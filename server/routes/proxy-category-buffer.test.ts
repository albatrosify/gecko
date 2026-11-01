import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectDb, getDb } from '../db.ts';
import { categoryMappings } from '../schema.ts';
import { replaceSourceStreams } from '../stream-store.ts';
import { resolveCategoryBufferSeconds } from './proxy.ts';

const PLAYLIST = 'pl-1';
const SOURCE = 'src-1';

function addCategoryMapping(id: string, originalId: string, bufferSeconds: number | null, type = 'live') {
  getDb().insert(categoryMappings).values({
    id,
    playlistId: PLAYLIST,
    type,
    originalId,
    extra: { bufferSeconds },
  }).run();
}

const base = {
  playlistId: PLAYLIST,
  type: 'live' as const,
  originalId: '100',
  sourceId: SOURCE,
  sourceIndex: 0,
  streamMapping: null,
};

describe('resolveCategoryBufferSeconds', () => {
  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    await connectDb();
    getDb().delete(categoryMappings).run();
    replaceSourceStreams(SOURCE, 'live', [
      { stream_id: '100', name: 'DEL 2 Event 3', category_id: '42' },
    ]);
  });

  afterEach(() => {
    delete process.env.SQLITE_PATH;
  });

  it('returns the override of the stream\'s own upstream category', async () => {
    addCategoryMapping('cm-1', '42', 0);
    expect(await resolveCategoryBufferSeconds(base)).toBe(0);
  });

  it('matches a source-prefixed category id', async () => {
    addCategoryMapping('cm-1', '0_42', 9);
    expect(await resolveCategoryBufferSeconds(base)).toBe(9);
  });

  it('prefers the category applied through the stream mapping', async () => {
    addCategoryMapping('cm-1', '42', 0);
    addCategoryMapping('cm-2', '99', 8);
    const value = await resolveCategoryBufferSeconds({
      ...base,
      streamMapping: { categoryId: '99' } as any,
    });
    expect(value).toBe(8);
  });

  it('treats a null override as "use the global default"', async () => {
    addCategoryMapping('cm-1', '42', null);
    expect(await resolveCategoryBufferSeconds(base)).toBeUndefined();
  });

  it('returns undefined when the category has no mapping', async () => {
    expect(await resolveCategoryBufferSeconds(base)).toBeUndefined();
  });

  it('ignores mappings of another playlist or another stream type', async () => {
    getDb().insert(categoryMappings).values({
      id: 'cm-other-playlist',
      playlistId: 'pl-2',
      type: 'live',
      originalId: '42',
      extra: { bufferSeconds: 3 },
    }).run();
    addCategoryMapping('cm-other-type', '42', 3, 'vod');
    expect(await resolveCategoryBufferSeconds(base)).toBeUndefined();
  });
});
