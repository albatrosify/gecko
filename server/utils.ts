import express from "express";
import { log } from "./logger.ts";

export const getClientInfo = (req: express.Request) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'no-ua';
  return `[${ip}] ${ua}`;
};

/** Rewrite an upstream image URL to go through the local /img proxy. */
export function proxyImageUrl(url: string | null | undefined, base: string): string {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url || '';
  return `${base}/img?url=${encodeURIComponent(url)}`;
}

// Helper to apply regex
export const applyRegex = (name: string, rules: { pattern: string; replacement: string }[]) => {
  let result = name;
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, 'g');
      result = result.replace(regex, rule.replacement);
    } catch (e) {
      log(`Invalid regex: ${rule.pattern}`);
    }
  }
  return result;
};
