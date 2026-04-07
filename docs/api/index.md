# Developer API Reference - Oblivinx3x

Welcome to the Oblivinx3x API documentation. This reference details how to use the high-performance embedded database out of the box with Node.js.

## Initializing the Database

```javascript
import { Oblivinx3x } from 'oblivinx3x';

// Opens or creates a database at the specified path
const db = new Oblivinx3x('mydb.ovn', {
  pageSize: 4096,          // Internal B+ Tree page size
  bufferPool: '256MB',     // LRU memory cache
  walMode: true,           // Write-Ahead Logging for safety
  compression: 'lz4'       // Transparent page compression
});
```

## Collection Management

Create strict typed JSON schema collections and track records.

```javascript
// Creates a new Collection registry
await db.createCollection('telemetry');

// Gets the list of available collections
const list = await db.listCollections(); // ['telemetry']
```

## CRUD Commands

```javascript
const coll = db.collection('telemetry');

// Insert single
const tx = await coll.insertOne({ point: [1, 2], active: true });
console.log(tx.insertedId); // UUID

// Insert multiple
await coll.insertMany([{ point: [3, 4] }, { point: [5, 6] }]);

// Query the DB
const points = await coll.find({ 'point.1': { $gt: 2 } });

// Upgrading an existing field safely
await coll.updateOne({ _id: tx.insertedId }, { $set: { active: false } });

// Deleting
await coll.deleteOne({ "active": false });
```

## Maintenance & Observability 

To inspect cache hits or active I/O loads:

```javascript
const stats = await db.getMetrics();
console.log(stats.io.pagesRead);
console.log(stats.cache.hitRate);
console.log(stats.txn.committed);
```

Once execution is finalized, you must always release the Neon pointers correctly:
```javascript
await db.close();
```
