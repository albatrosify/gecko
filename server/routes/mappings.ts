import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { eq, inArray, and } from 'drizzle-orm';
import { mappings as schemaMappings, categoryMappings as schemaCategoryMappings, playlists as schemaPlaylists } from '../schema.ts';
import { clearEpgCache, refreshPlaylistEpg } from '../epg-service.ts';
import { getBaseUrl } from '../utils.ts';
import type { Playlist } from '../../src/types.ts';

class ForbiddenError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Mapping edits change the playlist-scoped EPG assembly (override vs upstream
 * pairing, hidden state, filtered channel set). Debounced rebuild so rapid
 * edit storms (e.g. UI auto-match with hundreds of updates) collapse into one
 * build; the ready cache replaces the old one atomically in the sync worker.
 */
const EPG_REBUILD_DEBOUNCE_MS = 20_000;
const epgRebuildTimers = new Map<string, NodeJS.Timeout>();
function scheduleEpgRebuildForPlaylist(playlistId: string, req: AuthRequest): void {
  if (!playlistId) return;
  const existing = epgRebuildTimers.get(playlistId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    epgRebuildTimers.delete(playlistId);
    void (async () => {
      try {
        await clearEpgCache(playlistId);
        const db = getDb();
        const pl = db.select().from(schemaPlaylists).where(eq(schemaPlaylists.id, playlistId)).get();
        if (!pl) return;
        const playlist = { ...pl, ...(pl.extra as any || {}) } as any as Playlist;
        await refreshPlaylistEpg(playlist, getBaseUrl(req));
      } catch (err: any) {
        log(`[Mappings] Deferred EPG rebuild failed for playlist ${playlistId}: ${err.message}`);
      }
    })();
  }, EPG_REBUILD_DEBOUNCE_MS);
  timer.unref?.();
}

function verifyPlaylistOwnership(db: any, playlistId: string, userId: string, role?: string): boolean {
  if (role === 'admin') return true;
  const playlist = db.select({ id: schemaPlaylists.id }).from(schemaPlaylists)
    .where(and(eq(schemaPlaylists.id, playlistId), eq(schemaPlaylists.userId, userId))).get();
  return !!playlist;
}

function isValidMappingId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function handleBatchMappings(
  table: typeof schemaMappings | typeof schemaCategoryMappings,
  afterCommit?: (playlistIds: Set<string>, req: AuthRequest) => void
) {
  return async (req: AuthRequest, res: any) => {
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
          const docs = tx.select().from(table).where(inArray(table.id, chunk)).all();
          for (const doc of docs) {
            if (!verifyPlaylistOwnership(tx, doc.playlistId, req.user!.id, req.user?.role)) {
              throw new ForbiddenError();
            }
            docsById.set(doc.id, doc);
          }
        }

        const docsByComposite = new Map();
        const byPlaylistAndType = new Map<string, Map<string, string[]>>();
        for (const u of missingIdUpdates) {
          let typeMap = byPlaylistAndType.get(u.playlistId);
          if (!typeMap) {
            typeMap = new Map();
            byPlaylistAndType.set(u.playlistId, typeMap);
          }
          let origList = typeMap.get(u.type);
          if (!origList) {
            origList = [];
            typeMap.set(u.type, origList);
          }
          origList.push(String(u.originalId));
        }

        for (const [pId, typeMap] of byPlaylistAndType.entries()) {
          for (const [t, origList] of typeMap.entries()) {
            for (let i = 0; i < origList.length; i += 500) {
              const chunk = origList.slice(i, i + 500);
              const found = tx.select().from(table).where(
                and(
                  eq(table.playlistId, pId),
                  eq(table.type, t),
                  inArray(table.originalId, chunk)
                )
              ).all();
              for (const doc of found) {
                if (!verifyPlaylistOwnership(tx, doc.playlistId, req.user!.id, req.user?.role)) {
                  throw new ForbiddenError();
                }
                docsByComposite.set(JSON.stringify([doc.originalId, doc.playlistId, doc.type]), doc);
              }
            }
          }
        }

        const inserts: any[] = [];
        const insertedByComposite = new Map<string, any>();

        for (const update of updates) {
          const { id, originalId, playlistId, type, ...extra } = update;
          const isValidId = isValidMappingId(id);

          if (isValidId) {
            const doc = docsById.get(id);
            if (doc) {
               const newExtra = { ...(doc.extra as any || {}), ...extra };
               tx.update(table).set({
                 playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
                 type: type !== undefined ? type : doc.type,
                 originalId: originalId !== undefined ? String(originalId) : doc.originalId,
                 extra: newExtra
               }).where(eq(table.id, id)).run();
               doc.extra = newExtra;
            }
          } else {
            const compositeKey = JSON.stringify([String(originalId), playlistId, type]);
            const existing = docsByComposite.get(compositeKey);
            if (existing) {
               const newExtra = { ...(existing.extra as any || {}), ...extra };
               tx.update(table).set({ extra: newExtra }).where(eq(table.id, existing.id)).run();
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
            tx.insert(table).values(inserts.slice(i, i + 500)).run();
          }
        }
      });

      afterCommit?.(playlistIds, req);
      res.json({ success: true, count: updates.length });
    } catch (err: any) {
      if (err instanceof ForbiddenError || err?.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      log(`[batch mappings] error: ${err?.message || err}`);
      res.status(500).json({ error: "Failed to batch update mappings" });
    }
  };
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
      scheduleEpgRebuildForPlaylist(playlistId, req);
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

      scheduleEpgRebuildForPlaylist(playlistId !== undefined ? playlistId : doc.playlistId, req);
      res.json({ success: true });
    } catch (e: any) {
      log(`Failed to update mapping: ${e.message}`);
      res.status(500).json({ error: "Failed to update mapping" });
    }
  });

  router.post("/mappings/batch", requireAuth, handleBatchMappings(schemaMappings, (playlistIds, req) => {
    for (const pid of playlistIds) scheduleEpgRebuildForPlaylist(pid, req);
  }));

  router.delete("/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const doc = db.select().from(schemaMappings).where(eq(schemaMappings.id, req.params.id)).get();
      if (!doc) return res.status(404).json({ error: "Mapping not found" });
      if (!verifyPlaylistOwnership(db, doc.playlistId, req.user!.id, req.user?.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      db.delete(schemaMappings).where(eq(schemaMappings.id, req.params.id)).run();
      scheduleEpgRebuildForPlaylist(doc.playlistId, req);
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

  router.post("/category-mappings/batch", requireAuth, handleBatchMappings(schemaCategoryMappings));

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
      const resetPlaylistIds = new Set<string>();
      for (const doc of getDb().select().from(schemaMappings).where(inArray(schemaMappings.id, ids)).all()) {
        resetPlaylistIds.add(doc.playlistId);
      }
      for (const pid of resetPlaylistIds) scheduleEpgRebuildForPlaylist(pid, req);

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
      const { ids, originalIds, playlistId, type } = req.body;

      let targetIds: string[] = [];
      if (Array.isArray(ids) && ids.length > 0) {
        targetIds = ids;
      } else if (Array.isArray(originalIds) && originalIds.length > 0 && playlistId && type) {
        if (!verifyPlaylistOwnership(db, playlistId, req.user!.id, req.user?.role)) {
          return res.status(403).json({ error: "Access denied" });
        }
        for (let i = 0; i < originalIds.length; i += 500) {
          const chunk = originalIds.slice(i, i + 500);
          const found = db.select({ id: schemaCategoryMappings.id })
            .from(schemaCategoryMappings)
            .where(
              and(
                eq(schemaCategoryMappings.playlistId, playlistId),
                eq(schemaCategoryMappings.type, type),
                inArray(schemaCategoryMappings.originalId, chunk)
              )
            ).all();
          targetIds.push(...found.map(f => f.id));
        }
      } else {
        return res.status(400).json({ error: "ids array or (originalIds, playlistId, type) required" });
      }

      db.transaction((tx) => {
        for (let i = 0; i < targetIds.length; i += 500) {
          const chunk = targetIds.slice(i, i + 500);
          const docs = tx.select().from(schemaCategoryMappings).where(inArray(schemaCategoryMappings.id, chunk)).all();
          for (const doc of docs) {
            if (!verifyPlaylistOwnership(tx, doc.playlistId, req.user!.id, req.user?.role)) {
              throw new ForbiddenError();
            }
            const extra = (doc.extra as any) || {};
            delete extra.customName;
            tx.update(schemaCategoryMappings).set({ extra }).where(eq(schemaCategoryMappings.id, doc.id)).run();
          }
        }
      });

      res.json({ success: true, count: targetIds.length });
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
