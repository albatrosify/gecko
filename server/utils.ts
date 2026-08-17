import express from "express";
import { log } from "./logger.ts";
import { DEFAULT_PORT } from "./config.ts";

export const getClientInfo = (req: express.Request) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'no-ua';
  return `[${ip}] ${ua}`;
};

/** Centralize base URL construction for all proxying and exports. */
export function getBaseUrl(req: express.Request): string {
  if (process.env.APP_URL && !process.env.APP_URL.includes('YOUR_LAN_IP')) {
    return process.env.APP_URL.replace(/\/$/, '');
  }

  const protocol = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString();
  const hostHeader = (req.headers['x-forwarded-host'] || req.get('host') || `localhost:${DEFAULT_PORT}`).toString();

  return `${protocol}://${hostHeader}`;
}

/** Rewrite an upstream image URL to go through the local /img proxy. */
export function proxyImageUrl(url: string | null | undefined, base: string): string {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url || '';
  return `${base}/img?url=${encodeURIComponent(url)}`;
}

/** Recursively proxy image URLs in Xtream series/VOD info payloads. */
export function proxySeriesInfoImages(data: any, imgBase: string): any {
  if (!data || typeof data !== 'object') return data;

  if (data.info) {
    if (data.info.cover) data.info.cover = proxyImageUrl(data.info.cover, imgBase);
    if (data.info.movie_image) data.info.movie_image = proxyImageUrl(data.info.movie_image, imgBase);

    if (Array.isArray(data.info.backdrop_path)) {
      data.info.backdrop_path = data.info.backdrop_path.map((u: string) => proxyImageUrl(u, imgBase));
    } else if (typeof data.info.backdrop_path === 'string') {
      data.info.backdrop_path = proxyImageUrl(data.info.backdrop_path, imgBase);
    }
  }

  // Episode icons
  if (data.episodes && typeof data.episodes === 'object') {
    for (const season of Object.values(data.episodes)) {
      if (Array.isArray(season)) {
        for (const ep of season) {
          if (ep.info?.movie_image) ep.info.movie_image = proxyImageUrl(ep.info.movie_image, imgBase);
        }
      }
    }
  }

  return data;
}

/** Rewrite <icon src="..."> tags in XMLTV to use the image proxy. */
export function proxyXmlIcons(xml: string, imgBase: string): string {
  // Matches <icon\b ... src="http..." ... /> or <icon>...</icon>
  // We use a more robust regex that handles arbitrary attribute order
  return xml.replace(/<icon\b([^>]*)\bsrc=["'](https?:\/\/[^"']+)["']([^>\/]*)\/?>/gi, (match, before, url, after) => {
    return `<icon${before}src="${proxyImageUrl(url, imgBase)}"${after}/>`;
  });
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

/**
 * Parse and normalize Xtream/IPTV account expiration date.
 * Returns an ISO date string or null if unlimited / not set.
 */
export function parseXtreamExpDate(rawExpDate: any): string | null {
  if (rawExpDate === null || rawExpDate === undefined) return null;
  const str = String(rawExpDate).trim();
  if (!str || str === '0' || str.toLowerCase() === 'null' || str.toLowerCase() === 'unlimited' || str.toLowerCase() === 'never') {
    return null;
  }

  // Check if it is a pure numeric timestamp
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    if (num <= 0) return null;
    // If timestamp is < 100,000,000,000 (11 digits), it's in seconds.
    const ms = num < 100000000000 ? num * 1000 : num;
    const date = new Date(ms);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  // Try parsing direct ISO / date string
  const parsedDirect = new Date(str);
  if (!isNaN(parsedDirect.getTime())) {
    return parsedDirect.toISOString();
  }

  // Try replacing spaces with 'T' for "YYYY-MM-DD HH:mm:ss" formats
  const parsedIso = new Date(str.replace(' ', 'T'));
  if (!isNaN(parsedIso.getTime())) {
    return parsedIso.toISOString();
  }

  return null;
}

