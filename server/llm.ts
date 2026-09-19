import axios from 'axios';
import https from 'https';
import http from 'http';
import { getDb } from './db.ts';
import { settings } from './schema.ts';
import { eq } from 'drizzle-orm';
import { log } from './logger.ts';

export const DEFAULT_LLM_SYSTEM_PROMPT = `You are a channel and category name cleaner for an IPTV playlist.

Given a list of names, remove noise so only the essential name remains.

REMOVE these:
- Country/language markers: "|DE|", "|EN|", "|AT|", "|CH|", "DE:", "EN:", "[DE]", etc.
- Quality/resolution tags: "HD", "FHD", "UHD", "4K", "8K", "SD", "HEVC", "H.265", "ᵁᴴᴰ", "ᵀᴹ", "[720p]", "[1080p]", "FHD+", etc.
- Bracketed or parenthetical notes: "(DURING GAMES ONLY)", "(EN)", "(A)", "[OFFLINE]", etc.
- Leading and trailing whitespace.

KEEP exactly as-is (do NOT translate, rename, or re-capitalize):
- The core station/channel name.
- All channel numbers (e.g. "Sport 6", "Bundesliga 2", "Movie 24").

Examples:
"|DE| PROSIEBEN FUN ᵁᴴᴰ" -> "PROSIEBEN FUN"
"|DE| Sky Sport Austria 6 ᵁᴴᴰ (DURING GAMES ONLY)" -> "Sky Sport Austria 6"

If a name is already clean, return it unchanged.

Respond with ONLY a JSON object in this exact format and nothing else:
{"results":[{"id":"<id>","name":"<cleaned name>"}]}`;

export interface LlmSettings {
  enabled: boolean;
  url: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export async function getLlmSettings(): Promise<LlmSettings> {
  const db = getDb();
  const doc = db.select().from(settings).where(eq(settings.id, 'global')).get();
  const extra = (doc?.extra as any) || {};
  return {
    enabled: Boolean(extra.llmEnabled),
    url: extra.llmUrl ?? '',
    apiKey: extra.llmApiKey ?? '',
    model: extra.llmModel ?? '',
    systemPrompt: extra.llmSystemPrompt ?? DEFAULT_LLM_SYSTEM_PROMPT,
  };
}

export function resolveChatEndpoint(baseUrl: string): string {
  let url = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  // Already a full chat-completions URL (e.g. OpenAI / llama.cpp).
  if (url.endsWith('/chat/completions')) return url;
  // Base URL already includes the API version path, e.g. OpenRouter
  // (https://openrouter.ai/api/v1) or DeepSeek (https://api.deepseek.com/v1).
  if (url.endsWith('/v1')) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

function parseResults(content: string): { id: string; name: string }[] {
  const text = (content || '').trim();
  if (!text) return [];

  const candidates: string[] = [];
  try {
    JSON.parse(text);
    candidates.push(text);
  } catch {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) candidates.push(objMatch[0]);
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) candidates.push(arrMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      let arr: any[] = [];
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed && Array.isArray(parsed.results)) arr = parsed.results;
      else if (parsed && typeof parsed === 'object') {
        arr = Object.entries(parsed)
          .filter(([k]) => k !== 'results')
          .map(([id, name]) => ({ id, name }));
      }
      const results = arr
        .filter((x) => x && typeof x === 'object' && (x.name != null || x.cleaned != null))
        .map((x) => ({
          id: String(x.id ?? x.index ?? ''),
          name: String((x.name ?? x.cleaned ?? '')).trim(),
        }))
        .filter((x) => x.name);
      if (results.length > 0) return results;
    } catch {
      // try next candidate
    }
  }
  return [];
}

async function chatCompletion(cfg: LlmSettings, userContent: string): Promise<string> {
  const endpoint = resolveChatEndpoint(cfg.url);
  if (!endpoint) throw new Error('LLM endpoint URL is empty');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const body: Record<string, unknown> = {
    messages: [
      { role: 'system', content: cfg.systemPrompt || DEFAULT_LLM_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
    max_tokens: 4096,
    stream: false,
  };
  if (cfg.model) body.model = cfg.model;

  // Local llama.cpp endpoints are frequently served over self-signed HTTPS.
  const isHttps = endpoint.startsWith('https://');
  const agent = isHttps ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent();

  const res = await axios.post(endpoint, body, {
    headers,
    timeout: 120000,
    ...(isHttps ? { httpsAgent: agent } : { httpAgent: agent }),
  });

  const content = res.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Unexpected LLM response format (no choices[0].message.content)');
  }
  return content;
}

export async function cleanNamesWithLlm(
  items: { id: string; name: string }[],
  cfg?: LlmSettings
): Promise<{ id: string; name: string }[]> {
  const s = cfg ?? (await getLlmSettings());
  const chunkSize = 40;
  const results: { id: string; name: string }[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const payload = chunk.map((it) => ({ id: it.id, name: it.name }));
    const userContent =
      'Clean the following names and return the JSON object as instructed:\n' +
      JSON.stringify(payload);

    const content = await chatCompletion(s, userContent);
    const parsed = parseResults(content);
    const byId = new Map<string, string>(parsed.map((p) => [p.id, p.name]));

    chunk.forEach((it, idx) => {
      const cleaned = byId.get(it.id);
      if (cleaned !== undefined) {
        results.push({ id: it.id, name: cleaned });
      } else {
        // Fall back to positional result when the model dropped or altered ids.
        results.push({ id: it.id, name: parsed[idx]?.name ?? it.name });
      }
    });
  }

  return results;
}

export async function testLlmConnection(
  cfg: LlmSettings
): Promise<{ success: boolean; model?: string; error?: string }> {
  try {
    await chatCompletion(cfg, 'Reply with the single word "OK".');
    return { success: true, model: cfg.model || undefined };
  } catch (err: any) {
    log(`[llm test] failed: ${err?.message || err}`);
    return { success: false, error: err?.message || String(err) };
  }
}
