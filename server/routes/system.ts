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

      // Check Gluetun first if available
      const { getGluetunStatus } = await import("../vpn.ts");
      const gluetun = await getGluetunStatus();
      if (gluetun.configured && gluetun.publicIp) {
        const data = {
          ip: gluetun.publicIp,
          country: gluetun.country || '',
          city: gluetun.city || '',
          org: gluetun.organization || '',
        };
        ipCache = { data, expiresAt: now + 30_000 };
        return res.json(data);
      }

      const response = await axios.get('http://ipinfo.io/json', { timeout: 10000 });
      const { ip, country, city, org } = response.data;
      const data = { ip, country, city, org };
      ipCache = { data, expiresAt: now + 30_000 };
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to reach IP service: ' + err.message });
    }
  });

  // VPN Status & Diagnostics
  router.get("/system/vpn", requireAuth, async (req, res) => {
    try {
      const { getGluetunStatus } = await import("../vpn.ts");
      const status = await getGluetunStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to query VPN status: ' + err.message });
    }
  });

  // VPN Reconnect / Rotate
  router.post("/system/vpn/reconnect", requireAuth, async (req, res) => {
    try {
      const { reconnectGluetun } = await import("../vpn.ts");
      const result = await reconnectGluetun();
      ipCache = null; // Invalidate IP cache immediately
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to reconnect VPN' });
    }
  });

  // System Logs
  router.get("/system/logs", requireAuth, async (req, res) => {
    try {
      const data = await fs.promises.readFile(LOG_PATH, "utf-8");
      const lines = data.split("\n").filter(l => l.trim() !== "");
      const limit = Math.min(2000, Math.max(50, parseInt(req.query.limit as string || '500', 10)));
      const tail = lines.slice(-limit).join("\n");
      res.json({ logs: tail, totalLines: lines.length });
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return res.json({ logs: "", totalLines: 0 });
      }
      res.status(500).json({ error: "Failed to read logs: " + err.message });
    }
  });

  router.get("/proxy/stats", requireAuth, async (req, res) => {
    try {
      const db = getDb();
      const { playlists, users } = await import('../schema.ts');
      const { count, eq } = await import('drizzle-orm');
      const { getCacheStats } = await import('../cache.ts');

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
        cache: getCacheStats(),
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
      telegramBotToken: extra.telegramBotToken ?? '',
      telegramChatId: extra.telegramChatId ?? '',
      telegramEnabled: Boolean(extra.telegramEnabled),
    });
  });

  router.patch("/settings", requireAuth, async (req: any, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const db = getDb();
    const { settings } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    const { qualityLabelFormat, telegramBotToken, telegramChatId, telegramEnabled } = req.body;

    if (qualityLabelFormat !== undefined && (typeof qualityLabelFormat !== 'string' || qualityLabelFormat.length > 200)) {
      return res.status(400).json({ error: 'qualityLabelFormat must be a string ≤ 200 characters' });
    }
    if (telegramBotToken !== undefined && typeof telegramBotToken !== 'string') {
      return res.status(400).json({ error: 'telegramBotToken must be a string' });
    }
    if (telegramChatId !== undefined && typeof telegramChatId !== 'string') {
      return res.status(400).json({ error: 'telegramChatId must be a string' });
    }
    if (telegramEnabled !== undefined && typeof telegramEnabled !== 'boolean') {
      return res.status(400).json({ error: 'telegramEnabled must be a boolean' });
    }

    const currentSettings = db.select().from(settings).where(eq(settings.id, 'global')).get();
    const currentExtra = (currentSettings?.extra as any) || {};
    const mergedExtra = {
      ...currentExtra,
      ...(qualityLabelFormat !== undefined ? { qualityLabelFormat } : {}),
      ...(telegramBotToken !== undefined ? { telegramBotToken: telegramBotToken.trim() } : {}),
      ...(telegramChatId !== undefined ? { telegramChatId: telegramChatId.trim() } : {}),
      ...(telegramEnabled !== undefined ? { telegramEnabled } : {}),
    };

    db.insert(settings)
      .values({ id: 'global', extra: mergedExtra })
      .onConflictDoUpdate({ target: settings.id, set: { extra: mergedExtra } })
      .run();

    if (qualityLabelFormat !== undefined) {
      invalidateQualityFormatCache();
    }
    res.json({ success: true });
  });

  router.post("/settings/telegram/test", requireAuth, async (req: any, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { botToken, chatId } = req.body || {};
    const { testTelegramNotification } = await import('../telegram.ts');
    const result = await testTelegramNotification(botToken, chatId);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.error || 'Failed to send Telegram test message' });
    }
  });

  return router;
}
