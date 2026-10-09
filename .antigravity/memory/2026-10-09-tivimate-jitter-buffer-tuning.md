# Finding: TiviMate Live-Buffering vs. Zapping — Jitter-Buffer-Tuning & Pacing-Entlastung

**Datum:** 2026-10-09  
**Komponenten:** `server/multiplexer/stream-hub.ts`, `docker-compose.yml`

## Symptome & Beobachtungen
- TiviMate zeigte regelmäßige Aussetzer/Ladekreise („Buffering“) bei Live-TV — insbesondere kurz nach dem Start/Kanalwechsel („2x gebuffert“).
- VLC lief scheinbar länger flüssig, stockte aber bei längeren Starvations ebenfalls für 1–2 Sekunden.
- Live-Messungen auf Prod (`homgsa.de`) zeigten:
  - Upstream-Provider (`line.tivione2.cv` / `operator3.fikar.xyz`) liefert bursty mit **9,8 bis 10,5 Sekunden Totzeit** synchron zwischen Bursts.
  - Gelegentliche Aussetzer von **>15 Sekunden** (z.B. 15,48 s), die Reconnects triggern.
  - Downstream starvte regelmäßig für 2,5 bis 8 Sekunden (`⚠️ Downstream starved for 2500–8000 ms`).

## Root Cause
1. **Ungepactes Ausleeren des Start-Bursts leerte Geckos Puffer:**
   - In den ersten 3 Sekunden (`warmup`) war `pacing` bisher `false`.
   - Der initiale 3-MB-Burst des Providers wurde komplett in einem Wisch an den Client gesendet.
   - Folge: Geckos interner Puffer war sofort bei **0 Bytes**!
   - Da der Provider direkt nach dem Startburst für 5–8 Sekunden pausiert, stand Gecko mit leerem Puffer da und sandte für 5–8 Sekunden 0 Bytes ⇒ Sofortiges Buffering kurz nach dem Start!
2. **80%-Bremse (`LIVE_BUFFER_FILL_FACTOR = 0.8`) erzeugte Teufelskreis:**
   - Sobald `bufferedBytes < reserveBytes`, drosselte Gecko die Ausgabe an Clients auf 80 % der Stream-Rate.
   - Da die Provider-Bursts den Puffer vor der nächsten Pause selten auf die volle Reserve brachten, lief Gecko fast dauerhaft auf 80 %.
   - TiviMates interner ExoPlayer-Puffer (1,5–2,5 s) wurde dadurch kontinuierlich leergesaugt ⇒ Weiteres Buffering im laufenden Betrieb.
3. **`LIVE_BUFFER_RATE_MAX_GAP_S` deckelte reale 10s-Pausen:**
   - 10s-Pausen wurden auf 8 s gekappt, was die gemessene Rate um ~10–15 % überschätzte und den Pacer den Puffer leerlaufen ließ.
4. **`GECKO_LIVE_BUFFER_SECONDS = 6-9s` vs. 10,5s-Lücken:**
   - Provider pausiert synchron bis zu 10,5 Sekunden. 9 Sekunden Reserve reichen nicht ganz.

## Lösung
1. **Initialer Token-Burst (`LIVE_BUFFER_INITIAL_BURST_BYTES = 1_200_000`) & Fallback-Rate:**
   - Pacing ist ab Millisekunde 1 aktiv mit einem Fallback-Schätzwert (`800 KB/s`), sodass der Puffer nie unkontrolliert auf 0 geleert wird.
   - Gleichzeitig startet `pacingTokens` mit 1,2 MB Allowance: Der Client bekommt sofort 1,2 MB in <50ms (blitzschnelles Umschalten), während der Rest des Provider-Bursts im Gecko-Puffer verbleibt.
2. **Pacing-Entlastung in `stream-hub.ts`:**
   - Wenn der Puffer gesund ist (>= 40 % der Reserve), wird mit **voller Rate (1.0x)** ausgeliefert. TiviMates Puffer wird nicht mehr leergesaugt.
   - Nur wenn der Puffer kritisch tief fällt (< 40 %), greift ein minimaler Ausgleich (`0.96x`), den Audio-/Video-Clock-Drift unbemerkt schluckt.
3. **Gapanalyse-Korrektur:**
   - `LIVE_BUFFER_RATE_MAX_GAP_S` auf 12 Sekunden erhöht.
   - `UPSTREAM_GAP_WARN_MS` auf 13.000 ms und `UPSTREAM_GAP_RECONNECT_MS` auf 16.000 ms angehoben (keine Fehlalarme oder vorzeitigen Socket-Kills bei normalen 11-13s Provider-Pausen).
4. **Reserve auf 12 Sekunden:**
   - `GECKO_LIVE_BUFFER_SECONDS = 12` fängt 10,5s-Pausen vollständig ab, ohne dass der Puffer je 0 Bytes erreicht.
   - Umschaltzeit bleibt dank des initialen Token-Bursts bei < 500 ms.
5. **Connect-Burst Bitraten-Vergiftung & Filterung (Fix für das Leersaugen nach ~45s):**
   - **Phänomen:** Xtream-Upstreams dumpen auf Connect 25–35 MB in 6–10 Sekunden über TCP.
   - **Problem:** Die gleitende Bitratenmessung (`rawRate = total / spanSeconds`) sah 25 Mbps Durchsatz und pacingte daraufhin mit dem Maximum (12 Mbps), während der Stream nach Sekunde 10 real nur 6 Mbps lieferte. Folge: Nach exakt 40–45 Sekunden war der gesamte Vorlauf verfeuert und der Puffer fiel auf 0 Bytes.
   - **Lösung:** `inInitialBurst`-Erkennung mit `burstBytes`-Tracking. Wenn ein TCP-Vorlauf (> 8 MB) nach der ersten echten Providerpause (> 1,5s Pause nach mindestens 3s) oder nach 12s endet, wird `rateBuckets` bereinigt.
   - Der Vorlauf (25–30 MB) bleibt als sicheres ~35-Sekunden-Kissen in `channel.buffer`, während die Bitratenmessung sauber auf dem echten Live-Broadcast startet.
6. **VBR-Action-Spikes (Eishockey DEL 2) & Verbot von Drosselung unter 1.0x:**
   - **Problem:** Live-Sport (DEL 2 Eishockey) schwankt bei schnellen Spielzügen von 6 Mbps auf **10–12 Mbps**. Ein starrer Pacer auf Basis des 60s-Durchschnitts (6 Mbps) würgt den Player bei Action ab.
   - **Tödlicher Denkfehler bei `fillFactor < 1.0`:** Ein Video-Decoder spielt stur bei 1.0x Echtzeit (50 fps). Jede Drosselung unter 1.0x (wie 0.97x oder 0.92x) entzieht dem Player kontinuierlich Daten und leert seinen internen Puffer nach 1–2 Minuten vollständig ⇒ periodisches Buffering!
   - **Lösung:**
     - NIEMALS unter 1.0x drosseln.
     - Wenn der Puffer gesund ist (`> reserveBytes * 1.2`): Ausgabe mit 1.08x erlauben, um VBR-Spitzen abzufangen und Überschuss sanft abzubauen.
     - `LIVE_BUFFER_BURST_SECONDS` auf 0.6s erhöht und `LIVE_BUFFER_MAX_STREAM_RATE_BPS` auf 2.5 MB/s (20 Mbps) angehoben.
   - **Verifikation Prod:** Puffer hält konstant 21–27 MB im RAM, TiviMate läuft unterbrechungsfrei ohne periodische Re-Buffers.
