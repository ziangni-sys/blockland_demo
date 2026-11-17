// Dev server for the render harness only:
//   npx vite --config dev/render/vite.config.ts --port 5181 --strictPort
//   open http://127.0.0.1:5181/dev/render/
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  cacheDir: 'node_modules/.vite-render',
  define: { __ARTIFACT__: 'false', __BUILD_ID__: JSON.stringify(`dev-${Date.now()}`) },
  server: { host: '127.0.0.1', port: 5181, strictPort: true },
  logLevel: 'info',
});
