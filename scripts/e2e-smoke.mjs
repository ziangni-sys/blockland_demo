#!/usr/bin/env node
// End-to-end smoke test of the browser game (Playwright + Chromium): the real game, which runs its
// world in the game server Worker and plays it through the network client (NETCODE package 9).
//
//   node scripts/e2e-smoke.mjs [url] [--out DIR] [--no-build] [--only webgl|webgpu|normal|sandboxed]
//
// Without a URL it builds (npm run build and npm run build:artifact) and runs four
// configurations, each from a tiny static server on 127.0.0.1:
//  - webgl:     the single-file artifact (dist-artifact/blocklands.html wrapped in a minimal
//               document, the way the publishing host serves it), default flags (WebGL2 through
//               SwiftShader); the page must make no network request at all;
//  - webgpu:    the same with real WebGPU on SwiftShader's software adapter. Headless Chromium
//               cannot present a WebGPU canvas in this kind of container, so this run uses a headed
//               browser on a virtual X display (Xvfb) when no DISPLAY is set and Xvfb is installed;
//  - normal:    the normal static site (dist/, served as files), WebGL2;
//  - sandboxed: the artifact inside <iframe sandbox="allow-scripts"> (an opaque origin: module
//               workers from blob URLs are refused, so the server Worker starts from a data: URL;
//               no IndexedDB, so the world lives in the page's memory storage and the game must say
//               it cannot save; it can still be reopened while the page is open).
// With a URL (e.g. the dev server) it runs the webgl and webgpu scenarios on that page.
//
// Scenario: create a creative world from the main menu with a fixed seed, wait for the loading
// screen to go, check the replica's columns and meshes, the renderer API and how the server runs
// (a Worker; a data: URL Worker in the sandbox), walk, place + break a block, place a second one,
// open + close the inventory, pause (the server stops ticking) + resume, save & quit, load the world
// again and check the second block is still there (in IndexedDB; in the sandbox, in the page's
// memory storage), then make the server Worker fail and check the world stops behind the pause
// screen and "Quit without saving" leaves it. Any other console error, page error or failed
// request fails the run. Screenshots of every stage go to --out (default: a
// fresh temp directory, printed at the end).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = join(ROOT, 'dist-artifact', 'blocklands.html');
const DIST = join(ROOT, 'dist');
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
const MODES = ['webgl', 'webgpu', 'normal', 'sandboxed'];

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
    console.log('usage: node scripts/e2e-smoke.mjs [url] [--out DIR] [--no-build] [--only webgl|webgpu|normal|sandboxed]');
    process.exit(0);
  } else if (!a.startsWith('--')) url = a;
  else {
    console.error(`unknown option ${a}`);
    process.exit(2);
  }
}
if (only !== null && !MODES.includes(only)) {
  console.error(`--only takes one of ${MODES.join(', ')}`);
  process.exit(2);
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

// ------------------------------------------------------------------ static hosts

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Serves `page(url)` for a request, or 404; records every request. */
function serve(page) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/favicon.ico') {
      // A headed browser asks for the top-level document's icon by itself; that is the host
      // page's business, not a request made by the game.
      res.writeHead(204);
      res.end();
      return;
    }
    const body = page(req.url);
    if (body === null) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
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

/** The artifact fragment wrapped like the publishing host does. */
function artifactPage() {
  const fragment = readFileSync(ARTIFACT, 'utf8');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    `</head><body>${fragment}</body></html>`
  );
}

function artifactSite() {
  const page = artifactPage();
  return serve((u) => (u === '/' || u === '/index.html' ? { type: TYPES['.html'], data: page } : null));
}

function normalSite() {
  return serve((u) => {
    const path = u.split('?')[0] === '/' ? '/index.html' : u.split('?')[0];
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST) || !existsSync(file)) return null;
    return { type: TYPES[extname(file)] ?? 'application/octet-stream', data: readFileSync(file) };
  });
}

/** The artifact at /game.html inside a sandboxed iframe (an opaque origin) of the page at /. */
function sandboxedSite() {
  const page = artifactPage();
  const outer =
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
    '<iframe sandbox="allow-scripts" src="/game.html" style="border:0;width:100vw;height:100vh"></iframe></body></html>';
  return serve((u) => (u === '/' ? { type: TYPES['.html'], data: outer } : u === '/game.html' ? { type: TYPES['.html'], data: page } : null));
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

async function runMode(mode, site) {
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const steps = [];
  const problems = [];
  const sandboxed = mode === 'sandboxed';
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
  // The name is asked once on a page that can go online (package 11); this script plays alone.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('playerName', 'Smoke');
    } catch {
      // an opaque origin has no storage (and no name screen: it cannot go online)
    }
  });
  const page = await context.newPage();
  let listening = true;
  /** Errors a step provokes on purpose (the server failure below). */
  let expectedErrors = null;
  page.on('console', (m) => {
    if (!listening || m.type() !== 'error') return;
    // The sandbox has no allow-pointer-lock on purpose: Chromium reports the refused lock itself,
    // and the game switches to drag-to-look (checked below).
    if (sandboxed && /^Blocked pointer lock .* sandboxed/.test(m.text())) return;
    if (expectedErrors?.test(m.text())) return;
    problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    if (listening && !expectedErrors?.test(e.message)) problems.push(`page error: ${e.message}`);
  });
  page.on('requestfailed', (r) => {
    if (listening && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) problems.push(`request failed: ${r.url()}`);
  });

  /** The game's frame (the iframe in the sandbox). */
  let frame = page.mainFrame();
  const G = (fn, arg) => frame.evaluate(fn, arg);
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
      await frame.waitForFunction(fn, arg, { timeout, polling: 250 });
    } catch {
      throw new StepError(`timed out waiting for ${what}`);
    }
  };
  const check = (cond, msg) => {
    if (!cond) throw new StepError(msg);
  };
  const cellId = (c) => G((c) => window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023, c);
  /** Point the view at the centre of a cell (from the player's eyes as shown). */
  const aimAt = (c) =>
    G((c) => {
      const g = window.__blocklands.game;
      const p = g.debug.state().player;
      const dx = c.x + 0.5 - p.shownX;
      const dy = c.y + 0.5 - (p.shownY + p.eyeHeight);
      const dz = c.z + 0.5 - p.shownZ;
      g.debug.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, c);
  /** Let a few frames pass (animation frames: software WebGPU can take a second each) so the targets follow the look. */
  const settle = () =>
    G(() => new Promise((res) => {
      let k = 0;
      const f = () => (++k >= 3 ? setTimeout(res, 100) : requestAnimationFrame(f));
      requestAnimationFrame(f);
    }));
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
      await settle();
      const st = await state();
      const t = st.target;
      if (!t || t.gridId !== 0) continue;
      const d = DIRS[t.face];
      const candidates = [{ x: t.x, y: t.y, z: t.z }, { x: t.x + d[0], y: t.y + d[1], z: t.z + d[2] }];
      if (candidates.some((c) => touchesPlayer(c, st.player))) continue;
      await page.mouse.click(center.x, center.y, { button: 'right' });
      try {
        await frame.waitForFunction(
          ([cs, id]) => cs.some((c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === id),
          [candidates, PLANKS],
          { timeout: 15_000, polling: 250 },
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
    await page.goto(site.url, { timeout: 60_000 });
    if (sandboxed) {
      const deadline = Date.now() + 30_000;
      let f = null;
      while ((f = page.frames().find((x) => x.url().endsWith('/game.html')) ?? null) === null && Date.now() < deadline) await page.waitForTimeout(100);
      if (f === null) throw new StepError('the sandboxed frame never appeared');
      frame = f;
    }
    // A dev server may reload the page once while it boots (dependency optimisation, HMR):
    // only start once the page has been quiet for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 30_000 });
        await frame.waitForFunction(() => !!window.__blocklands, undefined, { timeout: 60_000 });
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
    await frame.fill('.bl-newworld input[type="text"] >> nth=0', 'Smoke');
    await frame.fill('.bl-newworld .bl-num-input', SEED);
    await frame.click('.bl-newworld .bl-form-submit');
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
    persistent = st.worldPersistent === true;
    log(
      `loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s: ${st.chunks} columns, ${st.sectionsMeshed} sections meshed, renderer ${st.renderer} (${st.rendererDetail}), ` +
        `server ${st.workers.server}, world storage ${persistent ? 'IndexedDB' : 'memory'}, workers ${st.workers.terrain}/${st.workers.mesh}, net ${st.netStatus}`,
    );
    check(st.chunks >= 49, `expected at least 49 columns around the player, got ${st.chunks}`);
    check(st.sectionsMeshed >= 200, `expected at least 200 meshed sections, got ${st.sectionsMeshed}`);
    check(st.sectionsDrawn > 0, 'the renderer has no section meshes');
    check(st.renderer === (mode === 'webgpu' ? 'webgpu' : 'webgl2'), `renderer API is ${st.renderer}, expected ${mode === 'webgpu' ? 'webgpu' : 'webgl2'}`);
    check(st.player && !st.player.dead, 'no live player');
    check(st.netStatus === 'ready', `the network client is ${st.netStatus}`);
    check(st.workers.server === (sandboxed ? 'worker (data URL)' : 'worker'), `the server runs as ${st.workers.server}`);
    check(st.inventory && st.inventory.hotbar.filter((x) => x !== null).length === 9, 'the starter items are not in the hotbar');
    if (sandboxed) {
      check(!persistent && !st.storagePersistent, 'the sandbox has no IndexedDB: the world must be in memory');
      const said = await G(() => window.__blocklands.game.toasts.list.some((t) => /not be saved|不会被保存/.test(t.text)));
      check(said, 'the game did not say that it cannot save');
    } else {
      check(persistent, 'the world storage is not persistent');
    }
    await shot('03-ready');

    // ---- engage (pointer lock or drag-to-look) and walk
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(1000);
    st = await state();
    log(`input: ${st.pointerLocked ? 'pointer locked' : st.dragLook ? 'drag-to-look' : 'not locked'}`);
    if (sandboxed) check(st.dragLook, 'the pointer cannot be locked in the sandbox: the game must look by dragging');
    await G(() => window.__blocklands.game.debug.look(0, -0.1));
    const p0 = st.player;
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);
    const p1 = (await state()).player;
    const walked = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    log(`walked ${walked.toFixed(2)} blocks`);
    check(walked > 1, `the player did not walk (moved ${walked.toFixed(2)})`);
    await shot('04-walked');

    // ---- place a block, break it, place a second one to keep (planks: the first starter slot)
    await page.keyboard.press('Digit1');
    await waitFor('planks in hand', (id) => window.__blocklands.game.debug.state().inventory.hotbar[window.__blocklands.game.debug.state().inventory.selected]?.item === id, PLANKS);
    const first = await placeBlock(AIMS);
    log(`placed planks at ${first.x} ${first.y} ${first.z}`);
    await shot('05-placed');
    await aimAt(first);
    await settle();
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

    // ---- pause + resume: the server stops ticking
    await page.waitForTimeout(1200); // Chrome refuses a re-lock right after an exit
    await page.keyboard.press('Escape');
    await waitFor('the pause menu', () => window.__blocklands.game.screen === 'pause');
    // The batches already on their way are applied in the next frames; then nothing more comes.
    await page.waitForTimeout(400);
    await settle();
    const ticksPaused = (await state()).worldTime;
    await page.waitForTimeout(800);
    await settle();
    check((await state()).worldTime === ticksPaused, 'the server kept ticking while paused');
    await shot('08-pause');
    await frame.click('.bl-screen[data-screen="pause"] .bl-btn--primary');
    await waitFor('play to resume', () => window.__blocklands.game.screen === 'none');
    await waitFor('the server to tick again', (t) => window.__blocklands.game.debug.state().worldTime > t + 5, ticksPaused);

    // ---- save & quit
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await waitFor('the pause menu', () => window.__blocklands.game.screen === 'pause');
    const worldId = (await state()).worldId;
    await frame.click('.bl-screen[data-screen="pause"] .bl-btn--danger');
    await waitFor('the main menu after saving', () => window.__blocklands.game.screen === 'mainMenu', undefined, 60_000);
    check((await state()).workers.server === '—', 'the server is still running after save & quit');
    // The world stays in the list in both cases: in IndexedDB, or (sandboxed, no IndexedDB) in the
    // page's memory storage, where its server saved it, until the page closes.
    await waitFor('the saved world in the list', (id) => !!document.querySelector(`.bl-world[data-id="${id}"]`), worldId);
    await shot('09-menu-after-quit');
    // ---- load it again
    await frame.click(`.bl-world[data-id="${worldId}"] [data-act="play"]`);
    await waitFor(
      'the world to load again',
      () => {
        const s = window.__blocklands.game.debug.state();
        return s.sessionState === 'ready' && s.screen === 'none';
      },
      undefined,
      LOAD_TIMEOUT,
    );
    check((await state()).worldPersistent === persistent, `the reloaded world's storage is not ${persistent ? 'IndexedDB' : 'memory'}`);
    await waitFor('the block area to load', (c) => window.__blocklands.game.debug.cell(c.x, c.y, c.z) !== -1, kept);
    const keptId = await cellId(kept);
    check(keptId === PLANKS, `the placed block was not kept (cell ${keptId})`);
    reloaded = persistent ? 'block persisted' : 'block kept in memory storage for this page';
    log(`reloaded: ${reloaded}`);
    await aimAt(kept);
    await settle();
    await shot('10-reloaded');

    // ---- the server fails (an uncaught error in its Worker): the world stops behind the pause
    // screen, which says so and cannot resume; "Quit without saving" closes the world.
    let serverWorker = null;
    for (const w of page.workers()) {
      try {
        if ((await w.evaluate(() => self.name)) === 'blocklands-server') serverWorker = w;
      } catch {
        // a worker that is gone or cannot be evaluated
      }
    }
    if (serverWorker === null) {
      log('the server Worker cannot be reached from the test here: server-failure step skipped');
    } else {
      expectedErrors = /injected server failure|the game server stopped/;
      await serverWorker.evaluate(() => {
        setTimeout(() => {
          throw new Error('e2e: injected server failure');
        }, 0);
      });
      await waitFor('the stopped world on the pause screen', () => {
        const s = window.__blocklands.game.debug.state();
        return s.screen === 'pause' && s.stopped === true;
      });
      // The UI follows the game state at its next frame.
      const said = await frame
        .waitForSelector('.bl-screen[data-screen="pause"] .bl-pause-stopped', { state: 'visible', timeout: STEP_TIMEOUT })
        .then(() => true, () => false);
      check(said, 'the pause screen does not say that the world stopped');
      check(!(await frame.isVisible('.bl-screen[data-screen="pause"] .bl-btn--primary')), 'a stopped world still offers Resume');
      await page.waitForTimeout(400);
      await settle();
      const stoppedAt = (await state()).worldTime;
      await page.waitForTimeout(800);
      await settle();
      check((await state()).worldTime === stoppedAt, 'the stopped world kept ticking');
      await shot('11-server-failed');
      await frame.click('.bl-screen[data-screen="pause"] .bl-pause-unsaved button');
      await waitFor('the main menu after quitting the stopped world', () => window.__blocklands.game.screen === 'mainMenu');
      check((await state()).workers.server === '—', 'the failed server is still there after quitting');
      expectedErrors = null;
      log('server failure: the world stopped on the pause screen, quit without saving went back to the menu');
    }

    st = await state();
    if (st.faults.length > 0) problems.push(...st.faults.map((f) => `game fault: ${f}`));
    log(`fps ${st.stats.fps.toFixed(1)}, frame ${st.stats.frameMs.toFixed(1)} ms, render ${st.stats.renderMs.toFixed(1)} ms`);
  } catch (e) {
    result = 'FAIL';
    problems.push(e instanceof StepError ? e.message : `${e.name}: ${e.message}`);
    await page.screenshot({ path: join(outDir, `${mode}-99-failure.png`) }).catch(() => undefined);
  } finally {
    listening = false;
    await browser.close().catch(() => undefined);
    xvfb?.stop();
  }
  if (site.requests && mode !== 'normal') {
    const extra = site.requests.filter((r) => r !== '/' && r !== '/index.html' && r !== '/game.html' && r !== '/favicon.ico');
    if (extra.length > 0) problems.push(`the page made network requests: ${[...new Set(extra)].join(', ')}`);
  }
  if (problems.length > 0) result = 'FAIL';
  return { mode, result, problems, steps, reloaded, seconds: (Date.now() - t0) / 1000 };
}

// ------------------------------------------------------------------ main

if (!url && build) {
  for (const script of ['build', 'build:artifact']) {
    console.log(`npm run ${script}`);
    const r = spawnSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('build failed');
      process.exit(1);
    }
  }
}

const modes = only ? [only] : url ? ['webgl', 'webgpu'] : MODES;
const results = [];
for (const mode of modes) {
  console.log(`\n== ${mode}`);
  let site;
  if (url) site = { url, requests: null, close: async () => undefined };
  else if (mode === 'normal') site = await normalSite();
  else if (mode === 'sandboxed') site = await sandboxedSite();
  else site = await artifactSite();
  try {
    console.log(`testing ${site.url}`);
    results.push(await runMode(mode, site));
  } finally {
    await site.close();
  }
}

console.log('\n== summary');
let failed = false;
for (const r of results) {
  console.log(`${r.result}  ${r.mode.padEnd(9)}  ${r.seconds.toFixed(0)}s  reload: ${r.reloaded}`);
  for (const p of r.problems) console.log(`      - ${p}`);
  if (r.result !== 'PASS') failed = true;
}
console.log(`screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
