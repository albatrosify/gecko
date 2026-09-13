import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb } from "../db.ts";
import { log } from "../logger.ts";
import { activeCrons } from "../sync.ts";
import { clearConnectionLogs } from "../connection-monitor.ts";

export function createAdminRouter() {
  const router = Router();

  // =====================================
  // Admin: User Management
  // =====================================
  router.get("/admin/users", requireAuth, async (req: AuthRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const db = getDb();
      const { users: schemaUsers, playlists: schemaPlaylists } = await import('../schema.ts');

      const allUsers = db.select({
        id: schemaUsers.id,
        email: schemaUsers.email,
        role: schemaUsers.role,
        createdAt: schemaUsers.createdAt
      }).from(schemaUsers).all();

      const allPlaylists = db.select({ id: schemaPlaylists.id, userId: schemaPlaylists.userId }).from(schemaPlaylists).all();
      const countMap = allPlaylists.reduce((acc, curr) => {
        acc[curr.userId] = (acc[curr.userId] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const userList = allUsers.map((u) => ({
        ...u,
        playlistCount: countMap[u.id] || 0
      }));

      res.json(userList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Admin get users error: ${msg}`);
      res.status(500).json({ error: "Failed to retrieve users" });
    }
  });

  router.delete("/admin/users/:id", requireAuth, async (req: AuthRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
    const userId = req.params.id;

    if (userId === req.user.id) {
      return res.status(400).json({ error: "Cannot delete yourself" });
    }

    try {
      const db = getDb();
      // Cascade delete
      const { eq, inArray } = await import('drizzle-orm');
      const {
        users: schemaUsers,
        playlists: schemaPlaylists,
        mappings: schemaMappings,
        categoryMappings: schemaCategoryMappings,
        sources: schemaSources,
        epgs: schemaEpgs,
        customCategories,
        customCategoryItems,
        source_changelogs,
        source_connection_logs,
        source_host_logs,
        source_sync_meta,
        cache: schemaCache
      } = await import('../schema.ts');

      const userPlaylists = db.select({ id: schemaPlaylists.id }).from(schemaPlaylists).where(eq(schemaPlaylists.userId, userId)).all();
      const playlistIds = userPlaylists.map(p => p.id);

      const userSources = db.select({ id: schemaSources.id }).from(schemaSources).where(eq(schemaSources.userId, userId)).all();
      const sourceIds = userSources.map(s => s.id);

      for (const sid of sourceIds) {
        if (activeCrons.has(sid)) {
          activeCrons.get(sid).stop();
          activeCrons.delete(sid);
        }
        clearConnectionLogs(sid);
      }

      db.transaction((tx) => {
        tx.delete(schemaUsers).where(eq(schemaUsers.id, userId)).run();
        tx.delete(schemaPlaylists).where(eq(schemaPlaylists.userId, userId)).run();
        tx.delete(schemaEpgs).where(eq(schemaEpgs.userId, userId)).run();

        if (playlistIds.length > 0) {
          tx.delete(schemaMappings).where(inArray(schemaMappings.playlistId, playlistIds)).run();
          tx.delete(schemaCategoryMappings).where(inArray(schemaCategoryMappings.playlistId, playlistIds)).run();
          tx.delete(customCategories).where(inArray(customCategories.playlistId, playlistIds)).run();
          tx.delete(customCategoryItems).where(inArray(customCategoryItems.playlistId, playlistIds)).run();
        }

        if (sourceIds.length > 0) {
          tx.delete(source_changelogs).where(inArray(source_changelogs.sourceId, sourceIds)).run();
          tx.delete(source_connection_logs).where(inArray(source_connection_logs.sourceId, sourceIds)).run();
          tx.delete(source_host_logs).where(inArray(source_host_logs.sourceId, sourceIds)).run();
          const metaKeys: string[] = [];
          const cacheKeys: string[] = [];
          for (const sid of sourceIds) {
            metaKeys.push(`${sid}_live`, `${sid}_vod`, `${sid}_series`);
            cacheKeys.push(`${sid}_categories`, `${sid}_streams_live`, `${sid}_streams_vod`, `${sid}_streams_series`);
            cacheKeys.push(`snapshot_${sid}_live`, `snapshot_${sid}_vod`, `snapshot_${sid}_series`);
          }
          tx.delete(source_sync_meta).where(inArray(source_sync_meta.key, metaKeys)).run();
          tx.delete(schemaCache).where(inArray(schemaCache.key, cacheKeys)).run();
        }

        tx.delete(schemaSources).where(eq(schemaSources.userId, userId)).run();
      });

      log(`Admin deleted user ${userId} and all associated data`);
      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Admin delete user error: ${msg}`);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  return router;
}
