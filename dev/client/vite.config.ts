// Dev server for the game itself with its own dependency cache, so it does not fight with
// the other harness servers running from the same checkout:
//   npx vite --config dev/client/vite.config.ts --port 5183 --strictPort
//   open http://127.0.0.1:5183/
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  base: './',
  cacheDir: 'node_modules/.vite-client',
  define: { __ARTIFACT__: 'false' },
  worker: { format: 'es' as const },
  server: { host: '127.0.0.1', port: 5183, strictPort: true },
  logLevel: 'info',
});
