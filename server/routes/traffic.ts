import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getTrafficStats, resetTrafficStats } from "../traffic.ts";

export function createTrafficRouter() {
  const router = Router();

  /**
   * GET /api/traffic/stats
   * Query params:
   *  - startDate (YYYY-MM-DD, optional)
   *  - endDate (YYYY-MM-DD, optional)
   */
  router.get("/stats", requireAuth, async (req: AuthRequest, res) => {
    try {
      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;
      const data = getTrafficStats(startDate, endDate);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: `Failed to fetch traffic stats: ${err.message}` });
    }
  });

  /**
   * POST /api/traffic/reset
   * Body:
   *  - playlistId (optional, to reset only a specific playlist)
   * Admin only
   */
  router.post("/reset", requireAuth, async (req: AuthRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    try {
      const playlistId = typeof req.body.playlistId === 'string' ? req.body.playlistId : undefined;
      resetTrafficStats(playlistId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: `Failed to reset traffic stats: ${err.message}` });
    }
  });

  return router;
}
