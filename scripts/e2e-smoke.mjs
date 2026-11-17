#!/usr/bin/env node
// End-to-end smoke test of the browser game (Playwright + Chromium).
//
//   node scripts/e2e-smoke.mjs [url] [--out DIR] [--no-build] [--only webgl|webgpu]
//
// Without a URL it runs `npm run build:artifact`, then serves dist-artifact/blocklands.html
// the way the publishing host does (the fragment wrapped in a minimal document skeleton) from
// a tiny static server on 127.0.0.1 — and checks that the page makes no network request at
// all. With a URL (e.g. the dev server) it tests that page as is.
//
// The whole scenario runs twice: with default flags (WebGL2 through SwiftShader) and with
// real WebGPU on SwiftShader's software adapter. Headless Chromium cannot present a WebGPU
// canvas in this kind of container (the swap chain's shared image cannot be created and the
// device is destroyed on the first frame), so the WebGPU run uses a headed browser on a
// virtual X display (Xvfb) when no DISPLAY is set and Xvfb is installed.
//
// Scenario: create a creative world from the main menu with a fixed seed, wait for the
// loading screen, check chunks / meshes / renderer API, walk, place + break a block, place a
// second one, open + close the inventory, pause + resume, save & quit, load the world again
// and check the second block is still there (when storage is persistent). Any console error,
// page error or failed request fails the run. Screenshots of every stage go to --out
// (default: a fresh temp directory, printed at the end).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = join(ROOT, 'dist-artifact', 'blocklands.html');
const SEED = 'smoke-test';
const RENDER_DISTANCE = 4;
const VIEWPORT = { width: 960, height: 540 };
const LOAD_TIMEOUT = 240_000;
const STEP_TIMEOUT = 30_000;
const PLANKS = 10;
const WEBGPU_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--enable-unsafe-swiftshader',
];

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
let url = null;
let outDir = null;
let build = true;
let only = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') outDir = argv[++i];
  else if (a === '--no-build') build = false;
  else if (a === '--only') only = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log('usage: node scripts/e2e-smoke.mjs [url] [--out DIR] [--no-build] [--only webgl|webgpu]');
    process.exit(0);
  } else if (!a.startsWith('--')) url = a;
  else {
    console.error(`unknown option ${a}`);
    process.exit(2);
  }
}
outDir = resolve(outDir ?? mkdtempSync(join(tmpdir(), 'blocklands-e2e-')));
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------ playwright

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

// ------------------------------------------------------------------ static host

/** Serves the artifact fragment wrapped like the host does; records every request. */
function startHost(file) {
  const fragment = readFileSync(file, 'utf8');
  const page =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    `</head><body>${fragment}</body></html>`;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    } else if (req.url === '/favicon.ico') {
      // A headed browser asks for the top-level document's icon by itself; that is the host
      // page's business (the artifact is a fragment of it), not a request made by the game.
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({ url: `http://127.0.0.1:${port}/`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// ------------------------------------------------------------------ virtual display

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Starts Xvfb on a free display; resolves to { display, stop } or null. */
async function startXvfb() {
  const bin = which('Xvfb');
  if (!bin) return null;
  for (let n = 90; n < 130; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const proc = spawn(bin, [`:${n}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    let exited = false;
    proc.on('exit', () => (exited = true));
    for (let t = 0; t < 100 && !exited; t++) {
      if (existsSync(`/tmp/.X11-unix/X${n}`)) {
        return {
          display: `:${n}`,
          stop: () => {
            if (!exited) proc.kill('SIGTERM');
          },
        };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!exited) proc.kill('SIGTERM');
  }
  return null;
}

// ------------------------------------------------------------------ the scenario

class StepError extends Error {}

async function runMode(mode, pageUrl, hostRequests) {
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const steps = [];
  const problems = [];
  const log = (msg) => {
    steps.push(`${elapsed()} ${msg}`);
    console.log(`  [${mode}] ${elapsed()} ${msg}`);
  };

  let xvfb = null;
  const launch = { args: mode === 'webgpu' ? WEBGPU_FLAGS : [] };
  if (mode === 'webgpu') {
    if (process.env.DISPLAY) {
      launch.headless = false;
    } else {
      xvfb = await startXvfb();
      if (xvfb) {
        launch.headless = false;
        launch.env = { ...process.env, DISPLAY: xvfb.display };
      } else {
        log('warning: no display and no Xvfb — headless WebGPU cannot present the canvas; screenshots will be blank');
      }
    }
  }
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  let listening = true;
  page.on('console', (m) => {
    if (listening && m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    if (listening) problems.push(`page error: ${e.message}`);
  });
  page.on('requestfailed', (r) => {
    if (listening && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) problems.push(`request failed: ${r.url()}`);
  });

  const G = (fn, arg) => page.evaluate(fn, arg);
  const state = () => G(() => window.__blocklands.game.debug.state());
  const shot = async (name) => {
    // let a few frames render first (software rendering is slow)
    await G(() => new Promise((res) => {
      let k = 0;
      const f = () => (++k >= 3 ? res() : requestAnimationFrame(f));
      requestAnimationFrame(f);
    }));
    const file = join(outDir, `${mode}-${name}.png`);
    await page.screenshot({ path: file });
    log(`screenshot ${name}`);
  };
  const waitFor = async (what, fn, arg, timeout = STEP_TIMEOUT) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 250 });
    } catch {
      throw new StepError(`timed out waiting for ${what}`);
    }
  };
  const check = (cond, msg) => {
    if (!cond) throw new StepError(msg);
  };
  const cellId = (c) => G((c) => window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023, c);
  /** Point the view at the centre of a cell (from the player's eyes). */
  const aimAt = (c) =>
    G((c) => {
      const g = window.__blocklands.game;
      const p = g.sim.player;
      const dx = c.x + 0.5 - p.pos.x;
      const dy = c.y + 0.5 - (p.pos.y + p.eyeHeight);
      const dz = c.z + 0.5 - p.pos.z;
      g.debug.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, c);
  /** Wait one simulation tick so sim.view reflects the current look direction. */
  const nextTick = async () => {
    const t = await G(() => window.__blocklands.game.sim.world.time);
    await waitFor('a simulation tick', (t) => window.__blocklands.game.sim.world.time > t + 1, t);
  };
  const center = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  /** Does cell c intersect the player's body (placing there would be refused)? */
  const touchesPlayer = (c, p) =>
    c.x < p.x + 0.35 && c.x + 1 > p.x - 0.35 && c.z < p.z + 0.35 && c.z + 1 > p.z - 0.35 && c.y < p.y + 1.85 && c.y + 1 > p.y - 0.05;
  /**
   * Right-click at the crosshair with planks in hand, trying a few look directions until a
   * block appears; returns the cell that became planks.
   */
  const placeBlock = async (aims) => {
    for (const [yaw, pitch] of aims) {
      await G(([y, p]) => window.__blocklands.game.debug.look(y, p), [yaw, pitch]);
      await nextTick();
      const st = await state();
      const t = st.target;
      if (!t || t.gridId !== 0) continue;
      const d = DIRS[t.face];
      const candidates = [{ x: t.x, y: t.y, z: t.z }, { x: t.x + d[0], y: t.y + d[1], z: t.z + d[2] }];
      if (candidates.some((c) => touchesPlayer(c, st.player))) continue;
      await page.mouse.click(center.x, center.y, { button: 'right' });
      try {
        await page.waitForFunction(
          ([cs, id]) => cs.some((c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === id),
          [candidates, PLANKS],
          { timeout: 8000, polling: 250 },
        );
      } catch {
        log(`no block appeared looking at ${t.x} ${t.y} ${t.z} (face ${t.face}); trying another spot`);
        continue;
      }
      for (const c of candidates) if ((await cellId(c)) === PLANKS) return c;
    }
    throw new StepError('could not place a block anywhere in front of the player');
  };
  const AIMS = [
    [0, -0.6],
    [0.7, -0.6],
    [-0.7, -0.6],
    [1.6, -0.55],
    [-1.6, -0.55],
    [Math.PI, -0.6],
  ];

  let result = 'PASS';
  let persistent = false;
  let reloaded = 'skipped';
  try {
    await page.goto(pageUrl, { timeout: 60_000 });
    // A dev server may reload the page once while it boots (dependency optimisation, HMR):
    // only start once the page has been quiet for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 30_000 });
        await page.waitForFunction(() => !!window.__blocklands, undefined, { timeout: 60_000 });
        await page.waitForTimeout(500);
        if (await G(() => !!window.__blocklands)) break;
      } catch (e) {
        if (attempt >= 2) throw new StepError(`the game did not boot: ${e.message}`);
      }
    }
    await G((rd) => window.__blocklands.game.changeSettings({ renderDistance: rd, showDebug: true }), RENDER_DISTANCE);
    await waitFor('the main menu', () => window.__blocklands.game.screen === 'mainMenu');
    await page.waitForTimeout(500);
    await shot('01-menu');

    // ---- create a world from the menu
    await page.fill('.bl-newworld input[type="text"] >> nth=0', 'Smoke');
    await page.fill('.bl-newworld .bl-num-input', SEED);
    await page.click('.bl-newworld .bl-form-submit');
    await waitFor('the loading screen', () => window.__blocklands.game.screen === 'loading', undefined, 10_000);
    await shot('02-loading');
    const tLoad = Date.now();
    await waitFor(
      'loading to finish',
      () => {
        const s = window.__blocklands.game.debug.state();
        return s.sessionState === 'ready' && s.screen === 'none';
      },
      undefined,
      LOAD_TIMEOUT,
    );
    let st = await state();
    persistent = st.storagePersistent;
    log(`loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s: ${st.chunks} chunks, ${st.sectionsMeshed} sections meshed, renderer ${st.renderer} (${st.rendererDetail}), storage ${persistent ? 'IndexedDB' : 'memory'}, workers ${st.workers.terrain}/${st.workers.mesh}`);
    check(st.chunks >= 49, `expected at least 49 chunks around the player, got ${st.chunks}`);
    check(st.sectionsMeshed >= 200, `expected at least 200 meshed sections, got ${st.sectionsMeshed}`);
    check(st.sectionsDrawn > 0, 'the renderer has no section meshes');
    check(st.renderer === (mode === 'webgpu' ? 'webgpu' : 'webgl2'), `renderer API is ${st.renderer}, expected ${mode === 'webgpu' ? 'webgpu' : 'webgl2'}`);
    check(st.player && !st.player.dead, 'no live player');
    await shot('03-ready');

    // ---- engage (pointer lock or drag-to-look) and walk
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(1000);
    st = await state();
    log(`input: ${st.pointerLocked ? 'pointer locked' : st.dragLook ? 'drag-to-look' : 'not locked'}`);
    await G(() => window.__blocklands.game.debug.look(0, -0.1));
    const p0 = st.player;
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);
    const p1 = (await state()).player;
    const walked = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    log(`walked ${walked.toFixed(2)} blocks`);
    check(walked > 1, `the player did not walk (moved ${walked.toFixed(2)})`);
    await shot('04-walked');

    // ---- place a block, break it, place a second one to keep
    await G((id) => window.__blocklands.game.debug.give(id), PLANKS);
    const first = await placeBlock(AIMS);
    log(`placed planks at ${first.x} ${first.y} ${first.z}`);
    await shot('05-placed');
    await aimAt(first);
    await nextTick();
    const tgt = (await state()).target;
    check(tgt && tgt.x === first.x && tgt.y === first.y && tgt.z === first.z, 'cannot target the placed block');
    await page.mouse.click(center.x, center.y, { button: 'left' });
    await waitFor('the block to break', ([c, id]) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) !== id, [first, PLANKS]);
    log(`broke it (cell is now ${await cellId(first)})`);
    await shot('06-broken');
    const kept = await placeBlock(AIMS.slice(1).concat([AIMS[0]]));
    log(`placed planks to keep at ${kept.x} ${kept.y} ${kept.z}`);

    // ---- inventory
    await page.keyboard.press('KeyE');
    await waitFor('the inventory', () => window.__blocklands.game.screen === 'inventory');
    await shot('07-inventory');
    await page.keyboard.press('KeyE');
    await waitFor('the inventory to close', () => window.__blocklands.game.screen === 'none');

    // ---- pause + resume
    await page.waitForTimeout(1200); // Chrome refuses a re-lock right after an exit
    await page.keyboard.press('Escape');
    await waitFor('the pause menu', () => window.__blocklands.game.screen === 'pause');
    const ticksPaused = await G(() => window.__blocklands.game.sim.world.time);
    await page.waitForTimeout(600);
    check((await G(() => window.__blocklands.game.sim.world.time)) === ticksPaused, 'the simulation kept ticking while paused');
    await shot('08-pause');
    await page.click('.bl-screen[data-screen="pause"] .bl-btn--primary');
    await waitFor('play to resume', () => window.__blocklands.game.screen === 'none');

    // ---- save & quit
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await waitFor('the pause menu', () => window.__blocklands.game.screen === 'pause');
    const worldId = (await state()).worldId;
    await page.click('.bl-screen[data-screen="pause"] .bl-btn--danger');
    await waitFor('the main menu after saving', () => window.__blocklands.game.screen === 'mainMenu', undefined, 60_000);
    await waitFor('the saved world in the list', (id) => !!document.querySelector(`.bl-world[data-id="${id}"]`), worldId);
    await shot('09-menu-after-quit');

    // ---- load it again
    await page.click(`.bl-world[data-id="${worldId}"] [data-act="play"]`);
    await waitFor(
      'the world to load again',
      () => {
        const s = window.__blocklands.game.debug.state();
        return s.sessionState === 'ready' && s.screen === 'none';
      },
      undefined,
      LOAD_TIMEOUT,
    );
    await waitFor('the block area to load', (c) => window.__blocklands.game.debug.cell(c.x, c.y, c.z) !== 1023, kept);
    const keptId = await cellId(kept);
    if (persistent) {
      check(keptId === PLANKS, `the placed block did not persist (cell ${keptId})`);
      reloaded = 'block persisted';
    } else {
      // Memory storage still keeps the world for this page.
      reloaded = keptId === PLANKS ? 'block persisted (memory storage)' : `memory storage, cell ${keptId}`;
    }
    log(`reloaded: ${reloaded}`);
    await aimAt(kept);
    await nextTick();
    await shot('10-reloaded');

    st = await state();
    if (st.faults.length > 0) problems.push(...st.faults.map((f) => `game fault: ${f}`));
    log(`fps ${st.stats.fps.toFixed(1)}, tick ${st.stats.tickMs.toFixed(2)} ms, render ${st.stats.renderMs.toFixed(1)} ms`);
  } catch (e) {
    result = 'FAIL';
    problems.push(e instanceof StepError ? e.message : `${e.name}: ${e.message}`);
    await page.screenshot({ path: join(outDir, `${mode}-99-failure.png`) }).catch(() => undefined);
  } finally {
    listening = false;
    await browser.close().catch(() => undefined);
    xvfb?.stop();
  }
  if (hostRequests) {
    const extra = hostRequests.filter((r) => r !== '/' && r !== '/index.html' && r !== '/favicon.ico');
    if (extra.length > 0) problems.push(`the page made network requests: ${[...new Set(extra)].join(', ')}`);
    hostRequests.length = 0;
  }
  if (problems.length > 0) result = 'FAIL';
  return { mode, result, problems, steps, reloaded, seconds: (Date.now() - t0) / 1000 };
}

// ------------------------------------------------------------------ main

let host = null;
let pageUrl = url;
if (!pageUrl) {
  if (build) {
    console.log('building the single-file artifact (npm run build:artifact) ...');
    const r = spawnSync('npm', ['run', 'build:artifact'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('build failed');
      process.exit(1);
    }
  }
  if (!existsSync(ARTIFACT)) {
    console.error(`${ARTIFACT} does not exist (run npm run build:artifact)`);
    process.exit(1);
  }
  host = await startHost(ARTIFACT);
  pageUrl = host.url;
}
console.log(`testing ${pageUrl}`);

const modes = only ? [only] : ['webgl', 'webgpu'];
const results = [];
for (const mode of modes) {
  console.log(`\n== ${mode}`);
  results.push(await runMode(mode, pageUrl, host ? host.requests : null));
}
await host?.close();

console.log('\n== summary');
let failed = false;
for (const r of results) {
  console.log(`${r.result}  ${r.mode.padEnd(6)}  ${r.seconds.toFixed(0)}s  reload: ${r.reloaded}`);
  for (const p of r.problems) console.log(`      - ${p}`);
  if (r.result !== 'PASS') failed = true;
}
console.log(`screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
