import { Oblivinx3x } from '../dist/index.js';

async function main() {
  console.log('Opening database...');
  // Initialize the database, it will create a file named test.ovn
  const db = new Oblivinx3x('test.ovn');

  try {
    console.log('Database opened successfully!');

    // Get version info
    const version = await db.getVersion();
    console.log('Oblivinx3x Version:', version);

    // Get a collection
    const users = db.collection('users');
    console.log('Obtained "users" collection.');

    // Insert a document
    console.log('\nInserting a document...');
    const insertRes = await users.insertOne({
      name: 'Alice',
      age: 28,
      email: 'alice@example.com',
      createdAt: new Date()
    });
    console.log('Insert result:', insertRes);

    // Insert another document
    const insertRes2 = await users.insertOne({
      name: 'Bob',
      age: 32,
      email: 'bob@example.com',
      createdAt: new Date()
    });
    console.log('Insert result 2:', insertRes2);

    // Query for a document
    console.log('\nQuerying for a document (age > 25)...');
    const results = await users.find({ age: { $gt: 25 } });
    console.log('Query results:', results);

    // Update a document
    console.log('\nUpdating Alice\'s age...');
    const updateRes = await users.updateOne(
      { name: 'Alice' },
      { $set: { age: 29 } }
    );
    console.log('Update result:', updateRes);

    // Verify the update
    const updatedAlice = await users.findOne({ name: 'Alice' });
    console.log('Updated Alice:', updatedAlice);

    // Create an index
    console.log('\nCreating index on "email"...');
    await users.createIndex({ email: 1 }, { unique: true });

    // Test unique constraint (this should fail if we try to insert duplicate email)
    try {
      console.log('Testing unique index constraint...');
      await users.insertOne({ name: 'Charlie', email: 'alice@example.com' });
    } catch (err) {
      console.log('Expected error on duplicate insert:', err.message);
    }

    console.log('\nSuccess! Oblivinx3x is working correctly.');
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    console.log('Closing database...');
    await db.close();
  }
}

main().catch(console.error);
