import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb } from "../db.ts";

export function createMigrationsRouter() {
  const router = Router();

  // =====================================
  // Migration: strip sourceIdx prefix from originalId
  // =====================================
  router.post("/migrate/strip-id-prefixes", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { mappings: schemaMappings, categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    const prefixPattern = /^(\d+)_(.+)$/;
    let updated = 0;

    const tables = [schemaMappings, schemaCategoryMappings];
    for (const table of tables) {
      const docs = db.select().from(table).all();
      db.transaction((tx) => {
        for (const doc of docs) {
          const match = String(doc.originalId || '').match(prefixPattern);
          if (!match) continue;
          const sourceIdx = parseInt(match[1]);
          const rawId = match[2];

          const extra = (doc.extra as any) || {};
          if (extra.sourceIdx == null) extra.sourceIdx = sourceIdx;

          tx.update(table).set({ originalId: rawId, extra }).where(eq(table.id, doc.id)).run();
          updated++;
        }
      });
    }

    res.json({ success: true, updated });
  });

  // =====================================
  // Migration: move detectedMeta from orphan (prefixed) docs to real mappings
  // =====================================
  router.post("/migrate/fix-detectedmeta-orphans", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const { mappings: schemaMappings } = await import('../schema.ts');
      const { eq, and, like } = await import('drizzle-orm');
      const prefixPattern = /^(\d+)_(.+)$/;
      const orphans = db.select().from(schemaMappings).where(like(schemaMappings.originalId, '%_%')).all().filter(d => /^\d+_/.test(d.originalId));
      let moved = 0, deleted = 0, renamed = 0;
      const details: any[] = [];

      db.transaction((tx) => {
        for (const orphan of orphans) {
          const match = String(orphan.originalId || '').match(prefixPattern);
          if (!match) continue;
          const rawId = match[2];
          const orphanExtra = (orphan.extra as any) || {};

          const conflict = tx.select().from(schemaMappings).where(
            and(
              eq(schemaMappings.playlistId, orphan.playlistId),
              eq(schemaMappings.originalId, rawId),
              eq(schemaMappings.type, orphan.type)
            )
          ).get();

          // Try to merge detectedMeta into an existing raw-ID mapping
          if (orphanExtra.detectedMeta && conflict) {
            const conflictExtra = (conflict.extra as any) || {};
            conflictExtra.detectedMeta = orphanExtra.detectedMeta;
            if (orphanExtra.useDetectedQuality != null) conflictExtra.useDetectedQuality = orphanExtra.useDetectedQuality;

            tx.update(schemaMappings).set({ extra: conflictExtra }).where(eq(schemaMappings.id, conflict.id)).run();
            tx.delete(schemaMappings).where(eq(schemaMappings.id, orphan.id)).run();
            moved++; deleted++;
            details.push({ action: 'merged', orphanId: String(orphan.originalId), rawId });
            continue;
          }
          if (!conflict) {
            // No raw-ID document exists — rename the orphan itself by stripping the prefix
            tx.update(schemaMappings).set({ originalId: rawId }).where(eq(schemaMappings.id, orphan.id)).run();
            renamed++;
            details.push({ action: 'renamed', orphanId: String(orphan.originalId), rawId });
          } else {
            // Conflict exists — merge orphan's useful fields into the conflict doc, then delete orphan
            const conflictExtra = (conflict.extra as any) || {};
            const mergeFields: any = {};
            if (orphanExtra.customName && !conflictExtra.customName) mergeFields.customName = orphanExtra.customName;
            if (orphanExtra.customIcon && !conflictExtra.customIcon) mergeFields.customIcon = orphanExtra.customIcon;
            if (orphanExtra.epgMapping && !conflictExtra.epgMapping) mergeFields.epgMapping = orphanExtra.epgMapping;
            if (orphanExtra.detectedMeta && !conflictExtra.detectedMeta) mergeFields.detectedMeta = orphanExtra.detectedMeta;
            if (orphanExtra.useDetectedQuality != null && conflictExtra.useDetectedQuality == null) mergeFields.useDetectedQuality = orphanExtra.useDetectedQuality;

            if (Object.keys(mergeFields).length > 0) {
              Object.assign(conflictExtra, mergeFields);
              tx.update(schemaMappings).set({ extra: conflictExtra }).where(eq(schemaMappings.id, conflict.id)).run();
            }
            tx.delete(schemaMappings).where(eq(schemaMappings.id, orphan.id)).run();
            deleted++;
            details.push({ action: 'merged_and_deleted', orphanId: String(orphan.originalId), rawId, mergedFields: Object.keys(mergeFields) });
          }
        }
      });
      res.json({ success: true, orphansFound: orphans.length, moved, deleted, renamed, details });
    } catch (err: any) {
      res.status(500).json({ success: false, error: String(err?.message || err) });
    }
  });

  return router;
}
