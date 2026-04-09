//! Oblivinx3x Engine — top-level API coordinating all layers.
//!
//! The `OvnEngine` struct is the primary entry point for all database operations.
//! It coordinates the storage engine, MVCC, indexing, and query layers.

pub mod collection;
pub mod config;
pub mod timeseries;

use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::error::{OvnError, OvnResult};
use crate::format::header::FileHeader;
use crate::format::obe::{ObeDocument, ObeValue};
use crate::format::page::{Page, PageType};
use crate::io::{FileBackend, OsFileBackend};
use crate::mvcc::{MvccManager, Transaction, VersionEntry};
use crate::query::aggregation::parse_pipeline;
use crate::query::filter::{evaluate_filter, parse_filter, Filter, FilterOp};
use crate::query::update::{apply_update, parse_update};
use crate::storage::btree::BPlusTree;
use crate::storage::buffer_pool::BufferPool;
use crate::storage::memtable::{MemTable, MemTableEntry};
use crate::storage::sstable::SSTableManager;
use crate::storage::wal::{WalManager, WalRecord, WalRecordType};
use crate::storage::blob::BlobManager;
use crate::mvcc::session::{SessionManager, WriteResult};
use crate::mvcc::change_stream::{ChangeStreamEmitter, ChangeStreamEvent, OperationType};

use self::collection::Collection;
use self::config::OvnConfig;

/// Options for write operations (insert, update, delete).
#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    pub lsid: Option<[u8; 16]>,
    pub txn_number: Option<u64>,
}

/// The main Oblivinx3x database engine.
pub struct OvnEngine {
    /// Database file path — retained for future WAL recovery and hot-backup APIs
    #[allow(dead_code)]
    path: PathBuf,
    /// File I/O backend
    backend: Arc<OsFileBackend>,
    /// File header (Page 0)
    header: RwLock<FileHeader>,
    /// Buffer pool (page cache)
    buffer_pool: Arc<BufferPool>,
    /// WAL manager
    wal: Arc<WalManager>,
    /// Active MemTable
    memtable: Arc<MemTable>,
    /// SSTable manager for L0 tables
    sstable_mgr: Arc<SSTableManager>,
    /// Permanent B+ tree
    btree: Arc<BPlusTree>,
    /// MVCC manager
    mvcc: Arc<MvccManager>,
    /// Session manager for idempotency
    session_mgr: Arc<SessionManager>,
    /// Change stream emitter for real-time events
    pub change_stream: Arc<RwLock<ChangeStreamEmitter>>,
    /// Blob storage manager
    blob_mgr: Arc<BlobManager>,
    /// Collections registry
    collections: RwLock<HashMap<String, Collection>>,
    /// Configuration
    config: OvnConfig,
    /// Whether the database is closed
    closed: RwLock<bool>,
}

impl OvnEngine {
    /// Open or create a database at the given path.
    pub fn open(path: &str, config: OvnConfig) -> OvnResult<Self> {
        let path = PathBuf::from(path);
        let is_new = !path.exists();

        let backend = Arc::new(OsFileBackend::open(&path, config.read_only)?);

        let header = if is_new {
            // New database — write initial header
            let mut header = FileHeader::new(config.page_size);
            header.set_wal_active(true);
            let header_bytes = header.to_bytes();
            backend.write_page(0, config.page_size, &header_bytes)?;

            // Write empty segment directory (Page 1)
            let seg_page = Page::new(PageType::SegmentDirectory, 1, config.page_size);
            backend.write_page(1, config.page_size, &seg_page.to_bytes())?;

            backend.sync()?;
            header
        } else {
            // Existing database — read header
            let header_bytes = backend.read_page(0, config.page_size)?;
            let header = FileHeader::from_bytes(&header_bytes)?;

            // Check WAL for crash recovery
            if header.is_wal_active() {
                log::info!("WAL active flag set — performing crash recovery");
                // Recovery would replay WAL records here
            }

            header
        };

        let buffer_pool = Arc::new(BufferPool::new(config.buffer_pool_size, config.page_size));
        let wal_offset = header.wal_start_offset;
        let wal = Arc::new(WalManager::new(wal_offset));
        let memtable = Arc::new(MemTable::new(config.memtable_threshold));
        let sstable_mgr = Arc::new(SSTableManager::new());
        let btree = Arc::new(BPlusTree::new());
        let mvcc = Arc::new(MvccManager::new());
        let session_mgr = Arc::new(SessionManager::new());
        let change_stream = Arc::new(RwLock::new(ChangeStreamEmitter::new()));
        let blob_mgr = Arc::new(BlobManager::new(buffer_pool.clone(), backend.clone()));

        let engine = Self {
            path,
            backend: backend.clone(),
            header: RwLock::new(header.clone()),
            buffer_pool,
            wal: wal.clone(),
            memtable,
            sstable_mgr,
            btree,
            mvcc,
            session_mgr,
            change_stream,
            blob_mgr,
            collections: RwLock::new(HashMap::new()),
            config,
            closed: RwLock::new(false),
        };

        // If existing database, try to recover data from WAL
        if !is_new {
            engine.load_btree_from_disk()?;

            if header.is_wal_active() {
                log::info!("WAL active flag set — performing crash recovery");
                engine.recover_from_wal()?;
            }
        }

        Ok(engine)
    }

    /// Close the database gracefully.
    pub fn close(&self) -> OvnResult<()> {
        if *self.closed.read() {
            return Ok(());
        }

        // Flush MemTable to SSTable if it has data
        if self.memtable.len() > 0 {
            self.flush_memtable()?;
        }

        // Flush everything to permanent storage
        self.checkpoint()?;

        // Flush SSTables and B+ tree to disk
        self.flush_sstables_to_disk()?;
        self.flush_btree_to_disk()?;

        // Final sync
        self.backend.sync()?;

        // Clear WAL active flag
        let mut header = self.header.write();
        header.set_wal_active(false);
        header.last_checkpoint = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let header_bytes = header.to_bytes();
        self.backend
            .write_page(0, self.config.page_size, &header_bytes)?;
        self.backend.sync()?;

        *self.closed.write() = true;
        Ok(())
    }

    /// Checkpoint — flush MemTable and WAL to permanent storage.
    pub fn checkpoint(&self) -> OvnResult<()> {
        self.check_closed()?;

        // Flush buffer pool
        self.buffer_pool.flush_all(&*self.backend)?;

        // Flush WAL
        self.wal.flush(&*self.backend)?;

        // Sync to disk
        self.backend.sync()?;

        // GC old MVCC versions
        self.mvcc.gc();

        Ok(())
    }

    // ── Collection Management ──────────────────────────────────

    /// Create a new collection.
    pub fn create_collection(
        &self,
        name: &str,
        options_json: Option<&serde_json::Value>,
    ) -> OvnResult<()> {
        self.check_closed()?;
        let mut collections = self.collections.write();

        if collections.contains_key(name) {
            return Err(OvnError::CollectionAlreadyExists {
                name: name.to_string(),
            });
        }

        let mut options = crate::engine::collection::CollectionOptions::default();
        if let Some(json) = options_json {
            if let Some(obj) = json.as_object() {
                if let Some(capped) = obj.get("capped").and_then(|v| v.as_bool()) {
                    options.capped = capped;
                }
                if let Some(size) = obj.get("size").and_then(|v| v.as_u64()) {
                    options.size = Some(size);
                }
                if let Some(max) = obj.get("max").and_then(|v| v.as_u64()) {
                    options.max = Some(max);
                }
                if let Some(validator) = obj.get("validator") {
                    options.validator = Some(validator.clone());
                }
                if let Some(level) = obj.get("validationLevel").and_then(|v| v.as_str()) {
                    options.validation_level = Some(level.to_string());
                }
                if let Some(action) = obj.get("validationAction").and_then(|v| v.as_str()) {
                    options.validation_action = Some(action.to_string());
                }
                if let Some(ts) = obj.get("timeseries").and_then(|v| v.as_object()) {
                    let mut ts_opts = crate::engine::collection::TimeSeriesOptions {
                        time_field: "timestamp".to_string(),
                        meta_field: None,
                        granularity: None,
                    };
                    if let Some(time_field) = ts.get("timeField").and_then(|v| v.as_str()) {
                        ts_opts.time_field = time_field.to_string();
                    }
                    if let Some(meta_field) = ts.get("metaField").and_then(|v| v.as_str()) {
                        ts_opts.meta_field = Some(meta_field.to_string());
                    }
                    if let Some(granularity) = ts.get("granularity").and_then(|v| v.as_str()) {
                        ts_opts.granularity = Some(granularity.to_string());
                    }
                    options.timeseries = Some(ts_opts);
                }
            }
        }

        let collection = Collection::new_with_options(name.to_string(), options);
        collections.insert(name.to_string(), collection);

        let mut header = self.header.write();
        header.collection_count = collections.len() as u32;

        Ok(())
    }

    /// Drop a collection.
    pub fn drop_collection(&self, name: &str) -> OvnResult<()> {
        self.check_closed()?;
        let mut collections = self.collections.write();

        if collections.remove(name).is_none() {
            return Err(OvnError::CollectionNotFound {
                name: name.to_string(),
            });
        }

        let mut header = self.header.write();
        header.collection_count = collections.len() as u32;

        Ok(())
    }

    /// List all collections.
    pub fn list_collections(&self) -> Vec<String> {
        self.collections.read().keys().cloned().collect()
    }

    /// Create a Vector Index (HNSW) for a specific field.
    pub fn create_vector_index(&self, collection: &str, field: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let mut collections = self.collections.write();
        if let Some(coll) = collections.get_mut(collection) {
            if coll.vector_index.is_some() {
                return Err(OvnError::IndexAlreadyExists {
                    name: "vector_index".to_string(),
                    collection: collection.to_string(),
                });
            }

            use crate::index::vector::HnswVectorIndex;
            let mut vector_index = HnswVectorIndex::new(field.to_string());

            // Build index for existing documents
            let all_entries = self.btree.scan_all();
            for entry in all_entries {
                if entry.tombstone {
                    continue;
                }
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    if let Some(val) = doc.get_path(field) {
                        if let Some(arr) = val.as_array() {
                            let mut values = Vec::new();
                            for v in arr {
                                if let Some(f) = v.as_f64() {
                                    values.push(f as f32);
                                }
                            }
                            if !values.is_empty() {
                                let _ = vector_index.insert_vector(&doc.id, crate::index::vector::VectorEmbedding::new(values));
                            }
                        }
                    }
                }
            }

            coll.vector_index = Some(vector_index);
            Ok(())
        } else {
            Err(OvnError::CollectionNotFound {
                name: collection.to_string(),
            })
        }
    }

    /// Perform a Vector Search query.
    pub fn vector_search(&self, collection: &str, query_vector: &[f32], limit: usize) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            if let Some(vector_index) = &coll.vector_index {
                let query_embedding = crate::index::vector::VectorEmbedding::new(query_vector.to_vec());
                let matches = vector_index.search(&query_embedding, limit);

                let mut results = Vec::new();
                for (doc_id, _) in matches {
                    if let Some(entry) = self.btree.get(&doc_id) {
                        if !entry.tombstone {
                            if let Ok(doc) = ObeDocument::decode(&entry.value) {
                                results.push(doc.to_json());
                            }
                        }
                    }
                }
                return Ok(results);
            } else {
                return Err(OvnError::IndexNotFound {
                    name: "vector_index".to_string(),
                    collection: collection.to_string(),
                });
            }
        }
        
        Err(OvnError::CollectionNotFound {
            name: collection.to_string(),
        })
    }

    // ── Document CRUD ──────────────────────────────────────────

    /// Insert a single document into a collection.
    pub fn insert_with_options(
        &self,
        collection: &str,
        doc_json: &serde_json::Value,
        options: WriteOptions,
    ) -> OvnResult<String> {
        self.check_closed()?;
        
        let lsid_val = options.lsid.unwrap_or([0u8; 16]);
        let txn_val = options.txn_number.unwrap_or(0);
        
        // Idempotency check
        if txn_val > 0 {
            if let Some(WriteResult::InsertId(existing_id)) = self.session_mgr.check_idempotent(&lsid_val, txn_val) {
                return Ok(existing_id);
            }
        }
        
        self.ensure_collection(collection)?;

        let mut doc = ObeDocument::from_json(doc_json)?;
        let txid = self.mvcc.next_txid();
        doc.txid = txid;

        // Serialize to OBE
        let encoded = doc.encode()?;

        // WAL write
        let collection_id = Self::collection_id(collection);
        let wal_record = WalRecord::new(
            WalRecordType::Insert,
            txid,
            collection_id,
            lsid_val,
            txn_val,
            encoded.clone(),
        );
        self.wal.append(wal_record, &*self.backend)?;

        // MemTable insert
        let entry = MemTableEntry {
            key: doc.id.to_vec(),
            value: encoded.clone(),
            txid,
            tombstone: false,
            collection_id,
        };
        self.memtable.insert(entry)?;

        // B+ tree insert
        let btree_entry = crate::storage::btree::BTreeEntry {
            key: doc.id.to_vec(),
            value: encoded,
            txid,
            tombstone: false,
        };
        self.btree.insert(btree_entry)?;

        // MVCC version
        self.mvcc.add_version(
            doc.id.to_vec(),
            VersionEntry {
                txid,
                data: doc.encode()?,
                tombstone: false,
            },
        );

        // Index the document
        let mut collections = self.collections.write();
        if let Some(coll) = collections.get_mut(collection) {
            coll.index_manager.index_document(&doc)?;
            
            // Add to vector index if applicable
            if let Some(vector_index) = &mut coll.vector_index {
                let field = vector_index.field.clone();
                if let Some(val) = doc.get_path(&field) {
                    if let Some(arr) = val.as_array() {
                        let mut values = Vec::new();
                        for v in arr {
                            if let Some(f) = v.as_f64() {
                                values.push(f as f32);
                            }
                        }
                        if !values.is_empty() {
                            let _ = vector_index.insert_vector(&doc.id, crate::index::vector::VectorEmbedding::new(values));
                        }
                    }
                }
            }
        }

        // Check if MemTable needs flushing
        if self.memtable.should_flush() {
            self.flush_memtable()?;
        }

        let result_id = doc.id_string();
        
        if txn_val > 0 {
            self.session_mgr.record_result(lsid_val, txn_val, WriteResult::InsertId(result_id.clone()));
        }

        // Emit change stream event
        let event = ChangeStreamEvent {
            op_type: OperationType::Insert,
            cluster_time: txid, // simplify, using txid as logic clock
            document_key: doc.id,
            full_document: Some(doc),
            namespace: collection.to_string(),
            resume_token: txid.to_be_bytes().to_vec(),
        };
        self.change_stream.write().emit(event);

        Ok(result_id)
    }

    /// Insert a single document into a collection without options.
    pub fn insert(&self, collection: &str, doc_json: &serde_json::Value) -> OvnResult<String> {
        self.insert_with_options(collection, doc_json, WriteOptions::default())
    }

    /// Insert many documents.
    pub fn insert_many(
        &self,
        collection: &str,
        docs: &[serde_json::Value],
    ) -> OvnResult<Vec<String>> {
        let mut ids = Vec::with_capacity(docs.len());
        for doc in docs {
            ids.push(self.insert(collection, doc)?);
        }
        Ok(ids)
    }

    /// Find documents matching a filter.
    pub fn find(
        &self,
        collection: &str,
        filter_json: &serde_json::Value,
        options: Option<FindOptions>,
    ) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let filter = parse_filter(filter_json)?;
        let opts = options.unwrap_or_default();

        let collection_id = Self::collection_id(collection);

        // Scan all documents (MemTable + B+ tree)
        let mut results: Vec<ObeDocument> = Vec::new();

        // Try to use secondary indexes for acceleration
        let filter_fields = crate::query::filter::extract_filter_fields(&filter);
        let use_index = {
            let collections = self.collections.read();
            if let Some(coll) = collections.get(collection) {
                coll.index_manager.find_best_index(&filter_fields)
            } else {
                None
            }
        };

        if let Some(_index_name) = use_index {
            // Index-accelerized query: get candidate doc IDs from index, then fetch from B+Tree
            // For now, we use the index to narrow down candidates, then evaluate filter
            // The index lookup gives us doc IDs; we fetch those docs and apply filter
            let collections = self.collections.read();
            let mut candidate_ids: Option<std::collections::HashSet<Vec<u8>>> = None;

            if let Some(coll) = collections.get(collection) {
                // Try simple equality lookup for single-field $eq filters
                if let Filter::Comparison(ref field, ref op, ref value) = filter {
                    if *op == FilterOp::Eq {
                        if let Some(idx) = coll.index_manager.list_indexes().iter()
                            .find(|spec| spec.fields.len() == 1 && spec.fields[0].0 == *field)
                        {
                            let doc_ids = coll.index_manager.lookup_in_index(&idx.name, value);
                            candidate_ids = Some(doc_ids.into_iter().collect());
                        }
                    }
                }
            }

            // Fetch candidate documents
            let all_entries = self.btree.scan_all();
            for entry in all_entries {
                if entry.tombstone {
                    continue;
                }
                // If we have candidate IDs from index, filter by them
                if let Some(ref ids) = candidate_ids {
                    if !ids.contains(&entry.key) {
                        continue;
                    }
                }
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    if evaluate_filter(&filter, &doc) {
                        results.push(doc);
                    }
                }
            }
        } else {
            // Full collection scan (no suitable index)
            let all_entries = self.btree.scan_all();
            for entry in all_entries {
                if entry.tombstone {
                    continue;
                }
                match ObeDocument::decode(&entry.value) {
                    Ok(doc) => {
                        if evaluate_filter(&filter, &doc) {
                            results.push(doc);
                        }
                    }
                    Err(_) => continue,
                }
            }
        }

        // Also check MemTable for uncommitted/recent writes
        let memtable_entries = self.memtable.entries_for_collection(collection_id);
        for entry in memtable_entries {
            if entry.tombstone {
                continue;
            }
            // Skip if already found in B+ tree (dedup by key)
            if results.iter().any(|d| d.id.to_vec() == entry.key) {
                continue;
            }
            if let Ok(doc) = ObeDocument::decode(&entry.value) {
                if evaluate_filter(&filter, &doc) {
                    results.push(doc);
                }
            }
        }

        // Apply sort
        if let Some(ref sort_fields) = opts.sort {
            results.sort_by(|a, b| {
                for (field, direction) in sort_fields {
                    let va = a.get_path(field);
                    let vb = b.get_path(field);
                    let ord = match (va, vb) {
                        (Some(va), Some(vb)) => {
                            if let (Some(fa), Some(fb)) = (va.as_f64(), vb.as_f64()) {
                                fa.partial_cmp(&fb).unwrap_or(std::cmp::Ordering::Equal)
                            } else if let (Some(sa), Some(sb)) = (va.as_str(), vb.as_str()) {
                                sa.cmp(sb)
                            } else {
                                std::cmp::Ordering::Equal
                            }
                        }
                        _ => std::cmp::Ordering::Equal,
                    };
                    let ord = if *direction < 0 { ord.reverse() } else { ord };
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                }
                std::cmp::Ordering::Equal
            });
        }

        // Apply skip
        if opts.skip > 0 {
            results = results.into_iter().skip(opts.skip).collect();
        }

        // Apply limit
        if let Some(limit) = opts.limit {
            results.truncate(limit);
        }

        // Apply projection
        let json_results: Vec<serde_json::Value> = results
            .into_iter()
            .map(|doc| {
                if let Some(ref proj) = opts.projection {
                    let mut json = doc.to_json();
                    if let Some(obj) = json.as_object_mut() {
                        let has_includes = proj.values().any(|&v| v > 0);
                        if has_includes {
                            let keys: Vec<String> = obj.keys().cloned().collect();
                            for key in keys {
                                if key != "_id" && proj.get(&key).copied().unwrap_or(0) == 0 {
                                    obj.remove(&key);
                                }
                            }
                        } else {
                            for (key, &val) in proj {
                                if val == 0 {
                                    obj.remove(key);
                                }
                            }
                        }
                    }
                    json
                } else {
                    doc.to_json()
                }
            })
            .collect();

        Ok(json_results)
    }

    /// Find a single document.
    pub fn find_one(
        &self,
        collection: &str,
        filter_json: &serde_json::Value,
    ) -> OvnResult<Option<serde_json::Value>> {
        let results = self.find(
            collection,
            filter_json,
            Some(FindOptions {
                limit: Some(1),
                ..Default::default()
            }),
        )?;
        Ok(results.into_iter().next())
    }

    /// Update documents matching a filter.
    pub fn update_with_options(
        &self,
        collection: &str,
        filter_json: &serde_json::Value,
        update_json: &serde_json::Value,
        options: WriteOptions,
    ) -> OvnResult<u64> {
        self.check_closed()?;
        
        let lsid_val = options.lsid.unwrap_or([0u8; 16]);
        let txn_val = options.txn_number.unwrap_or(0);
        
        if txn_val > 0 {
            if let Some(WriteResult::ModifiedCount(count)) = self.session_mgr.check_idempotent(&lsid_val, txn_val) {
                return Ok(count);
            }
        }
        
        self.ensure_collection(collection)?;

        let filter = parse_filter(filter_json)?;
        let update_ops = parse_update(update_json)?;
        let collection_id = Self::collection_id(collection);

        let mut updated_count = 0u64;

        // Find matching documents
        let all_entries = self.btree.scan_all();
        for entry in all_entries {
            if entry.tombstone {
                continue;
            }
            match ObeDocument::decode(&entry.value) {
                Ok(mut doc) => {
                    if evaluate_filter(&filter, &doc) {
                        // Apply updates
                        apply_update(&mut doc, &update_ops)?;

                        let txid = self.mvcc.next_txid();
                        doc.txid = txid;
                        let encoded = doc.encode()?;

                        // WAL
                        let wal_record = WalRecord::new(
                            WalRecordType::Update,
                            txid,
                            collection_id,
                            lsid_val,
                            txn_val,
                            encoded.clone(),
                        );
                        self.wal.append(wal_record, &*self.backend)?;

                        // Update B+ tree
                        let btree_entry = crate::storage::btree::BTreeEntry {
                            key: doc.id.to_vec(),
                            value: encoded.clone(),
                            txid,
                            tombstone: false,
                        };
                        self.btree.insert(btree_entry)?;

                        // MemTable update
                        let mem_entry = MemTableEntry {
                            key: doc.id.to_vec(),
                            value: encoded,
                            txid,
                            tombstone: false,
                            collection_id,
                        };
                        let _ = self.memtable.insert(mem_entry);

                        updated_count += 1;

                        // Only update first match for update()
                        break;
                    }
                }
                Err(_) => continue,
            }
        }

        if txn_val > 0 {
            self.session_mgr.record_result(lsid_val, txn_val, WriteResult::ModifiedCount(updated_count));
        }

        // Emit change stream event (just one for the whole batch for simplicity, or we could emit per doc)
        let event = ChangeStreamEvent {
            op_type: OperationType::Update,
            cluster_time: 0,
            document_key: [0; 16],
            full_document: None,
            namespace: collection.to_string(),
            resume_token: vec![],
        };
        self.change_stream.write().emit(event);

        Ok(updated_count)
    }

    /// Update documents matching a filter (without options).
    pub fn update(
        &self,
        collection: &str,
        filter_json: &serde_json::Value,
        update_json: &serde_json::Value,
    ) -> OvnResult<u64> {
        self.update_with_options(collection, filter_json, update_json, WriteOptions::default())
    }

    /// Update all matching documents.
    pub fn update_many(
        &self,
        collection: &str,
        filter_json: &serde_json::Value,
        update_json: &serde_json::Value,
    ) -> OvnResult<u64> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let filter = parse_filter(filter_json)?;
        let update_ops = parse_update(update_json)?;
        let collection_id = Self::collection_id(collection);

        let mut updated_count = 0u64;
        let mut to_update: Vec<ObeDocument> = Vec::new();

        let all_entries = self.btree.scan_all();
        for entry in all_entries {
            if entry.tombstone {
                continue;
            }
            if let Ok(doc) = ObeDocument::decode(&entry.value) {
                if evaluate_filter(&filter, &doc) {
                    to_update.push(doc);
                }
            }
        }

        for mut doc in to_update {
            apply_update(&mut doc, &update_ops)?;
            let txid = self.mvcc.next_txid();
            doc.txid = txid;
            let encoded = doc.encode()?;

            let wal_record = WalRecord::new(
                WalRecordType::Update,
                txid,
                collection_id,
                [0; 16],
                0,
                encoded.clone(),
            );
            self.wal.append(wal_record, &*self.backend)?;

            let btree_entry = crate::storage::btree::BTreeEntry {
                key: doc.id.to_vec(),
                value: encoded.clone(),
                txid,
                tombstone: false,
            };
            self.btree.insert(btree_entry)?;

            let mem_entry = MemTableEntry {
                key: doc.id.to_vec(),
                value: encoded,
                txid,
                tombstone: false,
                collection_id,
            };
            let _ = self.memtable.insert(mem_entry);

            updated_count += 1;
        }

        Ok(updated_count)
    }

    /// Delete a single matching document.
    pub fn delete(&self, collection: &str, filter_json: &serde_json::Value) -> OvnResult<u64> {
        self.check_closed()?;

        let filter = parse_filter(filter_json)?;
        let collection_id = Self::collection_id(collection);
        let all_entries = self.btree.scan_all();

        for entry in all_entries {
            if entry.tombstone {
                continue;
            }
            if let Ok(doc) = ObeDocument::decode(&entry.value) {
                if evaluate_filter(&filter, &doc) {
                    let txid = self.mvcc.next_txid();
                    let tombstone_entry = crate::storage::btree::BTreeEntry {
                        key: doc.id.to_vec(),
                        value: Vec::new(),
                        txid,
                        tombstone: true,
                    };
                    self.btree.insert(tombstone_entry)?;

                    let mem_entry = MemTableEntry {
                        key: doc.id.to_vec(),
                        value: Vec::new(),
                        txid,
                        tombstone: true,
                        collection_id,
                    };
                    let _ = self.memtable.insert(mem_entry);

                    // Remove from secondary indexes
                    let collections = self.collections.read();
                    if let Some(coll) = collections.get(collection) {
                        coll.index_manager.remove_document(&doc);
                    }

                    let wal_record = WalRecord::new(
                        WalRecordType::Delete,
                        txid,
                        collection_id,
                        [0; 16],
                        0,
                        doc.id.to_vec(),
                    );
                    self.wal.append(wal_record, &*self.backend)?;

                    return Ok(1);
                }
            }
        }

        Ok(0)
    }

    /// Delete all matching documents.
    pub fn delete_many(&self, collection: &str, filter_json: &serde_json::Value) -> OvnResult<u64> {
        self.check_closed()?;

        let filter = parse_filter(filter_json)?;
        let collection_id = Self::collection_id(collection);
        let all_entries = self.btree.scan_all();
        let mut deleted = 0u64;

        let to_delete: Vec<Vec<u8>> = all_entries
            .iter()
            .filter(|e| !e.tombstone)
            .filter_map(|e| ObeDocument::decode(&e.value).ok())
            .filter(|doc| evaluate_filter(&filter, doc))
            .map(|doc| doc.id.to_vec())
            .collect();

        for doc_id in to_delete {
            // First get the document to remove from indexes
            if let Ok(doc) = ObeDocument::decode(&self.btree.get(&doc_id).map(|e| e.value).unwrap_or_default()) {
                // Remove from secondary indexes
                let collections = self.collections.read();
                if let Some(coll) = collections.get(collection) {
                    coll.index_manager.remove_document(&doc);
                }
            }

            let txid = self.mvcc.next_txid();
            let tombstone = crate::storage::btree::BTreeEntry {
                key: doc_id.clone(),
                value: Vec::new(),
                txid,
                tombstone: true,
            };
            self.btree.insert(tombstone)?;

            let mem_entry = MemTableEntry {
                key: doc_id.clone(),
                value: Vec::new(),
                txid,
                tombstone: true,
                collection_id,
            };
            let _ = self.memtable.insert(mem_entry);

            let wal_record = WalRecord::new(
                WalRecordType::Delete,
                txid,
                collection_id,
                [0; 16],
                0,
                doc_id,
            );
            self.wal.append(wal_record, &*self.backend)?;
            deleted += 1;
        }

        Ok(deleted)
    }

    // ── Indexing API ───────────────────────────────────────────

    /// Create a secondary index.
    pub fn create_index(
        &self,
        collection: &str,
        fields_json: &serde_json::Value,
    ) -> OvnResult<String> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let fields_obj = fields_json
            .as_object()
            .ok_or_else(|| OvnError::QuerySyntaxError {
                position: 0,
                message: "Index fields must be an object".to_string(),
            })?;

        let fields: Vec<(String, i32)> = fields_obj
            .iter()
            .map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(1) as i32))
            .collect();

        let name = crate::index::secondary::IndexSpec::default_name(&fields);

        let spec = crate::index::secondary::IndexSpec {
            name: name.clone(),
            collection: collection.to_string(),
            fields,
            unique: false,
            text: false,
        };

        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            coll.index_manager.create_index(spec)?;
        }

        Ok(name)
    }

    /// List all indexes for a collection.
    pub fn list_indexes(&self, collection: &str) -> Vec<serde_json::Value> {
        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            coll.index_manager
                .list_indexes()
                .into_iter()
                .map(|spec| {
                    serde_json::json!({
                        "name": spec.name,
                        "fields": spec.fields.iter()
                            .map(|(f, d)| (f.clone(), serde_json::Value::from(*d)))
                            .collect::<serde_json::Map<String, serde_json::Value>>(),
                        "unique": spec.unique,
                    })
                })
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Drop a named index from a collection.
    pub fn drop_index(&self, collection: &str, index_name: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.ensure_collection(collection)?;
        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            coll.index_manager.drop_index(index_name, collection)?;
        }
        Ok(())
    }

    // ── Blob Management ────────────────────────────────────────

    /// Store a binary blob.
    pub fn put_blob(&self, data: &[u8]) -> OvnResult<String> {
        self.check_closed()?;
        let (blob_id, _) = self.blob_mgr.put_blob(data)?;
        Ok(uuid::Uuid::from_bytes(blob_id).to_string())
    }

    /// Retrieve a binary blob.
    pub fn get_blob(&self, blob_id_str: &str) -> OvnResult<Option<Vec<u8>>> {
        self.check_closed()?;
        let parsed_uuid = uuid::Uuid::parse_str(blob_id_str).map_err(|_| {
            OvnError::ValidationError(format!("Invalid UUID format: {}", blob_id_str))
        })?;
        self.blob_mgr.get_blob(parsed_uuid.as_bytes())
    }

    // ── Transactions ───────────────────────────────────────────

    /// Begin a new transaction.
    pub fn begin_transaction(&self) -> OvnResult<Transaction> {
        self.check_closed()?;
        Ok(self.mvcc.begin_transaction())
    }

    /// Commit a transaction.
    pub fn commit_transaction(&self, txid: u64) -> OvnResult<()> {
        self.mvcc.commit(txid)
    }

    /// Abort a transaction.
    pub fn abort_transaction(&self, txid: u64) {
        self.mvcc.abort(txid);
    }

    // ── Aggregation ────────────────────────────────────────────

    /// Execute an aggregation pipeline.
    pub fn aggregate(
        &self,
        collection: &str,
        pipeline_json: &[serde_json::Value],
    ) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let stages = parse_pipeline(pipeline_json)?;
        let collection_id = Self::collection_id(collection);

        // Collect all documents from the collection
        let all_entries = self.btree.scan_all();
        let mut docs: Vec<ObeDocument> = all_entries
            .into_iter()
            .filter(|e| !e.tombstone)
            .filter_map(|e| ObeDocument::decode(&e.value).ok())
            .collect();

        // Also include uncommitted MemTable entries
        let memtable_entries = self.memtable.entries_for_collection(collection_id);
        for entry in memtable_entries {
            if !entry.tombstone && !docs.iter().any(|d| d.id.to_vec() == entry.key) {
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    docs.push(doc);
                }
            }
        }

        // Process pipeline stages — $lookup needs engine access, others use execute_pipeline
        let mut current = docs;
        for stage in &stages {
            match stage {
                crate::query::aggregation::AggregateStage::Lookup(config) => {
                    // Resolve $lookup: for each doc, find matching foreign documents
                    self.ensure_collection(&config.from)?;
                    let foreign_id = Self::collection_id(&config.from);
                    let foreign_entries = self.btree.scan_all();
                    let foreign_docs: Vec<ObeDocument> = foreign_entries
                        .into_iter()
                        .filter(|e| !e.tombstone)
                        .filter_map(|e| ObeDocument::decode(&e.value).ok())
                        .collect();

                    current = current
                        .into_iter()
                        .map(|mut doc| {
                            let local_val = doc.get_path(&config.local_field).cloned();
                            let matched: Vec<ObeValue> = foreign_docs
                                .iter()
                                .filter(|fd| {
                                    let foreign_val = fd.get_path(&config.foreign_field);
                                    match (&local_val, foreign_val) {
                                        (Some(lv), Some(fv)) => {
                                            // Compare serialized values for equality
                                            lv.to_json() == fv.to_json()
                                        }
                                        _ => false,
                                    }
                                })
                                .map(|fd| ObeValue::Document(fd.fields.clone()))
                                .collect();

                            doc.set(config.as_field.clone(), ObeValue::Array(matched));
                            let _ = foreign_id; // suppress warning
                            doc
                        })
                        .collect();
                }
                other_stage => {
                    current = crate::query::aggregation::execute_stage_single(current, other_stage)?;
                }
            }
        }

        Ok(current.into_iter().map(|d| d.to_json()).collect())
    }

    /// Full-text autocomplete search.
    ///
    /// Searches for documents where the indexed field starts with the given prefix.
    /// Uses full-text index tokenization for matching.
    pub fn autocomplete(
        &self,
        collection: &str,
        field: &str,
        prefix: &str,
        limit: usize,
    ) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let prefix_lower = prefix.to_lowercase();
        let all_entries = self.btree.scan_all();
        let mut results = Vec::new();

        for entry in all_entries {
            if entry.tombstone {
                continue;
            }
            if let Ok(doc) = ObeDocument::decode(&entry.value) {
                if let Some(val) = doc.get_path(field) {
                    if let Some(s) = val.as_str() {
                        if s.to_lowercase().starts_with(&prefix_lower) {
                            results.push(doc.to_json());
                            if results.len() >= limit {
                                break;
                            }
                        }
                    }
                }
            }
        }

        Ok(results)
    }

    /// Export database to JSON format.
    ///
    /// Returns a JSON object with collections as keys and arrays of documents as values.
    pub fn export(&self) -> OvnResult<serde_json::Value> {
        self.check_closed()?;

        let collection_names = self.list_collections();
        let mut export_map = serde_json::Map::new();

        for coll_name in &collection_names {
            let docs = self.find(coll_name, &serde_json::Value::Null, None)?;
            export_map.insert(coll_name.clone(), serde_json::Value::Array(docs));
        }

        Ok(serde_json::Value::Object(export_map))
    }

    /// Backup database to a file path (stub — copies btree snapshot).
    ///
    /// In a full implementation this would create a consistent hot-backup
    /// using WAL checkpointing and file copy.
    pub fn backup(&self, dest_path: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.checkpoint()?;

        // Export all data as JSON to dest_path
        let data = self.export()?;
        let json_str = serde_json::to_string_pretty(&data)
            .map_err(|e| OvnError::EncodingError(e.to_string()))?;

        std::fs::write(dest_path, json_str)?;
        Ok(())
    }

    /// Create a geospatial index on a field for a collection.
    pub fn create_geo_index(&self, collection: &str, field: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let mut collections = self.collections.write();
        if let Some(coll) = collections.get_mut(collection) {
            // Check if geo_index already exists
            if coll.geo_index.is_some() {
                return Err(OvnError::IndexAlreadyExists {
                    name: format!("{}_geo", field),
                    collection: collection.to_string(),
                });
            }

            // Create geo index (GeoSpatialIndex is already in index module)
            use crate::index::geospatial::{GeoPoint, GeoSpatialIndex};
            let mut geo_idx = GeoSpatialIndex::new();

            // Index existing documents with geo field
            let all_entries = self.btree.scan_all();
            for entry in all_entries {
                if entry.tombstone {
                    continue;
                }
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    if let Some(val) = doc.get_path(field) {
                        // Accept [lng, lat] arrays
                        if let Some(arr) = val.as_array() {
                            if arr.len() == 2 {
                                let lng = arr[0].as_f64().unwrap_or(0.0);
                                let lat = arr[1].as_f64().unwrap_or(0.0);
                                let _ = geo_idx.index_point(&doc.id, GeoPoint::new(lng, lat));
                            }
                        }
                    }
                }
            }

            // Also register a 2dsphere spec in index_manager for listing purposes
            let _ = coll.index_manager.create_index(crate::index::secondary::IndexSpec {
                name: format!("{}_{}_2dsphere", collection, field),
                collection: collection.to_string(),
                fields: vec![(field.to_string(), 1)],
                unique: false,
                text: false,
            });

            // Store the actual geo index on the collection struct
            coll.geo_index = Some(geo_idx);

            log::info!("Created geospatial index on {}.{}", collection, field);
            Ok(())
        } else {
            Err(OvnError::CollectionNotFound {
                name: collection.to_string(),
            })
        }
    }


    // ── Metrics ────────────────────────────────────────────────

    /// Get database metrics.
    pub fn get_metrics(&self) -> serde_json::Value {
        let bp_stats = self.buffer_pool.stats();

        serde_json::json!({
            "io": {
                "pagesRead": bp_stats.pages_read,
                "pagesWritten": bp_stats.pages_written,
            },
            "cache": {
                "hitRate": self.buffer_pool.hit_rate(),
                "size": self.buffer_pool.size(),
            },
            "txn": {
                "activeCount": self.mvcc.active_count(),
            },
            "storage": {
                "btreeEntries": self.btree.len(),
                "memtableSize": self.memtable.memory_usage(),
                "sstableCount": self.sstable_mgr.l0_count(),
            },
            "collections": self.collections.read().len(),
        })
    }

    // ── Internal ───────────────────────────────────────────────

    fn check_closed(&self) -> OvnResult<()> {
        if *self.closed.read() {
            Err(OvnError::DatabaseClosed)
        } else {
            Ok(())
        }
    }

    fn ensure_collection(&self, name: &str) -> OvnResult<()> {
        let collections = self.collections.read();
        if !collections.contains_key(name) {
            drop(collections);
            self.create_collection(name, None)?;
        }
        Ok(())
    }

    fn collection_id(name: &str) -> u32 {
        let mut hash: u32 = 5381;
        for byte in name.bytes() {
            hash = hash.wrapping_mul(33).wrapping_add(byte as u32);
        }
        hash
    }

    fn flush_memtable(&self) -> OvnResult<()> {
        let entries = self.memtable.drain_sorted();
        if entries.is_empty() {
            return Ok(());
        }

        // Create SSTable from MemTable entries
        let sstable_id = self.sstable_mgr.next_id();
        let sstable = crate::storage::sstable::SSTable::from_memtable_entries(sstable_id, entries)?;
        self.sstable_mgr.add(sstable);

        // Clear MemTable
        self.memtable.clear();

        Ok(())
    }

    /// Flush all SSTables to disk by appending their encoded data to the .ovn file.
    fn flush_sstables_to_disk(&self) -> OvnResult<()> {
        // Get current file size to determine where to write SSTables
        let current_size = self.backend.file_size()?;
        // Start SSTables after current content (aligned to page boundary)
        let sstable_start = ((current_size + self.config.page_size as u64 - 1) / self.config.page_size as u64) * self.config.page_size as u64;

        let offset = sstable_start;
        let tables = self.sstable_mgr.l0_count();

        if tables > 0 {
            // For now, SSTables are kept in memory but we write their encoded form to disk
            // In a full implementation, each SSTable would be written to a dedicated page range
            // For the prototype, we append a marker to indicate SSTable data exists
            let sstable_marker = format!("[SSTABLES: {} tables at offset {}]", tables, sstable_start);
            self.backend.write_at(offset, sstable_marker.as_bytes())?;
            log::info!("Flushed {} SSTable(s) to disk starting at offset {}", tables, sstable_start);
        }

        Ok(())
    }

    /// Flush the B+ tree to disk by serializing all entries as page data.
    fn flush_btree_to_disk(&self) -> OvnResult<()> {
        let entries = self.btree.scan_all();
        if entries.is_empty() {
            return Ok(());
        }

        // Get current file size
        let current_size = self.backend.file_size()?;
        // Start B+ tree data after SSTables (aligned to page boundary)
        let btree_start = ((current_size + self.config.page_size as u64 - 1) / self.config.page_size as u64) * self.config.page_size as u64;

        let mut offset = btree_start;
        for entry in &entries {
            // Serialize each entry with its key, value, and metadata
            let mut buf = Vec::new();
            buf.extend_from_slice(&(entry.key.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.key);
            buf.extend_from_slice(&(entry.value.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.value);
            buf.extend_from_slice(&entry.txid.to_le_bytes());
            buf.push(if entry.tombstone { 0xFF } else { 0x00 });

            // Pad to page boundary
            let padded_len = ((buf.len() + self.config.page_size as usize - 1) / self.config.page_size as usize) * self.config.page_size as usize;
            buf.resize(padded_len.max(self.config.page_size as usize), 0);

            // Write the page
            self.backend.write_at(offset, &buf)?;
            offset += buf.len() as u64;
        }

        // Update file header with total file size
        let final_size = self.backend.file_size()?;
        let mut header = self.header.write();
        header.total_file_size = final_size;

        log::info!("Flushed {} B+ tree entries to disk starting at offset {}, final size: {} bytes",
                   entries.len(), btree_start, final_size);

        Ok(())
    }

    /// Load B+ tree entries from disk (data written by flush_btree_to_disk).
    fn load_btree_from_disk(&self) -> OvnResult<()> {
        let file_size = self.backend.file_size()?;
        let page_size = self.config.page_size as u64;

        // Skip header pages (page 0 and 1) — data starts from page 2
        let mut page_num = 2u64;
        let mut loaded = 0u64;

        while page_num * page_size < file_size {
            match self.backend.read_page(page_num, self.config.page_size) {
                Ok(page_data) => {
                    // Try to parse as B+ tree entry
                    if page_data.len() < 13 { // minimum: 4 + key_len(0) + 4 + val_len(0) + 8 + 1
                        page_num += 1;
                        continue;
                    }

                    let key_len = u32::from_le_bytes([page_data[0], page_data[1], page_data[2], page_data[3]]) as usize;
                    if key_len == 0 || key_len > page_data.len() - 13 {
                        page_num += 1;
                        continue;
                    }

                    let key = page_data[4..4 + key_len].to_vec();
                    let val_offset = 4 + key_len;

                    if val_offset + 4 > page_data.len() {
                        page_num += 1;
                        continue;
                    }

                    let val_len = u32::from_le_bytes([
                        page_data[val_offset], page_data[val_offset + 1],
                        page_data[val_offset + 2], page_data[val_offset + 3]
                    ]) as usize;

                    let data_offset = val_offset + 4;
                    if data_offset + val_len + 9 > page_data.len() {
                        page_num += 1;
                        continue;
                    }

                    let value = page_data[data_offset..data_offset + val_len].to_vec();
                    let txid_offset = data_offset + val_len;
                    let txid = u64::from_le_bytes([
                        page_data[txid_offset], page_data[txid_offset + 1],
                        page_data[txid_offset + 2], page_data[txid_offset + 3],
                        page_data[txid_offset + 4], page_data[txid_offset + 5],
                        page_data[txid_offset + 6], page_data[txid_offset + 7]
                    ]);
                    let tombstone = page_data[txid_offset + 8] == 0xFF;

                    // Skip empty/deleted entries
                    if !value.is_empty() && !tombstone {
                        let btree_entry = crate::storage::btree::BTreeEntry {
                            key,
                            value,
                            txid,
                            tombstone: false,
                        };
                        let _ = self.btree.insert(btree_entry);
                        loaded += 1;
                    }

                    page_num += 1;
                }
                Err(_) => break, // End of valid data
            }
        }

        if loaded > 0 {
            log::info!("Loaded {} B+ tree entries from disk", loaded);
        }

        Ok(())
    }

    /// Recover from WAL by replaying insert records into the B+Tree and MemTable.
    fn recover_from_wal(&self) -> OvnResult<()> {
        // Read WAL data from wal_start_offset to end of file
        let file_size = self.backend.file_size()?;
        let wal_start = self.header.read().wal_start_offset;

        if wal_start >= file_size {
            return Ok(()); // No WAL data to replay
        }

        let wal_data = self.backend.read_at(wal_start, (file_size - wal_start) as usize)?;
        let records = WalManager::replay(&wal_data)?;

        let mut recovered = 0u64;
        for record in records {
            match record.record_type {
                WalRecordType::Insert | WalRecordType::Update => {
                    if !record.data.is_empty() {
                        // Decode document and insert into B+Tree
                        if let Ok(doc) = ObeDocument::decode(&record.data) {
                            let btree_entry = crate::storage::btree::BTreeEntry {
                                key: doc.id.to_vec(),
                                value: record.data.clone(),
                                txid: record.txid,
                                tombstone: record.record_type == WalRecordType::Delete,
                            };
                            let _ = self.btree.insert(btree_entry);

                            // Also add to MemTable for recent writes
                            let mem_entry = MemTableEntry {
                                key: doc.id.to_vec(),
                                value: record.data,
                                txid: record.txid,
                                tombstone: false,
                                collection_id: record.collection_id,
                            };
                            let _ = self.memtable.insert(mem_entry);

                            recovered += 1;
                        }
                    }
                }
                WalRecordType::Delete => {
                    // Apply tombstone
                    let btree_entry = crate::storage::btree::BTreeEntry {
                        key: record.data.clone(),
                        value: Vec::new(),
                        txid: record.txid,
                        tombstone: true,
                    };
                    let _ = self.btree.insert(btree_entry);
                }
                _ => {}
            }
        }

        if recovered > 0 {
            log::info!("Recovered {} documents from WAL", recovered);
        }

        Ok(())
    }
}

/// Options for find operations.
#[derive(Debug, Clone, Default)]
pub struct FindOptions {
    /// Field projection: field_name → 1 (include) or 0 (exclude)
    pub projection: Option<HashMap<String, i32>>,
    /// Sort specification: (field, direction)
    pub sort: Option<Vec<(String, i32)>>,
    /// Maximum documents to return
    pub limit: Option<usize>,
    /// Documents to skip
    pub skip: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_create_and_list_collections() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.ovn");

        let config = OvnConfig::default();
        let engine = OvnEngine::open(db_path.to_str().unwrap(), config).unwrap();

        engine.create_collection("users", None).unwrap();
        engine.create_collection("products", None).unwrap();

        let collections = engine.list_collections();
        assert!(collections.contains(&"users".to_string()));
        assert!(collections.contains(&"products".to_string()));

        engine.close().unwrap();
    }

    #[test]
    fn test_engine_insert_and_find() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.ovn");

        let config = OvnConfig::default();
        let engine = OvnEngine::open(db_path.to_str().unwrap(), config).unwrap();

        let id = engine
            .insert(
                "users",
                &serde_json::json!({
                    "name": "Alice",
                    "age": 28,
                    "email": "alice@example.com"
                }),
            )
            .unwrap();
        assert!(!id.is_empty());

        let results = engine
            .find("users", &serde_json::json!({ "name": "Alice" }), None)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["name"], "Alice");
        assert_eq!(results[0]["age"], 28);

        engine.close().unwrap();
    }

    #[test]
    fn test_engine_update_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.ovn");

        let config = OvnConfig::default();
        let engine = OvnEngine::open(db_path.to_str().unwrap(), config).unwrap();

        engine
            .insert("users", &serde_json::json!({ "name": "Bob", "age": 30 }))
            .unwrap();

        // Update
        let updated = engine
            .update(
                "users",
                &serde_json::json!({ "name": "Bob" }),
                &serde_json::json!({ "$set": { "age": 31 } }),
            )
            .unwrap();
        assert_eq!(updated, 1);

        let results = engine
            .find("users", &serde_json::json!({ "name": "Bob" }), None)
            .unwrap();
        assert_eq!(results[0]["age"], 31);

        // Delete
        let deleted = engine
            .delete("users", &serde_json::json!({ "name": "Bob" }))
            .unwrap();
        assert_eq!(deleted, 1);

        let results = engine
            .find("users", &serde_json::json!({ "name": "Bob" }), None)
            .unwrap();
        assert_eq!(results.len(), 0);

        engine.close().unwrap();
    }
}
