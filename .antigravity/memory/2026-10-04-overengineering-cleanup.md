# 2026-10-04 — Über-Engineering-Cleanup (ponytail-audit, Teilumsetzung)

Ein ponytail-audit über das ganze Repo ergab ~35 Findings. Davon wurden die
grep-verifizierten Dead-Code- und kleinen Simplify-Punkte umgesetzt; die großen
strukturellen Refactorings bewusst NICHT.

## Umgesetzt

**Gelöschte Dateien:** `server/routes/migrations.ts` (+ Import/Mount in `server.ts`),
`server/epg.ts`, `server/config.ts` (3000 in `server.ts` + `server/utils.ts` inline),
`Dockerfile.slim`, `server_log.txt`, root `benchmark_customCategories.ts`,
`test_epg_proxy.js`, `drizzle.config.ts`.

**Entfernte tote Exporte/Funktionen:** `cache.ts clearCache()`,
`recorder.ts setUpstreamResponse()/getRecordingIdForConnection()`,
`db.ts toId()/docWithId()/docsWithId()` (+ unbenutzter Import in `auth.ts`),
`connection-monitor.ts stopConnectionMonitor()`, `hosts.ts stopHostStatsFlusher()`,
`XtreamClient.getMovies()` (→ `getVodStreams`), Route `/sources/:id/host-benchmarks`,
`llm.ts` systemPrompt-Override, `rate-limit.ts .destroy`-Hook.

**Konsolidiert:** `formatBytes` → ein Export in `server/utils.ts` (Verhalten von
recorder beibehalten: toFixed(1) MB / toFixed(2) GB); `copyToClipboard` (Frontend)
→ ein Export in `components/index.tsx`; absolute-URL-Normalisierung → `toAbsoluteUrl`
in `playerUtils.ts`.

**Vereinfacht:** unbenutzte lucide/AnimatePresence-Imports, tote `Layout`-Passthrough,
`SimpleSparkline` width/height hardcoded, `TrafficView.formatBytes` decimals-Param,
`isValidMappingId` ObjectId-Zweig, `quality.ts` Mini-Template-Engine auf `exists` +
`{var}` reduziert (vorher DB geprüft: keine anderen Operatoren gespeichert),
unbenutzte npm-Deps entfernt (formik, yup, xml2js, autoprefixer, @types/react-native,
drizzle-kit, dotenv, expo-status-bar), tsconfig `experimentalDecorators`/
`useDefineForClassFields`/`paths`-Alias, vite `@`-Alias + DISABLE_HMR.

## Bewusst NICHT umgesetzt (offen)

- **`src/components/index.tsx` Monolith zerlegen** (~5000 Zeilen relokiert, kein Netto-Delete) — hohes Risiko.
- **`proxy.ts` Katalog-Pipeline parametrisieren** (~450-550 Zeilen) — Datei hatte uncommitted WIP.
- **`mappings.ts` Batch-Factory** (~130-180 Zeilen).
- **`.github/workflows` dev.yml/release.yml zusammenführen** (~80 Zeilen).
- **Bandwidth-Widget-Duplikat** (ProxyBandwidthCard/Sidebar).
- `companion/` (untracked Scaffold) und `scripts/probe2.ts` (untracked) — User-Dateien, nicht angefasst.

## Fallstricke

- `npm uninstall` im Root braucht `--legacy-peer-deps` (react-window@1.8.10 vs React 19 Peer-Konflikt, unabhängig von den Entfernungen).
- `getHostBenchmarkHistory` (`hosts.ts`) und `session.upstreamResponse`
  (`recorder.ts:283`) sind nach den Löschungen unreferenziert — Kandidaten für einen nächsten Durchgang.
- Gate: `npm run lint` (tsc --noEmit) 0 Fehler, `npm run test` 16 Files / 92 Tests grün.

## Runde 2 (2026-10-04, nach Scout-Sweep)

**Gelöscht:** `ProxyBandwidthCard` (toter Zwilling von `ProxyBandwidthSidebar` in App.tsx),
`hosts.ts getHostBenchmarkHistory` (Waise nach Runde 1), `src/types.ts` `CustomCategory`/
`CustomCategoryItem`, `index.css @utility scrollbar-hide`, stale Kommentar in index.tsx.

**Entfernt/konsolidiert:** unbenutzte Imports in `proxy.ts` (`connectionArbiter`,
`RECORDINGS_DIR`, `path`) und `routes/dvr.ts` (`path`); doppelter `../db.ts`-Import in
`epgs.ts`; `@types/react-virtualized-auto-sizer` (v2 bringt eigene Typen).

**Dedupliziert:** `formatBytes` → neues `src/format.ts` (TrafficView-Semantik, 2 Dezimal/PB;
index.tsx nutzt jetzt ebenfalls 2 Dezimal statt 1); `formatDuration`-Shadowing in index.tsx
→ `formatElapsedSince` (epoch-ms) / `formatDurationSecs` (Sekunden).

**De-exportiert (nur intern genutzt):** `llm.resolveChatEndpoint`; `hosts.guessNetworkType/
detectHostNetwork/flushHostStats`; 5 Typen in `traffic.ts`; `placeholder.PLACEHOLDER_PATHS`;
`stream-guard.{GuardAction,GuardDecision}`; `stream-hub.{DownstreamSubscriber,UpstreamConfig,
ActiveStreamChannel,ChunkCallback}`.

**Korrektur zum Scout-Bericht:** `resolutionToLabel` ist in index.tsx:7522 doch in Gebrauch
(Import bleibt). Gate grün: 16 Files / 93 Tests.

## Runde 3 (2026-10-04)

**CI dedupliziert (ohne Check-Namen zu ändern):** `.github/actions/build-by-digest/` und
`.github/actions/merge-manifest/` als Composite Actions; `dev.yml`/`release.yml` rufen nur noch
diese auf. Bewusst KEINE Reusable-Workflow-Lösung: die hätte die Job-/Check-Namen auf
`build / build` umbenannt und damit Branch-Protection-Required-Checks brechen können.
`SHORT_SHA` als Step-Output (nicht `${{ env }}` — unsicher in Composites); `cd` statt
composite `working-directory`.

**data/ bereinigt:** `data/placeholder.ts` (4.2 MB Video mit falscher `.ts`-Endung),
`data/placeholder.mp4` (Duplikat von `assets/placeholder.mp4`) und `data/recordings/rec-test-123.ts`
(0 B) gelöscht. `PLACEHOLDER_PATHS`-Array → einzelnes `PLACEHOLDER_PATH` = `assets/placeholder.mp4`
(`data/` ist ohnehin in `.dockerignore`, war also nur Dev-Pfad). DB/`server.log` unangetastet.

Gate danach: tsc 0, 16 Files / 93 Tests.
