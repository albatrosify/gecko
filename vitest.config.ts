import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: ['player/**', 'node_modules/**', 'dist/**'],
  },
});
