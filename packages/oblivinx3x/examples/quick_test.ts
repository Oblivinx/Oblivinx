import { Oblivinx3x } from '../dist/index.js';
import * as fs from 'fs';
import * as path from 'path';

const TOTAL_DOCS = 10_000;
const BATCH_SIZE = 1_000;
const DB_PATH = path.join(process.cwd(), 'quick_test.ovn');

async function runQuickTest() {
  console.log(`Quick Test: Insert ${TOTAL_DOCS.toLocaleString()} Documents`);

  // Cleanup past DB
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }

  // Open Database
  const db = new Oblivinx3x(DB_PATH, {
    bufferPool: '256MB',
    compression: 'lz4',
  });

  // Create Collection
  await db.createCollection('test');
  const col = db.collection('test');

  // Insert documents
  let start = performance.now();
  for (let i = 0; i < TOTAL_DOCS; i += BATCH_SIZE) {
    const batch = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      batch.push({
        name: `user_${i + j}`,
        age: 20 + (j % 50),
        score: Math.random() * 100,
        active: true
      });
    }
    await col.insertMany(batch);
  }
  let insertTime = performance.now() - start;
  console.log(`✅ Inserted ${TOTAL_DOCS.toLocaleString()} docs in ${(insertTime / 1000).toFixed(2)}s`);

  // Check file size BEFORE close
  const sizeBefore = fs.statSync(DB_PATH).size;
  console.log(`📁 File size BEFORE close: ${(sizeBefore / 1024).toFixed(2)} KB`);

  // Close database
  await db.close();

  // Check file size AFTER close
  const sizeAfter = fs.statSync(DB_PATH).size;
  console.log(`📁 File size AFTER close: ${(sizeAfter / 1024).toFixed(2)} KB (${(sizeAfter / 1024 / 1024).toFixed(2)} MB)`);

  // Verify data can be read back
  console.log('\n📖 Re-opening database to verify data persistence...');
  const db2 = new Oblivinx3x(DB_PATH, {
    bufferPool: '256MB',
    compression: 'lz4',
  });
  const col2 = db2.collection('test');
  const count = await col2.countDocuments({});
  console.log(`✅ Documents found after restart: ${count.toLocaleString()}`);

  // Query test
  const results = await col2.find({ active: true }, { limit: 5 });
  console.log(`✅ Sample query returned ${results.length} docs`);
  if (results.length > 0) {
    console.log(`   First doc: ${JSON.stringify(results[0]).substring(0, 100)}...`);
  }

  await db2.close();

  // Cleanup
  fs.unlinkSync(DB_PATH);
  console.log('\n✅ Test completed successfully!');
}

runQuickTest().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
