import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { performance } from 'node:perf_hooks';

vi.mock('./logger.ts', () => ({
  log: vi.fn(),
}));

import { log } from './logger.ts';
import {
  resolveThresholds,
  severityFor,
  nsToMs,
  summarizeLag,
  formatStallMessage,
  formatLagMessage,
  measureSync,
  initEventLoopMonitor,
  stopEventLoopMonitor,
  getEventLoopStats,
  resetEventLoopMonitorForTests,
  type LagHistogramLike,
} from './event-loop-monitor.ts';

const mockedLog = vi.mocked(log);

/** Blocks the thread for at least `ms` so a phase duration is deterministic. */
function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* spin */
  }
}

describe('event-loop-monitor — pure helpers', () => {
  it('resolves default thresholds when the environment is empty', () => {
    expect(resolveThresholds({})).toEqual({ warnMs: 100, criticalMs: 1000 });
  });

  it('honours environment overrides', () => {
    expect(resolveThresholds({ GECKO_EVENTLOOP_WARN_MS: '50', GECKO_EVENTLOOP_CRITICAL_MS: '500' }))
      .toEqual({ warnMs: 50, criticalMs: 500 });
  });

  it('falls back to defaults for invalid values', () => {
    expect(resolveThresholds({ GECKO_EVENTLOOP_WARN_MS: 'abc', GECKO_EVENTLOOP_CRITICAL_MS: '-5' }))
      .toEqual({ warnMs: 100, criticalMs: 1000 });
  });

  it('never lets critical fall below warn', () => {
    expect(resolveThresholds({ GECKO_EVENTLOOP_WARN_MS: '5000', GECKO_EVENTLOOP_CRITICAL_MS: '100' }))
      .toEqual({ warnMs: 5000, criticalMs: 5000 });
  });

  it('classifies severity at the exact boundaries', () => {
    const thresholds = { warnMs: 100, criticalMs: 1000 };
    expect(severityFor(0, thresholds)).toBe('ok');
    expect(severityFor(99.9, thresholds)).toBe('ok');
    expect(severityFor(100, thresholds)).toBe('warn');
    expect(severityFor(999.9, thresholds)).toBe('warn');
    expect(severityFor(1000, thresholds)).toBe('critical');
    expect(severityFor(16000, thresholds)).toBe('critical');
  });

  it('converts nanoseconds to milliseconds defensively', () => {
    expect(nsToMs(1_500_000)).toBe(1.5);
    expect(nsToMs(0)).toBe(0);
    expect(nsToMs(-10)).toBe(0);
    expect(nsToMs(Number.NaN)).toBe(0);
  });

  it('summarizes a histogram into milliseconds', () => {
    const fake: LagHistogramLike = {
      mean: 5_000_000,
      max: 20_000_000,
      percentile: (p: number) => (p === 50 ? 4_000_000 : 12_000_000),
    };
    expect(summarizeLag(fake)).toEqual({ meanMs: 5, p50Ms: 4, p99Ms: 12, maxMs: 20 });
  });

  it('formats a phase stall message with label and severity', () => {
    const message = formatStallMessage('sync:setSnapshot', 8432.1, 'critical');
    expect(message).toContain('CRITICAL');
    expect(message).toContain('sync:setSnapshot');
    expect(message).toContain('8432.1 ms');
  });

  it('formats a lag message and names the worst phase when known', () => {
    const summary = { meanMs: 1, p50Ms: 0.5, p99Ms: 3, maxMs: 16000 };
    expect(formatLagMessage(summary, 'critical', { label: 'sync:snapshot', durationMs: 16000 }))
      .toContain('sync:snapshot');
    expect(formatLagMessage(summary, 'critical', null))
      .toContain('no instrumented phase');
  });
});

describe('event-loop-monitor — measureSync', () => {
  beforeEach(() => {
    resetEventLoopMonitorForTests();
    mockedLog.mockClear();
  });

  afterEach(() => {
    stopEventLoopMonitor();
  });

  it('passes the return value through and records the worst phase', () => {
    initEventLoopMonitor({ warnMs: 60_000, criticalMs: 65_000, throttleMs: 0 });
    mockedLog.mockClear();

    const result = measureSync('phase:ok', () => 21 * 2);

    expect(result).toBe(42);
    expect(getEventLoopStats().worstPhase?.label).toBe('phase:ok');
    expect(mockedLog).not.toHaveBeenCalled();
  });

  it('rethrows the original error after measuring', () => {
    initEventLoopMonitor({ warnMs: 60_000, criticalMs: 65_000, throttleMs: 0 });

    expect(() => measureSync('phase:boom', () => {
      throw new Error('kaboom');
    })).toThrow('kaboom');

    expect(getEventLoopStats().worstPhase?.label).toBe('phase:boom');
  });

  it('logs a stall once the phase exceeds the warn threshold', () => {
    initEventLoopMonitor({ warnMs: 1, criticalMs: 1000, throttleMs: 0 });
    mockedLog.mockClear();

    measureSync('phase:slow', () => busyWait(6));

    expect(mockedLog).toHaveBeenCalledTimes(1);
    const message = mockedLog.mock.calls[0][0] as string;
    expect(message).toContain('phase:slow');
    expect(message).toContain('WARN');
  });

  it('reports critical severity for very long phases', () => {
    initEventLoopMonitor({ warnMs: 1, criticalMs: 5, throttleMs: 0 });
    mockedLog.mockClear();

    measureSync('phase:critical', () => busyWait(8));

    expect(mockedLog.mock.calls[0][0] as string).toContain('CRITICAL');
  });

  it('throttles repeated reports of the same phase', () => {
    initEventLoopMonitor({ warnMs: 1, criticalMs: 1000, throttleMs: 10_000 });
    mockedLog.mockClear();

    measureSync('phase:repeat', () => busyWait(3));
    measureSync('phase:repeat', () => busyWait(3));

    expect(mockedLog).toHaveBeenCalledTimes(1);
  });

  it('keeps the slowest phase when several are measured', () => {
    initEventLoopMonitor({ warnMs: 60_000, criticalMs: 65_000, throttleMs: 0 });

    // Wide margins: the 40 ms phase must stay the slowest even on a loaded CI box.
    measureSync('phase:small', () => busyWait(1));
    measureSync('phase:large', () => busyWait(40));
    measureSync('phase:medium', () => busyWait(2));

    expect(getEventLoopStats().worstPhase?.label).toBe('phase:large');
  });
});

describe('event-loop-monitor — lifecycle', () => {
  beforeEach(() => {
    resetEventLoopMonitorForTests();
    mockedLog.mockClear();
  });

  afterEach(() => {
    stopEventLoopMonitor();
  });

  it('reports enabled state and thresholds', () => {
    expect(getEventLoopStats().enabled).toBe(false);

    initEventLoopMonitor({ warnMs: 120, criticalMs: 900, reportIntervalMs: 60_000 });

    const stats = getEventLoopStats();
    expect(stats.enabled).toBe(true);
    expect(stats.thresholds).toEqual({ warnMs: 120, criticalMs: 900 });
    expect(stats.lag).toBeNull();
    expect(stats.lastCheckAt).toBeNull();
  });

  it('stops monitoring and disables the histogram', () => {
    initEventLoopMonitor({ reportIntervalMs: 60_000 });
    expect(getEventLoopStats().enabled).toBe(true);

    stopEventLoopMonitor();

    expect(getEventLoopStats().enabled).toBe(false);
  });

  it('is idempotent when started twice', () => {
    initEventLoopMonitor({ warnMs: 1, reportIntervalMs: 60_000 });
    initEventLoopMonitor({ warnMs: 2, reportIntervalMs: 60_000 });

    expect(getEventLoopStats().enabled).toBe(true);
    expect(getEventLoopStats().thresholds.warnMs).toBe(2);
  });
});
