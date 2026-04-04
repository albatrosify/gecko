import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';

async function run() {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('test');
  const collection = db.collection('sources');

  function toId(id: string): ObjectId {
    return new ObjectId(id);
  }

  // Create mock sources
  const ids = [];
  for (let i = 0; i < 50; i++) {
    const res = await collection.insertOne({ name: `Source ${i}` });
    ids.push(res.insertedId.toString());
  }

  console.log('Running Promise.all(findOne) benchmark...');
  const start1 = Date.now();
  for (let i = 0; i < 500; i++) {
    await Promise.all(ids.map(id => collection.findOne({ _id: toId(id) })));
  }
  const end1 = Date.now();

  console.log('Running $in benchmark...');
  const start2 = Date.now();
  for (let i = 0; i < 500; i++) {
    const docs = await collection.find({ _id: { $in: ids.map(toId) } }).toArray();
    const map = new Map(docs.map(doc => [doc._id.toString(), doc]));
    const result = ids.map(id => map.get(id) || null);
  }
  const end2 = Date.now();

  console.log(`\nResults (50 documents, 500 iterations):`);
  console.log(`Promise.all(findOne): ${end1 - start1} ms`);
  console.log(`find({ $in }): ${end2 - start2} ms`);

  if (end1 - start1 > 0) {
    const improvement = ((end1 - start1) - (end2 - start2)) / (end1 - start1) * 100;
    console.log(`Improvement: ${improvement.toFixed(2)}%`);
  }

  await client.close();
  await mongod.stop();
  process.exit(0);
}

run().catch(console.error);