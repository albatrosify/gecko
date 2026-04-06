import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  role: text('role').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }),
});

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  url: text('url').notNull(),
  username: text('username'),
  password: text('password'),
  autoSyncEnabled: integer('autoSyncEnabled', { mode: 'boolean' }),
  syncCron: text('syncCron'),
  extra: text('extra', { mode: 'json' }), // stores any other fields like useUpstreamEpg etc
});

export const epgs = sqliteTable('epgs', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  extra: text('extra', { mode: 'json' }),
});

export const playlists = sqliteTable('playlists', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  username: text('username').notNull().unique(),
  password: text('password').notNull(),
  sourceIds: text('sourceIds', { mode: 'json' }), // JSON array
  directStreams: integer('directStreams', { mode: 'boolean' }),
  extra: text('extra', { mode: 'json' }), // stores epgIds, isSynced, nextStreamId, qualityLabelFormat
});

export const mappings = sqliteTable('mappings', {
  id: text('id').primaryKey(),
  playlistId: text('playlistId').notNull(),
  type: text('type').notNull(),
  originalId: text('originalId').notNull(),
  extra: text('extra', { mode: 'json' }), // stores order, sourceIdx, categoryId, epgMapping, hidden, customIcon, epgIcon, customName, regexRenames
});

export const categoryMappings = sqliteTable('categoryMappings', {
  id: text('id').primaryKey(),
  playlistId: text('playlistId').notNull(),
  type: text('type').notNull(),
  originalId: text('originalId').notNull(),
  extra: text('extra', { mode: 'json' }), // stores order, hidden, customName, syncOnDemand
});

export const source_sync_meta = sqliteTable('source_sync_meta', {
  key: text('key').primaryKey(), // sourceId_type
  lastSync: text('lastSync'),
  extra: text('extra', { mode: 'json' }),
});

export const cache = sqliteTable('cache', {
  key: text('key').primaryKey(),
  data: text('data', { mode: 'json' }),
  updatedAt: text('updatedAt'),
  expiresAt: integer('expiresAt'),
});

export const customCategories = sqliteTable('customCategories', {
  id: text('id').primaryKey(),
  playlistId: text('playlistId').notNull(),
  type: text('type').notNull(), // 'live', 'vod', 'series'
  name: text('name').notNull(),
  order: integer('order').notNull().default(0),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
});

export const customCategoryItems = sqliteTable('customCategoryItems', {
  id: text('id').primaryKey(),
  customCategoryId: text('customCategoryId').notNull(),
  playlistId: text('playlistId').notNull(),
  type: text('type').notNull(),
  upstreamStreamId: text('upstreamStreamId').notNull(),
  upstreamSourceId: text('upstreamSourceId').notNull(),
  streamId: text('streamId').notNull(), // User-facing stable stream ID
  extra: text('extra', { mode: 'json' }), // Snapshot of name, icon, etc.
});

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  extra: text('extra', { mode: 'json' }),
});

export const source_changelogs = sqliteTable('source_changelogs', {
  id: text('id').primaryKey(),
  sourceId: text('sourceId'),
  extra: text('extra', { mode: 'json' }),
});
