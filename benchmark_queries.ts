import { MongoClient, ObjectId } from 'mongodb';

async function benchmark() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB || 'open_iptv_benchmark';
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection('sources');

    // Setup: Create 100 dummy sources
    await collection.deleteMany({});
    const sourceIds: ObjectId[] = [];
    const sources = [];
    for (let i = 0; i < 100; i++) {
      const id = new ObjectId();
      sourceIds.push(id);
      sources.push({ _id: id, name: `Source ${i}` });
    }
    await collection.insertMany(sources);

    const N = 50; // Number of sources to fetch in a single request
    const subsetIds = sourceIds.slice(0, N);
    const subsetIdStrings = subsetIds.map(id => id.toString());

    console.log(`Benchmarking with ${N} sources...`);

    // 1. N+1 Query Baseline
    const startN1 = performance.now();
    const resultsN1 = [];
    for (const sid of subsetIdStrings) {
      const doc = await collection.findOne({ _id: new ObjectId(sid) });
      resultsN1.push(doc);
    }
    const endN1 = performance.now();
    console.log(`N+1 Strategy: ${(endN1 - startN1).toFixed(2)}ms`);

    // 2. Bulk Fetch Strategy
    const startBulk = performance.now();
    const cursor = collection.find({ _id: { $in: subsetIdStrings.map(id => new ObjectId(id)) } });
    const docs = await cursor.toArray();
    const sourcesMap = new Map(docs.map(doc => [doc._id.toString(), doc]));
    const resultsBulk = subsetIdStrings.map(sid => sourcesMap.get(sid));
    const endBulk = performance.now();
    console.log(`Bulk Strategy: ${(endBulk - startBulk).toFixed(2)}ms`);

    // Verification
    if (resultsN1.length !== resultsBulk.length) {
        console.error("Mismatch in result length!");
    }

    const improvement = ((endN1 - startN1) - (endBulk - startBulk)) / (endN1 - startN1) * 100;
    console.log(`Improvement: ${improvement.toFixed(2)}%`);

  } catch (error) {
    console.error('Benchmark failed:', error);
  } finally {
    await client.close();
  }
}

benchmark();
