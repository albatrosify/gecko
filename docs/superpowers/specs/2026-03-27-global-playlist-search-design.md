# Global Playlist Search — Design Spec

**Date:** 2026-03-27
**Status:** Approved

---

## Overview

A Spotlight-style global search modal inside the PlaylistEditor that searches across live channels, VOD, and series simultaneously. Results are fetched server-side from the stream cache so the client never loads all stream data. Clicking a result navigates to the correct tab, category, and selects the stream in the editor pane.

---

## Backend

### Endpoint

```
GET /api/playlists/:id/search?q=<term>
```

- Requires `requireAuth`; verifies playlist belongs to `req.user.id`
- Returns 400 if `q` is missing or fewer than 2 characters
- Returns 404 if playlist not found

### Search logic

For each source in `playlist.sourceIds`:

1. For each type in `['live', 'vod', 'series']`:
   - Read `getCached(`${sourceId}_streams_${type}`)`
   - If cache miss: call the appropriate `XtreamClient` method and populate the cache (same path as the tab load)
   - Read `getCached(`${sourceId}_categories`)` for category name lookup (also fetches on miss)
   - Filter streams where `stream.name` or `stream.title` contains `q` (case-insensitive)

2. Deduplicate results across sources by `streamId + type` (first source wins)

3. Return top 50 hits, ordered: exact prefix matches first, then substring matches

### Response shape

```ts
{
  results: {
    streamId: string;       // stream_id or series_id as string
    name: string;           // stream.name || stream.title
    type: 'live' | 'vod' | 'series';
    categoryId: string;     // stream.category_id as string
    categoryName: string;   // resolved from category cache, fallback ''
  }[]
}
```

---

## Frontend

### Trigger

- **Search button** in the PlaylistEditor header, next to the sync/sources controls — `Search` icon (lucide)
- **Cmd+K / Ctrl+K** keyboard shortcut anywhere within the PlaylistEditor

### Modal layout

Fixed full-screen overlay (`bg-black/60 backdrop-blur-sm`), click-outside closes.
Centered card `max-w-[580px] w-full`, rounded-2xl, zinc-900 background:

```
┌──────────────────────────────────────────┐
│ 🔍  Search channels, movies, series...   │  ← autofocused input
├──────────────────────────────────────────┤
│ [Tv]   CNN International   Channel · News│
│ [Film] Interstellar        Movie · Sci-Fi│
│ [Clap] Breaking Bad        Series · Drama│
│ ...up to 50 results, scrollable          │
└──────────────────────────────────────────┘
```

### Result row

- Left: type icon (`Tv` for live, `Film` for vod, `Clapperboard` for series)
- Center-left: stream name (white, medium weight)
- Center-right: type label + `·` + category name (zinc-500, small)
- Highlighted on hover / keyboard focus

### Behaviour

| Interaction | Result |
|---|---|
| Type < 2 chars | Placeholder: "Type at least 2 characters" |
| Type ≥ 2 chars | Debounce 300ms → fetch → show results |
| In-flight request | Subtle spinner in input right side |
| No results | "No results for «foo»" |
| Request error | "Search unavailable" (non-blocking) |
| Click / Enter on result | Navigate (see below) + close modal |
| Esc | Close modal |
| Arrow Up / Down | Move keyboard focus through results |
| Click outside overlay | Close modal |

### Navigation on select

```ts
setActiveTab(result.type);
setSelectedCategoryIds(new Set([result.categoryId]));
setSelectedStreamIds(new Set([result.streamId]));
// modal closes — category filter narrows the list, EditorPane opens with the stream
```

No explicit scroll-to-item required; selecting the category already narrows the visible stream list.

---

## Component

New `GlobalSearch` component, self-contained. Accepts:

```ts
interface GlobalSearchProps {
  playlistId: string;
  onNavigate: (type: 'live'|'vod'|'series', categoryId: string, streamId: string) => void;
  onClose: () => void;
}
```

State managed internally: `query`, `results`, `loading`, `error`, `focusedIndex`.

`onNavigate` is wired in `PlaylistEditor` to call `setActiveTab` + `setSelectedCategoryIds` + `setSelectedStreamIds`.

---

## API client

```ts
api.playlists.search(playlistId: string, q: string): Promise<{ results: SearchResult[] }>
```

Added to the existing `api.playlists` object in `src/api.ts`.

---

## Out of scope

- Fuzzy / ranked full-text search (substring match is sufficient)
- Searching category names (stream names only)
- Searching within mapping customNames (upstream names only)
- Persisting search history
