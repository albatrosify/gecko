# Project Conventions

Projektspezifische Konventionen und der Tech-Stack. Wird bei jeder Session geladen.

## Was ist GECKO?

Self-hosted IPTV-Playlist-Aggregator. User verbinden Xtream-Codes-/M3U-Upstream-Provider, passen Kanäle/Kategorien an (ausblenden, per Regex umbenennen, sortieren) und bekommen einen sauberen Xtream-kompatiblen `player_api.php`-Endpoint für Downstream-Clients.

## Tech-Stack

| Bereich | Technologie |
|---|---|
| Backend | Express + TypeScript (via `tsx`, ESM) |
| Frontend | React 19 + Vite + Tailwind CSS 4 |
| DB | SQLite (`better-sqlite3` + Drizzle ORM), WAL-Modus, Auto-Migrate in `db.ts` |
| Auth | JWT + bcrypt (lokales E-Mail/Passwort) |
| Tests | Vitest (`npm run test`) |
| Deployment | Docker + Docker Compose |

**Nebenprojekte:**
- `player/` — eigenständige Expo-/React-Native-App (IPTV-Player-Client), spricht gegen die Xtream-Endpoints des Hauptservers.
- `companion/` — leerer Expo-Router-Scaffold, derzeit ohne aktiven Code.

## Module & Imports

- ESM mit `.ts`-Dateierweiterung in relativen Imports (z.B. `import { connectDb } from "./server/db.ts"`).
- Shared-Typen: `src/types.ts` (Frontend + Backend gemeinsam).
- Kein `tsconfig`-Path-Alias; relative Pfade verwenden.

## Konventionen

- **IDs**: `crypto.randomUUID()` über `server/db.ts` `generateId()`. Text-Primärschlüssel, keine Auto-Increment-Ints.
- **`extra`-Spalte**: Viele Tabellen nutzen eine JSON-`extra`-Spalte für optionale Felder. `docWithId()`/`docsWithId()` in `db.ts` mergen `extra` flach in das Objekt.
- **Backend-Module** liegen in `server/`; HTTP-Routen in `server/routes/*.ts`, jede als `createXxxRouter()`.
- **Frontend-Komponenten**: primär in `src/components/index.tsx` (monolithisch, ~420 KB). Neue große Komponenten eher in eigene Dateien unter `src/components/` auslagern.
- **Naming**: Funktionen/Handler camelCase, Router-Fabriken `createXxxRouter()`, Singletons `xxx` (z.B. `dvrRecorder`, `streamHub`, `connectionArbiter`).

## Commands

```bash
npm run dev      # Express + Vite HMR auf Port 3000
npm run build    # Frontend -> dist/
npm run start    # Produktion: NODE_ENV=production tsx server.ts
npm run lint     # tsc --noEmit (Type-Check, kein Linter)
npm run test     # vitest run
```

Voraussetzung: `.env` (Kopie von `.env.example`) mit `SQLITE_PATH`, `JWT_SECRET`, `APP_URL`, `PORT`.

## Datenbank-Migration

Kein Migrations-Framework im Betrieb. `server/db.ts` führt bei `connectDb()` ein `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` aus. Neue Tabellen/Spalten: Schema in `server/schema.ts` (Drizzle) UND das SQL in `db.ts` ergänzen. Drizzle-Konfig: `drizzle.config.ts`.
