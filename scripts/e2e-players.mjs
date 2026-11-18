#!/usr/bin/env node
// The other players on screen (NETCODE package 12) in a real browser (Playwright + Chromium): the
// game with scripted extra players joined to the page's own server (the dev tooling of
// window.__blocklands.game.debug.bots(), client/devbots.ts: real network clients in the page).
//
//   node scripts/e2e-players.mjs [--renderer webgl2|default] [--out DIR] [--no-build] [--quick | --boat]
//
// --quick leaves out the wall and the boat (the slowest steps on a software renderer); --boat runs
// only the boat (after the bots joined).
//
// Without --renderer it runs both renderers (#webgl2, and the default, WebGPU on SwiftShader through
// a headed browser on Xvfb). Screenshots, each looked at by a person afterwards: another player
// standing; walking (two moments); holding different items (planks, glue, a water bucket);
// sneaking; at the helm of the example boat while it sails and turns, seen from the deck and from
// the shore; at night; behind a wall (the name hidden) and stepping out of it; far away; the own
// player walking in the over-the-shoulder view. Frame cost: the game's frame and render times with
// three other players in view, against none. Console errors and page errors fail the run.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 800, height: 450 };
const SEED = 'play-session';
const RENDER_DISTANCE = 4;
const B = { COBBLE: 2, HELM: 50, BEARING: 51 };
const SLOT = { planks: 0, helm: 3, glue: 5, cobble: 7, bucket: 8 };
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader'];

const argv = process.argv.slice(2);
let renderers = ['webgl2', 'default'];
let outDir = null;
let doBuild = true;
let quick = false;
let boatOnly = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--renderer') renderers = [argv[++i]];
  else if (a === '--out') outDir = argv[++i];
  else if (a === '--no-build') doBuild = false;
  else if (a === '--quick') quick = true;
  else if (a === '--boat') boatOnly = true;
  else {
    console.error('usage: node scripts/e2e-players.mjs [--renderer webgl2|default] [--out DIR] [--no-build] [--quick | --boat]');
    process.exit(2);
  }
}
outDir = resolve(outDir ?? mkdtempSync(join(tmpdir(), 'blocklands-players-')));
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
function site() {
  const dist = join(ROOT, 'dist');
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const file = normalize(join(dist, path));
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(req.url === '/favicon.ico' ? 204 : 404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(() => r())) })));
}

async function startXvfb() {
  const r = spawnSync('sh', ['-c', 'command -v Xvfb'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  for (let n = 180; n < 220; n++) {
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

async function session(renderer) {
  const name = renderer;
  const t0 = Date.now();
  const problems = [];
  const notes = [];
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
  const host = await site();
  const browser = await chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
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
  const shots = [];
  let shotN = 0;
  const shot = async (what, note) => {
    // Engaged again if the pointer lock was lost (no "click to play" card over the picture).
    if (!(await G(() => window.__blocklands.game.pointerLocked))) {
      await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
      await page.waitForTimeout(400);
    }
    await frames(4);
    const file = join(outDir, `${name}-${String(++shotN).padStart(2, '0')}-${what}.png`);
    await page.screenshot({ path: file });
    shots.push({ file, note });
    log(`screenshot ${what}`);
  };
  const waitFor = async (what, fn, arg, timeout = 60_000) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 200 });
    } catch {
      throw new StepError(`timed out waiting for ${what}`);
    }
  };
  const until = async (cond, what, timeout = 60_000, pollMs = 250) => {
    const end = Date.now() + timeout;
    while (!(await cond())) {
      if (Date.now() >= end) throw new StepError(`timed out waiting for ${what}`);
      await page.waitForTimeout(pollMs);
    }
  };
  const center = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  const engage = async () => {
    await page.waitForTimeout(600);
    if (await G(() => window.__blocklands.game.pointerLocked)) return;
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(400);
  };
  const look = (yaw, pitch) => G(([y, p]) => window.__blocklands.game.debug.look(y, p), [yaw, pitch]);
  /** Point the own view at a world point (from the eyes as shown). */
  const lookAtPoint = async (x, y, z) => {
    const p = (await state()).player;
    const dx = x - p.shownX;
    const dy = y - (p.shownY + p.eyeHeight);
    const dz = z - p.shownZ;
    await look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  };
  const teleport = async (x, y, z, tol = 0.8) => {
    await G(([x, y, z]) => window.__blocklands.game.debug.teleport(x, y, z), [x, y, z]);
    await waitFor(`the player at ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`, ([x, z, tol]) => {
      const s = window.__blocklands.game.debug.state();
      return s.player !== null && Math.hypot(s.player.x - x, s.player.z - z) < tol && s.sessionState === 'ready';
    }, [x, z, tol], 60_000);
    await frames(3);
  };
  const bots = (fn, arg) => G(async ([src, arg]) => {
    const b = await window.__blocklands.game.debug.bots();
    // eslint-disable-next-line no-new-func
    return new Function('b', 'arg', `return (${src})(b, arg);`)(b, arg);
  }, [fn.toString(), arg]);
  const botState = (n) => bots((b, n) => b.state(n), n);
  /** The entity list the renderer got in the last frame (what package 12 hands over), for the bots. */
  const drawn = () => G(() => {
    const s = window.__blocklands.game.session;
    const list = s.view.entityList ?? [];
    return list.filter((e) => e.kind === 'player').map((e) => ({ id: e.id, label: e.label, held: e.held, posture: e.posture, x: e.x, y: e.y, z: e.z, speed: Math.hypot(e.vx, e.vz) }));
  });
  /** Average game frame / render time over `ms` (the game's own FrameStats, every animation frame). */
  const frameCost = (ms) => G((ms) => new Promise((res) => {
    const g = window.__blocklands.game;
    const f = [];
    const r = [];
    const t0 = performance.now();
    const step = () => {
      f.push(g.stats.frameMs);
      r.push(g.stats.renderMs);
      if (performance.now() - t0 < ms) requestAnimationFrame(step);
      else {
        const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
        const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
        const st = g.debug.backendStats();
        res({ frames: f.length, frameAvg: avg(f), frameMed: med(f), renderAvg: avg(r), renderMed: med(r), drawCalls: st.drawCalls, triangles: st.triangles });
      }
    };
    requestAnimationFrame(step);
  }), ms);

  let result = 'PASS';
  const cost = {};
  try {
    await page.goto(host.url + (renderer === 'webgl2' ? '#webgl2' : ''));
    await page.waitForFunction(() => window.__blocklands?.game?.screen === 'mainMenu', undefined, { timeout: 60_000 });
    await G((rd) => window.__blocklands.game.changeSettings({ renderDistance: rd }), RENDER_DISTANCE);
    await page.waitForTimeout(400);
    await page.fill('.bl-newworld input[type="text"] >> nth=0', 'Players');
    await page.fill('.bl-newworld .bl-num-input', SEED);
    await page.click('.bl-newworld .bl-form-submit');
    await waitFor('play', () => {
      const s = window.__blocklands.game.debug.state();
      return s.sessionState === 'ready' && s.screen === 'none';
    }, undefined, 240_000);
    let st = await state();
    check(st.renderer === (renderer === 'default' ? 'webgpu' : 'webgl2'), `renderer ${st.renderer}`);
    await engage();
    // Noon, and the clock keeps running: set it again before every daytime scene.
    await G(() => window.__blocklands.game.debug.setDayTime(0.25));
    const p0 = st.player;
    log(`playing at ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} ${p0.z.toFixed(1)}, renderer ${st.renderer}`);

    // The example boat near the spawn, and flat ground: the player stays at the spawn.
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

    // ---- the stage is the deck of the example boat (still world blocks): flat planks, 5 wide, 9
    // long, the helm at the stern (v = 1), the mast at v = 6. deck(v, u): the middle of that cell.
    const gy = boat.helm.y;
    const deck = (v, u = 0) => {
      const c = along(v, u);
      return { x: c.x + 0.5, y: gy, z: c.z + 0.5 };
    };
    const bowYaw = Math.atan2(-bow.x, -bow.z);
    // The player hovers over the water off the starboard side (creative flight), looking across the deck.
    const me = { ...deck(4.8, 5.2), y: gy + 2 };
    const fly = async (at) => {
      // Take off where the player stands (a double jump; not in water), then the teleport keeps the flight.
      // A double jump straight into the prediction's held input (as two Space presses in one frame).
      for (let i = 0; i < 4 && !(await state()).player.flying; i++) {
        await G(() => {
          window.__blocklands.game.session.held.jumpPresses += 2;
        });
        await page.waitForTimeout(600);
      }
      const fs = await state();
      check(fs.player.flying, `the player does not fly: ${JSON.stringify({ p: fs.player, screen: fs.screen, locked: fs.pointerLocked, drag: fs.dragLook })}`);
      await teleport(at.x, at.y, at.z);
    };
    const faceDeck = () => lookAtPoint(deck(4.5, 0).x, gy + 1.1, deck(4.5, 0).z);
    await fly(me);
    await faceDeck();
    // ---- cost with nobody else, then with the three bots standing in the same view
    await page.waitForTimeout(1500);
    cost.none = await frameCost(6000);
    log(`frame cost, no other player: ${JSON.stringify(cost.none)}`);

    // ---- three bots join the page's own server
    const names = ['Mira', '船长 Bram', 'Cleo'];
    for (const n of names) {
      const s = await bots((b, n) => b.add(n), n);
      log(`bot ${n} joined as entity ${s.entityId}`);
    }
    // Joins the server refuses leave nothing behind: a name longer than the player table allows, and
    // a fourth guest in a full room (the host and three bots).
    for (const n of ['X'.repeat(25), 'Extra']) {
      const err = await bots((b, n) => b.add(n).then(() => null, (e) => e.message), n);
      check(err !== null && err.endsWith('refused'), `bot ${n.slice(0, 8)} was not refused: ${err}`);
    }
    const kept = await bots((b) => b.names(), null);
    check(JSON.stringify(kept) === JSON.stringify(names), `refused bots stay registered: ${JSON.stringify(kept)}`);
    log('refused joins (a 25-character name, a full room) left no bot behind');
    // Off the centre line: the windmill's sails hang over it.
    const spots = [deck(3, 1), deck(4.6, -1), deck(8, 1)];
    const goAll = (targets) => Promise.all(names.map((n, i) => (targets[i] ? bots((b, [n, s]) => b.goto(n, s.x, s.y, s.z), [n, targets[i]]) : true)));
    const faceMe = async (ns = names) => {
      for (const n of ns) await bots((b, [n, x, y, z]) => b.lookAt(n, x, y, z), [n, me.x, gy + 1.6, me.z]);
    };
    await goAll(spots);
    for (const [i, n] of names.entries()) {
      const s = await botState(n);
      check(Math.hypot(s.x - spots[i].x, s.z - spots[i].z) < 1.2, `bot ${n} did not arrive (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`);
    }
    await faceMe();
    // ---- standing, holding different items
    await bots((b) => b.select('Mira', 0), null); // planks
    await bots((b) => b.select('船长 Bram', 5), null); // glue
    await bots((b) => b.select('Cleo', 8), null); // a water bucket
    let list = [];
    if (!boatOnly) {
    await until(async () => {
      list = await drawn();
      return list.length === 3 && new Set(list.map((e) => e.held)).size === 3;
    }, 'three players holding three items', 60_000);
    log(`drawn players: ${JSON.stringify(list.map((e) => [e.label, e.held, e.posture, +e.x.toFixed(2), +e.y.toFixed(2), +e.z.toFixed(2)]))}; spots ${JSON.stringify(spots)}`);
    check(list.length === 3, `${list.length} other players drawn`);
    check(list.every((e) => e.label !== null), 'a player without a name tag');
    check(new Set(list.map((e) => e.held)).size === 3, 'the three do not hold three different items');
    await faceDeck();
    await page.waitForTimeout(1000);
    cost.three = await frameCost(6000);
    log(`frame cost, 3 players in view: ${JSON.stringify(cost.three)}`);
    await shot('standing-items', 'three players standing on the deck facing the camera: planks, glue, a water bucket in their right hands; name tags above');
    await lookAtPoint(spots[0].x, gy + 1.2, spots[0].z);
    await shot('close-planks', 'Mira closer, at the centre: the model, the planks in her right hand, her tag');
    await lookAtPoint(spots[2].x, gy + 1.2, spots[2].z);
    await shot('close-bucket', 'Cleo at the centre: the water bucket in her right hand');
    await faceDeck();
    await bots((b, y) => b.look('船长 Bram', y, 0.6), bowYaw);
    await page.waitForTimeout(800);
    await shot('head-up', 'Bram looks up and to the side (head pitch and turn): the body turns to its limit, the head tilts');
    await faceMe();

    await G(() => window.__blocklands.game.debug.setDayTime(0.25));
    // ---- walking: Mira walks the deck along its port side and back; Cleo sneaks
    await bots((b, [a, c]) => b.walk('Mira', [a, c], true, 0.7), [deck(2.5, 1), deck(8.5, 1)]);
    await bots((b) => b.keys('Cleo', { sneak: true }), null);
    await until(async () => {
      list = await drawn();
      return list.some((e) => e.label === 'Mira' && e.speed > 1) && list.some((e) => e.label === 'Cleo' && e.posture === 'sneak');
    }, 'Mira walking and Cleo sneaking', 60_000);
    log(`walking: ${JSON.stringify(list.map((e) => [e.label, e.posture, e.speed.toFixed(2)]))}`);
    await shot('walking-1', 'Mira walking the deck (legs and arms mid-swing), Cleo sneaking (bent, lower), Bram standing');
    await page.waitForTimeout(600);
    await shot('walking-2', 'Mira at another moment of the walk');
    await bots((b) => b.keys('Cleo', { sneak: false }), null);
    await bots((b) => b.stop('Mira'), null);

    await G(() => window.__blocklands.game.debug.setDayTime(0.25));
    // ---- night
    await G(() => window.__blocklands.game.debug.setDayTime(0.75));
    await goAll(spots);
    await faceMe();
    await faceDeck();
    await page.waitForTimeout(1500);
    await shot('night', 'midnight on deck: the models dark like the world around them, the name tags still readable (unlit)');
    await G(() => window.__blocklands.game.debug.setDayTime(0.25));

    if (!quick) {
    // ---- behind a wall: cobblestone 3 long and 3 high on the starboard gunwale (u = 2, v = 3..5),
    // built from close by; Cleo behind it on the deck.
    await goAll([deck(8.3, -1), deck(2, 1), deck(7.2, 1)]);
    const near = { ...deck(4, 3.5), y: gy + 1.5 };
    await fly(near);
    await G(() => window.__blocklands.game.input.selectSlot(7));
    await waitFor('cobblestone in hand', () => {
      const inv = window.__blocklands.game.debug.state().inventory;
      return inv.hotbar[inv.selected]?.item === 2;
    });
    const wallCells = [];
    for (let y = gy + 1; y < gy + 4; y++) for (let v = 3; v <= 5; v++) {
      const c = along(v, 2);
      wallCells.push({ x: c.x, y, z: c.z });
    }
    const aimAt = async (c, fy) => {
      await G(([c, fy]) => {
        const g = window.__blocklands.game;
        const p = g.debug.state().player;
        const w = { x: c.x + 0.5, y: c.y + fy, z: c.z + 0.5 };
        const dx = w.x - p.shownX;
        const dy = w.y - (p.shownY + p.eyeHeight);
        const dz = w.z - p.shownZ;
        g.debug.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      }, [c, fy]);
      await frames(3);
      return (await state()).target;
    };
    const cobble = async () => {
      let n = 0;
      for (const c of wallCells) if (((await G(([x, y, z]) => window.__blocklands.game.debug.cell(x, y, z), [c.x, c.y, c.z])) & 1023) === B.COBBLE) n++;
      return n;
    };
    for (let pass = 0; pass < 3 && (await cobble()) < wallCells.length; pass++) {
      for (const c of wallCells) {
        if (((await G(([x, y, z]) => window.__blocklands.game.debug.cell(x, y, z), [c.x, c.y, c.z])) & 1023) === B.COBBLE) continue;
        // Aim at the top face of the block under the cell, click: a block on it.
        const under = { x: c.x, y: c.y - 1, z: c.z };
        const t = await aimAt(under, 0.98);
        if (!t || t.x !== under.x || t.y !== under.y || t.z !== under.z) continue;
        await page.mouse.click(center.x, center.y, { button: 'right' });
        await frames(3);
      }
    }
    let wall = await cobble();
    log(`wall: ${wall} of ${wallCells.length} cobblestone placed`);
    check(wall === wallCells.length, `the wall has ${wall} blocks`);
    await bots((b, s) => b.goto('Cleo', s.x, s.y, s.z), deck(4, -0.6));
    await fly(me);
    await faceDeck();
    await faceMe(['Cleo']);
    await page.waitForTimeout(1200);
    list = await drawn();
    check(list.some((e) => e.label === 'Cleo'), 'Cleo is not in the list behind the wall (the depth test hides her, not the client)');
    await shot('behind-wall', 'Cleo right behind the cobblestone wall: neither her body nor her name tag shows; Mira and Bram on either side');
    await bots((b, s) => b.goto('Cleo', s.x, s.y, s.z), deck(6.8, 1));
    await faceMe(['Cleo']);
    await page.waitForTimeout(800);
    await shot('beside-wall', 'Cleo stepped out beside the wall: body and tag visible again');
    // The wall stays: it sails with the boat (blocks on its deck).
    await fly(me);

    await G(() => window.__blocklands.game.debug.setDayTime(0.25));
    }
    // ---- far away: the player 40 blocks off the starboard side, over the open sea, looking back at the deck
    await G(() => window.__blocklands.game.debug.setDayTime(0.25));
    const farCell = along(4.5, 40);
    const far = { x: farCell.x + 0.5, y: gy + 3, z: farCell.z + 0.5 };
    await fly(far);
    await faceDeck();
    await page.waitForTimeout(1000);
    list = await drawn();
    log(`far: ${JSON.stringify(list.map((e) => [e.label, +Math.hypot(e.x - far.x, e.z - far.z).toFixed(1)]))}`);
    check(list.length === 3, `${list.length} players drawn from far away`);
    await shot('far-away', 'from 40 blocks off the starboard side: the three on the deck are small figures, their tags still readable');
    await fly(me);

    // ---- the own player walking, over the shoulder (along the deck toward the bow)
    const aft = deck(2.2, -1);
    await teleport(aft.x, aft.y, aft.z);
    if ((await state()).player.flying) {
      await G(() => {
        window.__blocklands.game.session.held.jumpPresses += 2;
      });
      await page.waitForTimeout(800);
    }
    await G(() => window.__blocklands.game.debug.view('back'));
    await look(bowYaw, -0.25);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(700);
    await shot('own-walking-back-view', 'the own player from behind, mid-walk on the deck (legs swinging), no name tag over it');
    await page.keyboard.up('KeyW');
    await G(() => window.__blocklands.game.debug.view('first'));
    // Out of Bram's way: he goes to the mast, then to the wheel at the stern.
    const fore = deck(8.5, 1.5);
    await teleport(fore.x, fore.y, fore.z);

    }
    if (!quick) {
    await G(() => window.__blocklands.game.debug.setDayTime(0.25));
    // ---- the example boat: Bram starts the windmill and takes the wheel; the player rides on deck
    const under = along(6);
    const stern = along(2);
    // Only Bram is needed now: the other bots leave (each bot's client runs on this page's main
    // thread; a page that stalls 2 s makes the server let go of the helmsman's wheel).
    await bots((b) => {
      b.remove('Mira');
      b.remove('Cleo');
    }, null);
    // Planks in hand, as a player does it (glue in hand would glue the bearing's face).
    await bots((b) => b.select('船长 Bram', 0), null);
    await page.waitForTimeout(500);
    check(await bots((b, [x, y, z]) => b.goto('船长 Bram', x, y, z), [under.x + 0.5, boat.helm.y, under.z + 0.5]), 'Bram did not reach the mast');
    check(await bots((b, c) => b.useOn('船长 Bram', c.x, c.y, c.z), boat.bearing), 'Bram cannot click the bearing');
    await page.waitForTimeout(600);
    await bots((b, c) => b.useOn('船长 Bram', c.x, c.y, c.z), boat.bearing);
    await waitFor('the windmill to turn', () => window.__blocklands.game.debug.state().structures.some((s) => s.kind === 'rotor'));
    check(await bots((b, [x, y, z]) => b.goto('船长 Bram', x, y, z), [stern.x + 0.5, boat.helm.y, stern.z + 0.5]), 'Bram did not reach the stern');
    await bots((b, c) => b.useOn('船长 Bram', c.x, c.y, c.z), boat.helm);
    await page.waitForTimeout(600);
    await bots((b, c) => b.useOn('船长 Bram', c.x, c.y, c.z), boat.helm);
    await waitFor('a ship', () => window.__blocklands.game.debug.state().structures.some((s) => s.kind === 'ship'));
    st = await state();
    const ship = st.structures.find((s) => s.kind === 'ship');
    const takeHelm = async () => {
      // Let go of the keys first: a helmsman let go of with forward held walks off the deck.
      await bots((b) => b.keys('船长 Bram', { forward: 0, strafe: 0 }), null);
      for (let i = 0; i < 6; i++) {
        if ((await botState('船长 Bram')).steeringShipId === ship.id) return;
        await bots((b, [c, id]) => b.useOn('船长 Bram', c.x, c.y, c.z, id), [boat.helm, ship.id]);
        const end = Date.now() + 15_000;
        while (Date.now() < end && (await botState('船长 Bram')).steeringShipId !== ship.id) await page.waitForTimeout(300);
      }
      throw new StepError('Bram cannot take the wheel');
    };
    await takeHelm();
    log(`ship #${ship.id} assembled, Bram at the wheel`);
    // The player stands on the deck just ahead of the wheel, looking back at the helmsman.
    // Two cells ahead of the wheel, off the centre line (the windmill's blades sweep over it).
    const bowSpot = along(3.2, 1);
    // On the boat's deck, standing (not flying: a flier would stay behind when it sails), carried by it.
    for (let i = 0; i < 4 && (await state()).player.flying; i++) {
      await G(() => {
        window.__blocklands.game.session.held.jumpPresses += 2;
      });
      await page.waitForTimeout(800);
    }
    await teleport(bowSpot.x + 0.5, boat.helm.y, bowSpot.z + 0.5, 3);
    await until(async () => (await state()).player.carrierId === ship.id, 'the player carried by the boat', 60_000);
    log(`player on the deck: ${JSON.stringify((await state()).player)}`);
    await bots((b) => b.keys('船长 Bram', { forward: 1, strafe: 0.5 }), null);
    const heading = () => G((id) => {
      const q = window.__blocklands.game.session.replica.state.structures.get(id)?.structure.grid.rotation;
      return q ? 2 * Math.atan2(q.y, q.w) : NaN;
    }, ship.id);
    const h0 = await heading();
    await until(async () => {
      const bs = await botState('船长 Bram');
      if (bs.steeringShipId !== ship.id) {
        log('Bram was let go of the wheel (a stalled page: no report for 2 s); taking it again');
        await takeHelm();
        await bots((b) => b.keys('船长 Bram', { forward: 1, strafe: 0.5 }), null);
      }
      return Math.abs(Math.atan2(Math.sin((await heading()) - h0), Math.cos((await heading()) - h0))) > 0.25;
    }, 'the boat to sail and turn', 180_000, 400);
    const lookAtHelm = async () => {
      const hp = await G(([id, c]) => {
        const g = window.__blocklands.game.session.replica.state.structures.get(id).structure.grid;
        return g.toWorld({ x: c.x + 0.5, y: c.y + 0.8, z: c.z + 0.5 }, { x: 0, y: 0, z: 0 });
      }, [ship.id, boat.helm]);
      await lookAtPoint(hp.x, hp.y, hp.z);
    };
    await lookAtHelm();
    list = await drawn();
    const bram = list.find((e) => e.label === '船长 Bram');
    log(`at the helm: ${JSON.stringify(bram)}`);
    check(bram && bram.posture === 'helm', 'Bram is not drawn at the helm');
    await shot('helm-from-deck', 'from the deck of the sailing, turning boat, two cells ahead of the wheel: Bram at the wheel, both hands on it, facing it, his tag above; the deck and he stay put relative to each other');
    await page.waitForTimeout(1500);
    await lookAtHelm();
    await shot('helm-from-deck-2', 'a moment later, still turning: Bram unmoved at the wheel');
    // From the shore: over the island's edge beside where the boat was moored.
    const shoreCell = along(4.5, -9);
    const shoreTop = await G(([x, z]) => {
      const d = window.__blocklands.game.debug;
      for (let y = 90; y > 30; y--) {
        const id = d.cell(x, y, z) & 1023;
        if (id !== 0 && id !== 71 && id !== 72 && id !== 73 && id !== 74) return y;
      }
      return -1;
    }, [shoreCell.x, shoreCell.z]);
    log(`shore: ${JSON.stringify(shoreCell)} top ${shoreTop}`);
    // A few blocks over the island's edge (flying), so the cliff does not hide the sea.
    await fly({ x: shoreCell.x + 0.5, y: shoreTop + 5, z: shoreCell.z + 0.5 });
    for (let k = 0; k < 2; k++) {
      const sp = await G((id) => window.__blocklands.game.session.replica.state.structures.get(id).structure.grid.position, ship.id);
      await lookAtPoint(sp.x, sp.y + 1, sp.z);
      await page.waitForTimeout(600);
    }
    if ((await botState('船长 Bram')).steeringShipId !== ship.id) {
      log('Bram was let go of the wheel (a stalled page); taking it again');
      await takeHelm();
      await bots((b) => b.keys('船长 Bram', { forward: 1, strafe: 0.5 }), null);
    }
    await until(async () => {
      list = await drawn();
      return list.some((e) => e.label === '船长 Bram' && e.posture === 'helm');
    }, 'Bram drawn at the helm from the shore', 60_000);
    const sp3 = await G((id) => window.__blocklands.game.session.replica.state.structures.get(id).structure.grid.position, ship.id);
    await lookAtPoint(sp3.x, sp3.y + 1, sp3.z);
    await shot('helm-from-shore', 'from the shore: the boat under way with its windmill, Bram at the wheel, his tag above');

    }
    // ---- the bots leave: nobody drawn, no tag left behind
    await bots((b) => {
      for (const n of b.names()) b.remove(n);
    }, null);
    await page.waitForTimeout(2500);
    list = await drawn();
    check(list.length === 0, `${list.length} players drawn after the bots left`);
    await shot('bots-left', 'the bots left: the boat sails on with nobody at the wheel drawn, no tag left behind');
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
  return { name, result, problems, notes, shots, cost, seconds: (Date.now() - t0) / 1000 };
}

if (doBuild) {
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
}
const results = [];
for (const r of renderers) {
  console.log(`\n== ${r} renderer`);
  results.push(await session(r));
}
console.log('\n== summary');
let failed = false;
for (const r of results) {
  console.log(`${r.result}  ${r.name.padEnd(8)} ${r.seconds.toFixed(0)}s  cost ${JSON.stringify(r.cost)}`);
  for (const p of r.problems) console.log(`      - ${p}`);
  if (r.result !== 'PASS') failed = true;
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
