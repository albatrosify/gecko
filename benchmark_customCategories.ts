import { getDb, connectDb } from './server/db.ts';
import { customCategories, playlists } from './server/schema.ts';
import { eq } from 'drizzle-orm';
import { performance } from 'perf_hooks';

async function run() {
  await connectDb();
  const db = getDb();

  const playlistId = 'test-playlist-id';
  const categoryId = 'test-category-id';

  try {
    // Clean up existing
    db.delete(customCategories).where(eq(customCategories.id, categoryId)).run();
    db.delete(playlists).where(eq(playlists.id, playlistId)).run();

    db.insert(playlists).values({
      id: playlistId,
      userId: 'test-user-id',
      name: 'test',
      username: 'test-bench-user',
      password: 'test-password',
      sourceIds: [],
      directStreams: false,
      extra: {}
    }).run();

    db.insert(customCategories).values({
      id: categoryId,
      playlistId: playlistId,
      type: 'live',
      name: 'test-category',
      order: 0,
      hidden: false
    }).run();

    // Create prepared statements
    const seqGetCat = db.select().from(customCategories).where(eq(customCategories.id, categoryId)).prepare();
    const seqGetPlaylist = db.select().from(playlists).where(eq(playlists.id, playlistId)).prepare();

    const joinGet = db.select({
        customCategories,
        playlists
      })
      .from(customCategories)
      .leftJoin(playlists, eq(playlists.id, customCategories.playlistId))
      .where(eq(customCategories.id, categoryId))
      .prepare();

    // Warmup
    for (let i = 0; i < 100; i++) {
      seqGetCat.get();
      seqGetPlaylist.get();
      joinGet.get();
    }

    const ITERATIONS = 10000;

    // Baseline (sequential)
    const startSeq = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const doc = seqGetCat.get();
      const playlist = seqGetPlaylist.get();
      if (!doc || !playlist) throw new Error('Sequential query returned null');
    }
    const endSeq = performance.now();

    // Optimized (join)
    const startJoin = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const result = joinGet.get();
      if (!result?.customCategories || !result?.playlists) throw new Error('Join query returned null');
    }
    const endJoin = performance.now();

    console.log(`Sequential: ${(endSeq - startSeq).toFixed(2)}ms`);
    console.log(`Join: ${(endJoin - startJoin).toFixed(2)}ms`);
  } finally {
    db.delete(customCategories).where(eq(customCategories.id, categoryId)).run();
    db.delete(playlists).where(eq(playlists.id, playlistId)).run();
  }
}

run().catch(console.error);
