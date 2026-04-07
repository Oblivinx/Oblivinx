//! Oblivinx3x Engine — top-level API coordinating all layers.
//!
//! The `OvnEngine` struct is the primary entry point for all database operations.
//! It coordinates the storage engine, MVCC, indexing, and query layers.

pub mod collection;
pub mod config;

use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::error::{OvnError, OvnResult};
use crate::format::header::FileHeader;
use crate::format::obe::ObeDocument;
use crate::format::page::{Page, PageType};
use crate::io::{FileBackend, OsFileBackend};
use crate::mvcc::{MvccManager, Transaction, VersionEntry};
use crate::query::aggregation::{execute_pipeline, parse_pipeline};
use crate::query::filter::{evaluate_filter, parse_filter};
use crate::query::update::{apply_update, parse_update};
use crate::storage::btree::BPlusTree;
use crate::storage::buffer_pool::BufferPool;
use crate::storage::memtable::{MemTable, MemTableEntry};
use crate::storage::sstable::SSTableManager;
use crate::storage::wal::{WalManager, WalRecord, WalRecordType};

use self::collection::Collection;
use self::config::OvnConfig;

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

        Ok(Self {
            path,
            backend,
            header: RwLock::new(header),
            buffer_pool,
            wal,
            memtable,
            sstable_mgr,
            btree,
            mvcc,
            collections: RwLock::new(HashMap::new()),
            config,
            closed: RwLock::new(false),
        })
    }

    /// Close the database gracefully.
    pub fn close(&self) -> OvnResult<()> {
        if *self.closed.read() {
            return Ok(());
        }

        // Flush everything
        self.checkpoint()?;

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

        // Sync to disk
        self.backend.sync()?;

        // GC old MVCC versions
        self.mvcc.gc();

        Ok(())
    }

    // ── Collection Management ──────────────────────────────────

    /// Create a new collection.
    pub fn create_collection(&self, name: &str) -> OvnResult<()> {
        self.check_closed()?;
        let mut collections = self.collections.write();

        if collections.contains_key(name) {
            return Err(OvnError::CollectionAlreadyExists {
                name: name.to_string(),
            });
        }

        let collection = Collection::new(name.to_string());
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

    // ── Document CRUD ──────────────────────────────────────────

    /// Insert a single document into a collection.
    pub fn insert(&self, collection: &str, doc_json: &serde_json::Value) -> OvnResult<String> {
        self.check_closed()?;
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
            [0u8; 16],
            0,
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
        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            coll.index_manager.index_document(&doc)?;
        }

        // Check if MemTable needs flushing
        if self.memtable.should_flush() {
            self.flush_memtable()?;
        }

        Ok(doc.id_string())
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

        // Scan B+ tree
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
    pub fn update(
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
                            [0; 16],
                            0,
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

        Ok(updated_count)
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
        _collection: &str,
        pipeline_json: &[serde_json::Value],
    ) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;

        let stages = parse_pipeline(pipeline_json)?;

        // Get all documents from collection
        let all_entries = self.btree.scan_all();
        let docs: Vec<ObeDocument> = all_entries
            .into_iter()
            .filter(|e| !e.tombstone)
            .filter_map(|e| ObeDocument::decode(&e.value).ok())
            .collect();

        let result_docs = execute_pipeline(docs, &stages)?;

        Ok(result_docs.into_iter().map(|d| d.to_json()).collect())
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
            self.create_collection(name)?;
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

        engine.create_collection("users").unwrap();
        engine.create_collection("products").unwrap();

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
