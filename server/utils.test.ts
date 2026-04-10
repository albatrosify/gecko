import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyRegex } from './utils';
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
