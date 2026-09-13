import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { eq, inArray, and } from 'drizzle-orm';
import { mappings as schemaMappings, categoryMappings as schemaCategoryMappings, playlists as schemaPlaylists } from '../schema.ts';

class ForbiddenError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "ForbiddenError";
  }
}

function verifyPlaylistOwnership(db: any, playlistId: string, userId: string, role?: string): boolean {
  if (role === 'admin') return true;
  const playlist = db.select({ id: schemaPlaylists.id }).from(schemaPlaylists)
    .where(and(eq(schemaPlaylists.id, playlistId), eq(schemaPlaylists.userId, userId))).get();
  return !!playlist;
}

function isValidMappingId(id: unknown): id is string {
  return typeof id === 'string' && (/^[a-f\d]{24}$/i.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
}

export function createMappingsRouter() {
  const router = Router();

  // =====================================
  // CRUD: Mappings
  // =====================================
  router.get("/mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId || typeof playlistId !== 'string') return res.status(400).json({ error: "playlistId required" });
    const db = getDb();
    if (!verifyPlaylistOwnership(db, playlistId, req.user!.id, req.user?.role)) {
      return res.status(403).json({ error: "Access denied" });
    }
    const docs = db.select().from(schemaMappings).where(eq(schemaMappings.playlistId, playlistId)).all();
    const formatted = docs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) }));
    res.json(formatted);
  });

  router.post("/mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId, type, originalId, ...extra } = req.body;
    if (!playlistId || !type || originalId === undefined || originalId === null) {
      return res.status(400).json({ error: "playlistId, type, and originalId are required" });
    }

    try {
      const db = getDb();
      if (!verifyPlaylistOwnership(db, playlistId, req.user!.id, req.user?.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      const newId = generateId();
      const strOriginalId = String(originalId);
      db.insert(schemaMappings).values({ id: newId, playlistId, type, originalId: strOriginalId, extra }).run();
      res.status(201).json({ id: newId, playlistId, type, originalId: strOriginalId, ...extra });
    } catch (e: any) {
      log(`Failed to insert mapping: ${e.message}`);
      res.status(500).json({ error: "Failed to create mapping" });
    }
  });

  router.put("/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const { id, playlistId, type, originalId, ...extra } = req.body;
      if (id !== undefined && id !== req.params.id) {
        return res.status(400).json({ error: "Mismatched mapping ID in request body" });
      }

      const doc = db.select().from(schemaMappings).where(eq(schemaMappings.id, req.params.id)).get();
      if (!doc) {
        return res.status(404).json({ error: "Mapping not found" });
      }

      if (!verifyPlaylistOwnership(db, doc.playlistId, req.user!.id, req.user?.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (playlistId !== undefined && playlistId !== doc.playlistId) {
        if (!verifyPlaylistOwnership(db, playlistId, req.user!.id, req.user?.role)) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      db.update(schemaMappings).set({
        playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
        type: type !== undefined ? type : doc.type,
        originalId: originalId !== undefined ? String(originalId) : doc.originalId,
        extra: { ...(doc.extra as any || {}), ...extra }
      }).where(eq(schemaMappings.id, req.params.id)).run();

      res.json({ success: true });
    } catch (e: any) {
      log(`Failed to update mapping: ${e.message}`);
      res.status(500).json({ error: "Failed to update mapping" });
    }
  });

  router.post("/mappings/batch", requireAuth, async (req: AuthRequest, res) => {
    try {
      const { updates } = req.body; // Array of { id?, originalId, playlistId, type, ...data }
      if (!Array.isArray(updates)) {
        return res.status(400).json({ error: "updates array required" });
      }

      const db = getDb();

      // Verify ownership of all referenced playlist IDs
      const playlistIds = new Set<string>();
      for (const u of updates) {
        if (u.playlistId) playlistIds.add(u.playlistId);
      }
      for (const pid of playlistIds) {
        if (!verifyPlaylistOwnership(db, pid, req.user!.id, req.user?.role)) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      db.transaction((tx) => {
        const validIds: string[] = [];
        const missingIdUpdates: any[] = [];

        for (const update of updates) {
          const isValidId = isValidMappingId(update.id);
          if (isValidId) validIds.push(update.id);
          else missingIdUpdates.push(update);
        }

        const docsById = new Map();
        for (let i = 0; i < validIds.length; i += 500) {
          const chunk = validIds.slice(i, i + 500);
          const docs = tx.select().from(schemaMappings).where(inArray(schemaMappings.id, chunk)).all();
          for (const doc of docs) {
            if (!verifyPlaylistOwnership(tx, doc.playlistId, req.user!.id, req.user?.role)) {
              throw new ForbiddenError();
            }
            docsById.set(doc.id, doc);
          }
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
          const isValidId = isValidMappingId(id);

          if (isValidId) {
            const doc = docsById.get(id);
            if (doc) {
               const newExtra = { ...(doc.extra as any || {}), ...extra };
               tx.update(schemaMappings).set({
                 playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
                 type: type !== undefined ? type : doc.type,
                 originalId: originalId !== undefined ? String(originalId) : doc.originalId,
                 extra: newExtra
               }).where(eq(schemaMappings.id, id)).run();
               doc.extra = newExtra; // update locally in case of consecutive updates
            }
          } else {
            const compositeKey = JSON.stringify([String(originalId), playlistId, type]);
            const existing = docsByComposite.get(compositeKey);
            if (existing) {
               const newExtra = { ...(existing.extra as any || {}), ...extra };
               tx.update(schemaMappings).set({ extra: newExtra }).where(eq(schemaMappings.id, existing.id)).run();
               existing.extra = newExtra; // update locally in case of consecutive updates
            } else {
               const newlyInserted = insertedByComposite.get(compositeKey);
               if (newlyInserted) {
                 // Update the queued insert if we already queued one in the current batch
                 newlyInserted.extra = { ...newlyInserted.extra, ...extra };
               } else {
                 const newInsert = { id: generateId(), playlistId, type, originalId: String(originalId), extra };
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
      if (err instanceof ForbiddenError || err?.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      log(`[batch mappings] error: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to batch update mappings" });
    }
  });

  router.delete("/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const doc = db.select().from(schemaMappings).where(eq(schemaMappings.id, req.params.id)).get();
      if (!doc) return res.status(404).json({ error: "Mapping not found" });
      if (!verifyPlaylistOwnership(db, doc.playlistId, req.user!.id, req.user?.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      db.delete(schemaMappings).where(eq(schemaMappings.id, req.params.id)).run();
      res.json({ success: true });
    } catch (err: any) {
      log(`Failed to delete mapping: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to delete mapping" });
    }
  });

  // =====================================
  // CRUD: Category Mappings
  // =====================================
  router.get("/category-mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId || typeof playlistId !== 'string') return res.status(400).json({ error: "playlistId required" });
    const db = getDb();
    if (!verifyPlaylistOwnership(db, playlistId, req.user!.id, req.user?.role)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const docs = db.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.playlistId, playlistId)).all();
    const formatted = docs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) }));
    res.json(formatted);
  });

  router.post("/category-mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId, type, originalId, ...extra } = req.body;
    if (!playlistId || !type || originalId === undefined || originalId === null) {
      return res.status(400).json({ error: "playlistId, type, and originalId are required" });
    }

    try {
      const db = getDb();
      if (!verifyPlaylistOwnership(db, playlistId, req.user!.id, req.user?.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      const newId = generateId();
      const strOriginalId = String(originalId);
      db.insert(schemaCategoryMappings).values({ id: newId, playlistId, type, originalId: strOriginalId, extra }).run();
      res.status(201).json({ id: newId, playlistId, type, originalId: strOriginalId, ...extra });
    } catch (e: any) {
      log(`Failed to insert category mapping: ${e.message}`);
      res.status(500).json({ error: "Failed to create category mapping" });
    }
  });

  router.put("/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const { id, playlistId, type, originalId, ...extra } = req.body;
      if (id !== undefined && id !== req.params.id) {
        return res.status(400).json({ error: "Mismatched mapping ID in request body" });
      }

      const doc = db.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.id, req.params.id)).get();
      if (!doc) {
        return res.status(404).json({ error: "Category mapping not found" });
      }

      if (!verifyPlaylistOwnership(db, doc.playlistId, req.user!.id, req.user?.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (playlistId !== undefined && playlistId !== doc.playlistId) {
        if (!verifyPlaylistOwnership(db, playlistId, req.user!.id, req.user?.role)) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      db.update(schemaCategoryMappings).set({
        playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
        type: type !== undefined ? type : doc.type,
        originalId: originalId !== undefined ? String(originalId) : doc.originalId,
        extra: { ...(doc.extra as any || {}), ...extra }
      }).where(eq(schemaCategoryMappings.id, req.params.id)).run();

      res.json({ success: true });
    } catch (e: any) {
      log(`Failed to update category mapping: ${e.message}`);
      res.status(500).json({ error: "Failed to update category mapping" });
    }
  });

  router.post("/category-mappings/batch", requireAuth, async (req: AuthRequest, res) => {
    try {
      const { updates } = req.body;
      if (!Array.isArray(updates)) {
        return res.status(400).json({ error: "updates array required" });
      }

      const db = getDb();

      // Verify ownership of all referenced playlist IDs
      const playlistIds = new Set<string>();
      for (const u of updates) {
        if (u.playlistId) playlistIds.add(u.playlistId);
      }
      for (const pid of playlistIds) {
        if (!verifyPlaylistOwnership(db, pid, req.user!.id, req.user?.role)) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      db.transaction((tx) => {
        const validIds: string[] = [];
        const missingIdUpdates: any[] = [];

        for (const update of updates) {
          const isValidId = isValidMappingId(update.id);
          if (isValidId) validIds.push(update.id);
          else missingIdUpdates.push(update);
        }

        const docsById = new Map();
        for (let i = 0; i < validIds.length; i += 500) {
          const chunk = validIds.slice(i, i + 500);
          const docs = tx.select().from(schemaCategoryMappings).where(inArray(schemaCategoryMappings.id, chunk)).all();
          for (const doc of docs) {
            if (!verifyPlaylistOwnership(tx, doc.playlistId, req.user!.id, req.user?.role)) {
              throw new ForbiddenError();
            }
            docsById.set(doc.id, doc);
          }
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
          const isValidId = isValidMappingId(id);

          if (isValidId) {
            const doc = docsById.get(id);
            if (doc) {
               const newExtra = { ...(doc.extra as any || {}), ...extra };
               tx.update(schemaCategoryMappings).set({
                 playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
                 type: type !== undefined ? type : doc.type,
                 originalId: originalId !== undefined ? String(originalId) : doc.originalId,
                 extra: newExtra
               }).where(eq(schemaCategoryMappings.id, id)).run();
               doc.extra = newExtra;
            }
          } else {
            const compositeKey = JSON.stringify([String(originalId), playlistId, type]);
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
                 const newInsert = { id: generateId(), playlistId, type, originalId: String(originalId), extra };
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
    } catch (e: any) {
      if (e instanceof ForbiddenError || e?.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      log(`Failed to batch update category mappings: ${e.message}`);
      res.status(500).json({ error: "Failed to batch update category mappings" });
    }
  });

  router.delete("/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const doc = db.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.id, req.params.id)).get();
      if (!doc) return res.status(404).json({ error: "Category mapping not found" });
      if (!verifyPlaylistOwnership(db, doc.playlistId, req.user!.id, req.user?.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      db.delete(schemaCategoryMappings).where(eq(schemaCategoryMappings.id, req.params.id)).run();
      res.json({ success: true });
    } catch (err: any) {
      log(`Failed to delete category mapping: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to delete category mapping" });
    }
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
          if (!verifyPlaylistOwnership(tx, doc.playlistId, req.user!.id, req.user?.role)) {
            throw new ForbiddenError();
          }
          const extra = (doc.extra as any) || {};
          delete extra.customName;
          delete extra.customIcon;
          tx.update(schemaMappings).set({ extra }).where(eq(schemaMappings.id, doc.id)).run();
        }
      });

      res.json({ success: true, count: ids.length });
    } catch (err: any) {
      if (err instanceof ForbiddenError || err?.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      log(`[reset mappings] error: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to reset mappings" });
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
          if (!verifyPlaylistOwnership(tx, doc.playlistId, req.user!.id, req.user?.role)) {
            throw new ForbiddenError();
          }
          const extra = (doc.extra as any) || {};
          delete extra.customName;
          tx.update(schemaCategoryMappings).set({ extra }).where(eq(schemaCategoryMappings.id, doc.id)).run();
        }
      });

      res.json({ success: true, count: ids.length });
    } catch (err: any) {
      if (err instanceof ForbiddenError || err?.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      log(`[reset category-mappings] error: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to reset category mappings" });
    }
  });

  return router;
}
