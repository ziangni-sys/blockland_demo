import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __ARTIFACT__: 'false', __BUILD_ID__: JSON.stringify('test') },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'threads',
  },
});
