import { describe, it, expect } from 'vitest';
import { normalizeHosts, getOrderedHosts, getActiveHostUrls } from './hosts';

describe('normalizeHosts', () => {
  it('deduplicates hosts and includes the primary URL first', () => {
    const hosts = normalizeHosts(['http://b.example.com:8080', 'http://a.example.com:8080'], 'http://primary.example.com:8080');
    expect(hosts.map(h => h.url)).toEqual([
      'http://primary.example.com:8080',
      'http://b.example.com:8080',
      'http://a.example.com:8080',
    ]);
    expect(hosts.every(h => h.order === hosts.indexOf(h))).toBe(true);
  });

  it('preserves existing stats when re-normalizing', () => {
    const existing = normalizeHosts(['http://a.example.com:8080'], 'http://a.example.com:8080');
    existing[0].uses = 5;
    existing[0].failures = 2;
    const result = normalizeHosts(['http://a.example.com:8080', 'http://b.example.com:8080'], 'http://a.example.com:8080', existing);
    expect(result[0].uses).toBe(5);
    expect(result[0].failures).toBe(2);
  });

  it('accepts object host entries with labels', () => {
    const hosts = normalizeHosts([{ url: 'http://a.example.com:8080/', label: 'A' }], 'http://a.example.com:8080');
    expect(hosts[0].url).toBe('http://a.example.com:8080');
    expect(hosts[0].label).toBe('A');
  });
});

describe('getOrderedHosts / getActiveHostUrls', () => {
  it('falls back to the primary URL when no hosts are configured', () => {
    expect(getActiveHostUrls({ url: 'http://only.example.com:8080' })).toEqual(['http://only.example.com:8080']);
  });

  it('sorts the primary host first and filters disabled hosts', () => {
    const doc = {
      url: 'http://primary.example.com:8080',
      hosts: [
        { url: 'http://primary.example.com:8080', order: 2, uses: 0, failures: 0 },
        { url: 'http://second.example.com:8080', order: 0, uses: 0, failures: 0 },
        { url: 'http://disabled.example.com:8080', order: 1, enabled: false, uses: 0, failures: 0 },
      ],
    };
    expect(getActiveHostUrls(doc)).toEqual([
      'http://primary.example.com:8080',
      'http://second.example.com:8080',
    ]);
  });
});
