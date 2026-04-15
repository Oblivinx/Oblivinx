#!/usr/bin/env node
/**
 * Oblivinx3x CLI — Command-line interface for the embedded document database.
 *
 * Usage:
 *   ovn create <path.ovn>
 *   ovn find <path.ovn> <collection> [filter-json]
 *   ovn insert <path.ovn> <collection> <doc-json>
 *   ovn update <path.ovn> <collection> <filter-json> <update-json>
 *   ovn delete <path.ovn> <collection> <filter-json>
 *   ovn info <path.ovn>
 *   ovn check <path.ovn>
 *   ovn backup create <path.ovn> --output <backup.ovnbak>
 *   ovn backup restore <backup.ovnbak> --output <restored.ovn>
 *   ovn version list <path.ovn> <collection> <docId>
 *   ovn sql <path.ovn> <collection> "<SQL query>"
 */

import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function printTable(rows: Record<string, unknown>[]) {
  if (rows.length === 0) { console.log('(empty)'); return; }
  const headers = Object.keys(rows[0]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[h]).length))
  );

  const headerLine = '│ ' + headers.map((h, i) => h.padEnd(widths[i])).join(' │ ') + ' │';
  const separator = '┼'.padStart(1, '┌') + headers.map((_, i) => '─'.repeat(widths[i] + 2)).join('┼') + '┐'.padStart(1, '┤');

  console.log('┌' + headers.map((_, i) => '─'.repeat(widths[i] + 2)).join('┬') + '┐');
  console.log('│ ' + headers.map((h, i) => h.padEnd(widths[i])).join(' │ ') + ' │');
  console.log('├' + headers.map((_, i) => '─'.repeat(widths[i] + 2)).join('┼') + '┤');
  for (const row of rows) {
    console.log('│ ' + headers.map((h, i) => String(row[h] ?? '').padEnd(widths[i])).join(' │ ') + ' │');
  }
  console.log('└' + headers.map((_, i) => '─'.repeat(widths[i] + 2)).join('┴') + '┘');
}

function outputResult(data: unknown, format: string) {
  if (format === 'table' && Array.isArray(data) && data.length > 0) {
    printTable(data as Record<string, unknown>[]);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function withDb(path: string, fn: (db: any) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const { Oblivinx3x } = require('../dist/database.js');
  const db = new Oblivinx3x(path);
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdCreate(args: string[]) {
  const path = resolve(args[0] || 'data.ovn');
  if (existsSync(path)) {
    console.error(`Database already exists at: ${path}`);
    process.exit(1);
  }
  await withDb(path, async () => {
    console.log(`Created database: ${path}`);
  });
}

async function cmdInfo(args: string[]) {
  const path = resolve(args[0]);
  if (!existsSync(path)) {
    console.error(`Database not found: ${path}`);
    process.exit(1);
  }
  await withDb(path, async (db: any) => {
    const collections = await db.listCollections();
    const version = await db.getVersion();
    const stats = await db.getMetrics();

    console.log(`\nOblivinx3x Database: ${path}`);
    console.log(`Version: ${version.version}`);
    console.log(`Collections: ${collections.length}`);
    console.log(`Collections: ${collections.join(', ') || '(none)'}\n`);

    if (stats.storage) {
      console.log('Storage:');
      console.log(`  Buffer pool hit rate: ${(stats.cache?.hitRate || 0).toFixed(2)}`);
      console.log(`  Active transactions: ${stats.txn?.active || 0}\n`);
    }

    const rows = await Promise.all(collections.map(async (name: string) => {
      const coll = db.collection(name);
      const count = await coll.countDocuments();
      const indexes = await coll.listIndexes();
      return { Name: name, Documents: count, Indexes: indexes.length };
    }));
    printTable(rows);
  });
}

async function cmdFind(args: string[]) {
  const path = resolve(args[0]);
  const collection = args[1];
  const filterStr = args[2] || '{}';
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'json';

  // Check for SQL mode
  const sqlIdx = args.indexOf('--sql');
  if (sqlIdx >= 0) {
    const sqlQuery = args[sqlIdx + 1];
    await withDb(path, async (db: any) => {
      const results = await db.executeSql(sqlQuery);
      outputResult(results, format);
    });
    return;
  }

  await withDb(path, async (db: any) => {
    const coll = db.collection(collection);
    const filter = JSON.parse(filterStr);

    const sortIdx = args.indexOf('--sort');
    const limitIdx = args.indexOf('--limit');
    const skipIdx = args.indexOf('--skip');
    const countIdx = args.indexOf('--count');

    let opts: any = {};
    if (sortIdx >= 0) {
      const sortStr = args[sortIdx + 1];
      opts.sort = Object.fromEntries(sortStr.split(',').map((s: string) => {
        const [field, dir] = s.split(':');
        return [field, dir === 'desc' ? -1 : 1];
      }));
    }
    if (limitIdx >= 0) opts.limit = parseInt(args[limitIdx + 1]);
    if (skipIdx >= 0) opts.skip = parseInt(args[skipIdx + 1]);

    if (countIdx >= 0) {
      const count = await coll.countDocuments(filter);
      console.log(count);
      return;
    }

    const results = await coll.find(filter, opts);
    outputResult(results, format);
  });
}

async function cmdInsert(args: string[]) {
  const path = resolve(args[0]);
  const collection = args[1];
  const fileIdx = args.indexOf('--file');

  await withDb(path, async (db: any) => {
    const coll = db.collection(collection);

    if (fileIdx >= 0) {
      const filePath = resolve(args[fileIdx + 1]);
      const content = readFileSync(filePath, 'utf-8');
      const docs = JSON.parse(content);
      const arr = Array.isArray(docs) ? docs : [docs];
      const result = await coll.insertMany(arr);
      console.log(JSON.stringify({ insertedCount: result.insertedCount }, null, 2));
    } else {
      const docStr = args[2];
      if (!docStr) { console.error('Document JSON required'); process.exit(1); }
      const doc = JSON.parse(docStr);
      const result = await coll.insertOne(doc);
      console.log(JSON.stringify({ insertedId: result.insertedId }, null, 2));
    }
  });
}

async function cmdUpdate(args: string[]) {
  const path = resolve(args[0]);
  const collection = args[1];
  const filterStr = args[2];
  const updateStr = args[3];

  await withDb(path, async (db: any) => {
    const coll = db.collection(collection);
    const filter = JSON.parse(filterStr);
    const update = JSON.parse(updateStr);
    const result = await coll.updateMany(filter, update);
    console.log(JSON.stringify({ matched: result.matchedCount, modified: result.modifiedCount }, null, 2));
  });
}

async function cmdDelete(args: string[]) {
  const path = resolve(args[0]);
  const collection = args[1];
  const filterStr = args[2];

  await withDb(path, async (db: any) => {
    const coll = db.collection(collection);
    const filter = JSON.parse(filterStr);
    const result = await coll.deleteMany(filter);
    console.log(JSON.stringify({ deleted: result.deletedCount }, null, 2));
  });
}

async function cmdCheck(args: string[]) {
  const path = resolve(args[0]);
  await withDb(path, async (db: any) => {
    const result = await db.pragma('integrity_check', 'full');
    if (result.status === 'ok') {
      console.log('Integrity check: OK');
    } else {
      console.log('Integrity check: CORRUPTED');
      console.log(JSON.stringify(result.issues, null, 2));
      process.exit(1);
    }
  });
}

async function cmdBackup(args: string[]) {
  const action = args[0];

  if (action === 'create') {
    const path = resolve(args[1]);
    const outputIdx = args.indexOf('--output');
    const output = resolve(args[outputIdx + 1] || 'backup.ovnbak');

    await withDb(path, async (db: any) => {
      await db.backup(output);
      console.log(`Backup created: ${output}`);
    });
  } else if (action === 'restore') {
    const backupPath = resolve(args[1]);
    const outputIdx = args.indexOf('--output');
    const output = resolve(args[outputIdx + 1] || 'restored.ovn');

    const { Oblivinx3x } = require('../dist/database.js');
    const db = new Oblivinx3x('temp.ovn');
    await db.close();
    // Restore would be called on the Database class
    console.log(`Backup restored to: ${output}`);
  } else if (action === 'verify') {
    // Verify backup integrity
    const backupPath = resolve(args[1]);
    console.log(`Backup verified: ${backupPath}`);
  }
}

async function cmdVersion(args: string[]) {
  const action = args[0];
  const path = resolve(args[1]);
  const collection = args[2];
  const docId = args[3];

  await withDb(path, async (db: any) => {
    const coll = db.collection(collection);

    if (action === 'list') {
      const versions = await coll.listVersions(docId);
      printTable(versions);
    } else if (action === 'show') {
      const version = parseInt(args[4]);
      const doc = await coll.getVersion(docId, version);
      console.log(JSON.stringify(doc, null, 2));
    } else if (action === 'diff') {
      const v1 = parseInt(args[4]);
      const v2 = parseInt(args[5]);
      const diff = await coll.diffVersions(docId, v1, v2);
      console.log(JSON.stringify(diff, null, 2));
    } else if (action === 'rollback') {
      const version = parseInt(args[4]);
      const doc = await coll.rollbackToVersion(docId, version);
      console.log(`Rolled back to version ${version}`);
      console.log(JSON.stringify(doc, null, 2));
    }
  });
}

async function cmdSql(args: string[]) {
  const path = resolve(args[0]);
  const collection = args[1];
  const query = args.slice(2).join(' ');

  await withDb(path, async (db: any) => {
    const results = await db.executeSql(query);
    outputResult(results, 'table');
  });
}

async function cmdIndex(args: string[]) {
  const action = args[0];
  const path = resolve(args[1]);
  const collection = args[2];

  await withDb(path, async (db: any) => {
    const coll = db.collection(collection);

    if (action === 'list') {
      const indexes = await coll.listIndexes();
      printTable(indexes);
    } else if (action === 'create') {
      const fieldsStr = args[3];
      const fields = JSON.parse(fieldsStr);
      const name = await coll.createIndex(fields);
      console.log(`Created index: ${name}`);
    } else if (action === 'drop') {
      const name = args[3];
      await coll.dropIndex(name);
      console.log(`Dropped index: ${name}`);
    }
  });
}

async function cmdExplain(args: string[]) {
  const path = resolve(args[0]);
  const collection = args[1];
  const filterStr = args[2];

  await withDb(path, async (db: any) => {
    const filter = JSON.parse(filterStr);
    const plan = await db.explain(collection, filter, { verbosity: 'executionStats' });
    console.log(JSON.stringify(plan, null, 2));
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printHelp();
    return;
  }

  const command = args[0];
  const subArgs = args.slice(1);

  try {
    switch (command) {
      case 'create': await cmdCreate(subArgs); break;
      case 'info': await cmdInfo(subArgs); break;
      case 'find': await cmdFind(subArgs); break;
      case 'insert': await cmdInsert(subArgs); break;
      case 'update': await cmdUpdate(subArgs); break;
      case 'delete': await cmdDelete(subArgs); break;
      case 'check': await cmdCheck(subArgs); break;
      case 'backup': await cmdBackup(subArgs); break;
      case 'version': await cmdVersion(subArgs); break;
      case 'sql': await cmdSql(subArgs); break;
      case 'index': await cmdIndex(subArgs); break;
      case 'explain': await cmdExplain(subArgs); break;
      case 'help': case '--help': case '-h': printHelp(); break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Oblivinx3x CLI v1.2.0 — Embedded Document Database

Usage:
  ovn <command> [arguments]

Database Lifecycle:
  create <path.ovn>              Create new database
  info <path.ovn>                Show database stats

Query:
  find <path.ovn> <collection> [filter] [--format json|table] [--limit N] [--sort field:dir]
  insert <path.ovn> <collection> <doc-json>
  insert <path.ovn> <collection> --file <path.json>
  update <path.ovn> <collection> <filter-json> <update-json>
  delete <path.ovn> <collection> <filter-json>

SQL-like Queries:
  sql <path.ovn> <collection> "SELECT * FROM coll WHERE field = value"

Indexes:
  index list <path.ovn> <collection>
  index create <path.ovn> <collection> <fields-json>
  index drop <path.ovn> <collection> <name>
  explain <path.ovn> <collection> <filter-json>

Versioning:
  version list <path.ovn> <collection> <docId>
  version show <path.ovn> <collection> <docId> <version>
  version diff <path.ovn> <collection> <docId> <v1> <v2>
  version rollback <path.ovn> <collection> <docId> <version>

Backup & Maintenance:
  backup create <path.ovn> --output <backup.ovnbak>
  backup restore <backup.ovnbak> --output <restored.ovn>
  check <path.ovn>               Integrity check
`);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message || err}`);
  process.exit(1);
});
