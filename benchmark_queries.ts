import { MongoClient, ObjectId } from 'mongodb';

async function runBenchmark() {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/antigravity";
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const sources = db.collection('sources');

  // Insert some dummy data
  const numDocs = 50;
  const docs = Array.from({ length: numDocs }).map((_, i) => ({ name: `Source ${i}` }));
  const result = await sources.insertMany(docs);
  const ids = Object.values(result.insertedIds);

  console.log(`Inserted ${numDocs} documents.`);

  // Test 1: N+1 queries using Promise.all + findOne
  const start1 = performance.now();
  await Promise.all(ids.map(id => sources.findOne({ _id: id })));
  const time1 = performance.now() - start1;

  // Test 2: N+1 queries using for loop + await findOne
  const start2 = performance.now();
  for (const id of ids) {
    await sources.findOne({ _id: id });
  }
  const time2 = performance.now() - start2;

  // Test 3: Bulk query using $in
  const start3 = performance.now();
  await sources.find({ _id: { $in: ids } }).toArray();
  const time3 = performance.now() - start3;

  console.log(`Promise.all + findOne: ${time1.toFixed(2)}ms`);
  console.log(`for loop + await findOne: ${time2.toFixed(2)}ms`);
  console.log(`$in query: ${time3.toFixed(2)}ms`);

  // Cleanup
  await sources.deleteMany({ _id: { $in: ids } });
  await client.close();
}

runBenchmark().catch(console.error);
