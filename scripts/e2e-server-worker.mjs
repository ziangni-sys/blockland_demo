#!/usr/bin/env node
// Browser test of the game server Worker (NETCODE package 8), Playwright + Chromium.
//
//   node scripts/e2e-server-worker.mjs [--no-build] [--only normal|artifact|sandboxed] [--ms N]
//
// For both builds — the normal static site (dist/, served as files) and the single-file artifact
// (dist-artifact/blocklands.html wrapped in a minimal document, like the publishing host and
// scripts/e2e-smoke.mjs do) — it opens the page, calls window.__blocklands.serverProbe(ms)
// (src/client/serverprobe.ts), which starts the server Worker, creates a world, connects a real
// NetClient over a PortTransport as the host's client, lets it join (connecting, joining, ready)
// and apply the tick batches for `ms` milliseconds, then shuts the server down (the client is
// kicked) and deletes the world it made. A third run puts
// the artifact in an opaque-origin sandbox (<iframe sandbox="allow-scripts">, where module
// workers from blob URLs are refused and IndexedDB is unavailable): the probe starts the Worker
// from a data: URL, and the Worker's `ready` must say that its storage is memory only. The run
// fails on a bad probe result, any console error, page error or failed request, on a world left
// in the browser's storage, and (artifact) on any request besides the page itself.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 960, height: 540 };

const argv = process.argv.slice(2);
let build = true;
let only = null;
let probeMs = 4000;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-build') build = false;
  else if (a === '--only') only = argv[++i];
  else if (a === '--ms') probeMs = Number(argv[++i]);
  else {
    console.error('usage: node scripts/e2e-server-worker.mjs [--no-build] [--only normal|artifact|sandboxed] [--ms N]');
    process.exit(2);
  }
}

function loadPlaywright() {
  const attempts = [() => createRequire(import.meta.url)('playwright')];
  for (const dir of [...(process.env.NODE_PATH ?? '').split(':').filter(Boolean), '/opt/node-tools/node_modules']) {
    attempts.push(() => createRequire(join(dir, 'noop.js'))('playwright'));
  }
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // try the next location
    }
  }
  console.error('playwright is not installed (looked next to the script, in NODE_PATH and in /opt/node-tools/node_modules)');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Serves `page(url)` for a request, or 404; records every request. */
function serve(page) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const body = page(req.url);
    if (body === null) {
      res.writeHead(req.url === '/favicon.ico' ? 204 : 404, { 'content-type': 'text/plain' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': body.type, 'cache-control': 'no-store' });
    res.end(body.data);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      done({ url: `http://127.0.0.1:${port}/`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function normalSite() {
  const dist = join(ROOT, 'dist');
  return serve((url) => {
    const path = url.split('?')[0] === '/' ? '/index.html' : url.split('?')[0];
    const file = normalize(join(dist, path));
    if (!file.startsWith(dist) || !existsSync(file)) return null;
    return { type: TYPES[extname(file)] ?? 'application/octet-stream', data: readFileSync(file) };
  });
}

function artifactPage() {
  const fragment = readFileSync(join(ROOT, 'dist-artifact', 'blocklands.html'), 'utf8');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    `</head><body>${fragment}</body></html>`
  );
}

function artifactSite() {
  const page = artifactPage();
  return serve((url) => (url === '/' || url === '/index.html' ? { type: TYPES['.html'], data: page } : null));
}

/** The artifact at /game.html inside a sandboxed iframe (an opaque origin) of the page at /. */
function sandboxedSite() {
  const page = artifactPage();
  const outer =
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
    '<iframe sandbox="allow-scripts" src="/game.html" style="border:0;width:100vw;height:100vh"></iframe></body></html>';
  return serve((url) => (url === '/' ? { type: TYPES['.html'], data: outer } : url === '/game.html' ? { type: TYPES['.html'], data: page } : null));
}

async function runOne(name, site) {
  const problems = [];
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => {
      if (!r.url().startsWith('data:') && !r.url().startsWith('blob:')) problems.push(`request failed: ${r.url()}`);
    });
    await page.goto(site.url);
    const sandboxed = name === 'sandboxed';
    let frame = page.mainFrame();
    if (sandboxed) {
      const deadline = Date.now() + 30_000;
      while ((frame = page.frames().find((f) => f.url().endsWith('/game.html')) ?? null) === null && Date.now() < deadline) await page.waitForTimeout(100);
      if (frame === null) throw new Error('the sandboxed frame never appeared');
    }
    await frame.waitForFunction(() => window.__blocklands?.serverProbe !== undefined, null, { timeout: 60_000 });
    const t0 = Date.now();
    const r = await frame.evaluate(([ms, fromDataUrl]) => window.__blocklands.serverProbe(ms, { fromDataUrl }), [probeMs, sandboxed]);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `  [${name}] ${secs}s: ${r.batches} batches (ticks ${r.firstTick}..${r.lastTick}), statuses ${r.statuses.join(' ')}, columns ${r.columns}, kick ${r.kick}, ` +
        `persistent ${r.persistent}${r.storageReason !== null ? ` (${r.storageReason})` : ''}, world left ${r.worldLeft}, reports ${r.reports.join(' ')}`,
    );
    const expectTicks = Math.floor((probeMs / 1000) * 20 * 0.6);
    if (!r.worldReady) problems.push('the server Worker never reported ready');
    if (!r.welcome || !r.isHost) problems.push('no Welcome as the host');
    if (r.batches < expectTicks) problems.push(`only ${r.batches} batches in ${probeMs} ms (expected at least ${expectTicks})`);
    if (!r.contiguous) problems.push('the batches skipped ticks');
    if (!r.ready) problems.push('the NetClient never became ready');
    if (r.statuses.join(' ') !== 'connecting joining ready kicked') problems.push(`NetClient statuses ${r.statuses.join(' ')}`);
    if (r.columns === 0) problems.push('no columns in the replica');
    if (r.kick !== 'shutdown') problems.push(`expected Kick(shutdown), got ${r.kick}`);
    if (!r.closed) problems.push('the server Worker never reported closed');
    if (sandboxed ? r.persistent !== false || r.storageReason === null : r.persistent !== true) {
      problems.push(`ready said persistent ${r.persistent} (${r.storageReason}); expected ${sandboxed ? 'false with a reason' : 'true'}`);
    }
    if (r.worldLeft) problems.push("the probe's world is still in the browser's storage");
    for (const e of r.errors) problems.push(`probe: ${e}`);
    if (name !== 'normal') {
      const extra = site.requests.filter((u) => u !== '/' && u !== '/game.html' && u !== '/favicon.ico');
      if (extra.length > 0) problems.push(`the single-file build made requests: ${extra.join(', ')}`);
    }
  } finally {
    await browser.close();
  }
  return problems;
}

if (build) {
  for (const script of ['build', 'build:artifact']) {
    console.log(`npm run ${script}`);
    const r = spawnSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

let failed = false;
for (const [name, make] of [
  ['normal', normalSite],
  ['artifact', artifactSite],
  ['sandboxed', sandboxedSite],
]) {
  if (only !== null && only !== name) continue;
  const site = await make();
  try {
    const problems = await runOne(name, site);
    if (problems.length > 0) {
      failed = true;
      console.log(`  [${name}] FAILED:\n    ${problems.join('\n    ')}`);
    } else console.log(`  [${name}] ok`);
  } finally {
    await site.close();
  }
}
process.exit(failed ? 1 : 0);
