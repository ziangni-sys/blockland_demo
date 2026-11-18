/**
 * Package 10 end to end in one process: a host page's room (client/room.ts RoomHost: the signaller,
 * the handshake, a forwarder per guest into the server's PortTransport) and guests joining over the
 * WebRTC transport, with fake WebRTC (Node has none) and the real server, NetClient and replica.
 * A guest reaches ready with the server's world; the Refuse and Kick reasons reach it through the
 * forwarder and the data channels; a dead link is a leave on the server; and a guest plays for a
 * minute (walk, place, mine) with the replica equal to the server's at the end.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import type { Dir } from '../../src/core/dirs';
import { GUEST_HELLO_MS, GuestJoin, MAX_SILENT_GUESTS, RECONNECT_GIVE_UP_MS, RoomHost, type RoomServer } from '../../src/client/room';
import type { ClientStringKey } from '../../src/client/strings';
import { NetClient } from '../../src/net/client/netclient';
import { PortTransport, type PortLike } from '../../src/net/host/port';
import { LoopbackNet } from '../../src/net/loopback';
import { CONNECTION_TIMEOUT_MS, MAX_PLAYERS, MAX_RELIABLE_BYTES } from '../../src/net/protocol';
import type { Transport } from '../../src/net/transport';
import { BroadcastSignaller } from '../../src/net/webrtc/broadcast';
import { joinRoom, type ConnectDeps } from '../../src/net/webrtc/connect';
import { DialError, type DialFailure } from '../../src/net/webrtc/signal';
import { FRAGMENT_BYTES, FRAGMENT_FIRST, type WebRtcTransport } from '../../src/net/webrtc/transport';
import { generatorFromSpec } from '../../src/worldgen/generator';
import { counterRandom, FakeBroadcastHub, FakeRtcNet, netTimers, type FakeChannel, type FakePeer } from './fakertc';
import { NetHarness, type HeadlessClient } from './harness';

const CODE = 'RXAMCDEF';

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

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Run the harness until `p` settles. */
async function until<T>(h: NetHarness, p: Promise<T>, maxMs = 120_000): Promise<T> {
  let out: { v: T } | { e: unknown } | null = null;
  p.then(
    (v) => (out = { v }),
    (e: unknown) => (out = { e }),
  );
  for (let t = 0; t < maxMs && out === null; t += 10) {
    await flush();
    h.run(10);
  }
  await flush();
  if (out === null) throw new Error('still pending');
  const o = out as { v: T } | { e: unknown };
  if ('e' in o) throw o.e;
  return o.v;
}

interface Room {
  h: NetHarness;
  rtc: FakeRtcNet;
  hub: FakeBroadcastHub;
  deps: ConnectDeps;
  room: RoomHost;
  host: HeadlessClient;
  /** The server ends of the guests' ports, in connection order. */
  ports: FakePort[];
  /** The page's server refuses new guest connections (LocalServer.connectGuest throws: its Worker is gone). */
  serverDown: boolean;
}

/** A world served by a harness, its host's own client, and a room opened on it (broadcast signalling). */
async function openRoom(): Promise<Room> {
  const h = new NetHarness();
  await h.create();
  const host = h.addClient('host', {}, { local: true });
  h.runUntil(() => host.ready, 30_000);
  const rtc = new FakeRtcNet(h.net);
  const hub = new FakeBroadcastHub(h.net);
  const timers = netTimers(h.net);
  const deps: ConnectDeps = { createPeer: rtc.createPeer, timers };
  const ports: FakePort[] = [];
  const flags = { serverDown: false };
  const server: RoomServer = {
    connectGuest: () => {
      if (flags.serverDown) throw new Error('the game server is not running');
      const ps = new FakePort(h.net);
      const pf = new FakePort(h.net);
      ps.peer = pf;
      pf.peer = ps;
      ports.push(ps);
      h.host.connect(new PortTransport(ps), false);
      return pf;
    },
    openRoom: () => void h.host.control({ type: 'openRoom' }),
    closeRoom: () => void h.host.control({ type: 'closeRoom' }),
  };
  const room = new RoomHost({ server, signaller: new BroadcastSignaller({ open: hub.open, timers, random: counterRandom(1) }), code: CODE, deps, intervals: timers });
  await until(h, room.open());
  await until(h, h.settle());
  expect(room.state).toBe('open');
  expect(h.host.netServer.roomOpen).toBe(true);
  return {
    h,
    rtc,
    hub,
    deps,
    room,
    host,
    ports,
    get serverDown() {
      return flags.serverDown;
    },
    set serverDown(v: boolean) {
      flags.serverDown = v;
    },
  };
}

let seed = 10;
/** A guest's WebRTC transport to the room. */
function dial(r: Room, code = CODE): Promise<WebRtcTransport> {
  return joinRoom(new BroadcastSignaller({ open: r.hub.open, timers: r.deps.timers, random: counterRandom(seed++) }), code, r.deps);
}

/** A guest client on a transport it already has (the harness's opener is synchronous). */
function guest(r: Room, key: string, t: Transport, build?: string): HeadlessClient {
  let used = false;
  return r.h.addClient(key, {}, {
    viewRadius: 2,
    ...(build !== undefined ? { build } : {}),
    transport: () => {
      if (!used) {
        used = true;
        return t;
      }
      // No reconnection in these tests: a link that never answers.
      return { open: false, onMessage: null, onClose: null, send: () => undefined, bufferedBytes: () => 0, close: () => undefined };
    },
  });
}

describe('a room end to end over (fake) WebRTC, package 10', () => {
  it('a guest joins through the room and reaches ready with the server world; the host sees it', async () => {
    const r = await openRoom();
    const t = await until(r.h, dial(r));
    const g = guest(r, 'guest', t);
    r.h.runUntil(() => g.ready, 30_000);
    expect(g.welcome!.isHost).toBe(false);
    expect(r.room.guests).toBe(1);
    expect(r.h.sim.players.get('guest')).toBeDefined();
    r.h.run(1000);
    r.h.quiesce();
    expect(r.h.compareNow(g, false)).toEqual([]);
    expect(r.h.compareNow(r.host, false)).toEqual([]);
  }, 60_000);

  it('Refuse reasons reach the guest through the forwarder: closed, other build, full', async () => {
    const r = await openRoom();
    // The server's room closed while the page still listens (a race the page cannot rule out).
    await until(r.h, r.h.host.control({ type: 'closeRoom' }));
    const a = guest(r, 'a', await until(r.h, dial(r)));
    r.h.runUntil(() => a.status === 'refused', 10_000);
    expect(a.refusal!.reason).toBe('closed');
    await until(r.h, r.h.host.control({ type: 'openRoom' }));
    const b = guest(r, 'b', await until(r.h, dial(r)), 'some-other-build');
    r.h.runUntil(() => b.status === 'refused', 10_000);
    expect(b.refusal!.reason).toBe('build');
    // Host + 3 guests = MAX_PLAYERS; the next one is refused.
    const ins: HeadlessClient[] = [];
    for (let i = 0; i < MAX_PLAYERS - 1; i++) {
      const c = guest(r, `in${i}`, await until(r.h, dial(r)));
      r.h.runUntil(() => c.ready, 30_000);
      ins.push(c);
    }
    const late = guest(r, 'late', await until(r.h, dial(r)));
    r.h.runUntil(() => late.status === 'refused', 10_000);
    expect(late.refusal!.reason).toBe('full');
    expect(ins.every((c) => c.status === 'ready')).toBe(true);
    // The refused connections are closed at both ends (their forwarders ended).
    r.h.run(6000);
    expect(r.room.guests).toBe(MAX_PLAYERS - 1);
  }, 120_000);

  it('the host closing the world: the guest gets Kick(shutdown) before its link closes', async () => {
    const r = await openRoom();
    const g = guest(r, 'guest', await until(r.h, dial(r)));
    r.h.runUntil(() => g.ready, 30_000);
    await until(r.h, r.h.host.control({ type: 'shutdown', save: false }));
    r.h.run(500);
    expect(g.status).toBe('kicked');
    expect(g.kick!.reason).toBe('shutdown');
    r.room.end();
    r.h.run(6000);
    expect(r.room.guests).toBe(0);
  }, 60_000);

  it("a guest's link dying (the connection fails) is a leave on the server; the guest reconnects", async () => {
    const r = await openRoom();
    const t = await until(r.h, dial(r));
    const g = guest(r, 'guest', t);
    r.h.runUntil(() => g.ready, 30_000);
    const peers = [...r.rtc.peers.values()] as FakePeer[];
    // Both ends see the association die (ICE consent failed).
    for (const p of peers) {
      for (const ch of p.channels as FakeChannel[]) ch.abort();
    }
    r.h.run(200);
    expect(g.statuses).toContain('reconnecting');
    r.h.run(1000);
    expect(r.h.sim.players.get('guest')).toBeUndefined();
    expect(r.room.guests).toBe(0);
  }, 60_000);

  it('a minute of scripted play by a guest over WebRTC (walk, place, mine): the replica equals the server at the end', async () => {
    const r = await openRoom();
    const g = guest(r, 'guest', await until(r.h, dial(r)));
    r.h.runUntil(() => g.ready && g.own !== null && g.intents !== null, 30_000);
    const t0 = r.h.net.now;
    let placed = 0;
    let mined = 0;
    let walked = 0;
    for (let lap = 0; r.h.net.now - t0 < 60_000; lap++) {
      // Walk a second and a half, a quarter turn each lap (a square around the spawn).
      const p0 = { ...g.own!.player.pos };
      g.input.yaw = (lap * Math.PI) / 2;
      g.input.pitch = 0;
      g.input.forward = 1;
      r.h.run(1500);
      g.input.forward = 0;
      r.h.run(300);
      walked += Math.hypot(g.own!.player.pos.x - p0.x, g.own!.player.pos.z - p0.z);
      // Place a plank on the ground two cells aside, then mine the turf cell next to it (creative: one click).
      const p = g.own!.player.pos;
      const ax = Math.floor(p.x) + (lap % 2 === 0 ? 2 : -2);
      const az = Math.floor(p.z);
      g.hold(B.PLANKS_OAK);
      if (g.useOn(ax, 3, az, 2 as Dir) && r.h.sim.world.getCell(ax, 4, az) !== 0) placed++;
      if (g.mine(ax, 3, az + 1) && (r.h.sim.world.getCell(ax, 3, az + 1) & 1023) === 0) mined++;
    }
    g.stopInput();
    r.h.run(1000);
    r.h.quiesce();
    expect(walked).toBeGreaterThan(30);
    expect(placed).toBeGreaterThanOrEqual(10);
    expect(mined).toBeGreaterThanOrEqual(10);
    expect(r.h.compareNow(g, false)).toEqual([]);
    expect(r.h.compareNow(r.host, false)).toEqual([]);
    expect(g.correctionsSince(g.readyTick ?? 0, (c) => c.startsWith('check:'))).toEqual([]);
    expect(g.net.connectionCount).toBe(1);
  }, 180_000);
});

/** A guest page: NetClient on GuestJoin's transports, told about its statuses as client/game.ts does; a final verdict leaves. */
interface PageGuest {
  net: NetClient;
  join: GuestJoin;
  finals: Array<{ key: ClientStringKey; at: number }>;
  statuses: string[];
  /** Run the page (frames every 10 ms, heartbeats every second) and whatever `run` advances, for `ms`. */
  drive(ms: number): Promise<void>;
}

function pageGuest(loop: LoopbackNet, signaller: BroadcastSignaller, deps: ConnectDeps, key: string, run: (ms: number) => void = (ms) => loop.advanceBy(ms)): PageGuest {
  const finals: PageGuest['finals'] = [];
  const statuses: string[] = [];
  const join: GuestJoin = new GuestJoin({
    signaller,
    code: CODE,
    deps,
    now: () => loop.now,
    onFinal: (k) => {
      finals.push({ key: k, at: loop.now });
      net.leave();
    },
  });
  const net: NetClient = new NetClient({
    openTransport: join.openTransport,
    now: () => loop.now,
    chunkSource: (spec) => {
      const gen = generatorFromSpec(spec);
      return { generate: (cx, cz, done) => done(gen.generate(cx, cz)) };
    },
    playerKey: key,
    name: key,
    viewRadius: 2,
  });
  net.onStatus = (st) => {
    statuses.push(st);
    if (st === 'joining' || st === 'ready') join.connected();
    else if (st === 'reconnecting') join.linkLost();
  };
  let nextBeat = loop.now;
  const drive = async (ms: number): Promise<void> => {
    const end = loop.now + ms;
    while (loop.now < end) {
      await flush();
      run(10);
      net.frame(loop.now);
      if (loop.now >= nextBeat) {
        net.heartbeat(loop.now);
        nextBeat += 1000;
      }
    }
    await flush();
  };
  net.start();
  return { net, join, finals, statuses, drive };
}

/** A room on a LoopbackNet whose page server is `server` (no real server behind it). */
async function bareRoom(server: RoomServer): Promise<{ loop: LoopbackNet; rtc: FakeRtcNet; hub: FakeBroadcastHub; deps: ConnectDeps; room: RoomHost }> {
  const loop = new LoopbackNet();
  const rtc = new FakeRtcNet(loop);
  const hub = new FakeBroadcastHub(loop);
  const timers = netTimers(loop);
  const deps: ConnectDeps = { createPeer: rtc.createPeer, timers };
  const room = new RoomHost({ server, signaller: new BroadcastSignaller({ open: hub.open, timers, random: counterRandom(1) }), code: CODE, deps, intervals: timers });
  const opened = room.open();
  for (let i = 0; i < 20; i++) {
    await flush();
    loop.advanceBy(5);
  }
  await opened;
  return { loop, rtc, hub, deps, room };
}

describe('peers that never say Hello (RoomHost, client/room.ts)', () => {
  it(`a connection that sends nothing, or only a first fragment declaring ${MAX_RELIABLE_BYTES} bytes, is closed GUEST_HELLO_MS after it opened`, async () => {
    const r = await openRoom();
    const mine: FakePeer[] = [];
    const deps: ConnectDeps = {
      ...r.deps,
      createPeer: () => {
        const p = r.rtc.createPeer();
        mine.push(p);
        return p;
      },
    };
    const silent = await until(r.h, joinRoom(new BroadcastSignaller({ open: r.hub.open, timers: r.deps.timers, random: counterRandom(seed++) }), CODE, deps));
    const stalling = await until(r.h, joinRoom(new BroadcastSignaller({ open: r.hub.open, timers: r.deps.timers, random: counterRandom(seed++) }), CODE, deps));
    // The first fragment of a message as long as the format allows, then nothing (the host's
    // transport holds a buffer of the declared length).
    const first = new Uint8Array(5 + FRAGMENT_BYTES);
    first[0] = FRAGMENT_FIRST;
    new DataView(first.buffer).setUint32(1, MAX_RELIABLE_BYTES, true);
    const reliable = mine[1]!.channels.find((c) => c.id === 0)!;
    reliable.send(first);
    expect(r.room.guests).toBe(2);
    r.h.run(GUEST_HELLO_MS - 500);
    expect([silent.open, stalling.open]).toEqual([true, true]);
    r.h.run(1000);
    expect([silent.open, stalling.open]).toEqual([false, false]);
    expect(r.room.guests).toBe(0);
    // A guest that says Hello gets in, and stays past the deadline.
    const g = guest(r, 'guest', await until(r.h, dial(r)));
    r.h.runUntil(() => g.ready, 30_000);
    r.h.run(GUEST_HELLO_MS + 1000);
    expect(g.status).toBe('ready');
    expect(r.room.guests).toBe(1);
  }, 60_000);

  it(`at most MAX_SILENT_GUESTS (${MAX_SILENT_GUESTS}) silent connections: one more is closed at once; once they are cut, guests get in again`, async () => {
    const r = await openRoom();
    const silent: WebRtcTransport[] = [];
    for (let i = 0; i < MAX_SILENT_GUESTS; i++) silent.push(await until(r.h, dial(r)));
    expect(r.room.guests).toBe(MAX_SILENT_GUESTS);
    const extra = await until(r.h, dial(r));
    r.h.run(200);
    expect(extra.open).toBe(false);
    expect(silent.every((t) => t.open)).toBe(true);
    // The one turned away never got a connection into the server.
    expect(r.ports).toHaveLength(MAX_SILENT_GUESTS);
    r.h.run(GUEST_HELLO_MS);
    expect(silent.some((t) => t.open)).toBe(false);
    expect(r.room.guests).toBe(0);
    const g = guest(r, 'guest', await until(r.h, dial(r)));
    r.h.runUntil(() => g.ready, 30_000);
  }, 60_000);
});

describe('GuestJoin: how the page judges a failed join (client/room.ts)', () => {
  /** A GuestJoin whose dials fail with `codes` in turn (the last one again after that), and its verdicts. */
  function failingJoin(codes: DialFailure[]): { loop: LoopbackNet; join: GuestJoin; finals: Array<{ key: string; at: number }> } {
    const loop = new LoopbackNet();
    const timers = netTimers(loop);
    const finals: Array<{ key: string; at: number }> = [];
    let i = 0;
    const join = new GuestJoin({
      signaller: {
        kind: 'broadcast',
        patienceMs: 1000,
        onLost: null,
        listen: () => Promise.resolve(),
        close: () => undefined,
        dial: () => Promise.reject(new DialError(codes[Math.min(i++, codes.length - 1)]!, 'test')),
      },
      code: CODE,
      deps: {
        createPeer: () => {
          throw new Error('unused');
        },
        timers,
      },
      now: () => loop.now,
      onFinal: (key) => finals.push({ key, at: loop.now }),
    });
    return { loop, join, finals };
  }

  it('the first join: every failure is final, with its own message', async () => {
    const codes: DialFailure[] = ['unreachable', 'unknown', 'taken', 'bad_code', 'no_answer', 'left', 'ice'];
    for (const c of codes) {
      const j = failingJoin([c]);
      j.join.openTransport(
        () => undefined,
        () => undefined,
      );
      await flush();
      expect(j.finals).toEqual([{ key: { unreachable: 'join.unreachable', unknown: 'join.unknown', taken: 'join.taken', bad_code: 'join.badCode', no_answer: 'join.noAnswer', left: 'join.left', ice: 'join.ice' }[c], at: 0 }]);
    }
  });

  it('after the link died: a room that is gone is final at once; other failures are retried until RECONNECT_GIVE_UP_MS after the loss (a deadline, however the attempts end)', async () => {
    const gone = failingJoin(['unknown']);
    gone.join.connected();
    gone.join.linkLost();
    gone.join.openTransport(
      () => undefined,
      () => undefined,
    );
    await flush();
    expect(gone.finals).toEqual([{ key: 'join.gone', at: 0 }]);

    const j = failingJoin(['ice']);
    j.join.connected();
    j.join.linkLost();
    while (j.loop.now < RECONNECT_GIVE_UP_MS + 10_000) {
      j.join.openTransport(
        () => undefined,
        () => undefined,
      );
      await flush();
      j.loop.advanceBy(2000);
    }
    expect(j.finals).toEqual([{ key: 'join.lost', at: RECONNECT_GIVE_UP_MS }]);
    // Attempts every 2 s until the verdict, none after it.
    expect(j.join.attempts).toBe(RECONNECT_GIVE_UP_MS / 2000);

    // A Welcome before the deadline cancels it; the next loss starts a new one.
    const w = failingJoin(['ice']);
    w.join.connected();
    w.join.linkLost();
    w.loop.advanceBy(RECONNECT_GIVE_UP_MS - 1000);
    w.join.connected();
    w.loop.advanceBy(RECONNECT_GIVE_UP_MS);
    expect(w.finals).toEqual([]);
    w.join.linkLost();
    const lostAt = w.loop.now;
    w.loop.advanceBy(RECONNECT_GIVE_UP_MS - 1);
    expect(w.finals).toEqual([]);
    w.loop.advanceBy(1);
    expect(w.finals).toEqual([{ key: 'join.lost', at: lostAt + RECONNECT_GIVE_UP_MS }]);
  });

  it("the host's side takes the connection and drops it before Welcome (its server is gone): join.dropped at once, no second attempt", async () => {
    const b = await bareRoom({
      connectGuest: () => {
        throw new Error('the game server is not running');
      },
      openRoom: () => undefined,
      closeRoom: () => undefined,
    });
    const g = pageGuest(b.loop, new BroadcastSignaller({ open: b.hub.open, timers: b.deps.timers, random: counterRandom(9) }), b.deps, 'guest');
    await g.drive(60_000);
    expect(g.finals.map((f) => f.key)).toEqual(['join.dropped']);
    expect(g.finals[0]!.at).toBeLessThan(2000);
    expect(g.join.attempts).toBe(1);
    expect(g.net.connectionCount).toBe(1);
    expect(g.net.status).toBe('closed');
    // One peer connection on each side, never another.
    expect(b.rtc.peers.size).toBe(2);
  });

  it("the host's game takes the connection but never answers Hello: join.noWelcome when NetClient's Welcome timeout ends it", async () => {
    const b = await bareRoom({
      connectGuest: () => ({ postMessage: () => undefined, onmessage: null, close: () => undefined }),
      openRoom: () => undefined,
      closeRoom: () => undefined,
    });
    const g = pageGuest(b.loop, new BroadcastSignaller({ open: b.hub.open, timers: b.deps.timers, random: counterRandom(9) }), b.deps, 'guest');
    // The guest said Hello: the host page keeps the connection (no GUEST_HELLO_MS cut).
    await g.drive(GUEST_HELLO_MS + 5000);
    expect(b.room.guests).toBe(1);
    expect(g.finals).toEqual([]);
    await g.drive(CONNECTION_TIMEOUT_MS);
    expect(g.finals.map((f) => f.key)).toEqual(['join.noWelcome']);
    expect(g.finals[0]!.at).toBeGreaterThanOrEqual(CONNECTION_TIMEOUT_MS);
    expect(g.finals[0]!.at).toBeLessThan(CONNECTION_TIMEOUT_MS + 3000);
    expect(g.join.attempts).toBe(1);
    // The page left: its connection is closed at the host too.
    expect(b.room.guests).toBe(0);
  });

  it('after ready, the host page cannot take guests any more: each new attempt opens and is dropped; the guest gives up RECONNECT_GIVE_UP_MS after the link died', async () => {
    const r = await openRoom();
    const g = pageGuest(r.h.net, new BroadcastSignaller({ open: r.hub.open, timers: r.deps.timers, random: counterRandom(seed++) }), r.deps, 'guest', (ms) => r.h.run(ms));
    for (let i = 0; i < 3000 && g.net.status !== 'ready'; i++) await g.drive(10);
    expect(g.net.status).toBe('ready');
    r.serverDown = true;
    // The association dies at both ends (ICE consent failed).
    for (const p of r.rtc.peers.values()) for (const ch of p.channels) ch.abort();
    const diedAt = r.h.net.now;
    await g.drive(RECONNECT_GIVE_UP_MS + 10_000);
    expect(g.finals.map((f) => f.key)).toEqual(['join.lost']);
    expect(g.finals[0]!.at - diedAt).toBeGreaterThanOrEqual(RECONNECT_GIVE_UP_MS);
    expect(g.finals[0]!.at - diedAt).toBeLessThan(RECONNECT_GIVE_UP_MS + 100);
    // Attempts reached the host and were dropped there (each one a connection NetClient attached).
    expect(g.net.connectionCount).toBeGreaterThan(3);
    expect(g.statuses.filter((st) => st === 'reconnecting')).toHaveLength(1);
    const peers = r.rtc.peers.size;
    await g.drive(10_000);
    expect(r.rtc.peers.size).toBe(peers);
  }, 120_000);
});
