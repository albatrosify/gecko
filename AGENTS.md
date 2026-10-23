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
- Verify — nach Änderungen `bun run lint` und `bun run test`
- Type hints auf allen öffentlichen Funktionen
- Never commit secrets, nie force-push auf `main`
- **Pflicht:** Struktur/Endpoints/Tabellen/Routen geändert → diese Datei + `.antigravity/` im selben Zug aktualisieren (Auslöser-Tabelle in `.antigravity/rules.md`). Landkarte aktuell halten ist Teil des Done-Kriteriums.

## Commands

```bash
bun run dev      # Bun + Vite HMR auf Port 3000
bun run build    # Frontend -> dist/
bun run start    # Produktion: NODE_ENV=production bun server.ts
bun run lint     # tsc --noEmit (Type-Check)
bun run test     # vitest run (läuft unter Node — braucht better-sqlite3)
```

Node-Fallback (falls Bun nicht verfügbar ist): `npm run dev:node`, `npm run start:node`.
Details/Alternativen in ADR `0003-runtime-bun-default-node-fallback.md`.

Benchmark (messbar auf jeder Maschine, inkl. Prod-Box):

```bash
bun run bench                                             # synthetisch, 50 k Items
bun scripts/bench-data-layer.ts --items=185000
bun scripts/bench-data-layer.ts --source=/app/data/gecko.db
```

Treiber-Parity (muss unter **beiden** Runtimes laufen — die vitest-Suite sieht nur Node):

```bash
npx tsx scripts/check-db-driver.ts   # Node
bun scripts/check-db-driver.ts       # Bun
```

`.env` nötig (Kopie von `.env.example`): `SQLITE_PATH`, `JWT_SECRET`, `APP_URL`, `PORT`.

## Architektur

**Zwei Prozesse** (`server.ts` + `server/sync-worker.ts`): `server.ts` bedient REST-API **und** serviert das Vite-Frontend (dev: Vite-Middleware, prod: `dist/` + SPA-Fallback). Startup: `connectDb()` → `startSyncWorker()` → `initProxyStatsInterval()` → `initConnectionMonitor()` → `initHostStatsFlusher()` → `initTrafficFlusher()`.

Der **Sync-Worker** läuft in einem eigenen Prozess (`fork`) und besitzt **alle Katalog-Syncs und den Cron-Manager**, damit ein Sync niemals den Event-Loop der Streaming-Verarbeitung belegen kann — auch nicht bei 185 k Zeilen oder einem Absturz (ADR 0004). Kommunikation über IPC (`server/sync-client.ts`); Log-Zeilen sind mit `[sync-worker]` getaggt; bei Crash wird er automatisch neu gestartet. Verifiziert durch `scripts/check-sync-isolation.ts` (längste Loop-Lücke im Serving-Prozess während eines Syncs: 30–44 ms).

**Backend** (`server/`) — Module mit Domänenlogik, `server/routes/` mit HTTP-Routern:
- `db.ts` — SQLite, WAL, Auto-Migrate (`CREATE TABLE IF NOT EXISTS`) inkl. ADR-0002-Upgrade-Cleanup, gefolgt von einem **VACUUM** (Freelist-Ratio ≥ 20 %, sonst übersprungen; `GECKO_SKIP_VACUUM=1` schaltet es ab), damit der freigewordene Platz auch an das Dateisystem zurückgeht. Treiber runtime-abhängig: `bun:sqlite` unter Bun, `better-sqlite3` unter Node (`openDriver()`, gemeinsames `SqliteHandle`-Interface; `bun:sqlite` hat kein `pragma()`, daher `exec('PRAGMA …')`). `generateId()` = `crypto.randomUUID()`. `getSqlite()` = roher Handle für Bulk-Operationen und Virtual Tables (FTS5).
- `schema.ts` — Drizzle-Tabellendefinitionen.
- `auth.ts` — `createAuthRouter()` (register/login/me), `requireAuth` (JWT), `requireAuthOrQuery`.
- `cache.ts` — Two-Tier-Cache: In-Memory Map (1 min) + SQLite `cache`-Tabelle (12 h).
- `stream-store.ts` — Normalisierter Upstream-Katalog (ADR 0002), **Quelle der Wahrheit** für Stream-Namen/-Metadaten. Schreiben: `replaceSourceStreamsWithDiff()` (schreibt **nur Deltas** — 0 Bytes ohne Änderung, 4 KB bei 3 Zeilen; Staging + SQL-Diff in Temp-Tabellen, FTS-Rebuild nur bei echter Änderung), `primeSourceStreams()` (Mirror nach Sync). Lesen: `readSourceStreams()`/`getCachedStreams()` (60-s-Mirror, sonst aus der Tabelle materialisiert), `hasSourceStreams()`, `countSourceStreams()`, `searchStreams()` (FTS5-Trigram `MATCH`, Scan-Fallback unter 3 Zeichen), `invalidateSourceStreams()`, `rebuildStreamSearchIndex()`. Die früheren `cache`-Blobs (`${sourceId}_streams_${type}`) werden nicht mehr geschrieben.
- `xtream.ts` — `XtreamClient` für Upstream-Xtream-API.
- `hosts.ts` — Host-Erkennung, Failover, Benchmarking, Multi-IP-Cluster-Evaluierung, Per-Host-Nutzungs-Statistiken. `getOrderedHosts()` sortiert **gesundheitsbewusst**: tote Hosts (EMA-Score `health` < 0.6, siehe `nextHostHealth`/`isHostDemoted`) rutschen hinter die funktionierenden, damit ein toter Primary nicht bei jeder Anfrage zuerst 15 s Timeout kostet; nach 10 min ohne Fehler bekommt ein Host eine neue Chance (Probation).
- `dns-resolver.ts` — Multi-A DNS-Resolution, 5-Min-In-Memory-Caching, IP-Latency-Ranking, IP-Pinned HTTP/HTTPS-Agents (TCP-Socket auf Ziel-IP gepinnt unter Beibehaltung von Host-Header & TLS-SNI für Zertifikate & Nginx Virtual Hosts).
- `sync.ts` — `refreshSource()`, Changelogs via SQL-Diff (`persistChangelog()`, `recordSourceChanges()` nur noch für Kategorien), Cron-Manager (`activeCrons`, `initCronManager`, `rescheduleCrons`). Läuft **im Sync-Worker**, nicht im Serving-Prozess.
- `sync-worker.ts` — eigener Prozess: besitzt alle Syncs + den Cron-Manager. IPC-Handler für `sync`/`reschedule`; meldet `synced` zurück.
- `sync-client.ts` — Serving-Prozess-Seite: `startSyncWorker()`, `requestSourceSync()`, `notifyCronsChanged()`, `stopSyncWorker()`. Startet den Worker bei Crash neu.
- `connection-monitor.ts` — Überwacht Upstream-Verbindungen, protokolliert in `source_connection_logs`.
- `event-loop-monitor.ts` — **Event-Loop-Stall-Observability** (Haupt-Thread-Lag). `measureSync(label, fn)` misst synchrone Phasen und loggt Stalls mit Namenszuordnung; `measureSyncTimed()` gibt zusätzlich die Dauer zurück (für Telemetrie im eigenen Log statt als Alarm); `initEventLoopMonitor()` überwacht den Loop per `monitorEventLoopDelay`-Histogramm als Backstop für noch nicht instrumentierten Code; `getEventLoopStats()` speist `/health`. **Schweregrade sind rollenabhängig** (`role: 'serving' | 'background'`): `CRITICAL` heißt „das bricht Sendungen" und existiert **nur im Serving-Prozess** (Default warn 100 ms / critical 5000 ms); im Sync-Worker ist Blockieren by design harmlos, dort gibt es **kein CRITICAL** (Default warn 30 s). Überschreibbar via `GECKO_EVENTLOOP_WARN_MS` / `GECKO_EVENTLOOP_CRITICAL_MS`. **Instrumentierte Phasen:** `sync:catalog-write`, `streams:materialize:<type>`, `epg:proxy-icons`, `epg:assemble`, `epg:to-buffer`. Hinweis: Das Histogramm braucht einen Sampler-Tick, bevor es eine Verzögerung zuordnen kann — deshalb startet der Monitor vor jeder Arbeitslast.
- `multiplexer/stream-hub.ts` — bündelt Live-Streams; In-Place Self-Healing Reconnect mit Multi-IP-Rotation bei Upstream-Gaps/Abbrüchen; Backpressure- & Stalled-Subscriber-Schutz; **Live-Jitter-Buffer** (ratebasiertes Leaky-Bucket-Pacing, Reserve, Starvation-Logging). Tiefe über `GECKO_LIVE_BUFFER_SECONDS` (Sekunden, `0` = aus/passthrough, Default 18) — Reserve == zusätzliche Latenz. `getBufferHealth(channelKey)` liefert die Live-Pufferanzeige des Dashboards (`computeBufferHealth()` ist rein und getestet): `status` `healthy|low|starved|warming`, `fillPercent` **relativ zur Reserve** (100 % = genau die 18 s, nicht das Memory-Cap), `bufferedSeconds`/`reserveSeconds`, `rateBps`, `starvedMs`, `lastStarveAt`/`lastStarveMs`. `null` bei ausgeschaltetem Pacing, unbekanntem Kanal oder ohne Subscriber (dann verwirft der Pump den Buffer bewusst). Die Freigaberate folgt der 60-s-Ratenschätzung; weil die ±7 % streut, hält der begrenzte Trim `nextPaceTrim()` (alle 10 s, 0,95–1,05) den Füllstand am Soll — ohne ihn random-walkt der Puffer (beobachtet bis 17 % ≈ 3 s) und jede Provider-Pause erreicht den Player als Re-Buffer.
- `multiplexer/stream-guard.ts` — Einheitlicher Concurrency Guard über Live- und VOD-Streams hinweg (`evaluateStreamRequest`, Platzhalter bei Überlastung).
- `dvr/recorder.ts` — `DvrRecorder` (Aufnahmen). Zwei Startwege: **Stream-Tee** (`startLiveRecordingFromConnection`, aus einem aktiven Client) und **server-seitig** (`startChannelRecording`, direkt aus dem DVR-Tab ohne Player — öffnet den Upstream über einen internen Loopback-Request an `/live/...` mit Header `x-gecko-dvr-recording-id`, damit Host-Failover/IP-Pinning/Guard/Multiplexer wiederverwendet werden; optionale `durationMinutes` stoppen automatisch). Lossless Remux Repair (`repairRecording`), Revert to Backup (`revertRecording`), Auto-Pruning abgelaufener Backups (`pruneExpiredBackups`). `connection-arbiter.ts` — Verbindungszuteilung; `placeholder.ts` — Platzhalter-Streams; `playback.ts` — `serveRecordingFile()`: fertige Aufnahmen wie statische Dateien (seekbar), laufende im Follow-Mode ohne `Content-Length` mit 30 s Stall-Cutoff.
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
- `components/index.tsx` — monolithisch (~420 KB): `Dashboard`, `PlaylistManager`, `SourceManager`, `EPGManager`, `Settings`, `PlaylistEditor`, `UserManager`, `DvrManager`. Das Dashboard rendert pro Verbindung eine Puffer-Anzeige (`BufferGauge`, Balken relativ zur 18-s-Reserve, Farben stabil/knapp/hungert/messe…); der Streamname bricht um statt abgeschnitten zu werden.
- `components/TrafficView.tsx`, `components/SystemLogViewer.tsx`, `components/WebPlayer.tsx`, `components/BandwidthChart.tsx` — eigene Dateien. `BandwidthChart` zeichnet das Dashboard-Diagramm (SVG, kein Chart-Paket): Flächen-Gradient, Gitterlinien, `Avg`/`Peak`, Hover-Tooltip, Fenster 1m/5m/10m; Geometrie als reine Funktionen (`buildBandwidthGeometry`, `selectWindow`, `indexFromPointerX`) mit Tests.
- `playerUtils.ts`, `quality.ts`, `format.ts` — Frontend-Helfer.

**Routen** in `App.tsx`: `/` (Dashboard), `/traffic` (Traffic & Daten), `/dvr`, `/playlists`, `/sources`, `/epgs`, `/settings`, `/playlist/:id` (Editor), `/users` (nur admin).

**Nebenprojekte:**
- `player/` — eigenständige Expo-/React-Native-App (IPTV-Player-Client; `player/src/screens/*`, `player/src/api/xtream.ts`, `AuthContext`).

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
| `streams` | Normalisierter Upstream-Katalog (ADR 0002); Composite-PK `(sourceId, type, streamId)`, `extra` für provider-spezifische Felder. Begleit-Virtual-Table `streams_fts` (FTS5, external content, trigram) für die Namenssuche. |
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
| System | `server/routes/system.ts` | `/system/ip`, `/system/vpn`, `/system/logs`, `/proxy/stats` (connections inkl. `buffer`-Health), `/proxy/streams/:id/kill`, `/proxy/streams/kill-all`, `/health`, `/version`, `/settings`, `/settings/telegram/test` |
| Admin | `server/routes/admin.ts` | `/admin/users`, `/admin/users/:id` |
| Sources | `server/routes/sources.ts` | `/sources` CRUD, `/sources/:id/refresh`, `/changelog`, `/connections`, `/benchmark`, `/fetch-upstream`, `/fetch-streams` |
| EPG | `server/routes/epgs.ts` | `/epgs`, `/epg-channels` |
| Playlists | `server/routes/playlists.ts` | `/playlists` CRUD, `/:id/clone`, `/:id/sync`, `/:id/series-info`, `/:id/search`, `/download/:type/:playlistId/:streamId` |
| Mappings | `server/routes/mappings.ts` | `/mappings` + `/category-mappings` (CRUD + `batch` + `reset`) |
| Custom Categories | `server/routes/customCategories.ts` | `/custom-categories`, `/custom-category-items` (+ `batch`) |
| Quality Scan | `server/routes/quality-scan.ts` | `/quality-scan`, `/quality-scan/:jobId` |
| LLM | `server/routes/llm.ts` | `/llm/cleanup`, `/llm/test` |
| DVR | `server/routes/dvr.ts` (mount `/api/dvr`) | `/recordings`, `/record-now`, `/record-channel`, `/recordings/:id/stop`, `/recordings/:id`, `/recordings/:id/stream`, `/recordings/:id/repair`, `/recordings/:id/revert` |
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
