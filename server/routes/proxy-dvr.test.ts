import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { connectDb, getDb } from '../db.ts';
import { playlists, sources, recordings } from '../schema.ts';
import { dvrRecorder, RECORDINGS_DIR } from '../dvr/recorder.ts';
import { createProxyRouter, DVR_CATEGORY_ID } from './proxy.ts';

describe('Proxy DVR VOD Numeric IDs', () => {
  let server: http.Server;
  let baseUrl: string;
  const testRecId = '2883a608-38ca-43c6-aaf7-61057d358a0c';
  const testFilePath = path.join(RECORDINGS_DIR, 'test_rec.ts');

  beforeEach(async () => {
    process.env.SQLITE_PATH = ':memory:';
    await connectDb();

    const db = getDb();
    db.delete(playlists).run();
    db.delete(sources).run();
    db.delete(recordings).run();

    // Create a dummy recording file
    fs.writeFileSync(testFilePath, Buffer.from('TEST_TS_DATA'));

    // Insert dummy source and playlist
    db.insert(sources).values({
      id: 'src-1',
      userId: 'admin',
      name: 'Source 1',
      url: 'http://example.com',
      username: 'u',
      password: 'p',
      type: 'xtream',
    }).run();

    db.insert(playlists).values({
      id: 'pl-1',
      userId: 'admin',
      name: 'Test Playlist',
      username: 'tivi',
      password: 'tv',
      sourceIds: ['src-1'],
    }).run();

    // Insert completed recording
    db.insert(recordings).values({
      id: testRecId,
      userId: 'admin',
      playlistId: 'pl-1',
      sourceId: 'src-1',
      streamId: '100',
      streamName: 'DEL 2 Event 3',
      channelName: 'DEL 2 Event 3',
      type: 'live',
      status: 'completed',
      startTime: '2026-10-09T17:26:30.000Z',
      endTime: '2026-10-09T18:26:30.000Z',
      durationSeconds: 3600,
      fileSizeBytes: 12,
      filePath: testFilePath,
    }).run();

    const app = express();
    app.use('/', createProxyRouter());
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (fs.existsSync(testFilePath)) {
      try { fs.unlinkSync(testFilePath); } catch {}
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serves DVR category with numeric category_id in get_vod_categories', async () => {
    const res = await fetch(`${baseUrl}/player_api.php?username=tivi&password=tv&action=get_vod_categories`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const dvrCat = data.find((c: any) => c.category_id === DVR_CATEGORY_ID);
    expect(dvrCat).toBeDefined();
    expect(dvrCat.category_name).toContain('Gecko Recordings');
    // Must be numeric string so strict clients do not crash
    expect(/^\d+$/.test(dvrCat.category_id)).toBe(true);
  });

  it('serves DVR recordings with numeric stream_id in get_vod_streams', async () => {
    const res = await fetch(`${baseUrl}/player_api.php?username=tivi&password=tv&action=get_vod_streams`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);

    const numericId = dvrRecorder.getNumericId(testRecId);
    const item = data.find((s: any) => s.stream_id === numericId);
    expect(item).toBeDefined();
    expect(typeof item.stream_id).toBe('number');
    expect(item.stream_id).toBeGreaterThanOrEqual(900000000);
    expect(item.category_id).toBe(DVR_CATEGORY_ID);
    expect(item.category_ids).toEqual([parseInt(DVR_CATEGORY_ID, 10)]);
    expect(item.name).toContain('DEL 2 Event 3');
  });

  it('retrieves VOD info via numeric stream_id in get_vod_info', async () => {
    const numericId = dvrRecorder.getNumericId(testRecId);
    const res = await fetch(`${baseUrl}/player_api.php?username=tivi&password=tv&action=get_vod_info&vod_id=${numericId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.movie_data).toBeDefined();
    expect(data.movie_data.stream_id).toBe(numericId);
    expect(data.movie_data.category_id).toBe(DVR_CATEGORY_ID);
  });

  it('plays movie stream using numeric ID (/movie/:u/:p/:numericId.ts)', async () => {
    const numericId = dvrRecorder.getNumericId(testRecId);
    const res = await fetch(`${baseUrl}/movie/tivi/tv/${numericId}.ts`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('TEST_TS_DATA');
  });
});
