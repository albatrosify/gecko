import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { and, eq, inArray } from 'drizzle-orm';
import { customCategories, customCategoryItems, playlists } from '../schema.ts';

export function createCustomCategoriesRouter() {
  const router = Router();

  // Middleware to ensure user owns the playlist
  const verifyPlaylistOwnership = async (req: AuthRequest, res: any, next: any) => {
    let playlistId = (req.query.playlistId || req.body.playlistId) as string | undefined;
    if (!playlistId && Array.isArray(req.body?.items) && req.body.items.length > 0) {
      playlistId = req.body.items[0]?.playlistId;
    }
    if (!playlistId) return res.status(400).json({ error: "playlistId required" });

    if (req.body.playlistId && req.query.playlistId && req.body.playlistId !== req.query.playlistId) {
      return res.status(400).json({ error: "Mismatched playlistId in request" });
    }

    if (Array.isArray(req.body?.items)) {
      for (const item of req.body.items) {
        if (item.playlistId && item.playlistId !== playlistId) {
          return res.status(400).json({ error: "Mismatched playlistId in batch items" });
        }
      }
    }

    try {
      const db = getDb();
      const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();

      if (!playlist) return res.status(404).json({ error: "Playlist not found" });
      if (req.user?.role !== 'admin' && playlist.userId !== req.user?.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      req.verifiedPlaylistId = playlist.id;
      next();
    } catch (e: any) {
      log("Error verifying playlist ownership: " + e.message);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  // --- Custom Categories CRUD ---

  router.get("/custom-categories", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const playlistId = req.verifiedPlaylistId!;
    const db = getDb();
    const docs = db.select().from(customCategories).where(eq(customCategories.playlistId, playlistId)).all();
    res.json(docs);
  });

  router.post("/custom-categories", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const db = getDb();
    const playlistId = req.verifiedPlaylistId!;
    const { type, name, order, hidden } = req.body;

    if (!type || !['live', 'vod', 'series'].includes(type)) {
      return res.status(400).json({ error: "Invalid or missing category type (must be live, vod, or series)" });
    }
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const newId = generateId();
    const safeOrder = typeof order === 'number' ? order : 0;
    const safeHidden = Boolean(hidden);

    try {
      db.insert(customCategories).values({
        id: newId,
        playlistId,
        type,
        name: name.trim(),
        order: safeOrder,
        hidden: safeHidden
      }).run();

      res.status(201).json({ id: newId, playlistId, type, name: name.trim(), order: safeOrder, hidden: safeHidden });
    } catch (e: any) {
      log("Failed to insert custom category: " + e.message);
      res.status(500).json({ error: "Failed to create custom category" });
    }
  });

  router.put("/custom-categories/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id } = req.params;

    try {
      const result = db.select({
        doc: customCategories,
        playlist: playlists
      })
      .from(customCategories)
      .leftJoin(playlists, eq(playlists.id, customCategories.playlistId))
      .where(eq(customCategories.id, id))
      .get();

      if (!result || !result.doc) return res.status(404).json({ error: "Not found" });

      const { doc, playlist } = result;

      // Ownership check via playlist
      if (!playlist || (req.user?.role !== 'admin' && playlist.userId !== req.user?.id)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { name, order, hidden } = req.body;
      const updates: Partial<typeof customCategories.$inferInsert> = {};

      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) {
          return res.status(400).json({ error: "Category name must be a non-empty string" });
        }
        updates.name = name.trim();
      }
      if (order !== undefined) {
        if (typeof order !== 'number') {
          return res.status(400).json({ error: "Order must be a number" });
        }
        updates.order = order;
      }
      if (hidden !== undefined) {
        updates.hidden = Boolean(hidden);
      }

      if (Object.keys(updates).length > 0) {
        db.update(customCategories).set(updates).where(eq(customCategories.id, id)).run();
      }

      res.json({ success: true });
    } catch (e: any) {
      log("Failed to update custom category: " + e.message);
      res.status(500).json({ error: "Failed to update custom category" });
    }
  });

  router.delete("/custom-categories/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id } = req.params;

    try {
      const result = db.select({
        doc: customCategories,
        playlist: playlists
      })
      .from(customCategories)
      .leftJoin(playlists, eq(playlists.id, customCategories.playlistId))
      .where(eq(customCategories.id, id))
      .get();

      if (!result || !result.doc) return res.status(404).json({ error: "Not found" });

      const { doc, playlist } = result;

      if (!playlist || (req.user?.role !== 'admin' && playlist.userId !== req.user?.id)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      db.transaction((tx) => {
        tx.delete(customCategoryItems).where(eq(customCategoryItems.customCategoryId, id)).run();
        tx.delete(customCategories).where(eq(customCategories.id, id)).run();
      });

      res.json({ success: true });
    } catch (e: any) {
      log("Failed to delete custom category: " + e.message);
      res.status(500).json({ error: "Failed to delete custom category" });
    }
  });

  // --- Custom Category Items CRUD ---

  router.get("/custom-category-items", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const playlistId = req.verifiedPlaylistId!;
    const db = getDb();
    const docs = db.select().from(customCategoryItems).where(eq(customCategoryItems.playlistId, playlistId)).all();
    res.json(docs);
  });

  router.post("/custom-category-items", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const db = getDb();
    const playlistId = req.verifiedPlaylistId!;
    const { customCategoryId, type, upstreamStreamId, upstreamSourceId, streamId, extra } = req.body;

    if (!customCategoryId) {
      return res.status(400).json({ error: "customCategoryId is required" });
    }
    if (!type || !['live', 'vod', 'series'].includes(type)) {
      return res.status(400).json({ error: "Invalid or missing item type (must be live, vod, or series)" });
    }

    try {
      // If customCategoryId references an existing customCategory, ensure it belongs to this playlist
      const rawCatId = customCategoryId.startsWith('custom_') ? customCategoryId.slice(7) : customCategoryId;
      const category = db.select().from(customCategories)
        .where(eq(customCategories.id, rawCatId))
        .get();

      if (category && category.playlistId !== playlistId) {
        return res.status(403).json({ error: "customCategoryId does not belong to the verified playlist" });
      }

      const newId = generateId();
      const safeStreamId = streamId ? String(streamId) : String(Math.floor(100000000 + Math.random() * 900000000));

      db.insert(customCategoryItems).values({
        id: newId,
        customCategoryId,
        playlistId,
        type,
        upstreamStreamId: upstreamStreamId !== undefined ? String(upstreamStreamId) : '',
        upstreamSourceId: upstreamSourceId !== undefined ? String(upstreamSourceId) : '',
        streamId: safeStreamId,
        extra: (extra && typeof extra === 'object') ? extra : {}
      }).run();

      res.status(201).json({
        id: newId,
        customCategoryId,
        playlistId,
        type,
        upstreamStreamId: upstreamStreamId !== undefined ? String(upstreamStreamId) : '',
        upstreamSourceId: upstreamSourceId !== undefined ? String(upstreamSourceId) : '',
        streamId: safeStreamId,
        extra: (extra && typeof extra === 'object') ? extra : {}
      });
    } catch (e: any) {
      log("Failed to insert custom category item: " + e.message);
      res.status(500).json({ error: "Failed to create custom category item" });
    }
  });

  router.post("/custom-category-items/batch", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const db = getDb();
    const playlistId = req.verifiedPlaylistId!;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required and must not be empty" });
    }

    // Pre-validate all items before database operations
    for (const item of items) {
      if (!item || !item.customCategoryId || !item.type || !['live', 'vod', 'series'].includes(item.type)) {
        return res.status(400).json({ error: "Each item requires customCategoryId and a valid type ('live', 'vod', or 'series')" });
      }
    }

    try {
      // If any customCategoryId references an existing customCategory, ensure it belongs to this playlist
      const rawCatIds = [...new Set(items.map(i => i.customCategoryId.startsWith('custom_') ? i.customCategoryId.slice(7) : i.customCategoryId).filter(Boolean))];
      if (rawCatIds.length > 0) {
        const matchedCats = db.select({ id: customCategories.id, playlistId: customCategories.playlistId })
          .from(customCategories)
          .where(inArray(customCategories.id, rawCatIds))
          .all();
        const foreignCat = matchedCats.find(c => c.playlistId !== playlistId);
        if (foreignCat) {
          return res.status(403).json({ error: `Category ${foreignCat.id} does not belong to this playlist` });
        }
      }

      db.transaction((tx) => {
        for (const item of items) {
          const safeStreamId = item.streamId ? String(item.streamId) : String(Math.floor(100000000 + Math.random() * 900000000));
          tx.insert(customCategoryItems).values({
            id: generateId(),
            customCategoryId: item.customCategoryId,
            playlistId,
            type: item.type,
            upstreamStreamId: item.upstreamStreamId !== undefined ? String(item.upstreamStreamId) : '',
            upstreamSourceId: item.upstreamSourceId !== undefined ? String(item.upstreamSourceId) : '',
            streamId: safeStreamId,
            extra: (item.extra && typeof item.extra === 'object') ? item.extra : {}
          }).run();
        }
      });

      res.json({ success: true, count: items.length });
    } catch (e: any) {
      log("Failed to batch insert custom category items: " + e.message);
      res.status(500).json({ error: "Failed to batch insert items" });
    }
  });

  router.delete("/custom-category-items/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id } = req.params;

    try {
      const result = db.select({
        doc: customCategoryItems,
        playlist: playlists
      })
      .from(customCategoryItems)
      .leftJoin(playlists, eq(playlists.id, customCategoryItems.playlistId))
      .where(eq(customCategoryItems.id, id))
      .get();

      if (!result || !result.doc) return res.status(404).json({ error: "Not found" });

      const { doc, playlist } = result;

      if (!playlist || (req.user?.role !== 'admin' && playlist.userId !== req.user?.id)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      db.delete(customCategoryItems).where(eq(customCategoryItems.id, id)).run();
      res.json({ success: true });
    } catch (e: any) {
      log("Failed to delete custom category item: " + e.message);
      res.status(500).json({ error: "Failed to delete custom category item" });
    }
  });

  return router;
}
