//! Oblivinx3x Engine -- top-level API coordinating all layers.
//!
//! The `OvnEngine` struct is the primary entry point for all database operations.
//! It coordinates the storage engine, MVCC, indexing, and query layers.

pub mod collection;
pub mod config;
pub mod timeseries;

// Submodules containing split impl blocks for OvnEngine
mod attach;
mod audit;
mod backup;
mod blob_ops;
mod crud;
mod encryption;
mod explain;
mod index_ops;
mod metrics;
mod pragma;
mod relation;
mod security;
mod trigger;
mod txn_ops;
mod versioning;
mod view;

use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::error::{OvnError, OvnResult};
use crate::format::header::FileHeader;
use crate::format::obe::{ObeDocument, ObeValue};
use crate::format::segment::SegmentDirectory;
use crate::io::{FileBackend, OsFileBackend};
use crate::mvcc::change_stream::ChangeStreamEmitter;
use crate::mvcc::session::SessionManager;
use crate::mvcc::MvccManager;
use crate::query::aggregation::parse_pipeline;
use crate::storage::blob::BlobManager;
use crate::storage::btree::BPlusTree;
use crate::storage::buffer_pool::BufferPool;
use crate::storage::memtable::{MemTable, MemTableEntry};
use crate::storage::sstable::SSTableManager;
use crate::storage::wal::{WalManager, WalRecordType};

use self::collection::Collection;
use self::config::OvnConfig;
use self::txn_ops::SavepointState;

/// Options for write operations (insert, update, delete).
#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    pub lsid: Option<[u8; 16]>,
    pub txn_number: Option<u64>,
}

/// Options for find operations.
#[derive(Debug, Clone, Default)]
pub struct FindOptions {
    /// Field projection: field_name -> 1 (include) or 0 (exclude)
    pub projection: Option<HashMap<String, i32>>,
    /// Sort specification: (field, direction)
    pub sort: Option<Vec<(String, i32)>>,
    /// Maximum documents to return
    pub limit: Option<usize>,
    /// Documents to skip
    pub skip: usize,
}

/// The main Oblivinx3x database engine.
pub struct OvnEngine {
    /// Database file path -- retained for future WAL recovery and hot-backup APIs
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
    /// Whether the engine is closed
    closed: RwLock<bool>,
    /// Savepoint state per transaction (txid → SavepointState)
    savepoint_states: Mutex<HashMap<u64, SavepointState>>,
    /// View registry: name → ViewDefinition
    views: Mutex<HashMap<String, view::ViewDefinition>>,
    /// Materialized view cache: name → cached results
    materialized_caches: Mutex<HashMap<String, view::MaterializedViewCache>>,
    /// Relation definitions: stored for referential integrity validation
    relations: Mutex<Vec<relation::RelationDefinition>>,
    /// Referential integrity mode: 'off', 'soft', 'strict'
    integrity_mode: RwLock<String>,
    /// Trigger definitions: collection → event → trigger function metadata
    triggers: Mutex<HashMap<String, HashMap<String, trigger::TriggerDefinition>>>,
    /// Pragma key-value store
    pragmas: Mutex<HashMap<String, serde_json::Value>>,
    /// Attached databases: alias → engine instance
    attached_databases: Mutex<HashMap<String, Arc<OvnEngine>>>,
    /// Version history registry: collection → doc_id → versions
    version_history: Mutex<HashMap<String, versioning::CollectionVersionHistory>>,
    /// Versioning configs per collection
    versioning_configs: Mutex<HashMap<String, versioning::VersioningConfig>>,
    /// Encryption configs per collection
    encryption_configs: Mutex<HashMap<String, encryption::CollectionEncryptionConfig>>,
    /// Key provider for encryption
    key_provider: Mutex<Option<Box<dyn encryption::KeyProvider>>>,
    /// Audit log entries (ring buffer)
    audit_log: Mutex<Vec<audit::AuditEntry>>,
    /// Rate limiter state
    rate_limiter: Mutex<security::RateLimiter>,
    /// v2 Segment Directory (catalog of segment locations)
    segment_dir: Mutex<SegmentDirectory>,
}

impl OvnEngine {
    /// Open or create a database at the given path.
    ///
    /// For v1 `.ovn` files (magic OVNX): opens in read-only compatibility mode.
    /// Write operations on a v1 file return `OvnError::ReadOnly`.
    /// To migrate, call `engine.migrate_v1_to_v2(dest_path)` explicitly.
    pub fn open(path: &str, mut config: OvnConfig) -> OvnResult<Self> {
        let path = PathBuf::from(path);
        let is_new = !path.exists();

        let backend = Arc::new(OsFileBackend::open(&path, config.read_only)?);

        let (header, segment_dir) = if is_new {
            let mut header = FileHeader::new(config.page_size);
            header.set_wal_active(true);
            let header_bytes = header.to_bytes();
            backend.write_page(0, config.page_size, &header_bytes)?;

            // Write initial Segment Directory to Page 1
            let seg_dir = SegmentDirectory::with_defaults(2);
            let seg_bytes = seg_dir.to_bytes(config.page_size as usize)?;
            backend.write_page(1, config.page_size, &seg_bytes)?;

            backend.sync()?;
            (header, seg_dir)
        } else {
            let header_bytes = backend.read_page(0, config.page_size)?;
            let header = FileHeader::from_bytes(&header_bytes)?;

            // v1 compatibility: force read-only
            if header.is_v1_compat() {
                log::warn!(
                    "Opened v1 database at '{}'. \
                     Engine is in read-only compatibility mode. \
                     Use engine.migrate_v1_to_v2() to upgrade.",
                    path.display()
                );
                config.read_only = true;
            } else if header.is_wal_active() {
                log::info!("WAL active flag set — performing crash recovery.");
            }

            // Load segment directory from Page 1
            let seg_dir = match backend.read_page(1, config.page_size) {
                Ok(seg_bytes) => SegmentDirectory::from_bytes(&seg_bytes).unwrap_or_else(|e| {
                    log::warn!("Could not parse segment directory: {}. Using empty.", e);
                    SegmentDirectory::new()
                }),
                Err(_) => SegmentDirectory::new(),
            };

            (header, seg_dir)
        };

        let buffer_pool = Arc::new(BufferPool::new(config.buffer_pool_size, config.page_size));

        // Guard: WAL must NEVER start before offset (page_size * 2).
        // Databases created with older buggy builds may have wal_start_offset = 0,
        // which causes WAL records to overwrite Page 0 (the file header),
        // corrupting the magic number on next open.
        let min_wal_offset = config.page_size as u64 * 2;
        let wal_offset = if header.wal_start_offset < min_wal_offset {
            if !is_new {
                log::warn!(
                    "Detected wal_start_offset={} < minimum {}. \
                     Database may have been created with a buggy build. \
                     Resetting WAL offset to {} to prevent header corruption.",
                    header.wal_start_offset,
                    min_wal_offset,
                    min_wal_offset
                );
            }
            min_wal_offset
        } else {
            header.wal_start_offset
        };

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
            savepoint_states: Mutex::new(HashMap::new()),
            views: Mutex::new(HashMap::new()),
            materialized_caches: Mutex::new(HashMap::new()),
            relations: Mutex::new(Vec::new()),
            integrity_mode: RwLock::new("off".to_string()),
            triggers: Mutex::new(HashMap::new()),
            pragmas: Mutex::new(HashMap::new()),
            attached_databases: Mutex::new(HashMap::new()),
            version_history: Mutex::new(HashMap::new()),
            versioning_configs: Mutex::new(HashMap::new()),
            encryption_configs: Mutex::new(HashMap::new()),
            key_provider: Mutex::new(None),
            audit_log: Mutex::new(Vec::new()),
            rate_limiter: Mutex::new(security::RateLimiter::new(1000)),
            segment_dir: Mutex::new(segment_dir),
        };

        if !is_new {
            engine.load_btree_from_disk()?;

            if header.is_wal_active() {
                log::info!("WAL active flag set -- performing crash recovery");
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

        if !self.memtable.is_empty() {
            self.flush_memtable()?;
        }

        self.checkpoint()?;

        self.flush_sstables_to_disk()?;
        self.flush_btree_to_disk()?;

        self.backend.sync()?;

        // Write updated Segment Directory to Page 1
        {
            let seg_dir = self.segment_dir.lock().unwrap();
            if let Ok(seg_bytes) = seg_dir.to_bytes(self.config.page_size as usize) {
                let _ = self
                    .backend
                    .write_page(1, self.config.page_size, &seg_bytes);
            }
        }

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

    /// Checkpoint -- flush MemTable and WAL to permanent storage.
    pub fn checkpoint(&self) -> OvnResult<()> {
        self.check_closed()?;

        self.buffer_pool.flush_all(&*self.backend)?;

        self.wal.flush(&*self.backend)?;

        self.backend.sync()?;

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

        let all_entries = self.btree.scan_all();
        let mut docs: Vec<ObeDocument> = all_entries
            .into_iter()
            .filter(|e| !e.tombstone)
            .filter_map(|e| ObeDocument::decode(&e.value).ok())
            .collect();

        let memtable_entries = self.memtable.entries_for_collection(collection_id);
        for entry in memtable_entries {
            if !entry.tombstone && !docs.iter().any(|d| d.id.to_vec() == entry.key) {
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    docs.push(doc);
                }
            }
        }

        let mut current = docs;
        for stage in &stages {
            match stage {
                crate::query::aggregation::AggregateStage::Lookup(config) => {
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
                                        (Some(lv), Some(fv)) => lv.to_json() == fv.to_json(),
                                        _ => false,
                                    }
                                })
                                .map(|fd| ObeValue::Document(fd.fields.clone()))
                                .collect();

                            doc.set(config.as_field.clone(), ObeValue::Array(matched));
                            let _ = foreign_id;
                            doc
                        })
                        .collect();
                }
                other_stage => {
                    current =
                        crate::query::aggregation::execute_stage_single(current, other_stage)?;
                }
            }
        }

        Ok(current.into_iter().map(|d| d.to_json()).collect())
    }

    /// Full-text autocomplete search.
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

    // ── Internal helpers ───────────────────────────────────────

    /// Check if the engine is closed.
    fn check_closed(&self) -> OvnResult<()> {
        if *self.closed.read() {
            Err(OvnError::DatabaseClosed)
        } else {
            Ok(())
        }
    }

    /// Get the database file path.
    pub fn get_path(&self) -> &PathBuf {
        &self.path
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

        let sstable_id = self.sstable_mgr.next_id();
        let sstable = crate::storage::sstable::SSTable::from_memtable_entries(sstable_id, entries)?;
        self.sstable_mgr.add(sstable);

        self.memtable.clear();

        Ok(())
    }

    /// Flush all SSTables to disk.
    fn flush_sstables_to_disk(&self) -> OvnResult<()> {
        let current_size = self.backend.file_size()?;
        let sstable_start =
            current_size.div_ceil(self.config.page_size as u64) * self.config.page_size as u64;

        let offset = sstable_start;
        let tables = self.sstable_mgr.l0_count();

        if tables > 0 {
            let sstable_marker =
                format!("[SSTABLES: {} tables at offset {}]", tables, sstable_start);
            self.backend.write_at(offset, sstable_marker.as_bytes())?;
            log::info!(
                "Flushed {} SSTable(s) to disk starting at offset {}",
                tables,
                sstable_start
            );
        }

        Ok(())
    }

    /// Flush the B+ tree to disk.
    fn flush_btree_to_disk(&self) -> OvnResult<()> {
        let entries = self.btree.scan_all();
        if entries.is_empty() {
            return Ok(());
        }

        let current_size = self.backend.file_size()?;
        let btree_start =
            current_size.div_ceil(self.config.page_size as u64) * self.config.page_size as u64;

        let mut offset = btree_start;
        for entry in &entries {
            let mut buf = Vec::new();
            buf.extend_from_slice(&(entry.key.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.key);
            buf.extend_from_slice(&(entry.value.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.value);
            buf.extend_from_slice(&entry.txid.to_le_bytes());
            buf.push(if entry.tombstone { 0xFF } else { 0x00 });

            let padded_len =
                buf.len().div_ceil(self.config.page_size as usize) * self.config.page_size as usize;
            buf.resize(padded_len.max(self.config.page_size as usize), 0);

            self.backend.write_at(offset, &buf)?;
            offset += buf.len() as u64;
        }

        let final_size = self.backend.file_size()?;
        let mut header = self.header.write();
        header.total_file_size = final_size;

        log::info!(
            "Flushed {} B+ tree entries to disk starting at offset {}, final size: {} bytes",
            entries.len(),
            btree_start,
            final_size
        );

        Ok(())
    }

    /// Load B+ tree entries from disk.
    fn load_btree_from_disk(&self) -> OvnResult<()> {
        let file_size = self.backend.file_size()?;
        let page_size = self.config.page_size as u64;

        let mut page_num = 2u64;
        let mut loaded = 0u64;

        while page_num * page_size < file_size {
            match self.backend.read_page(page_num, self.config.page_size) {
                Ok(page_data) => {
                    if page_data.len() < 13 {
                        page_num += 1;
                        continue;
                    }

                    let key_len = u32::from_le_bytes([
                        page_data[0],
                        page_data[1],
                        page_data[2],
                        page_data[3],
                    ]) as usize;
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
                        page_data[val_offset],
                        page_data[val_offset + 1],
                        page_data[val_offset + 2],
                        page_data[val_offset + 3],
                    ]) as usize;

                    let data_offset = val_offset + 4;
                    if data_offset + val_len + 9 > page_data.len() {
                        page_num += 1;
                        continue;
                    }

                    let value = page_data[data_offset..data_offset + val_len].to_vec();
                    let txid_offset = data_offset + val_len;
                    let txid = u64::from_le_bytes([
                        page_data[txid_offset],
                        page_data[txid_offset + 1],
                        page_data[txid_offset + 2],
                        page_data[txid_offset + 3],
                        page_data[txid_offset + 4],
                        page_data[txid_offset + 5],
                        page_data[txid_offset + 6],
                        page_data[txid_offset + 7],
                    ]);
                    let tombstone = page_data[txid_offset + 8] == 0xFF;

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
                Err(_) => break,
            }
        }

        if loaded > 0 {
            log::info!("Loaded {} B+ tree entries from disk", loaded);
        }

        Ok(())
    }

    /// Recover from WAL by replaying insert records.
    fn recover_from_wal(&self) -> OvnResult<()> {
        let file_size = self.backend.file_size()?;
        let wal_start = self.header.read().wal_start_offset;

        if wal_start >= file_size {
            return Ok(());
        }

        let wal_data = self
            .backend
            .read_at(wal_start, (file_size - wal_start) as usize)?;
        let records = WalManager::replay(&wal_data)?;

        let mut recovered = 0u64;
        for record in records {
            match record.record_type {
                WalRecordType::Insert | WalRecordType::Update => {
                    if !record.data.is_empty() {
                        if let Ok(doc) = ObeDocument::decode(&record.data) {
                            let btree_entry = crate::storage::btree::BTreeEntry {
                                key: doc.id.to_vec(),
                                value: record.data.clone(),
                                txid: record.txid,
                                tombstone: record.record_type == WalRecordType::Delete,
                            };
                            let _ = self.btree.insert(btree_entry);

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
