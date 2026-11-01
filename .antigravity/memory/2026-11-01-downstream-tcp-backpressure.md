# Downstream TCP Backpressure Propagation

**Datum:** 2026-11-01  
**Komponenten:** `server/multiplexer/stream-hub.ts`, `server/multiplexer/stream-hub.test.ts`

### Problem
Wenn ein Client (z. B. TiviMate auf dem Nvidia Shield) angebunden war, füllte TiviMate seinen lokalen ExoPlayer-Puffer und stoppte zeitweise das Lesen aus dem TCP-Socket (`res.write() === false`).
Da der Gecko `StreamHub` als Broadcast-Multiplexer konzipiert ist, lief `upstreamResponse.data` im dauerhaft fließenden Modus (`.on('data')`) ohne Aufruf von `pause()`.
Folge:
1. Der Upstream-Provider (z. B. Tivione) schickte weiterhin Daten mit 25–40 Mbps.
2. Gecko staute die Daten in `channel.buffer` bis zum 64-MB-Ceiling (`LIVE_BUFFER_MAX_BYTES`).
3. Bei niedriger Stream-Bitrate (z. B. 2 Mbps) entsprachen 60 MB einem Puffer von **240 Sekunden**.
4. Beim Erreichen von 64 MB droppte Gecko die ältesten Pakete, was im Player zu massiven Zeitsprüngen und Einfrieren führte.

### Lösung
1. **Intelligente Backpressure-Erkennung (`checkUpstreamBackpressure`):**
   - Wenn genau ein Subscriber aktiv ist (`channel.subscribers.size === 1`) und keine DVR-Aufnahme läuft (`!channel.dvrRecordingId`):
   - Sobald der Client-Socket überlastet ist (`sub.res.writableLength > 4 MB`) oder `channel.bufferedBytes` das Ziel (`reserveBytes + 4 MB`) übersteigt:
     `pauseUpstream(channel)` ruft `channel.upstreamResponse.data.pause()` auf.
   - Dadurch stoppt Gecko das Lesen vom TCP-Socket des Providers. Das TCP-Empfangsfenster des Betriebssystems schließt sich (`TCP ZeroWindow`), und der Provider-Server stoppt das Senden.
   - Sobald der Player weiterliest, emittiert `sub.res` das `drain`-Event. Gecko ruft `resumeUpstream(channel)` (`channel.upstreamResponse.data.resume()`) auf, das TCP-Fenster öffnet sich wieder und der Provider sendet neue Chunks.
2. **Broadcast- & DVR-Schutz:**
   - Wenn ein zweiter Subscriber beitritt (`channel.subscribers.size > 1`) oder ein DVR-Recording anhängt, wird der Upstream sofort wieder aufgenommen (`resumeUpstream`), damit kein Teilnehmer verhungert.
3. **Gap-Timer-Schutz:**
   - Im `upstreamGapTimer` wird eine gewollte Backpressure-Pause nicht als Provider-Ausfall gewertet (`channel.isUpstreamPaused`). Ein 5-Minuten-Idle-Timeout trennt brachliegende Streams sauber.

### Verifikation
- 5 neue Unit-Tests in `server/multiplexer/stream-hub.test.ts`:
  1. Pausieren bei vollem Subscriber-Socket.
  2. Wiederaufnahme bei Socket-Drain.
  3. Kein Pausieren bei Multi-Subscriber.
  4. Sofortige Wiederaufnahme bei Beitritt eines zweiten Subscribers.
  5. Sofortige Wiederaufnahme beim Anhängen einer DVR-Aufnahme.
- `bun run lint` (0 Fehler) und alle 269 Tests bestanden.
