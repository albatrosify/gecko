# Incident: ARM VPS Heap Out-of-Memory Crash Loop & Stream Gaps

**Datum:** 2026-09-27  
**System:** Oracle ARM VPS (`arm.tailc4f9b.ts.net`), Docker Stack (`/home/ubuntu/docker/iptv`)

## Kontext & Symptome
- Der Gecko-Container ist in einer permanenten Absturzschleife gelaufen (**58 Container-Restarts**).
- Im Docker-Log trat wiederholt auf:
  `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`
- Streams brachen abrupt ab, Clients (z.B. TiviMate, VLC) mussten sich ständig neu verbinden.
- Live-Streams zeigten häufige Pausen von 3–5 Sekunden (`upstream silent for 3600-4900 ms`), da Upstream-Paketverluste (~20% zu `line.tivi-ott.net`) und Timeouts zu `operator3.barfik.org` auftraten.

## Root Cause
1. **Container Memory Limit & Node.js Default Heap**:
   - In `docker-compose.yml` war `gecko` auf `mem_limit: 1500m` beschränkt.
   - Da `NODE_OPTIONS` nicht gesetzt war, begrenzte V8 seinen maximalen Heap (`max_old_space_size`) auf ~774 MB.
2. **Große Payloads bei Sync & XMLTV**:
   - Bei Source-Syncs wurden riesige Datensätze (z.B. 158.904 VOD-Streams) synchronisiert, in Maps indiziert, gechangeloagt und per `JSON.stringify` serialisiert.
   - Beim Abruf von `/xmltv.php` wurden unkomprimierte XMLTV-Dateien vollständig als Buffer/Strings in den Speicher geladen.
   - Sobald der Heap ~750–800 MB erreichte, terminierte V8 den Prozess mit OOM.

## Host-Speicher-Analyse (Oracle ARM VPS)
- **Gesamter RAM:** 11.927 MB (~12 GB)
- **Llama.cpp (`llama-server`):** Belegt stabil ~4.907 MB RSS (`gemma-4-E2B-it-Q4_K_M.gguf` mit festem Context `-c 2048`).
- **Weitere Host-Dienste:** CrowdSec (~480 MB), Immich ML (~280 MB), Stalwart (~150 MB), Tailscale, Caddy etc. (~600 MB) → Summe Non-Gecko: ~6,5 GB.
- **Verfügbarer Puffer:** ~5,4 GB physisches RAM verfügbar (+ 4,8 GB freier Swap).

## Durchgeführte Maßnahmen
1. **Docker Compose (`/home/ubuntu/docker/iptv/docker-compose.yml`):**
   - `mem_limit` von `1500m` auf `3072m` (3,0 GB) erhöht.
   - `NODE_OPTIONS=--max-old-space-size=2304` gesetzt (V8 Heap-Limit von 774 MB auf 2.352 MB erhöht).
   - Container neu erstellt (`docker compose up -d gecko`).
   - Host hat weiterhin ~4,7 GB verfügbaren Speicher; `llama-server` läuft ungestört.
2. **Fehlerbehandlung in `server/routes/proxy.ts`:**
   - Aufruf von `client.authenticate()` in `player_api.php` mit `try/catch` abgesichert, um Unhandled Promise Rejections bei Upstream-Timeouts abzufangen und ein sauberes 502-JSON an Clients zu liefern.
3. **Konfiguration in Repository:**
   - `docker-compose.prod.yml` mit `mem_limit: 3072m` und `NODE_OPTIONS` aktualisiert.
