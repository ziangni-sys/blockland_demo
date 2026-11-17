// Dev harness for the UI module only:
//   npx vite --config dev/ui/vite.config.ts --port 5182 --strictPort
//   open http://127.0.0.1:5182/dev/ui/
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  cacheDir: 'node_modules/.vite-ui',
  define: { __ARTIFACT__: 'false' },
  server: { host: '127.0.0.1', port: 5182, strictPort: true },
  logLevel: 'warn',
});
