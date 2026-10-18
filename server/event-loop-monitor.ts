import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import { log } from './logger.ts';

/**
 * Event-loop stall observability.
 *
 * GECKO runs the live-stream multiplexer on the same event loop as every REST
 * request, sync job and JSON transform. A synchronous block of a few hundred
 * milliseconds therefore stalls `pumpChannelBuffer` and the upstream socket
 * reads — which StreamHub can misread as an upstream gap and answer with a
 * self-healing reconnect. This module turns those blocks from guesswork into
 * measurements:
 *
 *  - `measureSync()` attributes an explicit stall to a named phase and logs it.
 *  - `initEventLoopMonitor()` watches the loop with a histogram, so stalls from
 *    still-uninstrumented code are reported as well.
 *  - `getEventLoopStats()` exposes the current picture (used by `/health`).
 *
 * The pure helpers (`resolveThresholds`, `severityFor`, `summarizeLag`,
 * `nsToMs`, `formatStallMessage`) hold the logic and are unit-tested directly.
 *
 * Caveat: the histogram needs one sampler tick (~`resolutionMs`) before it can
 * attribute a delay — a block that starts immediately after `enable()` is
 * missed. `initEventLoopMonitor()` is therefore called before any workload, so
 * everything that matters is covered. `measureSync()` has no such caveat: it
 * times its phase directly, which is why both mechanisms exist.
 */

export type StallSeverity = 'ok' | 'warn' | 'critical';

export interface StallThresholds {
  /** Lag at or above this is reported as a stall. */
  warnMs: number;
  /** Lag at or above this is reported as critical. */
  criticalMs: number;
}

/** Minimal shape of an `IntervalHistogram`, so the summary stays testable. */
export interface LagHistogramLike {
  mean: number;
  max: number;
  percentile(percentile: number): number;
}

export interface LagSummary {
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface EventLoopStats {
  enabled: boolean;
  thresholds: StallThresholds;
  /** ISO timestamp of the last histogram check, or null before the first one. */
  lastCheckAt: string | null;
  /** Most recent per-interval lag summary, or null before the first check. */
  lag: LagSummary | null;
  /** Slowest instrumented phase since the last check. */
  worstPhase: { label: string; durationMs: number } | null;
  /** Total number of stall reports emitted. */
  stallReports: number;
}

const DEFAULT_WARN_MS = 100;
const DEFAULT_CRITICAL_MS = 1000;
const DEFAULT_RESOLUTION_MS = 10;
const DEFAULT_REPORT_INTERVAL_MS = 10_000;
const DEFAULT_THROTTLE_MS = 5_000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Parses a positive number from `raw`, falling back to `fallback`. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves the stall thresholds from the environment, falling back to the
 * defaults. `criticalMs` is clamped up to `warnMs` so the two can never invert.
 */
export function resolveThresholds(env: NodeJS.ProcessEnv = process.env): StallThresholds {
  const warnMs = positiveNumber(env.GECKO_EVENTLOOP_WARN_MS, DEFAULT_WARN_MS);
  const criticalRaw = positiveNumber(env.GECKO_EVENTLOOP_CRITICAL_MS, DEFAULT_CRITICAL_MS);
  return { warnMs, criticalMs: Math.max(criticalRaw, warnMs) };
}

/** Classifies a lag value against the thresholds. */
export function severityFor(lagMs: number, thresholds: StallThresholds): StallSeverity {
  if (lagMs >= thresholds.criticalMs) return 'critical';
  if (lagMs >= thresholds.warnMs) return 'warn';
  return 'ok';
}

/** Converts a nanosecond duration to milliseconds, rounded to 2 decimals. */
export function nsToMs(ns: number): number {
  if (!Number.isFinite(ns) || ns <= 0) return 0;
  return Math.round((ns / 1e6) * 100) / 100;
}

/** Builds a millisecond summary from a nanosecond histogram. */
export function summarizeLag(histogram: LagHistogramLike): LagSummary {
  return {
    meanMs: nsToMs(histogram.mean),
    p50Ms: nsToMs(histogram.percentile(50)),
    p99Ms: nsToMs(histogram.percentile(99)),
    maxMs: nsToMs(histogram.max),
  };
}

/** Formats the log line for a single instrumented phase exceeding the threshold. */
export function formatStallMessage(label: string, durationMs: number, severity: StallSeverity): string {
  return `[EventLoop] ${severity.toUpperCase()}: phase "${label}" blocked the event loop for ${durationMs.toFixed(1)} ms`;
}

/** Formats the log line for the per-interval histogram check. */
export function formatLagMessage(summary: LagSummary, severity: StallSeverity, worstPhase: { label: string; durationMs: number } | null): string {
  const attribution = worstPhase
    ? `worst instrumented phase: "${worstPhase.label}" (${worstPhase.durationMs.toFixed(1)} ms)`
    : 'no instrumented phase to attribute it to';
  return `[EventLoop] ${severity.toUpperCase()}: lag mean=${summary.meanMs}ms p50=${summary.p50Ms}ms p99=${summary.p99Ms}ms max=${summary.maxMs}ms — ${attribution}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let thresholds: StallThresholds = resolveThresholds();
let reportThrottleMs = DEFAULT_THROTTLE_MS;

let histogram: IntervalHistogram | null = null;
let checkTimer: NodeJS.Timeout | null = null;

let latestSummary: LagSummary | null = null;
let lastCheckAt: string | null = null;
let worstPhase: { label: string; durationMs: number } | null = null;
let stallReports = 0;

/** Last report time per phase label, so one hot phase cannot flood the log. */
const lastReportAt = new Map<string, number>();

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

/** Records the duration of a completed phase, logging when it exceeded the threshold. */
function recordPhase(label: string, durationMs: number, now: number = Date.now()): void {
  if (!worstPhase || durationMs > worstPhase.durationMs) {
    worstPhase = { label, durationMs };
  }

  const severity = severityFor(durationMs, thresholds);
  if (severity === 'ok') return;

  const previous = lastReportAt.get(label) ?? 0;
  if (now - previous < reportThrottleMs) return;
  lastReportAt.set(label, now);

  stallReports++;
  log(formatStallMessage(label, durationMs, severity));
}

/**
 * Runs a synchronous function and measures how long it blocked the event loop.
 *
 * Use this around known-heavy synchronous work (JSON transforms, synchronous
 * SQLite writes) so a stall can be attributed to a named phase. The return
 * value is passed through and exceptions are rethrown after measuring.
 */
export function measureSync<T>(label: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    recordPhase(label, performance.now() - start);
  }
}

// ---------------------------------------------------------------------------
// Histogram monitor
// ---------------------------------------------------------------------------

export interface MonitorOptions {
  warnMs?: number;
  criticalMs?: number;
  /** Histogram sampling resolution in ms (default 10). */
  resolutionMs?: number;
  /** How often the histogram is checked and reset, in ms (default 10000). */
  reportIntervalMs?: number;
  /** Minimum spacing between two reports of the same phase (default 5000 ms). */
  throttleMs?: number;
}

function runCheck(): void {
  if (!histogram) return;

  const summary = summarizeLag(histogram);
  histogram.reset();

  latestSummary = summary;
  lastCheckAt = new Date().toISOString();

  const severity = severityFor(summary.maxMs, thresholds);
  const phase = worstPhase;
  worstPhase = null;

  if (severity === 'ok') return;

  stallReports++;
  log(formatLagMessage(summary, severity, phase));
}

/**
 * Starts lag monitoring. Idempotent: a second call replaces the previous
 * monitor. Safe to call before any request is served.
 */
export function initEventLoopMonitor(options: MonitorOptions = {}): void {
  stopEventLoopMonitor();

  thresholds = {
    warnMs: options.warnMs ?? resolveThresholds().warnMs,
    criticalMs: options.criticalMs ?? resolveThresholds().criticalMs,
  };
  reportThrottleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;

  // Keep the resolved thresholds coherent even when only one is overridden.
  thresholds.criticalMs = Math.max(thresholds.criticalMs, thresholds.warnMs);

  histogram = monitorEventLoopDelay({ resolution: options.resolutionMs ?? DEFAULT_RESOLUTION_MS });
  histogram.enable();

  checkTimer = setInterval(runCheck, options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS);
  checkTimer.unref?.();

  log(`[EventLoop] Monitoring started (warn ≥ ${thresholds.warnMs} ms, critical ≥ ${thresholds.criticalMs} ms).`);
}

/** Stops monitoring and releases the histogram. */
export function stopEventLoopMonitor(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (histogram) {
    histogram.disable();
    histogram = null;
  }
}

/** Returns the current observability snapshot. */
export function getEventLoopStats(): EventLoopStats {
  return {
    enabled: histogram !== null,
    thresholds,
    lastCheckAt,
    lag: latestSummary,
    worstPhase,
    stallReports,
  };
}

/** Clears accumulated state. Intended for tests. */
export function resetEventLoopMonitorForTests(): void {
  stopEventLoopMonitor();
  thresholds = resolveThresholds();
  reportThrottleMs = DEFAULT_THROTTLE_MS;
  latestSummary = null;
  lastCheckAt = null;
  worstPhase = null;
  stallReports = 0;
  lastReportAt.clear();
}
