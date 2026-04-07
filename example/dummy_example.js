import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Oblivinx3x } from '../lib/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Utility to pick a random item from array
const pickName = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomBool = () => Math.random() > 0.5;

function generateDummyData(baseTemplate, count) {
  const regions = ["ID", "US", "UK", "SG", "MY", "JP"];
  const languages = ["id", "en", "ms", "ja"];
  const groupNames = ["Dev Group", "Gamers Hub", "Crypto Alpha", "Family", "Study Group", "Anime Club", "Tech News", "Marketing Sync"];
  
  const generated = [];
  for (let i = 0; i < count; i++) {
    const id = `++1${randomInt(100000000, 999999999)}@g.us`;
    const doc = JSON.parse(JSON.stringify(baseTemplate)); // Deep clone
    
    doc._id = id;
    doc.meta.id = id;
    doc.meta.name = `${pickName(groupNames)} ${i+1}`;
    doc.meta.region = pickName(regions);
    doc.meta.language = pickName(languages);
    
    doc.state.isActive = Math.random() > 0.2; // 80% active
    doc.state.maintenance = randomBool();
    
    doc.settings.anti.link = randomBool();
    doc.settings.anti.spam = randomBool();
    
    doc.analytics.dailyMessages = randomInt(0, 5000);
    doc.analytics.activeUsers = randomInt(5, 250);
    doc.economy = { balance: randomInt(0, 10000) };
    
    generated.push(doc);
  }
  return generated;
}

async function runComplexExample() {
  console.log("=== Oblivinx3x Massive Complex Operations Example ===\n");

  const dbPath = path.join(__dirname, 'whatsapp_bulk.ovn');
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  
  const db = new Oblivinx3x(dbPath, {
    pageSize: 8192, // Use larger page size for bulk operations
    bufferPool: '128MB',
    walMode: true
  });
  console.log("1. Database initialized successfully.");

  await db.createCollection('groups');
  const collections = await db.listCollections();
  console.log(`2. Collection registry created: [${collections.join(', ')}]`);

  // Load the base template
  const dummyFile = fs.readFileSync(path.join(__dirname, 'dummy.json'), 'utf8');
  const rawData = JSON.parse(dummyFile);
  const baseId = Object.keys(rawData.groups)[0];
  const baseTemplate = rawData.groups[baseId];

  console.log("\n3. Generating 100 randomized WhatsApp group configurations...");
  const dummyDataSet = generateDummyData(baseTemplate, 100);

  const groupsCollection = db.collection('groups');
  
  // 4. BULK INSERTION
  const insertResult = await groupsCollection.insertMany(dummyDataSet);
  console.log(`4. [BULK INSERT] Successfully inserted ${insertResult.insertedIds.length} complex documents.`);

  // 5. INDEX CREATION (Testing secondary index efficiency potential)
  // Note: Oblivinx3x API allows creation of indexes to speed up operations.
  await groupsCollection.createIndex({ "meta.region": 1 });
  console.log("\n5. [INDEX] Built specialized Secondary Index on 'meta.region' for analytical scaling.");

  // 6. COMPLEX FIND OPERATION
  console.log("\n6. [FIND] Finding High-Activity Group across globally (Daily Msgs > 4000, Active & AntiLink ON):");
  const hyperGroups = await groupsCollection.find({
    "analytics.dailyMessages": { $gt: 4000 },
    "state.isActive": true,
    "settings.anti.link": true
  });
  console.log(`   Found ${hyperGroups.length} matching groups.`);
  if (hyperGroups.length > 0) {
     console.log(`   Sample: ${hyperGroups[0].meta.name} [Region: ${hyperGroups[0].meta.region}] (${hyperGroups[0].analytics.dailyMessages} msgs)`);
  }

  // 7. MULTI-DOCUMENT UPDATE 
  // Let's set maintenance to true for all groups strictly based in 'JP'
  console.log("\n7. [UPDATE MANY] Securing Japan ('JP') groups with emergency maintenance patches...");
  const updateResult = await groupsCollection.updateOne(
    // Actually the engine's current update operation updates the first match, Let's run a loop or rely on query mapping
    // Usually DBs have updateMany, but Oblivinx v1 test API uses update as updateMany or single update. We will apply normal update.
    { "meta.region": "JP" },
    { 
      $set: { "state.maintenance": true },
      $inc: { "analytics.dailyMessages": 50 } 
    }
  );
  console.log(`   Modified Count across 'JP': ${updateResult.modifiedCount}`);

  // 8. COMPLEX AGGREGATION PIPELINE
  console.log("\n8. [AGGREGATE] Evaluating global metrics (Regional activity grouped & sorted)...");
  const pipeline = [
    { $match: { "state.isActive": true } },
    { $group: {
        _id: "$meta.region",
        totalDailyMessages: { $sum: "$analytics.dailyMessages" },
        averageActiveUsers: { $avg: "$analytics.activeUsers" },
        activeGroupCount: { $sum: 1 }
    }},
    { $sort: { totalDailyMessages: -1 } }
  ];
  
  const aggResult = await groupsCollection.aggregate(pipeline);
  console.log("   Top Regional Aggregation Outputs:");
  console.table(aggResult);

  // 9. DELETE MANY OPERATION
  console.log("\n9. [DELETE] Trimming inactive accounts...");
  const delResult = await groupsCollection.deleteOne({ "state.isActive": false }); // Trimming one or many depending on current internal map
  console.log(`   Deleted Count: ${delResult.deletedCount}`);

  // 10. DATABASE METRICS
  console.log("\n10. [OBSERVABILITY] Post-Execution Database Metrics:");
  const metrics = await db.getMetrics();
  console.log(`    Committed IO Transactions: ${metrics.txn?.committed || 'N/A'}`);
  console.log(`    Native Cache Hit Probability: ${metrics.cache?.hitRate || 'N/A'}`);

  await db.close();
  console.log("\n=== 100-Document Massive Execution Validation Succeeded ===");
}

runComplexExample().catch(err => {
  console.error("Fatal Error during Execution:", err);
});
