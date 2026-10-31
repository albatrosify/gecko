# Finding: `bun:sqlite` liefert `null`, `better-sqlite3` liefert `undefined`

**Datum:** 2026-10-18
**Komponenten:** `server/db.ts`, `server/stream-store.ts`, `scripts/check-db-driver.ts`
**Aufgetreten in:** Prod-Testinstanz `gecko-test-bun` (Port 3005)

## Symptom

Die Bun-Testinstanz lief gesund, aber:

- `streams` war **leer** (0 Zeilen), `streams_fts` ebenfalls.
- **Kein** `[Startup] Warming cold cache`-Log, **kein** `[Sync]`-Log.
- Die Playlist-Suche lieferte nichts, und jeder Playlist-Request fiel auf einen
  Upstream-Fetch zurück (langsam, belastet den Provider).
- Die Event-Loop-Werte sahen mit mean 0.09 ms *sehr* gut aus — weil die Instanz
  schlicht nichts tat.

## Ursache

`bun:sqlite` und `better-sqlite3` unterscheiden sich bei `.get()` ohne Treffer:

| Treiber | `.get()` ohne Zeile |
|---|---|
| `better-sqlite3` (Node) | `undefined` |
| `bun:sqlite` (Bun) | **`null`** |

`hasSourceStreams()` prüfte `return row !== undefined;` — unter Bun also **immer
`true`**. Folgen:

- Der Startup-Warm-up filtert mit `!hasSourceStreams(...)` → **alle** Quellen
  galten als „schon geladen" → es wurde nie synchronisiert.
- Derselbe Helfer steuert die Cooldown-Prüfung in `refreshSource()`.

Verifiziert im Container:

```
bun:sqlite .get() on empty -> null | typeof object
  row !== undefined       -> true   <-- what hasSourceStreams returned
```

## Lösung

`return row != null;` (lose, deckt `null` **und** `undefined` ab) mit Kommentar,
warum die lose Prüfung Absicht ist.

**Audit:** Alle übrigen rohen `.get()`-Stellen wurden geprüft — `getStreamRow`
nutzt `if (!row)`, `countSourceStreams`/`countPrev`/`countNew` sind `COUNT(*)`
und liefern immer eine Zeile, der Rest geht über Drizzle. Es war genau **eine**
fehlerhafte Stelle.

## Absicherung

`scripts/check-db-driver.ts` prüft die Treiberannahmen des Stores (leere
Partition, gefüllte Partition, Suche, Punkt-Lookup) und **muss unter beiden
Runtimes** laufen:

```bash
npx tsx scripts/check-db-driver.ts   # Node
bun scripts/check-db-driver.ts       # Bun
```

In `.github/workflows/bun.yml` als Job `parity` verdrahtet, und `merge` hängt
davon ab (`needs: [build, parity]`) — ein Mismatch blockiert also das
Veröffentlichen des Images.

## Lesson

**Die vitest-Suite läuft nur unter Node und kann Treiber-Divergenzen prinzipiell
nicht finden** — genau die Asymmetrie, die in ADR 0003 als Risiko notiert war.
Jeder Code, der rohe Treiber-Ergebnisse auswertet, gehört in den Parity-Check.
Weitere bekannte Divergenz: `bun:sqlite` hat **kein `db.pragma()`** (bereits über
`exec('PRAGMA …')` gelöst).
