#!/usr/bin/env node
// Two browser pages connected over real WebRTC (Playwright + Chromium; package 10 of NETCODE):
//
//   node scripts/e2e-room.mjs [--out DIR] [--no-build] [--only rtc|game|offline|cloud]
//
// rtc: two pages of dev/rtc (a Vite dev server this script starts) with the real
//   RTCPeerConnection, data channels and BroadcastChannel under src/net/webrtc:
//    - echo: a guest joins a room (BroadcastSignaller, loopback/host candidates only); messages
//      of 1 byte, 16 KiB - 1, 16 KiB, 16 KiB + 1, 1 MiB and 4 MiB go there and back whole and in
//      order; the channels are configured as section 2 says ('r' ordered and reliable, 'u'
//      unordered with no retransmits, negotiated, arraybuffer); closing either side is seen by
//      the other;
//    - ice: both sides strip their candidates: the join fails with 'ice' within its timeout;
//    - manual: the invitation and answer codes of ManualSignaller, copied by this script;
//    - server: a real ServerHost in one page (a flat world), the guest a
//      NetClient in the other: it reaches ready, its replica digest equals the server's view of
//      it (also after block changes), and the server's shutdown reaches it as Kick(shutdown).
// game: two pages of the built game (dist/, WebGL2 on SwiftShader): the host creates a world and
//   opens a room (broadcast), the guest joins with ?slot=guest through the debug helpers; the guest
//   plays for a minute (walk, place, mine) and the two replicas agree; a manual invitation; the
//   failures a player can meet end in their messages (unknown room, same identity, the host
//   closing the world, the host's page dying).
// offline: the single-file build says it cannot go online.
// cloud (only with --only cloud: it needs the network): two dev/rtc pages join through the real
//   public PeerJS server (CloudSignaller), messages go there and back, an unknown room is told.
//
// Screenshots go to --out (default: a fresh temp directory, printed at the end).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ARTIFACT = join(ROOT, 'dist-artifact', 'blocklands.html');
// Two pages draw with the software renderer on a shared machine: small pictures, short distance.
const VIEWPORT = { width: 480, height: 270 };
const HOST_VIEWPORT = { width: 320, height: 180 };
const RENDER_DISTANCE = 2;
const SEED = 'room-test';
const PLANKS = 10;
const KiB = 1024;
const SIZES = [1, 16 * KiB - 1, 16 * KiB, 16 * KiB + 1, 1024 * KiB, 4096 * KiB];
// Timeouts of the product (src/net/webrtc): the 'ice' failure comes ICE_TIMEOUT_MS after the
// answer; the gathering takes at most GATHER_TIMEOUT_MS a side; an unknown broadcast room
// BROADCAST_KNOCK_MS.
const ICE_TIMEOUT_MS = 15_000;
const GATHER_TIMEOUT_MS = 5000;
const BROADCAST_KNOCK_MS = 3000;

const argv = process.argv.slice(2);
let outDir = null;
let build = true;
let only = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') outDir = argv[++i];
  else if (a === '--no-build') build = false;
  else if (a === '--only') only = argv[++i].split(',');
  else {
    console.error('usage: node scripts/e2e-room.mjs [--out DIR] [--no-build] [--only rtc|game|offline|cloud]');
    process.exit(2);
  }
}
outDir = resolve(outDir ?? mkdtempSync(join(tmpdir(), 'blocklands-room-')));
mkdirSync(outDir, { recursive: true });
const want = (s) => (only === null ? s !== 'cloud' : only.includes(s));

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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serve(page) {
  const server = createServer((req, res) => {
    const body = page(req.url);
    if (body === null) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': body.type, 'cache-control': 'no-store' });
    res.end(body.data);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

function distSite() {
  return serve((u) => {
    const path = u.split('?')[0] === '/' ? '/index.html' : u.split('?')[0];
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST) || !existsSync(file)) return null;
    return { type: TYPES[extname(file)] ?? 'application/octet-stream', data: readFileSync(file) };
  });
}

function artifactSite() {
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>${readFileSync(ARTIFACT, 'utf8')}</body></html>`;
  return serve((u) => (u.split('?')[0] === '/' ? { type: TYPES['.html'], data: page } : null));
}

class StepError extends Error {}
const check = (cond, msg) => {
  if (!cond) throw new StepError(msg);
};
const results = [];
const t00 = Date.now();
function logger(name) {
  return (msg) => console.log(`  [${name}] ${((Date.now() - t00) / 1000).toFixed(1)}s ${msg}`);
}

/** Console errors and page errors of `page` go to `problems` unless they match `allowed`. */
function watch(page, name, problems, allowed = () => false) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !allowed(m.text())) problems.push(`${name} console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    if (!allowed(e.message)) problems.push(`${name} page error: ${e.message}`);
  });
}

// ====================================================================== rtc: the dev test page

async function runRtc(browser) {
  const log = logger('rtc');
  const problems = [];
  const { createServer: createVite } = await import(join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
  const vite = await createVite({ configFile: join(ROOT, 'dev', 'rtc', 'vite.config.ts'), server: { port: 0, strictPort: false } });
  await vite.listen();
  const addr = vite.httpServer.address();
  const url = `http://127.0.0.1:${addr.port}/dev/rtc/index.html`;
  const context = await browser.newContext();
  const open = async (name) => {
    const p = await context.newPage();
    // The ice step makes connections fail on purpose; nothing else may log an error.
    watch(p, name, problems);
    await p.goto(url);
    await p.waitForFunction(() => !!window.rtc, undefined, { timeout: 60_000 });
    return p;
  };
  try {
    // ---- echo
    let a = await open('host');
    let b = await open('guest');
    await a.evaluate(() => window.rtc.echoHost('ECHAAAAA'));
    const joined = await b.evaluate(() => window.rtc.echoJoin('ECHAAAAA'));
    log(`joined in ${joined.ms} ms (${joined.ok ? 'ok' : joined.failure})`);
    check(joined.ok, `the echo join failed: ${joined.failure}`);
    log(`channels: ${JSON.stringify(joined.config)}`);
    const [r, u] = joined.config;
    check(r.label === 'r' && r.id === 0 && r.negotiated && r.ordered === true && r.maxRetransmits === null && r.maxPacketLifeTime === null && r.binaryType === 'arraybuffer', 'the reliable channel is not configured as section 2 says');
    check(u.label === 'u' && u.id === 1 && u.negotiated && u.ordered === false && u.maxRetransmits === 0 && u.binaryType === 'arraybuffer', 'the unreliable channel is not unordered with no retransmits');
    const trips = await b.evaluate((sizes) => window.rtc.roundTrip(sizes), SIZES);
    const hostArrivals = (await a.evaluate(() => window.rtc.hostState())).arrivals;
    for (const t of trips) {
      const arrived = hostArrivals.find((x) => x.size === t.size && x.at >= t.sentAt);
      log(t.size < 0 ? `all sizes at once, in order: ${t.ok}` : `${t.size} bytes there and back in ${t.ms} ms (there ${arrived ? arrived.at - t.sentAt : '?'} ms, back ${arrived ? t.backAt - arrived.at : '?'} ms): ${t.ok}`);
    }
    check(trips.every((t) => t.ok), 'a message did not come back whole and equal');
    const burst = await b.evaluate(() => window.rtc.unreliable(200, 1000));
    log(`unreliable: ${burst.got} of ${burst.sent} came back (loopback loses nothing; the channel may)`);
    check(burst.got > 0, 'nothing came back on the unreliable channel');
    // The guest closes: the host sees it.
    await b.evaluate(() => window.rtc.closeGuest());
    const t0 = Date.now();
    await a.waitForFunction(() => window.rtc.hostState().closed.length === 1, undefined, { timeout: 15_000 });
    log(`guest closed: the host saw '${(await a.evaluate(() => window.rtc.hostState())).closed[0]}' after ${Date.now() - t0} ms`);
    // A second guest; the host closes: the guest sees it.
    await b.close();
    b = await open('guest2');
    check((await b.evaluate(() => window.rtc.echoJoin('ECHAAAAA'))).ok, 'the second echo join failed');
    await a.evaluate(() => window.rtc.closeHostSide());
    const t1 = Date.now();
    await b.waitForFunction(() => window.rtc.guestState().closed !== null, undefined, { timeout: 15_000 });
    log(`host closed: the guest saw '${(await b.evaluate(() => window.rtc.guestState())).closed}' after ${Date.now() - t1} ms`);
    await a.close();
    await b.close();

    // ---- ice: no candidates either way
    a = await open('host-ice');
    b = await open('guest-ice');
    await a.evaluate(() => window.rtc.echoHost('JCEFAAAA', true));
    const iceFail = await b.evaluate(() => window.rtc.echoJoin('JCEFAAAA', true));
    log(`without candidates: ${iceFail.ok ? 'connected (!)' : iceFail.failure} after ${iceFail.ms} ms`);
    check(!iceFail.ok && iceFail.failure === 'ice', `expected the 'ice' failure, got ${iceFail.ok ? 'a connection' : iceFail.failure}`);
    check(iceFail.ms <= ICE_TIMEOUT_MS + 2 * GATHER_TIMEOUT_MS + 2000, `the 'ice' failure took ${iceFail.ms} ms`);
    // An unknown room.
    const unknown = await b.evaluate(() => window.rtc.echoJoin('NQBQDYAA'));
    log(`unknown room: ${unknown.failure} after ${unknown.ms} ms`);
    check(unknown.failure === 'unknown' && unknown.ms <= BROADCAST_KNOCK_MS + 1000, 'an unknown room did not fail with unknown in time');
    await a.close();
    await b.close();

    // ---- manual codes, copied by this script
    a = await open('host-manual');
    b = await open('guest-manual');
    const invite = await a.evaluate(() => window.rtc.manualHost());
    log(`invitation code: ${invite.length} characters`);
    const answer = await b.evaluate((code) => window.rtc.manualJoin(code), invite);
    log(`answer code: ${answer.length} characters`);
    check(await a.evaluate((code) => window.rtc.manualAccept(code), answer), 'the host did not take the answer code');
    await b.waitForFunction(() => window.rtc.guestState().open, undefined, { timeout: 30_000 });
    const mtrip = await b.evaluate(() => window.rtc.roundTrip([5, 40_000]));
    check(mtrip.every((t) => t.ok), 'messages did not cross the manual connection');
    log('manual connection carries messages both ways');
    await a.close();
    await b.close();

    // ---- a real server and a NetClient over WebRTC
    a = await open('host-server');
    b = await open('guest-server');
    await a.evaluate(() => window.rtc.gameHost('SRVRAAAA'));
    const gj = await b.evaluate(() => window.rtc.gameJoin('SRVRAAAA', 'guestkey0001'));
    log(`the guest reached ready in ${gj.ms} ms (${gj.ok ? 'ok' : gj.failure}): ${JSON.stringify(await b.evaluate(() => window.rtc.guestNet()))}`);
    check(gj.ok, `the NetClient did not reach ready: ${gj.failure}`);
    const compare = async (what) => {
      let diff = null;
      for (let i = 0; i < 10; i++) {
        await b.waitForTimeout(500);
        const d = await b.evaluate(() => window.rtc.guestDigest());
        diff = await a.evaluate(([dg]) => window.rtc.compare('guestkey0001', dg), [d]);
        if (diff.length === 0) break;
      }
      log(`${what}: replica vs server ${diff.length === 0 ? 'equal' : diff.slice(0, 5).join('; ')}`);
      check(diff.length === 0, `${what}: the guest's replica differs from the server`);
    };
    await compare('after ready');
    await a.evaluate(() => window.rtc.hostEdit(40));
    await compare('after 40 block changes on the server');
    await a.evaluate(() => window.rtc.hostShutdown());
    await b.waitForFunction(() => window.rtc.guestNet().status === 'kicked', undefined, { timeout: 10_000 });
    log(`server shut down: the guest was kicked (${(await b.evaluate(() => window.rtc.guestNet())).kick})`);
    await b.screenshot({ path: join(outDir, 'rtc-guest.png') });
    await a.close();
    await b.close();
  } catch (e) {
    problems.push(e instanceof StepError ? e.message : `error: ${e.stack ?? e}`);
  } finally {
    await context.close();
    await vite.close();
  }
  return problems;
}

// ====================================================================== cloud: the real public signalling server

async function runCloud(browser) {
  const log = logger('cloud');
  const problems = [];
  const { createServer: createVite } = await import(join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
  const vite = await createVite({ configFile: join(ROOT, 'dev', 'rtc', 'vite.config.ts'), server: { port: 0, strictPort: false } });
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/dev/rtc/index.html`;
  const context = await browser.newContext();
  try {
    const open = async (name) => {
      const p = await context.newPage();
      watch(p, name, problems);
      await p.goto(url);
      await p.waitForFunction(() => !!window.rtc, undefined, { timeout: 60_000 });
      return p;
    };
    const a = await open('host');
    const b = await open('guest');
    const code = `C${Array.from({ length: 7 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('')}`;
    const t0 = Date.now();
    await a.evaluate((c) => window.rtc.echoHost(c, false, 'cloud'), code);
    log(`the host listens on 0.peerjs.com after ${Date.now() - t0} ms (room ${code})`);
    const j = await b.evaluate((c) => window.rtc.echoJoin(c, false, 'cloud'), code);
    log(`the guest joined in ${j.ms} ms (${j.ok ? 'ok' : j.failure})`);
    check(j.ok, `the join through the public server failed: ${j.failure}`);
    const trips = await b.evaluate(() => window.rtc.roundTrip([1, 20_000, 1 << 20]));
    check(trips.every((t) => t.ok), 'messages did not cross');
    const unknown = await b.evaluate(() => window.rtc.echoJoin('ZZZZZZZ2', false, 'cloud'));
    log(`an unknown room: ${unknown.failure} after ${unknown.ms} ms`);
    check(unknown.failure === 'unknown', 'an unknown room was not told');
  } catch (e) {
    problems.push(e instanceof StepError ? e.message : `error: ${e.stack ?? e}`);
  } finally {
    await context.close();
    await vite.close();
  }
  return problems;
}

// ====================================================================== game: two pages of the real game

async function runGame(browser) {
  const log = logger('game');
  const problems = [];
  const site = await distSite();
  const context = await browser.newContext({ viewport: VIEWPORT });
  // Errors the steps provoke on purpose: the failed joins and the ends of connections are logged as errors.
  const expected = (t) => /\[blocklands\] (No room has this code|没有找到|You are already in this world|你已经在|The host closed the world|房主关闭|Lost the connection to the host|与房主的连接断开)/.test(t);
  const pages = [];
  const open = async (name, search = '', viewport = VIEWPORT) => {
    const p = await context.newPage();
    await p.setViewportSize(viewport);
    watch(p, name, problems, expected);
    pages.push(p);
    await p.goto(site.url + search, { timeout: 60_000 });
    await p.waitForFunction(() => !!window.__blocklands, undefined, { timeout: 60_000 });
    await p.evaluate((rd) => window.__blocklands.game.changeSettings({ renderDistance: rd, showDebug: true, language: 'en' }), RENDER_DISTANCE);
    await p.waitForFunction(() => window.__blocklands.game.screen === 'mainMenu', undefined, { timeout: 30_000 });
    return p;
  };
  const st = (p) => p.evaluate(() => window.__blocklands.game.debug.state());
  const shot = async (p, name) => {
    await p.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
    await p.screenshot({ path: join(outDir, `game-${name}.png`) });
    log(`screenshot game-${name}.png`);
  };
  const toasts = (p) => p.evaluate(() => window.__blocklands.game.toasts.list.map((t) => t.text));
  const waitReady = (p, timeout = 180_000) =>
    p.waitForFunction(() => {
      const s = window.__blocklands.game.debug.state();
      return s.sessionState === 'ready' && s.screen === 'none';
    }, undefined, { timeout, polling: 250 });
  const waitMenu = (p, timeout) => p.waitForFunction(() => window.__blocklands.game.screen === 'mainMenu' && window.__blocklands.game.session === null, undefined, { timeout, polling: 100 });
  try {
    // ---- the host's world and room
    const host = await open('host', '', HOST_VIEWPORT);
    await host.fill('.bl-newworld input[type="text"] >> nth=0', 'Room');
    await host.fill('.bl-newworld .bl-num-input', SEED);
    await host.click('.bl-newworld .bl-form-submit');
    await waitReady(host);
    log('the host is in its world');
    const opened = await host.evaluate(() => window.__blocklands.game.debug.openRoom('broadcast', { iceServers: [] }));
    log(`room: ${JSON.stringify(opened)}`);
    check(opened.ok, `the room did not open: ${opened.error}`);
    await host.waitForFunction(() => window.__blocklands.game.debug.state().roomOpen === true, undefined, { timeout: 10_000 });

    // ---- a guest joins (a second identity in the same browser)
    const guest = await open('guest', '?slot=guest');
    const t0 = Date.now();
    check(await guest.evaluate((code) => window.__blocklands.game.debug.joinRoom('broadcast', code, { iceServers: [] }), opened.code), 'the guest could not start joining');
    await waitReady(guest);
    let gs = await st(guest);
    log(`the guest is in the world after ${((Date.now() - t0) / 1000).toFixed(1)} s: isHost ${gs.isHost}, ${gs.chunks} columns, players ${gs.players}, server ${gs.workers.server}`);
    check(gs.isHost === false && gs.netStatus === 'ready', 'the guest is not a ready guest');
    check(gs.workers.server === '—', 'the guest started a server of its own');
    await host.waitForFunction(() => window.__blocklands.game.debug.state().room.guests === 1, undefined, { timeout: 10_000 });
    await shot(guest, '01-guest-joined');
    await shot(host, '02-host-with-guest');

    // ---- the host idles in its settings screen (a still screen is drawn 4 times a second, not every
    // frame, which leaves the machine to the guest); the world does not pause while the room is open
    await host.keyboard.press('Escape');
    await host.waitForFunction(() => window.__blocklands.game.screen === 'pause', undefined, { timeout: 10_000 });
    await host.click('.bl-screen[data-screen="pause"] >> text=Settings');
    await host.waitForFunction(() => window.__blocklands.game.screen === 'settings', undefined, { timeout: 10_000 });
    const tick0 = (await st(host)).worldTime;
    await host.waitForTimeout(1500);
    const hs = await st(host);
    log(`host in its settings screen: paused ${hs.paused}, server ticks ${tick0} -> ${hs.worldTime}`);
    check(!hs.paused && hs.worldTime > tick0, 'the world paused while the room is open');

    // ---- a minute of play by the guest: walk, place, mine
    const center = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    // A few frames (a software renderer under load draws one or two a second).
    const frames = (p, n = 3) =>
      p.evaluate((k) => new Promise((res) => {
        let i = 0;
        const f = () => (++i >= k ? res() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }), n);
    await guest.bringToFront();
    await guest.mouse.click(center.x, center.y);
    await guest.waitForTimeout(500);
    await guest.keyboard.press('Digit1');
    const playStart = Date.now();
    let placed = 0;
    let mined = 0;
    let walked = 0;
    let laps = 0;
    // A minute at least, and four laps at least (a software renderer sharing the machine with other
    // browsers draws about one frame a second: a lap then takes half a minute), three minutes at most.
    const playing = () => (Date.now() - playStart < 60_000 || laps < 4) && Date.now() - playStart < 180_000;
    for (let lap = 0; playing(); lap++) {
      laps++;
      const p0 = (await st(guest)).player;
      await guest.evaluate((yaw) => window.__blocklands.game.debug.look(yaw, -0.1), (lap * Math.PI) / 2);
      await frames(guest, 2);
      await guest.keyboard.down('KeyW');
      await guest.waitForTimeout(2500);
      await guest.keyboard.up('KeyW');
      await frames(guest, 2);
      const p1 = (await st(guest)).player;
      walked += Math.hypot(p1.x - p0.x, p1.z - p0.z);
      // Look down in front and place planks on the ground, then break them again.
      await guest.evaluate(() => window.__blocklands.game.debug.look(window.__blocklands.game.debug.state().player.yaw, -0.9));
      await frames(guest, 3);
      const t = (await st(guest)).target;
      if (t === null || t.gridId !== 0) {
        log(`lap ${lap}: nothing to aim at (${JSON.stringify(t)})`);
        continue;
      }
      const D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][t.face];
      const cell = { x: t.x + D[0], y: t.y + D[1], z: t.z + D[2] };
      const cellId = (p) => p.evaluate((c) => window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023, cell);
      // A click that shows nothing is clicked again, as a person would (at a frame a second, a click
      // can land between the look and the target that follows it), three times at most.
      const clickUntil = async (button, done) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await guest.mouse.click(center.x, center.y, { button });
          try {
            await guest.waitForFunction(done, cell, { timeout: 8000, polling: 100 });
            return true;
          } catch {
            await frames(guest, 2);
          }
        }
        return false;
      };
      if (!(await clickUntil('right', (c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === 10))) {
        log(`lap ${lap}: no planks appeared at ${cell.x} ${cell.y} ${cell.z} (target ${t.x} ${t.y} ${t.z} face ${t.face}; hint ${(await st(guest)).hint})`);
        continue;
      }
      placed++;
      // The host sees the guest's block.
      await host.waitForFunction((c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) === 10, cell, { timeout: 20_000, polling: 100 });
      await frames(guest, 2);
      if (await clickUntil('left', (c) => (window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023) !== 10)) mined++;
      else log(`lap ${lap}: could not break the block at ${cell.x} ${cell.y} ${cell.z} (it is ${await cellId(guest)})`);
    }
    const after = await st(guest);
    log(`${((Date.now() - playStart) / 1000).toFixed(0)} s of play (${laps} laps): walked ${walked.toFixed(1)} blocks, placed ${placed}, broke ${mined}; guest ${after.stats.fps} fps, rtt ${Math.round(after.stats.rttMs)} ms`);
    check(walked > 3 && placed >= 3 && mined >= 3, 'the guest could not walk, place and break for a minute');
    await shot(guest, '03-guest-after-play');
    // The two replicas agree around the guest (the host's own replica is the server's, checked by the headless tests).
    let diff = null;
    for (let i = 0; i < 10; i++) {
      await guest.waitForTimeout(500);
      const dg = await guest.evaluate(() => window.__blocklands.game.debug.digest(2));
      const dh = await host.evaluate(() => window.__blocklands.game.debug.digest(6));
      diff = Object.keys(dg.columns).filter((k) => k in dh.columns && dh.columns[k] !== dg.columns[k]);
      const shared = Object.keys(dg.columns).filter((k) => k in dh.columns).length;
      const ships = Object.keys(dg.structures).filter((k) => dh.structures[k] !== dg.structures[k]);
      diff = diff.map((k) => `column ${k}`).concat(ships.map((k) => `structure ${k}`));
      if (diff.length === 0) {
        log(`replicas agree on ${shared} shared columns and ${Object.keys(dg.structures).length} structures`);
        check(shared >= 9, `only ${shared} columns in common`);
        break;
      }
    }
    check(diff.length === 0, `the replicas differ: ${diff.join(', ')}`);
    await guest.close();
    pages.splice(pages.indexOf(guest), 1);

    // ---- the same identity as the host: refused
    const twin = await open('twin');
    await twin.evaluate((code) => window.__blocklands.game.debug.joinRoom('broadcast', code, { iceServers: [] }), opened.code);
    await waitMenu(twin, 60_000);
    let said = await toasts(twin);
    log(`same identity: ${said.at(-1)}`);
    check(said.some((t) => /already in this world/.test(t)), 'the same identity was not told it is already in');
    // ---- an unknown room
    const t1 = Date.now();
    await twin.evaluate(() => window.__blocklands.game.debug.joinRoom('broadcast', 'ZZZZZZZZ', { iceServers: [] }));
    // While it knocks, the loading screen says what it waits for.
    await twin.waitForFunction(() => document.querySelector('.bl-loading')?.textContent?.includes('Connecting to the room'), undefined, { timeout: BROADCAST_KNOCK_MS });
    await waitMenu(twin, BROADCAST_KNOCK_MS + 10_000);
    said = await toasts(twin);
    log(`unknown room after ${((Date.now() - t1) / 1000).toFixed(1)} s: ${said.at(-1)}`);
    check(said.some((t) => /No room has this code/.test(t)), 'an unknown room was not told');
    await shot(twin, '04-unknown-room');
    await twin.close();
    pages.splice(pages.indexOf(twin), 1);

    // ---- a manual invitation (the broadcast room is closed first: one room at a time)
    const g2 = await open('guest-manual', '?slot=manual');
    await host.evaluate(() => window.__blocklands.game.debug.closeRoom());
    const manualRoom = await host.evaluate(() => window.__blocklands.game.debug.openRoom('manual', { iceServers: [] }));
    log(`manual room: ${JSON.stringify(manualRoom)}`);
    check(manualRoom.ok, 'the manual room did not open');
    const invite = await host.evaluate(() => window.__blocklands.game.debug.invite());
    check(typeof invite === 'string' && invite.startsWith('BL1I.'), 'no invitation code');
    await g2.evaluate((code) => window.__blocklands.game.debug.joinRoom('manual', code, { iceServers: [] }), invite);
    await g2.waitForFunction(() => window.__blocklands.game.debug.state().join?.answer, undefined, { timeout: 30_000 });
    const answer = (await st(g2)).join.answer;
    log(`codes: invitation ${invite.length} characters, answer ${answer.length}`);
    check(await host.evaluate((code) => window.__blocklands.game.debug.accept(code), answer), 'the host did not take the answer');
    await waitReady(g2);
    log('the manual guest is in the world');
    await shot(g2, '05-manual-guest');

    // ---- the host closes the world: the guest is told
    await host.evaluate(() => window.__blocklands.game.saveAndQuit());
    await waitMenu(g2, 30_000);
    said = await toasts(g2);
    log(`host quit: the guest says "${said.at(-1)}"`);
    check(said.some((t) => /host closed the world/.test(t)), 'the guest was not told the host closed the world');
    await shot(g2, '06-host-closed');

    // ---- the host's page dies: the guest is told the room is gone
    await host.waitForFunction(() => window.__blocklands.game.screen === 'mainMenu', undefined, { timeout: 30_000 });
    await host.evaluate(() => window.__blocklands.game.loadWorld(window.__blocklands.game.debug.state().worlds[0].id));
    await waitReady(host);
    const again = await host.evaluate(() => window.__blocklands.game.debug.openRoom('broadcast', { iceServers: [] }));
    await g2.evaluate((code) => window.__blocklands.game.debug.joinRoom('broadcast', code, { iceServers: [] }), again.code);
    await waitReady(g2);
    const t2 = Date.now();
    await host.close();
    pages.splice(pages.indexOf(host), 1);
    await waitMenu(g2, 90_000);
    said = await toasts(g2);
    log(`host page closed: after ${((Date.now() - t2) / 1000).toFixed(1)} s the guest says "${said.at(-1)}"`);
    check(said.some((t) => /room is gone|could not reconnect/.test(t)), 'the guest was not told the host is gone');
    await shot(g2, '07-host-gone');
  } catch (e) {
    problems.push(e instanceof StepError ? e.message : `error: ${e.stack ?? e}`);
    for (const [i, p] of pages.entries()) await p.screenshot({ path: join(outDir, `game-failure-${i}.png`) }).catch(() => undefined);
  } finally {
    await context.close();
    await site.close();
  }
  return problems;
}

// ====================================================================== offline: the single-file build

async function runOffline(browser) {
  const log = logger('offline');
  const problems = [];
  const site = await artifactSite();
  const page = await browser.newPage({ viewport: VIEWPORT });
  watch(page, 'artifact', problems);
  try {
    await page.goto(`${site.url}?join=ABCDEFGH&signal=cloud`);
    await page.waitForFunction(() => !!window.__blocklands, undefined, { timeout: 60_000 });
    await page.waitForFunction(() => window.__blocklands.game.toasts.list.length > 0, undefined, { timeout: 20_000 });
    const said = await page.evaluate(() => window.__blocklands.game.toasts.list.map((t) => t.text));
    const state = await page.evaluate(() => window.__blocklands.game.debug.state());
    log(`?join= in the single-file build: "${said.join(' | ')}"; screen ${state.screen}, online ${state.online}`);
    check(state.online === false && said.some((t) => /cannot go online|不能联机/.test(t)), 'the single-file build did not say it cannot go online');
    check(state.screen === 'mainMenu' && state.sessionState === null, 'the single-file build did not stay at the menu');
    const open = await page.evaluate(() => window.__blocklands.game.debug.joinRoom('cloud', 'ABCDEFGH'));
    check(open === false, 'joinRoom started in the single-file build');
    await page.screenshot({ path: join(outDir, 'offline.png') });
  } catch (e) {
    problems.push(e instanceof StepError ? e.message : `error: ${e.stack ?? e}`);
  } finally {
    await page.close();
    await site.close();
  }
  return problems;
}

// ====================================================================== main

if (build) {
  for (const script of [...(want('game') ? ['build'] : []), ...(want('offline') ? ['build:artifact'] : [])]) {
    console.log(`npm run ${script}`);
    const r = spawnSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) process.exit(1);
  }
}
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = false;
for (const [name, run] of [
  ['rtc', runRtc],
  ['game', runGame],
  ['offline', runOffline],
  ['cloud', runCloud],
]) {
  if (!want(name)) continue;
  console.log(`== ${name}`);
  const t = Date.now();
  const problems = await run(browser);
  const ok = problems.length === 0;
  failed ||= !ok;
  results.push(`${name}: ${ok ? 'PASS' : 'FAIL'} (${((Date.now() - t) / 1000).toFixed(0)} s)${ok ? '' : `\n    ${problems.join('\n    ')}`}`);
}
await browser.close();
console.log(`\n${results.join('\n')}\nscreenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
