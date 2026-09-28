# Incident & Finding: VOD Stream Inactivity Timeout & Buffer Pauses

**Datum:** 2026-09-28  
**Komponenten:** `server/routes/proxy.ts` (VOD / Movies / Series & Timeshift Proxy)

## Problem & Symptome
- Bei VOD- und Serien-Wiedergabe (z.B. über TiviMate / ExoPlayer) kam es periodisch alle 2–4 Minuten zu Stream-Abbrüchen und Ladekreisen (Buffering).
- Gleichzeitig verschwand der Stream im Gecko Web-Interface („Now Playing“ / „Aktive Streams“ zeigte 0 aktive Verbindungen), obwohl der Client die Serie weiter abspielte.

## Root Cause
1. **HTTP Range Chunking & Player Buffering:**
   - Anders als Live-TV (kontinuierlicher Stream) laden moderne VOD-Player (ExoPlayer in TiviMate) per HTTP Range Requests größere Chunks (20–30 MB) mit maximaler Bandbreite in den RAM-Puffer.
   - Sobald der Puffer voll ist, stoppt der Player das Lesen vom TCP-Socket (`TCP Zero Window` / `win 0`).
2. **Backpressure & 15-Sekunden Axios Socket-Timeout:**
   - Node.js reagiert auf die TCP-Blockade mit Backpressure und pausiert das Lesen von der Upstream-Quelle (`response.data.pause()`).
   - Die Upstream-Anfrage wurde mit `axios({ timeout: 15000, responseType: 'stream' })` initialisiert.
   - In Node.js setzt dieser Timeout einen Socket-Inaktivitäts-Watchdog (`socket.setTimeout(15000)`).
   - Sobald 15 Sekunden lang wegen des vollen Puffers keine Daten über die Upstream-Leitung flossen, abortete Axios den Socket mit `ECONNRESET / aborted`.
   - Geckos Error-Handler (`response.data.on('error', cleanup)`) rief `cleanup()` auf und zerstörte die Downstream-Client-Verbindung per `res.destroy()`.
   - Sobald der Client-Puffer nach 2–4 Minuten aufgebraucht war, stieß der Player auf die geschlossene Verbindung und musste den Stream unter Ladekreis-Anzeige komplett neu anfordern.

## Lösung
1. **Socket-Timeout nach Handshake entfernen:**
   - Sobald die HTTP-Header (200/206) vom Upstream vorliegen, wird der Socket-Timeout deaktiviert (`setTimeout(0)`), damit Backpressure-Pufferpausen nicht zum Verbindungsabbruch führen.
2. **TCP Keepalive aktivieren:**
   - Sowohl auf dem Downstream- als auch Upstream-Socket wird `socket.setKeepAlive(true, 10000)` aktiviert, um NAT-/VPN-Timeouts bei ruhenden Sockets zu verhindern.
3. **10-Minuten Inaktivitäts-Watchdog:**
   - Ein Timer trennt ruhende VOD-Verbindungen erst, wenn 10 Minuten lang kein einziges Byte abgefordert wurde (Schutz vor blockierten Provider-Slots bei verlassenen/pausierten Clients).
