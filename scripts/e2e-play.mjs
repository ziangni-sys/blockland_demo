#!/usr/bin/env node
// A scripted play session of the browser game in a real browser (Playwright + Chromium): what a
// person does in a first session, through the real input (keys, mouse buttons) and the real UI,
// with the world in the game server Worker and the client playing it through the network client
// (NETCODE package 9). Debug helpers on window.__blocklands only point the view, teleport (a host
// command) and read the state.
//
//   node scripts/e2e-play.mjs [--build normal|artifact] [--renderer webgl2|default] [--out DIR] [--no-build]
//
// Without --build / --renderer it runs both builds (the normal static site, and the single-file
// artifact wrapped like the publishing host does) with both renderers (#webgl2, and the default,
// WebGPU on SwiftShader through a headed browser on Xvfb). Steps: new world; walk, jump, swim;
// mine and place; glue a face and build onto it; off-hand glue; pick block; half slabs (debug.slab):
// walk up onto them and down again, mine one part of a two-part cell (the other stays), a small
// ship of half slabs assembled at its helm floats and docks again; the example boat:
// start the windmill, assemble at the helm, sail, turn, third-person views while sailing, open the
// inventory at the helm, take the wheel again, dock; pause for ten seconds (nothing moves); switch
// to survival, take fall damage, die, respawn; save and quit; reload the page; load the world:
// everything is where it was. Console errors and page errors fail the run; a screenshot of every
// step goes to --out.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 960, height: 540 };
const SEED = 'play-session';
// The software renderers of a busy container draw a frame or two a second at larger distances.
const RENDER_DISTANCE = 4;
const B = { PLANKS: 10, COBBLE: 2, HELM: 50, BEARING: 51 };
const GLUE = 1024;
const PY = 2;
const PX = 0;
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader'];

const argv = process.argv.slice(2);
let builds = ['normal', 'artifact'];
let renderers = ['webgl2', 'default'];
let outDir = null;
let doBuild = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--build') builds = [argv[++i]];
  else if (a === '--renderer') renderers = [argv[++i]];
  else if (a === '--out') outDir = argv[++i];
  else if (a === '--no-build') doBuild = false;
  else {
    console.error('usage: node scripts/e2e-play.mjs [--build normal|artifact] [--renderer webgl2|default] [--out DIR] [--no-build]');
    process.exit(2);
  }
}
outDir = resolve(outDir ?? mkdtempSync(join(tmpdir(), 'blocklands-play-')));
mkdirSync(outDir, { recursive: true });

function loadPlaywright() {
  for (const dir of [ROOT, ...(process.env.NODE_PATH ?? '').split(':').filter(Boolean), '/opt/node-tools/node_modules']) {
    try {
      return createRequire(join(dir, 'noop.js'))('playwright');
    } catch {
      // next
    }
  }
  console.error('playwright is not installed');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
function serve(page) {
  const server = createServer((req, res) => {
    const body = page(req.url);
    if (body === null) {
      res.writeHead(req.url === '/favicon.ico' ? 204 : 404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': body.type, 'cache-control': 'no-store' });
    res.end(body.data);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(() => r())) })));
}
function site(build) {
  if (build === 'artifact') {
    const page =
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>' +
      readFileSync(join(ROOT, 'dist-artifact', 'blocklands.html'), 'utf8') +
      '</body></html>';
    return serve((u) => (u.split('#')[0] === '/' ? { type: TYPES['.html'], data: page } : null));
  }
  const dist = join(ROOT, 'dist');
  return serve((u) => {
    const path = u.split('?')[0] === '/' ? '/index.html' : u.split('?')[0];
    const file = normalize(join(dist, path));
    if (!file.startsWith(dist) || !existsSync(file)) return null;
    return { type: TYPES[extname(file)] ?? 'application/octet-stream', data: readFileSync(file) };
  });
}

async function startXvfb() {
  const r = spawnSync('sh', ['-c', 'command -v Xvfb'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  for (let n = 140; n < 180; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const proc = spawn(r.stdout.trim(), [`:${n}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    for (let t = 0; t < 100; t++) {
      if (existsSync(`/tmp/.X11-unix/X${n}`)) return { display: `:${n}`, stop: () => proc.kill('SIGTERM') };
      await new Promise((res) => setTimeout(res, 50));
    }
    proc.kill('SIGTERM');
  }
  return null;
}

class StepError extends Error {}

async function session(build, renderer) {
  const name = `${build}-${renderer}`;
  const t0 = Date.now();
  const problems = [];
  const log = (m) => console.log(`  [${name}] ${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
  let xvfb = null;
  const launch = { args: renderer === 'default' ? WEBGPU_FLAGS : [] };
  if (renderer === 'default' && !process.env.DISPLAY) {
    xvfb = await startXvfb();
    if (xvfb) {
      launch.headless = false;
      launch.env = { ...process.env, DISPLAY: xvfb.display };
    }
  }
  const host = await site(build);
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: VIEWPORT });
  // The name is asked once on a page that can go online (package 11); this script plays alone.
  await context.addInitScript(() => localStorage.setItem('playerName', 'Player One'));
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`console error: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const G = (fn, arg) => page.evaluate(fn, arg);
  const state = () => G(() => window.__blocklands.game.debug.state());
  const check = (cond, msg) => {
    if (!cond) throw new StepError(msg);
  };
  const frames = (n = 3) =>
    G((n) => new Promise((res) => {
      let k = 0;
      const f = () => (++k >= n ? setTimeout(res, 50) : requestAnimationFrame(f));
      requestAnimationFrame(f);
    }), n);
  let shotN = 0;
  const shot = async (what) => {
    await frames(3);
    const file = join(outDir, `${name}-${String(++shotN).padStart(2, '0')}-${what}.png`);
    await page.screenshot({ path: file });
    log(`screenshot ${what}`);
  };
  const waitFor = async (what, fn, arg, timeout = 60_000) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 200 });
    } catch {
      throw new StepError(`timed out waiting for ${what}`);
    }
  };
  /**
   * Hold `keys` until `cond()` (polled in Node) holds, then let go; a StepError naming `what` after
   * `timeout`. The software renderers of a busy container can draw one frame a second, so nothing
   * here waits a fixed time for something to happen.
   */
  const holdUntil = async (keys, cond, what, timeout = 60_000, pollMs = 150) => {
    for (const k of keys) await page.keyboard.down(k);
    const end = Date.now() + timeout;
    let ok = false;
    try {
      while (!(ok = await cond()) && Date.now() < end) await page.waitForTimeout(pollMs);
    } finally {
      for (const k of keys) await page.keyboard.up(k);
    }
    if (!ok) throw new StepError(`timed out holding ${keys.join('+')} for ${what}`);
  };
  /** Poll `cond()` (in Node) until it holds; a StepError naming `what` after `timeout`. */
  const until = async (cond, what, timeout = 60_000, pollMs = 250) => {
    const end = Date.now() + timeout;
    while (!(await cond())) {
      if (Date.now() >= end) throw new StepError(`timed out waiting for ${what}`);
      await page.waitForTimeout(pollMs);
    }
  };
  const center = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  /**
   * Engage the game (pointer lock, or drag-to-look) with a click on the canvas, unless it already
   * is: closing a screen asks for the lock again by itself, and a click with the pointer locked is
   * a left click that mines (at once in creative).
   */
  const engage = async () => {
    await page.waitForTimeout(800);
    if (await G(() => window.__blocklands.game.pointerLocked)) return;
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(500);
  };
  const click = async (button) => {
    await page.mouse.click(center.x, center.y, { button });
    await frames(2);
  };
  /** Point the view at a cell of a grid (0 = the world), at a face's centre when given. */
  const aim = async (c, face = -1, gridId = 0) => {
    await G(([c, face, gridId]) => {
      const g = window.__blocklands.game;
      const r = g.session.replica;
      const grid = gridId === 0 ? r.world : r.state.structures.get(gridId).structure.grid;
      const D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const off = face >= 0 ? D[face] : [0, 0, 0];
      const w = grid.toWorld({ x: c.x + 0.5 + off[0] * 0.45, y: c.y + 0.5 + off[1] * 0.45, z: c.z + 0.5 + off[2] * 0.45 }, { x: 0, y: 0, z: 0 });
      const p = g.debug.state().player;
      const dx = w.x - p.shownX;
      const dy = w.y - (p.shownY + p.eyeHeight);
      const dz = w.z - p.shownZ;
      g.debug.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, [c, face, gridId]);
    await frames(3);
    return (await state()).target;
  };
  /** Aim at some part of a cell: its centre, then each face's centre, until it is the target (a model block such as the helm is not a full cube). */
  const aimAny = async (c, gridId = 0) => {
    for (const face of [-1, 0, 1, 2, 3, 4, 5]) if (onTarget(await aim(c, face, gridId), c, -1, gridId)) return true;
    return false;
  };
  const onTarget = (t, c, face = -1, gridId = 0) => t && t.gridId === gridId && t.x === c.x && t.y === c.y && t.z === c.z && (face < 0 || t.face === face);
  const cell = (c) => G((c) => window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023, c);
  const glueAt = (c, face) => G(([c, face]) => window.__blocklands.game.session.replica.worldGlue.has(c.x, c.y, c.z, face), [c, face]);
  const teleport = async (x, y, z) => {
    await G(([x, y, z]) => window.__blocklands.game.debug.teleport(x, y, z), [x, y, z]);
    await waitFor(`the player at ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`, ([x, z]) => {
      const p = window.__blocklands.game.debug.state().player;
      return p !== null && Math.hypot(p.x - x, p.z - z) < 0.6 && window.__blocklands.game.debug.state().sessionState === 'ready';
    }, [x, z], 60_000);
    await frames(3);
  };
  const selectItem = async (item) => {
    const st = await state();
    const idx = st.inventory.hotbar.findIndex((s) => s !== null && s.item === item);
    check(idx >= 0, `no ${item} in the hotbar`);
    await page.keyboard.press(`Digit${idx + 1}`);
    await waitFor(`item ${item} in hand`, (item) => {
      const inv = window.__blocklands.game.debug.state().inventory;
      return inv.hotbar[inv.selected]?.item === item;
    }, item);
  };
  // Playing: loaded, no screen, and the prediction placed the player (the debug state has no player
  // before the first client tick after loading, which a page drawing a frame a second can take a second to run).
  const playing = (fn) => waitFor('play', () => {
    const s = window.__blocklands.game.debug.state();
    return s.sessionState === 'ready' && s.screen === 'none' && s.player !== null;
  }, undefined, 240_000);

  let result = 'PASS';
  const world = {};
  try {
    await page.goto(host.url + (renderer === 'webgl2' ? '#webgl2' : ''));
    await page.waitForFunction(() => window.__blocklands?.game?.screen === 'mainMenu', undefined, { timeout: 60_000 });
    await G((rd) => window.__blocklands.game.changeSettings({ renderDistance: rd, showDebug: true }), RENDER_DISTANCE);
    await page.waitForTimeout(500);

    // ---- new world
    await page.fill('.bl-newworld input[type="text"] >> nth=0', 'Play');
    await page.fill('.bl-newworld .bl-num-input', SEED);
    const tNew = Date.now();
    await page.click('.bl-newworld .bl-form-submit');
    await waitFor('the loading screen', () => window.__blocklands.game.screen === 'loading', undefined, 10_000);
    await shot('loading');
    await playing();
    let st = await state();
    log(`playing ${((Date.now() - tNew) / 1000).toFixed(1)}s after "new world": renderer ${st.renderer}, server ${st.workers.server}, ${st.chunks} columns`);
    check(st.renderer === (renderer === 'default' ? 'webgpu' : 'webgl2'), `renderer ${st.renderer}`);
    check(st.workers.server === 'worker', `server runs as ${st.workers.server}`);
    world.id = st.worldId;
    await engage();
    await shot('playing');

    // ---- walk, jump, swim
    const p0 = st.player;
    await G(() => window.__blocklands.game.debug.look(0, -0.1));
    let p1 = p0;
    await holdUntil(['KeyW'], async () => {
      p1 = (await state()).player;
      return Math.hypot(p1.x - p0.x, p1.z - p0.z) > 1;
    }, 'walking');
    log(`walked ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1)} blocks`);
    await frames(3);
    p1 = (await state()).player;
    let topY = p1.y;
    await holdUntil(['Space'], async () => {
      topY = Math.max(topY, (await state()).player.y);
      return topY > p1.y + 0.5;
    }, `a jump (rose ${(topY - p1.y).toFixed(2)})`, 10_000, 50);
    check(topY > p1.y + 0.5, `did not jump (rose ${(topY - p1.y).toFixed(2)})`);
    log(`jumped ${(topY - p1.y).toFixed(2)} blocks`);
    await shot('walked-jumped');

    // the example boat (blocks near the spawn), found in the replica
    const boat = await G(() => {
      const d = window.__blocklands.game.debug;
      const p = d.state().player;
      let helm = null;
      let bearing = null;
      for (let x = Math.floor(p.x) - 60; x <= Math.floor(p.x) + 60; x++) {
        for (let z = Math.floor(p.z) - 60; z <= Math.floor(p.z) + 60; z++) {
          for (let y = 46; y <= 56; y++) {
            const id = d.cell(x, y, z) & 1023;
            if (id === 50) helm = { x, y, z };
            else if (id === 51) bearing = { x, y, z };
          }
        }
      }
      return { helm, bearing };
    });
    check(boat.helm && boat.bearing, 'no example boat near the spawn');
    const bow = { x: Math.sign(boat.bearing.x - boat.helm.x), z: Math.sign(boat.bearing.z - boat.helm.z) };
    const along = (v, u = 0) => ({ x: boat.helm.x + bow.x * (v - 1) - bow.z * u, z: boat.helm.z + bow.z * (v - 1) + bow.x * u });
    log(`example boat: helm ${JSON.stringify(boat.helm)}, bearing ${JSON.stringify(boat.bearing)}`);
    // swim: into the water beside the boat
    const water = along(4, 5);
    await teleport(water.x + 0.5, 46, water.z + 0.5);
    await until(async () => (await state()).player.wet > 0, 'the player in the water', 20_000);
    await shot('under-water');
    const sunk = (await state()).player.y;
    await holdUntil(['Space'], async () => {
      st = await state();
      return st.player.wet > 0 && st.player.y > sunk + 1;
    }, 'swimming up');
    log(`swam up from y ${sunk.toFixed(2)} to ${st.player.y.toFixed(2)}`);
    await shot('swimming');

    // ---- mine and place, back on land
    await teleport(p0.x, p0.y, p0.z);
    await selectItem(B.PLANKS);
    let placed = null;
    const tries = [];
    // A mob (a rabbit hopping by) in the cell refuses the block, rightly: the toast says so
    // (toast.place.occupied). Then another direction, and a second round after the mob moved on.
    await G(() => {
      const g = window.__blocklands.game;
      if (window.__e2eToasts) return;
      window.__e2eToasts = [];
      const push = g.toasts.push.bind(g.toasts);
      g.toasts.push = (text, ...rest) => {
        window.__e2eToasts.push(text);
        push(text, ...rest);
      };
    });
    const OCCUPIED = ['Something is in the way', '有东西挡着'];
    for (let round = 0; round < 2 && !placed; round++) {
      for (const [yaw, pitch] of [[0, -0.7], [1.2, -0.7], [-1.2, -0.7], [Math.PI, -0.7]]) {
        await G(([y, p]) => window.__blocklands.game.debug.look(y, p), [yaw, pitch]);
        await frames(3);
        const s = await state();
        const t = s.target;
        const pl = s.player;
        tries.push(`yaw ${yaw.toFixed(1)}: target ${JSON.stringify(t)}, player ${pl ? `${pl.x.toFixed(2)} ${pl.y.toFixed(2)} ${pl.z.toFixed(2)} shown ${pl.shownX.toFixed(2)} ${pl.shownY.toFixed(2)} ${pl.shownZ.toFixed(2)} look ${pl.yaw.toFixed(2)} ${pl.pitch.toFixed(2)}` : null}, screen ${s.screen}, ${s.sessionState}, locked ${s.pointerLocked}`);
        if (!t || t.gridId !== 0 || t.face !== PY) continue;
        const above = { x: t.x, y: t.y + 1, z: t.z };
        await G(() => void (window.__e2eToasts.length = 0));
        await click('right');
        let outcome = 'timeout';
        try {
          const settled = await page.waitForFunction(
            ([c, occupied]) => ((window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === 10 ? 'placed' : window.__e2eToasts.some((x) => occupied.includes(x)) ? 'occupied' : false),
            [above, OCCUPIED],
            { timeout: 30_000, polling: 200 },
          );
          outcome = await settled.jsonValue();
        } catch {
          // another direction
        }
        if (outcome === 'placed') {
          placed = above;
          break;
        }
        const near = await G((c) => {
          const g = window.__blocklands.game;
          const r = g.session.replica;
          return r.entities(g.session.net.clock.renderTick)
            .filter((e) => Math.hypot(e.pos.x - c.x - 0.5, e.pos.z - c.z - 0.5) < 2 && e.kind !== 'player')
            .map((e) => `${e.kind}#${e.id}@${e.pos.x.toFixed(2)},${e.pos.y.toFixed(2)},${e.pos.z.toFixed(2)}`);
        }, above);
        tries.push(`  ${outcome === 'occupied' ? 'refused: something is in the way' : 'nothing within 30 s'}; near the cell: ${JSON.stringify(near)}`);
        if (outcome === 'occupied') log(`placing at ${JSON.stringify(above)}: something is in the way (${near.join(', ') || 'nothing seen nearby'}), trying another direction`);
      }
      if (!placed && round === 0) await frames(20);
    }
    if (!placed) log(`placing failed:\n      ${tries.join('\n      ')}`);
    check(placed, 'could not place a block');
    log(`placed planks at ${JSON.stringify(placed)}`);
    await shot('placed');
    check(onTarget(await aim(placed), placed), 'cannot aim at the placed block');
    await click('left');
    await waitFor('the block mined', (c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) !== 10, placed);
    await shot('mined');
    // put it back to build on
    const base = { x: placed.x, y: placed.y - 1, z: placed.z };
    check(onTarget(await aim(base, PY), base, PY), 'cannot aim at the ground');
    await click('right');
    await waitFor('the block back', (c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === 10, placed);
    world.placed = placed;

    // ---- glue a face, build onto it
    await selectItem(GLUE);
    check(onTarget(await aim(placed, PY), placed, PY), 'cannot aim at the top face');
    await click('right');
    await waitFor('glue on the top face', ([c, f]) => window.__blocklands.game.session.replica.worldGlue.has(c.x, c.y, c.z, f), [placed, PY]);
    await shot('glued-face');
    await selectItem(B.PLANKS);
    check(onTarget(await aim(placed, PY), placed, PY), 'cannot aim at the glued face');
    await click('right');
    const onTop = { x: placed.x, y: placed.y + 1, z: placed.z };
    await waitFor('a block on the glued face', (c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === 10, onTop);
    check(await glueAt(placed, PY), 'the glue went away under the new block');
    await selectItem(GLUE); // covered glue shows while glue is in a hand
    await shot('covered-glue');

    // ---- off-hand glue: the next block placed against a face is glued to it (cobble does not
    // stick to planks by itself, so the glue is what joins them)
    await page.keyboard.press('KeyF');
    await waitFor('glue in the off-hand', () => window.__blocklands.game.debug.state().inventory.offhand?.item === 1024);
    await selectItem(B.COBBLE);
    check(onTarget(await aim(onTop, PX), onTop, PX), 'cannot aim at the side of the column');
    await click('right');
    const beside = { x: onTop.x + 1, y: onTop.y, z: onTop.z };
    await waitFor('a block placed against the side', ([c, id]) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === id, [beside, B.COBBLE]);
    await waitFor('the off-hand glue on that face', ([c, f]) => window.__blocklands.game.session.replica.worldGlue.has(c.x, c.y, c.z, f), [onTop, PX]);
    world.glued = [[placed, PY], [onTop, PX]];
    world.blocks = [[placed, B.PLANKS], [onTop, B.PLANKS], [beside, B.COBBLE]];
    await shot('offhand-glue');

    // ---- pick block: the turf under the player
    const ground = { x: Math.floor(p0.x) - 1, y: Math.floor(p0.y) - 1, z: Math.floor(p0.z) };
    const groundId = await cell(ground);
    check(onTarget(await aim(ground, PY), ground, PY), 'cannot aim at the ground');
    await click('middle');
    await waitFor('the picked block in hand', (id) => {
      const inv = window.__blocklands.game.debug.state().inventory;
      return inv.hotbar[inv.selected]?.item === id;
    }, groundId);
    log(`picked block ${groundId}`);
    await shot('picked');

    // ---- partial blocks (docs/SHAPES.md 14.1: debug.slab and debug.setCell, the host's commands,
    // stand in for the M2.4 chisel). A strip of cleared ground away from the blocks placed above:
    // a row of six lower half slabs on it, walked up onto without a jump and down off again; a
    // two-part cell (cobble below, planks above) of which the planks half is mined, the cobble half
    // stays.
    {
      const sx = Math.floor(p0.x) + 10;
      const sz = Math.floor(p0.z);
      const gy = Math.floor(p0.y);
      const COBBLE_CELL = B.COBBLE;
      const cells = [];
      for (let x = sx - 1; x <= sx + 14; x++) {
        for (let z = sz - 1; z <= sz + 1; z++) {
          cells.push([x, gy - 1, z, COBBLE_CELL]);
          for (let y = gy; y <= gy + 3; y++) cells.push([x, y, z, 0]);
        }
      }
      await G((cs) => {
        for (const [x, y, z, c] of cs) window.__blocklands.game.debug.setCell(x, y, z, c);
      }, cells);
      await waitFor('the strip cleared', ([x, y, z]) => (window.__blocklands.game.debug.cell(x, y, z) & 1023) === 2 && window.__blocklands.game.debug.cell(x, y + 1, z) === 0, [sx + 14, gy - 1, sz + 1]);
      // The slab row covers x in [ROW0, ROW1); a player (half width 0.3) whose x is within 0.3 of it
      // stands on it.
      const ROW0 = sx + 2;
      const ROW1 = sx + 8;
      for (let x = ROW0; x < ROW1; x++) check(await G(([x, y, z]) => window.__blocklands.game.debug.slab(x, y, z, 10, 3), [x, gy, sz]), `cannot put a half slab at ${x} ${gy} ${sz}`);
      await waitFor('the half slabs', ([x0, x1, y, z]) => {
        for (let x = x0; x < x1; x++) if ((window.__blocklands.game.debug.parts(x, y, z) ?? []).length !== 1) return false;
        return true;
      }, [ROW0, ROW1, gy, sz]);
      await teleport(sx + 0.5, gy, sz + 0.5);
      await G(() => window.__blocklands.game.debug.look(-Math.PI / 2, 0));
      await frames(3);
      await shot('half-slabs');
      const EAST = -Math.PI / 2;
      const WEST = Math.PI / 2;
      /** Let go of every key, then wait until the player stands still on something. */
      const standStill = async (what) => {
        let last = null;
        await until(async () => {
          const pl = (await state()).player;
          const still = pl.onGround && last !== null && Math.abs(pl.x - last.x) < 0.005 && Math.abs(pl.y - last.y) < 0.005;
          last = pl;
          return still;
        }, what, 30_000);
        return last;
      };
      // Walk onto the row without a jump, let go of W as soon as the player is on it, and check that
      // it stands still on top of the half slabs. Nothing is sampled while moving: the check is made
      // standing. Letting go late (a slow renderer, a slow page.evaluate) can carry the player past
      // the far end; it then walks back onto the row from the other side, which checks the same rule.
      let onRow = null;
      for (let attempt = 0, dir = EAST; attempt < 4 && onRow === null; attempt++, dir = dir === EAST ? WEST : EAST) {
        await G((yaw) => window.__blocklands.game.debug.look(yaw, 0), dir);
        await frames(3);
        await holdUntil(['KeyW'], async () => {
          const x = (await state()).player.x;
          return dir === EAST ? x > ROW0 + 0.5 : x < ROW1 - 0.5;
        }, `walking ${dir === EAST ? 'east' : 'west'} onto the half slabs`, 30_000, 50);
        const pl = await standStill('the player standing still after walking onto the half slabs');
        if (pl.x > ROW0 - 0.3 && pl.x < ROW1 + 0.3) onRow = pl;
        else log(`walking ${dir === EAST ? 'east' : 'west'} onto the half slabs carried the player past them (stopped at x ${(pl.x - sx).toFixed(2)}); walking back`);
      }
      check(onRow !== null, 'never stopped on the half slabs in four attempts');
      log(`standing on the half slabs at x ${(onRow.x - sx).toFixed(2)} y ${(onRow.y - gy).toFixed(2)}`);
      check(Math.abs(onRow.y - (gy + 0.5)) < 0.02, `not standing on top of the half slabs (walked up without a jump): y ${(onRow.y - gy).toFixed(3)} above the ground`);
      // Walk on east and down off the far end of the row, back onto the ground.
      await G((yaw) => window.__blocklands.game.debug.look(yaw, 0), EAST);
      await frames(3);
      await holdUntil(['KeyW'], async () => (await state()).player.x > ROW1 + 1.5, 'walking down off the half slabs', 30_000, 50);
      const end = await standStill('the player standing still past the half slabs');
      log(`down off the half slabs: standing at x ${(end.x - sx).toFixed(2)} y ${(end.y - gy).toFixed(2)}`);
      check(Math.abs(end.y - gy) < 0.02 && end.x > ROW1 + 0.3, `not back down on the ground past the slabs (at ${end.x.toFixed(2)} ${end.y.toFixed(2)})`);
      // A two-part cell ahead: cobble below, planks above; the planks half is mined (creative: one click).
      // The player is put a few steps before it (walking may have carried it anywhere past the row).
      const two = { x: sx + 13, y: gy, z: sz };
      await teleport(sx + 10.5, gy, sz + 0.5);
      check(await G(([c]) => window.__blocklands.game.debug.slab(c.x, c.y, c.z, 2, 3), [two]), 'cannot put the cobble half');
      await waitFor('the cobble half', (c) => (window.__blocklands.game.debug.parts(c.x, c.y, c.z) ?? []).length === 1, two);
      check(await G(([c]) => window.__blocklands.game.debug.slab(c.x, c.y, c.z, 10, 2), [two]), 'cannot put the planks half');
      await waitFor('the two-part cell', (c) => (window.__blocklands.game.debug.parts(c.x, c.y, c.z) ?? []).length === 2, two);
      await selectItem(B.PLANKS);
      await G(() => window.__blocklands.game.debug.look(-Math.PI / 2, 0));
      await frames(3);
      // Aim at the upper half of the cell's west face.
      await G((c) => {
        const g = window.__blocklands.game;
        const p = g.debug.state().player;
        const dx = c.x + 0.02 - p.shownX;
        const dy = c.y + 0.75 - (p.shownY + p.eyeHeight);
        const dz = c.z + 0.5 - p.shownZ;
        g.debug.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      }, two);
      await frames(3);
      const t = (await state()).target;
      check(onTarget(t, two) && t.sub >= 2 && (t.sub & 2) !== 0, `not aiming at the upper half of the two-part cell: ${JSON.stringify(t)}`);
      await shot('two-part-cell');
      await click('left');
      await waitFor('the planks half mined', (c) => {
        const parts = window.__blocklands.game.debug.parts(c.x, c.y, c.z) ?? [];
        return parts.length === 1 && parts[0].id === 2 && parts[0].fill === 0x33;
      }, two);
      log('mined the planks half of the two-part cell; the cobble half stays');
      await shot('one-part-left');
    }

    // ---- a small ship of half slabs: on open water near the example boat, a 3 x 3 raft of lower
    // planks half slabs around one full plank, with a helm on it; assembled at the helm, it floats,
    // then it is docked again.
    {
      const site = await G(() => {
        const d = window.__blocklands.game.debug;
        const p = d.state().player;
        const water = (x, z) => [45, 46, 47].every((y) => (d.cell(x, y, z) & 1023) === 30) && d.cell(x, 48, z) === 0;
        let best = null;
        for (let r = 6; r <= 60 && best === null; r++) {
          for (let x = Math.floor(p.x) - r; x <= Math.floor(p.x) + r && best === null; x++) {
            for (const z of [Math.floor(p.z) - r, Math.floor(p.z) + r]) {
              let open = true;
              for (let i = -3; i <= 3 && open; i++) for (let k = -3; k <= 3 && open; k++) if (!water(x + i, z + k)) open = false;
              if (open) {
                best = { x, z };
                break;
              }
            }
          }
        }
        return best;
      });
      check(site !== null, 'no open water for the slab raft');
      const LOWER_PLANKS = 10 + 0xcc * 65536; // planks, holes = the upper half (docs/SHAPES.md 1.2)
      const raftCells = [];
      for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) raftCells.push([site.x + i, 47, site.z + k, i === 0 && k === 0 ? B.PLANKS : LOWER_PLANKS]);
      await G((cs) => {
        for (const [x, y, z, c] of cs) window.__blocklands.game.debug.setCell(x, y, z, c);
      }, raftCells);
      await waitFor('the slab raft', (c) => (window.__blocklands.game.debug.cell(c.x, 47, c.z) & 1023) === 10 && (window.__blocklands.game.debug.parts(c.x + 1, 47, c.z + 1) ?? [])[0]?.fill === 0x33, site);
      log(`slab raft built at ${site.x} 47 ${site.z}`);
      // Stand on its south slab row; put a helm on the full plank in the middle (a functional block
      // is placed by hand: SetCell refuses it), then preview and assemble at it.
      await teleport(site.x + 0.5, 47.6, site.z + 1.5);
      check(await G(() => window.__blocklands.game.debug.give(50, 1)), 'no helm given');
      const centre = { x: site.x, y: 47, z: site.z };
      check(onTarget(await aim(centre, PY), centre, PY), 'cannot aim at the top of the raft\'s middle plank');
      await click('right');
      const helmCell = { x: site.x, y: 48, z: site.z };
      await waitFor('the helm on the slab raft', (c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === 50, helmCell);
      await selectItem(B.PLANKS);
      check(await aimAny(helmCell), 'cannot aim at the slab raft\'s helm');
      await click('right');
      await page.waitForTimeout(500);
      await click('right');
      await waitFor('the slab raft assembled and steered', () => {
        const s = window.__blocklands.game.debug.state();
        return s.structures.some((x) => x.kind === 'ship') && s.player.steeringShipId !== 0;
      });
      const raft = (await state()).structures.find((x) => x.kind === 'ship');
      check(raft.cells === 10, `the slab raft has ${raft.cells} cells, not 10`);
      await shot('slab-raft');
      // It floats: over a few seconds it neither sinks nor drifts up out of the water.
      const ys = [];
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(400);
        ys.push((await state()).structures.find((x) => x.id === raft.id).y);
      }
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      log(`slab raft #${raft.id} (${raft.cells} cells) floats: pivot y ${lo.toFixed(3)}..${hi.toFixed(3)}`);
      // The pivot is the centre of mass. Mass 8 x 0.25 + 0.5 (planks) + 0.6 (helm) = 3.1 on a 9-cell
      // waterplane: draught 0.344 below the surface at 47.875, centre of mass 0.532 above the bottom,
      // so 48.063 (headless: 48.0628). The same raft of full planks would float at 47.926.
      const FLOAT_Y = 48.063;
      check(hi - lo < 0.05 && Math.abs(lo - FLOAT_Y) < 0.075 && Math.abs(hi - FLOAT_Y) < 0.075, `the slab raft does not float steadily at its draught (pivot y ${lo.toFixed(3)}..${hi.toFixed(3)}, expected ${FLOAT_Y})`);
      // Dock it again (sneak + right-click while steering) so the example boat is the only ship below.
      let docked = false;
      for (let i = 0; i < 4 && !docked; i++) {
        await page.keyboard.down('ShiftLeft');
        await page.waitForTimeout(300);
        await click('right');
        try {
          await waitFor('the slab raft docked', () => !window.__blocklands.game.debug.state().structures.some((s) => s.kind === 'ship'), undefined, 30_000);
          docked = true;
        } catch {
          if ((await state()).player.steeringShipId === 0 && (await aimAny(helmCell, raft.id))) await click('right');
        } finally {
          await page.keyboard.up('ShiftLeft');
        }
      }
      check(docked, 'the slab raft did not dock');
      // The cells landed as they were: around the helm's plank, eight cells of one planks part with
      // the lower half filled (a 3 x 3 square of lower slabs looks the same turned any way).
      const landed = await G((c) => {
        const d = window.__blocklands.game.debug;
        for (let y = 45; y <= 49; y++) {
          for (let x = c.x - 5; x <= c.x + 5; x++) {
            for (let z = c.z - 5; z <= c.z + 5; z++) {
              if ((d.cell(x, y + 1, z) & 1023) !== 50) continue;
              const mid = d.parts(x, y, z) ?? [];
              const ring = [];
              for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) if (i !== 0 || k !== 0) ring.push(d.parts(x + i, y, z + k) ?? []);
              return { at: { x, y, z }, mid, ring };
            }
          }
        }
        return null;
      }, site);
      check(landed !== null, 'no helm found where the slab raft docked');
      const slabOk = (ps) => ps.length === 1 && ps[0].id === 10 && ps[0].fill === 0x33;
      check(landed.mid.length === 1 && landed.mid[0].id === 10 && landed.mid[0].fill === 0xff, `the docked raft's middle is not a full plank: ${JSON.stringify(landed.mid)}`);
      check(landed.ring.every(slabOk), `the docked raft's ring is not eight lower planks half slabs: ${JSON.stringify(landed.ring)}`);
      log(`the slab raft docked again at ${JSON.stringify(landed.at)}: a full plank under the helm, eight lower half slabs around it`);
      await teleport(p0.x, p0.y, p0.z);
    }

    // ---- the example boat: start the windmill
    const under = along(6);
    await teleport(under.x + 0.5, boat.helm.y, under.z + 0.5);
    await selectItem(B.PLANKS);
    check(onTarget(await aim(boat.bearing, 3), boat.bearing), 'cannot aim at the bearing');
    await click('right');
    await page.waitForTimeout(500);
    await click('right');
    await waitFor('the windmill to turn', () => window.__blocklands.game.debug.state().structures.some((s) => s.kind === 'rotor'));
    await page.waitForTimeout(1500);
    await shot('windmill');
    // assemble at the helm
    const stern = along(2);
    await teleport(stern.x + 0.5, boat.helm.y, stern.z + 0.5);
    check(onTarget(await aim(boat.helm), boat.helm), 'cannot aim at the helm');
    await click('right');
    await page.waitForTimeout(500);
    await click('right');
    await waitFor('the boat assembled and steered', () => {
      const s = window.__blocklands.game.debug.state();
      return s.structures.some((x) => x.kind === 'ship') && s.player.steeringShipId !== 0;
    });
    st = await state();
    const ship = st.structures.find((s) => s.kind === 'ship');
    log(`assembled ship #${ship.id} (${ship.cells} cells), steering`);
    await shot('at-the-helm');
    // sail and turn
    const heading = () => G((id) => {
      const q = window.__blocklands.game.session.replica.state.structures.get(id).structure.grid.rotation;
      return 2 * Math.atan2(q.y, q.w);
    }, ship.id);
    const h0 = await heading();
    const shipNow = async () => (await state()).structures.find((s) => s.id === ship.id);
    /** Aim at the helm on the boat and right-click until the player steers it again. */
    const takeHelm = async () => {
      for (let i = 0; i < 5; i++) {
        if ((await state()).player.steeringShipId === ship.id) return;
        if (!(await aimAny(boat.helm, ship.id))) continue;
        await click('right');
        try {
          await waitFor('steering again', (id) => window.__blocklands.game.debug.state().player.steeringShipId === id, ship.id, 20_000);
          return;
        } catch {
          // aim again
        }
      }
      throw new StepError('cannot take the helm again');
    };
    /**
     * Hold `keys` at the helm until `cond()`. The server lets go of the helm of a helmsman whose page
     * sent no movement report for 2 s (NETCODE section 3, STEER_TIMEOUT_TICKS): a software-rendered
     * page in a busy container can stall that long, so the helm is taken again when that happened
     * (and the run says so).
     */
    const steer = async (keys, cond, what, timeout = 180_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        let let_go = false;
        for (const k of keys) await page.keyboard.down(k);
        try {
          while (Date.now() < end) {
            if (await cond()) return;
            if ((await state()).player.steeringShipId !== ship.id) {
              let_go = true;
              break;
            }
            await page.waitForTimeout(150);
          }
        } finally {
          for (const k of keys) await page.keyboard.up(k);
        }
        if (!let_go) break;
        log('the helm was let go (no movement report for 2 s: a stalled page); taking it again');
        await takeHelm();
      }
      throw new StepError(`timed out steering for ${what}`);
    };
    // Screenshots are taken with no key held: taking one can stall a software-rendered page for
    // seconds (the helm is let go, see steer), and a helmsman let go of with W held walks off the deck.
    let s1 = ship;
    let throttle = 0;
    await steer(['KeyW'], async () => {
      const now = await state();
      s1 = now.structures.find((s) => s.id === ship.id);
      throttle = Math.max(throttle, now.helm?.throttle ?? 0);
      return Math.hypot(s1.x - ship.x, s1.z - ship.z) > 2 && throttle > 0.3;
    }, 'the boat to sail');
    check(throttle > 0.3, 'the helm shows no throttle');
    await shot('sailing');
    await takeHelm();
    let turned = 0;
    await steer(['KeyW', 'KeyA'], async () => {
      turned = Math.abs((await heading()) - h0);
      return turned > 0.3;
    }, 'the boat to turn');
    log(`sailed ${Math.hypot(s1.x - ship.x, s1.z - ship.z).toFixed(1)} blocks, turned ${turned.toFixed(2)} rad`);
    // third-person views while the boat moves on
    await page.keyboard.press('F5');
    await waitFor('over the shoulder', () => window.__blocklands.game.debug.state().viewMode === 'back');
    await page.waitForTimeout(800);
    await shot('sailing-back-view');
    await page.keyboard.press('F5');
    await waitFor('the front view', () => window.__blocklands.game.debug.state().viewMode === 'front');
    await page.waitForTimeout(800);
    await shot('sailing-front-view');
    await page.keyboard.press('F5');
    await waitFor('first person', () => window.__blocklands.game.debug.state().viewMode === 'first');
    await takeHelm();
    // open the inventory at the helm: the helm is let go
    await page.keyboard.press('KeyE');
    await waitFor('the inventory', () => window.__blocklands.game.screen === 'inventory');
    await waitFor('the helm let go', () => window.__blocklands.game.debug.state().player.steeringShipId === 0);
    await shot('inventory-at-helm');
    await page.keyboard.press('KeyE');
    await waitFor('play', () => window.__blocklands.game.screen === 'none');
    await page.waitForTimeout(1200);
    await engage();
    // take the wheel again once the boat has coasted to a stop (nobody steers it: the throttle went
    // to 0), then dock (sneak + right-click while steering)
    // (still: neither moving nor turning, or the look turned with the deck would miss the helm)
    let last = { ...(await shipNow()), h: await heading() };
    await until(async () => {
      const now = { ...(await shipNow()), h: await heading() };
      const moved = Math.hypot(now.x - last.x, now.z - last.z);
      const turnedBy = Math.abs(now.h - last.h);
      last = now;
      return moved < 0.02 && turnedBy < 0.002;
    }, 'the boat to coast to a stop', 120_000, 1000);
    // dock: sneak + right-click while steering (taken again if a stall let go of it meanwhile)
    let docked = false;
    for (let i = 0; i < 4 && !docked; i++) {
      await takeHelm();
      await page.keyboard.down('ShiftLeft');
      await page.waitForTimeout(300);
      await click('right');
      try {
        await waitFor('the boat docked', () => !window.__blocklands.game.debug.state().structures.some((s) => s.kind === 'ship'), undefined, 30_000);
        docked = true;
      } catch {
        log('not docked yet (the helm was let go before the click?): again');
      } finally {
        await page.keyboard.up('ShiftLeft');
      }
    }
    check(docked, 'the boat did not dock');
    const helmAt = await G(() => {
      const d = window.__blocklands.game.debug;
      const p = d.state().player;
      for (let x = Math.floor(p.x) - 12; x <= p.x + 12; x++) for (let z = Math.floor(p.z) - 12; z <= p.z + 12; z++) for (let y = 44; y <= 54; y++) if ((d.cell(x, y, z) & 1023) === 50) return { x, y, z };
      return null;
    });
    check(helmAt, 'the docked helm is not in the world');
    world.helm = helmAt;
    st = await state();
    world.rotors = st.structures.filter((s) => s.kind === 'rotor').length;
    check(world.rotors === 1, `expected the windmill to turn on in the world, rotors: ${world.rotors}`);
    log(`docked: helm at ${JSON.stringify(helmAt)}, windmill turning in the world`);
    await shot('docked');

    // ---- pause for ten seconds: nothing moves
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await waitFor('the pause menu', () => window.__blocklands.game.screen === 'pause');
    await page.waitForTimeout(500);
    await frames(3);
    const before = await state();
    const angle = () => G(() => {
      const r = window.__blocklands.game.session.replica;
      const rotor = r.structures().find((s) => s.constructor.name !== 'Ship' && 'angle' in s);
      const q = rotor.grid.rotation;
      return [q.x, q.y, q.z, q.w].map((v) => v.toFixed(6)).join(',');
    });
    const a0 = await angle();
    const shotA = await page.screenshot();
    await page.waitForTimeout(10_000);
    const after = await state();
    const a1 = await angle();
    const shotB = await page.screenshot();
    check(after.worldTime === before.worldTime, `the server ticked while paused (${before.worldTime} -> ${after.worldTime})`);
    check(a0 === a1, 'the windmill turned while paused');
    check(after.player.x === before.player.x && after.player.y === before.player.y, 'the player moved while paused');
    log(`paused 10 s: server tick ${after.worldTime} unchanged, windmill still, screenshots ${shotA.equals(shotB) ? 'identical' : 'differ'}`);
    await shot('paused');
    // switch to survival (the pause menu's mode switch), resume
    await page.click('.bl-screen[data-screen="pause"] .bl-pause-mode button >> nth=1');
    await waitFor('survival shown', () => window.__blocklands.game.debug.state().player.mode === 'survival');
    await page.click('.bl-screen[data-screen="pause"] .bl-btn--primary');
    await waitFor('play', () => window.__blocklands.game.screen === 'none');
    await page.waitForTimeout(1500);
    await engage();

    // ---- fall damage, death, respawn
    st = await state();
    const land = { x: Math.floor(p0.x) + 0.5, y: p0.y, z: Math.floor(p0.z) + 0.5 };
    await teleport(land.x, land.y + 7, land.z);
    await waitFor('landing hurt', () => {
      const p = window.__blocklands.game.debug.state().player;
      return p.health !== null && p.health < 20;
    }, undefined, 60_000);
    st = await state();
    check(!st.player.dead, 'a 7-block fall killed the player');
    log(`fall damage: health ${st.player.health}`);
    await shot('fall-damage');
    await teleport(land.x, land.y + 60, land.z);
    await waitFor('the death screen', () => window.__blocklands.game.screen === 'death', undefined, 60_000);
    await shot('dead');
    await page.click('.bl-screen[data-screen="death"] .bl-btn--primary');
    await playing();
    // the respawn is the server's (the screen goes at once, the health comes with its answer)
    await waitFor('alive again with full health', () => {
      const p = window.__blocklands.game.debug.state().player;
      return p !== null && !p.dead && p.health === 20;
    });
    st = await state();
    check((await G(() => window.__blocklands.game.screen)) === 'none', 'the death screen came back');
    log(`respawned at ${st.player.x.toFixed(1)} ${st.player.y.toFixed(1)} ${st.player.z.toFixed(1)}`);
    await page.waitForTimeout(800);
    await shot('respawned');

    // ---- save and quit
    world.player = (await state()).player;
    world.inventory = (await state()).inventory;
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await waitFor('the pause menu', () => window.__blocklands.game.screen === 'pause');
    await page.click('.bl-screen[data-screen="pause"] .bl-btn--danger');
    await waitFor('the main menu', () => window.__blocklands.game.screen === 'mainMenu', undefined, 60_000);
    await waitFor('the world in the list', (id) => !!document.querySelector(`.bl-world[data-id="${id}"]`), world.id);
    await shot('saved-and-quit');

    // ---- reload the page, load the world: everything is where it was
    await page.reload();
    await page.waitForFunction(() => window.__blocklands?.game?.screen === 'mainMenu', undefined, { timeout: 60_000 });
    await waitFor('the world in the list after reloading', (id) => !!document.querySelector(`.bl-world[data-id="${id}"]`), world.id);
    await G((rd) => window.__blocklands.game.changeSettings({ renderDistance: rd, showDebug: true }), RENDER_DISTANCE);
    await page.click(`.bl-world[data-id="${world.id}"] [data-act="play"]`);
    await playing();
    await page.waitForTimeout(1000);
    st = await state();
    check(Math.hypot(st.player.x - world.player.x, st.player.z - world.player.z) < 0.5, `the player is not where it was (${st.player.x}, ${st.player.z} vs ${world.player.x}, ${world.player.z})`);
    check(st.player.mode === 'survival', `mode ${st.player.mode} after loading`);
    check(JSON.stringify(st.inventory) === JSON.stringify(world.inventory), 'the inventory changed');
    for (const [b, id] of world.blocks) {
      await waitFor(`block ${JSON.stringify(b)} loaded`, (c) => window.__blocklands.game.debug.cell(c.x, c.y, c.z) !== -1, b, 60_000);
      check((await cell(b)) === id, `block ${JSON.stringify(b)} is gone`);
    }
    for (const [c, f] of world.glued) check(await glueAt(c, f), `glue at ${JSON.stringify(c)} face ${f} is gone`);
    await engage();
    await teleport(world.helm.x + 0.5, world.helm.y + 3, world.helm.z + 0.5);
    check((await cell(world.helm)) === B.HELM, 'the docked helm is gone');
    check((await state()).structures.filter((s) => s.kind === 'rotor').length === world.rotors, 'the windmill is gone');
    log('loaded: player, mode, inventory, blocks, glue, the docked boat and its windmill are where they were');
    await shot('reloaded');
  } catch (e) {
    result = 'FAIL';
    problems.push(e instanceof StepError ? e.message : `${e.name}: ${e.message}`);
    await page.screenshot({ path: join(outDir, `${name}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
    await host.close();
    xvfb?.stop();
  }
  if (problems.length > 0) result = 'FAIL';
  return { name, result, problems, seconds: (Date.now() - t0) / 1000 };
}

if (doBuild) {
  for (const script of ['build', 'build:artifact']) {
    const r = spawnSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) process.exit(1);
  }
}
const results = [];
for (const b of builds) for (const r of renderers) {
  console.log(`\n== ${b} build, ${r} renderer`);
  results.push(await session(b, r));
}
console.log('\n== summary');
let failed = false;
for (const r of results) {
  console.log(`${r.result}  ${r.name.padEnd(18)} ${r.seconds.toFixed(0)}s`);
  for (const p of r.problems) console.log(`      - ${p}`);
  if (r.result !== 'PASS') failed = true;
}
console.log(`screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
