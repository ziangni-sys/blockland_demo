// Dev server for the WebRTC test page (package 10; scripts/e2e-room.mjs starts it itself):
//   npx vite --config dev/rtc/vite.config.ts --port 5185 --strictPort
//   open http://127.0.0.1:5185/dev/rtc/ in two tabs
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  cacheDir: 'node_modules/.vite-rtc',
  define: { __ARTIFACT__: 'false', __BUILD_ID__: JSON.stringify('rtc-test') },
  server: { host: '127.0.0.1', port: 5185, strictPort: true, hmr: false },
  logLevel: 'warn',
});
