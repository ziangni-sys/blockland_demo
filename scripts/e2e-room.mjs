#!/usr/bin/env node
// Two browser pages connected over real WebRTC (Playwright + Chromium; package 10 of NETCODE):
//
//   node scripts/e2e-room.mjs [--out DIR] [--no-build] [--only rtc|screens|game|ship|ship-cloud|offline|cloud]
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
// screens (package 11): every new screen and panel of playing together, rendered by the UI harness
//   (dev/ui) from state, in English and Chinese, as screenshots (screen-<name>-<lang>.png).
// game: two pages of the built game (dist/, WebGL2 on SwiftShader), driven through the UI with
//   clicks and typing (package 11; ?signal=broadcast): the host is asked its name, creates a world,
//   opens the room from the pause menu's room screen (the link copied); a guest opens the link, is
//   asked its name, and the loading screen shows the stages; the Tab list, the guest's room screen
//   and its diagnostics text (copied), the host makes the guest a survivor; the guest plays for a
//   minute (walk, place, mine), the host puts half slabs and a two-part cell over its head
//   (debug.slab), and the two replicas agree, partial cells included; the host removes the guest, who reads
//   why; the join screen refuses nonsense; the same identity and an unknown room end in their
//   messages with "Try again"; manual invitation codes copied between the pages; the host closing
//   the world; the host's page dying (reconnecting with "Give up", then the end). Each screen is
//   shot in English and Chinese (game-<step>-<lang>.png).
// ship (package 14, the two-page smoke test): two pages of the built game. The host builds a raft
//   (15 planks on the water by a beach) and a helm with clicks and keys, puts half slabs and a
//   two-part cell on its far row (debug.slab), opens the room through the
//   room screen; the guest opens the invitation link, flies over to the beach, lands and walks onto
//   the raft; the host assembles it and sails. While it sails, each page must see it move and draw
//   the other player, with the right name, where the server has them in the raft's frame (the
//   server's own view comes from the host page's Worker: debug.serverProbe); the host docks; both
//   replicas must then equal the server. Over the same-browser channel (?signal=broadcast).
//   Then scenario 37: the host page is slowed down (CPU throttling x10 for 12 s): the guest is
//   told, stays connected, the world goes on, and the notice goes once the host is fast again.
// ship-cloud: the same through the real public signalling service (0.peerjs.com); when the room
//   cannot open there (no network), the step says so plainly and passes.
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
const SHOT_VIEWPORT = { width: 960, height: 600 };
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
    console.error('usage: node scripts/e2e-room.mjs [--out DIR] [--no-build] [--only rtc|screens|game|ship|ship-cloud|offline|cloud]');
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

// ====================================================================== game: two pages of the real game, driven through the UI

async function runGame(browser) {
  const log = logger('game');
  const problems = [];
  const site = await distSite();
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site.url.replace(/\/$/, '') });
  // Errors the steps provoke on purpose: the failed joins and the ends of connections are logged as errors.
  const expected = (t) =>
    /\[blocklands\] (No room has this code|没有找到|You are already in this world|你已经在|The host closed the world|房主关闭|The host removed you|房主把你移出|Lost the connection to the host|与房主的连接断开)/.test(t);
  const pages = [];
  /** A page of the game at `search`; `named`: the name screen is expected first (and answered by typing `named`). */
  const open = async (name, search = '', { viewport = VIEWPORT, named = null, menu = true } = {}) => {
    const p = await context.newPage();
    await p.setViewportSize(viewport);
    watch(p, name, problems, expected);
    pages.push(p);
    await p.goto(site.url + search, { timeout: 60_000 });
    await p.waitForFunction(() => !!window.__blocklands, undefined, { timeout: 60_000 });
    await p.evaluate((rd) => window.__blocklands.game.changeSettings({ renderDistance: rd, showDebug: false, language: 'en' }), RENDER_DISTANCE);
    if (named !== null) {
      await p.waitForFunction(() => window.__blocklands.game.screen === 'name', undefined, { timeout: 30_000 });
      return p;
    }
    if (menu) await p.waitForFunction(() => window.__blocklands.game.screen === 'mainMenu', undefined, { timeout: 30_000 });
    return p;
  };
  const st = (p) => p.evaluate(() => window.__blocklands.game.debug.state());
  const frames2 = (p) => p.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
  /** A screenshot in English and in Chinese (the language switched for the second and back). */
  const shot = async (p, name) => {
    // The pages play small (software rendering on a shared machine); the pictures are taken larger.
    const size = p.viewportSize();
    await p.setViewportSize(SHOT_VIEWPORT);
    await frames2(p);
    await p.screenshot({ path: join(outDir, `game-${name}-en.png`) });
    await p.evaluate(() => window.__blocklands.game.changeSettings({ language: 'zh' }));
    await frames2(p);
    await p.screenshot({ path: join(outDir, `game-${name}-zh.png`) });
    await p.evaluate(() => window.__blocklands.game.changeSettings({ language: 'en' }));
    await p.setViewportSize(size);
    await frames2(p);
    log(`screenshots game-${name}-en.png, -zh.png`);
  };
  const waitReady = (p, timeout = 180_000) =>
    p.waitForFunction(() => {
      const s = window.__blocklands.game.debug.state();
      return s.sessionState === 'ready' && s.screen === 'none' && s.player !== null;
    }, undefined, { timeout, polling: 250 });
  const waitScreen = (p, screen, timeout = 30_000) => p.waitForFunction((sc) => window.__blocklands.game.screen === sc, screen, { timeout, polling: 100 });
  /** The join's end on the loading screen: its message. */
  const waitFailed = async (p, timeout = 60_000) => {
    // Clicks follow on this page: a page in the background may hit-test a stale layout.
    await p.bringToFront();
    await p.waitForSelector('.bl-screen[data-screen="loading"] .bl-loading-fail:not([hidden])', { timeout });
    return (await p.textContent('.bl-loading-fail-text')).trim();
  };
  const ROOM = '.bl-screen[data-screen="room"]';
  /** Esc during play opens the pause menu; "Play together" (or "Players") the room screen. */
  const toRoomScreen = async (p) => {
    await p.bringToFront();
    await p.keyboard.press('Escape');
    await waitScreen(p, 'pause');
    await p.click('.bl-screen[data-screen="pause"] [data-act="together"]');
    await waitScreen(p, 'room');
  };
  const backToPlay = async (p) => {
    await p.click(`${ROOM} .bl-room-panel > .bl-actions .bl-btn--primary`);
    await waitScreen(p, 'pause');
    await p.click('.bl-screen[data-screen="pause"] .bl-btn--primary');
    await waitScreen(p, 'none');
  };
  try {
    // ---- the host: asked for a name first, then a world from the menu
    const host = await open('host', '?signal=broadcast', { named: 'Hester' });
    await shot(host, '01-name');
    await host.fill('[data-field="name"]', '');
    await host.click('[data-act="name"]');
    check(await host.isVisible('.bl-screen[data-screen="name"] .bl-room-error'), 'an empty name was not refused');
    await host.fill('[data-field="name"]', 'Hester');
    await host.click('[data-act="name"]');
    await waitScreen(host, 'mainMenu');
    await shot(host, '02-menu');
    await host.fill('.bl-newworld input[type="text"] >> nth=0', 'Room');
    await host.fill('.bl-newworld .bl-num-input', SEED);
    await host.click('.bl-newworld .bl-form-submit');
    await waitReady(host);
    log('the host is in its world');

    // ---- the pause menu pauses a single-player world; the room screen opens the room
    await host.keyboard.press('Escape');
    await waitScreen(host, 'pause');
    await host.waitForFunction(() => window.__blocklands.game.debug.state().paused === true, undefined, { timeout: 10_000 });
    await shot(host, '03-pause-alone');
    await host.click('.bl-screen[data-screen="pause"] [data-act="together"]');
    await waitScreen(host, 'room');
    await shot(host, '04-room-closed');
    // Tab walks the room screen's controls and never into the HUD behind it (the HUD is inert under a screen).
    const tabbed = [];
    for (let i = 0; i < 30; i++) {
      await host.keyboard.press('Tab');
      tabbed.push(await host.evaluate(() => {
        const a = document.activeElement;
        return a === null || a === document.body ? 'body' : a.closest('.bl-hud') !== null ? 'HUD' : a.closest('.bl-screen[data-screen="room"]') !== null ? 'room' : 'other';
      }));
    }
    log(`Tab on the room screen: ${[...new Set(tabbed)].join(', ')}`);
    check(!tabbed.includes('HUD'), 'Tab reached the HUD behind the room screen');
    // Single play: the pause menu's mode switch carries the world's rules, so the room screen has none.
    check(!(await host.isVisible(`${ROOM} .bl-room-rules`)), 'the world rules show in single play');
    const t0 = Date.now();
    await host.click(`${ROOM} [data-act="open"]`);
    await host.waitForSelector(`${ROOM} .bl-room-status[data-status="open"]`, { timeout: 30_000 });
    const link = await host.inputValue(`${ROOM} .bl-room-invite .bl-copy input >> nth=0`);
    const code = await host.inputValue(`${ROOM} .bl-copy--code input`);
    log(`room open after ${Date.now() - t0} ms: code ${code}, link ${link}`);
    check(/\?join=[A-Z2-9]{8}&signal=broadcast$/.test(link) && link.startsWith(site.url), `not an invitation link: ${link}`);
    check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `not a room code: ${code}`);
    check((await st(host)).paused === false, 'the world stayed paused with the room open');
    await host.click(`${ROOM} [data-act="copy-link"]`);
    const clip = await host.evaluate(() => navigator.clipboard.readText());
    check(clip === link, `Copy put "${clip}" on the clipboard`);
    // Online the world's rules are set here (apart from the host's own mode).
    await host.click(`${ROOM} [data-act="rules"][data-mode="survival"]`);
    await host.waitForSelector(`${ROOM} [data-act="rules"][data-mode="survival"][aria-checked="true"]`, { timeout: 20_000 });
    await host.click(`${ROOM} [data-act="rules"][data-mode="creative"]`);
    await host.waitForSelector(`${ROOM} [data-act="rules"][data-mode="creative"][aria-checked="true"]`, { timeout: 20_000 });
    log('the world rules control works');
    await shot(host, '05-room-open');
    await backToPlay(host);

    // Every toast the host shows from now on (a toast lasts a few seconds; the guest's loading may take longer).
    await host.evaluate(() => {
      const g = window.__blocklands.game;
      const show = g.toast.bind(g);
      window.__toastsSeen = [];
      g.toast = (text, kind) => {
        window.__toastsSeen.push(text);
        show(text, kind);
      };
    });
    // ---- a guest opens the invitation link: asked for a name, then the stages of the join
    const guest = await open('guest', `${link.slice(link.indexOf('?'))}&slot=guest`, { named: 'Gus' });
    await guest.fill('[data-field="name"]', 'Gus');
    const tj = Date.now();
    await guest.click('[data-act="name"]');
    await waitScreen(guest, 'loading');
    const stagesSeen = new Set();
    for (let i = 0; i < 600 && (await guest.evaluate(() => window.__blocklands.game.screen)) === 'loading'; i++) {
      const stage = await guest.evaluate(() => window.__blocklands.game.debug.state().join?.stage ?? null);
      if (stage !== null && !stagesSeen.has(stage)) {
        stagesSeen.add(stage);
        if (stage === 'host' || stage === 'world') await shot(guest, `06-joining-${stage}`);
      }
      await guest.waitForTimeout(100);
    }
    await waitReady(guest);
    log(`the guest is in after ${((Date.now() - tj) / 1000).toFixed(1)} s; stages seen: ${[...stagesSeen].join(', ')}`);
    const guestAddress = await guest.evaluate(() => location.search);
    check(!guestAddress.includes('join=') && guestAddress.includes('signal=broadcast'), `the address still holds the join: ${guestAddress}`);
    check(stagesSeen.has('world'), 'the loading screen never showed the stages');
    let gs = await st(guest);
    check(gs.isHost === false && gs.netStatus === 'ready' && gs.workers.server === '—', 'the guest is not a ready guest without a server');
    await host.waitForFunction(() => window.__blocklands.game.debug.state().online.players.length === 2, undefined, { timeout: 20_000 });
    const hostToasts = await host.evaluate(() => window.__toastsSeen);
    check(hostToasts.includes('\u2068Gus\u2069 joined the world'), `no join toast on the host (${hostToasts.join(' | ')})`);

    // ---- the player list: held Tab during play; the room screens
    await guest.bringToFront();
    await guest.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await guest.keyboard.down('Tab');
    await guest.waitForSelector('.bl-plist:not([hidden])', { timeout: 10_000 });
    const plist = (await guest.textContent('.bl-plist')).replace(/\s+/g, ' ');
    log(`Tab list on the guest: ${plist}`);
    check(plist.includes('Hester') && plist.includes('Gus') && plist.includes('Host') && plist.includes('You'), 'the Tab list does not show both players');
    await shot(guest, '07-tab-list');
    await guest.keyboard.up('Tab');
    await toRoomScreen(guest);
    check(!(await guest.isVisible(`${ROOM} .bl-room-invite`)), 'the guest sees the invite section');
    check((await guest.$$(`${ROOM} [data-act="kick"], ${ROOM} [data-act="mode"]`)).length === 0, 'the guest has host controls');
    const ps = await st(guest);
    check(ps.paused === false, 'the guest page paused');
    await guest.click(`${ROOM} [data-act="diagnostics"]`);
    await guest.waitForFunction(() => (document.querySelector('.bl-screen[data-screen="room"] .bl-copy--diag textarea')?.value ?? '').includes('last error'), undefined, { timeout: 20_000 });
    const diag = await guest.inputValue('.bl-screen[data-screen="room"] .bl-copy--diag textarea');
    log(`diagnostics:\n      ${diag.split('\n').join('\n      ')}`);
    check(/role: guest/.test(diag) && /signalling: broadcast/.test(diag) && /webrtc host: (host|srflx|prflx|relay|\?) -> (host|srflx|prflx|relay|\?) \((udp|tcp|\?)\)/.test(diag), 'the diagnostics lack the role, the signalling or the candidate pair');
    check(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(diag) && !diag.includes('Gus') && !diag.includes('Hester') && !diag.includes(code.replace('-', '')), 'the diagnostics carry an address, a name or the code');
    const dclip = await guest.evaluate(() => navigator.clipboard.readText());
    check(dclip === diag, 'the diagnostics were not copied');
    await shot(guest, '08-room-guest-diagnostics');
    await guest.click(`${ROOM} .bl-room-panel > .bl-actions .bl-btn--primary`);
    await waitScreen(guest, 'pause');
    await shot(guest, '09-pause-guest');
    await guest.click('.bl-screen[data-screen="pause"] .bl-btn--primary');
    await waitScreen(guest, 'none');

    // ---- the host's room screen: two players
    await host.bringToFront();
    await toRoomScreen(host);
    const gusRow = `${ROOM} .bl-player:not(:first-child)`;
    await host.waitForSelector(gusRow, { timeout: 10_000 });
    // The guest's real mode is lit before the host set anything (the player table carries it), and
    // next to the guest the server's numbers for its connection (about once a second).
    await host.waitForSelector(`${gusRow} [data-act="mode"][data-mode="creative"][aria-checked="true"]`, { timeout: 10_000 });
    await host.waitForSelector(`${gusRow} .bl-player-link:not([hidden])`, { timeout: 20_000 });
    const linkText = (await host.textContent(`${gusRow} .bl-player-link`)).trim();
    log(`the host's row of the guest: ${linkText}`);
    check(/^\d+(\.\d)? (B|KB|MB)\/s · backlog \d+(\.\d)? (B|KB|MB) · rtt (\d+|–) ms$/.test(linkText), `not the guest's connection: ${linkText}`);
    await host.click(`${ROOM} [data-act="diagnostics"]`);
    await host.waitForFunction(() => (document.querySelector('.bl-screen[data-screen="room"] .bl-copy--diag textarea')?.value ?? '').includes('last error'), undefined, { timeout: 20_000 });
    const hostDiag = await host.inputValue('.bl-screen[data-screen="room"] .bl-copy--diag textarea');
    log(`host diagnostics:\n      ${hostDiag.split('\n').join('\n      ')}`);
    check(/role: host \(room open, 1 guest\)/.test(hostDiag) && /guest 1: (host|srflx|prflx|relay|\?) -> (host|srflx|prflx|relay|\?) \((udp|tcp|\?)\), rtt [^;]*; out [^;]*, in [^;]*; server sends [^,]+, backlog [^,]+, rtt/.test(hostDiag), "the host's diagnostics lack the guest's line");
    check(!hostDiag.includes('Gus') && !hostDiag.includes('Hester') && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(hostDiag), "the host's diagnostics carry a name or an address");
    await shot(host, '10-room-two-players');
    await backToPlay(host);

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
    // A minute at least, and until three blocks were placed and broken (a software renderer sharing
    // the machine with other browsers draws about one frame a second: a lap then takes half a minute,
    // and a lap may miss), five minutes at most.
    const playing = () => (Date.now() - playStart < 60_000 || placed < 3 || mined < 3) && Date.now() - playStart < 300_000;
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
    // Partial cells (docs/SHAPES.md 14.1: the host's debug command stands in for the M2.4 tools)
    // over the guest's head: a two-part cell (cobble below, planks above), a west half slab, an
    // upper half slab. The guest's replica must hold them before the digests are compared, so the
    // comparison covers both extra layers (holes, second parts).
    const gp = (await st(guest)).player;
    const px = Math.floor(gp.x);
    const py = Math.floor(gp.y) + 3;
    const pz = Math.floor(gp.z);
    const partial = [
      [px + 1, py, pz, 2, 3],
      [px + 1, py, pz, 10, 2],
      [px - 1, py, pz, 10, 1],
      [px, py, pz + 1, 2, 2],
    ];
    for (const [x, y, z, id, dir] of partial) {
      check(await host.evaluate(([x, y, z, id, dir]) => window.__blocklands.game.debug.slab(x, y, z, id, dir), [x, y, z, id, dir]), `the host cannot put a half slab at ${x} ${y} ${z}`);
      await host.waitForFunction(([x, y, z, id]) => (window.__blocklands.game.debug.parts(x, y, z) ?? []).some((p) => p.id === id), [x, y, z, id], { timeout: 10_000, polling: 100 });
    }
    await guest.waitForFunction(([x, y, z]) => (window.__blocklands.game.debug.parts(x, y, z) ?? []).length === 2, [px + 1, py, pz], { timeout: 20_000, polling: 100 });
    log(`the host put half slabs over the guest (a two-part cell at ${px + 1} ${py} ${pz}); the guest sees them`);
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

    // ---- the host makes the guest a survivor, then removes it (it asks first); the guest sees why
    await host.bringToFront();
    await toRoomScreen(host);
    await host.click(`${gusRow} [data-act="mode"][data-mode="survival"]`);
    await guest.waitForFunction(() => window.__blocklands.game.debug.state().player?.mode === 'survival', undefined, { timeout: 20_000 });
    check((await host.getAttribute(`${gusRow} [data-act="mode"][data-mode="survival"]`, 'aria-checked')) === 'true', "the host's row does not show the mode it set");
    log('the host made the guest a survivor');
    await host.click(`${gusRow} [data-act="kick"]`);
    await host.waitForSelector(`${ROOM} .bl-player--confirm`, { timeout: 5000 });
    await shot(host, '11-kick-confirm');
    await host.click(`${ROOM} [data-act="kick-yes"]`);
    const kicked = await waitFailed(guest, 30_000);
    log(`the removed guest reads: "${kicked}"`);
    check(/removed you from the room/.test(kicked), 'the removed guest was not told why');
    check(!(await guest.isVisible('[data-act="retry"]')), '"Try again" offered after a removal');
    await shot(guest, '12-guest-removed');
    await host.waitForFunction(() => window.__blocklands.game.debug.state().online.players.length === 1, undefined, { timeout: 20_000 });
    check((await st(guest)).pointerLocked === false, 'the pointer stayed locked over the message');
    await guest.click('[data-act="menu"]');
    await waitScreen(guest, 'mainMenu');

    // ---- the same identity as the host joins from the join screen: refused with its message
    const twin = await open('twin', '?signal=broadcast');
    await twin.click('[data-act="join-room"]');
    await waitScreen(twin, 'join');
    await twin.fill('[data-field="join"]', 'not a code');
    await twin.click('.bl-screen[data-screen="join"] [data-act="join"]');
    check(await twin.isVisible('.bl-screen[data-screen="join"] .bl-room-error'), 'nonsense was not refused on the join screen');
    await twin.fill('[data-field="join"]', code.toLowerCase());
    await shot(twin, '13-join-screen');
    await twin.click('.bl-screen[data-screen="join"] [data-act="join"]');
    const same = await waitFailed(twin);
    log(`same identity: "${same}"`);
    check(/already in this world/.test(same), 'the same identity was not told it is already in');
    await shot(twin, '14-refused-same-identity');
    // ... an unknown room: "Try again" and "Back to the menu"
    await twin.click('[data-act="menu"]');
    await waitScreen(twin, 'mainMenu');
    await twin.click('[data-act="join-room"]');
    // Esc gives a join up at once (here while it reaches the service).
    await twin.fill('[data-field="join"]', 'ZZZZ-ZZZZ');
    await twin.click('.bl-screen[data-screen="join"] [data-act="join"]');
    await waitScreen(twin, 'loading');
    // The page draws a frame a second here: wait for the screen to show (the button, and Esc with it).
    await twin.waitForSelector('[data-act="cancel"]:visible', { timeout: 10_000 }).catch(() => check(false, 'no way back while joining'));
    await twin.keyboard.press('Escape');
    await waitScreen(twin, 'mainMenu');
    log('Esc gave the join up');
    await twin.click('[data-act="join-room"]');
    await twin.fill('[data-field="join"]', 'ZZZZ-ZZZZ');
    const tu = Date.now();
    await twin.click('.bl-screen[data-screen="join"] [data-act="join"]');
    const unknown = await waitFailed(twin, BROADCAST_KNOCK_MS + 20_000);
    log(`unknown room after ${((Date.now() - tu) / 1000).toFixed(1)} s: "${unknown}"`);
    check(/No room has this code/.test(unknown) && (await twin.isVisible('[data-act="retry"]')), 'an unknown room was not told, with "Try again"');
    await shot(twin, '15-unknown-room');
    // A guest that never got in can copy diagnostics from the failure screen: how far its dial got.
    const LOADING = '.bl-screen[data-screen="loading"]';
    await twin.click(`${LOADING} [data-act="diagnostics"]`);
    await twin.waitForFunction((sel) => (document.querySelector(sel)?.value ?? '').includes('last dial'), `${LOADING} .bl-copy--diag textarea`, { timeout: 20_000 });
    const failDiag = await twin.inputValue(`${LOADING} .bl-copy--diag textarea`);
    log(`diagnostics on the failure screen:\n      ${failDiag.split('\n').join('\n      ')}`);
    check(/role: guest/.test(failDiag) && /signalling: broadcast/.test(failDiag) && /last error: join\.unknown/.test(failDiag) && /last dial: unknown; no webrtc handshake/.test(failDiag), 'the failure screen\'s diagnostics lack the failure');
    check(!failDiag.includes('ZZZZ') && !failDiag.includes('Hester'), 'the failure screen\'s diagnostics carry the code or a name');
    await twin.click('[data-act="retry"]');
    await waitFailed(twin, BROADCAST_KNOCK_MS + 20_000);
    await twin.click('[data-act="menu"]');
    await waitScreen(twin, 'mainMenu');
    await twin.close();
    pages.splice(pages.indexOf(twin), 1);

    // ---- manual invitation codes: the host closes the service room and opens one for codes
    await host.bringToFront();
    await toRoomScreen(host);
    await host.click(`${ROOM} [data-act="close"]`);
    await host.waitForSelector(`${ROOM} .bl-room-status[data-status="closed"]`, { timeout: 10_000 });
    await host.click(`${ROOM} [data-act="open-manual"]`);
    await host.waitForSelector(`${ROOM} [data-act="invite"]:visible`, { timeout: 10_000 });
    await host.click(`${ROOM} [data-act="invite"]`);
    await host.waitForFunction(() => (document.querySelector('.bl-room-invite .bl-copy--multi textarea')?.value ?? '').startsWith('BL1I.'), undefined, { timeout: 30_000 });
    const invite = await host.inputValue(`${ROOM} .bl-room-invite .bl-copy--multi textarea`);
    await shot(host, '16-room-invitation');
    const g2 = await open('guest-manual', '?signal=broadcast&slot=manual', { named: 'Mia' });
    // A name with a right-to-left override: kept without it, so it cannot reverse the text around it.
    await g2.fill('[data-field="name"]', '\u202EMia\u202C');
    await g2.click('[data-act="name"]');
    await waitScreen(g2, 'mainMenu');
    /** Join with invitation `code`; the answer code once shown (not `before`: a hidden box keeps the last one). */
    const manualJoin = async (code, before = null) => {
      await g2.click('[data-act="join-room"]');
      await g2.fill('[data-field="join"]', code);
      await g2.click('.bl-screen[data-screen="join"] [data-act="join"]');
      await g2.waitForFunction((old) => {
        const v = document.querySelector('.bl-loading-answer:not([hidden]) textarea')?.value ?? '';
        return v.startsWith('BL1A.') && v !== old;
      }, before, { timeout: 30_000 });
      return g2.inputValue('.bl-loading-answer textarea');
    };
    const answer1 = await manualJoin(invite);
    // The host may take long to paste the answer: the guest can always go back.
    const steps = (await g2.textContent('.bl-steps')).replace(/\s+/g, ' ');
    check(/Reading the invitation/.test(steps) && !/signalling service/.test(steps), `the manual join's steps: ${steps}`);
    await g2.evaluate(() => {
      const g = window.__blocklands.game;
      const show = g.toast.bind(g);
      window.__toastsSeen = [];
      g.toast = (text, kind) => {
        window.__toastsSeen.push(text);
        show(text, kind);
      };
    });
    await g2.click('[data-act="cancel"]');
    await waitScreen(g2, 'mainMenu');
    log('the manual guest went back while waiting for the host');
    // An invitation is one guest's offer (a second answer to it fails the handshake): the page says
    // a new one is needed, and does not try the old one again.
    const usedToast = () => g2.evaluate(() => window.__toastsSeen.filter((t) => t.startsWith('This invitation has been used')).length);
    check((await usedToast()) === 1, 'giving up an answered invitation did not say it is used');
    await g2.click('[data-act="join-room"]');
    await g2.fill('[data-field="join"]', invite);
    await g2.click('.bl-screen[data-screen="join"] [data-act="join"]');
    await g2.waitForFunction(() => window.__toastsSeen.filter((t) => t.startsWith('This invitation has been used')).length === 2, undefined, { timeout: 10_000 });
    check((await g2.evaluate(() => window.__blocklands.game.screen)) === 'join', 'the used invitation was tried again');
    await g2.click('.bl-screen[data-screen="join"] .bl-actions .bl-btn--ghost');
    await waitScreen(g2, 'mainMenu');
    await host.click(`${ROOM} [data-act="invite"]`);
    await host.waitForFunction((old) => {
      const v = document.querySelector('.bl-room-invite .bl-copy--multi textarea')?.value ?? '';
      return v.startsWith('BL1I.') && v !== old;
    }, invite, { timeout: 30_000 });
    const invite2 = await host.inputValue(`${ROOM} .bl-room-invite .bl-copy--multi textarea`);
    const answer = await manualJoin(invite2, answer1);
    log(`codes: invitation ${invite2.length} characters, answer ${answer.length}`);
    await shot(g2, '17-joining-answer');
    await host.fill(`${ROOM} [data-field="answer"]`, answer);
    await host.click(`${ROOM} [data-act="accept"]`);
    await waitReady(g2);
    log('the manual guest is in the world');
    await host.waitForFunction(() => window.__blocklands.game.debug.state().online.players.length === 2, undefined, { timeout: 20_000 });
    const miaRow = (await host.textContent(`${ROOM} .bl-player:not(:first-child) .bl-player-name`)).trim();
    check(miaRow === 'Mia', `the manual guest's name in the host's list: ${JSON.stringify(miaRow)}`);
    await shot(host, '18-room-manual-in');
    await backToPlay(host);

    // ---- the host closes the world: the guest sees it
    await host.keyboard.press('Escape');
    await waitScreen(host, 'pause');
    await host.click('.bl-screen[data-screen="pause"] .bl-btn--danger >> visible=true');
    await waitScreen(host, 'mainMenu', 60_000);
    const ended = await waitFailed(g2, 30_000);
    log(`host quit: the guest reads "${ended}"`);
    check(/host closed the world/.test(ended), 'the guest was not told the host closed the world');
    await shot(g2, '19-host-closed');
    await g2.click('[data-act="menu"]');
    await waitScreen(g2, 'mainMenu');

    // ---- the host's page dies while a guest is in: reconnecting (with Give up), then the end
    await host.evaluate(() => window.__blocklands.game.loadWorld(window.__blocklands.game.debug.state().worlds[0].id));
    await waitReady(host);
    await toRoomScreen(host);
    await host.click(`${ROOM} [data-act="open"]`);
    await host.waitForSelector(`${ROOM} .bl-room-status[data-status="open"]`, { timeout: 30_000 });
    const again = await host.inputValue(`${ROOM} .bl-room-invite .bl-copy input >> nth=0`);
    await g2.click('[data-act="join-room"]');
    await g2.fill('[data-field="join"]', again);
    await g2.click('.bl-screen[data-screen="join"] [data-act="join"]');
    await waitReady(g2);
    const t2 = Date.now();
    await host.close();
    pages.splice(pages.indexOf(host), 1);
    await g2.waitForSelector('[data-act="give-up"]:visible', { timeout: 90_000 });
    log(`host page closed: reconnecting after ${((Date.now() - t2) / 1000).toFixed(1)} s`);
    await shot(g2, '20-reconnecting');
    const gone = await waitFailed(g2, 90_000);
    log(`then after ${((Date.now() - t2) / 1000).toFixed(1)} s the guest reads "${gone}"`);
    check(/room is gone|could not reconnect/.test(gone), 'the guest was not told the host is gone');
    await shot(g2, '21-host-gone');
  } catch (e) {
    problems.push(e instanceof StepError ? e.message : `error: ${e.stack ?? e}`);
    for (const [i, p] of pages.entries()) await p.screenshot({ path: join(outDir, `game-failure-${i}.png`) }).catch(() => undefined);
  } finally {
    await context.close();
    await site.close();
  }
  return problems;
}

// ====================================================================== ship: two pages on one raft (package 14)

const SHIP_SEED = 'play-session';
const SHIP_RENDER_DISTANCE = 2;
const ITEM = { planks: 10, helm: 50 };
/** Face (Dir) index of a horizontal unit step. */
const faceOf = (dx, dz) => (dx === 1 ? 0 : dx === -1 ? 1 : dz === 1 ? 4 : 5);
/** The sea level's top water cell (SEA_LEVEL 48: water up to y 47). */
const SEA_Y = 47;
/** A player's position on the deck as two pages and the server see it may differ this much (blocks; scenario 31 asks 0.05 at renderTick). */
const DECK_TOLERANCE = 0.1;

/** A page of the game with the helpers the ship step drives it with (clicks and keys as a player; debug helpers only point the view, teleport and read). */
function shipPage(p, name, log) {
  const G = (fn, arg) => p.evaluate(fn, arg);
  const state = () => G(() => window.__blocklands.game.debug.state());
  const frames = (n = 3) =>
    G((k) => new Promise((res) => {
      let i = 0;
      const f = () => (++i >= k ? res() : requestAnimationFrame(f));
      requestAnimationFrame(f);
    }), n);
  const until = async (cond, what, timeout = 60_000, pollMs = 250) => {
    const end = Date.now() + timeout;
    while (!(await cond())) {
      if (Date.now() >= end) throw new StepError(`${name}: timed out waiting for ${what}`);
      await p.waitForTimeout(pollMs);
    }
  };
  const center = () => ({ x: p.viewportSize().width / 2, y: p.viewportSize().height / 2 });
  /** The game takes the mouse (pointer lock, or drag-to-look) with a click when it does not have it yet: a click then is not a game click. */
  const engage = async () => {
    if (await G(() => window.__blocklands.game.pointerLocked)) return;
    await p.bringToFront();
    await p.mouse.click(center().x, center().y);
    await p.waitForTimeout(400);
  };
  const lookAtPoint = async (x, y, z) => {
    await G(([x, y, z]) => {
      const d = window.__blocklands.game.debug;
      const pl = d.state().player;
      const dx = x - pl.shownX;
      const dy = y - (pl.shownY + pl.eyeHeight);
      const dz = z - pl.shownZ;
      d.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, [x, y, z]);
    await frames(3);
  };
  /** Point the view at a cell of a grid (0 = the world), at a face's centre when given; the target that results. */
  const aim = async (c, face = -1, gridId = 0) => {
    await G(([c, face, gridId]) => {
      const g = window.__blocklands.game;
      const r = g.session.replica;
      const grid = gridId === 0 ? r.world : r.state.structures.get(gridId).structure.grid;
      const D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const off = face >= 0 ? D[face] : [0, 0, 0];
      const w = grid.toWorld({ x: c.x + 0.5 + off[0] * 0.45, y: c.y + 0.5 + off[1] * 0.45, z: c.z + 0.5 + off[2] * 0.45 }, { x: 0, y: 0, z: 0 });
      const pl = g.debug.state().player;
      const dx = w.x - pl.shownX;
      const dy = w.y - (pl.shownY + pl.eyeHeight);
      const dz = w.z - pl.shownZ;
      g.debug.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, [c, face, gridId]);
    await frames(3);
    return (await state()).target;
  };
  const onTarget = (t, c, face = -1, gridId = 0) => t && t.gridId === gridId && t.x === c.x && t.y === c.y && t.z === c.z && (face < 0 || t.face === face);
  const cell = (c) => G((c) => window.__blocklands.game.debug.cell(c.x, c.y, c.z) & 1023, c);
  const rightClick = async () => {
    await engage();
    await p.mouse.click(center().x, center().y, { button: 'right' });
    await frames(2);
  };
  const select = async (item) => {
    const st = await state();
    const idx = st.inventory.hotbar.findIndex((s) => s !== null && s.item === item);
    check(idx >= 0, `${name}: no item ${item} in the hotbar`);
    await p.bringToFront();
    await p.keyboard.press(`Digit${idx + 1}`);
    await until(async () => {
      const inv = (await state()).inventory;
      return inv.hotbar[inv.selected]?.item === item;
    }, `item ${item} in hand`, 20_000);
  };
  /**
   * A double tap of Space (creative): flight on or off, until it is `on`. The two taps go to the
   * page in one turn of its event loop: the game wants them within FLY_TOGGLE_TICKS (300 ms), and
   * two Playwright key presses to a page drawing a frame or two a second can be 0.5 s apart.
   */
  const flight = async (on) => {
    for (let i = 0; i < 6; i++) {
      if ((await state()).player.flying === on) return;
      await p.bringToFront();
      await engage();
      await G(() => {
        for (const type of ['keydown', 'keyup', 'keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true }));
      });
      try {
        await until(async () => (await state()).player.flying === on, `flight ${on ? 'on' : 'off'}`, 6000, 150);
        return;
      } catch {
        // again
      }
    }
    const s = await state();
    const focus = await G(() => document.hasFocus());
    throw new StepError(`${name}: flight did not turn ${on ? 'on' : 'off'} (mode ${s.player.mode}, screen ${s.screen}, pointer locked ${s.pointerLocked}, focus ${focus})`);
  };
  /** The host's teleport (a host command; the server answers with a correction). */
  const teleport = async (x, y, z) => {
    await G(([x, y, z]) => window.__blocklands.game.debug.teleport(x, y, z), [x, y, z]);
    await until(async () => {
      const s = await state();
      return s.player !== null && Math.hypot(s.player.x - x, s.player.z - z) < 0.3 && Math.abs(s.player.y - y) < 0.6 && s.sessionState === 'ready';
    }, `the player at ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`);
    await frames(2);
  };
  /** Hold `keys` until `cond()` holds (polled here), then let go. */
  const holdUntil = async (keys, cond, what, timeout = 60_000, pollMs = 120) => {
    await p.bringToFront();
    for (const k of keys) await p.keyboard.down(k);
    try {
      await until(cond, what, timeout, pollMs);
    } finally {
      for (const k of keys) await p.keyboard.up(k);
    }
  };
  /** The players this page draws: entity id, name tag, posture, feet (world) and, on a ship, in the ship's frame at its display pose. */
  const drawn = () =>
    G(() => {
      const s = window.__blocklands.game.session;
      const r = s.replica;
      return (s.view.entityList ?? [])
        .filter((e) => e.kind === 'player')
        .map((e) => {
          const ship = [...r.state.structures.values()].find((x) => x.structure.kind === 'ship');
          const l = ship ? ship.structure.grid.toLocal({ x: e.x, y: e.y, z: e.z }, { x: 0, y: 0, z: 0 }) : null;
          return { id: e.id, label: e.label, posture: e.posture, x: e.x, y: e.y, z: e.z, shipId: ship ? ship.structure.id : 0, local: l };
        });
    });
  /**
   * This page's own player as predicted; `local`: the feet in its carrier's frame as its last
   * movement report gave them (the prediction's own conversion, at the poses of its client tick).
   */
  const own = () =>
    G(() => {
      const s = window.__blocklands.game.session;
      const p = s.own.player;
      const rep = s.own.rep;
      const l = rep.carrierId === p.carrierId ? { x: rep.pos.x, y: rep.pos.y, z: rep.pos.z } : null;
      return { id: s.replica.ownEntityId, carrierId: p.carrierId, steeringShipId: p.steeringShipId, onGround: p.onGround, flying: p.flying, x: p.pos.x, y: p.pos.y, z: p.pos.z, local: l };
    });
  return { p, name, G, state, frames, until, engage, lookAtPoint, aim, onTarget, cell, rightClick, select, flight, teleport, holdUntil, drawn, own, log };
}

/** Find a place for a raft near `spawn`: a beach cell at sea level with open water before it (the raft's 3 x 5 cells and a lane to sail). */
function findRaftSite(spawn) {
  const d = window.__blocklands.game.debug;
  const Y = 47;
  const id = (x, y, z) => d.cell(x, y, z) & 1023;
  const water = (x, y, z) => id(x, y, z) === 30;
  const air = (x, y, z) => id(x, y, z) === 0;
  const ground = (n) => n === 1 || n === 3 || n === 4 || n === 5 || n === 6 || n === 7;
  const sites = [];
  for (let x = Math.floor(spawn.x) - 40; x <= spawn.x + 40; x++) {
    for (let z = Math.floor(spawn.z) - 40; z <= spawn.z + 40; z++) {
      if (!ground(id(x, Y, z)) || !air(x, Y + 1, z) || !air(x, Y + 2, z)) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ux = -dz;
        const uz = dx;
        let ok = true;
        for (let i = 1; i <= 16 && ok; i++) {
          for (let k = -2; k <= 2 && ok; k++) {
            const cx = x + dx * i + ux * k;
            const cz = z + dz * i + uz * k;
            if (!water(cx, Y, cz) || !air(cx, Y + 1, cz) || !air(cx, Y + 2, cz)) ok = false;
            else if (i <= 5 && Math.abs(k) <= 1 && !water(cx, Y - 1, cz)) ok = false;
          }
        }
        if (ok) sites.push({ x, z, dx, dz, ux, uz, dist: Math.hypot(x - spawn.x, z - spawn.z) });
      }
    }
  }
  sites.sort((a, b) => a.dist - b.dist);
  return sites[0] ?? null;
}

/**
 * Package 14, the two-page smoke test: the host builds a raft and a helm by clicks and keys, opens
 * the room through the room screen; the guest joins through the invitation link, flies over to the
 * beach and walks onto the raft; the host assembles it and sails; both pages see the ship move,
 * each other on its deck where the server has them, and each other's name; the host docks; both
 * replicas equal the server. `signal`: the same-browser channel, or the real public service (when
 * it cannot be reached, the step says so and passes).
 */
async function runShip(browser, signal) {
  const log = logger(`ship-${signal}`);
  const problems = [];
  const site = await distSite();
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site.url.replace(/\/$/, '') });
  // Each page was asked its name before (the game step covers the name screen).
  await context.addInitScript(() => {
    localStorage.setItem('playerName', 'Hester');
    localStorage.setItem('playerName:guest', 'Gus');
    // The page's frame gaps (a page that draws no frame for 2 s sends no movement report: the
    // helmsman is let go of the wheel, by design), for the log.
    const gaps = { longest: 0, over2s: 0, last: 0 };
    window.__e2eGaps = gaps;
    const frame = (t) => {
      if (gaps.last > 0) {
        const d = t - gaps.last;
        gaps.longest = Math.max(gaps.longest, d);
        if (d >= 2000) gaps.over2s++;
      }
      gaps.last = t;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const pages = [];
  const tag = signal === 'cloud' ? 'ship-cloud' : 'ship';
  const gapsOf = async (g) => {
    const x = await g.G(() => window.__e2eGaps ?? null);
    return x === null ? 'no frame record' : `longest frame gap ${(x.longest / 1000).toFixed(1)} s, ${x.over2s} of 2 s or more`;
  };
  const shot = async (g, what) => {
    const size = g.p.viewportSize();
    await g.p.setViewportSize(SHOT_VIEWPORT);
    await g.frames(3);
    const file = join(outDir, `${tag}-${what}.png`);
    await g.p.screenshot({ path: file });
    await g.p.setViewportSize(size);
    await g.frames(2);
    log(`screenshot ${file}`);
  };
  const open = async (who, search) => {
    const p = await context.newPage();
    watch(p, who, problems);
    pages.push(p);
    await p.goto(site.url + search, { timeout: 60_000 });
    await p.waitForFunction(() => !!window.__blocklands, undefined, { timeout: 60_000 });
    await p.evaluate((rd) => window.__blocklands.game.changeSettings({ renderDistance: rd, showDebug: false, language: 'en' }), SHIP_RENDER_DISTANCE);
    return shipPage(p, who, log);
  };
  const playing = (g, timeout = 240_000) =>
    g.until(async () => {
      const s = await g.state();
      return s.sessionState === 'ready' && s.screen === 'none' && s.player !== null;
    }, 'play', timeout, 300);
  const ROOM = '.bl-screen[data-screen="room"]';
  const screenIs = (g, sc) => g.until(async () => (await g.G(() => window.__blocklands.game.screen)) === sc, `the ${sc} screen`, 30_000, 150);
  try {
    // ---- the host: a world from the menu
    const host = await open('host', signal === 'broadcast' ? '?signal=broadcast' : '');
    await screenIs(host, 'mainMenu');
    await host.p.fill('.bl-newworld input[type="text"] >> nth=0', 'Raft');
    await host.p.fill('.bl-newworld .bl-num-input', SHIP_SEED);
    await host.p.click('.bl-newworld .bl-form-submit');
    await playing(host);
    const spawn = (await host.state()).player;
    const raft = await host.G(findRaftSite, { x: spawn.x, z: spawn.z });
    check(raft !== null, 'no beach with open water near the spawn');
    log(`raft site: beach ${raft.x} ${SEA_Y} ${raft.z}, out along ${raft.dx} ${raft.dz} (${raft.dist.toFixed(1)} blocks from the spawn)`);
    // Cell i rows out from the beach, k across (row 0 is the beach cell itself).
    const at = (i, k, y = SEA_Y) => ({ x: raft.x + raft.dx * i + raft.ux * k, y, z: raft.z + raft.dz * i + raft.uz * k });
    const out = { x: raft.dx, z: raft.dz };
    const across = { x: raft.ux, z: raft.uz };

    // ---- the host builds the raft: 3 x 5 planks on the water, each placed against a neighbour's face from just beyond it
    await host.engage();
    await host.flight(true);
    await host.select(ITEM.planks);
    const place = async (c, from, step) => {
      const face = faceOf(step.x, step.z);
      for (let attempt = 0; attempt < 3; attempt++) {
        await host.teleport(c.x + 0.5 + step.x * 1.6, SEA_Y + 1.6, c.z + 0.5 + step.z * 1.6);
        const t = await host.aim(from, face);
        if (!host.onTarget(t, from, face)) {
          log(`placing at ${c.x} ${c.y} ${c.z}: the target is ${JSON.stringify(t)}, again`);
          continue;
        }
        await host.rightClick();
        try {
          await host.until(async () => (await host.cell(c)) === ITEM.planks, `planks at ${c.x} ${c.y} ${c.z}`, 20_000, 150);
          return;
        } catch {
          // again
        }
      }
      throw new StepError(`could not place planks at ${c.x} ${c.y} ${c.z}`);
    };
    const tb = Date.now();
    for (let i = 1; i <= 5; i++) {
      await place(at(i, 0), at(i - 1, 0), out);
      await place(at(i, 1), at(i, 0), across);
      await place(at(i, -1), at(i, 0), { x: -across.x, z: -across.z });
    }
    // The helm on row 2, facing out to sea (where the host looks while placing it), from the beach.
    await host.select(ITEM.helm);
    const helm = at(2, 0, SEA_Y + 1);
    await host.teleport(raft.x + 0.5, SEA_Y + 1.1, raft.z + 0.5);
    let helmed = false;
    for (let attempt = 0; attempt < 3 && !helmed; attempt++) {
      const t = await host.aim(at(2, 0), 2);
      if (!host.onTarget(t, at(2, 0), 2)) continue;
      await host.rightClick();
      helmed = await host.until(async () => (await host.cell(helm)) === ITEM.helm, 'the helm', 20_000, 150).then(() => true, () => false);
    }
    check(helmed, 'could not place the helm');
    // Partial cells on the far row of the deck (docs/SHAPES.md 14.1: the host's debug command stands
    // in for the M2.4 tools): lower planks half slabs, and a two-part cell (planks below, cobble
    // above). They sail with the raft and dock back with it, so the final comparison of the two
    // replicas with the server covers both extra layers.
    for (const [c, id, dir] of [[at(5, 1, SEA_Y + 1), ITEM.planks, 3], [at(5, -1, SEA_Y + 1), ITEM.planks, 3], [at(5, 0, SEA_Y + 1), ITEM.planks, 3], [at(5, 0, SEA_Y + 1), 2, 2]]) {
      check(await host.G(([c, id, dir]) => window.__blocklands.game.debug.slab(c.x, c.y, c.z, id, dir), [c, id, dir]), `the host cannot put a half slab at ${c.x} ${c.y} ${c.z}`);
      await host.until(async () => (await host.G(([c, id]) => (window.__blocklands.game.debug.parts(c.x, c.y, c.z) ?? []).some((p) => p.id === id), [c, id])), `a half slab at ${c.x} ${c.y} ${c.z}`, 20_000, 150);
    }
    await host.flight(false);
    await host.until(async () => (await host.own()).onGround, 'the host on the beach', 20_000);
    log(`the host built the raft (15 planks), the helm and 3 partial cells in ${((Date.now() - tb) / 1000).toFixed(0)} s`);
    await host.lookAtPoint(at(3, 0).x + 0.5, SEA_Y + 1.2, at(3, 0).z + 0.5);
    await shot(host, '01-raft-built');

    // ---- the room, through the room screen
    await host.p.bringToFront();
    await host.p.keyboard.press('Escape');
    await screenIs(host, 'pause');
    await host.p.click('.bl-screen[data-screen="pause"] [data-act="together"]');
    await screenIs(host, 'room');
    const to = Date.now();
    await host.p.click(`${ROOM} [data-act="open"]`);
    const opened = await host.p
      .waitForSelector(`${ROOM} .bl-room-status[data-status="open"]`, { timeout: signal === 'cloud' ? 30_000 : 20_000 })
      .then(() => true, () => false);
    if (!opened) {
      const why = (await host.p.textContent(`${ROOM} .bl-room-error`).catch(() => null))?.trim() ?? '';
      if (signal === 'cloud') {
        log(`THE PUBLIC SIGNALLING SERVICE COULD NOT BE REACHED (${why || 'the room did not open in 30 s'}): the run through it is skipped`);
        return problems;
      }
      throw new StepError(`the room did not open: ${why}`);
    }
    const link = await host.p.inputValue(`${ROOM} .bl-room-invite .bl-copy input >> nth=0`);
    log(`room open after ${Date.now() - to} ms (${signal}): ${link}`);
    check(signal === 'cloud' ? /\?join=[A-Z2-9]{8}$/.test(link) : /\?join=[A-Z2-9]{8}&signal=broadcast$/.test(link), `not an invitation link: ${link}`);
    await host.p.click(`${ROOM} .bl-room-panel > .bl-actions .bl-btn--primary`);
    await screenIs(host, 'pause');
    await host.p.click('.bl-screen[data-screen="pause"] .bl-btn--primary');
    await screenIs(host, 'none');

    // ---- the guest opens the invitation link
    const tj = Date.now();
    const guest = await open('guest', `${link.slice(link.indexOf('?'))}&slot=guest`);
    await playing(guest);
    const joinS = (Date.now() - tj) / 1000;
    log(`the guest is in ${joinS.toFixed(1)} s after opening the link`);
    const hostId = (await host.own()).id;
    const guestId = (await guest.own()).id;
    await host.until(async () => (await host.state()).online.players.length === 2, "the guest in the host's list", 20_000);
    /**
     * Go to x, z holding W, in short presses timed from the distance left (`speed` blocks a second):
     * reading the page's state takes a few hundred ms on a page drawing a frame or two a second, so
     * polling would overshoot; each press is followed by a pause for the motion to settle.
     */
    const goTo = async (x, z, speed, tol, what, keys = ['KeyW'], legs = 25) => {
      for (let leg = 0; leg < legs; leg++) {
        const g = await guest.own();
        const d = Math.hypot(g.x - x, g.z - z);
        if (d < tol) return;
        await guest.lookAtPoint(x, g.y + 1.62, z);
        await guest.p.bringToFront();
        for (const k of keys) await guest.p.keyboard.down(k);
        await guest.p.waitForTimeout(Math.max(60, Math.min(2000, ((d - tol / 2) / speed) * 1000 * 0.8)));
        for (const k of [...keys].reverse()) await guest.p.keyboard.up(k);
        await guest.p.waitForTimeout(700);
      }
      const g = await guest.own();
      throw new StepError(`${what}: the guest stopped at ${g.x.toFixed(2)} ${g.z.toFixed(2)}, ${Math.hypot(g.x - x, g.z - z).toFixed(2)} from it`);
    };
    const flyTo = (x, z, what) => goTo(x, z, 10, 0.5, what);
    // The guest flies over to the beach and lands there, then walks onto the raft. On a busy
    // machine the last legs of the flight can leave it a little more than the tolerance off the
    // beach, or let it come down beside the beach (on the grass, at another height): it then takes
    // off again and makes another approach, three in all.
    const beach = { x: raft.x + 0.5, z: raft.z + 0.5 };
    let landed = false;
    for (let attempt = 1; attempt <= 3 && !landed; attempt++) {
      await guest.flight(true);
      const g0 = await guest.own();
      const cruise = Math.max(g0.y, SEA_Y + 1) + 14;
      await guest.holdUntil(['Space'], async () => (await guest.own()).y >= cruise, 'the guest rising', 60_000);
      try {
        await flyTo(beach.x, beach.z, 'the guest flying to the beach');
      } catch (e) {
        if (!(e instanceof StepError) || attempt === 3) throw e;
        log(`approach ${attempt}: ${e.message}; again`);
        continue;
      }
      await guest.flight(false);
      await guest.until(async () => (await guest.own()).onGround, 'the guest coming down', 60_000);
      const g = await guest.own();
      const off = Math.hypot(g.x - beach.x, g.z - beach.z);
      landed = Math.abs(g.y - (SEA_Y + 1)) < 0.05 && off < 0.8;
      if (!landed) log(`approach ${attempt}: the guest came down at ${g.x.toFixed(2)} ${g.y.toFixed(2)} ${g.z.toFixed(2)}, ${off.toFixed(2)} from the beach; again`);
    }
    if (!landed) throw new StepError('the guest did not land on the beach in three approaches');
    // On the raft as a careful player does: sneaking (slow, and the sneak guard keeps a body from
    // walking off an edge; it also never sprints, which two presses of W close together would start).
    const walkTo = (c, what, tol = 0.45) => goTo(c.x, c.z, 1.3, tol, what, ['ShiftLeft', 'KeyW']);
    const stand = { x: at(4, 1).x + 0.5, z: at(4, 1).z + 0.5 };
    await walkTo({ x: at(1, 1).x + 0.5, z: at(1, 1).z + 0.5 }, 'the guest stepping onto the raft', 0.6);
    await walkTo(stand, 'the guest walking across the deck');
    await guest.until(async () => {
      const g = await guest.own();
      return g.onGround && Math.abs(g.y - (SEA_Y + 1)) < 0.05;
    }, 'the guest standing on the deck', 30_000);
    const gs = await guest.own();
    log(`the guest stands on the raft at ${gs.x.toFixed(2)} ${gs.y.toFixed(2)} ${gs.z.toFixed(2)}`);

    // ---- the host assembles at the helm and sails
    const shipNow = async (g) => (await g.state()).structures.find((s) => s.kind === 'ship') ?? null;
    let ship = null;
    for (let attempt = 0; attempt < 4 && ship === null; attempt++) {
      await host.select(ITEM.planks);
      const t = await host.aim(helm);
      if (!host.onTarget(t, helm)) continue;
      // First click: the preview; second: assemble (and take the wheel).
      await host.rightClick();
      await host.p.waitForTimeout(600);
      await host.rightClick();
      await host.until(async () => (await shipNow(host)) !== null && (await host.own()).steeringShipId !== 0, 'the raft assembled and steered', 20_000).catch(() => undefined);
      ship = await shipNow(host);
    }
    check(ship !== null, 'the raft did not assemble');
    log(`assembled ship #${ship.id} (${ship.cells} cells); the host steers it`);
    await guest.until(async () => (await guest.own()).carrierId === ship.id, 'the guest carried by the raft', 30_000);
    const start = { x: ship.x, z: ship.z };
    /** The host holds the wheel; a page stalled 2 s loses it (by design): take it again. */
    const keepHelm = async () => {
      if ((await host.own()).steeringShipId === ship.id) return;
      log(`the host was let go of the wheel (no movement report for 2 s: a stalled page; host ${await gapsOf(host)}, guest ${await gapsOf(guest)}); taking it again`);
      // Without a helmsman the throttle is 0 and the raft coasts. A page drawing a frame a second
      // aims at a moving helm with a stale picture: wait for the raft to drift to a stop first.
      let last = await serverShip();
      await host.until(async () => {
        const now = await serverShip();
        const moved = now && last ? Math.hypot(now.x - last.x, now.z - last.z) : 0;
        last = now;
        return moved < 0.05;
      }, 'the raft to coast', 60_000, 1000).catch(() => log('the raft is still drifting after 60 s; aiming anyway'));
      for (let i = 0; i < 8; i++) {
        const t = await host.aim(helm, -1, ship.id);
        if (host.onTarget(t, helm, -1, ship.id)) await host.rightClick();
        else log(`taking the wheel: the target is ${JSON.stringify(t)}, again`);
        const ok = await host.until(async () => (await host.own()).steeringShipId === ship.id, 'the wheel again', 10_000).then(() => true, () => false);
        if (ok) return;
      }
      throw new StepError(`the host cannot take the wheel again (host ${await gapsOf(host)})`);
    };
    // Full ahead: the throttle follows W while it is held (the raft has no sails: it paddles slowly).
    await host.p.bringToFront();
    await host.p.keyboard.down('KeyW');
    const serverShip = async () => (await host.G(() => window.__blocklands.game.debug.serverProbe(2))).structures.find((x) => x.id === ship.id) ?? null;
    const sailed = async () => {
      const s = await serverShip();
      return s ? Math.hypot(s.x - start.x, s.z - start.z) : 0;
    };
    await host.until(async () => {
      await keepHelm();
      return (await sailed()) > 2;
    }, 'the raft under way', 120_000, 500);
    log(`under way: throttle ${((await host.state()).helm?.throttle ?? 0).toFixed(2)}`);

    // ---- while it sails: both pages see it move, each other on its deck where the server has them, and the names
    const seen = { host: { max: 0, n: 0 }, guest: { max: 0, n: 0 }, ownHost: 0, ownGuest: 0, moved: { host: 0, guest: 0 } };
    const shipPos = async (g) => g.G((id) => {
      const st = window.__blocklands.game.session.replica.state.structures.get(id);
      return st ? { x: st.structure.grid.position.x, z: st.structure.grid.position.z } : null;
    }, ship.id);
    const p0 = { host: await shipPos(host), guest: await shipPos(guest) };
    const dist = (a, b) => Math.hypot(a.x - b.lx, a.y - b.ly, a.z - b.lz);
    let ahead = true;
    for (let i = 0; i < 8; i++) {
      await keepHelm();
      // Under power until the pictures are taken, or before the end of the lane checked for open
      // water (16 cells): then it coasts on.
      if (ahead && (i >= 3 || (await sailed()) > 12)) {
        await host.p.keyboard.up('KeyW');
        ahead = false;
      }
      // Each page looks at the other (the views drawn are compared).
      const sg = (await guest.own());
      const sh = (await host.own());
      await host.lookAtPoint(sg.x, sg.y + 1.2, sg.z);
      await guest.lookAtPoint(sh.x, sh.y + 1.2, sh.z);
      const probe = await host.G(() => window.__blocklands.game.debug.serverProbe(2));
      const srv = Object.fromEntries(probe.players.map((x) => [x.entityId, x]));
      check(srv[guestId]?.carrierId === ship.id, `the server does not have the guest on the raft: ${JSON.stringify(srv[guestId])}`);
      for (const [g, other, key] of [[host, guestId, 'host'], [guest, hostId, 'guest']]) {
        const d = (await g.drawn()).find((e) => e.id === other);
        check(d !== undefined, `${g.name} does not draw the other player`);
        check(d.label === (other === guestId ? 'Gus' : 'Hester'), `${g.name} shows the name ${JSON.stringify(d.label)}`);
        check(d.local !== null && d.shipId === ship.id, `${g.name} has no ship to measure the other player on`);
        const e = dist(d.local, srv[other]);
        seen[key].max = Math.max(seen[key].max, e);
        seen[key].n++;
        if (i === 0) log(`${g.name} draws ${d.label} (${d.posture}) at ${d.local.x.toFixed(3)} ${d.local.y.toFixed(3)} ${d.local.z.toFixed(3)} on the raft; the server has ${srv[other].lx.toFixed(3)} ${srv[other].ly.toFixed(3)} ${srv[other].lz.toFixed(3)}`);
        const mine = await g.own();
        check(mine.local !== null, `${g.name}'s last report is not on the raft`);
        const eo = dist(mine.local, srv[mine.id]);
        if (key === 'host') seen.ownHost = Math.max(seen.ownHost, eo);
        else seen.ownGuest = Math.max(seen.ownGuest, eo);
      }
      if (i === 2) {
        await shot(host, '02-host-sees-guest-on-deck');
        await shot(guest, '03-guest-sees-host-at-helm');
      }
      await host.p.waitForTimeout(800);
    }
    const p1 = { host: await shipPos(host), guest: await shipPos(guest) };
    seen.moved.host = Math.hypot(p1.host.x - p0.host.x, p1.host.z - p0.host.z);
    seen.moved.guest = Math.hypot(p1.guest.x - p0.guest.x, p1.guest.z - p0.guest.z);
    log(`frames while sailing: host ${await gapsOf(host)}, guest ${await gapsOf(guest)}`);
    log(`while sailing (${seen.host.n} samples): the raft moved ${seen.moved.host.toFixed(2)} blocks on the host's page, ${seen.moved.guest.toFixed(2)} on the guest's`);
    log(`on the deck, page vs server (blocks, in the raft's frame): the host draws the guest within ${seen.host.max.toFixed(4)}, the guest draws the host within ${seen.guest.max.toFixed(4)}; own prediction vs server: host ${seen.ownHost.toFixed(4)}, guest ${seen.ownGuest.toFixed(4)}`);
    check(seen.moved.host > 0.5 && seen.moved.guest > 0.5, 'a page does not see the raft move');
    check(seen.host.max < DECK_TOLERANCE && seen.guest.max < DECK_TOLERANCE, `a page draws the other player off its place on the deck (host ${seen.host.max.toFixed(3)}, guest ${seen.guest.max.toFixed(3)})`);
    check(seen.ownHost < DECK_TOLERANCE && seen.ownGuest < DECK_TOLERANCE, 'a page predicts its own player off the place the server has');

    // ---- the host lets go of W, the raft coasts to a stop, the host docks: sneak + right-click the helm while steering
    await host.p.keyboard.up('KeyW');
    let last = await serverShip();
    await host.until(async () => {
      const now = await serverShip();
      const moved = Math.hypot(now.x - last.x, now.z - last.z);
      last = now;
      return moved < 0.02;
    }, 'the raft to coast to a stop', 90_000, 1000);
    let docked = false;
    for (let i = 0; i < 4 && !docked; i++) {
      await keepHelm();
      const t = await host.aim(helm, -1, ship.id);
      if (!host.onTarget(t, helm, -1, ship.id)) continue;
      await host.p.keyboard.down('ShiftLeft');
      try {
        await host.p.waitForTimeout(300);
        await host.rightClick();
        docked = await host.until(async () => (await shipNow(host)) === null, 'the raft docked', 20_000).then(() => true, () => false);
      } finally {
        await host.p.keyboard.up('ShiftLeft');
      }
    }
    check(docked, 'the raft did not dock');
    await guest.until(async () => (await shipNow(guest)) === null, "the dock on the guest's page", 20_000);
    log('docked');
    await host.until(async () => (await host.own()).onGround && (await guest.own()).onGround, 'both players standing on the docked raft', 30_000);

    // ---- at the end both replicas equal the server (columns about each player, structures), and each player is where the server has it
    let diff = null;
    for (let i = 0; i < 20; i++) {
      const probe = await host.G(() => window.__blocklands.game.debug.serverProbe(2));
      diff = [];
      for (const g of [host, guest]) {
        const dg = await g.G(() => window.__blocklands.game.debug.digest(2));
        const shared = Object.keys(dg.columns).filter((k) => k in probe.columns);
        for (const k of shared) if (dg.columns[k] !== probe.columns[k]) diff.push(`${g.name} column ${k}`);
        if (shared.length < 9) diff.push(`${g.name} shares only ${shared.length} columns with the probe`);
        const srvS = Object.fromEntries(probe.structures.map((s) => [String(s.id), s.hash]));
        if (JSON.stringify(Object.keys(dg.structures).sort()) !== JSON.stringify(Object.keys(srvS).sort())) diff.push(`${g.name} structures ${Object.keys(dg.structures)} vs ${Object.keys(srvS)}`);
        else for (const k of Object.keys(srvS)) if (dg.structures[k] !== srvS[k]) diff.push(`${g.name} structure ${k}`);
        const mine = await g.own();
        const s = probe.players.find((x) => x.entityId === mine.id);
        const e = Math.hypot(mine.x - s.x, mine.y - s.y, mine.z - s.z);
        if (e > 0.05) diff.push(`${g.name} own player ${e.toFixed(3)} from the server's`);
      }
      if (diff.length === 0) {
        log(`the two replicas equal the server: ${Object.keys(probe.columns).length} columns probed, ${probe.structures.length} structures, both players where the server has them`);
        break;
      }
      await host.p.waitForTimeout(500);
    }
    check(diff.length === 0, `at the end: ${diff.join('; ')}`);
    await host.lookAtPoint((await guest.own()).x, SEA_Y + 2.2, (await guest.own()).z);
    await shot(host, '04-docked');
    if (signal === 'broadcast') await slowHost(host, guest, log);
  } catch (e) {
    problems.push(e instanceof StepError ? e.message : `error: ${e.stack ?? e}`);
    for (const [i, p] of pages.entries()) await p.screenshot({ path: join(outDir, `${tag}-failure-${i}.png`) }).catch(() => undefined);
  } finally {
    await context.close();
    await site.close();
  }
  return problems;
}

/**
 * Scenario 37 with real pages: the host's page is slowed down (CDP CPU throttling x10 for 12 s: a
 * weak laptop, a heavy frame; headless Chromium never reports a page hidden, and pages with WebRTC
 * are not frozen). Every guest byte passes the host page's main thread (the forwarder), so the guest
 * stops getting batches for seconds. The world goes on (the server's clock is in the Worker); the
 * guest is told (a notice under the context hint, section 4: either text, see NETCODE section 18
 * "工作包 14"); the guest stays connected; once the host page is fast again the notice goes (the
 * pill is hidden: its last text stays in the DOM while it fades) and ticks flow.
 */
/** How long the slow-host check throttles the host page (ms). */
const SLOW_HOST_MS = 12_000;
/** ... by this factor (CDP CPU throttling; the release itself waits for the slowed page, so x20 can last a minute and more). */
const SLOW_HOST_RATE = 10;

async function slowHost(host, guest, log) {
  /** The guest's visible notice and replica tick, in one cheap call. */
  const look = () =>
    guest.p.evaluate(() => {
      const pill = document.querySelector('.bl-hint[data-show="1"]');
      const line = pill?.querySelector('.bl-hint-notice');
      return { notice: line && !line.hidden ? line.textContent : null, tick: window.__blocklands.game.session?.replica?.state.tick ?? -1 };
    });
  const before = (await host.G(() => window.__blocklands.game.debug.serverProbe(0))).tick;
  const t0 = Date.now();
  const cdp = await host.p.context().newCDPSession(host.p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOW_HOST_RATE });
  // Released by the clock, whatever the pages are doing (a sample can take seconds).
  const released = new Promise((done) => setTimeout(() => cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).then(done, done), SLOW_HOST_MS));
  let releasedAt = null;
  void released.then(() => (releasedAt = Date.now()));
  const told = new Set();
  let flowing = 0;
  let samples = 0;
  let last = (await look()).tick;
  while (releasedAt === null) {
    await guest.p.waitForTimeout(1000);
    if (releasedAt !== null) break;
    const g = await look();
    samples++;
    if (g.notice !== null) told.add(g.notice);
    if (g.tick > last) flowing++;
    last = g.tick;
  }
  await released;
  log(`the host page slowed x${SLOW_HOST_RATE} for ${((releasedAt - t0) / 1000).toFixed(1)} s: the guest was told ${JSON.stringify([...told])}; ticks arrived in ${flowing} of ${samples} samples`);
  check(told.size > 0, 'the guest was told nothing while the host page was slowed down');
  // Back to normal: the notice goes and ticks flow again; the guest never reconnected.
  const tr = Date.now();
  let clear = 0;
  last = (await look()).tick;
  while (clear < 3 && Date.now() - tr < 90_000) {
    await guest.p.waitForTimeout(1000);
    const g = await look();
    clear = g.notice === null && g.tick > last ? clear + 1 : 0;
    last = g.tick;
  }
  log(`the guest's notice went and ticks flowed ${((Date.now() - tr) / 1000).toFixed(0)} s after the host page was fast again`);
  check(clear >= 3, `the guest still shows ${JSON.stringify((await look()).notice)} (or no ticks) 90 s after the host page was fast again`);
  const gs = await guest.state();
  check(gs.netStatus === 'ready' && gs.sessionState === 'ready', `the guest is ${gs.netStatus} / ${gs.sessionState} after the slow host`);
  check((await guest.G(() => window.__blocklands.game.session.net.connectionCount)) === 1, 'the guest reconnected during the slow host');
  const after = (await host.G(() => window.__blocklands.game.debug.serverProbe(0))).tick;
  const tps = (after - before) / ((Date.now() - t0) / 1000);
  log(`the server ran ${after - before} ticks meanwhile (${tps.toFixed(1)} a second)`);
  check(tps > 12, `the world did not go on while the host page was slowed (${tps.toFixed(1)} ticks a second)`);
}

// ====================================================================== screens: every new screen and panel in zh and en (dev/ui harness)

/** UI states of package 11 for the harness (dev/ui/main.ts URL parameters), each shot in both languages. */
const SCREENS = [
  ['name', 'screen=name&role=none'],
  ['menu', 'screen=mainMenu&role=none'],
  ['menu-offline', 'screen=mainMenu&role=none&online=0'],
  ['join', 'screen=join&role=none'],
  ['settings-name', 'screen=settings&from=mainMenu&role=none'],
  ['pause-alone', 'screen=pause&players=1'],
  ['pause-room-open', 'screen=pause&room=open&players=3'],
  ['pause-guest', 'screen=pause&role=guest&players=2'],
  ['pause-offline', 'screen=pause&online=0&players=1'],
  ['room-closed', 'screen=room&room=closed&players=1'],
  ['room-opening', 'screen=room&room=opening&players=1'],
  ['room-open-1', 'screen=room&room=open&players=1'],
  ['room-open-2', 'screen=room&room=open&players=2&traffic=1'],
  ['room-open-3', 'screen=room&room=open&players=3&traffic=1'],
  ['room-open-4', 'screen=room&room=open&players=4&traffic=1'],
  ['room-lost', 'screen=room&room=lost&players=2'],
  ['room-error', 'screen=room&room=error&players=1'],
  ['room-manual', 'screen=room&room=manual&players=1'],
  ['room-manual-making', 'screen=room&room=manual-making&players=1'],
  ['room-manual-invite', 'screen=room&room=manual-invite&players=1'],
  ['room-manual-answered', 'screen=room&room=manual-answered&players=2'],
  ['room-guest-diagnostics', 'screen=room&role=guest&players=3&diag=1'],
  ['loading-service', 'screen=loading&join=service&progress=0.02'],
  ['loading-host', 'screen=loading&join=host&progress=0.04'],
  ['loading-answer', 'screen=loading&join=answer&progress=0.04'],
  ['loading-world', 'screen=loading&join=world&progress=0.4'],
  ['loading-reconnecting', 'screen=loading&join=reconnecting&progress=0.05'],
  ['loading-failed', 'screen=loading&join=failed'],
  ['loading-removed', 'screen=loading&join=ended'],
  ['loading-other-build', 'screen=loading&join=build'],
  ['hud-tab-list', 'screen=none&locked=1&plist=1&room=open&players=4&traffic=1'],
];

async function runScreens(browser) {
  const log = logger('screens');
  const problems = [];
  const { createServer: createVite } = await import(join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
  const vite = await createVite({ configFile: join(ROOT, 'dev', 'ui', 'vite.config.ts'), cacheDir: join(outDir, '.vite-ui'), server: { port: 0, strictPort: false } });
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/dev/ui/`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  watch(page, 'screens', problems);
  try {
    for (const lang of ['en', 'zh']) {
      for (const [name, query] of SCREENS) {
        await page.goto(`${url}?${query}&lang=${lang}`);
        await page.waitForFunction(() => !!window.harness, undefined, { timeout: 60_000 });
        // After the screens' fade-in (0.2 s) and the panels' (0.24 s).
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(outDir, `screen-${name}-${lang}.png`) });
      }
      log(`${SCREENS.length} screens in ${lang}`);
    }
    // Phone width: the room screen and the join failure.
    await page.setViewportSize({ width: 390, height: 780 });
    for (const [name, query] of [
      ['room-open-3-narrow', 'screen=room&room=open&players=3&traffic=1'],
      ['loading-failed-narrow', 'screen=loading&join=failed'],
    ]) {
      await page.goto(`${url}?${query}&lang=en`);
      await page.waitForFunction(() => !!window.harness, undefined, { timeout: 60_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(outDir, `screen-${name}-en.png`) });
    }
  } catch (e) {
    problems.push(e instanceof StepError ? e.message : `error: ${e.stack ?? e}`);
  } finally {
    await page.close();
    await vite.close();
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
    log(`?join= in the single-file build: "${said.join(' | ')}"; screen ${state.screen}, online ${state.onlineAvailable}`);
    check(state.onlineAvailable === false && said.some((t) => /cannot go online|不能联机/.test(t)), 'the single-file build did not say it cannot go online');
    check(state.screen === 'mainMenu' && state.sessionState === null, 'the single-file build did not stay at the menu (no name screen either)');
    check(await page.isVisible('.bl-menu-offline'), 'the menu does not say this build cannot go online');
    check(!(await page.isVisible('[data-act="join-room"]')), 'the menu offers "Join a room" in the single-file build');
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
  for (const script of [...(want('game') || want('ship') || want('ship-cloud') ? ['build'] : []), ...(want('offline') ? ['build:artifact'] : [])]) {
    console.log(`npm run ${script}`);
    const r = spawnSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) process.exit(1);
  }
}
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = false;
for (const [name, run] of [
  ['rtc', runRtc],
  ['screens', runScreens],
  ['game', runGame],
  ['ship', (b) => runShip(b, 'broadcast')],
  ['ship-cloud', (b) => runShip(b, 'cloud')],
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
