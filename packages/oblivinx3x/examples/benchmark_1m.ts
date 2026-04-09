import { Oblivinx3x } from '../dist/index.js';
import * as fs from 'fs';
import * as path from 'path';

// Thresholds & Constants
const TOTAL_DOCS = 1_000_000;
const BATCH_SIZE = 10_000;
const DB_PATH = path.join(process.cwd(), 'benchmark_1m.ovn');

interface SensorData {
  sensor_id: string;
  temperature: number;
  humidity: number;
  timestamp: number;
  active: boolean;
}

async function runBenchmark() {
  console.log(`===============================================`);
  console.log(`🚀 Oblivinx3x 1-Million Record Benchmark`);
  console.log(`===============================================`);

  // Cleanup past DB
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }

  // Open Database with optimized configuration
  console.log(`[1] Opening Database Engine...`);
  const db = new Oblivinx3x(DB_PATH, {
    bufferPool: '1GB',
    compression: 'lz4',
    pageSize: 8192
  });

  // Create Collection
  await db.createCollection('sensors', {
    timeseries: {
      timeField: 'timestamp',
      metaField: 'sensor_id',
      granularity: 'seconds'
    }
  });

  const sensors = db.collection<SensorData>('sensors');

  // Insert Benchmark
  console.log(`[2] Starting Insertion of ${TOTAL_DOCS.toLocaleString()} Documents...`);
  let start = performance.now();
  
  for (let i = 0; i < TOTAL_DOCS; i += BATCH_SIZE) {
    const batch: SensorData[] = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      batch.push({
        sensor_id: `sensor_${(i + j) % 100}`, // 100 distinctive sensors
        temperature: 20 + Math.random() * 15,
        humidity: 30 + Math.random() * 40,
        timestamp: Date.now() - (i + j) * 1000,
        active: true
      });
    }
    
    await sensors.insertMany(batch);
    if ((i + BATCH_SIZE) % 100_000 === 0) {
      console.log(`    ...inserted ${(i + BATCH_SIZE).toLocaleString()} docs`);
    }
  }
  
  let end = performance.now();
  console.log(`✅ Insertion Complete!`);
  console.log(`   Time Taken: ${((end - start) / 1000).toFixed(2)}s`);
  console.log(`   Throughput: ${((TOTAL_DOCS / (end - start)) * 1000).toFixed(0)} ops/sec\n`);

  // Indexing Benchmark
  console.log(`[3] Creating Indexes...`);
  start = performance.now();
  await sensors.createIndex({ sensor_id: 1, timestamp: -1 });
  end = performance.now();
  console.log(`✅ Index Creation Complete!`);
  console.log(`   Time Taken: ${((end - start) / 1000).toFixed(2)}s\n`);

  // Query Benchmark
  console.log(`[4] Querying Data (Filter + Sort + Limit)...`);
  start = performance.now();
  const results = await sensors.find(
    { sensor_id: 'sensor_42' }, 
    { sort: { timestamp: -1 }, limit: 10 }
  );
  end = performance.now();
  console.log(`✅ Query Complete!`);
  console.log(`   Found: ${results.length} docs`);
  console.log(`   Time Taken: ${(end - start).toFixed(2)}ms\n`); // ms format since read is usually blazing fast

  // Count Benchmark
  console.log(`[5] Counting Active Sensors...`);
  start = performance.now();
  const activeCount = await sensors.countDocuments({ active: true });
  end = performance.now();
  console.log(`✅ Count Complete!`);
  console.log(`   Active Count: ${activeCount.toLocaleString()}`);
  console.log(`   Time Taken: ${(end - start).toFixed(2)}ms\n`);

  // Metrics
  console.log(`[6] Current Engine Metrics:`);
  const metrics = await db.getMetrics();
  console.log(JSON.stringify(metrics, null, 2));

  // Teardown
  console.log(`\n[7] Cleaning and Closing Database...`);
  await db.close();
  console.log(`✅ Done.`);
}

runBenchmark().catch(err => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
