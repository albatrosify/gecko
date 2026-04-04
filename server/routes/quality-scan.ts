import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, toId } from "../db.ts";
import { log } from "../logger.ts";
import { scanJobs, ScanJob, buildStreamUrl } from "../quality-scan.ts";
import { getCached } from "../cache.ts";
import { probeStream } from "../quality.ts";

export function createQualityScanRouter() {
  const router = Router();

  // =====================================
  // Quality Scan
  // =====================================
  router.post("/quality-scan", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId, streamIds, type, concurrency = 1 } = req.body as {
      playlistId: string;
      streamIds: string[];
      type: 'live' | 'vod' | 'series';
      concurrency?: number;
    };

    if (!playlistId || !Array.isArray(streamIds) || !streamIds.length || !type) {
      return res.status(400).json({ error: 'playlistId, streamIds, and type are required' });
    }

    if (streamIds.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 streams per scan job' });
    }

    if (!streamIds.every((id: any) => typeof id === 'string' && id.length > 0)) {
      return res.status(400).json({ error: 'streamIds must be an array of non-empty strings' });
    }

    if (!['live', 'vod', 'series'].includes(type)) {
      return res.status(400).json({ error: 'type must be live, vod, or series' });
    }

    const db = getDb();
    const playlistDoc = await db.collection('playlists').findOne({
      _id: toId(playlistId),
      userId: req.user!.id,
    });
    if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

    const sourceIds: string[] = playlistDoc.sourceIds || [];
    const sourceDocsRaw = await db.collection('sources').find({ _id: { $in: sourceIds.map(sid => toId(sid)) } }).toArray();
    const sourcesMap = new Map(sourceDocsRaw.map(s => [s._id.toString(), s]));
    const validSources = sourceIds.map(sid => sourcesMap.get(sid)).filter(Boolean);
    if (!validSources.length) return res.status(400).json({ error: 'No sources found for playlist' });

    const jobId = Math.random().toString(36).slice(2);
    const job: ScanJob = {
      id: jobId,
      userId: req.user!.id,
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

          // Decode source-prefixed stream ID (e.g. "0_1234" → sIdx=0, originalId="1234")
          let sIdx: number | null = null;
          let originalStreamId = streamId;
          if (streamId.includes('_')) {
            const parts = streamId.split('_');
            const firstPart = parseInt(parts[0]);
            if (!isNaN(firstPart)) { sIdx = firstPart; originalStreamId = parts.slice(1).join('_'); }
          }
          const targetSources = (sIdx !== null && sIdx < validSources.length)
            ? [validSources[sIdx]]
            : validSources;

          let meta: any = null;
          let lastError = '';

          // Try each source until one works
          for (const sourceDoc of targetSources) {
            try {
              // For VOD/series, use the real container_extension from the stream cache
              // (defaults to 'mp4' only when cache is cold — most providers ignore the extension anyway)
              let extension: string | undefined;
              if (type === 'vod' || type === 'series') {
                const cached = getCached(`${sourceDoc.id ?? sourceDoc._id.toString()}_streams_${type}`);
                if (cached?.data) {
                  const streamData = (cached.data as any[]).find(
                    (s: any) => String(s.stream_id ?? s.series_id) === originalStreamId
                  );
                  extension = streamData?.container_extension || undefined;
                }
              }
              const url = buildStreamUrl(sourceDoc, originalStreamId, type, extension);
              meta = await probeStream(url);
              break;
            } catch (e: any) {
              lastError = e.message;
            }
          }

          if (meta) {
            meta.scannedAt = new Date().toISOString();
            // Upsert detectedMeta — use raw originalStreamId (prefix already decoded above) so it
            // matches the existing mapping document rather than creating an orphan with the prefixed key
            await db.collection('mappings').updateOne(
              { playlistId, originalId: originalStreamId, type },
              {
                $set: { detectedMeta: meta, ...(sIdx !== null ? { sourceIdx: sIdx } : {}) },
                $setOnInsert: { originalName: '', customName: '', hidden: false, order: 0, categoryId: '' },
              },
              { upsert: true }
            );
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

  router.get("/quality-scan/:jobId", requireAuth, (req, res) => {
    const job = scanJobs.get(req.params.jobId);
    if (!job || job.userId !== (req as AuthRequest).user!.id)
      return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  router.delete("/quality-scan/:jobId", requireAuth, (req, res) => {
    const job = scanJobs.get(req.params.jobId);
    if (!job || job.userId !== (req as AuthRequest).user!.id)
      return res.status(404).json({ error: 'Job not found' });
    job.status = 'cancelled';
    res.json({ success: true });
  });

  return router;
}
