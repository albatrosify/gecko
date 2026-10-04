import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface BandwidthSample {
  time: number;
  bps: number;
}

export interface YTick {
  y: number;
  value: number;
}

export interface XTick {
  x: number;
  label: string;
}

export interface PlottedPoint {
  x: number;
  y: number;
  bps: number;
  time: number;
}

export interface BandwidthGeometry {
  yMaxMbps: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  linePath: string;
  areaPath: string;
  averageMbps: number;
  averageY: number;
  peakMbps: number;
  yTicks: YTick[];
  xTicks: XTick[];
  points: PlottedPoint[];
}

export interface BandwidthGeometryOptions {
  width: number;
  height: number;
}

// Room for the value axis on the left and time labels along the bottom.
const PADDING = { top: 12, right: 12, bottom: 22, left: 46 };

/** Round a peak up to a readable axis maximum, so gridline labels are round numbers. */
export function niceMaxMbps(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalised = value / magnitude;
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
  const step = steps.find((s) => normalised <= s) ?? 10;
  return step * magnitude;
}

const formatClock = (time: number) =>
  new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function formatMbps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

/**
 * Project bandwidth samples into SVG coordinates.
 *
 * Kept pure and separate from the component so the geometry can be unit tested and
 * rendered standalone — a chart is easy to get subtly wrong (off-by-one in the time
 * axis, a peak that clips the frame) and hard to notice by eye.
 */
export function buildBandwidthGeometry(
  samples: BandwidthSample[],
  options: BandwidthGeometryOptions,
): BandwidthGeometry {
  const { width, height } = options;
  const plotLeft = PADDING.left;
  const plotTop = PADDING.top;
  const plotWidth = Math.max(1, width - PADDING.left - PADDING.right);
  const plotHeight = Math.max(1, height - PADDING.top - PADDING.bottom);

  const mbpsValues = samples.map((s) => s.bps / 1_000_000);
  const peakMbps = mbpsValues.length ? Math.max(...mbpsValues) : 0;
  // A little headroom keeps the peak off the top edge and stops it looking clipped.
  const yMaxMbps = niceMaxMbps(peakMbps * 1.05);
  const averageMbps = mbpsValues.length
    ? mbpsValues.reduce((sum, v) => sum + v, 0) / mbpsValues.length
    : 0;

  const xFor = (index: number) =>
    samples.length > 1 ? plotLeft + (index / (samples.length - 1)) * plotWidth : plotLeft + plotWidth / 2;
  const yFor = (value: number) =>
    // A single decimal place avoids sub-pixel jitter between neighbouring samples.
    Math.round((plotTop + plotHeight - (Math.max(0, value) / yMaxMbps) * plotHeight) * 100) / 100;

  const points: PlottedPoint[] = samples.map((sample, index) => ({
    x: xFor(index),
    y: yFor(sample.bps / 1_000_000),
    bps: sample.bps,
    time: sample.time,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const baseline = plotTop + plotHeight;
  const areaPath = points.length
    ? `${linePath} L${points[points.length - 1].x} ${baseline} L${points[0].x} ${baseline} Z`
    : '';

  const yTicks: YTick[] = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    y: yFor(yMaxMbps * fraction),
    value: yMaxMbps * fraction,
  }));

  const xTicks: XTick[] = [];
  if (points.length > 1) {
    xTicks.push({ x: points[0].x, label: formatClock(points[0].time) });
    const middle = points[Math.floor(points.length / 2)];
    xTicks.push({ x: middle.x, label: formatClock(middle.time) });
    xTicks.push({ x: points[points.length - 1].x, label: formatClock(points[points.length - 1].time) });
  }

  return {
    yMaxMbps,
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    linePath,
    areaPath,
    averageMbps,
    averageY: yFor(averageMbps),
    peakMbps,
    yTicks,
    xTicks,
    points,
  };
}

/**
 * Map a pointer offset inside the chart to the nearest sample index, clamped to the
 * series. Pure so the hover maths can be tested without a DOM.
 */
export function indexFromPointerX(offsetX: number, geometry: BandwidthGeometry): number | null {
  const count = geometry.points.length;
  if (count < 2 || geometry.plotWidth <= 0) return null;
  const ratio = (offsetX - geometry.plotLeft) / geometry.plotWidth;
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
}

/** Slice the retained history to a window, by timestamp rather than by count. */
export function selectWindow(history: BandwidthSample[], windowSeconds: number): BandwidthSample[] {
  if (!history.length) return [];
  const newest = history[history.length - 1].time;
  const cutoff = newest - windowSeconds * 1000;
  return history.filter((sample) => sample.time >= cutoff);
}

interface WindowOption {
  label: string;
  seconds: number;
}

const WINDOWS: WindowOption[] = [
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '10m', seconds: 600 },
];

const CHART_HEIGHT = 176;

export function BandwidthChart({
  history,
  currentBps,
}: {
  history: BandwidthSample[];
  currentBps: number;
}) {
  const [windowSeconds, setWindowSeconds] = useState(300);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [width, setWidth] = useState(600);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured && measured > 0) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const samples = useMemo(() => selectWindow(history, windowSeconds), [history, windowSeconds]);
  const geometry = useMemo(
    () => buildBandwidthGeometry(samples, { width, height: CHART_HEIGHT }),
    [samples, width],
  );

  const onPointerMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      setHoverIndex(indexFromPointerX(event.clientX - event.currentTarget.getBoundingClientRect().left, geometry));
    },
    [geometry],
  );

  const hovered = hoverIndex !== null ? geometry.points[hoverIndex] : undefined;
  const enoughData = geometry.points.length >= 2;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {WINDOWS.map((option) => (
            <button
              key={option.label}
              onClick={() => setWindowSeconds(option.seconds)}
              className={`px-2 py-0.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                windowSeconds === option.seconds
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[11px] tabular-nums">
          <span className="text-zinc-500">
            Avg <span className="text-zinc-200 font-semibold">{formatMbps(geometry.averageMbps)}</span> Mbps
          </span>
          <span className="text-zinc-500">
            Peak <span className="text-zinc-200 font-semibold">{formatMbps(geometry.peakMbps)}</span> Mbps
          </span>
          <span className="text-zinc-500">
            Now <span className="text-emerald-400 font-semibold">{formatMbps(currentBps / 1_000_000)}</span> Mbps
          </span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative w-full"
        style={{ height: CHART_HEIGHT }}
        onMouseMove={onPointerMove}
        onMouseLeave={() => setHoverIndex(null)}
        role="img"
        aria-label={`Bandwidth over the last ${windowSeconds / 60} minutes, average ${formatMbps(geometry.averageMbps)} Mbps and peak ${formatMbps(geometry.peakMbps)} Mbps`}
      >
        {!enoughData ? (
          <div className="h-full flex items-center justify-center text-xs text-zinc-600">
            Collecting samples…
          </div>
        ) : (
          <svg width={width} height={CHART_HEIGHT} className="block text-zinc-500">
            <defs>
              <linearGradient id="bandwidthFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {geometry.yTicks.map((tick) => (
              <g key={`y-${tick.y}`}>
                <line
                  x1={geometry.plotLeft}
                  x2={geometry.plotLeft + geometry.plotWidth}
                  y1={tick.y}
                  y2={tick.y}
                  stroke="rgb(39 39 42)"
                  strokeWidth="1"
                />
                <text x={geometry.plotLeft - 8} y={tick.y + 3} textAnchor="end" fontSize="10" fill="currentColor">
                  {formatMbps(tick.value)}
                </text>
              </g>
            ))}

            {geometry.xTicks.map((tick, index) => (
              <text
                key={`x-${index}`}
                x={tick.x}
                y={CHART_HEIGHT - 6}
                textAnchor={index === 0 ? 'start' : index === geometry.xTicks.length - 1 ? 'end' : 'middle'}
                fontSize="10"
                fill="currentColor"
              >
                {tick.label}
              </text>
            ))}

            <path d={geometry.areaPath} fill="url(#bandwidthFill)" />
            <path
              d={geometry.linePath}
              fill="none"
              stroke="rgb(16 185 129)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {geometry.averageMbps > 0 && (
              <g>
                <line
                  x1={geometry.plotLeft}
                  x2={geometry.plotLeft + geometry.plotWidth}
                  y1={geometry.averageY}
                  y2={geometry.averageY}
                  stroke="rgb(161 161 170)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                  opacity="0.7"
                />
                <text
                  x={geometry.plotLeft + geometry.plotWidth - 2}
                  y={geometry.averageY - 4}
                  textAnchor="end"
                  fontSize="10"
                  fill="rgb(161 161 170)"
                >
                  avg {formatMbps(geometry.averageMbps)}
                </text>
              </g>
            )}

            {hovered && (
              <g>
                <line
                  x1={hovered.x}
                  x2={hovered.x}
                  y1={geometry.plotTop}
                  y2={geometry.plotTop + geometry.plotHeight}
                  stroke="rgb(113 113 122)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                <circle cx={hovered.x} cy={hovered.y} r="3.5" fill="rgb(16 185 129)" stroke="rgb(9 9 11)" strokeWidth="1.5" />
              </g>
            )}
          </svg>
        )}

        {hovered && enoughData && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 text-[11px] shadow-xl tabular-nums"
            style={{
              left: Math.min(Math.max(hovered.x - 56, 0), Math.max(0, width - 118)),
              top: Math.max(0, hovered.y - 46),
            }}
          >
            <div className="text-zinc-400">{formatClock(hovered.time)}</div>
            <div className="text-emerald-400 font-semibold">{formatMbps(hovered.bps / 1_000_000)} Mbps</div>
          </div>
        )}
      </div>
    </div>
  );
}
