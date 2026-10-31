# 0005. Live-Audio-Transcode für den Web-Player (Video bleibt Copy)

Datum: 2026-10-31
Status: accepted

## Kontext

Der Web-Player (`src/components/WebPlayer.tsx`) spielt Live-Streams über
`mpegts.js` → MediaSource. Das Demuxen ist nicht das Problem: `mpegts.js` 1.8
erzeugt für AC-3/E-AC-3 sogar die passenden MP4-Sample-Entries. **MediaSource
lehnt den Codec danach ab** — in jedem Chromium- und Firefox-Build. IPTV-
Provider nutzen AC-3/E-AC-3 aber gerade auf den HD-Sendern, dazu DTS und MP2.

Bisherige „Lösung": der Player startete bei einem Audio-Fehler still ohne
Tonspur neu (`hasAudio: false`) und zeigte nur einen Warnbanner. Ergebnis: der
Kanal „läuft", aber tonlos — und niemand weiß, warum.

Kein JS-Player löst das: `hls.js`, `video.js`, Shaka und `mpegts.js` enden alle
in MSE. Mehr Codecs gibt es nur über (a) WebCodecs/WASM-Decoding, (b)
Server-Transcoding oder (c) einen anderen Transport (WebRTC).

## Entscheidung

1. **Server-seitiger Audio-Remux statt Video-Transcode.** `ffmpeg` läuft mit
   `-c:v copy`, nur die erste Audiospur wird zu AAC/48 kHz/Stereo. Kein
   Qualitätsverlust beim Video, ~2–4 % eines Cores pro Stream, keine GPU.
2. **Container bleibt MPEG-TS.** Damit bleibt der Client-Pfad unverändert
   (`mpegts.js`), es gibt keinen neuen Transport und keine zusätzliche Library.
3. **Der Transcode hängt sich an die Loopback-URL**, nicht an den Upstream —
   dasselbe Muster wie `startChannelRecording` (ADR 0001). Host-Failover,
   Multi-IP-Pinning, VPN-Routing, Concurrency-Guard und Multiplexer laufen
   dadurch unverändert und **genau einmal**.
4. **Ausgelöst per Query-Parameter** `?transcode=audio` auf der bestehenden
   Live-Route. Kein neuer Endpoint, keine Änderung an `player_api.php` oder den
   Downstream-Clients.
5. **Der Client eskaliert automatisch**: `original` → `transcoded` → `off`
   (video-only). Ausgelöst vom `MEDIA_ERROR` / `NotSupportedError`, nicht von
   einer Vorab-Probe — ein `ffprobe` pro Zapping würde einen zweiten
   Upstream-Slot kosten.
6. **Ehrliche UI statt stiller Degradierung**: `src/playback-capabilities.ts`
   misst die MSE-Allowlist (`MediaSource.isTypeSupported`) und zeigt im
   Fehlerfall, was der Browser kann (H.264/H.265/AAC/AC-3 …).
7. **Cap + Lifecycle**: `GECKO_MAX_AUDIO_TRANSCODES` (Default 4, `0` = aus).
   ffmpeg wird bei Client-Disconnect beendet, `stdout` pausiert bei
   Downstream-Backpressure, `SIGTERM`→`SIGKILL` nach 2 s, und beim Shutdown
   räumt `stopAllTranscoders()` auf.

## Konsequenzen

Positiv:
- AC-3/E-AC-3/DTS/MP2-Kanäle sind im Browser **mit Ton** nutzbar, ohne dass der
  Nutzer etwas tun muss.
- Video wird nicht neu kodiert → keine Qualitätsverluste, kein GPU-Bedarf.
- Der interne Loopback-Subscriber ist als `internal` markiert und erzeugt weder
  eine Dashboard-Karte noch doppelte Traffic-Buchung (sonst würde dieselbe
  Sendung zweimal im Monatskontingent landen).

Negativ / Risiko:
- Ein ffmpeg-Prozess **pro Zuschauer** (nicht pro Kanal). Bei mehreren Zuschauern
  desselben Kanals wird mehrfach identisch transkodiert. Bewusst akzeptiert:
  ein geteilter Transcode bräuchte Slowest-Consumer-Handling und ein eigenes
  Fan-out; die Kosten (Audio allein) sind gering. Der Cap verhindert Ausuferung.
- +0,3–1,5 s Startlatenz (Probe-Budget auf 1 s begrenzt).
- Der Web-Player braucht dafür die **proxied** URL; im `directStreams`-Modus
  (Player spricht den Provider direkt) ist kein Transcode möglich — die UI sagt
  das dann auch.
- MPEG-2-Video bleibt unmöglich. `-c:v copy` hilft dort nicht, das wäre ein
  echter Video-Transcode (offen, siehe Memory-Eintrag).

## Verifikation

- `server/transcode.test.ts`, `src/playback-capabilities.test.ts`
- Manuell: AC-3-TS → `buildAudioTranscodeArgs` → ffprobe zeigt
  `h264 (copy) + aac 48 kHz stereo`; Client-Abbruch beendet ffmpeg
  (keine Waisenprozesse), Limit `0` liefert HTTP 503.
