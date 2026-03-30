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

# Start the app (includes MongoDB integrated)
docker compose up -d

# OR run with separate services (original behavior)
# docker compose -f docker-compose.separate.yml up -d

# Open in browser
open http://localhost:3000
```

The first user to register becomes the admin.

### Configuration

Edit `.env` (or `docker-compose.yml` environment variables):

| Variable | Default | Description |
|---|---|---|
| `MONGODB_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGODB_DB` | `open_iptv` | Database name |
| `JWT_SECRET` | — | **Required.** Secret for JWT tokens (`openssl rand -hex 32`) |
| `APP_URL` | `http://YOUR_LAN_IP:3000` | Public URL for Xtream proxy rewrites |
| `PORT` | `3000` | Server port |

## Local Development

**Prerequisites:** Node.js 20+, MongoDB running locally

```bash
npm install
cp .env.example .env
npm run dev
```

## Tech Stack

- **Frontend**: React 19 + Vite + Tailwind CSS 4
- **Backend**: Express + TypeScript (tsx)
- **Database**: MongoDB 7
- **Auth**: JWT + bcrypt (local email/password)
- **Deployment**: Docker + Docker Compose
