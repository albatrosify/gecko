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
  buildEpgCache,
  parseTvBlocks,
  collectPlaylistEpgBindings,
  EPG_CACHE_FRESH_MS,
  EPG_CACHE_MAX_AGE_MS
} from './epg-service.ts';
import { connectDb, getDb } from './db.ts';
import { epgs as schemaEpgs, sources as schemaSources, mappings as schemaMappings, streams as schemaStreams } from './schema.ts';
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

  describe('buildEpgCache – playlist-scoped assembly', () => {
    it('emits only playlist-exported channels; overrides win, upstream pairings stay default', async () => {
      process.env.SQLITE_PATH = ':memory:';
      await connectDb();
      const db = getDb();
      db.insert(schemaEpgs).values({ id: 'epg-de', userId: 'user-1', name: 'IPTV-EPG Germany', url: 'https://epg-de.test/xmltv', extra: { enabled: true } }).run();
      db.insert(schemaSources).values({
        id: 'src-up',
        userId: 'user-1',
        name: 'Strong',
        type: 'xtream',
        url: 'http://up.test',
        username: 'u',
        password: 'p',
        autoSyncEnabled: false,
        extra: { useUpstreamEpg: true },
      } as any).run();
      const now = Date.now();
      const streams = [
        { sourceId: 'src-up', type: 'live', streamId: '1025123', name: 'PROSIEBEN FHD', epgChannelId: null, updatedAt: now },   // override
        { sourceId: 'src-up', type: 'live', streamId: '480050', name: 'PROSIEBEN 4K', epgChannelId: 'Pro7.de', updatedAt: now }, // upstream default
        { sourceId: 'src-up', type: 'live', streamId: '480051', name: 'NO PAIRING', epgChannelId: null, updatedAt: now },        // unbound by design
        { sourceId: 'src-up', type: 'live', streamId: '480052', name: 'HIDDEN', epgChannelId: 'ZDF.de', updatedAt: now },        // hidden → excluded
      ];
      for (const s of streams) db.insert(schemaStreams).values(s as any).run();
      db.insert(schemaMappings).values({
        id: 'm-override',
        playlistId: 'pl-epg-res',
        type: 'live',
        originalId: '1025123',
        extra: JSON.stringify({ epgMapping: 'ProSieben.de', epgSource: 'IPTV-EPG Germany', sourceIdx: 0, hidden: false }),
      }).run();
      db.insert(schemaMappings).values({
        id: 'm-hidden',
        playlistId: 'pl-epg-res',
        type: 'live',
        originalId: '480052',
        extra: JSON.stringify({ epgSource: 'IPTV-EPG Germany', sourceIdx: 0, hidden: true }),
      }).run();

      const ger = '<?xml version="1.0"?><tv>'
        + '<channel id="ProSieben.de"><display-name>DE - ProSieben</display-name></channel>'
        + '<channel id="3sat.de"><display-name>DE - 3sat (not exported)</display-name></channel>'
        + '<programme start="a" channel="ProSieben.de"><title>DE-Prog</title></programme>'
        + '<programme start="b" channel="3sat.de"><title>3sat-Prog</title></programme>'
        + '</tv>';
      const up = '<?xml version="1.0"?><tv>'
        + '<channel id="Pro7.de"><display-name>Pro 7</display-name></channel>'
        + '<channel id="ProSieben.de"><display-name>duplicache — dropped</display-name></channel>'
        + '<programme start="z" channel="Pro7.de"><title>UP-Prog</title></programme>'
        + '<programme start="y" channel="ProSieben.de"><title>UP-dupe-drop</title></programme>'
        + '</tv>';
      (axios.get as any).mockImplementation(async (url: string) => {
        if (url.startsWith('https://epg-de.test/')) return { data: Buffer.from(ger, 'utf-8'), headers: {} };
        if (url.startsWith('http://up.test/xmltv.php?username=u&password=p')) return { data: Buffer.from(up, 'utf-8'), headers: {} };
        throw new Error(`unexpected fetch ${url}`);
      });

      const playlist = {
        id: 'pl-epg-res',
        name: 'Resolve Test',
        userId: 'user-1',
        sourceIds: ['src-up'],
        epgIds: ['epg-de'],
      } as any as Playlist;

      await buildEpgCache(playlist, 'http://img.test');
      const gz = fs.readFileSync(getEpgCachePath('pl-epg-res'));
      const xml = zlib.gunzipSync(gz).toString('utf-8');

      // Override wins: Germany's channel + programme, NOT the upstream duplicate
      expect((xml.match(/<channel id="ProSieben\.de"/g) || []).length).toBe(1);
      expect(xml).toContain('<title>DE-Prog</title>');
      expect(xml).not.toContain('UP-dupe-drop');
      expect(xml).toContain('DE - ProSieben');
      // Upstream default pairing kept with its own programme
      expect((xml.match(/<channel id="Pro7\.de"/g) || []).length).toBe(1);
      expect(xml).toContain('<title>UP-Prog</title>');
      // Filtered out: channels the playlist doesn't export
      expect(xml).not.toContain('3sat.de');
      expect(xml).not.toContain('<title>3sat-Prog</title>');
      expect((xml.match(/<channel\b/g) || []).length).toBe(2);
    });

    it('parses blocks safely (first channel def wins, programmes collected per id)', () => {
      const xml = '<tv><channel id="a.de"/><channel id="a.de"><display-name>dup</display-name></channel>'
        + '<programme channel="a.de"><title>1</title></programme>'
        + '<programme channel="b.de"><title>2</title></programme></tv>';
      const tv = parseTvBlocks(xml);
      expect(tv.channels.size).toBe(1);
      expect((tv.channels.get('a.de') || '').startsWith('<channel id="a.de"/>')).toBe(true);
      expect((tv.programmes.get('a.de') || []).length).toBe(1);
      expect((tv.programmes.get('b.de') || []).length).toBe(1);
    });

    it('bindings: override > upstream pairing; hidden excluded; unbound skipped', async () => {
      process.env.SQLITE_PATH = ':memory:';
      await connectDb();
      const db = getDb();
      db.insert(schemaMappings).values({
        id: 'm-bind-override',
        playlistId: 'pl-bind',
        type: 'live',
        originalId: 'override-me',
        extra: JSON.stringify({ epgMapping: 'X.de', epgSource: 'IPTV-EPG Germany', sourceIdx: 0, hidden: false }),
      }).run();
      db.insert(schemaMappings).values({
        id: 'm-bind-hidden',
        playlistId: 'pl-bind',
        type: 'live',
        originalId: 'hidden-me',
        extra: JSON.stringify({ sourceIdx: 0, hidden: true }),
      }).run();
      const now = Date.now();
      const rows = [
        { sourceId: 's1', type: 'live', streamId: 'override-me', name: 'A', epgChannelId: 'UpA.de', updatedAt: now },
        { sourceId: 's1', type: 'live', streamId: 'hidden-me', name: 'H', epgChannelId: 'UpH.de', updatedAt: now },
        { sourceId: 's1', type: 'live', streamId: 'plain', name: 'P', epgChannelId: 'UpP.de', updatedAt: now },
        { sourceId: 's1', type: 'live', streamId: 'unbound', name: 'U', epgChannelId: null, updatedAt: now },
        { sourceId: 's1', type: 'vod', streamId: '9', name: 'V', epgChannelId: 'V.de', updatedAt: now },
      ];
      for (const r of rows) db.insert(schemaStreams).values(r as any).run();

      const playlist = { id: 'pl-bind', name: 't', userId: 'u1', sourceIds: ['s1'], epgIds: [] } as any as Playlist;
      const bindings = collectPlaylistEpgBindings(playlist);
      const byId = new Map(bindings.map(b => [b.id, b]));
      // override wins over the upstream pairing
      expect(byId.get('X.de')?.fromOverride).toBe(true);
      expect(byId.get('X.de')?.ownerSourceName).toBe('IPTV-EPG Germany');
      expect(byId.has('UpA.de')).toBe(false);
      // default = upstream pairing
      expect(byId.get('UpP.de')?.fromOverride).toBe(false);
      // hidden and paireless excluded; vod not considered
      expect(byId.has('UpH.de')).toBe(false);
      expect(byId.has('V.de')).toBe(false);
      expect(bindings.length).toBe(2);
    });
  });
});
