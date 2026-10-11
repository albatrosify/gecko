# Xtream Codes: Nicht-numerische Stream- und Kategorie-IDs bringen strenge IPTV-Clients (z. B. Televizo) zum Absturz

**Datum:** 2026-10-11  
**Betroffene Komponenten:** `server/routes/proxy.ts`, `server/dvr/recorder.ts`

## Problem & Symptome
- Der IPTV-Client **Televizo** (Android, User-Agent `Player (Linux; Android ...)`) brach den Playlist-Aktualisierungsprozess immer nach dem Abruf von `get_vod_streams` ab.
- Die Playlist wurde in Televizo als leer dargestellt („Keine Inhalte“), und `action=get_series` wurde nie angefordert, obwohl Kategorien für Live, VOD und Serien erfolgreich geladen worden waren.
- Das Problem trat reproduzierbar bei allen Playlists auf, selbst bei Playlists ohne eigene VOD-Inhalte (z. B. Test-Playlists).

## Ursache
1. **Xtream-Codes-Spezifikation & Android-Typisierung:**
   - Android-IPTV-Clients (wie Televizo, iMPlayer, TiviMate) bilden Xtream-Codes-Streams in streng typisierten Datenmodellen (Kotlin `Int`/`Long` via Gson/Moshi/Kotlinx oder SQLite INTEGER-Spalten) ab.
   - `stream_id` wird als Zahl erwartet.
   - `category_id` wird als numerischer Bezeichner (String aus Ziffern oder Integer) erwartet.
2. **DVR-Recordings in Gecko:**
   - Wenn DVR-Aufnahmen in `get_vod_categories` und `get_vod_streams` eingeschleust wurden, wurden sie mit nicht-numerischen Strings ausgeliefert:
     - `category_id: "gecko_recordings"`
     - `stream_id: "rec_2883a608-38ca-43c6-aaf7-61057d358a0c"` (UUID mit Präfix)
     - `category_ids: [...]` fehlte komplett.
3. **Crash im Client:**
   - Beim Parsen von `"rec_2883a608-..."` in ein Integer-Feld warf Televizo eine `NumberFormatException`.
   - Der Hintergrund-Sync-Job fing die Exception ab, verwarf die Transaktion, brach den Sync vor Serien ab und zeigte einen leeren Bildschirm.

## Lösung
1. **Deterministische numerische ID-Generierung (`server/dvr/recorder.ts`):**
   - `recordingIdToNumeric(recId: string): number` generiert deterministisch eine positive 32-Bit-Ganzzahl im Bereich `900.000.000 .. 999.999.999` (kollisionssicher, passt in signed 32-Bit Integer und kollidiert nicht mit typischen Upstream-Stream-IDs).
   - `dvrRecorder.getNumericId(recId)` und `dvrRecorder.getRecordingByNumericId(numericId)` verwalten das Mapping.
2. **Numerische Kategorie-ID (`server/routes/proxy.ts`):**
   - `DVR_CATEGORY_ID = "999999"`.
   - In `get_vod_categories`: `category_id: "999999"`.
   - In `get_vod_streams`: `stream_id: numericStreamId`, `category_id: "999999"`, `category_ids: [999999]`.
   - In `get_vod_info`: unterstützt sowohl `numericId` als auch `rec_<uuid>`.
   - In `/movie/:username/:password/:streamId.:ext`: unterstützt sowohl `numericId` als auch `rec_<uuid>`.
3. **Fehler-Logging:**
   - In `proxy.ts` fängt der Handler für `player_api.php` Fehler nun mit explizitem Logging ab (`log('[Proxy] player_api.php error: ...')`), anstatt Exceptions stillschweigend mit 500 zu schlucken.
