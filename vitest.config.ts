import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __ARTIFACT__: 'false' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'threads',
  },
});
