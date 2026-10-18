import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordSourceChanges } from './sync.ts';
import { connectDb, getDb } from './db.ts';
import { source_changelogs } from './schema.ts';

describe('Source Sync & Changelog Non-Blocking Processing', () => {
  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    await connectDb();
    const db = getDb();
    db.delete(source_changelogs).run();
  });

  it('correctly calculates changes across datasets larger than yield batch size', async () => {
    // Generate 12,000 items (triggers multiple SYNC_YIELD_BATCH_SIZE iterations)
    const oldItems: Array<{ stream_id: number; name: string }> = [];
    const newItems: Array<{ stream_id: number; name: string }> = [];

    for (let i = 1; i <= 12000; i++) {
      oldItems.push({ stream_id: i, name: `Channel ${i}` });
      if (i === 10) {
        // Renamed
        newItems.push({ stream_id: i, name: `Channel 10 Renamed` });
      } else if (i === 50) {
        // Removed (omitted from newItems)
      } else {
        newItems.push({ stream_id: i, name: `Channel ${i}` });
      }
    }
    // Added
    newItems.push({ stream_id: 99999, name: `Channel New` });

    const changes = await recordSourceChanges('src-test', 'live', oldItems, newItems);

    expect(changes.added).toEqual([{ id: '99999', name: 'Channel New' }]);
    expect(changes.removed).toEqual([{ id: '50', name: 'Channel 50' }]);
    expect(changes.renamed).toEqual([{ id: '10', oldName: 'Channel 10', newName: 'Channel 10 Renamed' }]);

    const db = getDb();
    const logs = db.select().from(source_changelogs).all();
    expect(logs).toHaveLength(1);
    expect((logs[0].extra as any).totalAdded).toBe(1);
    expect((logs[0].extra as any).totalRemoved).toBe(1);
    expect((logs[0].extra as any).totalRenamed).toBe(1);
  });
});
