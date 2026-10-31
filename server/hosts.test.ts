import { describe, it, expect, vi } from 'vitest';
import { normalizeHosts, getOrderedHosts, getActiveHostUrls, detectHostNetwork, nextHostHealth, isHostDemoted, HOST_HEALTH_MIN } from './hosts';
import * as dnsResolver from './dns-resolver';

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

  it('preserves resolvedIps and ipCount when re-normalizing from existing hosts', () => {
    const existing: any[] = [{
      url: 'http://a.example.com:8080',
      order: 0,
      uses: 10,
      failures: 0,
      resolvedIp: '198.51.100.1',
      ipCount: 3,
      resolvedIps: [
        { ip: '198.51.100.1', latencyMs: 25, healthy: true },
        { ip: '198.51.100.2', latencyMs: 35, healthy: true },
        { ip: '198.51.100.3', latencyMs: null, healthy: false },
      ],
    }];
    const result = normalizeHosts(['http://a.example.com:8080', 'http://b.example.com:8080'], 'http://a.example.com:8080', existing);
    expect(result[0].ipCount).toBe(3);
    expect(result[0].resolvedIp).toBe('198.51.100.1');
    expect(result[0].resolvedIps).toEqual(existing[0].resolvedIps);
    expect(result[1].ipCount).toBeUndefined();
    expect(result[1].resolvedIps).toBeUndefined();
  });

  it('preserves resolvedIps and ipCount from raw object input', () => {
    const rawHosts = [{
      url: 'http://multi.example.com:8080',
      label: 'Multi IP Host',
      resolvedIp: '203.0.113.10',
      ipCount: 2,
      resolvedIps: [
        { ip: '203.0.113.10', latencyMs: 15, healthy: true },
        { ip: '203.0.113.11', latencyMs: 20, healthy: true },
      ],
    }];
    const result = normalizeHosts(rawHosts, 'http://primary.example.com:8080');
    const host = result.find(h => h.url === 'http://multi.example.com:8080');
    expect(host?.ipCount).toBe(2);
    expect(host?.resolvedIp).toBe('203.0.113.10');
    expect(host?.resolvedIps).toHaveLength(2);
    expect(host?.resolvedIps?.[0].ip).toBe('203.0.113.10');
  });

  it('preserves resolvedIps and ipCount when primary URL is prepended from existing hosts', () => {
    const existing: any[] = [{
      url: 'http://primary.example.com:8080',
      order: 0,
      uses: 1,
      failures: 0,
      resolvedIp: '198.51.100.5',
      ipCount: 2,
      resolvedIps: [
        { ip: '198.51.100.5', latencyMs: 18, healthy: true },
        { ip: '198.51.100.6', latencyMs: 40, healthy: true },
      ],
    }];
    const result = normalizeHosts(['http://other.example.com:8080'], 'http://primary.example.com:8080', existing);
    expect(result[0].url).toBe('http://primary.example.com:8080');
    expect(result[0].ipCount).toBe(2);
    expect(result[0].resolvedIp).toBe('198.51.100.5');
    expect(result[0].resolvedIps).toEqual(existing[0].resolvedIps);
  });

  it('accepts object host entries with labels', () => {
    const hosts = normalizeHosts([{ url: 'http://a.example.com:8080/', label: 'A' }], 'http://a.example.com:8080');
    expect(hosts[0].url).toBe('http://a.example.com:8080');
    expect(hosts[0].label).toBe('A');
  });
});

describe('detectHostNetwork', () => {
  it('identifies direct IP addresses and sets resolvedIp', async () => {
    const res = await detectHostNetwork('http://192.0.2.1:8080');
    expect(res.networkType).toBe('direct');
    expect(res.cdnProvider).toBeNull();
    expect(res.resolvedIp).toBe('192.0.2.1');
  });

  it('identifies Cloudflare IP addresses and sets cdnProvider', async () => {
    const res = await detectHostNetwork('http://104.16.0.1:8080');
    expect(res.networkType).toBe('cdn');
    expect(res.cdnProvider).toBe('Cloudflare');
    expect(res.resolvedIp).toBe('104.16.0.1');
  });

  it('populates multi-IP information when rankHostIps returns multiple IPs', async () => {
    const spy = vi.spyOn(dnsResolver, 'rankHostIps').mockResolvedValueOnce([
      { ip: '198.51.100.10', latencyMs: 20, healthy: true },
      { ip: '198.51.100.20', latencyMs: 50, healthy: true },
    ]);
    const res = await detectHostNetwork('http://multi-domain.example.com:8080');
    expect(res.ipCount).toBe(2);
    expect(res.resolvedIp).toBe('198.51.100.10');
    expect(res.resolvedIps).toHaveLength(2);
    expect(res.networkType).toBe('direct');
    spy.mockRestore();
  });

  it('classifies as Cloudflare CDN if any ranked IP is a Cloudflare IP', async () => {
    const spy = vi.spyOn(dnsResolver, 'rankHostIps').mockResolvedValueOnce([
      { ip: '104.16.1.1', latencyMs: 15, healthy: true },
      { ip: '198.51.100.20', latencyMs: 50, healthy: true },
    ]);
    const res = await detectHostNetwork('http://cf-domain.example.com:8080');
    expect(res.networkType).toBe('cdn');
    expect(res.cdnProvider).toBe('Cloudflare');
    expect(res.ipCount).toBe(2);
    expect(res.resolvedIp).toBe('104.16.1.1');
    spy.mockRestore();
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

  it('demotes a dead primary behind a healthy host instead of burning its timeout first', () => {
    const now = Date.now();
    const doc = {
      url: 'http://dead.example.com:8080',
      hosts: [
        { url: 'http://dead.example.com:8080', order: 0, uses: 267, failures: 146, health: 0.05, lastErrorAt: new Date(now - 30_000).toISOString() },
        { url: 'http://works.example.com:8080', order: 1, uses: 500, failures: 3, health: 0.98, lastErrorAt: null },
      ],
    };
    expect(getActiveHostUrls(doc)).toEqual([
      'http://works.example.com:8080',
      'http://dead.example.com:8080',
    ]);
  });

  it('keeps the manual order while hosts look equally healthy', () => {
    const doc = {
      url: 'http://primary.example.com:8080',
      hosts: [
        { url: 'http://primary.example.com:8080', order: 0, uses: 0, failures: 0, health: 0.9 },
        { url: 'http://second.example.com:8080', order: 1, uses: 0, failures: 0, health: 0.85 },
      ],
    };
    expect(getActiveHostUrls(doc)[0]).toBe('http://primary.example.com:8080');
  });

  it('gives a demoted host another chance once it has been quiet for a while', () => {
    const stale = isHostDemoted({
      url: 'http://recovered.example.com:8080',
      order: 0,
      uses: 0,
      failures: 20,
      health: 0.1,
      lastErrorAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const fresh = isHostDemoted({
      url: 'http://still-dead.example.com:8080',
      order: 0,
      uses: 0,
      failures: 20,
      health: 0.1,
      lastErrorAt: new Date(Date.now() - 30_000).toISOString(),
    });
    expect(stale).toBe(false);
    expect(fresh).toBe(true);
  });

  it('nextHostHealth decays on failures and recovers on successes', () => {
    expect(nextHostHealth(undefined, 1, 0)).toBe(1);

    let health = nextHostHealth(1, 0, 3);
    expect(health).toBeLessThan(HOST_HEALTH_MIN);

    // Failures continue to lower it, successes pull it back above the threshold.
    health = nextHostHealth(health, 0, 1);
    expect(health).toBeLessThan(HOST_HEALTH_MIN);
    health = nextHostHealth(nextHostHealth(nextHostHealth(health, 1, 0), 1, 0), 1, 0);
    health = nextHostHealth(health, 1, 0);
    expect(health).toBeGreaterThanOrEqual(HOST_HEALTH_MIN);
  });
});
