# 0004. Sync-Worker: Katalog-Syncs laufen in einem eigenen Prozess

Datum: 2026-10-18
Status: accepted

## Kontext

Der Prod-Testlauf zeigte `sync:catalog-write`-Stalls von 2,0 s bis **36,2 s** — deutlich
über dem 18-s-Jitter-Buffer, also sichtbares Buffering. Nach der inkrementellen
FTS-Pflege (ADR 0002, Finding 8) blieben auf dem echten Katalog (184.707 Zeilen)
noch **~3,25 s** pro Sync.

3,25 s liegt unter dem Buffer, ist aber **keine Garantie**: ein größerer Katalog,
eine langsamere Platte oder ein Provider mit mehr Items holt das Buffering zurück.
Der Puffer kaschiert das Problem, statt es zu lösen.

Anforderung: Ein Sync darf Streaming **prinzipiell nicht** beeinträchtigen — nicht
„ist meistens schnell genug", sondern „kann es nicht".

## Entscheidung

1. **Alle Katalog-Syncs laufen in einem eigenen Prozess** (`child_process.fork`),
   inklusive Cron-Manager.
2. Der Serving-Prozess tauscht nur kleine Nachrichten über IPC aus
   (`server/sync-client.ts` ↔ `server/sync-worker.ts`).
3. Der Worker wird bei Crash automatisch neu gestartet (Backoff 5 s) und mit dem
   Parent beendet (`SIGTERM`/`SIGINT` plus `disconnect`-Handler im Kind).
4. Log-Zeilen des Workers sind mit `[sync-worker]` getaggt (`GECKO_PROCESS_ROLE`),
   damit interleaves `docker logs` zuordenbar bleibt.
5. **`PRAGMA busy_timeout = 5000`** in `db.ts`, weil jetzt **zwei Prozesse** dieselbe
   SQLite-Datei schreiben.
6. Routen, die einen Sync auslösen (`proxy.ts` On-Demand, `sources.ts` manuell,
   `playlists.ts` Clone) gehen über den Client. Cron-Änderungen lösen ein
   vollständiges `rescheduleCrons()` im Worker aus, statt den Schedule pro Quelle
   von außen zu patchen.

## Konsequenzen

Positiv:
- **Ein Sync kann Streaming nicht mehr blockieren** — unabhängig von Größe, Dauer
  oder Fehlern. Gemessen: längste Loop-Lücke im Serving-Prozess **30 ms (Bun) /
  44 ms (Node)** während eines 2,4-s-Syncs mit ~900 ms Schreibzeit.
- **Heap-Isolation:** ein OOM im Sync (Vorgeschichte:
  `memory/2026-09-27-arm-vps-oom-crash-loop.md`) tötet den Sync-Prozess, nicht die
  Streams.
- Sync-Kosten sind für die Streaming-Qualität nicht mehr optimierungsrelevant.

Negativ / Risiko:
- Zwei Prozesse statt einem: eigener SQLite-Connection und eigene Runtime je Prozess.
- Der Serving-Prozess kann den Katalog-Mirror nicht mehr selbst primen; nach einem
  Sync wird er invalidiert und der nächste Read materialisiert neu (0,87 s für
  184 k) — dieselbe Größenordnung, die der 60-s-Mirror ohnehin verursacht.
- Debugging über Prozessgrenzen hinweg — daher die Log-Tags.
- `fork` erbt `execArgv`: unter `tsx` startet der Worker damit korrekt, unter Bun
  läuft die `.ts`-Datei nativ. **Beides verifiziert.**

Verworfen:
- **Chunked Writes mit Yields** — begrenzt die Blockade nur, garantiert nichts
  (ein langsamer Chunk blockt weiter) und verliert die atomare Sicht auf einen Sync.
- **Worker-Thread statt Prozess** — teilt Heap und Prozessgrenze; ein OOM im Sync
  würde den Serving-Prozess mitnehmen.
- **Streaming in einen eigenen Prozess ziehen** — stärkere Garantie, aber
  Multiplexer/DVR/Proxy-Stats-Zustand müssten mitwandern; unverhältnismäßig groß.
- **Nur die FTS-Optimierung behalten** — beseitigt den größten Posten, lässt aber
  eine puffer-abhängige Restblockade.

## Verifikation

- `scripts/check-sync-isolation.ts` (committet): Mock-Upstream mit 120 k Items,
  echter Sync über den Worker, 20-ms-Timer misst die **längste Loop-Lücke** im
  Serving-Prozess; Schwelle 250 ms. Ergebnis: Node 44 ms, Bun 30 ms.
- Der CI-Job `parity` führt zusätzlich zu den Treiber-Checks beide Laufzeiten aus.
  (Job-Key bewusst unverändert, damit der Required-Check-Name nicht bricht.)
- 227 Tests, lint sauber; Produktion während der Entwicklung unberührt.

## Nachtrag: Schweregrade (2026-10-22, nach dem Prod-Deploy)

Im Prod-Log stand bei **jedem** Sync ein `CRITICAL: phase "sync:catalog-write"
blocked the event loop for 5594.0 ms` — korrekt getaggt, aber irreführend: im
isolierten Worker bricht das nichts.

Deshalb sind die Schweregrade jetzt rollenabhängig:

| Rolle | WARN | CRITICAL |
|---|---|---|
| `serving` (Default) | 100 ms | **5000 ms** — „für den Zuschauer sichtbar" |
| `background` (Sync-Worker) | 30 s | **keins** (`Infinity`) |

`CRITICAL` bedeutet ab jetzt ausschließlich „das kann Sendungen brechen" und ist
im Worker nicht erreichbar. Die Schreibdauer geht stattdessen als Telemetrie in
die Sync-Zeile: `[Sync] Catalog write for X (vod): 185006 rows in 5594 ms`.
Ergebnis: 0 CRITICAL-Zeilen im Worker, die Zahl bleibt sichtbar.
