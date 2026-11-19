import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// mode "artifact": one self-contained HTML file (JS inlined, workers as blob URLs) for
// hosts that only serve a single page. Default mode: normal multi-file static build.

/** What a build is made from: a change here changes the build. */
const BUILD_SOURCES = ['src', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts'];

/**
 * __BUILD_ID__ (src/net/protocol.ts BUILD_ID, docs/NETCODE.md section 3): two builds connect only
 * when it is equal. Dev server: 'dev-' plus the time it started. Build (both modes): the commit,
 * with '-dirty-<time>' appended when the sources differ from it (two such builds may differ, so
 * they must not match), or 'nogit-<time>' outside a git checkout. Vitest defines 'test'.
 */
function buildId(command: 'build' | 'serve'): string {
  const started = Date.now();
  if (command === 'serve') return `dev-${started}`;
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit: string;
  try {
    commit = git(['rev-parse', '--short=12', 'HEAD']);
  } catch {
    return `nogit-${started}`;
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', ...BUILD_SOURCES]) !== '';
  return dirty ? `${commit}-dirty-${started}` : commit;
}

export default defineConfig(({ mode, command }) => {
  const artifact = mode === 'artifact';
  return {
    base: './',
    define: { __ARTIFACT__: JSON.stringify(artifact), __BUILD_ID__: JSON.stringify(buildId(command)) },
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
