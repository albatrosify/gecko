import { Router } from "express";
import fs from "fs";
import axios from "axios";
import { requireAuth } from "../auth.ts";
import { getDb } from "../db.ts";
import { LOG_PATH } from "../logger.ts";
import { proxyStats } from "../proxy-stats.ts";
import { invalidateQualityFormatCache } from "../quality-scan.ts";

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

export function createSystemRouter() {
  const router = Router();

  // Public IP lookup (server-side so it reflects the VPN's IP)
  let ipCache: { data: any; expiresAt: number } | null = null;
  router.get("/system/ip", requireAuth, async (req, res) => {
    try {
      const now = Date.now();
      if (ipCache && now < ipCache.expiresAt) {
        return res.json(ipCache.data);
      }
      const response = await axios.get('http://ipinfo.io/json', { timeout: 10000 });
      const { ip, country, city, org } = response.data;
      const data = { ip, country, city, org };
      ipCache = { data, expiresAt: now + 30_000 };
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to reach ipinfo.io: ' + err.message });
    }
  });

  // System Logs
  router.get("/system/logs", requireAuth, async (req, res) => {
    try {
      const data = await fs.promises.readFile(LOG_PATH, "utf-8");
      const lines = data.split("\n").filter(l => l.trim() !== "");
      const tail = lines.slice(-200).join("\n");
      res.json({ logs: tail });
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return res.json({ logs: "" });
      }
      res.status(500).json({ error: "Failed to read logs: " + err.message });
    }
  });

  router.get("/proxy/stats", requireAuth, async (req, res) => {
    try {
      const db = getDb();
      const { playlists, users } = await import('../schema.ts');
      const { count, eq } = await import('drizzle-orm');

      const playlistsCount = db.select({ value: count() }).from(playlists).get()?.value || 0;
      const usersCount = db.select({ value: count() }).from(users).get()?.value || 0;
      const directStreamsCount = db.select({ value: count() }).from(playlists).where(eq(playlists.directStreams, true)).get()?.value || 0;

      res.json({
        activeStreams: proxyStats.activeStreams,
        totalBytes: proxyStats.totalBytes,
        currentBps: proxyStats.currentBps,
        history: proxyStats.history,
        totalPlaylists: playlistsCount,
        totalUsers: usersCount,
        directStreamsCount,
        connections: Array.from(proxyStats.connections.values()),
      });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  router.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/version", (req, res) => {
    res.json({ version: pkg.version });
  });

  // Settings
  router.get("/settings", requireAuth, async (_req, res) => {
    const db = getDb();
    const { settings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    const doc = db.select().from(settings).where(eq(settings.id, 'global')).get();
    const extra = (doc?.extra as any) || {};
    res.json({
      qualityLabelFormat: extra.qualityLabelFormat ?? '{surround::exists["[{surround}] "||""]}{hdr::exists["[{hdr}] "||""]}[{label}]',
    });
  });

  router.patch("/settings", requireAuth, async (req: any, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const db = getDb();
    const { settings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    const { qualityLabelFormat } = req.body;

    if (typeof qualityLabelFormat !== 'string' || qualityLabelFormat.length > 200) {
      return res.status(400).json({ error: 'qualityLabelFormat must be a string ≤ 200 characters' });
    }

    db.insert(settings)
      .values({ id: 'global', extra: { qualityLabelFormat } })
      .onConflictDoUpdate({ target: settings.id, set: { extra: { qualityLabelFormat } } })
      .run();

    invalidateQualityFormatCache();
    res.json({ success: true });
  });

  return router;
}
