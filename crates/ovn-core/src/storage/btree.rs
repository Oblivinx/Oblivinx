//! Persistent B+ Tree — primary document index.
//!
//! The B+ tree is the "Permanent Tree" in the hybrid B+/LSM architecture.
//! SSTable data is merged into this tree during compaction.
//!
//! Properties (4KB pages, 16-byte UUID keys, 8-byte pointers):
//! - Fanout: ~240
//! - 1 billion documents: ~4 levels max
//! - Point lookup: O(log N) with at most 4 page reads

use parking_lot::RwLock;

use crate::error::OvnResult;

/// Maximum number of key-value pairs per B+ tree leaf node.
/// With 4KB pages, 32-byte header, 16-byte keys + 8-byte pointers + 4-byte overhead:
///   (4096 - 32) / (16 + 8 + 4) ≈ 145 entries per leaf
const DEFAULT_LEAF_CAPACITY: usize = 145;

/// Maximum number of keys per interior node.
/// Interior nodes store keys + child pointers:
///   (4096 - 32 - 8) / (16 + 8) ≈ 169 keys per interior node
const DEFAULT_INTERIOR_CAPACITY: usize = 169;

/// A key-value pair in the B+ tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BTreeEntry {
    /// Document key (typically 16-byte UUID)
    pub key: Vec<u8>,
    /// Document value (OBE-encoded bytes) or pointer to data page
    pub value: Vec<u8>,
    /// Transaction ID of this version
    pub txid: u64,
    /// Tombstone flag
    pub tombstone: bool,
}

/// In-memory B+ Tree node.
#[derive(Debug, Clone)]
enum BPlusNode {
    /// Leaf node containing key-value pairs
    Leaf(LeafNode),
    /// Interior node containing keys and child pointers
    Interior(InteriorNode),
}

/// Leaf node in the B+ tree.
#[derive(Debug, Clone)]
struct LeafNode {
    /// Sorted key-value entries
    entries: Vec<BTreeEntry>,
    /// Pointer to the next leaf (right sibling) — for range scans
    next_leaf: Option<usize>,
}

/// Interior node in the B+ tree.
#[derive(Debug, Clone)]
struct InteriorNode {
    /// Separator keys (N keys)
    keys: Vec<Vec<u8>>,
    /// Child node indices (N+1 children)
    children: Vec<usize>,
}

/// In-memory B+ Tree implementation.
///
/// This is an in-memory prototype. In production, nodes would be stored as
/// pages in the .ovn file and loaded through the Buffer Pool.
pub struct BPlusTree {
    /// All nodes stored in a flat vector (node index = vector index)
    nodes: RwLock<Vec<BPlusNode>>,
    /// Index of the root node
    root: RwLock<Option<usize>>,
    /// Maximum entries per leaf
    leaf_capacity: usize,
    /// Maximum keys per interior node
    interior_capacity: usize,
    /// Total number of entries
    entry_count: RwLock<u64>,
}

impl BPlusTree {
    /// Create a new empty B+ tree.
    pub fn new() -> Self {
        Self {
            nodes: RwLock::new(Vec::new()),
            root: RwLock::new(None),
            leaf_capacity: DEFAULT_LEAF_CAPACITY,
            interior_capacity: DEFAULT_INTERIOR_CAPACITY,
            entry_count: RwLock::new(0),
        }
    }
}

impl Default for BPlusTree {
    fn default() -> Self {
        Self::new()
    }
}

impl BPlusTree {
    /// Create a B+ tree with custom node capacities.
    pub fn with_capacity(leaf_capacity: usize, interior_capacity: usize) -> Self {
        Self {
            nodes: RwLock::new(Vec::new()),
            root: RwLock::new(None),
            leaf_capacity,
            interior_capacity,
            entry_count: RwLock::new(0),
        }
    }

    /// Insert a key-value pair into the B+ tree.
    pub fn insert(&self, entry: BTreeEntry) -> OvnResult<()> {
        let mut nodes = self.nodes.write();
        let mut root_ref = self.root.write();

        if root_ref.is_none() {
            // Tree is empty — create root leaf
            let leaf = LeafNode {
                entries: vec![entry],
                next_leaf: None,
            };
            nodes.push(BPlusNode::Leaf(leaf));
            *root_ref = Some(0);
            *self.entry_count.write() += 1;
            return Ok(());
        }

        let root_idx = root_ref.unwrap();
        let result = Self::insert_recursive(
            &mut nodes,
            root_idx,
            entry,
            self.leaf_capacity,
            self.interior_capacity,
        );

        match result {
            InsertResult::Done => {}
            InsertResult::Split {
                median_key,
                right_idx,
            } => {
                // Root was split — create a new root
                let new_root = InteriorNode {
                    keys: vec![median_key],
                    children: vec![root_idx, right_idx],
                };
                let new_root_idx = nodes.len();
                nodes.push(BPlusNode::Interior(new_root));
                *root_ref = Some(new_root_idx);
            }
        }

        *self.entry_count.write() += 1;
        Ok(())
    }

    /// Point lookup by key.
    pub fn get(&self, key: &[u8]) -> Option<BTreeEntry> {
        let nodes = self.nodes.read();
        let root_ref = self.root.read();

        let root_idx = (*root_ref)?;
        Self::search_recursive(&nodes, root_idx, key)
    }

    /// Range scan [from, to), returning sorted entries.
    pub fn range_scan(&self, from: &[u8], to: &[u8]) -> Vec<BTreeEntry> {
        let nodes = self.nodes.read();
        let root_ref = self.root.read();

        let root_idx = match *root_ref {
            Some(idx) => idx,
            None => return Vec::new(),
        };

        // Find the leaf containing `from`
        let leaf_idx = Self::find_leaf(&nodes, root_idx, from);
        let mut results = Vec::new();
        let mut current_leaf = Some(leaf_idx);

        while let Some(idx) = current_leaf {
            if let BPlusNode::Leaf(leaf) = &nodes[idx] {
                for entry in &leaf.entries {
                    if entry.key.as_slice() >= to {
                        return results;
                    }
                    if entry.key.as_slice() >= from {
                        results.push(entry.clone());
                    }
                }
                current_leaf = leaf.next_leaf;
            } else {
                break;
            }
        }

        results
    }

    /// Delete a key from the B+ tree.
    pub fn delete(&self, key: &[u8]) -> Option<BTreeEntry> {
        let mut nodes = self.nodes.write();
        let root_ref = self.root.read();

        let root_idx = (*root_ref)?;
        let leaf_idx = Self::find_leaf(&nodes, root_idx, key);

        if let BPlusNode::Leaf(leaf) = &mut nodes[leaf_idx] {
            if let Some(pos) = leaf.entries.iter().position(|e| e.key.as_slice() == key) {
                let removed = leaf.entries.remove(pos);
                *self.entry_count.write() -= 1;
                return Some(removed);
            }
        }

        None
    }

    /// Get total number of entries.
    pub fn len(&self) -> u64 {
        *self.entry_count.read()
    }

    /// Check if the tree is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Get all entries in sorted order (full scan).
    pub fn scan_all(&self) -> Vec<BTreeEntry> {
        let nodes = self.nodes.read();
        let root_ref = self.root.read();

        let root_idx = match *root_ref {
            Some(idx) => idx,
            None => return Vec::new(),
        };

        // Find leftmost leaf
        let mut current = root_idx;
        while let BPlusNode::Interior(interior) = &nodes[current] {
            current = interior.children[0];
        }

        let mut results = Vec::new();
        let mut current_leaf = Some(current);
        while let Some(idx) = current_leaf {
            if let BPlusNode::Leaf(leaf) = &nodes[idx] {
                results.extend(leaf.entries.iter().cloned());
                current_leaf = leaf.next_leaf;
            } else {
                break;
            }
        }

        results
    }

    // ── Internal Helpers ───────────────────────────────────────

    fn insert_recursive(
        nodes: &mut Vec<BPlusNode>,
        node_idx: usize,
        entry: BTreeEntry,
        leaf_cap: usize,
        interior_cap: usize,
    ) -> InsertResult {
        match nodes[node_idx].clone() {
            BPlusNode::Leaf(mut leaf) => {
                // Find insertion position
                let pos = leaf.entries.binary_search_by(|e| e.key.cmp(&entry.key));
                match pos {
                    Ok(idx) => {
                        // Key exists — replace (update)
                        leaf.entries[idx] = entry;
                        nodes[node_idx] = BPlusNode::Leaf(leaf);
                        return InsertResult::Done;
                    }
                    Err(idx) => {
                        leaf.entries.insert(idx, entry);
                    }
                }

                if leaf.entries.len() <= leaf_cap {
                    nodes[node_idx] = BPlusNode::Leaf(leaf);
                    InsertResult::Done
                } else {
                    // Split leaf
                    let mid = leaf.entries.len() / 2;
                    let right_entries = leaf.entries.split_off(mid);
                    let median_key = right_entries[0].key.clone();

                    let right_leaf = LeafNode {
                        entries: right_entries,
                        next_leaf: leaf.next_leaf,
                    };
                    let right_idx = nodes.len();
                    leaf.next_leaf = Some(right_idx);

                    nodes[node_idx] = BPlusNode::Leaf(leaf);
                    nodes.push(BPlusNode::Leaf(right_leaf));

                    InsertResult::Split {
                        median_key,
                        right_idx,
                    }
                }
            }
            BPlusNode::Interior(interior) => {
                // Find the child to descend into
                let child_idx = Self::find_child(&interior, &entry.key);
                let child_node_idx = interior.children[child_idx];

                let result =
                    Self::insert_recursive(nodes, child_node_idx, entry, leaf_cap, interior_cap);

                match result {
                    InsertResult::Done => InsertResult::Done,
                    InsertResult::Split {
                        median_key,
                        right_idx,
                    } => {
                        // Child was split — insert median key into this interior node
                        let mut interior = match &nodes[node_idx] {
                            BPlusNode::Interior(i) => i.clone(),
                            _ => unreachable!(),
                        };

                        interior.keys.insert(child_idx, median_key.clone());
                        interior.children.insert(child_idx + 1, right_idx);

                        if interior.keys.len() <= interior_cap {
                            nodes[node_idx] = BPlusNode::Interior(interior);
                            InsertResult::Done
                        } else {
                            // Split interior node
                            let mid = interior.keys.len() / 2;
                            let up_key = interior.keys[mid].clone();

                            let right_keys = interior.keys.split_off(mid + 1);
                            interior.keys.pop(); // remove the promoted key

                            let right_children = interior.children.split_off(mid + 1);

                            let right_interior = InteriorNode {
                                keys: right_keys,
                                children: right_children,
                            };
                            let new_right_idx = nodes.len();
                            nodes[node_idx] = BPlusNode::Interior(interior);
                            nodes.push(BPlusNode::Interior(right_interior));

                            InsertResult::Split {
                                median_key: up_key,
                                right_idx: new_right_idx,
                            }
                        }
                    }
                }
            }
        }
    }

    fn search_recursive(nodes: &[BPlusNode], node_idx: usize, key: &[u8]) -> Option<BTreeEntry> {
        match &nodes[node_idx] {
            BPlusNode::Leaf(leaf) => leaf
                .entries
                .binary_search_by(|e| e.key.as_slice().cmp(key))
                .ok()
                .map(|idx| leaf.entries[idx].clone()),
            BPlusNode::Interior(interior) => {
                let child_idx = Self::find_child(interior, key);
                Self::search_recursive(nodes, interior.children[child_idx], key)
            }
        }
    }

    fn find_leaf(nodes: &[BPlusNode], node_idx: usize, key: &[u8]) -> usize {
        match &nodes[node_idx] {
            BPlusNode::Leaf(_) => node_idx,
            BPlusNode::Interior(interior) => {
                let child_idx = Self::find_child(interior, key);
                Self::find_leaf(nodes, interior.children[child_idx], key)
            }
        }
    }

    fn find_child(interior: &InteriorNode, key: &[u8]) -> usize {
        // In a B+ tree, all data lives in leaves.
        // Separator key S at index i means: keys < S go to children[i], keys >= S go to children[i+1].
        // binary_search returns Ok(i) on exact match — we must return i+1 (go RIGHT).
        match interior.keys.binary_search_by(|k| k.as_slice().cmp(key)) {
            Ok(idx) => idx + 1, // exact match → right child
            Err(idx) => idx,    // not found → insertion point (left/right)
        }
    }
}

enum InsertResult {
    Done,
    Split {
        median_key: Vec<u8>,
        right_idx: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(key: &str, value: &str, txid: u64) -> BTreeEntry {
        BTreeEntry {
            key: key.as_bytes().to_vec(),
            value: value.as_bytes().to_vec(),
            txid,
            tombstone: false,
        }
    }

    #[test]
    fn test_btree_insert_and_get() {
        let tree = BPlusTree::new();
        tree.insert(make_entry("key_b", "val_b", 1)).unwrap();
        tree.insert(make_entry("key_a", "val_a", 2)).unwrap();
        tree.insert(make_entry("key_c", "val_c", 3)).unwrap();

        let result = tree.get(b"key_a").unwrap();
        assert_eq!(result.value, b"val_a");
        assert_eq!(result.txid, 2);

        let result = tree.get(b"key_b").unwrap();
        assert_eq!(result.value, b"val_b");

        assert!(tree.get(b"key_d").is_none());
    }

    #[test]
    fn test_btree_range_scan() {
        let tree = BPlusTree::new();
        for i in 0..10u32 {
            let key = format!("key_{:03}", i);
            let val = format!("val_{}", i);
            tree.insert(make_entry(&key, &val, i as u64)).unwrap();
        }

        let results = tree.range_scan(b"key_003", b"key_007");
        assert_eq!(results.len(), 4); // key_003, key_004, key_005, key_006
    }

    #[test]
    fn test_btree_split() {
        // Use small capacity to force splits
        let tree = BPlusTree::with_capacity(4, 4);
        for i in 0..20u32 {
            let key = format!("key_{:04}", i);
            tree.insert(make_entry(&key, "v", i as u64)).unwrap();
        }

        assert_eq!(tree.len(), 20);

        // All keys should be findable
        for i in 0..20u32 {
            let key = format!("key_{:04}", i);
            assert!(tree.get(key.as_bytes()).is_some(), "Missing key: {key}");
        }
    }

    #[test]
    fn test_btree_delete() {
        let tree = BPlusTree::new();
        tree.insert(make_entry("a", "1", 1)).unwrap();
        tree.insert(make_entry("b", "2", 2)).unwrap();

        let removed = tree.delete(b"a").unwrap();
        assert_eq!(removed.value, b"1");
        assert!(tree.get(b"a").is_none());
        assert!(tree.get(b"b").is_some());
    }

    #[test]
    fn test_btree_update() {
        let tree = BPlusTree::new();
        tree.insert(make_entry("key", "old", 1)).unwrap();
        tree.insert(make_entry("key", "new", 2)).unwrap();

        let result = tree.get(b"key").unwrap();
        assert_eq!(result.value, b"new");
        assert_eq!(result.txid, 2);
    }

    #[test]
    fn test_btree_scan_all() {
        let tree = BPlusTree::new();
        tree.insert(make_entry("c", "3", 3)).unwrap();
        tree.insert(make_entry("a", "1", 1)).unwrap();
        tree.insert(make_entry("b", "2", 2)).unwrap();

        let all = tree.scan_all();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].key, b"a");
        assert_eq!(all[1].key, b"b");
        assert_eq!(all[2].key, b"c");
    }
}
