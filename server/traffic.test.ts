import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectDb, getDb } from './db.ts';
import {
  recordTraffic,
  flushTraffic,
  getTrafficStats,
  getMonthTrafficBytes,
  resetTrafficStats,
  stopTrafficFlusher
} from './traffic.ts';

describe('Traffic Stats Tracking', () => {
  beforeEach(async () => {
    await connectDb();
    resetTrafficStats();
  });

  afterEach(() => {
    stopTrafficFlusher();
  });

  it('records and flushes traffic to database', () => {
    const today = new Date().toISOString().slice(0, 10);
    recordTraffic('pl-1', 'Family Playlist', 'live', 1000);
    recordTraffic('pl-1', 'Family Playlist', 'live', 2500);
    recordTraffic('pl-1', 'Family Playlist', 'movie', 5000);
    recordTraffic('pl-2', 'Kids Playlist', 'series', 3000);

    flushTraffic();

    const stats = getTrafficStats(today, today);

    expect(stats.totalBytes).toBe(11500);
    expect(stats.byType.live).toBe(3500);
    expect(stats.byType.movie).toBe(5000);
    expect(stats.byType.series).toBe(3000);
    expect(stats.byType.other).toBe(0);

    expect(stats.byPlaylist).toHaveLength(2);
    const family = stats.byPlaylist.find(p => p.playlistId === 'pl-1');
    expect(family).toBeDefined();
    expect(family?.totalBytes).toBe(8500);
    expect(family?.byType.live).toBe(3500);
    expect(family?.byType.movie).toBe(5000);

    const kids = stats.byPlaylist.find(p => p.playlistId === 'pl-2');
    expect(kids).toBeDefined();
    expect(kids?.totalBytes).toBe(3000);
    expect(kids?.byType.series).toBe(3000);
  });

  it('aggregates daily timeline points', () => {
    const today = new Date().toISOString().slice(0, 10);
    recordTraffic('pl-1', 'Main', 'live', 1024 * 1024);
    flushTraffic();

    const stats = getTrafficStats(today, today);
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0].date).toBe(today);
    expect(stats.daily[0].totalBytes).toBe(1024 * 1024);
    expect(stats.daily[0].byType.live).toBe(1024 * 1024);
  });

  it('calculates month to date bytes and percentage', () => {
    const bytes = 50 * 1024 * 1024 * 1024; // 50 GB
    recordTraffic('pl-1', 'Main', 'live', bytes);
    flushTraffic();

    const monthData = getMonthTrafficBytes();
    expect(monthData.monthBytes).toBe(bytes);
    expect(monthData.quotaBytes).toBeGreaterThan(0);

    const stats = getTrafficStats();
    expect(stats.summary.monthBytes).toBe(bytes);
    expect(stats.summary.todayBytes).toBe(bytes);
    expect(stats.summary.monthPercent).toBeGreaterThan(0);
  });

  it('can reset traffic for a specific playlist or completely', () => {
    recordTraffic('pl-1', 'Main', 'live', 5000);
    recordTraffic('pl-2', 'Other', 'movie', 3000);
    flushTraffic();

    resetTrafficStats('pl-1');
    let stats = getTrafficStats();
    expect(stats.byPlaylist.find(p => p.playlistId === 'pl-1')).toBeUndefined();
    expect(stats.byPlaylist.find(p => p.playlistId === 'pl-2')).toBeDefined();

    resetTrafficStats();
    stats = getTrafficStats();
    expect(stats.totalBytes).toBe(0);
    expect(stats.byPlaylist).toHaveLength(0);
  });
});
