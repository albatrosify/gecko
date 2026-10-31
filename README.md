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
- **Zero-dependency Storage** — Single SQLite file, no external database required

## Quick Start with Docker

```bash
# Clone the repo
git clone https://github.com/albatrosify/gecko.git
cd gecko

# Copy and configure environment
cp .env.example .env
# Edit .env — set JWT_SECRET and APP_URL

# Start the app (SQLite database built-in, no external services needed)
# This will pull the latest image from the GitHub Container Registry (ghcr.io/albatrosify/gecko)
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
- **Auth**: JWT + bcrypt (local email/password)
- **Deployment**: Docker + Docker Compose
