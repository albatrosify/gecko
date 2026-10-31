# Finding: Conservation-Ratenschätzung ersetzt die heiße Data-Time-Bucket-Schätzung

**Datum:** 2026-10-30
**Komponenten:** `server/multiplexer/stream-hub.ts` (`measureUpstreamRate`, `enqueueChunk`, `pumpChannelBuffer`)
**Grund:** Der Live-Floor (konfiguriert 12 s) hielt in der Praxis nur ~4 s, weil die Freigaberate ein paar Prozent **heiß** lief und den Puffer langsam leerzog (siehe `2026-10-09-tivimate-jitter-buffer-tuning.md` und die Deploy-Zusammenfassung zu Commit `5d5db76`).

## Was geändert wurde
- **Alte Schätzung:** `rateBuckets` (Bytes pro Wall-Clock-*Sekunde*) → Rate über „Data-Time"-Spanne (Gaps auf 12 s gekappt) mit `oldestBytes`-Abzug. Granularitäts-Bias: ein 200-ms-Burst zählte als volle Sekunde, die Spanne wurde komprimiert → systematisch ~5 % zu hoch.
- **Neue Schätzung:** Wall-Clock-**Snapshots** `{ at, read }` im Sekundenabstand (im Pump), Rate = `Δread / Δwall-clock` über ein **60-s-Fenster**. Exakt (Bytes sind konserviert: `arrived = released + Δbuffer`), kein Bucket-Bias, läuft nicht heiß.
- **Freeze:** Bei Upstream-Stille > 12 s (`LIVE_BUFFER_RATE_FREEZE_MS`) wird die Rate eingefroren (`lastMeasuredRate`) statt mit dem Fenster zu zerfallen — der Pump gibt gepufferten Inhalt weiter, statt den Player auszuhungern.
- **Reset:** Nach einer langen Lücke (`gapSinceLastChunk > 12 s`) und nach dem Connect-Burst (`inInitialBurst` + `> 8 MB`) wird das Fenster geleert, damit die Rate aus frischen Daten anläuft statt aus einem verzerrten Tail.

## Fenster-Wahl (60 s statt der vorgeschlagenen ~15 s)
15 s ließ einen einzelnen Multi-MB-Gulp die Rate verzerren (im Surplus-Test 5 MB → ~343 KB/s statt 10 KB/s, Floor transient 1,37 MB). Die **Exaktheit** (Wall-Clock-Snapshot statt Data-Time-Bucket) ist der eigentliche Fix — nicht die Fensterlänge. 60 s ist robust gegen Einzel-Bursts und VBR-Sport-Spikes; verstellbar über `LIVE_BUFFER_RATE_WINDOW_S`.

## Verifikation
- `bun run test`: 255 Tests grün (inkl. neuem Freeze-Test: Rate fällt über 15 s Stille nicht auf null).
- `bun scripts/check-db-driver.ts` (16/16) und `bun scripts/check-sync-isolation.ts` (PASS) weiter grün.

## Korrektur einer früheren Diagnose
„Provider-Pausen 13–17 s" war ein Artefakt: `UPSTREAM_GAP_WARN_MS = 13_000` loggt nur Lücken ≥ 13 s, der Grep zeigte also nur den Tail. Real: ~5 s typisch, ~9,8–10,5 s häufig, 13–17 s gelegentlich (~24 Events/24 h vs. 68 „Downstream starved"). Der dominante Grund fürs häufige Buffering war der **nicht haltende Floor** (~4 s), der schon die normalen 5–10-s-Lücken durchlässt. Deshalb ist **kein Floor-Anheben auf 18–20 s nötig** — ein korrekt gehaltener 12-s-Floor + Player-Puffer deckt die Normallücken ab.
