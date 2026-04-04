import { MongoClient, ObjectId } from 'mongodb';

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/iptv-editor';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const sourcesCollection = db.collection('sources');

  // Insert test data
  const ids = Array.from({ length: 50 }).map(() => new ObjectId());
  await sourcesCollection.insertMany(ids.map((id, i) => ({ _id: id, name: `Source ${i}` })));

  const sourceIds = ids.map(id => id.toString());

  // Test N+1 findOne
  const startNPlus1 = Date.now();
  for (let i = 0; i < 100; i++) {
    await Promise.all(sourceIds.map(sid => sourcesCollection.findOne({ _id: new ObjectId(sid) })));
  }
  const endNPlus1 = Date.now();
  const nPlus1Time = endNPlus1 - startNPlus1;

  // Test $in query
  const startInQuery = Date.now();
  for (let i = 0; i < 100; i++) {
    await sourcesCollection.find({ _id: { $in: sourceIds.map(sid => new ObjectId(sid)) } }).toArray();
  }
  const endInQuery = Date.now();
  const inQueryTime = endInQuery - startInQuery;

  console.log(`N+1 findOne Time: ${nPlus1Time}ms`);
  console.log(`$in query Time: ${inQueryTime}ms`);

  // Cleanup
  await sourcesCollection.deleteMany({ _id: { $in: ids } });
  await client.close();
}

run().catch(console.error);
