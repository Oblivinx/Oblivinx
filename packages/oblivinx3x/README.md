# Oblivinx3x

**High-Performance Embedded Document Database** — Built in Rust, available for Node.js.

[![npm version](https://img.shields.io/npm/v/oblivinx3x.svg)](https://npm.im/oblivinx3x)
[![CI](https://github.com/natz/oblivinx3x/actions/workflows/ci.yml/badge.svg)](https://github.com/natz/oblivinx3x/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A MongoDB-compatible embedded document database. Single file, zero configuration, in-process. Written in Rust with MVCC concurrency and ACID transactions.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Storage** | Hybrid B+/LSM engine — LSM write path + B+ tree read path |
| **Indexing** | AHIT (Adaptive Hybrid Index Tree) — auto-promotes hot index nodes to memory |
| **Concurrency** | Full MVCC — multiple readers + single writer, no reader blocking |
| **Transactions** | ACID with Snapshot Isolation, optional Serializable mode |
| **Compression** | LZ4 (fast) or Zstd (compact) page-level compression |
| **Query** | MongoDB Query Language (MQL) subset — filter, update, aggregation pipeline |
| **Format** | Single `.ovn` file — binary, page-oriented, CRC32 integrity |
| **Platforms** | Windows x64 · Linux x64 · Linux ARM64 · macOS x64 · macOS ARM64 |

---

## 📦 Installation

```bash
npm install oblivinx3x
```

Pre-built native binaries are automatically selected for your platform — **no Rust installation required**.

---

## 🚀 Quick Start

```javascript
import { Oblivinx3x } from 'oblivinx3x';

// Open or create a database
const db = new Oblivinx3x('mydb.ovn', {
  compression: 'lz4',    // Optional: 'none' | 'lz4' | 'zstd'
  bufferPool: '256MB',   // Optional: buffer pool size
});

// Get a collection reference (auto-created on first insert)
const users = db.collection('users');

// ── Insert ────────────────────────────────────────────────────────
const { insertedId } = await users.insertOne({
  name: 'Alice Kim',
  age: 28,
  email: 'alice@example.com',
  address: { city: 'Jakarta', country: 'ID' },
  tags: ['admin', 'developer'],
});
console.log('Inserted:', insertedId);

// ── Find ──────────────────────────────────────────────────────────
const results = await users.find(
  { age: { $gt: 18 }, 'address.city': 'Jakarta' },
  { sort: { age: -1 }, limit: 10, projection: { name: 1, age: 1 } }
);

const alice = await users.findOne({ email: 'alice@example.com' });
const count  = await users.countDocuments({ active: true });

// ── Update ────────────────────────────────────────────────────────
await users.updateOne(
  { name: 'Alice Kim' },
  { $set: { age: 29 }, $push: { tags: 'senior' } }
);

await users.updateMany(
  { 'address.country': 'ID' },
  { $set: { verified: true } }
);

// ── Delete ────────────────────────────────────────────────────────
await users.deleteOne({ name: 'Alice Kim' });
await users.deleteMany({ active: false });

// ── Aggregation Pipeline ──────────────────────────────────────────
const stats = await users.aggregate([
  { $match: { active: true } },
  { $group: {
      _id: '$address.country',
      userCount: { $sum: 1 },
      avgAge:    { $avg: '$age' },
  }},
  { $sort: { userCount: -1 } },
  { $limit: 5 },
]);

// ── Indexes ───────────────────────────────────────────────────────
await users.createIndex({ age: 1 });                          // Single field
await users.createIndex({ 'address.city': 1, age: -1 });     // Compound
await users.createIndex({ content: 'text', title: 'text' }); // Full-text

const indexes = await users.listIndexes();
await users.dropIndex('age_1');

// ── Transactions ──────────────────────────────────────────────────
const txn = await db.beginTransaction();
try {
  await txn.update('accounts', { userId: 'u1' }, { $inc: { balance: -200 } });
  await txn.update('accounts', { userId: 'u2' }, { $inc: { balance: 200 } });
  await txn.commit();
} catch (err) {
  await txn.rollback();
  throw err;
}

// ── Metrics ───────────────────────────────────────────────────────
const metrics = await db.getMetrics();
console.log({
  cacheHitRate: metrics.cache.hitRate,
  btreeEntries: metrics.storage.btreeEntries,
  activeTxns:   metrics.txn.activeCount,
});

// ── Close ─────────────────────────────────────────────────────────
await db.close();
```

---

## 🔍 Supported MQL Operators

### Filter Operators
| Category | Operators |
|---|---|
| Comparison | `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin` |
| Logical | `$and`, `$or`, `$not`, `$nor` |
| Array | `$all`, `$elemMatch`, `$size` |
| Element | `$exists`, `$type` |
| Evaluation | `$regex` |

### Update Operators
| Category | Operators |
|---|---|
| Field | `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$rename`, `$currentDate` |
| Array | `$push`, `$pull`, `$addToSet`, `$pop` |

### Aggregation Stages
`$match` · `$group` · `$project` · `$sort` · `$limit` · `$skip` · `$unwind` · `$lookup` · `$count`

### Aggregation Accumulators
`$sum` · `$avg` · `$min` · `$max` · `$first` · `$last` · `$push` · `$addToSet`

---

## ⚙️ Configuration

```javascript
const db = new Oblivinx3x('path/to/db.ovn', {
  pageSize:   4096,      // Page size in bytes: 512–65536 (default: 4096)
  bufferPool: '256MB',   // Buffer pool: '64MB' | '256MB' | '1GB' (default: '256MB')
  readOnly:   false,     // Read-only mode (default: false)
  compression: 'lz4',   // Compression: 'none' | 'lz4' | 'zstd' (default: 'none')
  walMode:    true,      // Write-Ahead Log (default: true)
});
```

---

## 🏗️ Building from Source

If you need to build from source (e.g., unsupported platform):

```bash
# Prerequisites: Rust (https://rustup.rs/) + Node.js >= 18

# Windows
.\scripts\build.ps1

# Linux / macOS
./scripts/build.sh

# Or via npm
npm run build
```

---

## 📊 Architecture

```
┌─────────────────────────────────────────────────────┐
│          JavaScript / TypeScript API                │
├─────────────────────────────────────────────────────┤
│          Neon FFI Bindings (Rust → Node.js)         │
├─────────────────────────────────────────────────────┤
│          Query Engine (MQL Parser + Optimizer)      │
├─────────────────────────────────────────────────────┤
│          AHIT Index Engine (Adaptive B+/LSM Hybrid) │
├─────────────────────────────────────────────────────┤
│          MVCC Transaction Layer                     │
├─────────────────────────────────────────────────────┤
│          Storage Engine (WAL + MemTable + B+ Tree)  │
├─────────────────────────────────────────────────────┤
│          .OVN File Format (single file, CRC32)     │
└─────────────────────────────────────────────────────┘
```

### Key Design Choices

- **AHIT (Adaptive Hybrid Index Tree)** — Combines B+ tree sorted scans with LSM write efficiency. A background "Promoter" thread moves frequently accessed index subtrees to memory (Hot Zone), eliminating disk I/O for hot key ranges.
- **Hybrid B+/LSM Storage** — Writes go to an in-memory MemTable (skip list), then flush to L0 SSTables. Background compaction merges into a persistent B+ tree. Provides LSM write throughput + B+ scan efficiency.
- **Full MVCC** — Every document write creates a new version with a TxID. Readers see a snapshot at transaction-start time. A GC thread purges versions older than the oldest active snapshot.
- **Single `.ovn` File** — All pages (data, index, WAL, metadata) are stored in one file. The header at page 0 contains root pointers and crash-recovery flags.

---

## 📄 License

MIT © Natz
