import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { connectDb, getDb } from '../server/db.ts';
import * as schema from '../server/schema.ts';
import fs from 'fs';
import path from 'path';

async function migrate() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB || 'open_iptv';

  console.log(`Connecting to MongoDB at ${uri} database: ${dbName}`);
  const client = new MongoClient(uri);
  await client.connect();
  const mongoDb = client.db(dbName);

  console.log(`Connecting to SQLite...`);
  await connectDb();
  const sqliteDb = getDb();

  const collections = [
    { name: 'users', table: schema.users },
    { name: 'sources', table: schema.sources },
    { name: 'epgs', table: schema.epgs },
    { name: 'playlists', table: schema.playlists },
    { name: 'mappings', table: schema.mappings },
    { name: 'categoryMappings', table: schema.categoryMappings },
    { name: 'source_sync_meta', table: schema.source_sync_meta },
    { name: 'settings', table: schema.settings },
    { name: 'source_changelogs', table: schema.source_changelogs },
  ];

  for (const { name, table } of collections) {
    console.log(`Migrating collection: ${name}`);
    const docs = await mongoDb.collection(name).find({}).toArray();
    let success = 0;
    let failed = 0;

    sqliteDb.transaction((tx) => {
      for (const doc of docs) {
        try {
          const { _id, ...rest } = doc;
          const id = name === 'source_sync_meta' ? doc.key : _id.toString();

          if (name === 'users') {
            tx.insert(table).values({
              id,
              email: rest.email,
              password: rest.password,
              role: rest.role,
              createdAt: rest.createdAt ? new Date(rest.createdAt) : new Date(),
            }).onConflictDoNothing().run();
          } else if (name === 'sources') {
            const { userId, name: sName, type, url, username, password, autoSyncEnabled, syncCron, ...extra } = rest;
            tx.insert(table).values({
              id, userId, name: sName, type, url, username, password, autoSyncEnabled, syncCron, extra
            }).onConflictDoNothing().run();
          } else if (name === 'epgs') {
            const { userId, name: eName, url, ...extra } = rest;
            tx.insert(table).values({
              id, userId, name: eName, url, extra
            }).onConflictDoNothing().run();
          } else if (name === 'playlists') {
            const { userId, name: pName, username, password, sourceIds, directStreams, ...extra } = rest;
            tx.insert(table).values({
              id, userId, name: pName, username, password, sourceIds, directStreams, extra
            }).onConflictDoNothing().run();
          } else if (name === 'mappings' || name === 'categoryMappings') {
            const { playlistId, type, originalId, ...extra } = rest;
            tx.insert(table).values({
              id, playlistId, type, originalId, extra
            }).onConflictDoNothing().run();
          } else if (name === 'source_sync_meta') {
            const { lastSync, ...extra } = rest;
            tx.insert(table).values({
              key: id, lastSync, extra
            }).onConflictDoNothing().run();
          } else if (name === 'settings') {
             tx.insert(table).values({
                id, extra: rest
             }).onConflictDoNothing().run();
          } else if (name === 'source_changelogs') {
             const { sourceId, ...extra } = rest;
             tx.insert(table).values({
                id, sourceId, extra
             }).onConflictDoNothing().run();
          }
          success++;
        } catch (e: any) {
          console.error(`Failed to insert doc from ${name}:`, e.message);
          failed++;
        }
      }
    });
    console.log(`Finished ${name}: ${success} inserted, ${failed} failed.`);
  }

  // Migrate cache files
  const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'data', 'cache');
  if (fs.existsSync(CACHE_DIR)) {
    console.log(`Migrating cache files from ${CACHE_DIR}...`);
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
    let cacheSuccess = 0;
    let cacheFailed = 0;

    sqliteDb.transaction((tx) => {
      for (const file of files) {
        try {
          const key = file.replace('.json', '');
          const filePath = path.join(CACHE_DIR, file);
          const stat = fs.statSync(filePath);
          const raw = fs.readFileSync(filePath, 'utf-8');
          const age = Date.now() - stat.mtimeMs;

          const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
          if (age > CACHE_TTL_MS) continue; // Skip expired

          tx.insert(schema.cache).values({
            key,
            data: raw, // Drizzle sqlite will parse json if needed, but since we use string input we might just parse it first. Wait, mode is json.
            updatedAt: stat.mtime.toISOString(),
            expiresAt: stat.mtimeMs + CACHE_TTL_MS
          }).onConflictDoNothing().run();

          cacheSuccess++;
        } catch (e: any) {
          cacheFailed++;
        }
      }
    });
    console.log(`Finished cache: ${cacheSuccess} inserted, ${cacheFailed} failed.`);
  }

  await client.close();
  console.log('Migration complete.');
  process.exit(0);
}

migrate().catch(console.error);
