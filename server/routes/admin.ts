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

    const userIds = users.map((u) => u._id.toString());
    const playlistCounts = await db.collection('playlists').aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: "$userId", count: { $sum: 1 } } }
    ]).toArray();

    const countMap = playlistCounts.reduce((acc, curr) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {} as Record<string, number>);

    const userList = users.map((u) => ({
      ...docWithId(u),
      playlistCount: countMap[u._id.toString()] || 0
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
