import { Router } from "express";
import { requireAuth } from "../auth.ts";
import { log } from "../logger.ts";
import {
  getLlmSettings,
  cleanNamesWithLlm,
  testLlmConnection,
  LlmSettings,
} from "../llm.ts";

export function createLlmRouter() {
  const router = Router();

  router.post("/llm/cleanup", requireAuth, async (req: any, res) => {
    try {
      const { items, systemPrompt } = req.body || {};
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "items array required" });
      }
      if (items.length > 2000) {
        return res.status(400).json({ error: "Too many items (max 2000)" });
      }

      const normalized = items
        .map((it: any) => ({ id: String(it?.id ?? ""), name: String(it?.name ?? "").trim() }))
        .filter((it: any) => it.name);

      if (normalized.length === 0) {
        return res.status(400).json({ error: "No valid names provided" });
      }

      const cfg = await getLlmSettings();
      if (!cfg.enabled || !cfg.url) {
        return res.status(400).json({ error: "LLM cleanup is not configured. Add an endpoint in Settings." });
      }

      const effective: LlmSettings = systemPrompt
        ? { ...cfg, systemPrompt: String(systemPrompt) }
        : cfg;

      const results = await cleanNamesWithLlm(normalized, effective);
      res.json({ results });
    } catch (err: any) {
      log(`[llm cleanup] error: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || "LLM cleanup failed" });
    }
  });

  router.post("/llm/test", requireAuth, async (req: any, res) => {
    try {
      const cfg = await getLlmSettings();
      const overrides = req.body || {};
      const testCfg: LlmSettings = {
        enabled: true,
        url: overrides.url !== undefined ? String(overrides.url) : cfg.url,
        apiKey: overrides.apiKey !== undefined ? String(overrides.apiKey) : cfg.apiKey,
        model: overrides.model !== undefined ? String(overrides.model) : cfg.model,
        systemPrompt:
          overrides.systemPrompt !== undefined ? String(overrides.systemPrompt) : cfg.systemPrompt,
      };
      if (!testCfg.url) {
        return res.status(400).json({ success: false, error: "No endpoint URL configured" });
      }
      const result = await testLlmConnection(testCfg);
      if (result.success) {
        res.json({ success: true, model: result.model });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  return router;
}
