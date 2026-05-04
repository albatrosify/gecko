# Custom Categories Design

**Date:** 2026-04-05
**Status:** Approved

## Overview

Allow users to create custom categories per playlist and copy channels from upstream sources into them. Custom categories are curated collections — channels appear in both their original upstream category and the custom category independently. The original channel mapping is never modified.

## Constraints

- Custom categories are **per-playlist** (consistent with existing categoryMappings)
- Channels are **copy-only** — the original stream mapping is never touched
- Copies can only go into **custom categories**, not into existing upstream categories
- A copy is a **snapshot** of the channel's settings at copy time (customName, epgMapping, epgIcon, customIcon, regexRenames)
- After copying, the copy is **fully independent** — editing the copy does not affect the original and vice versa

## Data Model

### `customCategories` table

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `playlistId` | TEXT NOT NULL | FK to playlists |
| `type` | TEXT NOT NULL | `live` / `vod` / `series` |
| `name` | TEXT NOT NULL | user-defined display name |
| `order` | INTEGER | display position in category list |
| `hidden` | INTEGER | boolean — hidden from IPTV output |

### `customCategoryItems` table

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `customCategoryId` | TEXT NOT NULL | FK to customCategories |
| `playlistId` | TEXT NOT NULL | denormalized for efficient querying |
| `type` | TEXT NOT NULL | `live` / `vod` / `series` |
| `upstreamStreamId` | TEXT NOT NULL | original upstream `stream_id` — used for existence checks and stream proxying |
| `upstreamSourceId` | TEXT NOT NULL | which source the channel came from |
| `streamId` | INTEGER | synthetic stable ID from playlist's `nextStreamId` counter — used in IPTV stream URLs |
| `extra` | TEXT JSON | snapshot: `customName`, `epgMapping`, `epgIcon`, `customIcon`, `regexRenames`, `order`, `hidden` |

**Why `streamId` is needed:** Downstream IPTV clients request streams by numeric ID (e.g. `/live/user/pass/12345.ts`). The same upstream channel can appear in multiple custom categories, each needing a unique routable ID. The existing `nextStreamId` counter on the playlist already handles this for regular stream mappings.

**Why `upstreamStreamId` + `upstreamSourceId`:** The proxy needs to forward stream requests to the right upstream source. These fields are also used to detect when an upstream source has removed a channel (existence check against the cached upstream data).

## API

All routes require authentication and playlist ownership.

### Custom Categories

| method | route | description |
|---|---|---|
| GET | `/api/playlists/:id/custom-categories` | list all custom categories for a playlist |
| POST | `/api/playlists/:id/custom-categories` | create a custom category |
| PUT | `/api/playlists/:id/custom-categories/:catId` | update name, order, hidden |
| DELETE | `/api/playlists/:id/custom-categories/:catId` | delete category and cascade-delete its items |

### Custom Category Items

| method | route | description |
|---|---|---|
| GET | `/api/playlists/:id/custom-categories/:catId/items` | list items with existence status |
| POST | `/api/playlists/:id/custom-categories/:catId/items` | copy a channel into the category |
| PUT | `/api/playlists/:id/custom-categories/:catId/items/:itemId` | update item settings (name, order, epg, etc.) |
| DELETE | `/api/playlists/:id/custom-categories/:catId/items/:itemId` | remove item from custom category |

**POST item body:**
```json
{
  "upstreamStreamId": "1234",
  "upstreamSourceId": "abc-source-id",
  "type": "live",
  "customName": "BBC One",
  "epgMapping": "bbc1.uk",
  "epgIcon": "https://...",
  "customIcon": "",
  "regexRenames": []
}
```
The server assigns `streamId` from the playlist's `nextStreamId` counter.

**GET items response** includes an `exists` boolean per item (cross-referenced against upstream cache at request time), so the UI can show missing channels.

## Proxy Changes

### `get_live_categories` / `get_vod_categories` / `get_series_categories`

After building the upstream category list, append custom categories for that type:
```json
{ "category_id": "custom_<id>", "category_name": "My Favorites", "parent_id": 0 }
```

### `get_live_streams` / `get_vod_streams` / `get_series_streams`

After building the upstream stream list, append items from all custom categories of that type. Each item is served using its snapshot settings and its synthetic `streamId` as the `stream_id` field.

If filtered by `category_id` (e.g. `?category_id=custom_abc`), only items from that custom category are returned.

Missing items (upstream stream no longer exists in source cache) are **omitted** from the IPTV output silently.

### Stream URL resolution (`/live/:user/:pass/:streamId.ts` etc.)

Add a lookup path: if a stream ID is not found in the regular mappings, check `customCategoryItems` by `streamId`. If found, proxy to the item's `upstreamSourceId` + `upstreamStreamId`.

## UI

### Category Panel

- A "+ Custom Category" button in the category list header (visible per active tab: live/vod/series)
- Clicking opens an inline input to name the category; Enter or a checkmark confirms
- Custom categories appear in the list with a star icon to distinguish them from upstream categories
- A custom category with missing items shows a warning badge (e.g. "2 missing")
- Custom categories can be renamed, reordered, and hidden like upstream categories

### Copying a Channel

- Each stream row in the stream list has a small copy icon button
- Clicking it opens a popover listing the custom categories available for that type
- Selecting a category snapshots the channel's current settings and adds the copy
- If no custom categories exist yet, the popover shows a prompt to create one first

### Custom Category Stream List

- Selecting a custom category in the panel shows its items in the stream list
- Items can be reordered (drag or arrow buttons), renamed, have EPG remapped, etc.
- Missing items (no longer in upstream) appear greyed out with a strikethrough and a "Missing" label
- A "Remove" action lets the user clean up missing or unwanted items

## Missing Channel Behavior

| Context | Behavior |
|---|---|
| PlaylistEditor (admin UI) | Item shown greyed out/strikethrough; category shows warning badge |
| IPTV output to downstream client | Item silently omitted — no dead streams |
| Upstream renames channel | No impact — copy has its own snapshot name |
| Upstream modifies stream metadata | No impact — copy re-proxies to same upstream URL |

## Cascade Deletion

- Deleting a playlist removes all its `customCategories` and `customCategoryItems`
- Deleting a custom category removes all its `customCategoryItems`
- Removing a source from a playlist does **not** auto-delete custom category items sourced from it — they show as "missing" instead, giving the user a chance to clean up manually

## Out of Scope

- Copying channels into existing upstream categories (not supported — copy-only into custom categories)
- "Move" action (hide original + copy in one click) — user explicitly does not want to touch originals
- Sharing custom categories across playlists
- Notifications/alerts for missing channels (handled inline in the editor UI)
