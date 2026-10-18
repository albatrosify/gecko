# 0002. Daten-Layer: Katalog normalisieren, Serving-Artefakte materialisieren

Datum: 2026-10-18
Status: proposed (Grundlagen umgesetzt, Schritt 5 offen)

## Kontext

Gemessene Ausgangslage (`data/gecko.db`, 40.61 MB):

- Der Katalog liegt als JSON-Blobs in `cache`: **4 Zeilen = 89.5 %** der DB
  (VOD 22.0 MB / 51.462 Items, Series 13.4 MB, Live 0.9 MB). Reale relationale
  Daten: **< 1 MB**.
- Der Katalog existierte **doppelt**: Blob (`cache`, 36.33 MB) **und** Snapshot
  (`source_sync_meta`, 4.06 MB) — zusätzlich wurde er pro Request in JS-Objekte
  materialisiert.
- Der 16-Sekunden-Stall vom 2026-10-18 entstand im Sync
  (siehe `memory/2026-10-18-sync-event-loop-yielding-and-dns-enrichment.md`).
- 220 synchrone DB-Aufrufe (`better-sqlite3`) blockieren den Event-Loop, auf dem
  auch der Live-Multiplexer läuft.

## Entscheidung

1. **Eine Engine, eine Datei.** SQLite bleibt (normalisiert + WAL + FTS5).
   Kein Postgres, keine Polyglot-Persistenz.
2. **Katalog normalisieren**: `streams(sourceId, type, streamId, name, categoryId,
   icon, epgChannelId, containerExtension, extra, updatedAt)` mit Composite-PK.
   Bulk-Replace je `(sourceId, type)` in **einer** Transaktion.
3. **Suche über FTS5** (external content, `tokenize='trigram'`) — per `MATCH`.
4. **Changelog als SQL-Diff** statt JSON-Snapshot.
5. **Serving-Artefakte materialisieren**: `player_api.php`-JSON und `get.php`-M3U
   sind reine Funktionen von (Katalog-Version, Playlist-Config, Mappings) →
   einmal pro Version rendern, als gzip-Bytes ausliefern.
   **← dieser Schritt ist der entscheidende, siehe unten.**
6. **Versionierte Migrationen** ersetzen das ad-hoc `CREATE TABLE IF NOT EXISTS`.
7. **Runtime bleibt offen** — das Design ist portabel (Go + `modernc.org/sqlite`).

## Validierung (Prototyp gegen den echten 51.462-Item-Katalog)

Umgesetzt in `server/stream-store.ts` (31 Tests) und an `sync.ts` sowie alle
Lesepfade angebunden. Die Messungen haben das Design mehrfach korrigiert:

### Suchpfad
1. **`LIKE` auf external-content-FTS ist die schlechteste Variante (~13 ms,
   konstant)** — FTS5 muss jeden Kandidaten aus der Content-Tabelle nachlesen.
   → **`MATCH`**: 0.12–0.43 ms, Trefferzahlen identisch zum JS-Scan.
2. **2-Zeichen-Queries kann ein Trigram-Tokenizer nicht indexieren.** `"hd"`
   liefert per `MATCH` 0 Treffer, obwohl der Katalog 212 hat.
   → Scan-Fallback (~6.9 ms) unter 3 Zeichen.
3. **Trigger pro Zeile sind der Flaschenhals.** 51 k Rows: mit FTS-Triggern
   **2.247 ms**, ohne Trigger **324 ms** + ein `'rebuild'` **170 ms** = **494 ms**.
   → **Keine Trigger**.
4. **Der SQL-Diff ist billig:** `replaceSourceStreamsWithDiff` kostet 469 ms
   (leer), 555 ms (keine Änderung) bzw. 568 ms (kleines Delta) — die
   `NOT IN`-/Join-Diffs kosten nur ~96 ms und sind indexgestützt.

### Der entscheidende Befund: Normalisierung ist eine *Query*-Optimierung
5. **Ein Blob ist für Massen-Lesen SCHNELLER als normalisierte Zeilen.**
   Kalter Read des 51-k-Katalogs: Blob lesen + parsen **92 ms** (33 + 59) vs.
   Materialisieren aus `streams` **182 ms** (51 k Objekt-Builds + 51 k
   `JSON.parse` auf `extra`). Der Warmer-Mirror-Treffer ist in beiden Fällen ~0.
6. **Voller Replace ist beim Schreiben teurer** als ein Blob (469 ms vs. 285 ms) —
   aber **inkrementelles Schreiben dreht das um.** Es werden nur Deltas
   geschrieben; gemessen am echten Katalog (51.462 Items):

   | Vorgang | Zeit | in die WAL geschrieben |
   |---|---|---|
   | Erst-Sync (alles neu) | 299 ms | 12.9 MB |
   | **Re-Sync, keine Änderung** | 251 ms | **0 Bytes** |
   | **Re-Sync, Delta (3 Zeilen)** | 304 ms | **3.6 MB** |

   Vorher schrieb **jeder** Sync ~40 MB. Ohne Änderung schreibt der Sync jetzt
   gar nichts; bei Änderungen dominiert der **FTS-Rebuild** (3.6 MB) — nicht die
   geänderten Zeilen (siehe Finding 8).

   ⚠️ Messmethodik: „geschriebene Bytes" **muss** aus der WAL-Datei gemessen
   werden, nicht aus der DB-Dateigröße. SQLite vergrößert die Datei nur, wenn
   neue Pages nötig sind — geänderte Zeilen benutzen oft freigewordene Pages und
   lesen sich dann als 0. Eine frühere Messung („4 KB bei Delta") war dadurch
   falsch.
7. **Storage wächst:** 47.93 MB vs. 40.61 MB = **+18 %**, fast vollständig der
   Trigram-Index (7.1 MB).

8. **Der FTS-Rebuild dominiert jeden Sync mit Änderungen.** Inkrementelles
   Schreiben spart die geänderten Zeilen, aber der Index wird als Ganzes neu
   aufgebaut, sobald *irgendetwas* anders ist: **3.6 MB** für eine 3-Zeilen-
   Änderung (gemessen). Nur ein Sync **ohne** Änderung schreibt 0 Bytes.
   Kosten-Nutzen des Index: 0.06 ms Suche statt ~11 ms Scan — beides weit unter
   dem 18-s-Puffer. Wer den letzten Rest Schreiblast sparen will, kann den
   Rebuild durch inkrementelle Index-Pflege (`'delete'`/`insert` je geänderter
   rowid) ersetzen oder ganz auf FTS verzichten (dann −7.1 MB Storage).

**Konsequenz:** Solange pro Request O(Katalog) Arbeit anfällt, ist es fast
gleichgültig, woraus sie kommt (Blob 92 ms, Tabelle 182 ms) — beides blockiert
den Loop. Die Normalisierung gewinnt bei **Query-förmigem** Zugriff (Suche
20–65×, indexgestützte Kategorie-Filter, Punkt-Lookups, SQL-Diff) und verliert
bei **ganzheitlichem** Zugriff. Deshalb ist **Schritt 5 (Serving-Artefakte) der
entscheidende**: nur er entfernt O(Katalog)-Arbeit vollständig aus dem
Request-Pfad.

**Zwischenstand:** Der Schreibpfad ist jetzt klar besser (0 Bytes statt ~40 MB pro
Sync). Der Lesepfad ist beim kalten Massen-Lesen ~90 ms langsamer als der Blob —
unkritisch gegenüber dem 18-s-Puffer, aber der Grund, Schritt 5 (Artefakte)
weiterhin als nächsten Schritt zu führen.

## Konsequenzen

Positiv:
- **Suche ~20–65× schneller** (7.5–15 ms → 0.12–0.43 ms), indexgestützt.
- **Sync schreibt nur noch Deltas: 0 Bytes ohne Änderung, 4 KB bei 3 geänderten
  Zeilen** (vorher ~40 MB pro Sync). Genau der Hebel gegen die vermutete
  Disk-I/O-bedingte Blockade.
- Changelog ist ein SQL-Diff: kein 18-MB-Snapshot-Blob, kein 3-Pass-JSON-Vergleich.
- Kein `cache`-Blob mehr für Streams: **−36 MB** Alt-Daten, −221 ms Blob-Write pro Sync.
- Indexgestützte Kategorie-/Typ-Filter, Punkt-Lookups, Grundlage für Artefakte.
- Cache/Kaltstart-Semantik unverändert (`getCachedStreams` liefert `null` bei
  leerer Partition → bestehender Upstream-Fallback greift weiterhin).

Negativ / Risiko:
- **+18 % Storage** durch Index + FTS.
- **Kalter Read +90 ms** (182 vs. 92 ms) pro Mirror-Ablauf und Quelle/Typ.
- **2-Zeichen-Suchen bleiben ein Scan** (~6.9 ms).
- **CPU-Restkosten im Sync** (~331 ms bei 51 k: Staging + Diff + ggf. FTS-Rebuild).
  Rein CPU, keine Schreiblast — beseitigt erst ein Off-Loop-Writer oder Go.
- Der in `memory/2026-10-04` bewusst verschobene Pipeline-Refactor in
  `proxy.ts` wird angefasst.

Verworfen:
- **DuckDB / LMDB / Redis** — Polyglot-Overhead ohne gemessenen Bedarf.
- **Postgres** — löst das Zugriffsmuster nicht.
- **FTS5-Trigger** — 4,5× langsamer als Load + Rebuild (gemessen).
- **FTS5 + `LIKE`** — 30–100× langsamer als `MATCH` (gemessen).
- **Custom-Binary-Format** für den Katalog.

## Offen (nächste Schritte)

1. **Serving-Artefakte materialisieren (Schritt 5).** Der einzige Schritt, der
   O(Katalog)-Arbeit pro Request wirklich entfernt (`player_api.php`-JSON und
   `get.php`-M3U pro Katalog-/Config-Version vorrendern) und damit auch den
   kalten Read von 182 ms auf ~0 bringt.
2. **FTS-Rebuild inkrementell machen** (`'delete'`/`insert` je geänderter rowid
   statt Voll-Rebuild) → 3.6 MB pro geändertem Sync auf ~KB senken. Alternativ
   FTS streichen (−7.1 MB Storage, Suche dann ~11 ms Scan).
3. **Payload-Hash als Fast-Path:** liefert der Provider dieselben Daten, Staging +
   Diff komplett überspringen (Hash statt 51 k Temp-Inserts) → No-Change von
   251 ms auf ~70 ms.
4. Versionierte Migrationen (Schritt 6).
5. Off-Loop-Writer evaluieren, falls das CPU-Restblocking stört.
