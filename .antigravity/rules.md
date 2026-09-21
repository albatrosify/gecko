# Behavioral Guidelines

Verhaltensregeln für KI-Agenten, die an diesem Projekt arbeiten. Diese Datei wird bei jeder Session geladen.

## Vorgehen

1. **Erst orientieren, dann handeln.** Lies `AGENTS.md` (Landkarte) und `CONTEXT.md`, bevor du Code anfasst.
2. **Plan vor Code.** Bei mehrschrittigen Änderungen erst nachdenken, dann schrittweise umsetzen und verifizieren.
3. **Verifizieren.** Nach Änderungen `npm run lint` (tsc --noEmit) und `npm run test` (vitest) ausführen.
4. **Kleinschrittig.** Änderungen minimal halten; nicht nebenbei refactoren, was nicht Teil der Aufgabe ist.

## Nicht erlaubt

- Secrets committen (`JWT_SECRET`, Passwörter, API-Keys). `.env` ist in `.gitignore`.
- Force-push auf `main`.
- Änderungen an `dist/`, `node_modules/`, `data/*.db*` committen.

## Code-Qualität

- Type hints auf allen öffentlichen Funktionen.
- Keine stillen Exceptions (`try/catch` ohne Log/Handling).
- Keine neuen Abhängigkeiten ohne Notwendigkeit — erst prüfen, ob etwas im Stack (siehe `conventions.md`) es schon kann.

## Nach der Arbeit

- Ergebnisse/Fehler in `.antigravity/memory/` dokumentieren, wenn sie für künftige Sessions relevant sind.
- Architektur-Entscheidungen in `.antigravity/decisions/` festhalten.
- `AGENTS.md` aktualisieren, wenn sich Struktur/Konventionen ändern.

## Pflicht: Landkarte aktuell halten

`AGENTS.md` ist die zentrale Karte und altert, sobald der Code sich ändert. **Jede Änderung, die die Karte betrifft, MUSS noch in derselben Session in `AGENTS.md` (und ggf. `.antigravity/`) nachgetragen werden — als Teil der Aufgabe, nicht als nachträglicher Gedanke.**

| Wenn du ... | Dann ... |
|---|---|
| Datei in `server/`, `server/routes/`, `src/`, `player/` anlegst/umbenennst/löschst | Datei-Karte in `AGENTS.md` → „Architektur" aktualisieren |
| Endpoint in einem Router hinzufügst/änderst/entfernst | Endpoint-Tabelle in `AGENTS.md` aktualisieren |
| Mount-Pfad in `server.ts` änderst | Router-Liste in `AGENTS.md` aktualisieren |
| Tabelle/Spalte in `server/schema.ts` änderst | `schema.ts` **und** `db.ts` **und** Datenmodell-Tabelle in `AGENTS.md` aktualisieren |
| Neue API-Gruppe/-Funktion in `src/api.ts` hinzufügst | `api.ts`-Gruppenliste in `AGENTS.md` aktualisieren |
| Neue Route/Seite in `src/App.tsx` hinzufügst | Routenliste in `AGENTS.md` aktualisieren |
| Signifikante Architektur-Entscheidung triffst | ADR in `.antigravity/decisions/` anlegen |
| Nicht-offensichtlichen Bug/Fallstrick findest | Eintrag in `.antigravity/memory/` anlegen |

Nach einer strukturellen Änderung gilt: Landkarte aktualisieren gehört zum **Done-Kriterium** — erst dann ist die Aufgabe abgeschlossen.
