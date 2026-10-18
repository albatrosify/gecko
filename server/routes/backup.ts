import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb } from "../db.ts";
import { log } from "../logger.ts";
import { eq } from "drizzle-orm";
import {
  playlists as schemaPlaylists,
  sources as schemaSources,
  mappings as schemaMappings,
  categoryMappings as schemaCategoryMappings,
  customCategories as schemaCustomCategories,
  customCategoryItems as schemaCustomCategoryItems,
  settings as schemaSettings,
} from "../schema.ts";

export function createBackupRouter() {
  const router = Router();

  // Export full configuration or single playlist
  router.get("/backup/export", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const playlistId = req.query.playlistId as string | undefined;
      const isAdmin = req.user?.role === "admin";
      const userId = req.user!.id;

      if (playlistId) {
        const playlist = db
          .select()
          .from(schemaPlaylists)
          .where(eq(schemaPlaylists.id, playlistId))
          .get();

        if (!playlist) {
          return res.status(404).json({ error: "Playlist not found" });
        }
        if (!isAdmin && playlist.userId !== userId) {
          return res.status(403).json({ error: "Access denied" });
        }

        const mappings = db
          .select()
          .from(schemaMappings)
          .where(eq(schemaMappings.playlistId, playlistId))
          .all();

        const categoryMappings = db
          .select()
          .from(schemaCategoryMappings)
          .where(eq(schemaCategoryMappings.playlistId, playlistId))
          .all();

        const customCategories = db
          .select()
          .from(schemaCustomCategories)
          .where(eq(schemaCustomCategories.playlistId, playlistId))
          .all();

        const customCategoryItems = db
          .select()
          .from(schemaCustomCategoryItems)
          .where(eq(schemaCustomCategoryItems.playlistId, playlistId))
          .all();

        return res.json({
          version: 2,
          type: "playlist",
          exportedAt: new Date().toISOString(),
          playlist,
          mappings,
          categoryMappings,
          customCategories,
          customCategoryItems,
        });
      }

      // Full export
      const playlists = isAdmin
        ? db.select().from(schemaPlaylists).all()
        : db
            .select()
            .from(schemaPlaylists)
            .where(eq(schemaPlaylists.userId, userId))
            .all();

      const sources = isAdmin
        ? db.select().from(schemaSources).all()
        : db
            .select()
            .from(schemaSources)
            .where(eq(schemaSources.userId, userId))
            .all();

      const playlistIds = new Set(playlists.map((p) => p.id));
      const allMappings = db
        .select()
        .from(schemaMappings)
        .all()
        .filter((m) => playlistIds.has(m.playlistId));

      const allCategoryMappings = db
        .select()
        .from(schemaCategoryMappings)
        .all()
        .filter((cm) => playlistIds.has(cm.playlistId));

      const allCustomCategories = db
        .select()
        .from(schemaCustomCategories)
        .all()
        .filter((cc) => playlistIds.has(cc.playlistId));

      const allCustomCategoryItems = db
        .select()
        .from(schemaCustomCategoryItems)
        .all()
        .filter((cci) => playlistIds.has(cci.playlistId));

      const settings = isAdmin
        ? db
            .select()
            .from(schemaSettings)
            .where(eq(schemaSettings.id, "global"))
            .get()?.extra || null
        : null;

      res.json({
        version: 2,
        type: "full",
        exportedAt: new Date().toISOString(),
        sources,
        playlists,
        mappings: allMappings,
        categoryMappings: allCategoryMappings,
        customCategories: allCustomCategories,
        customCategoryItems: allCustomCategoryItems,
        settings,
      });
    } catch (e: any) {
      log(`[Backup] Export failed: ${e.message}`);
      res.status(500).json({ error: "Export failed: " + e.message });
    }
  });

  // Import configuration (supports full or playlist backup)
  router.post("/backup/import", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const payload = req.body;
      const isAdmin = req.user?.role === "admin";
      const userId = req.user!.id;

      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ error: "Invalid backup JSON payload" });
      }

      if (payload.playlist) {
        // Playlist backup
        const playlist = payload.playlist;
        if (!isAdmin) {
          playlist.userId = userId;
        }

        // Upsert playlist
        const existing = db
          .select()
          .from(schemaPlaylists)
          .where(eq(schemaPlaylists.id, playlist.id))
          .get();

        if (existing) {
          db.update(schemaPlaylists)
            .set(playlist)
            .where(eq(schemaPlaylists.id, playlist.id))
            .run();
        } else {
          db.insert(schemaPlaylists).values(playlist).run();
        }

        // Mappings
        if (Array.isArray(payload.mappings)) {
          for (const m of payload.mappings) {
            const ext = db
              .select()
              .from(schemaMappings)
              .where(eq(schemaMappings.id, m.id))
              .get();
            if (ext) {
              db.update(schemaMappings)
                .set(m)
                .where(eq(schemaMappings.id, m.id))
                .run();
            } else {
              db.insert(schemaMappings).values(m).run();
            }
          }
        }

        // Category Mappings
        if (Array.isArray(payload.categoryMappings)) {
          for (const cm of payload.categoryMappings) {
            const ext = db
              .select()
              .from(schemaCategoryMappings)
              .where(eq(schemaCategoryMappings.id, cm.id))
              .get();
            if (ext) {
              db.update(schemaCategoryMappings)
                .set(cm)
                .where(eq(schemaCategoryMappings.id, cm.id))
                .run();
            } else {
              db.insert(schemaCategoryMappings).values(cm).run();
            }
          }
        }

        // Custom Categories
        if (Array.isArray(payload.customCategories)) {
          for (const cc of payload.customCategories) {
            const ext = db
              .select()
              .from(schemaCustomCategories)
              .where(eq(schemaCustomCategories.id, cc.id))
              .get();
            if (ext) {
              db.update(schemaCustomCategories)
                .set(cc)
                .where(eq(schemaCustomCategories.id, cc.id))
                .run();
            } else {
              db.insert(schemaCustomCategories).values(cc).run();
            }
          }
        }

        // Custom Category Items
        if (Array.isArray(payload.customCategoryItems)) {
          for (const cci of payload.customCategoryItems) {
            const ext = db
              .select()
              .from(schemaCustomCategoryItems)
              .where(eq(schemaCustomCategoryItems.id, cci.id))
              .get();
            if (ext) {
              db.update(schemaCustomCategoryItems)
                .set(cci)
                .where(eq(schemaCustomCategoryItems.id, cci.id))
                .run();
            } else {
              db.insert(schemaCustomCategoryItems).values(cci).run();
            }
          }
        }

        return res.json({
          success: true,
          imported: {
            playlists: 1,
            mappings: payload.mappings?.length || 0,
            categoryMappings: payload.categoryMappings?.length || 0,
            customCategories: payload.customCategories?.length || 0,
            customCategoryItems: payload.customCategoryItems?.length || 0,
          },
        });
      }

      // Full backup import
      if (Array.isArray(payload.sources)) {
        for (const s of payload.sources) {
          if (!isAdmin) s.userId = userId;
          const ext = db
            .select()
            .from(schemaSources)
            .where(eq(schemaSources.id, s.id))
            .get();
          if (ext) {
            db.update(schemaSources)
              .set(s)
              .where(eq(schemaSources.id, s.id))
              .run();
          } else {
            db.insert(schemaSources).values(s).run();
          }
        }
      }

      if (Array.isArray(payload.playlists)) {
        for (const p of payload.playlists) {
          if (!isAdmin) p.userId = userId;
          const ext = db
            .select()
            .from(schemaPlaylists)
            .where(eq(schemaPlaylists.id, p.id))
            .get();
          if (ext) {
            db.update(schemaPlaylists)
              .set(p)
              .where(eq(schemaPlaylists.id, p.id))
              .run();
          } else {
            db.insert(schemaPlaylists).values(p).run();
          }
        }
      }

      if (Array.isArray(payload.mappings)) {
        for (const m of payload.mappings) {
          const ext = db
            .select()
            .from(schemaMappings)
            .where(eq(schemaMappings.id, m.id))
            .get();
          if (ext) {
            db.update(schemaMappings)
              .set(m)
              .where(eq(schemaMappings.id, m.id))
              .run();
          } else {
            db.insert(schemaMappings).values(m).run();
          }
        }
      }

      if (Array.isArray(payload.categoryMappings)) {
        for (const cm of payload.categoryMappings) {
          const ext = db
            .select()
            .from(schemaCategoryMappings)
            .where(eq(schemaCategoryMappings.id, cm.id))
            .get();
          if (ext) {
            db.update(schemaCategoryMappings)
              .set(cm)
              .where(eq(schemaCategoryMappings.id, cm.id))
              .run();
          } else {
            db.insert(schemaCategoryMappings).values(cm).run();
          }
        }
      }

      if (Array.isArray(payload.customCategories)) {
        for (const cc of payload.customCategories) {
          const ext = db
            .select()
            .from(schemaCustomCategories)
            .where(eq(schemaCustomCategories.id, cc.id))
            .get();
          if (ext) {
            db.update(schemaCustomCategories)
              .set(cc)
              .where(eq(schemaCustomCategories.id, cc.id))
              .run();
          } else {
            db.insert(schemaCustomCategories).values(cc).run();
          }
        }
      }

      if (Array.isArray(payload.customCategoryItems)) {
        for (const cci of payload.customCategoryItems) {
          const ext = db
            .select()
            .from(schemaCustomCategoryItems)
            .where(eq(schemaCustomCategoryItems.id, cci.id))
            .get();
          if (ext) {
            db.update(schemaCustomCategoryItems)
              .set(cci)
              .where(eq(schemaCustomCategoryItems.id, cci.id))
              .run();
          } else {
            db.insert(schemaCustomCategoryItems).values(cci).run();
          }
        }
      }

      if (isAdmin && payload.settings) {
        db.insert(schemaSettings)
          .values({ id: "global", extra: payload.settings })
          .onConflictDoUpdate({
            target: schemaSettings.id,
            set: { extra: payload.settings },
          })
          .run();
      }

      res.json({
        success: true,
        imported: {
          sources: payload.sources?.length || 0,
          playlists: payload.playlists?.length || 0,
          mappings: payload.mappings?.length || 0,
          categoryMappings: payload.categoryMappings?.length || 0,
          customCategories: payload.customCategories?.length || 0,
          customCategoryItems: payload.customCategoryItems?.length || 0,
        },
      });
    } catch (e: any) {
      log(`[Backup] Import failed: ${e.message}`);
      res.status(500).json({ error: "Import failed: " + e.message });
    }
  });

  return router;
}
