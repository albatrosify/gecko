# Quality Scan — Design Spec

**Date:** 2026-03-26
**Status:** Approved

## Overview

Scan selected channels via ffprobe to detect actual stream quality metadata (resolution, codec, HDR, audio). Store the raw metadata per channel mapping. Expose a per-channel toggle to replace/supplement the upstream quality label in the channel name with a configurable template-based label derived from the detected metadata.

---

## Problem

Upstream IPTV providers embed quality labels in channel names (e.g. "RTL HD EXCLUSIVE", "8K LIVE", "raw") that are inconsistent, misleading, or absent. Users cannot trust these labels. The goal is to detect ground truth quality from the stream itself and display it consistently.

---

## Data Model

### `StreamMapping` — new fields (`src/types.ts`)

```typescript
detectedMeta?: {
  resolution?: string;       // "1920x1080" — raw ffprobe output
  videoCodec?: string;       // "hevc", "h264", "av1"
  hdr?: string | null;       // "HDR10" | "HLG" | "DV" | "HDR10+" | null (SDR)
  fps?: number;              // 25, 30, 50, 60
  audioCodec?: string;       // "aac", "eac3", "truehd", "dts", "ac3"
  audioChannels?: number;    // 2, 6, 8
  scannedAt?: string;        // ISO timestamp of last scan
};
useDetectedQuality?: boolean; // Toggle: append detected quality label to channel name
```

### `Playlist` — new field (`src/types.ts`)

```typescript
qualityLabelFormat?: string;  // Per-playlist template, e.g. "[{label}]"
                              // Falls back to global default if unset
```

### Global Settings (`settings` MongoDB collection)

```typescript
qualityLabelFormat: string;   // Default: "[{label}]"
```

### Resolution → Label Mapping (fixed, server + client)

| Height (px) | Label |
|---|---|
| ≤ 480 | `SD` |
| 481–720 | `HD` |
| 721–1080 | `FHD` |
| 1081–1440 | `QHD` |
| 1441–2160 | `UHD` |
| > 2160 | `8K` |

### Template Variables

| Variable | Example | Notes |
|---|---|---|
| `{label}` | `FHD` | Derived from resolution height |
| `{res}` | `1920x1080` | Raw resolution string |
| `{codec}` | `H.265` | Human-readable codec name |
| `{hdr}` | `HDR10` | Empty string if SDR |
| `{audio}` | `DD+ 5.1` | Codec + channel count |
| `{fps}` | `50` | Frame rate |

Variables that have no value are replaced with empty string. Surrounding whitespace/separators are cleaned up automatically (e.g. `[FHD] []` → `[FHD]`).

### Computed Display Name

Applied everywhere the channel name is rendered (proxy output, frontend display):

```typescript
function computeDisplayName(
  mapping: StreamMapping,
  playlistFormat?: string,
  globalFormat?: string
): string {
  const base = mapping.customName || mapping.originalName;
  if (!mapping.useDetectedQuality || !mapping.detectedMeta?.resolution) return base;
  const format = playlistFormat ?? globalFormat ?? "[{label}]";
  const suffix = renderTemplate(format, mapping.detectedMeta);
  return stripExistingQualityLabel(base) + (suffix ? ' ' + suffix : '');
}
```

`stripExistingQualityLabel` removes known quality tokens only when they appear standalone (surrounded by spaces, brackets, or at string boundaries). Conservative — does not strip tokens that are part of other words (e.g. "8K EXCLUSIVE" is left untouched).

---

## Backend

### Scan Job System (`server.ts`)

In-memory job store (Map). Job state is not persisted — scans are idempotent (re-running overwrites `detectedMeta`).

```typescript
interface ScanJob {
  id: string;
  status: 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  results: { streamId: string; meta?: DetectedStreamMeta; error?: string }[];
}

const scanJobs = new Map<string, ScanJob>();
```

### API Endpoints

**`POST /api/quality-scan`** — Start scan
Auth: `requireAuth`

```typescript
Body: {
  playlistId: string;
  streamIds: string[];       // originalIds from mappings
  type: 'live' | 'vod' | 'series';
  concurrency?: number;      // 1–5, default 1
}
Response: { jobId: string }
```

Resolves stream URLs from the upstream source (same logic as stream proxy). Runs ffprobe with concurrency limit. Writes each result to `mappings` collection immediately as it completes. Sets `detectedMeta.scannedAt` on success.

**`GET /api/quality-scan/:jobId`** — Poll progress
Auth: `requireAuth`

```typescript
Response: ScanJob
```

**`DELETE /api/quality-scan/:jobId`** — Cancel job
Auth: `requireAuth`

Sets `status: 'cancelled'`. Any in-flight ffprobe processes are killed. Already-written results are preserved.

### ffprobe Integration

```bash
ffprobe -v quiet -print_format json \
  -show_streams \
  -select_streams v:0 \
  <stream_url>
```

Called via `child_process.spawn` with 8s timeout. Auth headers forwarded from upstream source config.

**HDR Detection logic:**
- `color_transfer === 'smpte2084'` → HDR10
- `color_transfer === 'arib-std-b67'` → HLG
- Side data type `DOVI` → DV (Dolby Vision)
- Side data type `HDR10+` → HDR10+
- Otherwise → null (SDR)

**Audio:** Second ffprobe pass with `-select_streams a:0` for audio codec + channel layout.

### Dockerfile

Add to `node:20-alpine` base:
```dockerfile
RUN apk add --no-cache ffmpeg
```

### `refreshSource()` — unchanged

The `isUnmodified` check (`!m.customName || m.customName === m.originalName`) remains exactly as-is. `detectedMeta` and `useDetectedQuality` are orthogonal to the sync logic — they are never touched by `refreshSource()`.

---

## Frontend

### BatchEditorPane — new "Quality Scan" section

Added below the existing sections. Inherits the current scope selection (All / Selected Categories / Selected Channels).

```
┌─────────────────────────────────────────────┐
│ 📡 QUALITY SCAN                             │
│                                             │
│  Concurrency    [1 ▼]  (1–5)               │
│  Skip scanned   [✓]                         │
│                                             │
│  — idle —                                   │
│                                             │
│  [▶ Start Scan]                             │
└─────────────────────────────────────────────┘
```

While running:

```
│  [████████░░░░░░░]  47 / 200               │
│  ✓ 44  ✗ 3  •  est. 4 min remaining        │
│                                             │
│  [■ Cancel]                                 │
```

On completion: summary toast ("Scanned 197/200 channels, 3 failed").

Polling: every 2 seconds while `status === 'running'`. Stops on `done` or `cancelled`.

### EditorPane — per-channel quality section

New section below the custom name field, shown for all stream types:

```
┌─────────────────────────────────────────────┐
│ DETECTED QUALITY                            │
│                                             │
│  1920×1080 · H.265 · HDR10 · DD+ 5.1 · 50fps│
│                                             │
│  Show in name  ○──●                         │
│  Preview: "RTL [FHD] [HDR10]"               │
└─────────────────────────────────────────────┘
```

If not yet scanned:

```
│  Not scanned yet   [Scan this channel]      │
```

The "Scan this channel" button calls `POST /api/quality-scan` with `streamIds: [thisStreamId]`, `concurrency: 1`, and polls until done, then refreshes the mapping.

Toggle saves immediately via `PATCH /api/mappings/:id` (existing endpoint).

### Playlist Settings — quality label format

New field in the playlist settings panel:

```
Quality Label Format
Template   [{label}]          [input]
Preview    RTL [FHD]
```

Help text lists available variables. Falls back to global default when empty.

### Global Settings

New field in the Settings page:

```
Default Quality Label Format
Template   [{label}]          [input]
Preview    RTL [FHD]
```

### `applyRegex` / `computeDisplayName`

A shared `computeDisplayName` utility function is extracted (used in both `StreamRow` and the Xtream proxy in `server.ts`). Currently `StreamRow` computes the display name inline:

```typescript
// src/components/index.tsx:3112
const displayName = applyRegex(mapping?.customName || originalName, mapping?.regexRenames || []);
```

This becomes:

```typescript
const displayName = applyRegex(
  computeDisplayName(mapping, playlist?.qualityLabelFormat, globalQualityFormat),
  mapping?.regexRenames || []
);
```

The same `computeDisplayName` logic runs server-side in the Xtream proxy when building `get_live_streams` responses.

---

## Scope of Changes

| File | Change |
|---|---|
| `src/types.ts` | Add `detectedMeta`, `useDetectedQuality` to `StreamMapping`; `qualityLabelFormat` to `Playlist` |
| `server.ts` | Add scan endpoints, ffprobe helper, `computeDisplayName` in proxy output |
| `src/components/index.tsx` | Quality scan section in `BatchEditorPane`, quality section in `EditorPane`, format field in playlist settings, `computeDisplayName` in `StreamRow` |
| `src/api.ts` | Add `api.qualityScan.*` methods |
| `Dockerfile` | Add `ffmpeg` apk package |

---

## Out of Scope

- Persisting scan jobs to MongoDB (in-memory is sufficient; scans are idempotent)
- Automatic re-scan on sync (user triggers scans manually)
- Quality-based filtering/sorting in the UI (future feature)
- Series / VOD metadata enrichment beyond what ffprobe returns from stream probe
