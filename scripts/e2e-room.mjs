#!/usr/bin/env node
// Two browser pages connected over real WebRTC (Playwright + Chromium; package 10 of NETCODE):
//
//   node scripts/e2e-room.mjs [--out DIR] [--no-build] [--only rtc|screens|game|offline|cloud]
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
//   minute (walk, place, mine) and the two replicas agree; the host removes the guest, who reads
//   why; the join screen refuses nonsense; the same identity and an unknown room end in their
//   messages with "Try again"; manual invitation codes copied between the pages; the host closing
//   the world; the host's page dying (reconnecting with "Give up", then the end). Each screen is
//   shot in English and Chinese (game-<step>-<lang>.png).
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
    console.error('usage: node scripts/e2e-room.mjs [--out DIR] [--no-build] [--only rtc|screens|game|offline|cloud]');
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
      return s.sessionState === 'ready' && s.screen === 'none';
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
    await guest.waitForFunction(() => (document.querySelector('.bl-copy--diag textarea')?.value ?? '').includes('last error'), undefined, { timeout: 20_000 });
    const diag = await guest.inputValue('.bl-copy--diag textarea');
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
  ['room-open-2', 'screen=room&room=open&players=2&modes=1'],
  ['room-open-3', 'screen=room&room=open&players=3&modes=1'],
  ['room-open-4', 'screen=room&room=open&players=4&modes=1'],
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
  ['hud-tab-list', 'screen=none&locked=1&plist=1&room=open&players=4'],
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
      ['room-open-3-narrow', 'screen=room&room=open&players=3&modes=1'],
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
  ['screens', runScreens],
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
