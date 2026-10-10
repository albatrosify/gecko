import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { PassThrough } from 'stream';
import axios from 'axios';
import {
  getEpgCacheDir,
  getEpgCachePath,
  clearEpgCache,
  streamEpgFile,
  servePlaylistEpg,
  refreshPlaylistEpg,
  EPG_CACHE_FRESH_MS,
  EPG_CACHE_MAX_AGE_MS
} from './epg-service.ts';
import type { Playlist } from '../src/types.ts';

vi.mock('axios');

class MockResponse extends PassThrough {
  statusCode = 200;
  headers: Record<string, string> = {};
  headersSent = false;

  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  send(body?: any) {
    this.end(body);
    return this;
  }
}

describe('EPG Service & Disk Caching', () => {
  const testTmpDir = path.join(os.tmpdir(), `gecko-epg-test-${Date.now()}`);

  beforeEach(() => {
    process.env.EPG_CACHE_DIR = testTmpDir;
    fs.mkdirSync(testTmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    } catch {}
    delete process.env.EPG_CACHE_DIR;
  });

  it('generates sanitized cache paths correctly', () => {
    expect(getEpgCacheDir()).toBe(testTmpDir);
    const safePath = getEpgCachePath('pl-123_abc/../danger');
    expect(safePath).toContain('epg_pl-123_abc____danger.xml.gz');
    expect(path.dirname(safePath)).toBe(testTmpDir);
  });

  it('streams pre-compressed gzip file directly when client supports gzip', async () => {
    const xmlContent = '<?xml version="1.0"?><tv><channel id="1"><display-name>Test</display-name></channel></tv>';
    const gzipped = zlib.gzipSync(Buffer.from(xmlContent, 'utf-8'));
    const testFile = path.join(testTmpDir, 'test.xml.gz');
    fs.writeFileSync(testFile, gzipped);

    const writtenChunks: Buffer[] = [];
    const req = {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
      on: vi.fn()
    } as any;

    const res = new MockResponse();
    res.on('data', (chunk) => writtenChunks.push(chunk));

    const finishPromise = new Promise((resolve) => res.on('finish', resolve));
    streamEpgFile(req, res as any, testFile);
    await finishPromise;

    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['content-encoding']).toBe('gzip');
    const combined = Buffer.concat(writtenChunks);
    const unzipped = zlib.gunzipSync(combined).toString('utf-8');
    expect(unzipped).toBe(xmlContent);
  });

  it('decompresses stream on-the-fly when client does not support gzip', async () => {
    const xmlContent = '<?xml version="1.0"?><tv><channel id="1"><display-name>Plain</display-name></channel></tv>';
    const gzipped = zlib.gzipSync(Buffer.from(xmlContent, 'utf-8'));
    const testFile = path.join(testTmpDir, 'test_plain.xml.gz');
    fs.writeFileSync(testFile, gzipped);

    const writtenChunks: Buffer[] = [];
    const req = {
      headers: { 'accept-encoding': 'identity' },
      on: vi.fn()
    } as any;

    const res = new MockResponse();
    res.on('data', (chunk) => writtenChunks.push(chunk));

    const finishPromise = new Promise((resolve) => res.on('finish', resolve));
    streamEpgFile(req, res as any, testFile);
    await finishPromise;

    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['content-encoding']).toBeUndefined();
    const combined = Buffer.concat(writtenChunks).toString('utf-8');
    expect(combined).toBe(xmlContent);
  });

  it('serves fresh cached file without calling upstream or refreshing', async () => {
    const playlistId = 'playlist-fresh-1';
    const cacheFile = getEpgCachePath(playlistId);
    const xmlContent = '<?xml version="1.0"?><tv><channel id="1"/></tv>';
    fs.writeFileSync(cacheFile, zlib.gzipSync(Buffer.from(xmlContent, 'utf-8')));

    const playlist: Playlist = {
      id: playlistId,
      name: 'Fresh Playlist',
      userId: 'user-1',
      sourceIds: [],
      epgIds: []
    } as any;

    const req = {
      headers: { 'accept-encoding': 'gzip' },
      query: {},
      on: vi.fn()
    } as any;

    const writtenChunks: Buffer[] = [];
    const res = new MockResponse();
    res.on('data', (chunk) => writtenChunks.push(chunk));

    const finishPromise = new Promise((resolve) => res.on('finish', resolve));
    await servePlaylistEpg(req, res as any, playlist, 'http://localhost:3000');
    await finishPromise;

    // Axios should NOT have been called
    expect(axios.get).not.toHaveBeenCalled();
    expect(writtenChunks.length).toBeGreaterThan(0);
  });

  it('clears specific or all cache files properly', async () => {
    const p1 = getEpgCachePath('p1');
    const p2 = getEpgCachePath('p2');
    fs.writeFileSync(p1, 'test1');
    fs.writeFileSync(p2, 'test2');

    expect(fs.existsSync(p1)).toBe(true);
    expect(fs.existsSync(p2)).toBe(true);

    await clearEpgCache('p1');
    expect(fs.existsSync(p1)).toBe(false);
    expect(fs.existsSync(p2)).toBe(true);

    await clearEpgCache();
    expect(fs.existsSync(p2)).toBe(false);
  });
});
