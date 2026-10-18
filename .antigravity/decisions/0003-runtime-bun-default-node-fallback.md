# 0003. Runtime: Bun als Standard, Node als Fallback

Datum: 2026-10-18
Status: accepted

## Kontext

Ausgangslage: Node + `tsx` + `better-sqlite3`. Letzteres ist ein natives Modul und
muss pro Node-Version und Architektur kompiliert werden — bei Multi-Arch-Builds
(amd64/arm64) ein wiederkehrender Kosten- und Fehlerfaktor.

Ursprünglicher Blocker-Befund: **Bun kann `better-sqlite3` nicht laden**
(oven-sh/bun#4290). Das betrifft aber nur diesen Treiber, nicht SQLite: Buns
eingebautes `bun:sqlite` erfüllt alle Anforderungen (verifiziert mit Bun 1.4.3 /
SQLite 3.54 — FTS5 + Trigram, Temp-Tabellen, `ON CONFLICT … DO UPDATE … WHERE`,
`transaction`, `monitorEventLoopDelay`). Einzige echte Inkompatibilität:
`db.pragma()` fehlt → `exec('PRAGMA …')`.

Messung (`scripts/bench-data-layer.ts`, 50 k synthetisch, beide Runtimes):

| Vorgang | Node | Bun |
|---|---|---|
| **kalter Read (materialisieren)** | **165–181 ms** | **53–67 ms** |
| Erst-Load | 316–428 ms | 319–342 ms |
| Re-Sync ohne Änderung | 259–291 ms | 288–353 ms |
| Re-Sync, Delta | 317–390 ms | 374–431 ms |
| Suche (FTS5) | 0.068 ms | 0.079–0.191 ms |

Bun ist auf dem **Lesepfad ~3× schneller** (die JS-Arbeit dominiert: 50 k
`JSON.parse` + Objekt-Aufbau) und beim **Schreiben ~15 % langsamer** (selten, und
0 Bytes ohne Änderung).

## Entscheidung

1. **Bun ist der Standard-Runtime** für Entwicklung und Produktion:
   `bun --watch server.ts`, `NODE_ENV=production bun server.ts`, `bun run build`,
   `oven/bun:1` als Basis-Image.
2. **Treiber bleibt runtime-abhängig** (`server/db.ts` → `openDriver()`):
   `bun:sqlite` unter Bun, `better-sqlite3` unter Node, hinter einem gemeinsamen
   `SqliteHandle`-Interface. `better-sqlite3` wird dynamisch importiert, damit es
   unter Bun nie geladen wird.
3. **Node bleibt als Fallback** erhalten (`start:node`, `dev:node`), weil die
   vitest-Suite unter Node läuft und `better-sqlite3` braucht.
4. **Im Image: `bun install --ignore-scripts`.** Damit entfällt der native Build
   von `better-sqlite3` (unter Bun ungenutzt). esbuilds Plattform-Binary kommt als
   Paket, nicht per postinstall — `bun run build` funktioniert weiterhin.
5. **`NODE_OPTIONS=--max-old-space-size=…` in `docker-compose.prod.yml` ist kein
   Zwangsdefault mehr** (V8-spezifisch, von Bun ignoriert). Bun leitet seine
   Heap-Größe aus dem cgroup-Limit (`mem_limit`) ab. Die Variable bleibt als
   Passthrough für das Node-Fallback-Image erhalten.

## Konsequenzen

Positiv:
- **Kein natives Modul im Prod-Image** → schnellere und robustere Multi-Arch-Builds
  (arm64/amd64), kein node-gyp/`prebuild-install`.
- **Lesepfad ~3× schneller**; der frühere Nachteil des Redesigns (kalter Read
  +90 ms gegenüber dem Blob) entfällt — unter Bun ist er schneller als der Blob.
- Weniger Abhängigkeiten im Prod-Pfad (`tsx` nicht mehr nötig).

Negativ / Risiko:
- **Die Tests laufen auf einem anderen Runtime als die Produktion** (vitest/Node).
  Der konditionale Treiber hält beides am Leben, aber das ist eine Asymmetrie.
- **Memory-Tuning ist nicht übertragbar:** V8-Flags wirken nicht; die OOM-Historie
  (`memory/2026-09-27-arm-vps-oom-crash-loop.md`) muss für Bun neu bewertet werden
  — verlässlich ist nur `mem_limit` (cgroup).
- **Bun/Node-Compat-Lücken** (u. a. `async_hooks`, `cluster`, TLS) sind für eine
  Streaming-Appliance relevant, die TLS terminiert.
- Single-Vendor-Runtime; `better-sqlite3` bleibt als (ungenutzte) Abhängigkeit im
  Repo, damit der Node-Pfad testbar bleibt.

Verworfen:
- **Vollständiger Switch inkl. `bun test`** — `vi.mock` u. a. sind nicht
  kompatibel, würde die 222 Tests brechen. Nicht im Verhältnis zum Nutzen.
- **`better-sqlite3` ganz entfernen** — braucht der Node-Testpfad.
- **Node behalten** — verliert den 3× Lesepfad-Vorteil ohne Gegenwert.

## Verifikation

- `bun run build` → 2116 Module, 3.08 s, `dist/` erzeugt.
- `bun server.ts` (NODE_ENV=production) → SPA ausgeliefert, `/health` (inkl.
  `eventLoop`) und `/api/version` 200, keine Fehler im Log.
- Auto-Migration unter Bun legt WAL + `streams` + `streams_fts` an.
- Node-Pfad unverändert: `npm run test` 222 Tests grün, `npm run lint` sauber.

**Nicht verifiziert:** der Docker-Build selbst (auf dieser Maschine ist kein Docker
installiert). Die einzelnen Schritte sind geprüft, das Image nicht.
