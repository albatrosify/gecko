# Architectural Decision Log

Verzeichnis für Architektur-Entscheidungen (ADR-artig). Ein Eintrag pro Datei, benannt `NNNN-kurztitel.md`.

## Format

```md
# NNNN. Titel

Datum: YYYY-MM-DD
Status: proposed | accepted | superseded

## Kontext
Warum war eine Entscheidung nötig?

## Entscheidung
Was wurde entschieden?

## Konsequenzen
Positive/negative Folgen; was nun anders ist.
```

## Bisherige Entscheidungen

- `0001-dvr-server-side-recordings.md` — Server-seitige DVR-Aufnahmen über internen Loopback an `/live/...` (Start aus dem DVR-Tab ohne Player).
- `0002-data-layer-catalog-normalization.md` — Daten-Layer: Katalog normalisieren (`streams` + FTS5), Serving-Artefakte materialisieren; SQLite bleibt.
- `0003-runtime-bun-default-node-fallback.md` — Bun als Standard-Runtime (kein natives SQLite-Modul), Node als Fallback für die vitest-Suite.
