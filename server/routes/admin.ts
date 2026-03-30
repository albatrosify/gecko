import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, toId, docWithId } from "../db.ts";
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
    const users = await db.collection('users').find({}, { projection: { password: 0 } }).toArray();

    const userList = await Promise.all(users.map(async (u) => {
      const playlistCount = await db.collection('playlists').countDocuments({ userId: u._id.toString() });
      return {
        ...docWithId(u),
        playlistCount
      };
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
    const userPlaylists = await db.collection('playlists').find({ userId }).toArray();
    const playlistIds = userPlaylists.map(p => p._id.toString());

    await Promise.all([
      db.collection('users').deleteOne({ _id: toId(userId) }),
      db.collection('playlists').deleteMany({ userId }),
      db.collection('mappings').deleteMany({ playlistId: { $in: playlistIds } }),
      db.collection('categoryMappings').deleteMany({ playlistId: { $in: playlistIds } }),
      db.collection('sources').deleteMany({ userId })
    ]);

    log(`Admin deleted user ${userId} and all associated data`);
    res.json({ success: true });
  });

  return router;
}
