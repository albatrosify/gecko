import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
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
    const { playlists: schemaPlaylists, sources: schemaSources } = await import('../schema.ts');
    const { eq, and, inArray } = await import('drizzle-orm');

    const playlistDoc = db.select().from(schemaPlaylists).where(and(eq(schemaPlaylists.id, playlistId), eq(schemaPlaylists.userId, req.user!.id))).get();
    if (!playlistDoc) return res.status(404).json({ error: 'Playlist not found' });

    const sourceIds: string[] = (Array.isArray(playlistDoc.sourceIds) ? playlistDoc.sourceIds : []) as string[];
    const sourceDocs = sourceIds.length > 0
      ? db.select().from(schemaSources).where(inArray(schemaSources.id, sourceIds)).all()
      : [];
    const sourcesMap = new Map(sourceDocs.map(doc => [doc.id, { ...doc, ...(doc.extra as any || {}) }]));
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
                const cached = getCached(`${sourceDoc.id}_streams_${type}`);
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
            const { mappings: schemaMappings } = await import('../schema.ts');
            const { eq, and } = await import('drizzle-orm');

            const existingMapping = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, playlistId), eq(schemaMappings.originalId, originalStreamId), eq(schemaMappings.type, type))).get();
            if (existingMapping) {
               const currentExtra = (existingMapping.extra as any) || {};
               currentExtra.detectedMeta = meta;
               if (sIdx !== null) currentExtra.sourceIdx = sIdx;
               db.update(schemaMappings).set({ extra: currentExtra }).where(eq(schemaMappings.id, existingMapping.id)).run();
            } else {
               const newExtra = { detectedMeta: meta, originalName: '', customName: '', hidden: false, order: 999999, categoryId: '' } as any;
               if (sIdx !== null) newExtra.sourceIdx = sIdx;

               db.insert(schemaMappings).values({ id: generateId(), playlistId, originalId: originalStreamId, type, extra: newExtra }).run();
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
