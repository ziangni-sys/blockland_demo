/**
 * Package 11 at game level, headless: client/lobby.ts on the real server (the harness's ServerHost),
 * the real NetClient and replica, and package 10's fakes for WebRTC and the same-browser channel,
 * all on the LoopbackNet's virtual clock. The host page is a Lobby over the host's own client and a
 * RoomServer into the harness; each guest page is a Lobby over a NetClient whose transports come
 * from the Lobby's GuestJoin, wired as client/game.ts wires them (status -> Lobby.netStatus, batches
 * -> Lobby.onBatch, the end of a join -> the session torn down with the message kept).
 *
 * Covered: the paste rules (link, code, invitation code) and the name rules; opening a room and
 * joining by link and by code with the stages in order; the player list for the host and a guest;
 * join and leave toasts; setting a guest's mode; Kick (the guest's message, the lists, coming back
 * allowed); leaving; the host closing the world; reconnecting; a fifth player refused; another build
 * refused; the manual invitation codes; closing the room; a room that cannot open; the diagnostics.
 */
import { describe, expect, it } from 'vitest';
import { Lobby, parseJoinText, invitationLink, showRoomCode, type LobbyDeps, type LobbySession } from '../../src/client/lobby';
import { PLAYER_NAME_STORAGE, storedName, suggestedName } from '../../src/client/names';
import { dialFailureKey, type RoomServer, type SignalKind } from '../../src/client/room';
import { clientText } from '../../src/client/strings';
import { diagnosticsText, pairFromStats } from '../../src/client/diagnostics';
import { NetClient } from '../../src/net/client/netclient';
import { cleanName } from '../../src/net/names';
import { PortTransport, type PortLike } from '../../src/net/host/port';
import type { LoopbackNet } from '../../src/net/loopback';
import { BUILD_ID, MAX_PLAYERS } from '../../src/net/protocol';
import { BroadcastSignaller } from '../../src/net/webrtc/broadcast';
import { ManualSignaller } from '../../src/net/webrtc/manual';
import { DialError, type DialFailure, type Signaller } from '../../src/net/webrtc/signal';
import { generatorFromSpec } from '../../src/worldgen/generator';
import type { Language } from '../../src/ui/model';
import { counterRandom, FakeBroadcastHub, FakeRtcNet, netTimers } from '../net/fakertc';
import { FLAT, NetHarness, testMeta, type HeadlessClient } from '../net/harness';

const BASE = 'https://example.org/blocklands/';

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

class FakePort implements PortLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  peer: FakePort | null = null;
  closed = false;
  constructor(private readonly net: LoopbackNet) {}
  postMessage(message: unknown, transfer: Transferable[]): void {
    if (this.closed) return;
    const data = structuredClone(message, { transfer });
    const peer = this.peer!;
    this.net.schedule(this.net.now, () => {
      if (!peer.closed) peer.onmessage?.({ data } as MessageEvent);
    });
  }
  close(): void {
    this.closed = true;
  }
}

function memoryStore(): Map<string, string> & { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const m = new Map<string, string>() as Map<string, string> & { getItem(k: string): string | null; setItem(k: string, v: string): void };
  m.getItem = (k) => m.get(k) ?? null;
  m.setItem = (k, v) => void m.set(k, v);
  return m;
}

interface World {
  h: NetHarness;
  rtc: FakeRtcNet;
  hub: FakeBroadcastHub;
  host: HeadlessClient;
  hostLobby: Lobby;
  hostToasts: string[];
  pages: GuestPage[];
  /** Fail the signaller's listen (a service that cannot be reached). */
  listenFails: boolean;
}

let seed = 100;

function deps(w: { h: NetHarness; rtc: FakeRtcNet; hub: FakeBroadcastHub; listenFails?: boolean }, key: string, toasts: string[], lang: Language | (() => Language) = 'en'): LobbyDeps {
  const timers = netTimers(w.h.net);
  const random = counterRandom(seed++);
  return {
    online: true,
    lang: typeof lang === 'function' ? lang : () => lang,
    signaller: (kind: SignalKind): Signaller => {
      if (kind === 'manual') return new ManualSignaller({ random });
      const s = new BroadcastSignaller({ open: w.hub.open, timers, random });
      if (w.listenFails) s.listen = () => Promise.reject(new DialError('unreachable', 'test: no service'));
      return s;
    },
    connectDeps: () => ({ createPeer: w.rtc.createPeer, timers }),
    intervals: timers,
    random,
    now: () => w.h.net.now,
    baseUrl: BASE,
    service: 'broadcast',
    store: memoryStore(),
    slot: null,
    playerKey: key,
    toast: (text) => toasts.push(text),
    log: () => undefined,
  };
}

function hostSession(c: HeadlessClient): LobbySession {
  return {
    get welcome() {
      return c.welcome;
    },
    get players() {
      return c.state?.players ?? null;
    },
    get rules() {
      return c.state?.rules ?? null;
    },
    hostCommand: (cmd) => {
      c.hostCommand(cmd);
      return true;
    },
  };
}

/** A guest's page: a Lobby and a NetClient, wired as client/game.ts wires them. */
class GuestPage {
  readonly toasts: string[] = [];
  readonly lobby: Lobby;
  net: NetClient | null = null;
  readonly stages: string[] = [];
  private nextBeat = 0;

  constructor(
    private readonly w: World,
    readonly key: string,
    readonly name: string,
    private readonly build?: string,
  ) {
    this.lobby = new Lobby(deps(w, key, this.toasts));
    this.lobby.setPlayerName(name);
    w.pages.push(this);
  }

  join(text: string): void {
    const target = parseJoinText(text, 'broadcast');
    if (target === null) throw new Error(`not joinable: ${text}`);
    const lobby = this.lobby;
    const join = lobby.beginJoin(target, () => this.end());
    const net: NetClient = new NetClient({
      openTransport: join.openTransport,
      now: () => this.w.h.net.now,
      chunkSource: (spec) => {
        const gen = generatorFromSpec(spec);
        return { generate: (cx, cz, done) => done(gen.generate(cx, cz)) };
      },
      playerKey: this.key,
      name: lobby.playerName,
      viewRadius: 2,
      ...(this.build !== undefined ? { build: this.build } : {}),
    });
    net.onStatus = (s) => {
      if (this.net === net && lobby.netStatus(s, net)) this.end();
    };
    net.onBatch = (b) => lobby.onBatch(b);
    lobby.attach({
      get welcome() {
        return net.welcome;
      },
      get players() {
        return net.replica?.state.players ?? null;
      },
      get rules() {
        return net.replica?.state.rules ?? null;
      },
      hostCommand: () => false,
    });
    this.net = net;
    this.nextBeat = this.w.h.net.now;
    net.start();
  }

  /** The join ended for good (game.ts joinEnded): the session goes, the message stays. */
  private end(): void {
    const net = this.net;
    this.net = null;
    if (net !== null) {
      net.onStatus = null;
      if (net.status !== 'idle' && net.status !== 'closed') net.leave();
    }
    this.lobby.endWorld(true);
  }

  /** The player leaves (pause menu: leave the room). */
  leave(): void {
    const net = this.net;
    this.net = null;
    if (net !== null) {
      net.onStatus = null;
      net.leave();
    }
    this.lobby.endWorld();
  }

  tick(now: number): void {
    const net = this.net;
    if (net === null) return;
    net.frame(now);
    if (now >= this.nextBeat) {
      net.heartbeat(now);
      this.nextBeat += 1000;
    }
    const j = this.lobby.view().join;
    if (j !== null && this.stages[this.stages.length - 1] !== j.stage) this.stages.push(j.stage);
  }

  get ready(): boolean {
    return this.net?.status === 'ready';
  }
}

/** Run the virtual clock `ms`, every guest page getting frames and heartbeats. */
async function drive(w: World, ms: number, until?: () => boolean): Promise<void> {
  const end = w.h.net.now + ms;
  while (w.h.net.now < end) {
    await flush();
    w.h.run(10);
    for (const p of w.pages) p.tick(w.h.net.now);
    if (until?.()) return;
  }
  await flush();
}

async function waitFor(w: World, cond: () => boolean, ms = 60_000): Promise<void> {
  await drive(w, ms, cond);
  if (!cond()) throw new Error('condition not reached');
}

async function world(opts: { listenFails?: boolean } = {}): Promise<World> {
  const h = new NetHarness();
  await h.create(testMeta('lobby'), { generator: FLAT, exampleShip: false });
  const host = h.addClient('host', {}, { local: true, name: 'Hester', viewRadius: 2 });
  h.runUntil(() => host.ready, 30_000);
  const rtc = new FakeRtcNet(h.net);
  const hub = new FakeBroadcastHub(h.net);
  const hostToasts: string[] = [];
  const w: World = { h, rtc, hub, host, hostLobby: null as unknown as Lobby, hostToasts, pages: [], listenFails: opts.listenFails ?? false };
  const lobby = new Lobby(deps(w, 'host', hostToasts));
  const server: RoomServer = {
    connectGuest: () => {
      const ps = new FakePort(h.net);
      const pf = new FakePort(h.net);
      ps.peer = pf;
      pf.peer = ps;
      h.host.connect(new PortTransport(ps), false);
      return pf;
    },
    openRoom: () => void h.host.control({ type: 'openRoom' }),
    closeRoom: () => void h.host.control({ type: 'closeRoom' }),
  };
  lobby.beginHosting(server);
  lobby.attach(hostSession(host));
  // The host page hears its batches as game.ts does (the harness's client keeps its own hook).
  const prev = host.net.onBatch;
  host.net.onBatch = (b, r) => {
    prev?.(b, r);
    lobby.onBatch(b);
  };
  const prevStatus = host.net.onStatus;
  host.net.onStatus = (s) => {
    prevStatus?.(s);
    lobby.netStatus(s, host.net);
  };
  w.hostLobby = lobby;
  return w;
}

async function openRoom(w: World): Promise<string> {
  const p = w.hostLobby.openRoom('service');
  let res: Awaited<typeof p> | null = null;
  void p.then((r) => (res = r));
  await waitFor(w, () => res !== null, 10_000);
  const r = res as unknown as Awaited<typeof p>;
  expect(r.ok).toBe(true);
  await waitFor(w, () => w.h.host.netServer.roomOpen, 5000);
  return r.code!;
}

const names = (l: Lobby): string[] => l.view().players.map((p) => `${p.name}${p.host ? ' (host)' : ''}${p.you ? ' (you)' : ''}`);

// ====================================================================== pure rules

describe('what a player can paste to join', () => {
  it('an invitation link (its signal, the public service by default), a room code as typed, an invitation code; nothing else', () => {
    expect(parseJoinText('https://example.org/blocklands/?join=RXAMCDEF', 'broadcast')).toEqual({ kind: 'cloud', code: 'RXAMCDEF' });
    expect(parseJoinText(' http://127.0.0.1:5173/?slot=b&join=rxam-cdef&signal=broadcast#webgl2 ', 'cloud')).toEqual({ kind: 'broadcast', code: 'RXAMCDEF' });
    expect(parseJoinText('?join=RXAMCDEF', 'cloud')).toEqual({ kind: 'cloud', code: 'RXAMCDEF' });
    expect(parseJoinText('rxam cdef', 'cloud')).toEqual({ kind: 'cloud', code: 'RXAMCDEF' });
    expect(parseJoinText('RXAM-CDEF', 'broadcast')).toEqual({ kind: 'broadcast', code: 'RXAMCDEF' });
    expect(parseJoinText('BL1I.abc\n def', 'cloud')).toEqual({ kind: 'manual', code: 'BL1I.abcdef' });
    expect(parseJoinText('https://x/?join=BL1I.abc', 'cloud')).toEqual({ kind: 'manual', code: 'BL1I.abc' });
    for (const bad of ['', '   ', 'hello', 'RXAMCDE', 'RXAMCDEF1', 'RXAMCDE0', 'https://x/?join=', 'https://x/?join=nope', 'BL1A.answer']) expect(parseJoinText(bad, 'cloud'), bad).toBeNull();
  });

  it('the invitation link is the page address with ?join=<code> (and &signal= when not the public service); a code shows in two groups', () => {
    expect(invitationLink(BASE, 'RXAMCDEF', 'cloud')).toBe(`${BASE}?join=RXAMCDEF`);
    expect(invitationLink(BASE, 'RXAMCDEF', 'broadcast')).toBe(`${BASE}?join=RXAMCDEF&signal=broadcast`);
    expect(showRoomCode('RXAMCDEF')).toBe('RXAM-CDEF');
    expect(parseJoinText(invitationLink(BASE, 'RXAMCDEF', 'broadcast'), 'cloud')).toEqual({ kind: 'broadcast', code: 'RXAMCDEF' });
    expect(parseJoinText(showRoomCode('RXAMCDEF'), 'cloud')).toEqual({ kind: 'cloud', code: 'RXAMCDEF' });
  });
});

describe('the player name', () => {
  it('the page keeps a name by the server\'s rule (net/names.ts; its cases are in tests/net/names.test.ts)', () => {
    const h = new NetHarness();
    const lobby = new Lobby(deps({ h, rtc: new FakeRtcNet(h.net), hub: new FakeBroadcastHub(h.net) }, 'k0', []));
    expect(lobby.setPlayerName('  \u202Eevil\u202C  ')).toBe(true);
    expect(lobby.playerName).toBe('evil');
    expect(lobby.setPlayerName('\u200B \u2067')).toBe(false);
    expect(lobby.playerName).toBe('evil');
  });

  it('the suggestion: short, original, the same for the same key, in the player language; never "Player"', () => {
    const keys = Array.from({ length: 200 }, (_, i) => `${i.toString(16).padStart(32, '0')}`);
    for (const lang of ['zh', 'en'] as const) {
      const all = keys.map((k) => suggestedName(k, lang));
      for (const n of all) {
        expect(cleanName(n)).toBe(n);
        expect(n).not.toMatch(/player/i);
      }
      expect(new Set(all).size).toBeGreaterThan(60);
      expect(suggestedName(keys[7]!, lang)).toBe(all[7]);
    }
    expect(suggestedName(keys[3]!, 'en')).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it('asked once: nothing stored until a name is kept; kept per identity slot; a bad name changes nothing', async () => {
    const h = new NetHarness();
    const w = { h, rtc: new FakeRtcNet(h.net), hub: new FakeBroadcastHub(h.net) };
    const d = deps(w, 'k1', []);
    const store = d.store as ReturnType<typeof memoryStore>;
    const a = new Lobby(d);
    expect(a.nameChosen).toBe(false);
    expect(a.playerName).toBe(suggestedName('k1', 'en'));
    expect(storedName(store, null)).toBeNull();
    expect(a.setPlayerName('   ')).toBe(false);
    expect(a.nameChosen).toBe(false);
    expect(a.setPlayerName('  Ada \u0007')).toBe(true);
    expect(store.get(PLAYER_NAME_STORAGE)).toBe('Ada');
    expect(new Lobby(d).nameChosen).toBe(true);
    expect(new Lobby(d).playerName).toBe('Ada');
    // Another slot of the same browser has its own.
    const b = new Lobby({ ...d, slot: 'b' });
    expect(b.nameChosen).toBe(false);
    b.setPlayerName('Bea');
    expect(store.get(`${PLAYER_NAME_STORAGE}:b`)).toBe('Bea');
    expect(new Lobby(d).playerName).toBe('Ada');
  });
});

describe('connection diagnostics', () => {
  it('the selected candidate pair with its types, round trip and bytes; never an address', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP2' }],
      ['CP1', { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'failed' }],
      ['CP2', { id: 'CP2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R2', state: 'succeeded', nominated: true, currentRoundTripTime: 0.042, bytesSent: 5000, bytesReceived: 90000 }],
      ['L2', { id: 'L2', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', address: '203.0.113.7', port: 50123 }],
      ['R2', { id: 'R2', type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.20', port: 61000 }],
    ]);
    const pair = pairFromStats(report)!;
    expect(pair).toEqual({ local: 'srflx', remote: 'host', protocol: 'udp', rttMs: 42, bytesSent: 5000, bytesReceived: 90000 });
    // Firefox marks the pair itself.
    const ff = new Map<string, Record<string, unknown>>([
      ['P', { id: 'P', type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R', bytesSent: 1, bytesReceived: 2 }],
      ['L', { id: 'L', type: 'local-candidate', candidateType: 'relay', protocol: 'tcp' }],
      ['R', { id: 'R', type: 'remote-candidate', candidateType: '1.2.3.4' }],
    ]);
    expect(pairFromStats(ff)).toMatchObject({ local: 'relay', remote: '?', protocol: 'tcp', rttMs: null });
    expect(pairFromStats(new Map())).toBeNull();
    const text = diagnosticsText({
      build: 'abc1234',
      role: 'guest',
      signal: 'cloud',
      roomOpen: null,
      link: { pair, outPerSec: 1200, inPerSec: 15000 },
      guests: [],
      rttMs: 45,
      loss: 0.012,
      delayTicks: 1.42,
      inPerSec: 14800,
      outPerSec: 1100,
      serverTps: 19.96,
      netStatus: 'ready',
      lastError: null,
    });
    expect(text).toContain('build: abc1234');
    expect(text).toContain('role: guest');
    expect(text).toContain('signalling: cloud');
    expect(text).toContain('webrtc host: srflx -> host (udp), rtt 42 ms; out 1.2 KB/s, in 14.6 KB/s');
    expect(text).toContain('loss: 1.2 %');
    expect(text).toContain('interpolation delay: 1.42 ticks');
    expect(text).toContain('server tps: 20.0');
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+|:\d{4,5}\b/);
    // The host: one line per guest, its link and what the server measures of it, no names.
    const host = diagnosticsText({
      build: 'abc1234',
      role: 'host',
      signal: 'broadcast',
      roomOpen: true,
      link: null,
      guests: [
        { link: { pair, outPerSec: 4300, inPerSec: 2900 }, server: { bytesPerSec: 4405, backlogBytes: 0, rttMs: 48 } },
        { link: null, server: { bytesPerSec: 812, backlogBytes: 3100, rttMs: 0 } },
        { link: { pair: null, outPerSec: null, inPerSec: null }, server: null },
      ],
      rttMs: null,
      loss: null,
      delayTicks: null,
      inPerSec: null,
      outPerSec: null,
      serverTps: 20,
      netStatus: 'ready',
      lastError: null,
    });
    expect(host).toContain('role: host (room open, 3 guests)');
    expect(host).toContain('guest 1: srflx -> host (udp), rtt 42 ms; out 4.2 KB/s, in 2.8 KB/s; server sends 4.3 KB/s, backlog 0 B, rtt 48 ms');
    expect(host).toContain('guest 2: no webrtc link; server sends 812 B/s, backlog 3.0 KB, rtt -');
    expect(host).toContain('guest 3: no candidate pair yet; out -, in -; server: no report yet');
    expect(host).not.toContain('webrtc host');
  });
});

describe('every way a first join fails ends with its message on the loading screen, with "try again"', () => {
  it('each DialFailure of package 10', async () => {
    const codes: DialFailure[] = ['unreachable', 'unknown', 'taken', 'bad_code', 'no_answer', 'left', 'ice'];
    for (const code of codes) {
      const h = new NetHarness();
      const w = { h, rtc: new FakeRtcNet(h.net), hub: new FakeBroadcastHub(h.net) };
      let lang: Language = 'en';
      const d = deps(w, 'k', [], () => lang);
      const lobby = new Lobby({
        ...d,
        signaller: () => ({ kind: 'broadcast', patienceMs: 1000, onLost: null, listen: () => Promise.resolve(), close: () => undefined, dial: () => Promise.reject(new DialError(code, 'test')) }),
      });
      let ended = 0;
      const join = lobby.beginJoin({ kind: 'broadcast', code: 'RXAMCDEF' }, () => ended++);
      expect(lobby.view().join).toMatchObject({ stage: 'service', canRetry: true });
      join.openTransport(
        () => undefined,
        () => undefined,
      );
      await flush();
      expect(ended).toBe(1);
      expect(lobby.view().join, code).toMatchObject({ stage: 'failed', error: clientText('en', dialFailureKey(code)), canRetry: true, wasIn: false });
      // The message follows the language.
      lang = 'zh';
      expect(lobby.view().join!.error).toBe(clientText('zh', dialFailureKey(code)));
      lang = 'en';
      expect(lobby.view().role).toBe('guest');
      lobby.clearJoin();
      expect(lobby.view().join).toBeNull();
      expect(lobby.view().role).toBeNull();
    }
  });
});

// ====================================================================== on the server

describe('playing together, headless (package 11)', { timeout: 120_000 }, () => {
  it('open a room; join by link and by code (stages in order); the player list for host and guests; join toasts', async () => {
    const w = await world();
    expect(w.hostLobby.view().room).toMatchObject({ status: 'closed', code: null, link: null });
    expect(w.hostLobby.view().pauses).toBe(true);
    const code = await openRoom(w);
    const room = w.hostLobby.view().room!;
    expect(room).toMatchObject({ status: 'open', signal: 'broadcast', code: showRoomCode(code), link: `${BASE}?join=${code}&signal=broadcast` });
    expect(w.hostLobby.view().pauses).toBe(false);
    expect(w.hostToasts).toContain(clientText('en', 'room.open', { code: showRoomCode(code) }));

    const ann = new GuestPage(w, 'ann', 'Ann');
    ann.join(room.link!);
    await waitFor(w, () => ann.ready);
    expect(ann.stages).toEqual(['service', 'host', 'world']);
    const bob = new GuestPage(w, 'bob', 'Bob');
    bob.join(room.code!.toLowerCase());
    await waitFor(w, () => bob.ready);
    await drive(w, 300);
    expect(names(w.hostLobby)).toEqual(['Hester (host) (you)', 'Ann', 'Bob']);
    expect(names(ann.lobby)).toEqual(['Hester (host)', 'Ann (you)', 'Bob']);
    expect(ann.lobby.view().role).toBe('guest');
    expect(ann.lobby.view().room).toBeNull();
    expect(ann.lobby.view().pauses).toBe(false);
    expect(w.hostToasts).toContain('\u2068Ann\u2069 joined the world');
    expect(w.hostToasts).toContain('\u2068Bob\u2069 joined the world');
    expect(ann.toasts).toContain('\u2068Bob\u2069 joined the world');
    expect(ann.toasts.some((t) => t.includes('Ann joined'))).toBe(false);
    expect(bob.toasts.filter((t) => t.includes('joined'))).toEqual([]); // the table of its Welcome is no news
    expect(w.h.sim.players.online()).toHaveLength(3);
  });

  it("every list shows each player's mode (the player table carries it); the host sets a guest's; guests have no host controls", async () => {
    const w = await world();
    await openRoom(w);
    const ann = new GuestPage(w, 'ann', 'Ann');
    ann.join(w.hostLobby.view().room!.code!);
    await waitFor(w, () => ann.ready);
    const annId = ann.net!.welcome!.entityId;
    const hostId = w.host.welcome!.entityId;
    const modeIn = (l: Lobby, id: number): string | undefined => l.view().players.find((p) => p.entityId === id)?.mode;
    expect(w.h.sim.players.get('ann')!.player.mode).toBe('creative');
    // Before the host sets anything, its buttons show the guest's real mode, and so does the guest's list.
    expect(modeIn(w.hostLobby, annId)).toBe('creative');
    expect(modeIn(ann.lobby, annId)).toBe('creative');
    expect(modeIn(ann.lobby, hostId)).toBe('creative');
    const toastsBefore = [w.hostToasts.length, ann.toasts.length];
    expect(w.hostLobby.setPlayerMode(annId, 'survival')).toBe(true);
    // Shown only once the server says so (the next batch's player table), on every page.
    expect(modeIn(w.hostLobby, annId)).toBe('creative');
    await waitFor(w, () => modeIn(w.hostLobby, annId) === 'survival' && modeIn(ann.lobby, annId) === 'survival', 5000);
    expect(w.h.sim.players.get('ann')!.player.mode).toBe('survival');
    expect(w.h.sim.players.get('host')!.player.mode).toBe('creative');
    expect(modeIn(ann.lobby, hostId)).toBe('creative');
    // A mode change is not a join or a leave: no toasts.
    expect([w.hostToasts.length, ann.toasts.length]).toEqual(toastsBefore);
    // Whatever changes a mode on the server shows (here the simulation itself, as a survival world rule would not).
    w.h.sim.players.get('host')!.setMode('survival');
    await waitFor(w, () => modeIn(ann.lobby, hostId) === 'survival' && modeIn(w.hostLobby, hostId) === 'survival', 5000);
    // Not the host's own player through this control; a guest's lobby has no host commands.
    expect(w.hostLobby.setPlayerMode(hostId, 'creative')).toBe(false);
    expect(ann.lobby.setPlayerMode(hostId, 'creative')).toBe(false);
    expect(ann.lobby.kick(hostId)).toBe(false);
    // A guest who joins later gets everyone's mode in its Welcome.
    const bob = new GuestPage(w, 'bob', 'Bob');
    bob.join(w.hostLobby.view().room!.code!);
    await waitFor(w, () => bob.ready);
    expect(modeIn(bob.lobby, annId)).toBe('survival');
    expect(modeIn(bob.lobby, hostId)).toBe('survival');
  });

  it("the host sees each guest's connection next to its row and per guest in the diagnostics; guests do not", async () => {
    const w = await world();
    await openRoom(w);
    const ann = new GuestPage(w, 'ann', 'Ann');
    ann.join(w.hostLobby.view().room!.code!);
    await waitFor(w, () => ann.ready);
    const annId = ann.net!.welcome!.entityId;
    // The server's status report (host control, about once a second while guests are in).
    w.hostLobby.guestTraffic([{ entityId: annId, name: 'Ann', bytesPerSec: 4321, backlogBytes: 12, rttMs: 57 }]);
    const row = w.hostLobby.view().players.find((p) => p.entityId === annId)!;
    expect(row.traffic).toEqual({ bytesPerSec: 4321, backlogBytes: 12, rttMs: 57 });
    expect(w.hostLobby.view().players.find((p) => p.you)!.traffic).toBeNull();
    expect(ann.lobby.view().players.every((p) => p.traffic === null)).toBe(true);
    let text = '';
    void w.hostLobby.diagnostics(() => ({ rttMs: null, loss: null, delayTicks: null, serverTps: 20, netStatus: 'ready', traffic: null })).then((x) => (text = x));
    await waitFor(w, () => text !== '', 5000);
    expect(text).toContain('role: host (room open, 1 guest)');
    // The link is the guest's (matched through the entity id its Welcome gave); the fake peers have no statistics.
    expect(text).toContain('guest 1: no candidate pair yet; out -, in -; server sends 4.2 KB/s, backlog 12 B, rtt 57 ms');
    expect(text).not.toContain('guest 2');
    expect(text).not.toContain('Ann');
    // The next report replaces it; a guest gone from it has no numbers.
    w.hostLobby.guestTraffic([]);
    expect(w.hostLobby.view().players.find((p) => p.entityId === annId)!.traffic).toBeNull();
  });

  it('kick: the removed guest sees why (no "try again"); the lists update; the leave toast; coming back is allowed', async () => {
    const w = await world();
    await openRoom(w);
    const ann = new GuestPage(w, 'ann', 'Ann');
    const bob = new GuestPage(w, 'bob', 'Bob');
    ann.join(w.hostLobby.view().room!.link!);
    bob.join(w.hostLobby.view().room!.link!);
    await waitFor(w, () => ann.ready && bob.ready);
    w.hostLobby.kick(ann.net!.welcome!.entityId);
    await waitFor(w, () => ann.lobby.view().join?.stage === 'failed', 5000);
    expect(ann.lobby.view().join).toMatchObject({ stage: 'failed', error: clientText('en', 'kick.kicked'), canRetry: false, wasIn: true });
    expect(ann.net).toBeNull();
    expect(ann.lobby.lastError).toMatch(/^kick\.kicked/);
    await drive(w, 500);
    expect(names(w.hostLobby)).toEqual(['Hester (host) (you)', 'Bob']);
    expect(names(bob.lobby)).toEqual(['Hester (host)', 'Bob (you)']);
    expect(w.hostToasts).toContain('\u2068Ann\u2069 left the world');
    expect(bob.toasts).toContain('\u2068Ann\u2069 left the world');
    // Rejoining is allowed while the room is open.
    ann.lobby.clearJoin();
    ann.join(w.hostLobby.view().room!.link!);
    await waitFor(w, () => ann.ready);
    await drive(w, 300);
    expect(names(w.hostLobby)).toEqual(['Hester (host) (you)', 'Ann', 'Bob']);
  });

  it('a guest leaves: the others hear it; the host closes the world: the guests see that, with no "try again"', async () => {
    const w = await world();
    await openRoom(w);
    const ann = new GuestPage(w, 'ann', 'Ann');
    const bob = new GuestPage(w, 'bob', 'Bob');
    ann.join(w.hostLobby.view().room!.link!);
    bob.join(w.hostLobby.view().room!.link!);
    await waitFor(w, () => ann.ready && bob.ready);
    bob.leave();
    await drive(w, 500);
    expect(bob.lobby.view().join).toBeNull();
    expect(bob.lobby.view().role).toBeNull();
    expect(w.hostToasts).toContain('\u2068Bob\u2069 left the world');
    expect(names(ann.lobby)).toEqual(['Hester (host)', 'Ann (you)']);
    const shut = w.h.host.shutdown(false);
    await waitFor(w, () => ann.lobby.view().join?.stage === 'failed', 10_000);
    await shut;
    expect(ann.lobby.view().join).toMatchObject({ error: clientText('en', 'kick.shutdown'), canRetry: false, wasIn: true });
  });

  it('the link dies: reconnecting, then back in; a fifth player is refused (try again offered); another build is refused (no try again)', async () => {
    const w = await world();
    await openRoom(w);
    const pages = ['ann', 'bob', 'cy'].map((k) => new GuestPage(w, k, k.toUpperCase()));
    for (const p of pages) p.join(w.hostLobby.view().room!.link!);
    await waitFor(w, () => pages.every((p) => p.ready));
    expect(w.hostLobby.view().players).toHaveLength(MAX_PLAYERS);

    const fifth = new GuestPage(w, 'dee', 'Dee');
    fifth.join(w.hostLobby.view().room!.link!);
    await waitFor(w, () => fifth.lobby.view().join?.stage === 'failed');
    expect(fifth.lobby.view().join).toMatchObject({ error: clientText('en', 'refuse.full'), canRetry: true, wasIn: false });

    const other = new GuestPage(w, 'old', 'Old', 'old-build');
    other.join(w.hostLobby.view().room!.link!);
    await waitFor(w, () => other.lobby.view().join?.stage === 'failed');
    expect(other.lobby.view().join).toMatchObject({ error: clientText('en', 'refuse.build'), canRetry: false });
    expect(BUILD_ID).not.toBe('old-build');

    // Cy's link dies at both ends (ICE consent fails): reconnecting, then a full join again.
    const cy = pages[2]!;
    const before = cy.net!.connectionCount;
    const cyPeers = [...w.rtc.peers.values()].filter((p) => p.connectionState === 'connected');
    // Abort only the channels of Cy's connection: its transport is the join's.
    const t = cy.lobby.currentJoin!.transport!;
    for (const p of cyPeers) for (const ch of p.channels) if ((t as unknown as { reliable: unknown }).reliable === ch) ch.abort();
    await waitFor(w, () => cy.lobby.view().join?.stage === 'reconnecting', 30_000);
    await waitFor(w, () => cy.ready && cy.lobby.view().join?.stage === 'world', 60_000);
    expect(cy.net!.connectionCount).toBeGreaterThan(before);
    expect(pages.every((p) => p.ready)).toBe(true);
  });

  it('manual invitation codes: the host makes one, the guest pastes it and gets an answer, the host pastes that: the guest is in', async () => {
    const w = await world();
    const res = w.hostLobby.openRoom('manual');
    let out: Awaited<typeof res> | null = null;
    void res.then((r) => (out = r));
    await waitFor(w, () => out !== null, 5000);
    expect(out).toMatchObject({ ok: true, code: null });
    expect(w.hostLobby.view().room).toMatchObject({ status: 'open', signal: 'manual', code: null, link: null, invitation: null });
    const inv = w.hostLobby.makeInvitation();
    expect(w.hostLobby.view().room!.inviting).toBe(true);
    let code: string | null = null;
    void inv.then((c) => (code = c));
    await waitFor(w, () => code !== null, 10_000);
    expect(w.hostLobby.view().room).toMatchObject({ invitation: code, inviting: false });
    const ann = new GuestPage(w, 'ann', 'Ann');
    ann.join(code!);
    await waitFor(w, () => ann.lobby.view().join?.answer != null, 10_000);
    const answer = ann.lobby.view().join!.answer!;
    expect(ann.lobby.view().join).toMatchObject({ stage: 'host', signal: 'manual' });
    expect(answer.startsWith('BL1A.')).toBe(true);
    // Answered: this page does not try that invitation again (a second answer to one offer fails ICE).
    expect(ann.lobby.invitationUsed(code!)).toBe(true);
    expect(ann.lobby.invitationUsed(`${code!}x`)).toBe(false);
    expect(w.hostLobby.acceptAnswer('BL1A.garbage')).toBe(false);
    expect(w.hostToasts).toContain(clientText('en', 'join.badCode'));
    expect(w.hostLobby.acceptAnswer(answer)).toBe(true);
    expect(w.hostLobby.view().room).toMatchObject({ invitation: null, answered: true });
    await waitFor(w, () => ann.ready);
    // Reading an invitation code needs no service: the stage passes within the same tick.
    expect(ann.stages).toEqual(['host', 'world']);
  });

  it('closing the room: the guests in stay, the world still does not pause, a new guest finds no room; a room that cannot open says why', async () => {
    const w = await world();
    await openRoom(w);
    const ann = new GuestPage(w, 'ann', 'Ann');
    const link = w.hostLobby.view().room!.link!;
    ann.join(link);
    await waitFor(w, () => ann.ready);
    w.hostLobby.closeRoom();
    await drive(w, 300);
    expect(w.hostLobby.view().room).toMatchObject({ status: 'closed', code: null, link: null });
    expect(w.hostLobby.blocksPause).toBe(true);
    expect(w.hostLobby.view().pauses).toBe(false);
    expect(ann.ready).toBe(true);
    const bob = new GuestPage(w, 'bob', 'Bob');
    bob.join(link);
    await waitFor(w, () => bob.lobby.view().join?.stage === 'failed', 10_000);
    expect(bob.lobby.view().join).toMatchObject({ error: clientText('en', 'join.unknown'), canRetry: true });
    // Opening again: a new room code.
    const again = await openRoom(w);
    expect(link).not.toContain(again);

    const down = await world({ listenFails: true });
    const r = await down.hostLobby.openRoom('service');
    expect(r).toMatchObject({ ok: false, error: 'unreachable' });
    expect(down.hostLobby.view().room).toMatchObject({ status: 'closed', error: clientText('en', 'join.unreachable') });
  });

  it('diagnostics on a live link: role, signalling, the link line, numbers; no names, keys or codes', async () => {
    const w = await world();
    const code = await openRoom(w);
    const ann = new GuestPage(w, 'ann', 'Ann');
    ann.join(w.hostLobby.view().room!.link!);
    await waitFor(w, () => ann.ready);
    const p = ann.lobby.diagnostics(() => ({ rttMs: ann.net!.clock!.rtt, loss: ann.net!.clock!.lossRate, delayTicks: ann.net!.clock!.D, serverTps: ann.net!.replica!.state.tps, netStatus: ann.net!.status, traffic: { in: 1000, out: 100 } }));
    expect(ann.lobby.view().diagnosticsBusy).toBe(true);
    let text: string | null = null;
    void p.then((t) => (text = t));
    await waitFor(w, () => text !== null, 5000);
    expect(ann.lobby.view()).toMatchObject({ diagnostics: text, diagnosticsBusy: false });
    expect(text).toContain('role: guest');
    expect(text).toContain('signalling: broadcast');
    expect(text).toContain('webrtc host: no candidate pair yet'); // the fake peers have no statistics
    expect(text).toContain('connection: ready');
    expect(text).toContain('server tps: 20.0');
    for (const secret of ['Ann', 'ann', 'Hester', code, showRoomCode(code)]) expect(text).not.toContain(secret);
    const hostText = await (async () => {
      let t: string | null = null;
      void w.hostLobby.diagnostics(() => ({ rttMs: null, loss: null, delayTicks: null, serverTps: 20, netStatus: 'ready', traffic: null })).then((x) => (t = x));
      await waitFor(w, () => t !== null, 5000);
      return t as unknown as string;
    })();
    expect(hostText).toContain('role: host (room open, 1 guest)');
    expect(hostText).toContain('guest 1: no candidate pair yet; out -, in -; server: no report yet');
  });

  it('the last error keeps only its key and code, never a room code, and starts afresh with each join', async () => {
    const w = await world();
    await openRoom(w);
    const ann = new GuestPage(w, 'ann', 'Ann');
    ann.join('ZZZZ-ZZZZ');
    await waitFor(w, () => ann.lobby.view().join?.stage === 'failed', 30_000);
    expect(ann.lobby.lastError).toBe('join.unknown (unknown)');
    ann.lobby.clearJoin();
    ann.join(w.hostLobby.view().room!.link!);
    await waitFor(w, () => ann.ready);
    expect(ann.lobby.lastError).toBeNull();
    let text: string | null = null;
    void ann.lobby.diagnostics(() => ({ rttMs: 1, loss: 0, delayTicks: 3, serverTps: 20, netStatus: 'ready', traffic: null })).then((t) => (text = t));
    await waitFor(w, () => text !== null, 5000);
    expect(text).not.toContain('ZZZZ');
    expect(text).not.toContain('join.unknown');
  });
});
