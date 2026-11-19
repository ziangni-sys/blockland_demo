import { defineConfig } from 'vitest/config';

/**
 * Three projects: the unit tests, and the acceptance tests twice (docs/NETCODE.md section 16,
 * scenario 30): with the server-driven player on a Simulation ('direct'), and through the protocol
 * with a real client and server in lockstep ('network'). tests/acceptance/world.ts reads the mode.
 */
const ACCEPTANCE = 'tests/acceptance/**/*.test.ts';

export default defineConfig({
  define: { __ARTIFACT__: 'false', __BUILD_ID__: JSON.stringify('test') },
  test: {
    environment: 'node',
    testTimeout: 30_000,
    pool: 'threads',
    // The two acceptance projects must run the same ticks (tests/acceptance/tick-parity.ts).
    globalSetup: ['tests/acceptance/tick-parity.ts'],
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: [ACCEPTANCE] } },
      {
        extends: true,
        test: { name: 'acceptance', include: [ACCEPTANCE], setupFiles: ['tests/acceptance/setup.ts'], env: { BLOCKLANDS_WORLD: 'direct' } },
      },
      {
        extends: true,
        test: { name: 'acceptance-net', include: [ACCEPTANCE], setupFiles: ['tests/acceptance/setup.ts'], env: { BLOCKLANDS_WORLD: 'network' } },
      },
    ],
  },
});
