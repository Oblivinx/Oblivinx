//! CRUD operations for the OvnEngine.

use std::collections::HashSet;

use super::FindOptions;
use super::OvnEngine;
use super::WriteOptions;

use crate::error::OvnResult;
use crate::format::obe::{ObeDocument, ObeValue};
use crate::mvcc::change_stream::{ChangeStreamEvent, OperationType};
use crate::mvcc::session::WriteResult;
use crate::mvcc::VersionEntry;
use crate::query::filter::{
    evaluate_filter, extract_filter_fields, parse_filter, Filter, FilterOp,
};
use crate::query::update::{apply_update, parse_update};
use crate::storage::btree::BTreeEntry;
use crate::storage::memtable::MemTableEntry;
use crate::storage::wal::{WalRecord, WalRecordType};

impl OvnEngine {
    pub(super) fn ensure_collection(&self, name: &str) -> OvnResult<()> {
        let collections = self.collections.read();
        if !collections.contains_key(name) {
            drop(collections);
            self.create_collection(name, None)?;
        }
        Ok(())
    }

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
            if let Some(WriteResult::InsertId(existing_id)) =
                self.session_mgr.check_idempotent(&lsid_val, txn_val)
            {
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
        let btree_entry = BTreeEntry {
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
                            let _ = vector_index.insert_vector(
                                &doc.id,
                                crate::index::vector::VectorEmbedding::new(values),
                            );
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
            self.session_mgr.record_result(
                lsid_val,
                txn_val,
                WriteResult::InsertId(result_id.clone()),
            );
        }

        // Emit change stream event
        let event = ChangeStreamEvent {
            op_type: OperationType::Insert,
            cluster_time: txid,
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
    ///
    /// Uses indexes for acceleration when available:
    /// - IndexPointLookup for equality filters on indexed fields
    /// - IndexRangeScan for inequality filters ($gt, $gte, $lt, $lte)
    /// - CoveredIndexScan when projection matches index fields
    /// - Falls back to CollectionScan when no index is suitable
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

        // Try to use secondary indexes for acceleration
        let filter_fields = extract_filter_fields(&filter);
        let use_index = {
            let collections = self.collections.read();
            if let Some(coll) = collections.get(collection) {
                coll.index_manager.find_best_index(&filter_fields)
            } else {
                None
            }
        };

        // Gather candidate document IDs from indexes
        let mut candidate_ids: Option<HashSet<Vec<u8>>> = None;

        if let Some(ref index_name) = use_index {
            let collections = self.collections.read();
            if let Some(coll) = collections.get(collection) {
                // Try point lookup for equality filters
                if let Filter::Comparison(ref field, ref op, ref value) = filter {
                    if *op == FilterOp::Eq {
                        let doc_ids = coll.index_manager.lookup_in_index(index_name, value);
                        if !doc_ids.is_empty() {
                            candidate_ids = Some(doc_ids.into_iter().collect());
                        }
                    }
                    // Try range scan for inequality filters
                    else if matches!(op, FilterOp::Gt | FilterOp::Gte | FilterOp::Lt | FilterOp::Lte) {
                        // Build range bounds
                        let from = match op {
                            FilterOp::Gt | FilterOp::Gte => value.clone(),
                            _ => ObeValue::Null, // Unbounded low
                        };
                        let to = match op {
                            FilterOp::Lt | FilterOp::Lte => value.clone(),
                            _ => ObeValue::Null, // Unbounded high
                        };

                        let doc_ids = coll.index_manager.range_scan_index(index_name, &from, &to);
                        if !doc_ids.is_empty() {
                            candidate_ids = Some(doc_ids.into_iter().collect());
                        }
                    }
                }
            }
        }

        // Scan documents, using candidate IDs if available
        let mut results: Vec<ObeDocument> = Vec::new();

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

        // Also check MemTable for recent writes
        let memtable_entries = self.memtable.entries_for_collection(collection_id);
        for entry in memtable_entries {
            if entry.tombstone {
                continue;
            }
            if results.iter().any(|d| d.id.to_vec() == entry.key) {
                continue;
            }
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
            if let Some(WriteResult::ModifiedCount(count)) =
                self.session_mgr.check_idempotent(&lsid_val, txn_val)
            {
                return Ok(count);
            }
        }

        self.ensure_collection(collection)?;

        let filter = parse_filter(filter_json)?;
        let update_ops = parse_update(update_json)?;
        let collection_id = Self::collection_id(collection);

        let mut updated_count = 0u64;

        let all_entries = self.btree.scan_all();
        for entry in all_entries {
            if entry.tombstone {
                continue;
            }
            match ObeDocument::decode(&entry.value) {
                Ok(mut doc) => {
                    if evaluate_filter(&filter, &doc) {
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
                        let btree_entry = BTreeEntry {
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
            self.session_mgr.record_result(
                lsid_val,
                txn_val,
                WriteResult::ModifiedCount(updated_count),
            );
        }

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
        self.update_with_options(
            collection,
            filter_json,
            update_json,
            WriteOptions::default(),
        )
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

            let btree_entry = BTreeEntry {
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
                    let tombstone_entry = BTreeEntry {
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
            if let Ok(doc) =
                ObeDocument::decode(&self.btree.get(&doc_id).map(|e| e.value).unwrap_or_default())
            {
                let collections = self.collections.read();
                if let Some(coll) = collections.get(collection) {
                    coll.index_manager.remove_document(&doc);
                }
            }

            let txid = self.mvcc.next_txid();
            let tombstone = BTreeEntry {
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

    /// Count documents matching a filter.
    pub fn count(
        &self,
        collection: &str,
        filter_json: Option<&serde_json::Value>,
    ) -> OvnResult<u64> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let collection_id = Self::collection_id(collection);
        let mut count = 0u64;

        if let Some(filter_json) = filter_json {
            let filter = parse_filter(filter_json)?;
            let all_entries = self.btree.scan_all();
            for entry in all_entries {
                if entry.tombstone {
                    continue;
                }
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    if evaluate_filter(&filter, &doc) {
                        count += 1;
                    }
                }
            }

            let memtable_entries = self.memtable.entries_for_collection(collection_id);
            for entry in memtable_entries {
                if !entry.tombstone
                    && !self
                        .btree
                        .scan_all()
                        .iter()
                        .any(|e| e.key == entry.key && !e.tombstone)
                {
                    if let Ok(doc) = ObeDocument::decode(&entry.value) {
                        if evaluate_filter(&filter, &doc) {
                            count += 1;
                        }
                    }
                }
            }
        } else {
            let all_entries = self.btree.scan_all();
            for entry in all_entries {
                if !entry.tombstone {
                    count += 1;
                }
            }
        }

        Ok(count)
    }
}
