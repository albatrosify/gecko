# 0002. Daten-Layer: Katalog normalisieren, Serving-Artefakte materialisieren

Datum: 2026-10-18
Status: proposed

## Kontext

Gemessene Ausgangslage (`data/gecko.db`, 40.61 MB):

- Der Katalog liegt als JSON-Blobs in `cache`: **4 Zeilen = 89.5 %** der DB
  (VOD 22.0 MB / 51.462 Items, Series 13.4 MB / 12.972, Live 0.9 MB). Reale
  relationale Daten: **< 1 MB** (1 User, 1 Source, 1 Playlist, 0 Mappings).
- Der Katalog existiert **doppelt**: Blob (`cache`, 36.33 MB) **und** Snapshot
  (`source_sync_meta`, 4.06 MB) — zusätzlich wird er pro Request in JS-Objekte
  materialisiert.
- Der 16-Sekunden-Stall vom 2026-10-18 entstand durch `JSON.stringify` von
  185 k Items + 18 MB SQLite-Write in `sync.ts`
  (siehe `memory/2026-10-18-sync-event-loop-yielding-and-dns-enrichment.md`).
- 220 synchrone DB-Aufrufe (`better-sqlite3`) blockieren den Event-Loop, auf dem
  auch der Live-Multiplexer läuft.

Benchmark gegen den echten VOD-Katalog (51.462 Items):

| Pfad | Zeit |
|---|---|
| `JSON.parse` 22 MB Blob (heute) | 59.3 ms |
| Read + Order 51 k Rows (SQLite) | 33.3 ms |
| JS-Linear-Scan der Suche (heute) | 7.5–15 ms |
| FTS5 trigram via `MATCH` | **0.12–0.43 ms** |
| FTS5 trigram via `LIKE` | 13 ms ⚠️ |

Schlussfolgerung: Der **Store ist nicht der Hebel.** Pro Request wird
O(Katalog) Arbeit auf dem Loop verrichtet (33 ms in *jedem* Store). Der Gewinn
liegt im Zugriffsmuster und in der Indexierung.

## Entscheidung

1. **Eine Engine, eine Datei.** SQLite bleibt (normalisiert + WAL + FTS5).
   Kein Postgres, keine Polyglot-Persistenz. Postgres erst, wenn Gecko
   mandantenfähig (hosted SaaS) oder mehrfach instanziiert wird — es löst das
   Zugriffsmuster nicht.
2. **Katalog normalisieren**: Tabelle
   `streams(sourceId, type, streamId, name, categoryId, icon, epgChannelId, containerExtension, extra, updatedAt)`
   mit Composite-PK `(sourceId, type, streamId)`. Bulk-Replace je
   `(sourceId, type)` in **einer** Transaktion. Die PK deckt `(sourceId, type)`
   als Präfix ab — kein separater Index dafür.
3. **Suche über FTS5** (external content, `tokenize='trigram'`) — per `MATCH`.
4. **Changelog als SQL-Diff** statt JSON-Snapshot → die
   `source_sync_meta`-Snapshots entfallen.
5. **Serving-Artefakte materialisieren**: `player_api.php`-JSON und
   `get.php`-M3U sind reine Funktionen von (Katalog-Version, Playlist-Config,
   Mappings) → einmal pro Version rendern, als gzip-Bytes ausliefern.
   Version-Key = Hash(Katalog-Version + Playlist-Config + Mapping-Version).
6. **Versionierte Migrationen** ersetzen das ad-hoc `CREATE TABLE IF NOT EXISTS`.
7. **Runtime bleibt offen.** Das Design ist portabel: Go + `modernc.org/sqlite`
   + FTS5 erfüllt es identisch, und Goroutines machen Blocking zum Nicht-Thema.

## Validierung (Prototyp gegen den echten 51.462-Item-Katalog)

Umgesetzt in `server/stream-store.ts`; 24 Tests. Vier Messungen haben das Design
**korrigiert**:

1. **`LIKE` auf external-content-FTS ist die schlechteste Variante (~13 ms,
   konstant).** Da `content=` den Text nicht speichert, muss FTS5 jeden Kandidaten
   aus der Content-Tabelle nachlesen. → **`MATCH` verwenden**: 0.12–0.43 ms,
   Trefferzahlen identisch zum JS-Scan (38/38, 3/3), case-insensitiv.
2. **2-Zeichen-Queries kann ein Trigram-Tokenizer nicht indexieren.** `"hd"`
   liefert per `MATCH` **0** Treffer, obwohl der Katalog 212 hat. → Fallback auf
   einen Scan der `streams`-Tabelle (~6.9 ms) unterhalb von 3 Zeichen.
3. **Trigger pro Zeile sind der Flaschenhals.** 51 k Rows: mit FTS-Triggern
   **2.247 ms**, ohne Trigger **324 ms** + ein `'rebuild'` **170 ms** = **494 ms**
   (4,5×). → **Keine Trigger**; der Writer rebuildet den Index einmal.
4. **Storage wächst, nicht schrumpft.** Ganzer Katalog (66.523 Rows, 3 Typen):
   `streams` 37.06 MB + FTS 7.09 MB + Kategorie-Index ≈ **47.93 MB** vs.
   **40.61 MB** vorher = **+18 %**. Entfernt man den redundanten
   `idx_streams_source_type`, sinkt der Anteil; ohne FTS wäre es etwa neutral.
   Kostentreiber ist der Trigram-Index (7.1 MB).

Damit: `replaceSourceStreams` (51 k) = **541 ms**, `searchStreams` = **0.12–0.43 ms**.

**Wichtig — Blocking ist reduziert, nicht beseitigt:** 541 ms (bzw. ~1.8 s bei
185 k) laufen weiterhin synchron auf dem Event-Loop. Das ist ~9–30× besser als
der 16-s-Stall, aber kein Nullwert. Ein echter Nullwert braucht einen Off-Loop-
Writer (Worker-Thread) oder Go — siehe Punkt 7.

## Konsequenzen

Positiv:
- **Kein `JSON.parse` (59 ms) und keine 51 k JS-Objekte** mehr im Request-Pfad.
- **Suche ~20–65× schneller** (7.5–15 ms → 0.12–0.43 ms) und indexgestützt.
- **Sync-Schreiblast −75 %** (Trigger 2.247 ms → 541 ms für 51 k) und keine
  18-MB-Blob-Writes mehr.
- Changelog als SQL-Diff statt zweitem 185 k-JSON-Array.
- Indexgestützte Kategorie-/Typ-Filter statt JS-Filterung.

Negativ / Risiko:
- **+18 % Storage** durch Index + FTS. Auf einem 40-MB-Katalog trivial, aber
  keine Ersparnis.
- **2-Zeichen-Suchen bleiben ein Scan** (~6.9 ms) — Trigram-Limit.
- **Restliches Blocking** (541 ms / 51 k) bleibt, solange `better-sqlite3`
  synchron ist.
- Größerer Refactor in `sync.ts`, `proxy.ts`, `cache.ts`, `playlists.ts` — der in
  `memory/2026-10-04` bewusst verschobene Pipeline-Refactor wird angefasst.
- Migration: nur **Config** muss wandern (< 1 MB); der Katalog ist eine
  Upstream-Kopie und wird per Re-Sync neu aufgebaut.

Verworfen:
- **DuckDB / LMDB / Redis** — Polyglot-Overhead ohne gemessenen Bedarf.
- **Postgres** — löst das Zugriffsmuster nicht.
- **FTS5-Trigger** — 4,5× langsamer als Load + Rebuild (gemessen).
- **FTS5 + `LIKE`** — 30–100× langsamer als `MATCH` (gemessen).
- **Custom-Binary-Format** für den Katalog.

## Offen (nächste Schritte)

1. `sync.ts` an `replaceSourceStreams` anbinden und den Snapshot-Blob entfernen
   (Changelog als SQL-Diff) — das adressiert den Ursachenpfad des 16-s-Stalls.
2. `playlists.ts`-Suche auf `searchStreams` umstellen.
3. Serving-Artefakte (Punkt 5) materialisieren.
4. Versionierte Migrationen (Punkt 6).
5. Off-Loop-Writer evaluieren, falls 541 ms Restblocking stört.
