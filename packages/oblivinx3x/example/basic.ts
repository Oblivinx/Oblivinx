import { Oblivinx3x, Document } from '../dist/index.js';

interface User extends Document {
  name: string;
  age: number;
  email: string;
  createdAt: Date;
}

async function main() {
  console.log('Opening database...');
  // Initialize the database, it will create a file named test_typed.ovn
  const db = new Oblivinx3x('test_typed.ovn');

  try {
    console.log('Database opened successfully!');
    
    // Get version info
    const version = await db.getVersion();
    console.log('Oblivinx3x Version:', version);

    // Get a typed collection
    const users = db.collection<User>('users');
    console.log('Obtained "users" typed collection.');

    // Insert a document
    console.log('\nInserting documents...');
    await users.insertOne({ 
      name: 'Alice', 
      age: 28, 
      email: 'alice@example.com',
      createdAt: new Date()
    });
    
    await users.insertOne({ 
      name: 'Bob', 
      age: 32, 
      email: 'bob@example.com',
      createdAt: new Date()
    });
    console.log('Inserted Alice and Bob.');

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

    console.log('\nSuccess! Oblivinx3x typed example is working correctly.');
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    console.log('Closing database...');
    await db.close();
  }
}

main().catch(console.error);
