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
    const prefixPattern = /^(\d+)_(.+)$/;
    let updated = 0;

    for (const col of ['mappings', 'categoryMappings']) {
      const docs = await db.collection(col).find({}).toArray();
      for (const doc of docs) {
        const match = String(doc.originalId || '').match(prefixPattern);
        if (!match) continue;
        const sourceIdx = parseInt(match[1]);
        const rawId = match[2];
        await db.collection(col).updateOne(
          { _id: doc._id },
          { $set: { originalId: rawId, ...(doc.sourceIdx == null ? { sourceIdx } : {}) } }
        );
        updated++;
      }
    }

    res.json({ success: true, updated });
  });

  // =====================================
  // Migration: move detectedMeta from orphan (prefixed) docs to real mappings
  // =====================================
  router.post("/migrate/fix-detectedmeta-orphans", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const prefixPattern = /^(\d+)_(.+)$/;
      const orphans = await db.collection('mappings').find({ originalId: { $regex: /^\d+_/ } }).toArray();
      let moved = 0, deleted = 0, renamed = 0;
      const details: any[] = [];
      for (const orphan of orphans) {
        const match = String(orphan.originalId || '').match(prefixPattern);
        if (!match) continue;
        const rawId = match[2];
        const conflict = await db.collection('mappings').findOne({ playlistId: orphan.playlistId, originalId: rawId, type: orphan.type });
        // Try to merge detectedMeta into an existing raw-ID mapping
        if (orphan.detectedMeta && conflict) {
          const result = await db.collection('mappings').updateOne(
            { _id: conflict._id },
            { $set: { detectedMeta: orphan.detectedMeta, ...(orphan.useDetectedQuality != null ? { useDetectedQuality: orphan.useDetectedQuality } : {}) } }
          );
          if (result.matchedCount > 0) {
            await db.collection('mappings').deleteOne({ _id: orphan._id });
            moved++; deleted++;
            details.push({ action: 'merged', orphanId: String(orphan.originalId), rawId });
            continue;
          }
        }
        if (!conflict) {
          // No raw-ID document exists — rename the orphan itself by stripping the prefix
          await db.collection('mappings').updateOne({ _id: orphan._id }, { $set: { originalId: rawId } });
          renamed++;
          details.push({ action: 'renamed', orphanId: String(orphan.originalId), rawId });
        } else {
          // Conflict exists — merge orphan's useful fields into the conflict doc, then delete orphan
          const mergeFields: any = {};
          if (orphan.customName && !conflict.customName) mergeFields.customName = orphan.customName;
          if (orphan.customIcon && !conflict.customIcon) mergeFields.customIcon = orphan.customIcon;
          if (orphan.epgMapping && !conflict.epgMapping) mergeFields.epgMapping = orphan.epgMapping;
          if (orphan.detectedMeta && !conflict.detectedMeta) mergeFields.detectedMeta = orphan.detectedMeta;
          if (orphan.useDetectedQuality != null && conflict.useDetectedQuality == null) mergeFields.useDetectedQuality = orphan.useDetectedQuality;
          if (Object.keys(mergeFields).length > 0) {
            await db.collection('mappings').updateOne({ _id: conflict._id }, { $set: mergeFields });
          }
          await db.collection('mappings').deleteOne({ _id: orphan._id });
          deleted++;
          details.push({ action: 'merged_and_deleted', orphanId: String(orphan.originalId), rawId, mergedFields: Object.keys(mergeFields) });
        }
      }
      res.json({ success: true, orphansFound: orphans.length, moved, deleted, renamed, details });
    } catch (err: any) {
      res.status(500).json({ success: false, error: String(err?.message || err) });
    }
  });

  return router;
}
