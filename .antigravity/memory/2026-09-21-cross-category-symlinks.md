# Findings & Implementation: Cross-Category Symlinks

**Datum:** 2026-09-21  
**Feature:** Kanal aus einer Kategorie in eine andere verlinken (Symlink)

## Architektur & Datenmodell
- **Wiederverwendung von `customCategoryItems`**:
  - `customCategoryId` speichert entweder eine Custom-Category-UUID (für selbst erstellte Kategorien) oder eine Upstream-Kategorie-ID.
  - Dadurch waren keine Schema-Änderungen an der Datenbank notwendig.
  - `streamId` wird als 9-stellige Zahl (`Math.floor(100000000 + Math.random() * 900000000)`) generiert, damit Xtream Codes Clients (z.B. TiviMate), die `stream_id` als 32-Bit Integer parsen, nicht abstürzen und jeden Symlink eindeutig identifizieren.

## Backend-Pipeline (`server/routes/`)
- **`customCategories.ts`**:
  - `POST /custom-category-items` und `POST /custom-category-items/batch` validieren, dass wenn `customCategoryId` keine Custom-Category ist, es als Upstream-Kategorie-ID direkt akzeptiert wird.
- **`proxy.ts`**:
  - `get_live_streams`, `get_vod_streams`, `get_series`:
    - Symlinks (`_isCopy: true`) werden in die jeweiligen Zielkategorien (`targetCatId`) injiziert.
    - Wenn der Original-Stream upstream nicht mehr existiert, wird der Symlink nicht in der Client-API ausgeliefert (keine toten Streams).
    - `mapping.categoryId` überschreibt nicht die Zielkategorie von Symlinks.
  - `handleStreamProxy`:
    - Unterstützt sowohl Direkt-Modus (`directStreams: true` -> 302 Redirect auf upstream Xtream URL) als auch Proxy-Modus (`targetSourceIds = [item.upstreamSourceId]`, `originalId = item.upstreamStreamId` mit Guard & Multiplexer).
  - M3U `get.php`:
    - Bindet Custom- und Symlink-Streams ein und berücksichtigt `_isCopy` für Direct URL (`_originalStreamId`).
- **`playlists.ts`**:
  - Beim Klonen einer Playlist (`POST /playlists/:id/clone`) werden sowohl `customCategories` als auch alle `customCategoryItems` (inklusive Upstream-Symlinks) für die geklonte Playlist dupliziert.

## Frontend (`src/components/index.tsx`)
- **UI in `PlaylistEditor`**:
  - Tabellenzeile: Button mit `Link2`-Icon öffnet ein Popover mit Kategoriesuche zur Auswahl jeder Custom- oder Upstream-Kategorie. Bereits zugewiesene Kategorie wird mit "Aktuell" markiert.
  - Kanalname: Verlinkte Kanäle erhalten das Badge `<Link2 /> Link` in Lila.
  - Aktionen: Für Symlinks wird ein `Trash2`-Button angeboten, mit dem nur die Verlinkung entfernt wird (der Original-Kanal bleibt unverändert).
  - `EditorPane`: Zeigt ein Banner "Verlinkter Kanal (Symlink)" mit Quelle sowie einen Button "Verlinkung entfernen". Tote Links werden rot als "Original-Kanal nicht gefunden" mit Entfernungs-Option dargestellt.
  - **Tote Symlinks**: Wenn der Parent-Kanal nicht mehr existiert, wird der Eintrag in der Tabelle sofort durch ein **💀-Emoji im Logo-Feld** und ein rotes Badge `💀 Tot` hervorgehoben (auch im Header und Banner des `EditorPane`).
  - Reaktive State-Aktualisierung: `rawStreamsRef` puffert Upstream-Streams, sodass Symlinks bei Erstellung/Löschung sofort ohne langsamen Netzwerk-Fetch in der UI aktualisiert werden.
