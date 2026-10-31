# Web-Player: Codec-Lücken und Audio-Transcode

Datum: 2026-10-31
Kontext: „Der Web-Player soll ein Player sein, der wirklich funktioniert."

## Befund

`mpegts.js` ist **nicht** die Grenze. Version 1.8 demuxt AC-3/E-AC-3 und baut
sogar die passenden MP4-Sample-Entries (`ac-3`, `ec-3`, `hvc1`, `av01`). Der
Fehler kommt erst von `MediaSource.addSourceBuffer`, das den Codec ablehnt.

Konkrete Lücken (Stand 2026):

| Codec | Browser-MSE | Konsequenz |
|---|---|---|
| AC-3 / E-AC-3 / DTS | nirgends (Safari nur in *nativem* HLS) | Server-Transcode (ADR 0005) |
| MP2 | unzuverlässig | Transcode |
| MPEG-2 Video | nirgends, auch WebCodecs nicht | nur echter Video-Transcode (offen) |
| MPEG-4 Part 2 (Xvid, VOD) | nirgends | nur Video-Transcode (offen) |
| HEVC/H.265 | Chrome 107+, Edge, Safari 11+, FF 120+ — **nur mit Hardware-Decoder** | funktioniert oft schon, aber nie geprüft |
| H.264 / AAC | überall | Basis |

Wichtig: Ein Player-Library-Wechsel (Shaka, video.js, hls.js) bringt **null**
neue Codecs — alle enden in MSE. Mehr Codecs gibt es nur über WebCodecs/WASM
(CPU) oder Server-Transcoding (Server-CPU) oder WebRTC (anderer Transport).

## Nicht-offensichtliche Fallstricke

1. **Doppelte Traffic-Buchung**: Der Transcode zieht über einen Loopback-Request.
   Der Loopback-`Subscriber` läuft durch den normalen Hub-Pfad und würde die
   Bytes verbuchen — zusätzlich zu den Bytes, die der Transcode an den echten
   Client schickt. Deshalb `internal: true` im `DownstreamSubscriber` (kein
   Dashboard-Card, kein `recordTraffic`, zählt nicht als Zuschauer).
2. **Header erst mit dem ersten Chunk senden.** Sonst bekommt der Client ein
   leeres HTTP 200, wenn ffmpeg beim Probing stirbt — und der Player kann den
   Fehler nicht erklären. Deshalb puffert `handleAudioTranscode` bis zum ersten
   `stdout`-Chunk und antwortet bei frühem Exit mit 502 + stderr-Tail.
3. **`-analyzeduration` default ist 5 s.** Für Live-Zapping zu lang; auf 1 s
   (mit `-probesize 1M`) begrenzt. Im Test: erster Chunk nach <1 s.
4. **Ein ffmpeg pro Zuschauer**, nicht pro Kanal. Bewusst: geteilter Transcode
   bräuchte Slowest-Consumer-Handling. Cap via `GECKO_MAX_AUDIO_TRANSCODES`.
5. **`directStreams`-Playlists können nicht transcodiert werden** — der Player
   spricht dann den Provider direkt an. `withAudioTranscodeParam()` gibt `null`
   zurück und die UI sagt es ehrlich.
6. **Audio-Modus gehört zum Kanal**: `audioState = { url, mode }`, sonst würde
   ein „video-only"-Fallback auf den nächsten Kanal vererbt.

## Verifiziert

- AC-3-TS → ffmpeg-Args → `h264 (copy) + aac 48 kHz stereo`, Exit 0.
- HTTP-Ebene: 200 / `video/mp2t` / `X-Gecko-Transcode: audio`; Limit `0` → 503;
  Client-Abbruch → ffmpeg beendet, keine Waisenprozesse, Session-Zähler 0.

## Offen / nächster Schritt

- Video-Transcode-Fallback (MPEG-2/MPEG-4ASP/HEVC ohne HW-Decoder). Braucht GPU
  (VAAPI/QSV/NVENC) für mehr als 1–2 parallele 1080p-Streams; auf ARM-VPS
  (siehe `2026-09-27-arm-vps-oom-crash-loop.md`) nicht sinnvoll.
- VOD-Audio-Transcode (`-movflags frag_keyframe+empty_moov` → fMP4): spielbar,
  aber ohne Seek/Range. Erst sinnvoll, wenn AC-3-VOD tatsächlich auftaucht.
- Codec-Inventar über den bestehenden `ffprobe`-Pfad in `server/quality.ts`
  (Stichprobe je Quelle) — sagt, ob MPEG-2 überhaupt relevant ist.
