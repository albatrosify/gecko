# „Stream 1938143" statt Episodentitel nach jedem Restart

**Datum:** 2026-10-23

## Symptom

Dashboard „Now Playing" zeigt bei einer laufenden Serien-Episode `Stream 1938143`
statt `Dark S01E01 - Secrets` — und zwar gehäuft **nach Container-Restarts**
(„wieder"), während Live- und Filmnamen korrekt bleiben.

## Ursache

- Live/VOD-Namen kommen aus dem Katalog (`streams`-Tabelle) — persistent.
- **Serien-Episoden** existieren dort nicht. Die `streams`-Tabelle hat nur
  Serien-Zeilen (`series_id`); Episodentitel stehen ausschließlich in der
  `get_series_info`-Antwort des Upstreams.
- Diese Antwort cached `stream-title-cache.ts` **nur im Speicher** (Map). Die
  Clients (TiviMate & Co.) holen `get_series_info` aber nur, wenn sie die
  Serienansicht öffnen — beim Abspielen einer Episode längst gecacht, also nach
  einem Restart **nie wieder**. Der Fallback in `proxy.ts` greift dann:
  `Stream <episodeId>`.

## Fix (2026-10-23)

- Neue Tabelle `episode_meta (sourceId, episodeId, title, icon, updatedAt)`.
- `rememberSeriesInfo()` schreibt die Episoden zusätzlich dorthin (ein
  `INSERT … ON CONFLICT DO UPDATE` je Antwort, in einer Transaktion).
- `getStreamTitle()` fällt für `type = 'series'` auf die Tabelle zurück und wärmt
  dabei den In-Memory-Cache; `getStreamIcon()` liefert das Episoden-Still, sonst
  das Serien-Cover.
- Der Icon-Lookup für Live/VOD läuft über `stream-store.getStreamIcon()` — der
  Katalog hat die Spalte `icon` bereits (`stream_icon`, Fallback `cover`).
- Beides landet als `streamIcon` in `proxyStats.connections` und wird im
  Dashboard als Thumbnail gerendert (`/img?url=…`, Fallback Play-Symbol, falls
  das Bild 404 liefert).

## Fallstricke

- `rememberSeriesInfo()` wird pro `get_series_info`-Request aufgerufen. Deshalb
  `ON CONFLICT` + Transaktion, sonst wächst die Tabelle bei jedem Request.
- In Unit-Tests ist die DB nicht verbunden (`isDbConnected()` false) — Persistenz
  und Lookup müssen dann still no-op sein, nicht werfen.
- Episoden-IDs sind **nicht** Serien-IDs. Eine Suche in `streams` nach der ID aus
  dem Play-URL schlägt deshalb immer fehl; das ist kein Bug.
