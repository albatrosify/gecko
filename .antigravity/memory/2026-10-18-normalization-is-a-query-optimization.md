# Finding: Normalisierung ist eine Query-Optimierung — Massen-Lesen wird langsamer

**Datum:** 2026-10-18
**Komponenten:** `server/stream-store.ts`, `server/sync.ts`, ADR `0002`

## Kernaussage

Ein JSON-Blob ist für **ganzheitlichen** Zugriff („gib mir den ganzen Katalog")
schneller als normalisierte Zeilen — auf beiden Achsen:

| 51.462 Items | Blob | normalisierte Zeilen |
|---|---|---|
| kalter Read → JS-Objekte | **92 ms** (33 lesen + 59 parsen) | **182 ms** (51 k Objekt-Builds + 51 k `JSON.parse` auf `extra`) |
| Schreiben im Sync | **285 ms** (22-MB-Blob 221 + Snapshot 28 + Changelog 36) | **469 ms** (Zeilen + FTS-Rebuild) |
| Substring-Suche | 7.5–15 ms | **0.12–0.43 ms** |
| Storage (ganzer Katalog) | 40.61 MB | 47.93 MB (+18 %) |

**Merksatz:** Blob = billig zu schreiben, teuer zu lesen. Tabelle = teuer zu
schreiben, billig zu *fragen*. Der `JSON.parse` eines 22-MB-Blobs (59 ms) ist
günstiger als 51 k Einzel-`JSON.parse` + Objekt-Konstruktion (182 ms).

## Konsequenz für das Design

- Normalisierung gewinnt bei **Query-förmigem** Zugriff: Suche, Kategorie-Filter,
  Punkt-Lookups, SQL-Diff.
- Normalisierung verliert bei **ganzheitlichem** Zugriff (player_api
  `get_*_streams`, `get.php`-M3U).
- Solange pro Request O(Katalog)-Arbeit anfällt, blockiert der Loop — egal ob
  aus Blob (92 ms) oder Tabelle (182 ms). **Nur vorgerenderte Serving-Artefakte
  entfernen diese Arbeit vollständig** (ADR 0002, Schritt 5).

## Fallstricke im Prototyp

- **FTS5 external content + `LIKE` ist eine Falle:** ~13 ms konstant, weil FTS5
  jeden Kandidaten aus der Content-Tabelle nachliest. `MATCH` mit gequoteter
  Phrase: 0.12–0.43 ms bei identischen Treffern.
- **Trigram indexiert erst ab 3 Zeichen.** `"hd"` → 0 Treffer bei 212 echten
  Treffern. Fallback-Scan nötig (< 3 Zeichen, ~6.9 ms).
- **FTS-Trigger pro Zeile kosten 2.247 ms für 51 k Rows** vs. 494 ms für
  Load + ein `'rebuild'`. Keine Trigger verwenden.
- **Ein Temp-Table ist der richtige Ort für den Diff**, nicht ein JS-Map mit
  185 k Objekten: `replaceSourceStreamsWithDiff` kostet nur ~96 ms mehr als der
  reine Replace.
- **`sqlite.exec()`-Template-Strings:** Backticks in SQL-**Kommentaren**
  terminieren das Template-Literal und brechen den Build. Keine Backticks in
  Kommentaren innerhalb von `` sqlite.exec(`...`) `` verwenden.
