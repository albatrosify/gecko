import { describe, it, expect, beforeEach } from 'vitest';
import { connectDb, getSqlite } from './db.ts';
import {
  normalizeStream,
  toUpstreamStream,
  replaceSourceStreams,
  replaceSourceStreamsWithDiff,
  searchStreams,
  countSourceStreams,
  deleteSourceStreams,
  getStreamRow,
  escapeLike,
  toMatchQuery,
} from './stream-store.ts';

const SOURCE = 'src-1';

describe('stream-store — normalization', () => {
  it('promotes known fields and keeps provider-specific ones in extra', () => {
    const row = normalizeStream(SOURCE, 'vod', {
      stream_id: 1234,
      name: 'Movie Night',
      category_id: 7,
      stream_icon: 'http://img/logo.png',
      container_extension: 'mkv',
      rating: '7.5',
      added: '1700000000',
    });

    expect(row).not.toBeNull();
    expect(row!.streamId).toBe('1234');
    expect(row!.name).toBe('Movie Night');
    expect(row!.categoryId).toBe('7');
    expect(row!.icon).toBe('http://img/logo.png');
    expect(row!.containerExtension).toBe('mkv');
    expect(row!.extra).toEqual({ rating: '7.5', added: '1700000000' });
  });

  it('falls back from name to title and from stream_icon to cover', () => {
    const row = normalizeStream(SOURCE, 'series', {
      series_id: 'abc',
      title: 'Series Title',
      cover: 'http://img/cover.jpg',
    });

    expect(row!.streamId).toBe('abc');
    expect(row!.name).toBe('Series Title');
    expect(row!.icon).toBe('http://img/cover.jpg');
  });

  it('returns null when the item has no usable id', () => {
    expect(normalizeStream(SOURCE, 'live', { name: 'No id here' })).toBeNull();
    expect(normalizeStream(SOURCE, 'live', { stream_id: '' })).toBeNull();
    expect(normalizeStream(SOURCE, 'live', null)).toBeNull();
  });

  it('keeps a numeric category id of 0', () => {
    const row = normalizeStream(SOURCE, 'live', { stream_id: '1', category_id: 0 });
    expect(row!.categoryId).toBe('0');
  });

  it('round-trips back into an upstream-shaped object', () => {
    const original = {
      stream_id: 99,
      name: 'Channel One',
      category_id: 3,
      stream_icon: 'http://img/one.png',
      epg_channel_id: 'one.tv',
      num: 5,
    };
    const row = normalizeStream(SOURCE, 'live', original)!;
    const back = toUpstreamStream(row);

    expect(back.stream_id).toBe('99');
    expect(back.name).toBe('Channel One');
    expect(back.category_id).toBe('3');
    expect(back.stream_icon).toBe('http://img/one.png');
    expect(back.epg_channel_id).toBe('one.tv');
    expect(back.num).toBe(5);
  });

  it('emits series_id for series rows', () => {
    const row = normalizeStream(SOURCE, 'series', { series_id: '77', name: 'Show' })!;
    expect(toUpstreamStream(row).series_id).toBe('77');
  });
});

describe('stream-store — replace and count', () => {
  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    await connectDb();
  });

  it('stores a partition and reports the row count', () => {
    const stored = replaceSourceStreams(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha' },
      { stream_id: '2', name: 'Beta' },
    ]);

    expect(stored).toBe(2);
    expect(countSourceStreams(SOURCE, 'live')).toBe(2);
  });

  it('replaces a partition instead of appending', () => {
    replaceSourceStreams(SOURCE, 'live', [{ stream_id: '1', name: 'Alpha' }]);
    replaceSourceStreams(SOURCE, 'live', [{ stream_id: '2', name: 'Beta' }]);

    expect(countSourceStreams(SOURCE, 'live')).toBe(1);
    expect(searchStreams('Alpha', { type: 'live' })).toHaveLength(0);
    expect(searchStreams('Beta', { type: 'live' })).toHaveLength(1);
  });

  it('scopes partitions by source and type', () => {
    replaceSourceStreams(SOURCE, 'live', [{ stream_id: '1', name: 'Live One' }]);
    replaceSourceStreams(SOURCE, 'vod', [{ stream_id: '2', name: 'Vod Two' }]);
    replaceSourceStreams('src-2', 'live', [{ stream_id: '3', name: 'Other Live' }]);

    expect(countSourceStreams(SOURCE)).toBe(2);
    expect(countSourceStreams(SOURCE, 'vod')).toBe(1);
    expect(countSourceStreams('src-2', 'live')).toBe(1);
  });

  it('skips items without an id and tolerates upstream duplicates', () => {
    const stored = replaceSourceStreams(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha' },
      { name: 'No id' },
      { stream_id: '1', name: 'Alpha Duplicate' },
    ]);

    // `stored` counts distinct rows actually staged, not the raw input length.
    expect(stored).toBe(1);
    expect(countSourceStreams(SOURCE, 'live')).toBe(1);
  });

  it('deletes a whole source or a single type', () => {
    replaceSourceStreams(SOURCE, 'live', [{ stream_id: '1', name: 'A' }]);
    replaceSourceStreams(SOURCE, 'vod', [{ stream_id: '2', name: 'B' }]);

    expect(deleteSourceStreams(SOURCE, 'live')).toBe(1);
    expect(countSourceStreams(SOURCE)).toBe(1);
    expect(deleteSourceStreams(SOURCE)).toBe(1);
    expect(countSourceStreams(SOURCE)).toBe(0);
  });

  it('round-trips a stored row through getStreamRow', () => {
    replaceSourceStreams(SOURCE, 'vod', [
      { stream_id: '5', name: 'Film', container_extension: 'mp4', rating: '8.1' },
    ]);

    const row = getStreamRow(SOURCE, 'vod', '5');
    expect(row).not.toBeNull();
    expect(row!.name).toBe('Film');
    expect(row!.containerExtension).toBe('mp4');
    expect(row!.extra).toEqual({ rating: '8.1' });
    expect(getStreamRow(SOURCE, 'vod', 'nope')).toBeNull();
  });
});

describe('stream-store — search', () => {
  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    await connectDb();
  });

  function seed() {
    replaceSourceStreams(SOURCE, 'live', [
      { stream_id: '1', name: 'TiviMate Sports HD' },
      { stream_id: '2', name: 'Documentary Channel' },
      { stream_id: '3', name: 'Sports Extra' },
    ]);
    replaceSourceStreams(SOURCE, 'vod', [
      { stream_id: '4', name: 'A Sports Movie' },
    ]);
  }

  it('finds substrings from the middle of a name', () => {
    seed();
    const hits = searchStreams('Sports');
    expect(hits).toHaveLength(3);
    expect(hits.map(h => h.streamId).sort()).toEqual(['1', '3', '4']);
  });

  it('filters by type', () => {
    seed();
    const hits = searchStreams('Sports', { type: 'live' });
    expect(hits.map(h => h.streamId).sort()).toEqual(['1', '3']);
  });

  it('filters by sourceIds', () => {
    seed();
    replaceSourceStreams('src-2', 'live', [{ stream_id: '9', name: 'Sports Other Source' }]);

    expect(searchStreams('Sports', { sourceIds: [SOURCE] })).toHaveLength(3);
    expect(searchStreams('Sports', { sourceIds: ['src-2'] })).toHaveLength(1);
    expect(searchStreams('Sports', { sourceIds: ['src-2', SOURCE] })).toHaveLength(4);
  });

  it('honours the limit', () => {
    seed();
    expect(searchStreams('Sports', { limit: 2 })).toHaveLength(2);
  });

  it('still finds two-character queries via the scan fallback', () => {
    seed();
    const hits = searchStreams('HD');
    expect(hits.map(h => h.name)).toContain('TiviMate Sports HD');
  });

  it('returns nothing for an empty query', () => {
    seed();
    expect(searchStreams('   ')).toHaveLength(0);
  });

  it('treats LIKE wildcards literally', () => {
    seed();
    // Un-escaped, '%' would match every row.
    expect(searchStreams('%')).toHaveLength(0);
    expect(searchStreams('_')).toHaveLength(0);
  });

  it('does not return stale entries after a re-sync', () => {
    seed();
    replaceSourceStreams(SOURCE, 'live', [{ stream_id: '10', name: 'Brand New Channel' }]);

    expect(searchStreams('Sports', { type: 'live' })).toHaveLength(0);
    expect(searchStreams('Brand New')).toHaveLength(1);
  });

  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
  });

  it('builds a quoted FTS5 phrase query', () => {
    expect(toMatchQuery('Sports HD')).toBe('"Sports HD"');
    expect(toMatchQuery('say "hi"')).toBe('"say ""hi"""');
  });

  it('matches names containing quotes', () => {
    replaceSourceStreams(SOURCE, 'vod', [
      { stream_id: '1', name: 'The "Best" Movie' },
      { stream_id: '2', name: 'Something Else' },
    ]);

    expect(searchStreams('"Best"').map(h => h.streamId)).toEqual(['1']);
  });

  it('stays correct after a partial delete', () => {
    seed();
    deleteSourceStreams('src-2', 'live');
    expect(searchStreams('Sports', { type: 'live' }).length).toBeGreaterThan(0);
  });
});

describe('stream-store — sync diff', () => {
  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    await connectDb();
  });

  it('reports no changes on a first sync', () => {
    const { stored, changes } = replaceSourceStreamsWithDiff(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha' },
      { stream_id: '2', name: 'Beta' },
    ]);

    expect(stored).toBe(2);
    expect(changes).toEqual({ added: [], removed: [], renamed: [] });
  });

  it('reports added, removed and renamed entries', () => {
    replaceSourceStreams(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha' },
      { stream_id: '2', name: 'Beta' },
      { stream_id: '3', name: 'Gamma' },
    ]);

    const { changes } = replaceSourceStreamsWithDiff(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha' },
      { stream_id: '2', name: 'Beta Renamed' },
      { stream_id: '4', name: 'Delta' },
    ]);

    expect(changes.added).toEqual([{ id: '4', name: 'Delta' }]);
    expect(changes.removed).toEqual([{ id: '3', name: 'Gamma' }]);
    expect(changes.renamed).toEqual([{ id: '2', oldName: 'Beta', newName: 'Beta Renamed' }]);
  });

  it('reports nothing when the catalog is unchanged', () => {
    const items = [
      { stream_id: '1', name: 'Alpha' },
      { stream_id: '2', name: 'Beta' },
    ];
    replaceSourceStreams(SOURCE, 'live', items);

    const { changes } = replaceSourceStreamsWithDiff(SOURCE, 'live', items);
    expect(changes).toEqual({ added: [], removed: [], renamed: [] });
  });

  it('treats a name becoming null as a rename, not a removal', () => {
    replaceSourceStreams(SOURCE, 'live', [{ stream_id: '1', name: 'Alpha' }]);
    const { changes } = replaceSourceStreamsWithDiff(SOURCE, 'live', [{ stream_id: '1' }]);

    expect(changes.renamed).toEqual([{ id: '1', oldName: 'Alpha', newName: null }]);
    expect(changes.removed).toHaveLength(0);
  });

  it('diffs partitions independently', () => {
    replaceSourceStreams(SOURCE, 'live', [{ stream_id: '1', name: 'Live One' }]);
    replaceSourceStreams(SOURCE, 'vod', [{ stream_id: '1', name: 'Vod One' }]);

    const live = replaceSourceStreamsWithDiff(SOURCE, 'live', [{ stream_id: '1', name: 'Live Renamed' }]);
    expect(live.changes.renamed).toHaveLength(1);

    const vod = replaceSourceStreamsWithDiff(SOURCE, 'vod', [{ stream_id: '1', name: 'Vod One' }]);
    expect(vod.changes).toEqual({ added: [], removed: [], renamed: [] });
  });

  it('keeps the search index consistent with the diff result', () => {
    replaceSourceStreams(SOURCE, 'live', [{ stream_id: '1', name: 'Old Channel Name' }]);
    replaceSourceStreamsWithDiff(SOURCE, 'live', [{ stream_id: '1', name: 'New Channel Name' }]);

    expect(searchStreams('Old Channel')).toHaveLength(0);
    expect(searchStreams('New Channel')).toHaveLength(1);
  });
});

describe('stream-store — incremental writes', () => {
  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    await connectDb();
  });

  const updatedAtOf = (streamId: string): number =>
    (getSqlite()
      .prepare('SELECT updatedAt FROM streams WHERE sourceId = ? AND type = ? AND streamId = ?')
      .get(SOURCE, 'live', streamId) as { updatedAt: number }).updatedAt;

  it('rewrites nothing when the catalog is unchanged', async () => {
    const items = [
      { stream_id: '1', name: 'Alpha', rating: '7', added: '123' },
      { stream_id: '2', name: 'Beta' },
    ];
    replaceSourceStreamsWithDiff(SOURCE, 'live', items);
    const firstRun = updatedAtOf('1');

    // Ensure a rewrite would be visible: Date.now() must have advanced.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { changes } = replaceSourceStreamsWithDiff(SOURCE, 'live', items);

    expect(updatedAtOf('1')).toBe(firstRun);
    expect(updatedAtOf('2')).toBe(firstRun);
    expect(changes).toEqual({ added: [], removed: [], renamed: [] });
  });

  it('updates only the rows whose values differ', async () => {
    replaceSourceStreamsWithDiff(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha' },
      { stream_id: '2', name: 'Beta' },
    ]);
    const firstRun = updatedAtOf('1');

    await new Promise((resolve) => setTimeout(resolve, 5));
    replaceSourceStreamsWithDiff(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha' },
      { stream_id: '2', name: 'Beta Renamed' },
    ]);

    expect(updatedAtOf('1')).toBe(firstRun);
    expect(updatedAtOf('2')).toBeGreaterThan(firstRun);
  });

  it('updates a row when a non-name field changes', async () => {
    replaceSourceStreamsWithDiff(SOURCE, 'live', [{ stream_id: '1', name: 'Alpha', rating: '7' }]);
    const firstRun = updatedAtOf('1');

    await new Promise((resolve) => setTimeout(resolve, 5));
    replaceSourceStreamsWithDiff(SOURCE, 'live', [{ stream_id: '1', name: 'Alpha', rating: '9' }]);

    expect(updatedAtOf('1')).toBeGreaterThan(firstRun);
    expect(getStreamRow(SOURCE, 'live', '1')!.extra).toEqual({ rating: '9' });
  });

  it('does not treat a reordered payload as a change', async () => {
    replaceSourceStreamsWithDiff(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha', rating: '7', added: '123' },
    ]);
    const firstRun = updatedAtOf('1');

    await new Promise((resolve) => setTimeout(resolve, 5));
    replaceSourceStreamsWithDiff(SOURCE, 'live', [
      { stream_id: '1', name: 'Alpha', added: '123', rating: '7' },
    ]);

    expect(updatedAtOf('1')).toBe(firstRun);
  });
});
