import { Database } from '../src/index.js';
import { rmSync } from 'node:fs';

async function main() {
  const dbPath = 'blob-test.ovn';
  
  // Clean up previous runs
  try { rmSync(dbPath); } catch {}

  const db = new Database(dbPath, {
    bufferPool: '64MB',
  });

  console.log('✅ Database opened');

  try {
    // Generate a 1MB dummy file
    const size = 1024 * 1024; // 1 MB
    const dummyData = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        dummyData[i] = i % 256;
    }
    
    console.log(`⏳ Storing Blob of size: ${size} bytes...`);
    
    // Save to Database natively
    const startWrite = Date.now();
    const blobId = await db.putBlob(dummyData);
    const writeTime = Date.now() - startWrite;
    console.log(`✅ Saved Blob! UUID: ${blobId} (took ${writeTime}ms)`);

    console.log(`⏳ Retrieving Blob...`);
    const startRead = Date.now();
    const retrievedData = await db.getBlob(blobId);
    const readTime = Date.now() - startRead;
    
    if (!retrievedData) {
      throw new Error("❌ Retrieved data is null!");
    }

    console.log(`✅ Retrieved Blob! Size: ${retrievedData.length} bytes (took ${readTime}ms)`);

    // Verify Integrity
    let isMatch = retrievedData.length === size;
    if (isMatch) {
      for (let i = 0; i < size; i++) {
        if (dummyData[i] !== retrievedData[i]) {
          isMatch = false;
          break;
        }
      }
    }

    if (isMatch) {
      console.log('✅ DATA INTEGRITY VERIFIED - Match successful!');
    } else {
      console.error('❌ ERROR: Data mismatch!');
    }

  } catch (error) {
    console.error('❌ Error during Blob operations:', error);
  } finally {
    await db.close();
    console.log('✅ Database closed');
    try { rmSync(dbPath); } catch {}
  }
}

main().catch(console.error);
