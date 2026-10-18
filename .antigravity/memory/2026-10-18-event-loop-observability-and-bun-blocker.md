# Finding: Event-Loop-Observability & Bun-Migrations-Blocker

**Datum:** 2026-10-18
**Branch:** `feature/bun-runtime` (Worktree `.config/superpowers/worktrees/gecko/bun-runtime`)
**Komponenten:** `server/event-loop-monitor.ts` (neu), `server.ts`, `server/routes/system.ts`

## 1. Feature: Event-Loop-Stall-Observability

### Problem
Der 16-Sekunden-Stall aus `2026-10-18-sync-event-loop-yielding-and-dns-enrichment.md` war nur
durch Log-Interpretation (scheinbare `Upstream silent for 18518 ms`) auffindbar. Es gab keine
direkte Messung, welcher Code den Haupt-Thread blockiert.

### Lösung
- `server/event-loop-monitor.ts` mit zwei komplementären Mechanismen:
  - `measureSync(label, fn)` — mist eine synchrone Phase exakt und loggt Stalls mit
    Namenszuordnung (`phase "sync:setSnapshot" blocked the event loop for 8432.1 ms`).
    Throttling pro Label (Default 5 s) verhindert Log-Flooding.
  - `initEventLoopMonitor()` — `monitorEventLoopDelay`-Histogramm als Backstop für noch
    nicht instrumentierten Code; prüft alle 10 s mean/p50/p99/max.
- `getEventLoopStats()` speist `/health` (`eventLoop`-Feld) → Stalls sind von außen per
  `curl localhost:3000/health` sichtbar.
- Reine Helfer (`resolveThresholds`, `severityFor`, `summarizeLag`, `nsToMs`) sind separat
  unit-getestet (18 Tests), passend zum `BandwidthChart`-Muster.
- Env: `GECKO_EVENTLOOP_WARN_MS` (Default 100), `GECKO_EVENTLOOP_CRITICAL_MS` (Default 1000).

### Fallstrick: Histogramm braucht einen Warm-up-Tick
Empirisch verifiziert: blockiert der Thread **sofort nach** `histogram.enable()`, wird die
Verzögerung **nicht** erfasst (`max = 11 ms` bei 300 ms Block). Nach mindestens einem
Sampler-Tick wird ein 400-ms-Block korrekt gemessen (`max = 406.32 ms`).
→ `initEventLoopMonitor()` wird deshalb vor jeder Arbeitslast (vor `startServer()`) aufgerufen.
→ `measureSync()` hat diesen Fallstrick nicht und bleibt die primäre, exakte Quelle.

## 2. Blocker: Bun kann `better-sqlite3` nicht laden

### Befund
```
error: 'better-sqlite3' is not yet supported in Bun.
Track the status in https://github.com/oven-sh/bun/issues/4290
In the meantime, you could try bun:sqlite which has a similar API.
```
Reproduziert mit Bun 1.4.3 (macOS arm64), `better-sqlite3` 12.8.0 frisch kompiliert.
Unter Node 26.11.1 lädt dasselbe Modul problemlos.

### Konsequenz
GECKO nutzt `better-sqlite3` als **gesamte** DB-Schicht (`server/db.ts`, Drizzle
`drizzle-orm/better-sqlite3`). Eine Bun-Migration ist damit **kein Runtime-Tausch**, sondern
erfordert `bun:sqlite` + `drizzle-orm/bun-sqlite` (Driver ist in Drizzle 0.45.2 vorhanden).

Weiteres Problem: die Test-Suite läuft unter **vitest/Node**, wo `bun:sqlite` nicht existiert.
Eine reine Umstellung bricht alle DB-Tests → es braucht einen runtime-konditionalen Driver
(`bun:sqlite` unter Bun, `better-sqlite3` unter Node), inkl. Typ-Cast, weil die Query-Builder-
APIs (`.all()`, `.get()`, `.run()`) synchron kompatibel sind.

## 3. Nebenbefund: Node 26 führt TypeScript nativ aus

`node server.ts` verarbeitet TS direkt (Type-Stripping ist ab Node 23.6 stabil, hier
verifiziert mit `node -e` auf einer `.ts`-Datei). **`tsx` ist damit in Production überflüssig** —
ohne Bun, ohne Zusatzabhängigkeit. Betrifft `package.json` (`start`/`dev`) und `Dockerfile:CMD`.

## 4. Fallstrick: Vitest-Timing-Tests unter CPU-Last

Ein paralleler Lauf von `npm run lint` (`tsc --noEmit`) und `npm run test` lastete die CPU so
stark aus, dass ein timing-abhängiger Test (`expect(log).not.toHaveBeenCalled()` mit
1000-ms-Schwelle) intermittierend fehlschlug. → **Lint und Tests nicht parallel ausführen**,
und Timing-Assertions mit großzügigen Margen (60 s Schwelle, ≥40 ms Abstand) schreiben.
