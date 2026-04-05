![Logo](src/assets/logo.png)

# GECKO

> **AI Disclosure:** This project was almost entirely written by AI (Claude by Anthropic and Gemini by Google).

A self-hosted IPTV playlist aggregator and editor. Connect upstream Xtream Codes / M3U providers, customize channels, categories, and stream names, then expose a clean Xtream-compatible API endpoint for your IPTV clients.

## Features

- **Upstream Source Management** — Connect multiple Xtream Codes or M3U providers
- **Playlist Editor** — Hide/show channels and categories, rename with regex rules, drag-and-drop reorder
- **Xtream API Proxy** — Serves a clean `player_api.php` endpoint compatible with all IPTV players
- **M3U Export** — Download playlists in M3U format
- **EPG Support** — Attach XMLTV EPG sources to playlists
- **Multi-user** — Local email/password authentication with admin/user roles
- **Disk-based Cache** — Handles large upstream playlists (100K+ streams) efficiently

## Quick Start with Docker

```bash
# Clone the repo
git clone https://github.com/albatrosify/gecko.git
cd gecko

# Copy and configure environment
cp .env.example .env
# Edit .env — set JWT_SECRET, APP_URL, and VPN credentials

# Start the app (includes SQLite database built-in)
docker compose up -d

# Open in browser
open http://localhost:3000
```

The first user to register becomes the admin.

### Configuration

Edit `.env` (or `docker-compose.yml` environment variables):

| Variable | Default | Description |
|---|---|---|
| `SQLITE_PATH` | `/app/data/gecko.db` | SQLite database file location |
| `JWT_SECRET` | — | **Required.** Secret for JWT tokens (`openssl rand -hex 32`) |
| `APP_URL` | `http://YOUR_LAN_IP:3000` | Public URL for Xtream proxy rewrites |
| `PORT` | `3000` | Server port |

## Local Development

**Prerequisites:** Node.js 20+

```bash
npm install
cp .env.example .env
npm run dev
```

## Tech Stack

- **Frontend**: React 19 + Vite + Tailwind CSS 4
- **Backend**: Express + TypeScript (tsx)
- **Database**: SQLite (better-sqlite3 + Drizzle ORM)

## Migrating from MongoDB to SQLite

If you are upgrading from an older version that used MongoDB, you can easily migrate your data:

1. Ensure your MongoDB instance is running (e.g. `docker-compose up -d mongo` if you used `docker-compose.separate.yml` before).
2. Set the `MONGODB_URI` environment variable to point to your MongoDB instance, and ensure `SQLITE_PATH` points to where you want your new SQLite database file.
3. Run the migration script: `npx tsx scripts/migrate-mongo-to-sqlite.ts`.
4. Your new `.db` file is ready to use! You can now stop and remove your MongoDB container.
- **Auth**: JWT + bcrypt (local email/password)
- **Deployment**: Docker + Docker Compose
