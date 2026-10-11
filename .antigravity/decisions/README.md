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
