# 0001. Server-seitige DVR-Aufnahmen über internen Loopback

Datum: 2026-10-11
Status: accepted

## Kontext

Bisher gab es nur **Stream-Tee**-Aufnahmen: `DvrRecorder.startLiveRecordingFromConnection()`
braucht eine bereits aktive Proxy-Verbindung (Client spielt den Sender gerade). Im DVR-Tab
konnte man deshalb keine Aufnahme starten — für eine Sendung wie ein Eishockey-Match, das
man ohne laufenden Player aufnehmen will, fehlte der Einstiegspunkt.

Eine Aufnahme ohne Client muss den Upstream selbst öffnen. Diese Logik (Host-Failover,
Multi-IP-Pinning, VPN-Routing, Concurrency Guard, Stream-Hub-Multiplexing) steckt
vollständig in `handleStreamProxy()` (`server/routes/proxy.ts`) und ist ~450 Zeilen
verschränkt. Ein Heraus-Extrahieren wäre ein großer, riskanter Umbau.

## Entscheidung

Server-seitige Aufnahmen starten über einen **internen Loopback-Request** des Recorders an
den eigenen öffentlichen Proxy-Endpoint:

- `POST /api/dvr/record-channel` (`playlistId`, `streamId`, `streamName?`, `durationMinutes?`)
- `DvrRecorder.startChannelRecording()` öffnet `http://127.0.0.1:$PORT/live/{user}/{pass}/{streamId}`
  mit Header `x-gecko-dvr-recording-id`.
- `handleStreamProxy()` erkennt den Header, attacht die Aufnahme an den neu eröffneten
  (oder via Guard wiederverwendeten) Kanal über `DvrRecorder.attachExternalRecording()`.
- Der Loopback-Response wird nur **gedrained** (Discard). Die Datei wird aus den *rohen*
  Upstream-Chunks geschrieben (`handleUpstreamChunk` → `onChunkCallback`).
- Ist die Quelle durch einen anderen Stream belegt, antwortet der Proxy für DVR-Requests
  mit **HTTP 409** statt mit einem Platzhalter-Stream (sonst würde die Hinweisanzeige
  aufgenommen).
- `durationMinutes` startet einen Auto-Stop-Timer (`0` = bis manuell gestoppt, max. 24 h).

## Konsequenzen

Positiv:
- Feature nutzt die **komplette** Upstream-Pipeline wieder — kein Duplikat, kein Umbau.
- Aufnahme eines bereits laufenden Senders kostet **0 Extra-Verbindungen** (Guard
  `join_existing` → attach an den bestehenden Kanal).
- DVR-Lock (Arbiter) verhindert weiterhin zwei gleichzeitige Aufnahmen derselben Quelle.

Negativ / Fallstricke:
- Loopback über TCP kostet einen zusätzlichen Socket + Kopie pro Aufnahme; akzeptabel,
  da nur manuell gestartet. Traffic wird dabei einmal (über den Subscriber) gezählt.
- Recorder und Proxy kennen sich jetzt über einen HTTP-Header statt über direkte Calls.
- Der Loopback-Request taucht (unverändert) im Request-Log auf.
