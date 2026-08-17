import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyRegex, parseXtreamExpDate } from './utils';
import * as logger from './logger';

vi.mock('./logger', () => ({
  log: vi.fn()
}));

describe('applyRegex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should apply valid regex replacements', () => {
    const rules = [{ pattern: 'foo', replacement: 'bar' }];
    expect(applyRegex('foo baz', rules)).toBe('bar baz');
  });

  it('should catch invalid regex and log an error without throwing', () => {
    const rules = [{ pattern: '[', replacement: 'bar' }];
    expect(applyRegex('foo baz', rules)).toBe('foo baz');
    expect(logger.log).toHaveBeenCalledWith('Invalid regex: [');
  });
});

describe('parseXtreamExpDate', () => {
  it('should return null for unlimited, null, or empty values', () => {
    expect(parseXtreamExpDate(null)).toBeNull();
    expect(parseXtreamExpDate(undefined)).toBeNull();
    expect(parseXtreamExpDate('')).toBeNull();
    expect(parseXtreamExpDate('   ')).toBeNull();
    expect(parseXtreamExpDate('0')).toBeNull();
    expect(parseXtreamExpDate(0)).toBeNull();
    expect(parseXtreamExpDate('null')).toBeNull();
    expect(parseXtreamExpDate('unlimited')).toBeNull();
    expect(parseXtreamExpDate('Unlimited')).toBeNull();
    expect(parseXtreamExpDate('never')).toBeNull();
  });

  it('should parse unix timestamp in seconds', () => {
    // 1735689600 = 2025-01-01T00:00:00.000Z
    expect(parseXtreamExpDate('1735689600')).toBe(new Date(1735689600 * 1000).toISOString());
    expect(parseXtreamExpDate(1735689600)).toBe(new Date(1735689600 * 1000).toISOString());
  });

  it('should parse unix timestamp in milliseconds', () => {
    const ms = 1735689600000;
    expect(parseXtreamExpDate(ms)).toBe(new Date(ms).toISOString());
    expect(parseXtreamExpDate(String(ms))).toBe(new Date(ms).toISOString());
  });

  it('should parse formatted date strings', () => {
    const iso = '2026-12-31T23:59:59.000Z';
    expect(parseXtreamExpDate(iso)).toBe(new Date(iso).toISOString());
    const dateStr = '2026-12-31 23:59:59';
    expect(parseXtreamExpDate(dateStr)).toBe(new Date(dateStr.replace(' ', 'T')).toISOString());
  });
});

