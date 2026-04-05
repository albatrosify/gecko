import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";

export function createMappingsRouter() {
  const router = Router();

  // =====================================
  // CRUD: Mappings
  // =====================================
  router.get("/mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId) return res.status(400).json({ error: "playlistId required" });
    const db = getDb();
    const { mappings: schemaMappings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    const docs = db.select().from(schemaMappings).where(eq(schemaMappings.playlistId, playlistId as string)).all();
    const formatted = docs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) }));
    res.json(formatted);
  });

  router.post("/mappings", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { mappings: schemaMappings } = await import('../schema.ts');
    const newId = generateId();
    const { playlistId, type, originalId, ...extra } = req.body;

    db.insert(schemaMappings).values({ id: newId, playlistId, type, originalId, extra }).run();
    res.status(201).json({ id: newId, playlistId, type, originalId, ...extra });
  });

  router.put("/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { mappings: schemaMappings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
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
      const { mappings: schemaMappings } = await import('../schema.ts');
      const { eq, and } = await import('drizzle-orm');
      const { updates } = req.body; // Array of { id?, originalId, playlistId, type, ...data }

      db.transaction((tx) => {
        for (const update of updates) {
          const { id, originalId, playlistId, type, ...extra } = update;
          // Use id-based update only when id is a valid 24-char hex ObjectId string OR a uuid
          const isValidId = id && (/^[a-f\d]{24}$/i.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
          if (isValidId) {
            const doc = tx.select().from(schemaMappings).where(eq(schemaMappings.id, id)).get();
            if (doc) {
               tx.update(schemaMappings).set({
                 playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
                 type: type !== undefined ? type : doc.type,
                 originalId: originalId !== undefined ? originalId : doc.originalId,
                 extra: { ...(doc.extra as any || {}), ...extra }
               }).where(eq(schemaMappings.id, id)).run();
            }
          } else {
            const existing = tx.select().from(schemaMappings).where(and(eq(schemaMappings.originalId, originalId), eq(schemaMappings.playlistId, playlistId), eq(schemaMappings.type, type))).get();
            if (existing) {
               tx.update(schemaMappings).set({ extra: { ...(existing.extra as any || {}), ...extra } }).where(eq(schemaMappings.id, existing.id)).run();
            } else {
               tx.insert(schemaMappings).values({ id: generateId(), playlistId, type, originalId, extra }).run();
            }
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
    const { mappings: schemaMappings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
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
    const { categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    const docs = db.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.playlistId, playlistId as string)).all();
    const formatted = docs.map(d => ({ id: d.id, playlistId: d.playlistId, type: d.type, originalId: d.originalId, ...(d.extra as any || {}) }));
    res.json(formatted);
  });

  router.post("/category-mappings", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const newId = generateId();
    const { playlistId, type, originalId, ...extra } = req.body;

    db.insert(schemaCategoryMappings).values({ id: newId, playlistId, type, originalId, extra }).run();
    res.status(201).json({ id: newId, playlistId, type, originalId, ...extra });
  });

  router.put("/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
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
    const { categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');
    const { updates } = req.body;

    db.transaction((tx) => {
      for (const update of updates) {
        const { id, originalId, playlistId, type, ...extra } = update;
        if (id) {
          const doc = tx.select().from(schemaCategoryMappings).where(eq(schemaCategoryMappings.id, id)).get();
          if (doc) {
             tx.update(schemaCategoryMappings).set({
               playlistId: playlistId !== undefined ? playlistId : doc.playlistId,
               type: type !== undefined ? type : doc.type,
               originalId: originalId !== undefined ? originalId : doc.originalId,
               extra: { ...(doc.extra as any || {}), ...extra }
             }).where(eq(schemaCategoryMappings.id, id)).run();
          }
        } else {
          const existing = tx.select().from(schemaCategoryMappings).where(and(eq(schemaCategoryMappings.originalId, originalId), eq(schemaCategoryMappings.playlistId, playlistId), eq(schemaCategoryMappings.type, type))).get();
          if (existing) {
             tx.update(schemaCategoryMappings).set({ extra: { ...(existing.extra as any || {}), ...extra } }).where(eq(schemaCategoryMappings.id, existing.id)).run();
          } else {
             tx.insert(schemaCategoryMappings).values({ id: generateId(), playlistId, type, originalId, extra }).run();
          }
        }
      }
    });

    res.json({ success: true, count: updates.length });
  });

  router.delete("/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    db.delete(schemaCategoryMappings).where(eq(schemaCategoryMappings.id, req.params.id)).run();
    res.json({ success: true });
  });

  return router;
}
