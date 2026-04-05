# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context
This project uses Antigravity cognitive architecture.
See `.antigravity/rules.md` for behavioral guidelines.
See `.antigravity/conventions.md` for project-specific conventions.
See `.antigravity/decisions/` for architectural decision log.
See `.antigravity/memory/` for past reports and findings.

## Quick Rules
- Think before acting — read the full task, plan, then execute
- Verify your work — run tests after changes
- Type hints and docstrings on all public functions
- Never commit secrets or force-push to main
- Check `.antigravity/` for project context before starting work

## What This Project Does
A self-hosted IPTV playlist aggregator. Users connect Xtream Codes / M3U upstream providers, customize channels/categories (hide, rename via regex, reorder), then expose a clean `player_api.php` Xtream-compatible endpoint for downstream IPTV clients.

## Commands

```bash
npm run dev       # Start dev server (Express + Vite HMR on port 3000)
npm run build     # Build frontend to dist/
npm run start     # Production: NODE_ENV=production tsx server.ts
npm run lint      # Type-check only (tsc --noEmit, no test suite)
```

Docker:
```bash
docker compose up -d   # App only — SQLite is built-in, no external services needed
```

Requires a `.env` file (copy from `.env.example`) with `SQLITE_PATH`, `JWT_SECRET`, `APP_URL`, `PORT`.

## Architecture

**Single-process server** (`server.ts`) — Express handles both the REST API and serves the Vite-built frontend (or proxies to Vite in dev mode). No separate frontend build step needed in development.

**Backend** (`server/`):
- `db.ts` — SQLite connection via `better-sqlite3` + Drizzle ORM; `toId()` is a passthrough (IDs are plain strings/UUIDs), `docsWithId()` maps rows to `{ id, ...fields }` merging the `extra` JSON column
- `schema.ts` — Drizzle table definitions for all collections
- `auth.ts` — JWT middleware (`requireAuth`), local email/password with bcrypt
- `cache.ts` — Two-tier cache: in-memory Map (1 min TTL) backed by SQLite `cache` table (12h TTL); keyed by source ID
- `xtream.ts` — `XtreamClient` fetches from upstream Xtream API (`player_api.php`)
- `epg.ts` — XMLTV EPG fetching/parsing

**Frontend** (`src/`):
- `types.ts` — Shared type definitions used by both frontend and backend
- `api.ts` — Typed fetch wrapper; JWT stored in `localStorage`; 401 triggers reload
- `App.tsx` — Router + auth gate; all routes under a collapsible sidebar
- `components/index.tsx` — All UI components in one file: `Dashboard`, `PlaylistEditor`, `SourceManager`, `EPGManager`, `Settings`, `Layout`, `ErrorBoundary`

**Data model** (SQLite tables via Drizzle, defined in `server/schema.ts`):
- `users` — email/password/role (`admin`|`user`)
- `sources` — upstream Xtream/M3U providers (per-user); supports `autoSyncEnabled` + `syncCron` (crontab) for scheduled refresh; extra fields in `extra` JSON column
- `epgs` — XMLTV EPG URLs (per-user)
- `playlists` — aggregation configs with custom `username`/`password` for downstream access; `directStreams: true` bypasses the stream proxy; `sourceIds` stored as JSON array
- `mappings` — per-playlist stream overrides (hide, rename, reorder, regex rules, EPG mapping); extra fields in `extra` JSON column
- `categoryMappings` — per-playlist category overrides (hide, rename, reorder)
- `source_sync_meta` — cooldown tracking for upstream syncs (5-min minimum between syncs)
- `cache` — SQLite-backed cache table replacing the old disk-based JSON files

**Xtream proxy** — `/player_api.php` and `/get.php` endpoints in `server.ts` merge multiple upstream sources, apply stream/category mappings, and serve a unified Xtream-compatible API. The `APP_URL` env var is used to rewrite stream URLs so they proxy through this server. In-memory `proxyStats` tracks active connections, bytes, and bandwidth history (60 data points at 2s intervals).

**Auto-sync** — `refreshSource()` syncs upstream stream names into `mappings`; cron jobs are managed in-process via `activeCrons` map (node-cron). Only updates `customName` when not manually overridden.

**Logging** — `log()` writes to `data/server.log`; `/api/system/logs` returns the last 200 lines.

**Cache key pattern**: `source_${sourceId}_${type}` (e.g. `source_abc123_live_streams`)
