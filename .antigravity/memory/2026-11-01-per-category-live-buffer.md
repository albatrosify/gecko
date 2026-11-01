# Per-Kategorie Live-Jitter-Buffer (`bufferSeconds`)

Datum: 2026-11-01
Betrifft: `server/multiplexer/stream-hub.ts`, `server/routes/proxy.ts`, `src/components/index.tsx`, `src/types.ts`

## Ausgangslage

Trotz funktionierendem Server-Puffer (Conservation-Ratenschätzung, volle Reserve,
Gap-Watchdog oberhalb der Reserve) meldete der Nutzer weiter „kleine Loading-Events"
in TiviMate, während die Server-Logs nur eine einzige `Downstream starved`-Zeile zeigten.

Ursachenanalyse:

1. **Client-Puffer stand auf „OFF"** (TiviMate → Wiedergabe → Puffergröße). Der
   VBR-Sprung des Hockey-Feeds (~6 → ~20 Mbps) leert einen Puffer von 0 Byte sofort;
   das passiert **nach** dem Server-Puffer und ist von Gecko aus nicht behebbar.
2. Der Server hielt 20 s Reserve, um den fehlenden Client-Puffer zu kompensieren —
   das fühlte sich für den Nutzer falsch an („Gecko hält zurück, während der Client
   hungert") und erhöhte die Latenz.

Erkenntnis: Die **Summe** aus Server- und Client-Puffer zählt. Der Server-Puffer ist
nur für die Provider-Pausen zuständig; VBR-Spitzen und der letzte Hop (WLAN,
Decoder) gehören in den Client-Puffer. Deshalb ist die Reserve ein sinnvoller
**Default**, aber pro Kategorie (z. B. Sport/Hockey mit starkem VBR) muss sie
abschaltbar bzw. anders dosierbar sein.

## Umsetzung

- Neues Feld `categoryMappings.extra.bufferSeconds`:
  - fehlt / `null` → globaler Default (`GECKO_LIVE_BUFFER_SECONDS`)
  - `0` → passthrough, kein Pacing für Streams dieser Kategorie
  - `N` → N Sekunden Reserve
- `resolveCategoryBufferSeconds()` in `server/routes/proxy.ts` (exportiert, getestet)
  löst die Kategorie beim Stream-Start auf. Priorität:
  1. Kategorie aus dem Stream-Mapping (`mappings.extra.categoryId`)
  2. `"<sourceIdx>_<categoryId>"` (eindeutig bei mehreren Quellen)
  3. `"<categoryId>"` (roh, mehrdeutig — nur Fallback)
- `streamHub.registerChannel(..., bufferSecondsOverride)` hält die Reserve als
  `channel.reserveSeconds` am Kanal fest. `getBufferHealth()` meldet gegen **diese**
  Reserve und gibt `null` zurück, wenn sie 0 ist (passthrough).
- Gap-Watchdogs skalieren jetzt mit der Reserve:
  warn `max(18 s, reserve + 4 s)`, reconnect `max(22 s, reserve + 8 s)`. Sonst würde
  ein tieferer Puffer von einem zu früh feuernden Reconnect zerrissen.
- UI: Abschnitt „Live buffer" im Kategorie-Pane (nur Live-Tab, nur echte
  Upstream-Kategorien) mit Wert-Eingabe, Schnellwahl `Off / 8 / 14 / 20` und
  „Default"-Reset (schreibt `bufferSeconds: null`).

## Fallstricke

- Die Reserve wird **beim Kanal-Start** festgelegt. Änderungen greifen erst für neu
  gestartete Streams; ein laufender Kanal behält seine Reserve (auch wenn ein
  zweiter Client per `join_existing` dazukommt).
- `bufferSeconds: null` wird als JSON in `extra` gemerged (`{...doc.extra, ...extra}`)
  und bedeutet „Default" — nicht „Feld löschen". `resolveCategoryBufferSeconds()`
  prüft deshalb `typeof === 'number'`.
- Custom Categories haben (noch) keinen Buffer-Override; sie sind keine
  `categoryMappings`-Zeilen. Für sie gilt der globale Default.
- Ein sehr tiefer Wert (0) liefert die Provider-Pausen wieder direkt an den Client
  durch — genau das war der ursprüngliche Buffering-Bug. Nur sinnvoll, wenn der
  Client selbst ausreichend puffert.

## Verifikation

- `server/routes/proxy-category-buffer.test.ts` (6 Fälle: eigene Kategorie,
  Source-Prefix, Mapping-Vorrang, `null`, keine Mapping, fremde Playlist/Typ)
- `server/multiplexer/stream-hub.test.ts` (+3: Override gewinnt, Fallback auf
  Default, `0` = sofortige Weitergabe + kein Health-Report)
- Gesamtsuite: 264 Tests / 28 Dateien grün, `tsc --noEmit` sauber.
