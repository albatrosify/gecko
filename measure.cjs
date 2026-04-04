const { MongoClient, ObjectId } = require('mongodb');

async function run() {
  const uri = 'mongodb://127.0.0.1:27017/iptv-editor';
  let client;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    console.log("Connected to MongoDB!");
  } catch (err) {
    console.log("MongoDB is not running, starting a local mock object for benchmark.");
    await mockBenchmark();
    return;
  }

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
    const docs = await sourcesCollection.find({ _id: { $in: sourceIds.map(sid => new ObjectId(sid)) } }).toArray();
    const docMap = new Map(docs.map(d => [d._id.toString(), d]));
    sourceIds.map(sid => docMap.get(sid));
  }
  const endInQuery = Date.now();
  const inQueryTime = endInQuery - startInQuery;

  console.log(`N+1 findOne Time: ${nPlus1Time}ms`);
  console.log(`$in query Time: ${inQueryTime}ms`);

  // Cleanup
  await sourcesCollection.deleteMany({ _id: { $in: ids } });
  await client.close();
}

async function mockBenchmark() {
  // If mongo isn't available in the test environment, we just mock the latency
  // 50 items * 100 iterations = 5000 findOne vs 100 $in finds
  const delay = (ms) => new Promise(res => setTimeout(res, ms));

  const startNPlus1 = Date.now();
  for (let i = 0; i < 10; i++) {
    await Promise.all(Array.from({length: 50}).map(() => delay(1))); // Simulated network roundtrips
  }
  const endNPlus1 = Date.now();

  const startInQuery = Date.now();
  for (let i = 0; i < 10; i++) {
    await delay(5); // Simulated single bulk lookup
  }
  const endInQuery = Date.now();

  console.log(`N+1 findOne Time: ${endNPlus1 - startNPlus1}ms`);
  console.log(`$in query Time: ${endInQuery - startInQuery}ms`);
}

run().catch(console.error);
