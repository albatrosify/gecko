# 2026-10-11 — DVR-Aufnahme direkt aus dem DVR-Tab (server-seitig)

Feature: Im DVR-Tab gibt es jetzt **„Neue Aufnahme"** — Sender aus einer Playlist wählen,
optional eine Dauer, fertig. Kein laufender Player nötig. Vorbereitung für ein zeitlich
bekanntes Live-Event (Eishockey-Match).

## Umsetzung (Kurz)

- Backend: `DvrRecorder.startChannelRecording()` + `attachExternalRecording()` in
  `server/dvr/recorder.ts`; `POST /api/dvr/record-channel` in `server/routes/dvr.ts`.
- Detail-Entscheidung siehe ADR `0001-dvr-server-side-recordings.md`.
- Frontend: `StartRecordingModal` + „Neue Aufnahme"-Button in `DvrManager`
  (`src/components/index.tsx`); API in `src/api.ts` (`dvr.startChannelRecording`,
  `dvr.getLiveChannels`).
- Senderliste kommt bewusst vom eigenen `player_api.php?action=get_live_streams`
  (über `api.dvr.getLiveChannels(username, password)`) — so stimmt die Auswahl exakt
  mit dem überein, was Downstream-Clients sehen (inkl. Symlinks/Custom-Namen).

## Wiederkehrende Fallstricke

- **Loopback-Response muss gedrained werden.** Wird der Response-Stream des internen
  Requests nicht gelesen, baut der Stream-Hub Backpressure auf und evictet den
  „Subscriber" nach dem Buffer-Limit. Deshalb `response.data.resume()` + `on('data', …)`.
- **Datei kommt aus den Roh-Chunks, nicht aus dem Loopback.** `handleUpstreamChunk`
  ruft `onChunkCallback(channel.channelKey, chunk)` nur, wenn `channel.dvrRecordingId`
  gesetzt ist → deshalb attacht der Proxy die Aufnahme **bevor** `addSubscriber` läuft.
- **Platzhalter vs. Fehler.** Der Guard schickt normalen Clients einen Platzhalter-Stream.
  Für DVR-Requests liefert der Proxy stattdessen HTTP 409, sonst würde die Hinweisanzeige
  in die Aufnahme geschrieben.
- **Doppelte Aufnahme desselben Senders** verhindert der Arbiter-Lock: zweiter Start
  scheitert mit „bereits gesperrt" (`session.attachError`).
- **Stirbt der Loopback-Socket unerwartet**, greift die bestehende Handover-Logik — der
  Kanal bleibt wegen `dvrRecordingId` am Leben und die Aufnahme läuft weiter, bis Dauer ab
  ist / manuell gestoppt / der Kanal ganz schließt.
- Die **DB-Zeile** wird erst nach erfolgreichem Attach geschrieben (dann ist `sourceId`
  exakt bekannt, auch bei Host-Failover). Fehlversuche hinterlassen keine Karteileiche.

## Gate

`npm run lint` 0 Fehler, `npm run test` 20 Files / 148 Tests grün, `npm run build` ok.
