import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { log } from "../logger.ts";
import { and, eq } from 'drizzle-orm';
import { customCategories, customCategoryItems, playlists } from '../schema.ts';

export function createCustomCategoriesRouter() {
  const router = Router();

  // Middleware to ensure user owns the playlist
  const verifyPlaylistOwnership = async (req: AuthRequest, res: any, next: any) => {
    const playlistId = req.query.playlistId || req.body.playlistId || req.params.playlistId;
    if (!playlistId) return res.status(400).json({ error: "playlistId required" });

    const db = getDb();
    const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId as string)).get();

    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    if (req.user?.role !== 'admin' && playlist.userId !== req.user?.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };

  // --- Custom Categories CRUD ---

  router.get("/custom-categories", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    const db = getDb();
    const docs = db.select().from(customCategories).where(eq(customCategories.playlistId, playlistId as string)).all();
    res.json(docs);
  });

  router.post("/custom-categories", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const db = getDb();
    const newId = generateId();
    const { playlistId, type, name, order, hidden } = req.body;

    db.insert(customCategories).values({
      id: newId,
      playlistId,
      type,
      name,
      order: order ?? 0,
      hidden: hidden ?? false
    }).run();

    res.status(201).json({ id: newId, playlistId, type, name, order: order ?? 0, hidden: hidden ?? false });
  });

  router.put("/custom-categories/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id } = req.params;

    const doc = db.select().from(customCategories).where(eq(customCategories.id, id)).get();
    if (!doc) return res.status(404).json({ error: "Not found" });

    // Ownership check via playlist
    const playlist = db.select().from(playlists).where(eq(playlists.id, doc.playlistId)).get();
    if (!playlist || (req.user?.role !== 'admin' && playlist.userId !== req.user?.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { name, order, hidden } = req.body;
    db.update(customCategories).set({
      name: name !== undefined ? name : doc.name,
      order: order !== undefined ? order : doc.order,
      hidden: hidden !== undefined ? hidden : doc.hidden
    }).where(eq(customCategories.id, id)).run();

    res.json({ success: true });
  });

  router.delete("/custom-categories/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id } = req.params;

    const doc = db.select().from(customCategories).where(eq(customCategories.id, id)).get();
    if (!doc) return res.status(404).json({ error: "Not found" });

    const playlist = db.select().from(playlists).where(eq(playlists.id, doc.playlistId)).get();
    if (!playlist || (req.user?.role !== 'admin' && playlist.userId !== req.user?.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    db.transaction((tx) => {
      tx.delete(customCategoryItems).where(eq(customCategoryItems.customCategoryId, id)).run();
      tx.delete(customCategories).where(eq(customCategories.id, id)).run();
    });

    res.json({ success: true });
  });

  // --- Custom Category Items CRUD ---

  router.get("/custom-category-items", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    const db = getDb();
    const docs = db.select().from(customCategoryItems).where(eq(customCategoryItems.playlistId, playlistId as string)).all();
    res.json(docs);
  });

  router.post("/custom-category-items", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const db = getDb();
    const newId = generateId();
    const { customCategoryId, playlistId, type, upstreamStreamId, upstreamSourceId, streamId, extra } = req.body;

    db.insert(customCategoryItems).values({
      id: newId,
      customCategoryId,
      playlistId,
      type,
      upstreamStreamId,
      upstreamSourceId,
      streamId,
      extra: extra || {}
    }).run();

    res.status(201).json({ id: newId, customCategoryId, playlistId, type, upstreamStreamId, upstreamSourceId, streamId, extra });
  });

  router.post("/custom-category-items/batch", requireAuth, verifyPlaylistOwnership, (req: AuthRequest, res) => {
    const db = getDb();
    const { items } = req.body; // Array of items

    db.transaction((tx) => {
      for (const item of items) {
        tx.insert(customCategoryItems).values({
          id: generateId(),
          customCategoryId: item.customCategoryId,
          playlistId: item.playlistId,
          type: item.type,
          upstreamStreamId: item.upstreamStreamId,
          upstreamSourceId: item.upstreamSourceId,
          streamId: item.streamId, // generated on client or server
          extra: item.extra || {}
        }).run();
      }
    });

    res.json({ success: true, count: items.length });
  });

  router.delete("/custom-category-items/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id } = req.params;

    const doc = db.select().from(customCategoryItems).where(eq(customCategoryItems.id, id)).get();
    if (!doc) return res.status(404).json({ error: "Not found" });

    const playlist = db.select().from(playlists).where(eq(playlists.id, doc.playlistId)).get();
    if (!playlist || (req.user?.role !== 'admin' && playlist.userId !== req.user?.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    db.delete(customCategoryItems).where(eq(customCategoryItems.id, id)).run();
    res.json({ success: true });
  });

  return router;
}
