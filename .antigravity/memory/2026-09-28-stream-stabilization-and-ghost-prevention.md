# Stream-Stabilisierung & Zombie-Connection-Prävention (5-Punkte-Roadmap)

**Datum:** 28.09.2026  
**Kontext:** Single-Connection-Provider (`max_connections: 1`), TiviMate / ExoPlayer VOD/Live Streaming, Vermeidung von Upstream-Überlastung und hängenden Geisterverbindungen.

---

### Hintergrund & Problemstellung
1. **Single-Connection Limit:** Provider wie Tivione erlauben exakt 1 gleichzeitige Verbindung. Jede Überschreitung führt zu Drosselung oder Provider-Fehlern (403/502/Pufferkreise).
2. **ExoPlayer/TiviMate Verhalten:**
   - Beim Spulen (Seek) oder schnellen Umschalten auf die nächste Episode sendet der Player bereits eine neue HTTP-Anfrage (oft mit `Range`), während der alte Socket clientseitig gerade erst schließt.
   - VOD puffert stoßweise (~48 Mbit/s) und pausiert danach den Datenbezug für mehrere Minuten (`TCP Zero Window`).
   - Bei Live TV führen kurze Paketverluste oder Upstream-CDN-Hänger (>3-6 s) dazu, dass der Player-Puffer leerläuft und TiviMate hart abbricht.
3. **Guard-Blindspot:** Der Concurrency Guard überprüfte bisher nur Live TV in `StreamHub`. VOD-Streams waren für den Guard unsichtbar.

---

### Umgesetzte Maßnahmen

1. **Vollständiges Socket-Lifecycle-Cleanup (VOD & Timeshift)**
   - Alle Downstream-Events (`req.on('close')`, `req.socket?.on('close')`, `req.socket?.on('error')`, `res.on('finish')`, `res.on('close')`, `res.on('error')`) verdrahtet.
   - Alle Upstream-Events (`response.data.on('close')`, `response.data.on('end')`, `response.data.on('error')`, `socket?.on('close')`, `socket?.on('error')`) verdrahtet.
   - Idempotente Teardown-Sperre (`cleanedUp`-Flag) verhindert Mehrfachaufrufe und Race Conditions.
   - Timeshift vollständig in `proxyStats.connections` und `streamControllers` integriert.

2. **VOD Stream-De-Duplikation & Auto-Replacement**
   - Vor dem Aufbau eines neuen VOD-Upstreams wird geprüft, ob für `(playlistId, username)` bereits ein VOD-Stream existiert.
   - Bei gleichem Stream (Seek/Retry) oder Single-Slot-Accounts (`maxConnections <= 1`) wird der vorherige Stream sofort über seinen Controller sauber beendet (`killStream`).
   - Dadurch ist der Upstream-Slot beim Provider garantiert frei, bevor die neue Upstream-Anfrage initiiert wird.

3. **Einheitlicher Concurrency Guard (Live + VOD)**
   - `proxy-stats.ts`: Neue Hilfsfunktion `getActiveVodConnectionsForSource(sourceId)` isoliert echte 1:1-Upstream-Verbindungen.
   - `stream-guard.ts`: `evaluateStreamRequest` berücksichtigt jetzt die Summe aus aktiven Live-Kanälen und VOD-Verbindungen.
   - Läuft ein VOD-Film auf einem 1-Verbindungs-Account, blockiert ein neuer Live-TV-Request sauber via Platzhalter (`block_placeholder`), statt den Film zu zerstören.
   - Umgekehrt blockieren VOD-Requests, wenn Live TV aktiv ist (sofern es sich um unterschiedliche Nutzer/Clients handelt).

4. **Periodischer Zombie-Socket-Sweeper**
   - `proxy-stats.ts`: `streamControllers` speichert neben dem Kill-Handler optional eine Liveness-Prüfung (`isAlive()`).
   - Alle Controller (Live-Subscribers, VOD, Timeshift, Placeholder) prüfen `!res.destroyed && !res.writableEnded && !(req && req.destroyed)`.
   - Alle 10 Sekunden fegt der Sweeper verwaiste Einträge ohne Controller sowie Verbindungen mit toten Sockets aus `proxyStats.connections` und killt hängende Upstream-Sockets.

5. **Self-Healing Live TV Reconnect bei Upstream-Gaps**
   - `stream-hub.ts`: Speichert `upstreamConfig` (URL & Headers) beim Registrieren eines Kanals.
   - Erkennt der Watchdog eine Stille von >= 6 Sekunden (`silentMs >= 6_000`) oder schließt der Upstream unerwartet, während noch Subscriber warten, stößt `reconnectChannel()` einen nahtlosen In-Place-Reconnect an.
   - Die Downstream-Sockets der Clients bleiben offen und bedienen sich aus ihrem internen Puffer (5-10 s). Sobald der neue Upstream steht, fließen Chunks nahtlos weiter, ohne dass der Client abbricht oder TiviMate neu laden muss.

---

### Verifikation & Tests
- `server/proxy-stats.test.ts`: 4 neue Unit-Tests für Controller, VOD-Filterung und Zombie-Sweeper.
- `server/multiplexer/stream-guard.test.ts`: 2 neue Unit-Tests für VOD-Überlastungs-Schutz.
- `server/multiplexer/stream-hub.test.ts`: Neuer Unit-Test für In-Place Self-Healing Reconnect.
- Gesamter Testbestand: 15 Testdateien, 91 Tests erfolgreich, Type-Check (`tsc --noEmit`) fehlerfrei.
