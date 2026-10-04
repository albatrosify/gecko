import { describe, it, expect } from 'vitest';
import { buildBandwidthGeometry, formatMbps, indexFromPointerX, niceMaxMbps, selectWindow } from './BandwidthChart.tsx';

const makeSamples = (values: number[], startTime = 1_700_000_000_000, stepMs = 2000) =>
  values.map((mbps, index) => ({ time: startTime + index * stepMs, bps: mbps * 1_000_000 }));

describe('niceMaxMbps', () => {
  it('rounds a peak up to a readable axis maximum', () => {
    expect(niceMaxMbps(5.3)).toBe(7.5);
    expect(niceMaxMbps(12)).toBe(15);
    expect(niceMaxMbps(1)).toBe(1);
    expect(niceMaxMbps(0.4)).toBe(0.4); // already a round axis value
    expect(niceMaxMbps(0.42)).toBe(0.5);
  });

  it('never returns zero, so the axis cannot divide by zero on an idle link', () => {
    expect(niceMaxMbps(0)).toBe(1);
    expect(niceMaxMbps(-5)).toBe(1);
    expect(niceMaxMbps(Number.NaN)).toBe(1);
  });
});

describe('selectWindow', () => {
  it('keeps only samples inside the requested window, measured from the newest sample', () => {
    const history = makeSamples([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 5 samples span 8s; a 10s window reaches back to the *10th* from the end.
    expect(selectWindow(history, 10)).toHaveLength(6);
    expect(selectWindow(history, 600)).toHaveLength(10);
    expect(selectWindow(history, 1)).toHaveLength(1);
  });

  it('handles an empty history', () => {
    expect(selectWindow([], 60)).toEqual([]);
  });
});

describe('buildBandwidthGeometry', () => {
  const options = { width: 600, height: 176 };

  it('spans the plot area from the first to the last sample', () => {
    const geometry = buildBandwidthGeometry(makeSamples([1, 2, 3]), options);
    const first = geometry.points[0];
    const last = geometry.points[geometry.points.length - 1];

    expect(first.x).toBe(geometry.plotLeft);
    expect(last.x).toBeCloseTo(geometry.plotLeft + geometry.plotWidth, 5);
    // First and last share the same time span as the input, newest on the right.
    expect(last.time).toBeGreaterThan(first.time);
  });

  it('keeps every point inside the plot box and scales the peak to the top', () => {
    const geometry = buildBandwidthGeometry(makeSamples([2, 40, 7, 0, 21]), options);
    const top = geometry.plotTop;
    const bottom = geometry.plotTop + geometry.plotHeight;

    for (const point of geometry.points) {
      expect(point.y).toBeGreaterThanOrEqual(top);
      expect(point.y).toBeLessThanOrEqual(bottom);
      expect(point.x).toBeGreaterThanOrEqual(geometry.plotLeft);
      expect(point.x).toBeLessThanOrEqual(geometry.plotLeft + geometry.plotWidth);
    }

    // The axis maximum stays above the peak, so the trace is never clipped.
    expect(geometry.peakMbps).toBe(40);
    expect(geometry.yMaxMbps).toBeGreaterThan(geometry.peakMbps);
  });

  it('reports the mean and places the average line between the extremes', () => {
    const geometry = buildBandwidthGeometry(makeSamples([0, 10]), options);
    expect(geometry.averageMbps).toBeCloseTo(5, 6);
    expect(geometry.averageY).toBeGreaterThan(geometry.plotTop);
    expect(geometry.averageY).toBeLessThan(geometry.plotTop + geometry.plotHeight);
  });

  it('closes the area path down to the baseline', () => {
    const geometry = buildBandwidthGeometry(makeSamples([1, 5, 3]), options);
    const baseline = geometry.plotTop + geometry.plotHeight;
    expect(geometry.areaPath.startsWith(geometry.linePath)).toBe(true);
    expect(geometry.areaPath.endsWith('Z')).toBe(true);
    expect(geometry.areaPath).toContain(String(baseline));
  });

  it('provides axis ticks and degrades safely without samples', () => {
    const geometry = buildBandwidthGeometry(makeSamples([1, 2, 3, 4]), options);
    expect(geometry.yTicks).toHaveLength(5);
    expect(geometry.yTicks[0].value).toBe(0);
    expect(geometry.yTicks[4].value).toBe(geometry.yMaxMbps);
    expect(geometry.xTicks).toHaveLength(3);

    const empty = buildBandwidthGeometry([], options);
    expect(empty.points).toEqual([]);
    expect(empty.linePath).toBe('');
    expect(empty.areaPath).toBe('');
    expect(empty.averageMbps).toBe(0);
    expect(empty.xTicks).toEqual([]);
  });

  it('never produces NaN coordinates, even for a single sample or a flat zero link', () => {
    for (const samples of [makeSamples([5]), makeSamples([0, 0, 0]), makeSamples([0.0001, 0.0002])]) {
      const geometry = buildBandwidthGeometry(samples, options);
      for (const point of geometry.points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
      expect(Number.isFinite(geometry.averageY)).toBe(true);
    }
  });
});

describe('formatMbps', () => {
  it('keeps precision useful at low rates and readable at high ones', () => {
    expect(formatMbps(0)).toBe('0');
    expect(formatMbps(4.8823)).toBe('4.88');
    // 42.15 is slightly below 42.15 as a double, so it rounds down; assert a
    // value that is unambiguous rather than enshrining float noise.
    expect(formatMbps(42.16)).toBe('42.2');
    expect(formatMbps(1234.5)).toBe('1235');
  });
});

describe('indexFromPointerX', () => {
  const geometry = buildBandwidthGeometry(makeSamples([1, 2, 3, 4, 5]), { width: 600, height: 176 });

  it('picks the nearest sample and clamps outside the plot area', () => {
    const left = geometry.plotLeft;
    const span = geometry.plotWidth;

    expect(indexFromPointerX(left, geometry)).toBe(0);
    expect(indexFromPointerX(left + span / 2, geometry)).toBe(2);
    expect(indexFromPointerX(left + span, geometry)).toBe(4);
    // Pointer outside the plot (over the axis labels, or past the last sample).
    expect(indexFromPointerX(left - 200, geometry)).toBe(0);
    expect(indexFromPointerX(left + span + 400, geometry)).toBe(4);
  });

  it('returns null when there is nothing to hover', () => {
    const empty = buildBandwidthGeometry([], { width: 600, height: 176 });
    expect(indexFromPointerX(100, empty)).toBeNull();
    const single = buildBandwidthGeometry(makeSamples([3]), { width: 600, height: 176 });
    expect(indexFromPointerX(100, single)).toBeNull();
  });
});
