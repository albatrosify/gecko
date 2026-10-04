# Finding: Live-Buffering durch bursty Provider — Jitter-Buffer & Pacing

**Datum:** 2026-10-04
**Komponenten:** `server/multiplexer/stream-hub.ts`, `server/dvr/recorder.ts`, `server.ts`

## Symptome
- Live-TV buffert stark, Video friert ein (Ton läuft weiter), Stream „springt" zu einem anderen Zeitpunkt, Zähler im Web-Interface startet neu.
- Nach längerem Provider-Ausfall bleibt der Loader (TiviMate) dauerhaft sichtbar, obwohl der Server Daten hält.

## Root Cause (in dieser Reihenfolge belegt)

1. **Provider liefert bursty, nicht kontinuierlich.** Messung im Container: ~3 MB in ~200 ms, danach ~5 s **komplett 0 Byte** (87 von 100 200-ms-Fenstern ohne Daten). Zusätzlich echte Ausfälle von **8–15 s**.
   - Box/VPN als Ursache ausgeschlossen: Bulk-Download 50 MB in 0,7 s (580 Mbps), Latenz 9–12 ms über 40 Samples, `Recv-Q` immer leer, CPU 0,07 %.
   - Zwei unabhängige Provider (`operator3.barfik.org`, `line.tivione2.cv`) pausieren **synchron** ⇒ gemeinsames Backend/Relay vorgeschaltet.
2. **Chunks wurden sofort weitergegeben** (`sub.res.write(chunk)` direkt im Upstream-Handler). Jede Provider-Lücke wurde damit 1:1 zur Client-Lücke.
3. **Self-Healing-Reconnect feuerte mitten in der normalen Lücke** (6 s Schwelle, normale Lücke ~4,8 s). Reconnect verwirft gepufferte Daten (Freeze) und der neue Connect startet an anderer Stelle im Origin-Buffer (Zeitsprung).
4. **Rate-Schätzung als Wall-Clock-Mittel** (`bytes / seit Start`) sinkt während eines Ausfalls unter Echtzeit ⇒ Pacer hungert den Client aus, obwohl Puffer gefüllt ist (Ladekreis für ~1 min nach Ausfall).

## Lösung

Jitter-Buffer mit **ratebasiertem Leaky-Bucket-Pacing** in `stream-hub.ts`:

- Chunks werden gepuffert und in 64-KB-Slices über einen Token-Bucket mit der **gemessenen Durchschnittsrate** freigegeben. Ausgabeform ist damit unabhängig von der Ankunftsform.
- **Rate aus Datenzeit**, nicht Wall-Clock: Sekunden-Buckets über 60 s, Lücken zwischen Daten-Sekunden auf `LIVE_BUFFER_RATE_MAX_GAP_S` (8 s) gekappt, damit ein Ausfall die Rate nicht dauerhaft drückt; zusätzlich **ältester Bucket wird von `total` abgezogen** (er trägt Bytes ohne vorausgehende Zeitspanne ⇒ ~2× Überschätzung am Start).
- **Reserve** (`GECKO_LIVE_BUFFER_SECONDS`, Default 3 s) wird gehalten und über einen Füll-Regime (Faktor 0,8 statt 1,0) aufgebaut.
- **Start-Durchleitung:** Solange keine Rate messbar ist (~3 s), wird ungepaced durchgelassen ⇒ Kanalwechsel startet sofort (First Byte ~36 ms statt ~10 s bei einem früheren Prebuffer-Ansatz).
- **Diagnose:** `⚠️ Downstream starved for X ms` loggt genau die Zustände, die den Client erreichen (Puffer leer bei vorhandenen Subscribern, ≥1,5 s). Ergänzend Silence-Warnung **einmal pro Ereignis** (vorher 1×/s → Logs suggerierten 8 Ausfälle statt einem).
- Reconnect-Schwellen erhöht (Warn 8 s, Reconnect 15 s); fehlgeschlagener Reconnect wird mit Backoff (2/4/8/15 s) wiederholt, solange Zuschauer hängen.

## Fallstricke (jeweils verifiziert)
- **Level-basiert** (nur oberhalb der Reserve freigeben) ⇒ Ausgabe wird gulp-synchron, Lücken bleiben.
- **Age-basiert** (Chunk nach X ms Alter freigeben) ⇒ reproduziert die Gulp-Form, da Chunks eines Bursts mikrosekundenweise eintreffen.
- **Token-Cap muss << Provider-Lücke** sein, sonst bankt der Bucket über die Lücke und entlädt sie als Sawtooth.
- Starvation-Check **vor** dem `if (buffer.length === 0) return` platzieren, sonst toter Code (genau der Zustand, den er beobachten soll).
- Rate-Schätzung: ohne Bucket-Abzug Überschätzung ⇒ Pacer überholt den Puffer.

## Tradeoffs (bewusst)
- **Reserve == Latenz.** Instant-Umschalten und Ausfall-Toleranz schließen sich aus; ein Puffer kann nur liefern, was er empfangen hat. 8–15 s Provider-Ausfall ⇒ Client hungert unvermeidbar (physikalisch), nur `GECKO_LIVE_BUFFER_SECONDS` erhöhen hilft (Kosten: Latenz).
- **Füll-Regime zehrt am Client-Puffer:** Reserve R wird über ~5R Sekunden aufgebaut und entzieht dem Client dabei ~R Sekunden. Reserve ≤ Client-Puffer wählen.
- Kanalwechsel-Spike (rx bis 57 Mbps, tx bis 38 Mbps, 1–2 s) ist Start-Durchleitung + Provider-Erstburst und füllt den Client-Puffer tief — gewollt, nur bei Provider-Bandbreitenlimit problematisch.

## Betrieb (wichtig)
- **Restart orphaned Aufnahmen:** Sessions leben nur im Speicher; nach Neustart blieben Zeilen auf `status='recording'`, hielten Upstreams mit 0 Zuschauern offen und blockierten Playback dauerhaft. `dvrRecorder.reconcileOrphanedRecordings()` beim Start (in `server.ts`) markiert sie als `completed`.
- **Umschalt-Spike begrenzen:** `LIVE_BUFFER_MAX_BYTES` deckelt nur Speicher; es gibt **keine** Flow-Control auf dem Upstream-Socket (bewusst: Pausieren riskiert Provider-Drop).
- **Container baut Frontend nicht:** `vite build` im Container wird bei 3 GB Limit / `--max-old-space-size=2304` vom OOM-Killer getötet (dist bleibt intakt). Frontend **lokal** bauen und `dist/` ins Image/Container bringen.

## Verifikation
- `npm run lint` + `npm test` (93 Tests, 16 Dateien).
- `server/multiplexer/stream-hub-pacing.test.ts`: fake Upstream (Bursts + 15 s Ausfall) mit Fake-Timern; asserted sofortigen Start (<1 s), keine Starvation-Sekunde, Rate ~Echtzeit nach Ausfall, kein ungepacter Gulp. **Gegenprobe:** Test schlägt fehl bei reintroduziertem Bucket-Bias (`expected [ 9 ]`), bei deaktiviertem Pacing und bei ungekappter Lücken-Spanne (`expected 408400 > 450000`).
