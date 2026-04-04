import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

async function run() {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('test_db');

  // Create some dummy sources
  const ids = [];
  for (let i = 0; i < 500; i++) {
    const res = await db.collection('sources').insertOne({ name: `Source ${i}` });
    ids.push(res.insertedId.toString());
  }

  const toId = (id: string) => new ObjectId(id);

  // N+1 Query Benchmark
  const startNPlus1 = Date.now();
  for (let iter = 0; iter < 50; iter++) {
    await Promise.all(
      ids.map((sid) => db.collection('sources').findOne({ _id: toId(sid) }))
    );
  }
  const timeNPlus1 = Date.now() - startNPlus1;

  // Bulk Query Benchmark
  const startBulk = Date.now();
  for (let iter = 0; iter < 50; iter++) {
    const docs = await db.collection('sources').find({ _id: { $in: ids.map(toId) } }).toArray();
    // keep order
    const docsMap = new Map(docs.map(d => [d._id.toString(), d]));
    ids.map(id => docsMap.get(id));
  }
  const timeBulk = Date.now() - startBulk;

  console.log(`N+1 Query Time: ${timeNPlus1}ms`);
  console.log(`Bulk Query Time: ${timeBulk}ms`);

  await client.close();
  await mongod.stop();
  process.exit(0);
}

run().catch(console.error);
