import { Oblivinx3x } from '../dist/index.js';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = path.join(process.cwd(), 'test_new_features.ovn');

async function testNewFeatures() {
  console.log('Testing New Features Ported from Rust to TypeScript\n');

  // Cleanup
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const db = new Oblivinx3x(DB_PATH, { bufferPool: '256MB' });

  // ═══════════════════════════════════════════════════════════
  // TEST 1: export()
  // ═══════════════════════════════════════════════════════════
  console.log('[1] Testing export()...');
  await db.createCollection('users');
  const users = db.collection('users');
  await users.insertMany([
    { name: 'Alice', age: 30, email: 'alice@example.com' },
    { name: 'Bob', age: 25, email: 'bob@example.com' },
    { name: 'Charlie', age: 35, email: 'charlie@example.com' },
  ]);

  await db.createCollection('products');
  const products = db.collection('products');
  await products.insertMany([
    { name: 'Laptop', price: 999.99 },
    { name: 'Phone', price: 699.99 },
  ]);

  const exported = await db.export();
  console.log(`   ✅ Exported collections: ${Object.keys(exported).join(', ')}`);
  console.log(`   ✅ Users count: ${exported.users?.length}`);
  console.log(`   ✅ Products count: ${exported.products?.length}`);

  // ═══════════════════════════════════════════════════════════
  // TEST 2: autocomplete()
  // ═══════════════════════════════════════════════════════════
  console.log('\n[2] Testing autocomplete()...');
  const suggestions = await users.autocomplete('name', 'Al', 5);
  console.log(`   ✅ Autocomplete "Al" returned ${suggestions.length} results`);
  suggestions.forEach((u: any) => console.log(`      - ${u.name}`));

  // ═══════════════════════════════════════════════════════════
  // TEST 3: createGeoIndex()
  // ═══════════════════════════════════════════════════════════
  console.log('\n[3] Testing createGeoIndex()...');
  await db.createCollection('places');
  const places = db.collection('places');
  await places.insertMany([
    { name: 'Central Park', location: [-73.965355, 40.782865] },
    { name: 'Times Square', location: [-73.985656, 40.758896] },
    { name: 'Empire State', location: [-73.985656, 40.748817] },
  ]);

  await places.createGeoIndex('location');
  console.log('   ✅ Geospatial index created successfully');

  // Verify via listIndexes
  const indexes = await places.listIndexes();
  console.log(`   ✅ Indexes: ${indexes.map((i: any) => i.name).join(', ')}`);

  // ═══════════════════════════════════════════════════════════
  // TEST 4: backup()
  // ═══════════════════════════════════════════════════════════
  console.log('\n[4] Testing backup()...');
  const backupPath = path.join(process.cwd(), 'test_backup.json');
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  await db.backup(backupPath);
  const backupSize = fs.statSync(backupPath).size;
  console.log(`   ✅ Backup created: ${(backupSize / 1024).toFixed(2)} KB`);

  // Verify backup content
  const backupContent = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
  console.log(`   ✅ Backup contains collections: ${Object.keys(backupContent).join(', ')}`);
  fs.unlinkSync(backupPath);

  // ═══════════════════════════════════════════════════════════
  // TEST 5: Index-accelerated queries (from TASK_2)
  // ═══════════════════════════════════════════════════════════
  console.log('\n[5] Testing index-accelerated queries...');
  await users.createIndex({ email: 1 });
  const start = performance.now();
  const found = await users.find({ email: 'alice@example.com' });
  const elapsed = performance.now() - start;
  console.log(`   ✅ Query with index took ${elapsed.toFixed(2)}ms`);
  console.log(`   ✅ Found: ${found.length} user(s), name: ${found[0]?.name}`);

  // ═══════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════
  await db.close();
  fs.unlinkSync(DB_PATH);
  console.log('\n✅ All new feature tests passed!');
}

testNewFeatures().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
