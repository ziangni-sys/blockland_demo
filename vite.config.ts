import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// mode "artifact": one self-contained HTML file (JS inlined, workers as blob URLs) for
// hosts that only serve a single page. Default mode: normal multi-file static build.
export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  return {
    base: './',
    define: { __ARTIFACT__: JSON.stringify(artifact) },
    plugins: artifact ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
    worker: { format: 'es' as const },
    build: {
      target: 'es2022',
      outDir: artifact ? 'dist-artifact' : 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 4000,
      assetsInlineLimit: artifact ? 100_000_000 : 4096,
    },
    server: { host: '127.0.0.1', port: 5173 },
    preview: { host: '127.0.0.1', port: 4173 },
  };
});
