import { MongoClient, Db, Collection, ObjectId } from 'mongodb';

let client: MongoClient;
let db: Db;

export async function connectDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB || 'open_iptv';
  
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  
  // Create indexes for common queries
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('sources').createIndex({ userId: 1 });
  await db.collection('epgs').createIndex({ userId: 1 });
  await db.collection('playlists').createIndex({ userId: 1 });
  await db.collection('playlists').createIndex({ username: 1 }, { unique: true });
  await db.collection('playlists').createIndex({ username: 1, password: 1 });
  await db.collection('mappings').createIndex({ playlistId: 1 });
  await db.collection('mappings').createIndex({ playlistId: 1, type: 1, originalId: 1 });
  await db.collection('categoryMappings').createIndex({ playlistId: 1 });
  await db.collection('categoryMappings').createIndex({ playlistId: 1, type: 1, originalId: 1 });
  
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db;
}

export function toId(id: string): ObjectId {
  return new ObjectId(id);
}

export function docWithId(doc: any): any {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

export function docsWithId(docs: any[]): any[] {
  return docs.map(docWithId);
}
