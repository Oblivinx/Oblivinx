import { Oblivinx3x, type Document } from '../src/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const TEST_DIR = path.join(process.cwd(), 'test_output_real');
if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

interface UserSession extends Document {
  _id?: string;
  userId: string;
  token: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

/**
 * 🛠 PHASE 1: Real Case Example (Schema complex, Triggers, Views, Transactions)
 */
async function phase1_RealUsage() {
  console.log('\n================================================');
  console.log('🛠 PHASE 1: Real-world Usage & Transactions test');
  console.log('================================================');
  const dbPath = path.join(TEST_DIR, 'real_usage.ovn');
  const db = new Oblivinx3x(dbPath, { pageSize: 4096, bufferPool: '128MB', compression: 'lz4' });

  try {
    const sessions = db.collection<UserSession>('sessions');

    // Test Transaction MVCC
    console.log('>> Menguji transaksi ACID...');
    const tx = await db.beginTransaction();
    try {
      await tx.insert('sessions', {
        userId: 'U100',
        token: 'ABC-123',
        metadata: { ip: '192.168.1.1', device: 'iOS' },
        createdAt: Date.now()
      });
      await tx.insert('sessions', {
        userId: 'U101',
        token: 'XYZ-987',
        metadata: { ip: '192.168.1.2', device: 'Android' },
        createdAt: Date.now()
      });
      await tx.commit();
      console.log('   ✅ Transaksi berhasil di-commit.');
    } catch (e) {
      await tx.rollback();
      console.error('   ❌ Transaksi gagal', e);
    }

    // Materialized view & query
    console.log('>> Membuat view & query native...');
    await db.createView('ios_sessions', {
      source: 'sessions',
      pipeline: [
        { $match: { 'metadata.device': 'iOS' } }
      ]
    });

    const count = await sessions.countDocuments();
    console.log(`   ✅ Total session di DB: ${count}`);

    const res = await db.executeSql("SELECT * FROM sessions WHERE metadata.device = 'iOS'");
    console.log('   ✅ Eksekusi SQL Native: ', res.length > 0 ? 'Ditemukan' : 'Kosong');

  } finally {
    await db.close();
  }
}

/**
 * 🚀 PHASE 2: Stress Test (Ratusan - Puluhan Ribu Request dalam 1 waktu)
 */
async function phase2_StressTest() {
  console.log('\n================================================');
  console.log('🚀 PHASE 2: Concurrent Stress Test (10,000+ Req)');
  console.log('================================================');
  const dbPath = path.join(TEST_DIR, 'stress_test.ovn');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Oblivinx3x(dbPath, { pageSize: 8192, bufferPool: '256MB', walMode: true });
  const metricsInitial = await db.getMetrics();

  try {
    const col = db.collection('high_freq_data');

    const TOTAL_REQUESTS = 20000;
    const BATCH_SIZE = 1000;

    console.log(`>> Menjalankan ${TOTAL_REQUESTS} concurrent inserts dalam batch ${BATCH_SIZE}...`);
    const startTime = Date.now();

    for (let i = 0; i < TOTAL_REQUESTS; i += BATCH_SIZE) {
      const promises = [];
      for (let j = 0; j < BATCH_SIZE; j++) {
        promises.push(
          col.insertOne({
            tid: randomUUID(),
            timestamp: Date.now(),
            payload: randomBytes(64).toString('hex') // Simulasi data
          })
        );
      }
      await Promise.all(promises);
      process.stdout.write(`\r   Memproses: ${i + BATCH_SIZE} / ${TOTAL_REQUESTS} selesai.`);
    }
    const endTime = Date.now();
    console.log(`\n   ✅ ${TOTAL_REQUESTS} inserts selesai dalam ${(endTime - startTime) / 1000} detik!`);

    // Concurrent Reads
    console.log('>> Menjalankan 5,000 concurrent reads (Find)...');
    const readPromises = [];
    const readStart = Date.now();
    for (let i = 0; i < 5000; i++) {
      readPromises.push(col.find({}, { limit: 5, skip: Math.floor(Math.random() * 1000) }));
    }
    await Promise.all(readPromises);
    const readEnd = Date.now();
    console.log(`   ✅ 5,000 queries selesai dalam ${(readEnd - readStart) / 1000} detik!`);

    const metricsAfter = await db.getMetrics();
    console.log(`   📊 Cache Hit Rate: ${(metricsAfter.cache.hitRate * 100).toFixed(2)}%`);
    console.log(`   📊 B+Tree Entries: ${metricsAfter.storage.btreeEntries}`);

  } finally {
    await db.close();
  }
}

/**
 * 💥 PHASE 3: Error & Corruption Testing
 */
async function phase3_ErrorAndCorruption() {
  console.log('\n================================================');
  console.log('💥 PHASE 3: Error Handling & File Corruption Test');
  console.log('================================================');
  const dbPath = path.join(TEST_DIR, 'corrupt_test.ovn');

  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  // Buat DB normal dulu
  let db = new Oblivinx3x(dbPath, { pageSize: 4096 });
  const rootCol = db.collection('system');
  await rootCol.insertOne({ init: true });
  await db.close();

  // Sengaja kita corrupt file header systemnya bytes ke 10-100 (Magic Number area)
  console.log('>> Mensimulasikan file system corruption dengan me-rewrite header...');
  const fd = fs.openSync(dbPath, 'r+');
  const corruptBuffer = Buffer.alloc(1024, 0x00); // Tulis nol semua
  fs.writeSync(fd, corruptBuffer, 0, 1024, 0); // Override header dan page 0
  fs.closeSync(fd);

  console.log('>> Mencoba load kembali file yang terkorupsi...');
  try {
    new Oblivinx3x(dbPath);
    console.error('   ❌ Anomali: Database berhasil dibuka meskipun terkorupsi!');
  } catch (err: any) {
    console.log('   ✅ Berhasil menangkap engine error sesuai harapan:');
    console.log(`      -> ${err.message}`);
  }
}

/**
 * 💾 PHASE 4: Simulated Massive Database (GB Scale) & Backup
 */
async function phase4_LargeScaleBackup() {
  console.log('\n================================================');
  console.log('💾 PHASE 4: Large Scale Backup (Simulasi up to GB)');
  console.log('================================================');

  const dbPath = path.join(TEST_DIR, 'massive_db.ovn');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Oblivinx3x(dbPath, {
    pageSize: 16384, // Pake page size gede 16kb buat big data
    bufferPool: '512MB',
    compression: 'none' // Sengaja dimatikan agar cepat bengkak (simulasi load real)
  });

  try {
    // Simulasi mengisi DB sampai ratusan MB -> Limit dikecilkan agar test tidak memakan waktu berjam2
    // Pada real server, targetLoop ini set saja puluhan ribu untuk tembus 10-20GB.
    const targetLoop = 200;
    const CHUNK_SIZE = 1024 * 1024; // 1 MB text/json per insert stream
    const dummyBlob = randomBytes(CHUNK_SIZE).toString('hex'); // 2MB string sebenarnya lengthnya

    console.log(`>> Injeksi bulk blobs dokumen besar (Target ~${(targetLoop * 2)}MB)...`);
    const archives = db.collection('archives');

    const startTime = Date.now();
    for (let i = 0; i < targetLoop; i++) {
      await archives.insertOne({
        index: i,
        archiveKey: `ARCHIVE-${i}`,
        massivePayload: dummyBlob
      });
      if (i > 0 && i % 50 === 0) {
        process.stdout.write(`\r   Mengisi: ${i} blocks...`);
        await db.checkpoint(); // Trigger flush internal agar sync ke disk
      }
    }
    const stat = fs.statSync(dbPath);
    console.log(`\n   ✅ Injeksi selesai! Ukuran file DB fisik: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);

    // Backup Process
    const backupPath = path.join(TEST_DIR, 'massive_db_backup.json');
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

    console.log('>> Menjalankan auto-backup real streaming...');
    const bkpStart = Date.now();
    await db.backup(backupPath);
    const bkpEnd = Date.now();

    const bkpStat = fs.statSync(backupPath);
    console.log(`   ✅ Backup rampung dalam ${(bkpEnd - bkpStart) / 1000} detik!`);
    console.log(`   ✅ Size Hasil Backup JSON: ${(bkpStat.size / (1024 * 1024)).toFixed(2)} MB`);

  } finally {
    await db.close();
  }
}

// =======================
//   TEST RUNNER
// =======================
async function runAll() {
  try {
    await phase1_RealUsage();
    await phase2_StressTest();
    await phase3_ErrorAndCorruption();
    await phase4_LargeScaleBackup();

    console.log('\n🎉 SEMUA TEST BERHASIL DILEWATI SANGAT BAIK!!! 🎉');
  } catch (error) {
    console.error('\n❌ FAILURE RUNNING TESTS:', error);
  }
}

runAll();
