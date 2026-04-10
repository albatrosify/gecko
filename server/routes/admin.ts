import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb } from "../db.ts";
import { log } from "../logger.ts";

export function createAdminRouter() {
  const router = Router();

  // =====================================
  // Admin: User Management
  // =====================================
  router.get("/admin/users", requireAuth, async (req: AuthRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
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
  });

  router.delete("/admin/users/:id", requireAuth, async (req: AuthRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
    const db = getDb();
    const userId = req.params.id;

    if (userId === req.user.id) {
      return res.status(400).json({ error: "Cannot delete yourself" });
    }

    // Cascade delete
    const { eq, inArray } = await import('drizzle-orm');
    const { users: schemaUsers, playlists: schemaPlaylists, mappings: schemaMappings, categoryMappings: schemaCategoryMappings, sources: schemaSources } = await import('../schema.ts');

    const userPlaylists = db.select({ id: schemaPlaylists.id }).from(schemaPlaylists).where(eq(schemaPlaylists.userId, userId)).all();
    const playlistIds = userPlaylists.map(p => p.id);

    db.transaction((tx) => {
      tx.delete(schemaUsers).where(eq(schemaUsers.id, userId)).run();
      tx.delete(schemaPlaylists).where(eq(schemaPlaylists.userId, userId)).run();
      if (playlistIds.length > 0) {
        tx.delete(schemaMappings).where(inArray(schemaMappings.playlistId, playlistIds)).run();
        tx.delete(schemaCategoryMappings).where(inArray(schemaCategoryMappings.playlistId, playlistIds)).run();
      }
      tx.delete(schemaSources).where(eq(schemaSources.userId, userId)).run();
    });

    log(`Admin deleted user ${userId} and all associated data`);
    res.json({ success: true });
  });

  return router;
}
