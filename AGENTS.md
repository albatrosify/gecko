# AGENTS.md

## Project Context

GECKO ist ein self-hosted IPTV-Playlist-Aggregator. User verbinden Xtream-Codes-/M3U-Upstream-Provider, passen Kanäle/Kategorien an (ausblenden, per Regex umbenennen, sortieren) und bekommen einen sauberen Xtream-kompatiblen `player_api.php`-Endpoint für Downstream-Clients.

Cognitive-Architecture-Kontext (diese Dateien zuerst lesen):
1. `.antigravity/rules.md` — Verhaltensregeln für KI-Agenten
2. `.antigravity/conventions.md` — Tech-Stack, Konventionen, Commands
3. `.antigravity/decisions/` — Architektur-Entscheidungen (ADR)
4. `.antigravity/memory/` — Findings/Berichte früherer Sessions

## Quick Rules

- Think before acting — erst orientieren (diese Datei), planen, dann umsetzen
- Verify — nach Änderungen `npm run lint` und `npm run test`
- Type hints auf allen öffentlichen Funktionen
- Never commit secrets, nie force-push auf `main`
- **Pflicht:** Struktur/Endpoints/Tabellen/Routen geändert → diese Datei + `.antigravity/` im selben Zug aktualisieren (Auslöser-Tabelle in `.antigravity/rules.md`). Landkarte aktuell halten ist Teil des Done-Kriteriums.

## Commands

```bash
npm run dev      # Express + Vite HMR auf Port 3000
npm run build    # Frontend -> dist/
npm run start    # Produktion: NODE_ENV=production tsx server.ts
npm run lint     # tsc --noEmit (Type-Check)
npm run test     # vitest run
```

`.env` nötig (Kopie von `.env.example`): `SQLITE_PATH`, `JWT_SECRET`, `APP_URL`, `PORT`.

## Architektur

**Single-Process-Server** (`server.ts`): Express bedient REST-API **und** serviert das Vite-Frontend (dev: Vite-Middleware, prod: `dist/` + SPA-Fallback). Startup: `connectDb()` → `initCronManager()` → `initProxyStatsInterval()` → `initConnectionMonitor()` → `initHostStatsFlusher()` → `initTrafficFlusher()`.

**Backend** (`server/`) — Module mit Domänenlogik, `server/routes/` mit HTTP-Routern:
- `db.ts` — SQLite (`better-sqlite3` + Drizzle), WAL, Auto-Migrate (`CREATE TABLE IF NOT EXISTS`). `generateId()` = `crypto.randomUUID()`.
- `schema.ts` — Drizzle-Tabellendefinitionen.
- `auth.ts` — `createAuthRouter()` (register/login/me), `requireAuth` (JWT), `requireAuthOrQuery`.
- `cache.ts` — Two-Tier-Cache: In-Memory Map (1 min) + SQLite `cache`-Tabelle (12 h).
- `xtream.ts` — `XtreamClient` für Upstream-Xtream-API.
- `hosts.ts` — Host-Erkennung, Failover, Benchmarking, Multi-IP-Cluster-Evaluierung, Per-Host-Nutzungs-Statistiken.
- `dns-resolver.ts` — Multi-A DNS-Resolution, 5-Min-In-Memory-Caching, IP-Latency-Ranking, IP-Pinned HTTP/HTTPS-Agents (TCP-Socket auf Ziel-IP gepinnt unter Beibehaltung von Host-Header & TLS-SNI für Zertifikate & Nginx Virtual Hosts).
- `sync.ts` — `refreshSource()`, Changelogs, Cron-Manager (`activeCrons`, `initCronManager`).
- `connection-monitor.ts` — Überwacht Upstream-Verbindungen, protokolliert in `source_connection_logs`.
- `multiplexer/stream-hub.ts` — bündelt Live-Streams; In-Place Self-Healing Reconnect mit Multi-IP-Rotation bei Upstream-Gaps/Abbrüchen; Backpressure- & Stalled-Subscriber-Schutz; **Live-Jitter-Buffer** (ratebasiertes Leaky-Bucket-Pacing, Reserve, Starvation-Logging). Tiefe über `GECKO_LIVE_BUFFER_SECONDS` (Sekunden, `0` = aus/passthrough, Default 3) — Reserve == zusätzliche Latenz.
- `multiplexer/stream-guard.ts` — Einheitlicher Concurrency Guard über Live- und VOD-Streams hinweg (`evaluateStreamRequest`, Platzhalter bei Überlastung).
- `dvr/recorder.ts` — `DvrRecorder` (Aufnahmen); `connection-arbiter.ts` — Verbindungszuteilung; `placeholder.ts` — Platzhalter-Streams; `playback.ts` — `serveRecordingFile()`: fertige Aufnahmen wie statische Dateien (seekbar), laufende im Follow-Mode ohne `Content-Length` mit 30 s Stall-Cutoff.
- `llm.ts` — LLM-basierte Kanal-/Kategorie-Namensbereinigung.
- `telegram.ts` — Benachrichtigungen. `vpn.ts` — Gluetun/VPN-Status + Block-Erkennung.
- `quality.ts` / `quality-scan.ts` — Stream-Qualität prüfen/scannen.
- `proxy-stats.ts` — Bandbreiten-/Verbindungs-Statistiken (300 Datenpunkte, 2 s-Interval = 10 min für die Dashboard-Fenster 1m/5m/10m), Zombie-Socket-Sweeper, `getActiveVodConnectionsForSource` + `streamControllers`-Registry (Kill-Switch je aktiver Verbindung: `registerStreamController`/`killStream`/`killAllStreams`).
- `stream-title-cache.ts` — In-Memory O(1) Cache für Upstream Stream-/Filmnamen & Serien-Episodentitel (Live, VOD, Series) für Now-Playing & DVR.
- `traffic.ts` — Erfassung des übertragenen Datenvolumens (Buffer + periodischer SQLite-Flush), Range/Playlist/Stream-Typ Aufschlüsselung, Monatskontingent.
- `epg-service.ts` — EPG Fetching, Disk-Caching (`.xml.gz`), Stale-While-Revalidate, Non-Blocking Streaming für `/xmltv.php`.

**Frontend** (`src/`):
- `main.tsx` — Entry. `App.tsx` — Router + Auth-Gate, Routen unter Sidebar.
- `api.ts` — Typed-Fetch-Wrapper (JWT in `localStorage`, 401 → Reload); Gruppen `auth`, `sources`, `epgs`, `playlists`, `mappings`, `categoryMappings`, `customCategories`, `customCategoryItems`, `upstream`, `proxy`, `admin`, `system`, `settings`, `llm`, `qualityScan`, `dvr`, `traffic`.
- `types.ts` — Shared Types (Frontend + Backend).
- `components/index.tsx` — monolithisch (~420 KB): `Dashboard`, `PlaylistManager`, `SourceManager`, `EPGManager`, `Settings`, `PlaylistEditor`, `UserManager`, `DvrManager`.
- `components/TrafficView.tsx`, `components/SystemLogViewer.tsx`, `components/WebPlayer.tsx`, `components/BandwidthChart.tsx` — eigene Dateien. `BandwidthChart` zeichnet das Dashboard-Diagramm (SVG, kein Chart-Paket): Flächen-Gradient, Gitterlinien, `Avg`/`Peak`, Hover-Tooltip, Fenster 1m/5m/10m; Geometrie als reine Funktionen (`buildBandwidthGeometry`, `selectWindow`, `indexFromPointerX`) mit Tests.
- `playerUtils.ts`, `quality.ts`, `format.ts` — Frontend-Helfer.

**Routen** in `App.tsx`: `/` (Dashboard), `/traffic` (Traffic & Daten), `/dvr`, `/playlists`, `/sources`, `/epgs`, `/settings`, `/playlist/:id` (Editor), `/users` (nur admin).

**Nebenprojekte:**
- `player/` — eigenständige Expo-/React-Native-App (IPTV-Player-Client; `player/src/screens/*`, `player/src/api/xtream.ts`, `AuthContext`).
- `companion/` — leerer Expo-Router-Scaffold, kein aktiver Code.

**Design-Dokumente** (`docs/superpowers/` — vor Feature-Arbeit lesen, sonst übersieht man getroffene Entscheidungen):
- `specs/2026-04-05-custom-categories-design.md` — Custom Categories & Symlinks (Verlinken/Kopieren in Custom- und Upstream-Kategorien via `customCategoryItems`).
- `specs/2026-03-26-quality-scan-design.md`, `specs/2026-03-27-global-playlist-search-design.md` — weitere Features.
- `plans/*.md` — ausführliche Implementierungspläne zu den Specs.

## Datenmodell (SQLite, `server/schema.ts`)

| Tabelle | Zweck |
|---|---|
| `users` | E-Mail/Passwort/Rolle (`admin`\|`user`) |
| `sources` | Upstream-Xtream/M3U-Provider; `extra` (u.a. `useUpstreamEpg`), `syncCron` |
| `epgs` | XMLTV-EPG-URLs |
| `playlists` | Aggregations-Configs; `sourceIds` (JSON), `directStreams`, `username`/`password` für Downstream; `extra` (epgIds, isSynced, …) |
| `mappings` | Stream-Overrides (hide, rename, reorder, regex, EPG-Mapping) in `extra` |
| `categoryMappings` | Kategorie-Overrides |
| `customCategories` / `customCategoryItems` | User-definierte Kategorien und Symlinks/Items (Verlinkung in Custom- und Upstream-Kategorien) |
| `source_sync_meta` | Cooldown/Sync-Metadaten |
| `cache` | SQLite-Cache |
| `settings` | Globale Settings |
| `source_changelogs` | Sync-Changelog |
| `source_connection_logs` / `source_host_logs` | Verbindungs-/Host-Überwachung |
| `recordings` | DVR-Aufnahmen |
| `traffic_stats` | Übertragenes Datenvolumen pro Tag, Playlist und StreamType (TV, Movie, Series) |

## API-Endpoints

Alle unter `/api` (Auth via `requireAuth`), außer Proxy-Endpoints. Detaillierte Pfade direkt in den Routern greppbar.

| Router | Datei | Endpoints (Auszug) |
|---|---|---|
| Auth | `server/auth.ts` | `/auth/register`, `/auth/login`, `/auth/me` |
| System | `server/routes/system.ts` | `/system/ip`, `/system/vpn`, `/system/logs`, `/proxy/stats`, `/proxy/streams/:id/kill`, `/proxy/streams/kill-all`, `/health`, `/version`, `/settings`, `/settings/telegram/test` |
| Admin | `server/routes/admin.ts` | `/admin/users`, `/admin/users/:id` |
| Sources | `server/routes/sources.ts` | `/sources` CRUD, `/sources/:id/refresh`, `/changelog`, `/connections`, `/benchmark`, `/fetch-upstream`, `/fetch-streams` |
| EPG | `server/routes/epgs.ts` | `/epgs`, `/epg-channels` |
| Playlists | `server/routes/playlists.ts` | `/playlists` CRUD, `/:id/clone`, `/:id/sync`, `/:id/series-info`, `/:id/search`, `/download/:type/:playlistId/:streamId` |
| Mappings | `server/routes/mappings.ts` | `/mappings` + `/category-mappings` (CRUD + `batch` + `reset`) |
| Custom Categories | `server/routes/customCategories.ts` | `/custom-categories`, `/custom-category-items` (+ `batch`) |
| Quality Scan | `server/routes/quality-scan.ts` | `/quality-scan`, `/quality-scan/:jobId` |
| LLM | `server/routes/llm.ts` | `/llm/cleanup`, `/llm/test` |
| DVR | `server/routes/dvr.ts` (mount `/api/dvr`) | `/recordings`, `/record-now`, `/recordings/:id/stop`, `/recordings/:id`, `/recordings/:id/stream` |
| Traffic | `server/routes/traffic.ts` (mount `/api/traffic`) | `/stats`, `/reset` |
| Proxy (public) | `server/routes/proxy.ts` (mount `/`) | `/player_api.php`, `/get.php`, `/xmltv.php`, `/live\|movie\|series/:username/:password/:streamId`, `/timeshift/...`, `/img` |

## Wo baue ich X ein?

| Aufgabe | Anlaufstelle |
|---|---|
| Neue DB-Tabelle/Spalte | `server/schema.ts` (Drizzle) **und** SQL in `server/db.ts` |
| Neuer REST-Endpoint | Neuer Router in `server/routes/*.ts` + in `server.ts` mounten; Frontend-Wrapper in `src/api.ts` |
| Neue UI-Seite | Komponente in `src/components/index.tsx`, Route + Sidebar-Nav in `src/App.tsx` |
| Stream-Proxy-/Xtream-Logik | `server/routes/proxy.ts` + `server/multiplexer/*` |
| Upstream-Sync/Cron | `server/sync.ts` |
| Host-Failover/Benchmark | `server/hosts.ts` |
| DVR-/Aufnahme-Logik | `server/dvr/recorder.ts` |
| LLM-Feature | `server/llm.ts` + `server/routes/llm.ts` |
| Telegram/VPN | `server/telegram.ts`, `server/vpn.ts` |
| Frontend-API-Call | `src/api.ts` (Gruppe) + `src/types.ts` |
| Player-App-Feature | `player/src/screens/*` + `player/src/api/xtream.ts` |
| Shared Types | `src/types.ts` |
