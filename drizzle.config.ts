import type { Config } from 'drizzle-kit';
export default {
  schema: './server/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.SQLITE_PATH || './data/gecko.db' },
} satisfies Config;
