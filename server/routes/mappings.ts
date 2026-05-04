import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { eq, inArray, and } from 'drizzle-orm';
import { mappings as schemaMappings, categoryMappings as schemaCategoryMappings } from '../schema.ts';

export function createMappingsRouter() {
  const router = Router();

  // =====================================
  // CRUD: Mappings
  // =====================================
  router.get("/mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId) return res.status(400).json({ error: "playlistId required" });
    const db = getDb();
    const docs = db.select().from(schemaMappings).where(eq(schemaMappings.playlistId, playlistId as string)).all();
    const formatted = docs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) }));
    res.json(formatted);
  });

  router.post("/mappings", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const newId = generateId();
    const { playlistId, type, originalId, ...extra } = req.body;

    db.insert(schemaMappings).values({ id: newId, playlistId, type, originalId, extra }).run();
    res.status(201).json({ id: newId, playlistId, type, originalId, ...extra });
  });

  router.put("/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id, playlistId, type, originalId, ...extra } = req.body;

    const doc = db.select().from(schemaMappings).where(eq(schemaMappings.id, req.params.id)).get();
    if (doc) {
      db.update(schemaMappings).set({
        playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
        type: type !== undefined ? type : doc.type,
        originalId: originalId !== undefined ? originalId : doc.originalId,
        extra: { ...(doc.extra as any || {}), ...extra }
      }).where(eq(schemaMappings.id, req.params.id)).run();
    }
    res.json({ success: true });
  });

  router.post("/mappings/batch", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const { updates } = req.body; // Array of { id?, originalId, playlistId, type, ...data }

      db.transaction((tx) => {
        const validIds: string[] = [];
        const missingIdUpdates: any[] = [];

        for (const update of updates) {
          const isValidId = update.id && (/^[a-f\d]{24}$/i.test(update.id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(update.id));
          if (isValidId) validIds.push(update.id);
          else missingIdUpdates.push(update);
        }

        const docsById = new Map();
        for (let i = 0; i < validIds.length; i += 500) {
          const chunk = validIds.slice(i, i + 500);
          const docs = tx.select().from(schemaMappings).where(inArray(schemaMappings.id, chunk)).all();
          for (const doc of docs) docsById.set(doc.id, doc);
        }

        const docsByComposite = new Map();
        // Map from playlistId -> type -> array of originalIds
        const byPlaylistAndType = new Map<string, Map<string, string[]>>();
        for (const u of missingIdUpdates) {
          let typeMap = byPlaylistAndType.get(u.playlistId);
          if (!typeMap) {
            typeMap = new Map();
            byPlaylistAndType.set(u.playlistId, typeMap);
          }
          let originalIds = typeMap.get(u.type);
          if (!originalIds) {
            originalIds = [];
            typeMap.set(u.type, originalIds);
          }
          originalIds.push(u.originalId);
        }

        for (const [playlistId, typeMap] of byPlaylistAndType.entries()) {
          for (const [type, originalIds] of typeMap.entries()) {
            for (let i = 0; i < originalIds.length; i += 500) {
              const chunk = originalIds.slice(i, i + 500);
              const existing = tx.select().from(schemaMappings).where(
                and(
                  eq(schemaMappings.playlistId, playlistId),
                  eq(schemaMappings.type, type),
                  inArray(schemaMappings.originalId, chunk)
                )
              ).all();
              for (const doc of existing) {
                // Use a safer separator that won't appear in standard UUIDs or hex IDs
                // actually composite key with JSON.stringify is safer:
                docsByComposite.set(JSON.stringify([doc.originalId, doc.playlistId, doc.type]), doc);
              }
            }
          }
        }

        const inserts: any[] = [];
        const insertedByComposite = new Map(); // to prevent duplicate inserts in the same batch

        for (const update of updates) {
          const { id, originalId, playlistId, type, ...extra } = update;
          const isValidId = id && (/^[a-f\d]{24}$/i.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));

          if (isValidId) {
            const doc = docsById.get(id);
            if (doc) {
               const newExtra = { ...(doc.extra as any || {}), ...extra };
               tx.update(schemaMappings).set({
                 playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
                 type: type !== undefined ? type : doc.type,
                 originalId: originalId !== undefined ? originalId : doc.originalId,
                 extra: newExtra
               }).where(eq(schemaMappings.id, id)).run();
               doc.extra = newExtra; // update locally in case of consecutive updates
            }
          } else {
            const compositeKey = JSON.stringify([originalId, playlistId, type]);
            const existing = docsByComposite.get(compositeKey);
            if (existing) {
               const newExtra = { ...(existing.extra as any || {}), ...extra };
               tx.update(schemaMappings).set({ extra: newExtra }).where(eq(schemaMappings.id, existing.id)).run();
               existing.extra = newExtra; // update locally in case of consecutive updates
            } else {
               const newlyInserted = insertedByComposite.get(compositeKey);
               if (newlyInserted) {
                 // if we already queued an insert for this in the current batch, update the queued insert
                 newlyInserted.extra = { ...newlyInserted.extra, ...extra };
               } else {
                 const newInsert = { id: generateId(), playlistId, type, originalId, extra };
                 inserts.push(newInsert);
                 insertedByComposite.set(compositeKey, newInsert);
               }
            }
          }
        }

        if (inserts.length > 0) {
          for (let i = 0; i < inserts.length; i += 500) {
            tx.insert(schemaMappings).values(inserts.slice(i, i + 500)).run();
          }
        }
      });
      res.json({ success: true, count: updates.length });
    } catch (err: any) {
      log(`[batch mappings] error: ${err?.message || err}`);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.delete("/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    db.delete(schemaMappings).where(eq(schemaMappings.id, req.params.id)).run();
    res.json({ success: true });
  });

  // =====================================
  // CRUD: Category Mappings
  // =====================================
  router.get("/category-mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId) return res.status(400).json({ error: "playlistId required" });
    const db = getDb();

    const docs = db.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.playlistId, playlistId as string)).all();
    const formatted = docs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) }));
    res.json(formatted);
  });

  router.post("/category-mappings", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const newId = generateId();
    const { playlistId, type, originalId, ...extra } = req.body;

    db.insert(schemaCategoryMappings).values({ id: newId, playlistId, type, originalId, extra }).run();
    res.status(201).json({ id: newId, playlistId, type, originalId, ...extra });
  });

  router.put("/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id, playlistId, type, originalId, ...extra } = req.body;

    const doc = db.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.id, req.params.id)).get();
    if (doc) {
      db.update(schemaCategoryMappings).set({
        playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
        type: type !== undefined ? type : doc.type,
        originalId: originalId !== undefined ? originalId : doc.originalId,
        extra: { ...(doc.extra as any || {}), ...extra }
      }).where(eq(schemaCategoryMappings.id, req.params.id)).run();
    }
    res.json({ success: true });
  });

  router.post("/category-mappings/batch", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { updates } = req.body;

    db.transaction((tx) => {
      const validIds: string[] = [];
      const missingIdUpdates: any[] = [];

      for (const update of updates) {
        if (update.id) validIds.push(update.id);
        else missingIdUpdates.push(update);
      }

      const docsById = new Map();
      for (let i = 0; i < validIds.length; i += 500) {
        const chunk = validIds.slice(i, i + 500);
        const docs = tx.select().from(schemaCategoryMappings).where(inArray(schemaCategoryMappings.id, chunk)).all();
        for (const doc of docs) docsById.set(doc.id, doc);
      }

      const docsByComposite = new Map();
      // Map from playlistId -> type -> array of originalIds
      const byPlaylistAndType = new Map<string, Map<string, string[]>>();
      for (const u of missingIdUpdates) {
        let typeMap = byPlaylistAndType.get(u.playlistId);
        if (!typeMap) {
          typeMap = new Map();
          byPlaylistAndType.set(u.playlistId, typeMap);
        }
        let originalIds = typeMap.get(u.type);
        if (!originalIds) {
          originalIds = [];
          typeMap.set(u.type, originalIds);
        }
        originalIds.push(u.originalId);
      }

      for (const [playlistId, typeMap] of byPlaylistAndType.entries()) {
        for (const [type, originalIds] of typeMap.entries()) {
          for (let i = 0; i < originalIds.length; i += 500) {
            const chunk = originalIds.slice(i, i + 500);
            const existing = tx.select().from(schemaCategoryMappings).where(
              and(
                eq(schemaCategoryMappings.playlistId, playlistId),
                eq(schemaCategoryMappings.type, type),
                inArray(schemaCategoryMappings.originalId, chunk)
              )
            ).all();
            for (const doc of existing) {
              docsByComposite.set(JSON.stringify([doc.originalId, doc.playlistId, doc.type]), doc);
            }
          }
        }
      }

      const inserts: any[] = [];
      const insertedByComposite = new Map();

      for (const update of updates) {
        const { id, originalId, playlistId, type, ...extra } = update;

        if (id) {
          const doc = docsById.get(id);
          if (doc) {
             const newExtra = { ...(doc.extra as any || {}), ...extra };
             tx.update(schemaCategoryMappings).set({
               playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
               type: type !== undefined ? type : doc.type,
               originalId: originalId !== undefined ? originalId : doc.originalId,
               extra: newExtra
             }).where(eq(schemaCategoryMappings.id, id)).run();
             doc.extra = newExtra;
          }
        } else {
          const compositeKey = JSON.stringify([originalId, playlistId, type]);
          const existing = docsByComposite.get(compositeKey);
          if (existing) {
             const newExtra = { ...(existing.extra as any || {}), ...extra };
             tx.update(schemaCategoryMappings).set({ extra: newExtra }).where(eq(schemaCategoryMappings.id, existing.id)).run();
             existing.extra = newExtra;
          } else {
             const newlyInserted = insertedByComposite.get(compositeKey);
             if (newlyInserted) {
               newlyInserted.extra = { ...newlyInserted.extra, ...extra };
             } else {
               const newInsert = { id: generateId(), playlistId, type, originalId, extra };
               inserts.push(newInsert);
               insertedByComposite.set(compositeKey, newInsert);
             }
          }
        }
      }

      if (inserts.length > 0) {
        for (let i = 0; i < inserts.length; i += 500) {
          tx.insert(schemaCategoryMappings).values(inserts.slice(i, i + 500)).run();
        }
      }
    });

    res.json({ success: true, count: updates.length });
  });

  router.delete("/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    db.delete(schemaCategoryMappings).where(eq(schemaCategoryMappings.id, req.params.id)).run();
    res.json({ success: true });
  });

  router.post("/mappings/reset", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const { ids } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "ids array required" });
      }

      db.transaction((tx) => {
        const docs = tx.select().from(schemaMappings).where(inArray(schemaMappings.id, ids)).all();
        for (const doc of docs) {
          const extra = (doc.extra as any) || {};
          delete extra.customName;
          delete extra.customIcon;
          tx.update(schemaMappings).set({ extra }).where(eq(schemaMappings.id, doc.id)).run();
        }
      });

      res.json({ success: true, count: ids.length });
    } catch (err: any) {
      log(`[reset mappings] error: ${err?.message || err}`);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post("/category-mappings/reset", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const { ids } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "ids array required" });
      }

      db.transaction((tx) => {
        const docs = tx.select().from(schemaCategoryMappings).where(inArray(schemaCategoryMappings.id, ids)).all();
        for (const doc of docs) {
          const extra = (doc.extra as any) || {};
          delete extra.customName;
          tx.update(schemaCategoryMappings).set({ extra }).where(eq(schemaCategoryMappings.id, doc.id)).run();
        }
      });

      res.json({ success: true, count: ids.length });
    } catch (err: any) {
      log(`[reset category-mappings] error: ${err?.message || err}`);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  return router;
}
