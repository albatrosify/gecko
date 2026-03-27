# Quality Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ffprobe-based stream quality detection with per-channel metadata storage, a `useDetectedQuality` toggle, and configurable label templates that replace unreliable upstream quality labels in channel names.

**Architecture:** Pure quality utilities live in `src/quality.ts` (shared between server and frontend). ffprobe probing lives in `server/quality.ts` (Node.js only). Scan jobs run in-memory in `server.ts` with polling via REST. The computed display name replaces the raw `customName || originalName` in both the Xtream proxy output and the React frontend.

**Tech Stack:** Node.js `child_process.spawn` for ffprobe, MongoDB `$set` for metadata writes, React state + 2s polling interval for progress UI. No new npm packages needed — ffmpeg added to the Alpine Docker image.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Add `DetectedStreamMeta`, update `StreamMapping` + `Playlist` |
| `Dockerfile` | Modify | Add `ffmpeg` Alpine package |
| `src/quality.ts` | Create | Pure shared utilities: `resolutionToLabel`, `stripQualityLabel`, `renderTemplate`, `computeDisplayName` |
| `server/quality.ts` | Create | ffprobe wrapper: `probeStream`, `parseProbeResult` |
| `server.ts` | Modify | Settings endpoints, scan endpoints, wire `computeDisplayName` into proxy |
| `src/api.ts` | Modify | Add `api.settings` and `api.qualityScan` |
| `src/components/index.tsx` | Modify | StreamRow display name, EditorPane quality section, BatchEditorPane scan section, playlist settings format field, global settings format field |

---

## Task 1: Data model — `src/types.ts`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `DetectedStreamMeta` interface and update `StreamMapping` and `Playlist`**

Open `src/types.ts`. After the existing imports (line 1), add the `DetectedStreamMeta` interface, then add the two new fields to `StreamMapping` and one new field to `Playlist`:

```typescript
export interface DetectedStreamMeta {
  resolution?: string;        // e.g. "1920x1080"
  videoCodec?: string;        // e.g. "hevc", "h264", "av1"
  hdr?: string | null;        // "HDR10" | "HLG" | "DV" | "HDR10+" | null (SDR)
  fps?: number;               // e.g. 25, 30, 50, 60
  audioCodec?: string;        // e.g. "aac", "eac3", "truehd", "dts", "ac3"
  audioChannels?: number;     // e.g. 2, 6, 8
  scannedAt?: string;         // ISO timestamp
}
```

In `StreamMapping`, after `regexRenames`:

```typescript
  detectedMeta?: DetectedStreamMeta;
  useDetectedQuality?: boolean;
```

In `Playlist`, after `lastSync`:

```typescript
  qualityLabelFormat?: string;  // e.g. "[{label}]" — per-playlist template
```

- [ ] **Step 2: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors related to these new fields.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add DetectedStreamMeta, useDetectedQuality, qualityLabelFormat types"
```

---

## Task 2: Dockerfile — add ffmpeg

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add ffmpeg to the Alpine image**

In `Dockerfile`, after the `WORKDIR /app` line, add:

```dockerfile
RUN apk add --no-cache ffmpeg
```

The file should look like:

```dockerfile
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY . .
ARG VITE_APP_VERSION=unknown
ENV VITE_APP_VERSION=$VITE_APP_VERSION
RUN npm run build

ENV CACHE_DIR=/app/data/cache

EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add ffmpeg to Docker image for quality scanning"
```

---

## Task 3: Shared quality utilities — `src/quality.ts`

**Files:**
- Create: `src/quality.ts`

- [ ] **Step 1: Create the file with all pure utility functions**

```typescript
import { DetectedStreamMeta, StreamMapping } from './types';

// ── Resolution → human label ──────────────────────────────────────────────────

export function resolutionToLabel(resolution: string): string {
  const match = resolution.match(/\d+x(\d+)/i);
  if (!match) return '';
  const h = parseInt(match[1], 10);
  if (h <= 480) return 'SD';
  if (h <= 720) return 'HD';
  if (h <= 1080) return 'FHD';
  if (h <= 1440) return 'QHD';
  if (h <= 2160) return 'UHD';
  return '8K';
}

// ── Codec display labels ───────────────────────────────────────────────────────

const VIDEO_CODEC_LABELS: Record<string, string> = {
  hevc: 'H.265', h265: 'H.265', h264: 'H.264', avc: 'H.264', av1: 'AV1', vp9: 'VP9',
};

const AUDIO_CODEC_LABELS: Record<string, string> = {
  eac3: 'DD+', ac3: 'DD', truehd: 'TrueHD', dts: 'DTS', aac: 'AAC', mp3: 'MP3', opus: 'Opus',
};

const CHANNEL_COUNT_LABELS: Record<number, string> = {
  1: 'Mono', 2: '2.0', 6: '5.1', 8: '7.1',
};

// ── Template rendering ─────────────────────────────────────────────────────────

/**
 * Replace template variables with values from detected metadata.
 * Unknown/empty variables render as empty string.
 * Empty bracket pairs like "[]" or "()" are removed automatically.
 *
 * Available variables: {label} {res} {codec} {hdr} {audio} {fps}
 */
export function renderTemplate(format: string, meta: DetectedStreamMeta): string {
  const label = meta.resolution ? resolutionToLabel(meta.resolution) : '';
  const codec = meta.videoCodec
    ? (VIDEO_CODEC_LABELS[meta.videoCodec.toLowerCase()] ?? meta.videoCodec.toUpperCase())
    : '';
  const hdr = meta.hdr ?? '';
  const fps = meta.fps != null ? String(meta.fps) : '';

  const audioCodecLabel = meta.audioCodec
    ? (AUDIO_CODEC_LABELS[meta.audioCodec.toLowerCase()] ?? meta.audioCodec.toUpperCase())
    : '';
  const channelLabel = meta.audioChannels != null
    ? (CHANNEL_COUNT_LABELS[meta.audioChannels] ?? String(meta.audioChannels))
    : '';
  const audio = [audioCodecLabel, channelLabel].filter(Boolean).join(' ');

  let result = format
    .replace(/\{label\}/g, label)
    .replace(/\{res\}/g, meta.resolution ?? '')
    .replace(/\{codec\}/g, codec)
    .replace(/\{hdr\}/g, hdr)
    .replace(/\{audio\}/g, audio)
    .replace(/\{fps\}/g, fps);

  // Remove empty bracket / paren pairs that result from missing variables
  result = result.replace(/\[\s*\]/g, '').replace(/\(\s*\)/g, '');
  // Collapse multiple whitespace
  result = result.replace(/\s{2,}/g, ' ').trim();

  return result;
}

// ── Strip existing quality tokens from a name ─────────────────────────────────

const QUALITY_STRIP_RE =
  /[\s\-_(]*(8K|UHD|4K|2160p|QHD|1440p|FHD|1080p|HD|720p|SD|480p|RAW)[\s\-_).)]*/gi;

export function stripQualityLabel(name: string): string {
  return name.replace(QUALITY_STRIP_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ── Compute final display name ─────────────────────────────────────────────────

/**
 * Returns the channel name to display/proxy.
 * - If useDetectedQuality is false, or no detectedMeta.resolution: return base name unchanged.
 * - Otherwise: strip any existing quality label from base, append rendered template suffix.
 */
export function computeDisplayName(
  mapping: Pick<StreamMapping, 'customName' | 'originalName' | 'detectedMeta' | 'useDetectedQuality'>,
  playlistFormat?: string | null,
  globalFormat?: string | null
): string {
  const base = mapping.customName || mapping.originalName;
  if (!mapping.useDetectedQuality || !mapping.detectedMeta?.resolution) return base;
  const format = playlistFormat ?? globalFormat ?? '[{label}]';
  const suffix = renderTemplate(format, mapping.detectedMeta);
  return suffix ? stripQualityLabel(base) + ' ' + suffix : base;
}
```

- [ ] **Step 2: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/quality.ts
git commit -m "feat: add shared quality label utilities (computeDisplayName, renderTemplate, stripQualityLabel)"
```

---

## Task 4: ffprobe wrapper — `server/quality.ts`

**Files:**
- Create: `server/quality.ts`

- [ ] **Step 1: Create the ffprobe probe function**

```typescript
import { spawn } from 'child_process';
import { DetectedStreamMeta } from '../src/types.ts';

/**
 * Run ffprobe against a stream URL and return parsed metadata.
 * Rejects if ffprobe exits non-zero, stdout is empty, or timeout is hit.
 */
export async function probeStream(
  url: string,
  timeoutMs = 8000
): Promise<DetectedStreamMeta> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Proxy/1.0',
      url,
    ];

    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffprobe timeout'));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 300)}`));
      }
      try {
        const data = JSON.parse(stdout);
        resolve(parseProbeResult(data));
      } catch {
        reject(new Error('Failed to parse ffprobe JSON output'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffprobe spawn error: ${err.message}`));
    });
  });
}

function parseProbeResult(data: { streams?: any[] }): DetectedStreamMeta {
  const videoStream = data.streams?.find((s) => s.codec_type === 'video');
  const audioStream = data.streams?.find((s) => s.codec_type === 'audio');
  const meta: DetectedStreamMeta = {};

  if (videoStream) {
    const { width: w, height: h } = videoStream;
    if (w && h) meta.resolution = `${w}x${h}`;

    const cn: string = (videoStream.codec_name ?? '').toLowerCase();
    if (cn) meta.videoCodec = cn;

    // HDR detection via color_transfer and side_data
    const ct: string = videoStream.color_transfer ?? '';
    const sideData: any[] = videoStream.side_data_list ?? [];
    const hasDovi = sideData.some((sd) =>
      (sd.side_data_type ?? '').toLowerCase().includes('dovi')
    );
    const hasHdr10Plus = sideData.some((sd) =>
      (sd.side_data_type ?? '').toLowerCase().includes('hdr10+')
    );

    if (hasDovi) meta.hdr = 'DV';
    else if (hasHdr10Plus) meta.hdr = 'HDR10+';
    else if (ct === 'smpte2084') meta.hdr = 'HDR10';
    else if (ct === 'arib-std-b67') meta.hdr = 'HLG';
    else meta.hdr = null;

    // Frame rate — prefer r_frame_rate, fall back to avg_frame_rate
    const fpsStr: string = videoStream.r_frame_rate || videoStream.avg_frame_rate || '';
    if (fpsStr && fpsStr !== '0/0') {
      const parts = fpsStr.split('/').map(Number);
      if (parts.length === 2 && parts[1] > 0) {
        meta.fps = Math.round(parts[0] / parts[1]);
      }
    }
  }

  if (audioStream) {
    const ac: string = (audioStream.codec_name ?? '').toLowerCase();
    if (ac) meta.audioCodec = ac;
    if (audioStream.channels != null) meta.audioChannels = audioStream.channels;
  }

  return meta;
}
```

- [ ] **Step 2: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add server/quality.ts
git commit -m "feat: add ffprobe stream probe utility"
```

---

## Task 5: Settings endpoint — `server.ts`

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add import for quality utilities at the top of `server.ts`**

After the existing imports (around line 14), add:

```typescript
import { computeDisplayName } from './src/quality.ts';
import { probeStream } from './server/quality.ts';
```

- [ ] **Step 2: Add GET and PATCH `/api/settings` endpoints**

Find the section comment `// CRUD: Mappings` (around line 868 in `server.ts`). Just before it, add the settings endpoints:

```typescript
    // =====================================
    // Settings
    // =====================================
    app.get("/api/settings", requireAuth, async (_req, res) => {
      const db = getDb();
      const doc = await db.collection('settings').findOne({ _id: 'global' as any });
      res.json({
        qualityLabelFormat: doc?.qualityLabelFormat ?? '[{label}]',
      });
    });

    app.patch("/api/settings", requireAuth, async (req: AuthRequest, res) => {
      const db = getDb();
      const { qualityLabelFormat } = req.body;
      await db.collection('settings').updateOne(
        { _id: 'global' as any },
        { $set: { qualityLabelFormat } },
        { upsert: true }
      );
      res.json({ success: true });
    });
```

- [ ] **Step 3: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat: add GET/PATCH /api/settings endpoint for qualityLabelFormat"
```

---

## Task 6: Quality scan endpoints — `server.ts`

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add the in-memory job store and type after the `activeCrons` Map**

Find the `const activeCrons` line (around line 297). After it, add:

```typescript
// ── Quality Scan Jobs ──────────────────────────────────────────────────────────
interface ScanJob {
  id: string;
  status: 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  results: { streamId: string; meta?: any; error?: string }[];
}
const scanJobs = new Map<string, ScanJob>();
```

- [ ] **Step 2: Add helper to build the stream URL from a source doc**

Right after the `scanJobs` Map, add:

```typescript
function buildStreamUrl(sourceDoc: any, streamId: string, type: 'live' | 'vod' | 'series'): string {
  const cl = new XtreamClient(sourceDoc as any);
  if (type === 'live') return cl.getLiveStreamUrl(streamId);
  if (type === 'vod') return cl.getVodStreamUrl(streamId);
  return cl.getSeriesStreamUrl(streamId);
}
```

- [ ] **Step 3: Add the three scan endpoints**

Find the settings endpoints added in Task 5 and add these after them, still inside the main server setup function:

```typescript
    // =====================================
    // Quality Scan
    // =====================================
    app.post("/api/quality-scan", requireAuth, async (req: AuthRequest, res) => {
      const { playlistId, streamIds, type, concurrency = 1 } = req.body as {
        playlistId: string;
        streamIds: string[];
        type: 'live' | 'vod' | 'series';
        concurrency?: number;
      };

      if (!playlistId || !streamIds?.length || !type) {
        return res.status(400).json({ error: 'playlistId, streamIds, and type are required' });
      }

      const db = getDb();
      const playlistDoc = await db.collection('playlists').findOne({
        _id: toId(playlistId),
        userId: req.user!.id,
      });
      if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

      const sourceIds: string[] = playlistDoc.sourceIds || [];
      const sourceDocs = await Promise.all(
        sourceIds.map((sid) => db.collection('sources').findOne({ _id: toId(sid) }))
      );
      const validSources = sourceDocs.filter(Boolean);
      if (!validSources.length) return res.status(400).json({ error: 'No sources found for playlist' });

      const jobId = Math.random().toString(36).slice(2);
      const job: ScanJob = {
        id: jobId,
        status: 'running',
        total: streamIds.length,
        done: 0,
        failed: 0,
        results: [],
      };
      scanJobs.set(jobId, job);
      res.json({ jobId });

      // Run in background — do not await
      (async () => {
        const cap = Math.max(1, Math.min(5, concurrency));

        for (let i = 0; i < streamIds.length; i += cap) {
          if (job.status === 'cancelled') break;
          const batch = streamIds.slice(i, i + cap);

          await Promise.all(batch.map(async (streamId) => {
            if (job.status === 'cancelled') return;

            let meta: any = null;
            let lastError = '';

            // Try each source until one works
            for (const sourceDoc of validSources) {
              try {
                const url = buildStreamUrl(sourceDoc, streamId, type);
                meta = await probeStream(url);
                break;
              } catch (e: any) {
                lastError = e.message;
              }
            }

            if (meta) {
              meta.scannedAt = new Date().toISOString();
              // Upsert detectedMeta into the mapping for this stream
              const existing = await db.collection('mappings').findOne({
                playlistId,
                originalId: streamId,
                type,
              });
              if (existing) {
                await db.collection('mappings').updateOne(
                  { _id: existing._id },
                  { $set: { detectedMeta: meta } }
                );
              } else {
                // No mapping yet — create one to store the metadata
                await db.collection('mappings').insertOne({
                  playlistId,
                  originalId: streamId,
                  type,
                  originalName: streamId,
                  customName: '',
                  order: 0,
                  hidden: false,
                  categoryId: '',
                  detectedMeta: meta,
                });
              }
              job.results.push({ streamId, meta });
            } else {
              job.results.push({ streamId, error: lastError || 'All sources failed' });
              job.failed++;
            }
            job.done++;
          }));
        }

        if (job.status !== 'cancelled') job.status = 'done';
        // Auto-clean job after 10 minutes
        setTimeout(() => scanJobs.delete(jobId), 10 * 60 * 1000);
      })().catch((e) => {
        log(`[QualityScan] Job ${jobId} crashed: ${e.message}`);
        job.status = 'done';
      });
    });

    app.get("/api/quality-scan/:jobId", requireAuth, (req, res) => {
      const job = scanJobs.get(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json(job);
    });

    app.delete("/api/quality-scan/:jobId", requireAuth, (req, res) => {
      const job = scanJobs.get(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      job.status = 'cancelled';
      res.json({ success: true });
    });
```

- [ ] **Step 4: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: add quality scan job endpoints (POST/GET/DELETE /api/quality-scan)"
```

---

## Task 7: Wire `computeDisplayName` into Xtream proxy — `server.ts`

**Files:**
- Modify: `server.ts`

The proxy currently sets channel names on line ~1451:

```typescript
if (mapping?.customName) s.name = applyRegex(mapping.customName, mapping.regexRenames || []);
```

This needs to use `computeDisplayName` so that the quality suffix appears for downstream IPTV clients.

- [ ] **Step 1: Add global settings loader helper**

Inside `startServer()`, just before the Xtream proxy section (find the comment `// Xtream Codes Proxy API`), add:

```typescript
    async function getGlobalQualityFormat(): Promise<string> {
      const db = getDb();
      const doc = await db.collection('settings').findOne({ _id: 'global' as any });
      return doc?.qualityLabelFormat ?? '[{label}]';
    }
```

- [ ] **Step 2: Update `get_live_streams` name resolution**

Find this block in the `get_live_streams` case (around line 1451):

```typescript
              if (mapping?.customName) s.name = applyRegex(mapping.customName, mapping.regexRenames || []);
```

Replace it with:

```typescript
              const globalFmt = await getGlobalQualityFormat();
              const displayName = computeDisplayName(
                {
                  customName: mapping?.customName || '',
                  originalName: s.name || '',
                  detectedMeta: mapping?.detectedMeta,
                  useDetectedQuality: mapping?.useDetectedQuality,
                },
                (playlist as any).qualityLabelFormat,
                globalFmt
              );
              s.name = applyRegex(displayName, mapping?.regexRenames || []);
```

- [ ] **Step 3: Update `get_vod_streams` name resolution**

Find the equivalent block in `get_vod_streams` case. It looks like:

```typescript
              if (mapping?.customName) s.name = applyRegex(mapping.customName, mapping.regexRenames || []);
```

Apply the same replacement as Step 2 (replace the `if (mapping?.customName) s.name = ...` line).

- [ ] **Step 4: Update `get_series` name resolution**

Find and apply the same replacement in the `get_series` case.

- [ ] **Step 5: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat: apply computeDisplayName in Xtream proxy output for all stream types"
```

---

## Task 8: Frontend API — `src/api.ts`

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1: Add `settings` and `qualityScan` API objects**

Before the final `const api = { ... }` line (line 271), add:

```typescript
// Settings
export const settings = {
  async get(): Promise<{ qualityLabelFormat: string }> {
    return request('/api/settings');
  },
  async update(data: { qualityLabelFormat: string }) {
    return request<{ success: boolean }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
};

// Quality Scan
export const qualityScan = {
  async start(body: {
    playlistId: string;
    streamIds: string[];
    type: 'live' | 'vod' | 'series';
    concurrency?: number;
  }): Promise<{ jobId: string }> {
    return request('/api/quality-scan', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async status(jobId: string): Promise<{
    id: string;
    status: 'running' | 'done' | 'cancelled';
    total: number;
    done: number;
    failed: number;
    results: { streamId: string; meta?: any; error?: string }[];
  }> {
    return request(`/api/quality-scan/${jobId}`);
  },
  async cancel(jobId: string): Promise<{ success: boolean }> {
    return request(`/api/quality-scan/${jobId}`, { method: 'DELETE' });
  },
};
```

Update the final export line to include the new objects:

```typescript
const api = { auth, sources, epgs, playlists, mappings, categoryMappings, upstream, proxy, admin, system, settings, qualityScan };
```

- [ ] **Step 2: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat: add api.settings and api.qualityScan client methods"
```

---

## Task 9: Wire `computeDisplayName` into `StreamRow` — `src/components/index.tsx`

**Files:**
- Modify: `src/components/index.tsx`

The `PlaylistEditor` component needs the global quality format setting. The `StreamRow` component (around line 3112) needs to call `computeDisplayName`.

- [ ] **Step 1: Add `computeDisplayName` import**

At the top of `src/components/index.tsx`, after the existing imports, add:

```typescript
import { computeDisplayName } from '../quality';
```

- [ ] **Step 2: Add `globalQualityFormat` state to `PlaylistEditor`**

In `PlaylistEditor`, after the existing state declarations (after `lastSelectedStreamId` state, around line 1592), add:

```typescript
  const [globalQualityFormat, setGlobalQualityFormat] = useState<string>('[{label}]');
```

- [ ] **Step 3: Fetch global quality format on mount**

In `PlaylistEditor`, after the `loadPlaylistData` useEffect (around line 1614), add:

```typescript
  useEffect(() => {
    api.settings.get().then(s => setGlobalQualityFormat(s.qualityLabelFormat)).catch(() => {});
  }, []);
```

- [ ] **Step 4: Pass `globalQualityFormat` and `playlist` down to `StreamList`**

Find where `<StreamList>` is rendered (around line 2497–2506). It currently receives props like `streams`, `mappings`, etc. Add two more props:

```typescript
                  globalQualityFormat={globalQualityFormat}
                  playlistQualityFormat={playlist?.qualityLabelFormat}
```

- [ ] **Step 5: Add the new props to `StreamList`'s prop types and pass to `StreamRow`**

Find the `StreamList` function definition. It receives props destructured — add `globalQualityFormat` and `playlistQualityFormat` to both the destructuring and the prop type annotation. Then when rendering `<StreamRowMemo>`, add:

```typescript
                  globalQualityFormat={globalQualityFormat}
                  playlistQualityFormat={playlistQualityFormat}
```

- [ ] **Step 6: Update `StreamRow` to use `computeDisplayName`**

Find `StreamRow` (around line 3107). It currently has:

```typescript
  const displayName = applyRegex(mapping?.customName || originalName, mapping?.regexRenames || []);
```

Replace with:

```typescript
  const displayName = applyRegex(
    computeDisplayName(
      {
        customName: mapping?.customName || '',
        originalName,
        detectedMeta: mapping?.detectedMeta,
        useDetectedQuality: mapping?.useDetectedQuality,
      },
      playlistQualityFormat,
      globalQualityFormat
    ),
    mapping?.regexRenames || []
  );
```

Also add `globalQualityFormat` and `playlistQualityFormat` to `StreamRow`'s prop types (they are `string | undefined`).

- [ ] **Step 7: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: wire computeDisplayName into StreamRow for quality label display"
```

---

## Task 10: EditorPane — quality section — `src/components/index.tsx`

**Files:**
- Modify: `src/components/index.tsx`

- [ ] **Step 1: Add `Scan` icon import**

In the lucide-react import block at the top, add `ScanLine` to the existing list:

```typescript
  ScanLine,
```

- [ ] **Step 2: Add quality section state to `EditorPane`**

In `EditorPane` (around line 3309, after `const [showTechInfo, setShowTechInfo] = useState(false)`), add:

```typescript
  const [useDetectedQuality, setUseDetectedQuality] = useState(mapping?.useDetectedQuality ?? false);
  const [scanningThis, setScanningThis] = useState(false);
  const [scanError, setScanError] = useState('');
```

- [ ] **Step 3: Sync toggle state when mapping changes**

In the existing `useEffect` that syncs mapping state (around line 3363–3369), add:

```typescript
    setUseDetectedQuality(mapping?.useDetectedQuality ?? false);
```

- [ ] **Step 4: Add toggle save handler**

After `const handleSave = async () => { ... }` in `EditorPane`, add:

```typescript
  const handleToggleDetectedQuality = async (value: boolean) => {
    setUseDetectedQuality(value);
    try {
      if (mapping?.id) {
        await api.mappings.update(mapping.id, { useDetectedQuality: value });
      } else {
        await api.mappings.batchUpdate([{
          originalId: stream._uniqueId,
          playlistId,
          type,
          originalName: stream.name || stream.title || '',
          customName: stream.name || stream.title || '',
          order: 0,
          hidden: false,
          categoryId: String(stream.category_id || ''),
          useDetectedQuality: value,
        }]);
      }
      onUpdate();
    } catch {
      setUseDetectedQuality(!value); // revert on error
    }
  };
```

- [ ] **Step 5: Add single-channel scan handler**

After `handleToggleDetectedQuality`, add:

```typescript
  const handleScanThis = async () => {
    setScanningThis(true);
    setScanError('');
    try {
      const { jobId } = await api.qualityScan.start({
        playlistId,
        streamIds: [stream._uniqueId],
        type: type as 'live' | 'vod' | 'series',
        concurrency: 1,
      });
      // Poll until done
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(async () => {
          try {
            const job = await api.qualityScan.status(jobId);
            if (job.status !== 'running') {
              clearInterval(interval);
              resolve();
            }
          } catch (e) {
            clearInterval(interval);
            reject(e);
          }
        }, 1500);
      });
      onUpdate();
    } catch (e: any) {
      setScanError(e.message || 'Scan failed');
    } finally {
      setScanningThis(false);
    }
  };
```

- [ ] **Step 6: Add the quality section JSX**

In `EditorPane`'s JSX, find the section that renders the custom name input. After the custom name section and before the EPG section, insert:

```tsx
        {/* ── Detected Quality ──────────────────────────────────────── */}
        <div className="space-y-3 pt-4 border-t border-zinc-800">
          <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2">
            <ScanLine size={12} /> Detected Quality
          </div>

          {mapping?.detectedMeta ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {mapping.detectedMeta.resolution && (
                  <span className="px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-lg text-[11px] font-bold">
                    {mapping.detectedMeta.resolution}
                  </span>
                )}
                {mapping.detectedMeta.videoCodec && (
                  <span className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 text-zinc-300 rounded-lg text-[11px] font-mono">
                    {mapping.detectedMeta.videoCodec.toUpperCase()}
                  </span>
                )}
                {mapping.detectedMeta.hdr && (
                  <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-lg text-[11px] font-bold">
                    {mapping.detectedMeta.hdr}
                  </span>
                )}
                {mapping.detectedMeta.fps && (
                  <span className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 text-zinc-300 rounded-lg text-[11px] font-mono">
                    {mapping.detectedMeta.fps}fps
                  </span>
                )}
                {mapping.detectedMeta.audioCodec && (
                  <span className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 text-zinc-300 rounded-lg text-[11px] font-mono">
                    {mapping.detectedMeta.audioCodec.toUpperCase()}
                    {mapping.detectedMeta.audioChannels ? ` ${mapping.detectedMeta.audioChannels}ch` : ''}
                  </span>
                )}
              </div>
              <label className="flex items-center justify-between cursor-pointer select-none p-3 bg-zinc-950/50 border border-zinc-800/50 rounded-xl hover:border-zinc-700 transition-all">
                <div>
                  <div className="text-sm font-bold text-zinc-200">Show in channel name</div>
                  {mapping.detectedMeta.resolution && (
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      Preview: "{computeDisplayName(
                        { customName: mapping.customName || '', originalName: stream.name || stream.title || '', detectedMeta: mapping.detectedMeta, useDetectedQuality: true },
                        undefined,
                        '[{label}]'
                      )}"
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleToggleDetectedQuality(!useDetectedQuality)}
                  className={cn(
                    "relative w-10 h-5 rounded-full transition-all",
                    useDetectedQuality ? "bg-emerald-500" : "bg-zinc-700"
                  )}
                >
                  <div className={cn(
                    "absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all",
                    useDetectedQuality ? "left-5" : "left-0.5"
                  )} />
                </button>
              </label>
              {mapping.detectedMeta.scannedAt && (
                <div className="text-[10px] text-zinc-600">
                  Scanned {new Date(mapping.detectedMeta.scannedAt).toLocaleDateString()}
                  {' · '}
                  <button
                    onClick={handleScanThis}
                    disabled={scanningThis}
                    className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
                  >
                    {scanningThis ? 'Scanning…' : 'Re-scan'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between p-3 bg-zinc-950/50 border border-zinc-800/50 rounded-xl">
              <span className="text-xs text-zinc-500 italic">Not scanned yet</span>
              <button
                onClick={handleScanThis}
                disabled={scanningThis}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
              >
                <ScanLine size={12} />
                {scanningThis ? 'Scanning…' : 'Scan this channel'}
              </button>
            </div>
          )}
          {scanError && (
            <p className="text-xs text-red-400">{scanError}</p>
          )}
        </div>
```

- [ ] **Step 7: Add `computeDisplayName` import to the component**

This was already done in Task 9 Step 1. Confirm it is present.

- [ ] **Step 8: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: add detected quality section to EditorPane with toggle and single-channel scan"
```

---

## Task 11: BatchEditorPane — quality scan section — `src/components/index.tsx`

**Files:**
- Modify: `src/components/index.tsx`

- [ ] **Step 1: Add scan state to `BatchEditorPane`**

`BatchEditorPane` is a function component starting around line 2552. It receives `onApply`, `onVisibilityToggle`, `onMove`, `onMoveToTop`, `onClose`, `categories`, `selectedCategoryIds`, `selectedStreamIds`.

Add a new prop `onScanComplete` and update the prop type:

```typescript
  onScanComplete: () => void;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  allStreams: any[];
```

Inside `BatchEditorPane`, after the existing state declarations (`rules`, `scope`, `targetCategoryId`), add:

```typescript
  const [scanConcurrency, setScanConcurrency] = useState(1);
  const [skipScanned, setSkipScanned] = useState(true);
  const [scanJobId, setScanJobId] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<{ status: string; total: number; done: number; failed: number } | null>(null);
  const [scanError, setScanError] = useState('');
```

- [ ] **Step 2: Add polling effect**

After the existing `useEffect` that auto-switches scope, add:

```typescript
  useEffect(() => {
    if (!scanJobId) return;
    const interval = setInterval(async () => {
      try {
        const job = await api.qualityScan.status(scanJobId);
        setScanJob({ status: job.status, total: job.total, done: job.done, failed: job.failed });
        if (job.status !== 'running') {
          clearInterval(interval);
          if (job.status === 'done') onScanComplete();
        }
      } catch {
        clearInterval(interval);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [scanJobId]);
```

- [ ] **Step 3: Add scan start handler**

After the polling effect, add:

```typescript
  const handleStartScan = async () => {
    setScanError('');
    let targetStreams: any[] = [];
    if (scope === 'all') targetStreams = allStreams;
    else if (scope === 'categories') targetStreams = allStreams.filter(s => selectedCategoryIds.has(String(s.category_id)));
    else targetStreams = allStreams.filter(s => selectedStreamIds.has(String(s._uniqueId)));

    if (skipScanned) {
      // filter out streams that already have detectedMeta (passed via allStreams enriched with mappings)
      targetStreams = targetStreams.filter(s => !s._detectedMeta);
    }

    if (!targetStreams.length) { setScanError('No streams to scan in current scope.'); return; }

    try {
      const { jobId } = await api.qualityScan.start({
        playlistId,
        streamIds: targetStreams.map(s => String(s._uniqueId)),
        type,
        concurrency: scanConcurrency,
      });
      setScanJobId(jobId);
      setScanJob({ status: 'running', total: targetStreams.length, done: 0, failed: 0 });
    } catch (e: any) {
      setScanError(e.message || 'Failed to start scan');
    }
  };

  const handleCancelScan = async () => {
    if (!scanJobId) return;
    await api.qualityScan.cancel(scanJobId).catch(() => {});
    setScanJob(prev => prev ? { ...prev, status: 'cancelled' } : null);
    setScanJobId(null);
  };
```

- [ ] **Step 4: Add the scan section JSX inside `BatchEditorPane`'s return**

At the bottom of the scrollable content area in `BatchEditorPane` (after the last `<div className="h-px w-full bg-zinc-800/50" />` and the regex section), add:

```tsx
        <div className="h-px w-full bg-zinc-800/50" />

        {/* Quality Scan */}
        <div className="space-y-3">
          <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2">
            <ScanLine size={12} /> Quality Scan
          </div>

          <div className="space-y-2">
            <label className="flex items-center justify-between text-xs text-zinc-400">
              <span>Concurrency</span>
              <select
                value={scanConcurrency}
                onChange={e => setScanConcurrency(Number(e.target.value))}
                disabled={scanJob?.status === 'running'}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none"
              >
                {[1, 2, 3, 4, 5].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={skipScanned}
                onChange={e => setSkipScanned(e.target.checked)}
                disabled={scanJob?.status === 'running'}
                className="w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-900 text-emerald-500"
              />
              Skip already scanned
            </label>
          </div>

          {scanJob ? (
            <div className="space-y-2">
              <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-500"
                  style={{ width: `${scanJob.total > 0 ? Math.round((scanJob.done / scanJob.total) * 100) : 0}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-500">
                <span>✓ {scanJob.done - scanJob.failed}  ✗ {scanJob.failed}  /  {scanJob.total}</span>
                <span className={cn(
                  "font-bold uppercase tracking-widest",
                  scanJob.status === 'done' ? 'text-emerald-500' :
                  scanJob.status === 'cancelled' ? 'text-zinc-500' : 'text-amber-500 animate-pulse'
                )}>
                  {scanJob.status}
                </span>
              </div>
              {scanJob.status === 'running' && (
                <button
                  onClick={handleCancelScan}
                  className="w-full py-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl text-xs font-bold hover:bg-red-500/20 transition-all"
                >
                  Cancel Scan
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={handleStartScan}
              className="w-full flex justify-center items-center gap-2 py-2.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-xl text-xs font-bold hover:bg-blue-500/20 transition-all hover:-translate-y-0.5"
            >
              <ScanLine size={14} />
              Start Quality Scan
            </button>
          )}
          {scanError && <p className="text-xs text-red-400">{scanError}</p>}
        </div>
```

- [ ] **Step 5: Pass new props from `PlaylistEditor` to `BatchEditorPane`**

In `PlaylistEditor` where `<BatchEditorPane>` is rendered (around line 2510), add the new required props:

```tsx
                  onScanComplete={refreshMappings}
                  playlistId={id!}
                  type={activeTab}
                  allStreams={sortedStreams.map(s => ({
                    ...s,
                    _detectedMeta: mappings.find(m => m.originalId === s._uniqueId && m.type === activeTab)?.detectedMeta,
                  }))}
```

- [ ] **Step 6: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: add quality scan section to BatchEditorPane with progress tracking"
```

---

## Task 12: Playlist settings modal — quality format field — `src/components/index.tsx`

**Files:**
- Modify: `src/components/index.tsx`

- [ ] **Step 1: Add `qualityLabelFormat` to the edit modal state**

Find where `editData` is initialized in `PlaylistManager` (the object spread with `name`, `username`, `password`, `epgIds`, etc., around line 440–450). Add `qualityLabelFormat` to the initial state:

```typescript
  qualityLabelFormat: editingPlaylist?.qualityLabelFormat ?? '',
```

- [ ] **Step 2: Add the format input to the edit modal JSX**

In the "Edit Playlist Settings" modal (around line 654), after the EPG sources section and before the closing `</div>` / buttons, add:

```tsx
              <div className="pt-4 border-t border-zinc-800 space-y-2">
                <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
                  Quality Label Format
                </label>
                <input
                  placeholder="e.g. [{label}] — leave empty to use global default"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-sm font-mono focus:border-emerald-500 outline-none transition-all"
                  value={editData.qualityLabelFormat}
                  onChange={e => setEditData({ ...editData, qualityLabelFormat: e.target.value })}
                />
                <p className="text-[10px] text-zinc-600">
                  Variables: <span className="font-mono text-zinc-500">{'{label}'} {'{res}'} {'{codec}'} {'{hdr}'} {'{audio}'} {'{fps}'}</span>
                </p>
                {editData.qualityLabelFormat && (
                  <p className="text-[10px] text-emerald-500/70 font-mono">
                    Preview: "Channel Name {editData.qualityLabelFormat.replace('{label}', 'FHD').replace('{hdr}', 'HDR10').replace(/\{[^}]+\}/g, '')}"
                  </p>
                )}
              </div>
```

- [ ] **Step 3: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: add qualityLabelFormat field to playlist settings modal"
```

---

## Task 13: Global Settings page — quality format field — `src/components/index.tsx`

**Files:**
- Modify: `src/components/index.tsx`

- [ ] **Step 1: Add state and fetch to the `Settings` component**

In `Settings` (around line 1441), after `const [logs, setLogs] = useState(...)`, add:

```typescript
  const [qualityFormat, setQualityFormat] = useState('[{label}]');
  const [qualityFormatSaved, setQualityFormatSaved] = useState(false);

  useEffect(() => {
    api.settings.get().then(s => setQualityFormat(s.qualityLabelFormat)).catch(() => {});
  }, []);

  const handleSaveQualityFormat = async () => {
    try {
      await api.settings.update({ qualityLabelFormat: qualityFormat });
      setQualityFormatSaved(true);
      setTimeout(() => setQualityFormatSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save quality format', e);
    }
  };
```

- [ ] **Step 2: Add the format card to Settings JSX**

In the `Settings` component's JSX, inside the left column (after the "User Profile" card and before the "Danger Zone" card, around line 1494), add:

```tsx
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 space-y-4">
            <div className="space-y-1">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <ScanLine size={18} className="text-blue-400" />
                Quality Labels
              </h3>
              <p className="text-xs text-zinc-500">Default template for quality labels in channel names.</p>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Format Template</label>
              <input
                value={qualityFormat}
                onChange={e => setQualityFormat(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-sm font-mono focus:border-emerald-500 outline-none transition-all"
                placeholder="[{label}]"
              />
              <p className="text-[10px] text-zinc-600">
                Variables: <span className="font-mono text-zinc-500">{'{label}'} {'{res}'} {'{codec}'} {'{hdr}'} {'{audio}'} {'{fps}'}</span>
              </p>
              <p className="text-[10px] text-zinc-600">
                Example result: <span className="font-mono text-zinc-400">Channel Name [FHD]</span>
              </p>
            </div>
            <button
              onClick={handleSaveQualityFormat}
              className={cn(
                "w-full py-2.5 rounded-xl font-bold text-sm transition-all",
                qualityFormatSaved
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              )}
            >
              {qualityFormatSaved ? '✓ Saved' : 'Save Format'}
            </button>
          </div>
```

- [ ] **Step 3: Verify types compile**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: add quality label format setting to global Settings page"
```

---

## Final Verification

- [ ] **Run full type check**

```bash
cd /Users/marius/Desktop/Projects/open-iptv-editor/.claude/worktrees/adoring-albattani && npm run lint
```

Expected: Exit 0, no errors.

- [ ] **Start dev server and smoke test**

```bash
npm run dev
```

Manual checks:
1. Open Playlist Editor → Channel Tools → verify "Quality Scan" section is visible
2. Select a channel → verify "Detected Quality" section shows "Not scanned yet" with scan button
3. Click "Scan this channel" → verify it polls and shows metadata after ~10s (requires ffmpeg in PATH locally, or test via Docker)
4. Toggle "Show in name" → verify channel name updates in the stream list
5. Open Settings → verify "Quality Labels" card is visible with format input
6. Open Playlist settings → verify "Quality Label Format" field is present

- [ ] **Final commit if any fixups needed**

```bash
git add -p
git commit -m "fix: quality scan integration fixups"
```
