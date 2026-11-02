# Prod-Incident 2026-11-02: ProSieben/RTL-Zwei-Streams „Loading-Kreis", barfik „Socket is closed"

## Kontext

User meldet: aktueller Kanal (ProSieben) startet nicht, Daten fließen aber sichtbar;
andere Kanäle (RTL/ZDF/WDR) laufen. TiviMate/„Tivione-Marius" wirft rote `Socket is
closed`-Zeilen in der Log.

## Zwei unabhängige Ursachen + ein Struktur-Befund

### 1. barfik-Hosts: stale IP-Cache → TLS-Hangs → „Socket is closed" (gelöst)

- Anwendung: Ops-DB-Tweak, kein Codefix. `sources.extra.hosts[barfik]` hatte 11
  `resolvedIps` vom Benchmark 2026-11-01 17:42 UTC; der Provider hat die A-Records
  seither komplett umgebogen (alt: 57.130.75.x/141.95.x/51.75.x/51.89.x — LB-Set;
  neu: 57.131.18.x/57.130.82.x/57.130.72.x/91.134.239.x/159.173.134.x — direkte Nodes).
- Die alten IPs akzeptieren TCP:443 (probe „TCP ok"), der TLS-Handshake mit SNI
  hängt aber endlos → axios/Bun meldet `Socket is closed` je nach Attempt nach
  ~3–12 s. Pro Anfrage werden ALLE 11 IPs durchprobiert (Loop in
  `proxy.ts` Failed-Handling), dann Host-Wechsel.
- **Warum der Demote nicht griff:** `hosts.ts` `isHostDemoted()` hat eine
  10-min-Probation (`HOST_HEALTH_PROBATION_MS`): wenn ein Host länger als 10 min
  *nicht getestet* wurde (weil er schon immer fehlschlug und dadurch „lastErrorAt"
  alt war), wird er wieder vorne versucht. Kombiniert mit dem stale IP-Cache
  resultierte das in periodischen ~2-min-„Rote-Zeilen"-Zügen alle ~10 min.
- **Fix (Live, prod):** `resolvedIp`/`resolvedIps` des barfik-Hosts in der DB
  geleert → `proxy.ts` fällt in den `candidateIps.length <= 1`-Pfad →
  frisches DNS pro Anfrage → frische IPs antworten sofort (65–76 ms Handshake,
  verifiziert via Gecko Ende-zu-Ende mit ffmpeg).
- **Code-Fix (2026-11-02, umgesetzt):**
  - `hosts.ts`: `isConnectionClassFailure()` (ETIMEDOUT/ECONNREFUSED/EPROTO/
    ECONNRESET/EPIPE/„Socket is closed“/TLS) und `mergeFreshHostIps()`
    (merge frische DNS-IPs nach vorne in `extra.hosts`, Cap 10).
  - `proxy.ts`: bei Connect-Klasse-Fehler an einem Host MIT Benchmark-Pin-Liste
    einmal DNS neu auflösen und neu gesehene IPs **direkt hinter dem
    gescheiterten Kandidaten** in `ipsToTry` einschieben (Cap 4/Request);
    Erfolg über eine frische IP → Liste in der DB persistieren (kein manuelles
    Re-Benchmark nötig). HTTP-Status-Fehler triggern KEIN Re-Resolve.
  - `stream-hub.ts` `reconnectChannel()`: nach einer vollen fehlgeschlagenen
    Rotation über die Kandidaten-IPs (Zähler `reconnectRotations`, Reset bei
    Erfolg/Channel-Close) wird der bei Registrierung eingefrorenen Pin-Snapshot
    gelöscht → Reconnects laufen über normales DNS.
  - Tests: `proxy-multi-ip.test.ts` (Re-Resolve + Persist + kein Re-Resolve bei
    HTTP-Status), `stream-hub.test.ts` (Snapshot-Drop nach Vollrotation).
    272 Tests grün, lint sauber. **ACHTUNG:** Die Reconnect-Tests nutzen
    `vi.doMock('axios')` + `vi.resetModules()` je Test (Pattern der Datei) —
    ein Datei-weites `vi.mock('axios')` verlangsamt/kompliziert die früheren Tests.


### 2. Televizo/„Marius"-Playlist (g1ming): ProSieben-Circle-of-Loading

- Playlist-Layout: „Marius" (`user=live`) → nur g1ming-Quelle;
  „Tivione-Marius" (`user=tivi`) → nur barfik/fikar.
- Verify: ProSieben g1ming-Feed (480050) upstream ist **valid MPEG-TS**:
  PAT/PMT, h264 1080p50, AC-3 5.1, CC 0 Discos, PTS/PCR laufen konstant
  ~2.3–2.5× realtime (Provider „heiß"). Zwei unabhängige Captures.
- Ende-zu-Ende-Check: über geckos Proxy abgegriffene
  Downstream-Bytes (`/live/<user>/<pass>/<id>.ts` aus dem Container)
  sind valid TS (ffmpeg decodiert) — für HUNGAMA (barfik via
  `480050`) UND ProSieben (barfik `1025127`, h264 + **eac3**).
- **Muster:** Kanäle, die bei Televizo hängen = alle AC-3/E-AC-3-Feeds
  (ProSieben, RTL Zwei, VOX, SAT.1, Kabel 1, Sixx, DMAX 5.1, Das Erste 5.1);
  Kanäle, die laufen = AAC-2.0-Feeds (RTL HD 720p, ZDF, WDR). VLC auf
  Desktop decodiert AC-3 nativ → läuft. Kein Verdacht mehr gegen
  Gecko/Multiplex: verdächtig bleibt die Client-Codec-Basis
  (Televizo/Device — Dolby-Audio-Codec cfg/prüfen: AC3-Passthrough-An/Aus,
  Software-Decoding). Gecko könnte ggf. AC3→AAC-Transcode anbieten
  (Aufwand: ffmpeg im Stream-Hub — bewusst nicht umgesetzt).

### 3. Stream-ID-Kollision über Quellen (beachten, prüfen)

- Stream-IDs sind pro Upstream-Quelle numerisch eigenständig;
  `480050` = ProSieben (g1ming) UND HUNGAMA SERIES (barfik) zugleich.
  Playlists sind hier 1-Quelle, daher im Incident unkritisch — aber
  2-Quellen-Playlists mit ID-Kollision resolve first-match-wins in der
  `proxy.ts`-Source-Schleife. Nicht Teil dieses Incidents, aber
  Struktur-Risiko für Multi-Source-Playlists merken.

## Nicht-Täter

- `stream-hub` Backpressure-Pause/Resume-Loop (Commit 26a1bf0) läuft
  pause->resume-Ping-Pong am 4-MB-Threshold ohne Hysterese — Datenstrom
  bleibt aber im Fluss; nicht Ursache des Deadends.

## Bewährtes Diagnose-Rezept (Update)

- Bei „daten fließen, Bild bleibt weg": zuerst **Downstream-Capture durch
  Gecko** (`curl http://127.0.0.1:<PORT>/live/<user>/<pass>/<id>.ts` im
  Container, ~8 MB) + hostseitig `ffprobe` — das trennt Gecko von Client
  in einem Rutsch. PORT im Container-Env (prod: 8850).
- Xtream-Live-IDs sind **pro Quelle** eindeutig, nicht global.
