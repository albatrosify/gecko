# Custom Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-created custom categories per playlist, with the ability to copy channels into them as independent snapshot copies.

**Architecture:** Two new SQLite tables (`customCategories`, `customCategoryItems`) managed by a new route file. The Xtream proxy injects custom categories into category lists and their items into stream lists. Custom items carry synthetic stream IDs (≥ 1,000,000, stored in `playlist.extra.nextCustomItemId`) so the stream proxy can resolve them via a new fallback lookup.

**Tech Stack:** TypeScript, Express, Drizzle ORM (better-sqlite3), React, Tailwind CSS, Lucide icons.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `server/schema.ts` | Add `customCategories` + `customCategoryItems` table definitions |
| Modify | `server/db.ts` | Add `CREATE TABLE IF NOT EXISTS` statements + indexes |
| Modify | `src/types.ts` | Add `CustomCategory`, `CustomCategoryItem` interfaces |
| Create | `server/routes/custom-categories.ts` | CRUD routes for both tables |
| Modify | `server.ts` | Register new router |
| Modify | `server/routes/playlists.ts` | Cascade delete on playlist delete + clone support |
| Modify | `server/routes/proxy.ts` | Inject custom cats/items + stream URL fallback |
| Modify | `src/api.ts` | Add `customCategories` API client |
| Modify | `src/components/index.tsx` | UI: create/list/copy/view custom categories |

---

## Task 1: DB Schema

**Files:**
- Modify: `server/schema.ts`
- Modify: `server/db.ts`

- [ ] **Step 1: Add table definitions to `server/schema.ts`**

Append after the existing `source_changelogs` table:

```typescript
export const customCategories = sqliteTable('customCategories', {
  id: text('id').primaryKey(),
  playlistId: text('playlistId').notNull(),
  type: text('type').notNull(), // 'live' | 'vod' | 'series'
  name: text('name').notNull(),
  extra: text('extra', { mode: 'json' }), // stores: order, hidden
});

export const customCategoryItems = sqliteTable('customCategoryItems', {
  id: text('id').primaryKey(),
  customCategoryId: text('customCategoryId').notNull(),
  playlistId: text('playlistId').notNull(),
  type: text('type').notNull(),
  upstreamStreamId: text('upstreamStreamId').notNull(),
  upstreamSourceId: text('upstreamSourceId').notNull(),
  streamId: integer('streamId'),
  extra: text('extra', { mode: 'json' }), // snapshot: customName, epgMapping, epgIcon, customIcon, regexRenames, order, hidden
});
```

- [ ] **Step 2: Add CREATE TABLE statements to `server/db.ts`**

Inside the `sqlite.exec(...)` block, after the existing `source_changelogs` table and before the first `CREATE INDEX`:

```sql
CREATE TABLE IF NOT EXISTS customCategories (id TEXT PRIMARY KEY, playlistId TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, extra TEXT);
CREATE TABLE IF NOT EXISTS customCategoryItems (id TEXT PRIMARY KEY, customCategoryId TEXT NOT NULL, playlistId TEXT NOT NULL, type TEXT NOT NULL, upstreamStreamId TEXT NOT NULL, upstreamSourceId TEXT NOT NULL, streamId INTEGER, extra TEXT);
```

Then add indexes after the existing `idx_cache_expiresAt` line:

```sql
CREATE INDEX IF NOT EXISTS idx_customCategories_playlistId ON customCategories(playlistId);
CREATE INDEX IF NOT EXISTS idx_customCategories_playlist_type ON customCategories(playlistId, type);
CREATE INDEX IF NOT EXISTS idx_customCategoryItems_customCategoryId ON customCategoryItems(customCategoryId);
CREATE INDEX IF NOT EXISTS idx_customCategoryItems_playlistId ON customCategoryItems(playlistId);
CREATE INDEX IF NOT EXISTS idx_customCategoryItems_streamId ON customCategoryItems(streamId);
```

- [ ] **Step 3: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/schema.ts server/db.ts
git commit -m "feat: add customCategories and customCategoryItems schema"
```

---

## Task 2: TypeScript Types + API Client

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: Add interfaces to `src/types.ts`**

Append after the `StreamMapping` interface:

```typescript
export interface CustomCategory {
  id: string;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  name: string;
  order: number;
  hidden: boolean;
  missingCount?: number; // populated by API at request time
}

export interface CustomCategoryItem {
  id: string;
  customCategoryId: string;
  playlistId: string;
  type: 'live' | 'vod' | 'series';
  upstreamStreamId: string;
  upstreamSourceId: string;
  streamId: number;
  customName: string;
  epgMapping?: string;
  epgIcon?: string;
  customIcon?: string;
  regexRenames?: { type?: 'regex' | 'string'; pattern: string; replacement: string }[];
  order: number;
  hidden: boolean;
  exists?: boolean; // populated by API at request time
}
```

- [ ] **Step 2: Add API client to `src/api.ts`**

First, add a type import at the very top of `src/api.ts` (it currently has no imports):

```typescript
import type { CustomCategory, CustomCategoryItem } from './types';
```

Then add the API client after the `categoryMappings` block (before `// Upstream data`):

```typescript
// Custom Categories
export const customCategories = {
  async list(playlistId: string) {
    return request<CustomCategory[]>(`/api/custom-categories?playlistId=${playlistId}`);
  },
  async create(data: { playlistId: string; type: string; name: string }) {
    return request<CustomCategory>('/api/custom-categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async update(id: string, data: Partial<Pick<CustomCategory, 'name' | 'order' | 'hidden'>>) {
    return request<any>(`/api/custom-categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async delete(id: string) {
    return request<any>(`/api/custom-categories/${id}`, { method: 'DELETE' });
  },
  async listItems(catId: string) {
    return request<CustomCategoryItem[]>(`/api/custom-categories/${catId}/items`);
  },
  async createItem(catId: string, data: Omit<CustomCategoryItem, 'id' | 'customCategoryId' | 'streamId' | 'exists'>) {
    return request<CustomCategoryItem>(`/api/custom-categories/${catId}/items`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async updateItem(catId: string, itemId: string, data: Partial<Pick<CustomCategoryItem, 'customName' | 'epgMapping' | 'epgIcon' | 'customIcon' | 'regexRenames' | 'order' | 'hidden'>>) {
    return request<any>(`/api/custom-categories/${catId}/items/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async deleteItem(catId: string, itemId: string) {
    return request<any>(`/api/custom-categories/${catId}/items/${itemId}`, { method: 'DELETE' });
  },
};
```

Also add `CustomCategory, CustomCategoryItem` to the import at the top of `src/api.ts`. Find the existing import line and add the two new types:

```typescript
import { CustomCategory, CustomCategoryItem } from './types';
```

(Add to the existing types import — the file already imports from `'../types'` or `'./types'`; match whatever is there.)

Finally, add `customCategories` to the `const api` export at the bottom of `src/api.ts`:

```typescript
const api = { auth, sources, epgs, playlists, mappings, categoryMappings, customCategories, upstream, proxy, admin, system, settings, qualityScan };
```

- [ ] **Step 3: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/api.ts
git commit -m "feat: add CustomCategory and CustomCategoryItem types + API client"
```

---

## Task 3: Backend Routes — Custom Categories CRUD

**Files:**
- Create: `server/routes/custom-categories.ts`

- [ ] **Step 1: Create the route file**

```typescript
import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, generateId } from "../db.ts";
import { getCached } from "../cache.ts";
import { log } from "../logger.ts";

export function createCustomCategoriesRouter() {
  const router = Router();

  // =====================================
  // CRUD: Custom Categories
  // =====================================

  router.get("/custom-categories", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId) return res.status(400).json({ error: "playlistId required" });
    const db = getDb();
    const { customCategories, customCategoryItems } = await import('../schema.ts');
    const { eq, and } = await import('drizzle-orm');

    const cats = db.select().from(customCategories)
      .where(eq(customCategories.playlistId, playlistId as string))
      .all();

    // Compute missingCount for each category
    const result = cats.map(cat => {
      const extra = (cat.extra as any) || {};
      const items = db.select().from(customCategoryItems)
        .where(eq(customCategoryItems.customCategoryId, cat.id))
        .all();
      const cacheKey = cat.type === 'vod' ? 'vod' : cat.type === 'series' ? 'series' : 'live';
      let missingCount = 0;
      for (const item of items) {
        const cached = getCached(`${item.upstreamSourceId}_streams_${cacheKey}`);
        const exists = cached?.data?.some((s: any) => String(s.stream_id || s.series_id) === item.upstreamStreamId) ?? true;
        if (!exists) missingCount++;
      }
      return {
        id: cat.id,
        playlistId: cat.playlistId,
        type: cat.type,
        name: cat.name,
        order: extra.order ?? 999999,
        hidden: extra.hidden ?? false,
        missingCount,
      };
    });

    result.sort((a, b) => a.order - b.order);
    res.json(result);
  });

  router.post("/custom-categories", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { customCategories } = await import('../schema.ts');
    const { playlistId, type, name, ...extra } = req.body;
    if (!playlistId || !type || !name) return res.status(400).json({ error: "playlistId, type, name required" });

    const newId = generateId();
    db.insert(customCategories).values({ id: newId, playlistId, type, name, extra }).run();
    res.status(201).json({ id: newId, playlistId, type, name, order: (extra as any).order ?? 999999, hidden: (extra as any).hidden ?? false, missingCount: 0 });
  });

  router.put("/custom-categories/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { customCategories } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');
    const { name, ...extra } = req.body;

    const doc = db.select().from(customCategories).where(eq(customCategories.id, req.params.id)).get();
    if (!doc) return res.status(404).json({ error: "Not found" });

    db.update(customCategories).set({
      name: name !== undefined ? name : doc.name,
      extra: { ...(doc.extra as any || {}), ...extra },
    }).where(eq(customCategories.id, req.params.id)).run();

    res.json({ success: true });
  });

  router.delete("/custom-categories/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { customCategories, customCategoryItems } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    // Cascade: delete items first
    db.delete(customCategoryItems).where(eq(customCategoryItems.customCategoryId, req.params.id)).run();
    db.delete(customCategories).where(eq(customCategories.id, req.params.id)).run();
    res.json({ success: true });
  });

  // =====================================
  // CRUD: Custom Category Items
  // =====================================

  router.get("/custom-categories/:catId/items", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { customCategoryItems } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    const items = db.select().from(customCategoryItems)
      .where(eq(customCategoryItems.customCategoryId, req.params.catId))
      .all();

    const result = items.map(item => {
      const extra = (item.extra as any) || {};
      const cacheKey = item.type === 'vod' ? 'vod' : item.type === 'series' ? 'series' : 'live';
      const cached = getCached(`${item.upstreamSourceId}_streams_${cacheKey}`);
      const exists = cached?.data?.some((s: any) => String(s.stream_id || s.series_id) === item.upstreamStreamId) ?? true;
      return {
        id: item.id,
        customCategoryId: item.customCategoryId,
        playlistId: item.playlistId,
        type: item.type,
        upstreamStreamId: item.upstreamStreamId,
        upstreamSourceId: item.upstreamSourceId,
        streamId: item.streamId,
        exists,
        ...extra,
      };
    });

    result.sort((a: any, b: any) => (a.order ?? 999999) - (b.order ?? 999999));
    res.json(result);
  });

  router.post("/custom-categories/:catId/items", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { customCategoryItems, playlists: schemaPlaylists } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    const { playlistId, type, upstreamStreamId, upstreamSourceId, ...snapshot } = req.body;
    if (!playlistId || !type || !upstreamStreamId || !upstreamSourceId) {
      return res.status(400).json({ error: "playlistId, type, upstreamStreamId, upstreamSourceId required" });
    }

    // Allocate a unique streamId from playlist's nextCustomItemId counter
    const playlistDoc = db.select().from(schemaPlaylists).where(eq(schemaPlaylists.id, playlistId)).get();
    if (!playlistDoc) return res.status(404).json({ error: "Playlist not found" });

    const playlistExtra = (playlistDoc.extra as any) || {};
    const streamId = playlistExtra.nextCustomItemId ?? 1_000_000;
    const nextCustomItemId = streamId + 1;

    db.update(schemaPlaylists).set({
      extra: { ...playlistExtra, nextCustomItemId },
    }).where(eq(schemaPlaylists.id, playlistId)).run();

    const newId = generateId();
    db.insert(customCategoryItems).values({
      id: newId,
      customCategoryId: req.params.catId,
      playlistId,
      type,
      upstreamStreamId,
      upstreamSourceId,
      streamId,
      extra: snapshot,
    }).run();

    res.status(201).json({ id: newId, customCategoryId: req.params.catId, playlistId, type, upstreamStreamId, upstreamSourceId, streamId, exists: true, ...snapshot });
  });

  router.put("/custom-categories/:catId/items/:itemId", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { customCategoryItems } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    const doc = db.select().from(customCategoryItems).where(eq(customCategoryItems.id, req.params.itemId)).get();
    if (!doc) return res.status(404).json({ error: "Not found" });

    db.update(customCategoryItems).set({
      extra: { ...(doc.extra as any || {}), ...req.body },
    }).where(eq(customCategoryItems.id, req.params.itemId)).run();

    res.json({ success: true });
  });

  router.delete("/custom-categories/:catId/items/:itemId", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { customCategoryItems } = await import('../schema.ts');
    const { eq } = await import('drizzle-orm');

    db.delete(customCategoryItems).where(eq(customCategoryItems.id, req.params.itemId)).run();
    res.json({ success: true });
  });

  return router;
}
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/routes/custom-categories.ts
git commit -m "feat: add custom categories CRUD routes"
```

---

## Task 4: Register Router + Cascade Deletes

**Files:**
- Modify: `server.ts`
- Modify: `server/routes/playlists.ts`

- [ ] **Step 1: Register the router in `server.ts`**

Add the import near the top with the other route imports (around line 19-20):

```typescript
import { createCustomCategoriesRouter } from "./server/routes/custom-categories.ts";
```

Then register it after `app.use('/api', createMappingsRouter());` (around line 89):

```typescript
app.use('/api', createCustomCategoriesRouter());
```

- [ ] **Step 2: Add cascade delete to playlist deletion in `server/routes/playlists.ts`**

Find the `DELETE /playlists/:id` handler. It currently runs:
```typescript
tx.delete(schemaCategoryMappings).where(eq(schemaCategoryMappings.playlistId, playlistId)).run()
```

Add two more deletes in the same transaction (after the `schemaCategoryMappings` delete):

First, add the import at the top of the destructure in that handler. The existing line in `DELETE /playlists/:id` is:
```typescript
const { playlists: schemaPlaylists, mappings: schemaMappings, categoryMappings: schemaCategoryMappings } = await import('../schema.ts');
```

Change it to:
```typescript
const { playlists: schemaPlaylists, mappings: schemaMappings, categoryMappings: schemaCategoryMappings, customCategories: schemaCustomCategories, customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');
```

Then inside the transaction, after `tx.delete(schemaCategoryMappings)...`:

```typescript
// Delete custom categories and their items
const customCats = tx.select().from(schemaCustomCategories).where(eq(schemaCustomCategories.playlistId, playlistId)).all();
const customCatIds = customCats.map((c: any) => c.id);
if (customCatIds.length > 0) {
  tx.delete(schemaCustomCategoryItems).where(inArray(schemaCustomCategoryItems.customCategoryId, customCatIds)).run();
}
tx.delete(schemaCustomCategories).where(eq(schemaCustomCategories.playlistId, playlistId)).run();
```

(The `inArray` import is already available from `drizzle-orm` in that handler.)

- [ ] **Step 3: Add clone support in `server/routes/playlists.ts`**

Find the `POST /playlists/:id/clone` handler. After the block that clones `catMappings` (around line 107), add:

```typescript
// Clone Custom Categories and Items
const { customCategories: schemaCustomCategories, customCategoryItems: schemaCustomCategoryItems } = await import('../schema.ts');
const customCats = db.select().from(schemaCustomCategories).where(eq(schemaCustomCategories.playlistId, playlistId)).all();
if (customCats.length > 0) {
  db.transaction((tx) => {
    for (const cat of customCats) {
      const newCatId = generateId();
      tx.insert(schemaCustomCategories).values({ id: newCatId, playlistId: newPlaylistId, type: cat.type, name: cat.name, extra: cat.extra }).run();
      const items = tx.select().from(schemaCustomCategoryItems).where(eq(schemaCustomCategoryItems.customCategoryId, cat.id)).all();
      for (const item of items) {
        tx.insert(schemaCustomCategoryItems).values({
          id: generateId(),
          customCategoryId: newCatId,
          playlistId: newPlaylistId,
          type: item.type,
          upstreamStreamId: item.upstreamStreamId,
          upstreamSourceId: item.upstreamSourceId,
          streamId: item.streamId,
          extra: item.extra,
        }).run();
      }
    }
  });
}
```

- [ ] **Step 4: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server.ts server/routes/playlists.ts
git commit -m "feat: register custom-categories router, cascade delete, clone support"
```

---

## Task 5: Proxy — Inject Custom Categories into Category Lists

**Files:**
- Modify: `server/routes/proxy.ts`

The proxy has three nearly identical category list handlers: `get_live_categories`, `get_vod_categories`, `get_series_categories`. Each needs the same custom category injection appended after the existing `data` array is built and filtered.

- [ ] **Step 1: Add a helper function at the top of `createProxyRouter` (just before the `findPlaylistByCredentials` function, around line 60)**

```typescript
async function appendCustomCategories(
  db: ReturnType<typeof import('../db.ts').getDb>,
  playlistId: string,
  type: 'live' | 'vod' | 'series',
  data: any[]
): Promise<void> {
  const { customCategories } = await import('../schema.ts');
  const { eq, and } = await import('drizzle-orm');
  const cats = db.select().from(customCategories)
    .where(and(eq(customCategories.playlistId, playlistId), eq(customCategories.type, type)))
    .all();
  const sorted = cats
    .map(c => ({ id: c.id, name: c.name, ...((c.extra as any) || {}) }))
    .filter(c => !c.hidden)
    .sort((a, b) => (a.order ?? 999999) - (b.order ?? 999999));
  for (const c of sorted) {
    data.push({ category_id: `custom_${c.id}`, category_name: c.name, parent_id: 0 });
  }
}
```

- [ ] **Step 2: Call the helper at the end of `get_live_categories` case**

Find the line `data.forEach((c: any) => { delete c._order; delete c._hidden; delete c._sourceIdx; });` inside `case 'get_live_categories'`. Add immediately after it (before `break`):

```typescript
await appendCustomCategories(db, playlist.id, 'live', data);
```

- [ ] **Step 3: Call the helper at the end of `get_vod_categories` case**

Same pattern — find the equivalent cleanup line in `case 'get_vod_categories'` and add:

```typescript
await appendCustomCategories(db, playlist.id, 'vod', data);
```

- [ ] **Step 4: Call the helper at the end of `get_series_categories` case**

Same pattern in `case 'get_series_categories'`:

```typescript
await appendCustomCategories(db, playlist.id, 'series', data);
```

- [ ] **Step 5: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proxy.ts
git commit -m "feat: inject custom categories into Xtream category list responses"
```

---

## Task 6: Proxy — Inject Custom Category Items into Stream Lists

**Files:**
- Modify: `server/routes/proxy.ts`

Same pattern as Task 5: three nearly identical stream handlers (`get_live_streams`, `get_vod_streams`, `get_series`). Each needs custom category items injected into `filteredData` after the upstream items are built.

- [ ] **Step 1: Add a helper function `appendCustomCategoryItems` near `appendCustomCategories`**

Place it immediately after `appendCustomCategories`:

```typescript
async function appendCustomCategoryItems(
  db: ReturnType<typeof import('../db.ts').getDb>,
  playlistId: string,
  type: 'live' | 'vod' | 'series',
  filteredData: any[],
  categoryIdFilter: string | undefined,
  imgBase: string,
  applyRegex: (name: string, rules: any[]) => string
): Promise<void> {
  const { customCategories, customCategoryItems } = await import('../schema.ts');
  const { eq, and } = await import('drizzle-orm');
  const { getCached } = await import('../cache.ts');

  // Only inject if no filter, or filter is a custom category
  if (categoryIdFilter && !String(categoryIdFilter).startsWith('custom_')) return;

  const cats = db.select().from(customCategories)
    .where(and(eq(customCategories.playlistId, playlistId), eq(customCategories.type, type)))
    .all();

  const cacheStreamKey = type === 'vod' ? 'vod' : type === 'series' ? 'series' : 'live';

  for (const cat of cats) {
    const catExtra = (cat.extra as any) || {};
    if (catExtra.hidden) continue;
    if (categoryIdFilter && categoryIdFilter !== `custom_${cat.id}`) continue;

    const items = db.select().from(customCategoryItems)
      .where(eq(customCategoryItems.customCategoryId, cat.id))
      .all();

    items.sort((a, b) => ((a.extra as any)?.order ?? 999999) - ((b.extra as any)?.order ?? 999999));

    for (const item of items) {
      const itemExtra = (item.extra as any) || {};
      if (itemExtra.hidden) continue;

      const cached = getCached(`${item.upstreamSourceId}_streams_${cacheStreamKey}`);
      if (!cached?.data) continue; // no cache = skip (not missing, just unknown)

      const upstreamStream = cached.data.find((s: any) =>
        String(s.stream_id || s.series_id) === item.upstreamStreamId
      );
      if (!upstreamStream) continue; // missing — omit from IPTV output

      const streamObj: any = { ...upstreamStream };
      streamObj.stream_id = item.streamId;
      streamObj.category_id = `custom_${cat.id}`;

      const displayName = itemExtra.customName || upstreamStream.name || upstreamStream.title || '';
      streamObj.name = itemExtra.regexRenames?.length > 0
        ? applyRegex(displayName, itemExtra.regexRenames)
        : displayName;

      const icon = itemExtra.customIcon || itemExtra.epgIcon;
      if (icon) streamObj.stream_icon = proxyImageUrl(icon, imgBase);
      else if (streamObj.stream_icon) streamObj.stream_icon = proxyImageUrl(streamObj.stream_icon, imgBase);

      if (itemExtra.epgMapping) streamObj.epg_channel_id = itemExtra.epgMapping;

      // Clean up internal fields
      delete streamObj._client;
      delete streamObj._sourceIdx;

      filteredData.push(streamObj);
    }
  }
}
```

Note: `proxyImageUrl` is already defined in scope within `createProxyRouter` — the helper must be defined inside `createProxyRouter` (not at module level) to access it, OR `proxyImageUrl` must be hoisted. Since the existing helpers `appendCustomCategories` and `appendCustomCategoryItems` are defined at module level (outside the router factory), pass `proxyImageUrl` as a parameter instead:

Revise the signature to:

```typescript
async function appendCustomCategoryItems(
  db: ReturnType<typeof import('../db.ts').getDb>,
  playlistId: string,
  type: 'live' | 'vod' | 'series',
  filteredData: any[],
  categoryIdFilter: string | undefined,
  imgBase: string
): Promise<void> {
```

Note: `proxyImageUrl` and `applyRegex` are already imported at module level in `proxy.ts` from `../utils.ts`, so the helper function can use them directly without passing them as parameters.

- [ ] **Step 2: Call the helper at the end of `get_live_streams` case**

Find the `filteredData.sort(...)` block and the subsequent `for (const s of data) { delete s._catOrder; ... }` cleanup at the end of `case 'get_live_streams'`. After that cleanup and before `break`, add:

```typescript
await appendCustomCategoryItems(db, playlist.id, 'live', data, categoryId as string | undefined, imgBase);
```

- [ ] **Step 3: Call the helper at the end of `get_vod_streams` case**

Same pattern at the end of `case 'get_vod_streams'` before `break`:

```typescript
await appendCustomCategoryItems(db, playlist.id, 'vod', data, categoryId as string | undefined, imgBase);
```

- [ ] **Step 4: Call the helper at the end of `get_series` case**

Same pattern at the end of `case 'get_series'` before `break`:

```typescript
await appendCustomCategoryItems(db, playlist.id, 'series', data, categoryId as string | undefined, imgBase);
```

- [ ] **Step 5: Inject into M3U output (`/get.php`)**

Find `let rawStreams = allResults.flat();` in the `/get.php` handler (around line 1092). The `rawStreams` array is then filtered into a `streams` const using `rawStreams.filter(...)`. Custom items must be injected **after** that filter, because the filter checks `catOrderMap` which only contains upstream categories and would drop items with `category_id = custom_*`.

Find the `const streams = rawStreams.filter(...)` block and the variable it produces. Immediately after it (before the M3U line-building loop), add:

```typescript
// Inject custom category items into M3U output
const customM3uItems: any[] = [];
{
  const { customCategories: schemaCCs, customCategoryItems: schemaCCIs } = await import('../schema.ts');
  const { eq, and: _and } = await import('drizzle-orm');
  const cats = db.select().from(schemaCCs)
    .where(_and(eq(schemaCCs.playlistId, playlist.id), eq(schemaCCs.type, activeTabStr)))
    .all();
  for (const cat of cats) {
    const catE = (cat.extra as any) || {};
    if (catE.hidden) continue;
    const items = db.select().from(schemaCCIs)
      .where(eq(schemaCCIs.customCategoryId, cat.id))
      .all();
    for (const item of items) {
      const itemE = (item.extra as any) || {};
      if (itemE.hidden) continue;
      const cacheKey = activeTabStr === 'vod' ? 'vod' : activeTabStr === 'series' ? 'series' : 'live';
      const cached = getCached(`${item.upstreamSourceId}_streams_${cacheKey}`);
      if (!cached?.data) continue;
      const upstream = cached.data.find((s: any) => String(s.stream_id || s.series_id) === item.upstreamStreamId);
      if (!upstream) continue;
      const name = itemE.customName || upstream.name || upstream.title || '';
      customM3uItems.push({ ...upstream, stream_id: item.streamId, category_id: `custom_${cat.id}`, name, _catName: cat.name, streamId: item.streamId });
    }
  }
}
const allStreams = [...streams, ...customM3uItems];
```

Then replace the variable name `streams` in the M3U line-building loop with `allStreams`.

- [ ] **Step 6: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/routes/proxy.ts
git commit -m "feat: inject custom category items into Xtream stream list and M3U responses"
```

---

## Task 7: Proxy — Stream URL Resolution Fallback

**Files:**
- Modify: `server/routes/proxy.ts`

When a client requests `/live/user/pass/1000000.ts` (a custom item's synthetic stream ID), `handleStreamProxy` won't find it in `schemaMappings`. We need a fallback lookup.

- [ ] **Step 1: Add fallback lookup in `handleStreamProxy`**

Find the section in `handleStreamProxy` starting at (around line 84):

```typescript
let originalId = streamId;

// Look up stream mapping by raw upstream stream ID.
const { mappings: schemaMappings, sources: schemaSources } = await import('../schema.ts');
```

Replace this entire block (including the `streamMappingDoc` lookup and `targetSourceIds` derivation) with:

```typescript
let originalId = streamId;
let targetSourceOverride: string[] | null = null;

// Look up stream mapping by raw upstream stream ID.
const { mappings: schemaMappings, sources: schemaSources, customCategoryItems: schemaCustomItems } = await import('../schema.ts');
const { eq, and, inArray } = await import('drizzle-orm');
const mappingTypeMap: Record<string, string> = { live: 'live', movie: 'vod', series: 'series' };
const streamMappingDoc = db.select().from(schemaMappings).where(and(eq(schemaMappings.playlistId, String(playlist.id)), eq(schemaMappings.originalId, streamId), eq(schemaMappings.type, mappingTypeMap[type]))).get();
const streamMapping = streamMappingDoc ? { ...streamMappingDoc, ...(streamMappingDoc.extra as any || {}) } : null;

// Fallback: check custom category items if not found in regular mappings
if (!streamMapping) {
  const parsedStreamId = parseInt(streamId);
  if (!isNaN(parsedStreamId)) {
    const customItem = db.select().from(schemaCustomItems)
      .where(and(
        eq(schemaCustomItems.playlistId, String(playlist.id)),
        eq(schemaCustomItems.streamId, parsedStreamId)
      ))
      .get();
    if (customItem) {
      originalId = customItem.upstreamStreamId;
      targetSourceOverride = [customItem.upstreamSourceId];
    }
  }
}

const streamName = streamMapping
  ? computeDisplayName(streamMapping as any, playlist.qualityLabelFormat, globalFormat)
  : `Stream ${streamId}`;
```

Then find the existing `targetSourceIds` derivation:

```typescript
const sourceIdx = streamMapping?.sourceIdx ?? -1;
const targetSourceIds = (sourceIdx >= 0 && sourceIdx < sourceIds.length)
  ? [sourceIds[sourceIdx]]
  : sourceIds;
```

Replace with:

```typescript
const sourceIdx = streamMapping?.sourceIdx ?? -1;
const targetSourceIds = targetSourceOverride ?? (
  (sourceIdx >= 0 && sourceIdx < sourceIds.length)
    ? [sourceIds[sourceIdx]]
    : sourceIds
);
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/routes/proxy.ts
git commit -m "feat: add custom category item stream URL resolution fallback in proxy"
```

---

## Task 8: Frontend — State, Load, Types

**Files:**
- Modify: `src/components/index.tsx`

- [ ] **Step 1: Add imports at the top of `src/components/index.tsx`**

Find the existing import line near the top:

```typescript
import { User, Playlist, UpstreamSource, EPGSource, StreamMapping, CategoryMapping } from '../types';
```

Add `CustomCategory, CustomCategoryItem`:

```typescript
import { User, Playlist, UpstreamSource, EPGSource, StreamMapping, CategoryMapping, CustomCategory, CustomCategoryItem } from '../types';
```

- [ ] **Step 2: Add state to `PlaylistEditor`**

Find the `PlaylistEditor` function state declarations (around line 1747). Add after the `categoryMappings` state line:

```typescript
const [customCategories, setCustomCategories] = useState<CustomCategory[]>([]);
const [customCategoryItems, setCustomCategoryItems] = useState<Record<string, CustomCategoryItem[]>>({});
```

- [ ] **Step 3: Load custom categories in `loadPlaylistData`**

Find the `loadPlaylistData` callback (around line 1774). Change the `Promise.all` call to also fetch custom categories:

```typescript
const [playlistData, mappingData, catMappingData, epgData, customCatData] = await Promise.all([
  api.playlists.list().then(list => list.find(p => p.id === id) || null),
  api.mappings.list(id),
  api.categoryMappings.list(id),
  api.epgs.channels(id).catch(() => ({ channels: [] })),
  api.customCategories.list(id),
]);
setPlaylist(playlistData);
setMappings(mappingData);
setCategoryMappings(catMappingData);
setEpgChannels(epgData.channels);
setCustomCategories(customCatData);
```

- [ ] **Step 4: Add `loadCustomCategoryItems` helper**

After `loadPlaylistData`, add a new callback:

```typescript
const loadCustomCategoryItems = useCallback(async (catId: string) => {
  if (!id) return;
  try {
    const items = await api.customCategories.listItems(catId);
    setCustomCategoryItems(prev => ({ ...prev, [catId]: items }));
  } catch (err) {
    console.error('Failed to load custom category items:', err);
  }
}, [id]);
```

- [ ] **Step 5: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: add custom category state and loading to PlaylistEditor"
```

---

## Task 9: Frontend — Category Panel: Create + List Custom Categories

**Files:**
- Modify: `src/components/index.tsx`

- [ ] **Step 1: Add `createCustomCategory` handler to `PlaylistEditor`**

After `loadCustomCategoryItems`, add:

```typescript
const createCustomCategory = useCallback(async (name: string) => {
  if (!id || !name.trim()) return;
  try {
    const newCat = await api.customCategories.create({ playlistId: id, type: activeTab, name: name.trim() });
    setCustomCategories(prev => [...prev, newCat]);
  } catch (err) {
    console.error('Failed to create custom category:', err);
  }
}, [id, activeTab]);
```

- [ ] **Step 2: Add a `SortableCustomCategory` component**

Add this component after the existing `SortableCategory` component (around line 3591):

```tsx
function SortableCustomCategory({
  cat,
  isSelected,
  onClick,
  onDelete,
  onRename,
}: {
  cat: CustomCategory;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [nameVal, setNameVal] = useState(cat.name);

  useEffect(() => { setNameVal(cat.name); }, [cat.name]);

  const handleRename = async () => {
    const trimmed = nameVal.trim();
    if (!trimmed || trimmed === cat.name) { setIsEditing(false); return; }
    await onRename(cat.id, trimmed);
    setIsEditing(false);
  };

  return (
    <div
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-all group relative cursor-pointer",
        isSelected
          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.05)]"
          : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300 border border-transparent"
      )}
    >
      <Star size={10} className={cn("shrink-0", isSelected ? "text-emerald-500" : "text-zinc-600")} />

      <div className="flex-1 flex items-center min-w-0">
        {isEditing ? (
          <form onSubmit={(e) => { e.preventDefault(); handleRename(); }} className="flex-1" onClick={e => e.stopPropagation()}>
            <input
              autoFocus
              value={nameVal}
              onChange={e => setNameVal(e.target.value)}
              onBlur={() => setIsEditing(false)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs focus:outline-none focus:border-emerald-500"
            />
          </form>
        ) : (
          <span className={cn(
            "text-xs font-medium truncate",
            isSelected ? "text-emerald-400" : "text-zinc-300 group-hover:text-zinc-100"
          )}>
            {cat.name}
          </span>
        )}
      </div>

      {cat.missingCount != null && cat.missingCount > 0 && (
        <span className="text-[8px] font-bold text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-1 shrink-0">
          {cat.missingCount} missing
        </span>
      )}

      <div className={cn("flex items-center gap-1 transition-opacity", isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
        <button
          onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
          className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300"
          title="Rename"
        >
          <Edit3 size={11} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(cat.id); }}
          className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-red-400"
          title="Delete custom category"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
```

(Note: `Star`, `Trash2`, `Edit3` are already imported from `lucide-react` in this file — verify and add any missing ones to the existing import.)

- [ ] **Step 3: Add `handleDeleteCustomCategory` and `handleRenameCustomCategory` to `PlaylistEditor`**

Add these handlers after `createCustomCategory`:

```typescript
const handleDeleteCustomCategory = useCallback(async (catId: string) => {
  if (!confirm('Delete this custom category and all its channels?')) return;
  try {
    await api.customCategories.delete(catId);
    setCustomCategories(prev => prev.filter(c => c.id !== catId));
    setCustomCategoryItems(prev => { const next = { ...prev }; delete next[catId]; return next; });
    setSelectedCategoryIds(prev => { const next = new Set(prev); next.delete(`custom_${catId}`); return next; });
  } catch (err) {
    console.error('Failed to delete custom category:', err);
  }
}, []);

const handleRenameCustomCategory = useCallback(async (catId: string, name: string) => {
  try {
    await api.customCategories.update(catId, { name });
    setCustomCategories(prev => prev.map(c => c.id === catId ? { ...c, name } : c));
  } catch (err) {
    console.error('Failed to rename custom category:', err);
  }
}, []);
```

- [ ] **Step 4: Add "+ Custom Category" button and render list in the category panel**

Find the category panel's `<div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">` section (around line 2921). After the closing `</DndContext>` tag but still inside the scrollable div, add:

```tsx
{/* Custom Categories */}
{customCategories.filter(c => c.type === activeTab).length > 0 && (
  <div className="my-1 h-px bg-zinc-800/60" />
)}
{customCategories.filter(c => c.type === activeTab).map(cat => (
  <SortableCustomCategory
    key={cat.id}
    cat={cat}
    isSelected={selectedCategoryIds.has(`custom_${cat.id}`)}
    onClick={() => {
      setSelectedCategoryIds(new Set([`custom_${cat.id}`]));
      loadCustomCategoryItems(cat.id);
    }}
    onDelete={handleDeleteCustomCategory}
    onRename={handleRenameCustomCategory}
  />
))}
```

Find the category panel header section (the `<div>` containing the search input and hide/show button, around line 2880). Add a "+ Custom Category" button inline with the other header buttons. Find the closing `</div>` of the button group in the header and add before it:

```tsx
<NewCustomCategoryButton onConfirm={createCustomCategory} />
```

- [ ] **Step 5: Add `NewCustomCategoryButton` component**

Add this small component near `SortableCustomCategory`:

```tsx
function NewCustomCategoryButton({ onConfirm }: { onConfirm: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const confirm = () => {
    if (name.trim()) { onConfirm(name.trim()); }
    setName('');
    setOpen(false);
  };

  if (open) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); confirm(); }} className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={() => { setOpen(false); setName(''); }}
          onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); setName(''); } }}
          placeholder="Category name"
          className="bg-zinc-950 border border-emerald-500/50 rounded px-2 py-1 text-xs w-28 outline-none text-zinc-200"
        />
        <button type="submit" className="p-1 text-emerald-500 hover:text-emerald-400">
          <Check size={13} />
        </button>
      </form>
    );
  }

  return (
    <button
      onClick={() => setOpen(true)}
      className="p-2 rounded-xl border bg-zinc-950 text-zinc-500 border-zinc-800 hover:bg-zinc-800 transition-all shrink-0"
      title="New custom category"
    >
      <FolderPlus size={16} />
    </button>
  );
}
```

(Add `FolderPlus`, `Check` to the lucide-react import if not already present.)

- [ ] **Step 6: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: add custom category creation and listing to PlaylistEditor"
```

---

## Task 10: Frontend — Copy Channel Button + Popover

**Files:**
- Modify: `src/components/index.tsx`

Each stream row in the stream list needs a copy-to-custom-category button.

- [ ] **Step 1: Add `CopyToCustomCategoryButton` component**

Add this component after `NewCustomCategoryButton`:

```tsx
function CopyToCustomCategoryButton({
  stream,
  type,
  mapping,
  playlistId,
  sourceId,
  customCategories,
  onCopied,
}: {
  stream: any;
  type: 'live' | 'vod' | 'series';
  mapping?: StreamMapping;
  playlistId: string;
  sourceId: string;
  customCategories: CustomCategory[];
  onCopied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState(false);

  const relevantCats = customCategories.filter(c => c.type === type);

  const doCopy = async (catId: string) => {
    setCopying(true);
    try {
      const snapshot: any = {
        playlistId,
        type,
        upstreamStreamId: String(stream.stream_id || stream.series_id || stream._rawId),
        upstreamSourceId: sourceId,
        customName: mapping?.customName || stream.name || stream.title || '',
        epgMapping: mapping?.epgMapping || stream.epg_channel_id || '',
        epgIcon: mapping?.epgIcon || '',
        customIcon: mapping?.customIcon || '',
        regexRenames: mapping?.regexRenames || [],
        order: 999999,
        hidden: false,
      };
      await api.customCategories.createItem(catId, snapshot);
      setOpen(false);
      onCopied();
    } catch (err) {
      console.error('Failed to copy channel:', err);
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        className="p-1 hover:bg-zinc-800 rounded text-zinc-600 hover:text-emerald-400 transition-colors"
        title="Copy to custom category"
      >
        <Copy size={12} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl min-w-[160px] p-1"
          onClick={e => e.stopPropagation()}
        >
          {relevantCats.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500">No custom categories yet.<br/>Create one in the category panel.</div>
          ) : (
            relevantCats.map(cat => (
              <button
                key={cat.id}
                disabled={copying}
                onClick={() => doCopy(cat.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-emerald-400 rounded-lg transition-colors"
              >
                <Star size={10} className="text-zinc-500" />
                {cat.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

(Add `Copy` to the lucide-react imports if not already present.)

- [ ] **Step 2: Pass `customCategories` + handlers down to `StreamTableMemo`**

Find where `StreamTableMemo` is rendered (around line 3023). The component receives many props. Add two more:

```tsx
<StreamTableMemo
  ...existing props...
  customCategories={customCategories}
  onCustomCopied={() => loadPlaylistData()}
/>
```

- [ ] **Step 3: Thread the props through `StreamTableMemo` to `StreamRow`**

Find the `StreamTableMemo` component definition and its props interface. Add:

```typescript
customCategories: CustomCategory[];
onCustomCopied: () => void;
```

Pass them into the `StreamRow` render call inside `StreamTableMemo`.

Find the `StreamRow` component's props interface and add the same two props. Inside `StreamRow`, render the `CopyToCustomCategoryButton`:

```tsx
// Find the "Actions" column in the stream row (the div with w-20 shrink-0 text-center)
// Add the button inside it, alongside the existing action buttons:
<CopyToCustomCategoryButton
  stream={stream}
  type={activeTab}
  mapping={mappings.find(m => m.originalId === stream._rawId && m.type === activeTab)}
  playlistId={playlistId}
  sourceId={allSources.find(s => playlistSourceIds[stream._sourceIdx ?? 0] === s.id)?.id || ''}
  customCategories={customCategories}
  onCopied={onCustomCopied}
/>
```

- [ ] **Step 4: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: add copy-to-custom-category button on stream rows"
```

---

## Task 11: Frontend — Custom Category Items View

**Files:**
- Modify: `src/components/index.tsx`

When a custom category is selected, the stream panel should show its items instead of regular filtered streams — with missing items greyed out/strikethrough.

- [ ] **Step 1: Detect when a custom category is selected**

In `PlaylistEditor`, add a derived value after the `sortedCategories` useMemo:

```typescript
const selectedCustomCatId = useMemo(() => {
  if (selectedCategoryIds.size !== 1) return null;
  const id = Array.from(selectedCategoryIds)[0];
  return id.startsWith('custom_') ? id.replace('custom_', '') : null;
}, [selectedCategoryIds]);
```

- [ ] **Step 2: Render custom category items view when a custom category is selected**

Find the `{/* Streams Grid */}` section (around line 2966). Wrap the existing stream table in a conditional:

```tsx
{selectedCustomCatId ? (
  <CustomCategoryItemsView
    catId={selectedCustomCatId}
    items={customCategoryItems[selectedCustomCatId] || []}
    onLoadItems={() => loadCustomCategoryItems(selectedCustomCatId)}
    onRemoveItem={async (itemId) => {
      await api.customCategories.deleteItem(selectedCustomCatId, itemId);
      loadCustomCategoryItems(selectedCustomCatId);
      setCustomCategories(prev => prev.map(c =>
        c.id === selectedCustomCatId
          ? { ...c, missingCount: Math.max(0, (c.missingCount || 0) - 1) }
          : c
      ));
    }}
    onUpdateItem={async (itemId, data) => {
      await api.customCategories.updateItem(selectedCustomCatId, itemId, data);
      loadCustomCategoryItems(selectedCustomCatId);
    }}
  />
) : (
  // ... existing stream list JSX (unchanged) ...
)}
```

- [ ] **Step 3: Create `CustomCategoryItemsView` component**

```tsx
function CustomCategoryItemsView({
  catId,
  items,
  onLoadItems,
  onRemoveItem,
  onUpdateItem,
}: {
  catId: string;
  items: CustomCategoryItem[];
  onLoadItems: () => void;
  onRemoveItem: (itemId: string) => void;
  onUpdateItem: (itemId: string, data: any) => void;
}) {
  useEffect(() => { onLoadItems(); }, [catId]);

  if (!items.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-3">
        <Star size={32} className="text-zinc-700" />
        <p className="text-zinc-500 text-sm">No channels in this category yet.</p>
        <p className="text-zinc-600 text-xs">Click the copy icon on any channel to add it here.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900/30 text-[10px] uppercase tracking-wider text-zinc-500 font-bold">
        <div className="flex-1 min-w-0">Name</div>
        <div className="w-20 shrink-0 text-center">Actions</div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {items.map((item, idx) => (
          <div
            key={item.id}
            className={cn(
              "flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800/50 group hover:bg-zinc-900/30 transition-colors",
              !item.exists && "opacity-50"
            )}
          >
            <div className="w-8 shrink-0 text-zinc-600 text-xs text-center font-mono">{idx + 1}</div>
            <div className="flex-1 min-w-0">
              <span className={cn(
                "text-sm text-zinc-200",
                !item.exists && "line-through text-zinc-500"
              )}>
                {item.customName || item.upstreamStreamId}
              </span>
              {!item.exists && (
                <span className="ml-2 text-[9px] font-bold text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-1">
                  Missing
                </span>
              )}
            </div>
            <div className="w-20 shrink-0 flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => onRemoveItem(item.id)}
                className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-red-400 transition-colors"
                title="Remove from custom category"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

(Add `X` to lucide-react imports if not already present.)

- [ ] **Step 4: Type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Start dev server and smoke-test manually**

```bash
npm run dev
```

Manual verification checklist:
- [ ] Can create a custom category (click "+ Custom Category", type name, press Enter)
- [ ] Custom category appears in the category panel with a star icon
- [ ] Clicking a stream's copy icon shows the custom category popover
- [ ] Copying a channel adds it to the custom category; selecting the custom category shows the item
- [ ] Starting the dev server and requesting `GET /player_api.php?username=X&password=Y&action=get_live_categories` returns the custom category in the list
- [ ] `GET /player_api.php?...&action=get_live_streams` returns the copied channel with `category_id = custom_<id>` and its own `stream_id`

- [ ] **Step 6: Commit**

```bash
git add src/components/index.tsx
git commit -m "feat: add custom category items view with missing channel indicators"
```

---

## Task 12: Final Type-Check + Build

- [ ] **Step 1: Run full type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 2: Build frontend**

```bash
npm run build
```

Expected: successful build with no TypeScript errors.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: custom categories complete — create, copy channels, missing indicators, proxy injection"
```
