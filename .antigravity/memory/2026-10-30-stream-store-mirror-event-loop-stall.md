# Finding: 60-s-Mirror-TTL in `stream-store` blockte den Event-Loop und verursachte Live-Buffering

**Datum:** 2026-10-30
**Komponenten:** `server/stream-store.ts`, `server/event-loop-monitor.ts`, `server/multiplexer/stream-hub.ts`
**Umgebung:** Prod (`homgsa.de`, Oracle ARM VPS, Image `ghcr.io/albatrosify/gecko:bun`, Branch `feature/data-layer`), 3 gleichzeitige Live-Streams.

## Symptom
- `Downstream starved for 1,5–26 s` — Clients re-buffern trotz intakter Buffer.
- `[EventLoop] WARN phase "streams:materialize:vod/series" blocked the event loop for 300–3000 ms` (schlimmster Fall 40,5 s in 24 h).
- Die Stalls clustern bei TiviMate-Starts/-Refreshes (`GET /player_api.php?...get_vod_streams/get_series`).

## Root Cause
`readSourceStreams()` (read path von `getCachedStreams()`, u.a. genutzt von `player_api.php`) hat einen **60-s-In-Memory-Mirror** (`MIRROR_TTL_MS = 60_000`). Bei jedem Mirror-Expiry wurde die Partition erneut **synchron** aus der `streams`-Tabelle materialisiert:

- `materializePartition()` selektiert alle Zeilen einer `(sourceId, type)`-Partition (VOD bis ~158 k, Series ~51 k) und baut daraus Objekte mit `JSON.parse(row.extra)` — gemessen ~180 ms für 51 k, **1–3 s** für die echten Kataloge.
- Das lief auf demselben Haupt-Thread wie `pumpChannelBuffer()`, daher blockierte jede Re-Materialisierung die Auslieferung **aller** aktiven Streams für die Dauer des Blocks — unabhängig von Puffer-Größe/Pacing.

Die TTL war ein Überbleibsel des alten `cache`-Mirrors; für Katalogdaten, die sich nur durch einen Sync ändern, ist sie falsch.

## Lösung
Mirror ist jetzt **invalidierungsgesteuert statt zeitgesteuert**:

- `primeSourceStreams()` seedet nach jedem Sync, `invalidateSourceStreams()`/`deleteSourceStreams()` räumen bei Delete. Damit ist der Mirror nie stale.
- Kein `MIRROR_TTL_MS` mehr; `readSourceStreams()`/`hasSourceStreams()` greifen ohne Expiry-Check auf den Mirror zu.
- Folge: eine Partition wird **einmal pro Prozess (pro Sync)** materialisiert statt **einmal pro Minute**.

Die Invalidierungs-Abdeckung ist vollständig verifiziert: jeder Schreibpfad geht über `replaceSourceStreamsWithDiff()` → `primeSourceStreams()` (Sync) oder `deleteSourceStreams()` → `invalidateSourceStreams()`; der Sync-Worker meldet zurück und `sync-client.ts` invalidiert im Serving-Prozess.

## Tradeoff
- Der Mirror hält jetzt den gesamten Katalog dauerhaft im RAM (geschätzt ~100–300 MB JS-Objekte bei 158 k+51 k). Bei 3-GiB-Limit akzeptabel; zu beobachten.
- Tests ergänzt (`stream-store — mirror lifetime`, +2): gleiche Referenz = Mirror-Hit, `invalidateSourceStreams`/`deleteSourceStreams` erzwingen Re-Materialisierung.

## Offen (nächste Schritte, noch NICHT umgesetzt)
1. `epg:assemble` / `epg:to-buffer` in `server/epg-service.ts` blockieren ebenfalls synchron (Buffer.from/join des ~100-MB-XML) auf `/xmltv.php`-Rebuild.
2. **Conservation-Ratenschätzung** in `stream-hub.ts` (exakte Ankunftsrate statt 60-s-Schätzung) — damit der Floor tatsächlich hält (aktuelle ~4 s statt konfigurierter 12 s).
3. Floor danach auf 18–20 s anheben: Provider-Pausen liegen jetzt bei **13–17 s** (früher 2–4 s/10,5 s), der Compose-Kommentar („2–4 s, selten ~10 s“) ist veraltet.
