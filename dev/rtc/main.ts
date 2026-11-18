/**
 * The WebRTC test page of package 10 (scripts/e2e-room.mjs drives two of these through window.rtc):
 * the real RTCPeerConnection, data channels and BroadcastChannel of the browser under the code of
 * src/net/webrtc, which Node cannot run.
 *
 *  - echo: one page hosts a room whose guests get every message back on the channel it came on;
 *    the other joins and sends messages of given sizes (fragmenting, reassembly, order), reads the
 *    channels' configuration, and either side closes (the other must see it);
 *  - strip: both sides drop every candidate from their descriptions, so ICE cannot connect (the
 *    'ice' failure, timed);
 *  - manual: the invitation and answer codes of ManualSignaller, copied by the script;
 *  - game: one page runs a real ServerHost (a flat world) and hosts its room with the game's
 *    RoomHost (client/room.ts): every guest through a MessageChannel and a PortForwarder into it;
 *    the other page is a NetClient on the WebRTC transport. The guest's replica digest is compared
 *    with the server's (tests/net/digest.ts) in the host page.
 */
import { RoomHost } from '../../src/client/room';
import { NetClient } from '../../src/net/client/netclient';
import { ServerHost } from '../../src/net/host/host';
import { PortTransport } from '../../src/net/host/port';
import { RELIABLE, UNRELIABLE, type Channel } from '../../src/net/transport';
import { BroadcastSignaller } from '../../src/net/webrtc/broadcast';
import { CloudSignaller } from '../../src/net/webrtc/cloud';
import { joinRoom, RoomListener, type ConnectDeps } from '../../src/net/webrtc/connect';
import { ManualSignaller } from '../../src/net/webrtc/manual';
import { DialError, type SignalMessage, type SignalPath, type Signaller } from '../../src/net/webrtc/signal';
import type { WebRtcTransport } from '../../src/net/webrtc/transport';
import { SAVE_VERSION } from '../../src/save/codec';
import { MemoryStorage } from '../../src/save/storage';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { generatorFromSpec, type GeneratorSpec } from '../../src/worldgen/generator';
import { compareReplica, DigestContext, replicaDigest, serverDigest, type Digest } from '../../tests/net/digest';

const timers = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (h: unknown): void => clearTimeout(h as number),
  every: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
  stop: (h: unknown): void => clearInterval(h as number),
};
const random = (b: Uint8Array<ArrayBuffer>): void => void crypto.getRandomValues(b);
const FLAT: GeneratorSpec = { kind: 'flat', seed: 7, layers: [{ cell: 7, thickness: 1 }, { cell: 1, thickness: 2 }, { cell: 3, thickness: 1 }] } as GeneratorSpec;

/** The channels every peer connection of this page made (to read their configuration). */
const channels: RTCDataChannel[] = [];

function deps(): ConnectDeps {
  return {
    createPeer: () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      const make = pc.createDataChannel.bind(pc);
      pc.createDataChannel = (label: string, init?: RTCDataChannelInit) => {
        const ch = make(label, init);
        channels.push(ch);
        return ch;
      };
      return pc;
    },
    timers,
  };
}

function broadcast(): BroadcastSignaller {
  return new BroadcastSignaller({ open: (name) => new BroadcastChannel(name), timers, random });
}

/** The signalling of `kind`: this browser's BroadcastChannel, or the public PeerJS server (the real one: needs the network). */
function signaller(kind: 'broadcast' | 'cloud'): Signaller {
  return kind === 'cloud' ? new CloudSignaller({ openSocket: (url) => new WebSocket(url), timers, random }) : broadcast();
}

/** `inner` with every candidate line dropped from the descriptions this side sends. */
function stripped(inner: Signaller): Signaller {
  const wrap = (p: SignalPath): SignalPath => ({
    get offerer() {
      return p.offerer;
    },
    send: (m: SignalMessage) => p.send(m.t === 'bye' ? m : { t: m.t, sdp: m.sdp.replace(/a=candidate:[^\r\n]*\r?\n/g, '').replace(/a=end-of-candidates\r?\n/g, '') }),
    get onMessage() {
      return p.onMessage;
    },
    set onMessage(f) {
      p.onMessage = f;
    },
    get onEnd() {
      return p.onEnd;
    },
    set onEnd(f) {
      p.onEnd = f;
    },
    close: () => p.close(),
  });
  return {
    kind: inner.kind,
    patienceMs: inner.patienceMs,
    get onLost() {
      return inner.onLost;
    },
    set onLost(f) {
      inner.onLost = f;
    },
    listen: (code, onGuest) => inner.listen(code, (p) => onGuest(wrap(p))),
    dial: (code) => inner.dial(code).then(wrap),
    close: () => inner.close(),
  };
}

function pattern(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function describe(e: unknown): string {
  return e instanceof DialError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

type Serial = { tick: number; columns: Array<[number, unknown]>; structures: Array<[number, unknown]>; entities: Array<[number, unknown]> };

function serial(d: Digest): Serial {
  return { tick: d.tick, columns: [...d.columns], structures: [...d.structures], entities: [...d.entities] };
}

function unserial(s: Serial): Digest {
  return { tick: s.tick, columns: new Map(s.columns), structures: new Map(s.structures), entities: new Map(s.entities) } as Digest;
}

// ------------------------------------------------------------------ state of this page

const host = {
  room: null as RoomListener | null,
  manual: null as ManualSignaller | null,
  transports: [] as WebRtcTransport[],
  closed: [] as string[],
  echoed: 0,
  server: null as ServerHost | null,
  game: null as RoomHost | null,
  failures: [] as string[],
  arrivals: [] as Array<{ at: number; size: number }>,
};
const guest = {
  t: null as WebRtcTransport | null,
  closed: null as string | null,
  got: [] as Array<{ channel: Channel; bytes: Uint8Array }>,
  manual: null as ManualSignaller | null,
  net: null as NetClient | null,
  joinMs: 0,
  onGot: null as (() => void) | null,
};

function echo(t: WebRtcTransport): void {
  host.transports.push(t);
  t.onMessage = (ch, bytes) => {
    host.echoed++;
    host.arrivals.push({ at: Date.now(), size: bytes.length });
    t.send(ch, bytes);
  };
  t.onClose = (reason) => host.closed.push(reason);
}

function keepGuest(t: WebRtcTransport): void {
  guest.t = t;
  t.onMessage = (channel, bytes) => {
    guest.got.push({ channel, bytes });
    guest.onGot?.();
  };
  t.onClose = (reason) => (guest.closed = reason);
}

function channelConfig(): Array<Record<string, unknown>> {
  return channels.slice(-2).map((c) => ({
    label: c.label,
    id: c.id,
    negotiated: c.negotiated,
    ordered: c.ordered,
    maxRetransmits: c.maxRetransmits,
    maxPacketLifeTime: c.maxPacketLifeTime,
    binaryType: c.binaryType,
    readyState: c.readyState,
  }));
}

const rtc = {
  // ---- echo
  async echoHost(code: string, strip = false, kind: 'broadcast' | 'cloud' = 'broadcast'): Promise<void> {
    const room = new RoomListener(strip ? stripped(signaller(kind)) : signaller(kind), deps());
    room.onGuest = echo;
    room.onGuestFailed = (e) => host.failures.push(describe(e));
    await room.open(code);
    host.room = room;
  },
  hostState() {
    return { guests: host.transports.filter((t) => t.open).length, closed: host.closed, echoed: host.echoed, failures: host.failures, forwarders: host.game?.guests ?? 0, arrivals: host.arrivals };
  },
  async echoJoin(code: string, strip = false, kind: 'broadcast' | 'cloud' = 'broadcast'): Promise<{ ok: boolean; ms: number; failure: string | null; config: Array<Record<string, unknown>> }> {
    const t0 = performance.now();
    try {
      keepGuest(await joinRoom(strip ? stripped(signaller(kind)) : signaller(kind), code, deps()));
      return { ok: true, ms: Math.round(performance.now() - t0), failure: null, config: channelConfig() };
    } catch (e) {
      return { ok: false, ms: Math.round(performance.now() - t0), failure: e instanceof DialError ? e.code : describe(e), config: [] };
    }
  },
  /** Reliable messages of `sizes` there and back: each arrives whole and equal, in order. */
  async roundTrip(sizes: number[]): Promise<Array<{ size: number; ok: boolean; ms: number; sentAt: number; backAt: number }>> {
    const t = guest.t!;
    const out: Array<{ size: number; ok: boolean; ms: number; sentAt: number; backAt: number }> = [];
    for (const [i, size] of sizes.entries()) {
      const msg = pattern(size, i + 1);
      guest.got.length = 0;
      const t0 = performance.now();
      const sentAt = Date.now();
      // Woken by the message itself (a timer may be throttled in a page that is not in front).
      const back = await new Promise<{ channel: Channel; bytes: Uint8Array } | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 30_000);
        guest.onGot = () => {
          clearTimeout(timer);
          resolve(guest.got[0]);
        };
        t.send(RELIABLE, msg);
      });
      guest.onGot = null;
      out.push({ size, ok: back !== undefined && back.channel === RELIABLE && guest.got.length === 1 && same(back.bytes, msg), ms: Math.round(performance.now() - t0), sentAt, backAt: Date.now() });
    }
    // All of them at once: they come back in order.
    guest.got.length = 0;
    for (const [i, size] of sizes.entries()) t.send(RELIABLE, pattern(size, 100 + i));
    const deadline = performance.now() + 60_000;
    while (guest.got.length < sizes.length && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    out.push({ size: -1, ok: guest.got.length === sizes.length && sizes.every((size, i) => same(guest.got[i]!.bytes, pattern(size, 100 + i))), ms: 0, sentAt: 0, backAt: 0 });
    return out;
  },
  /** `n` unreliable messages of `size` bytes: how many came back. */
  async unreliable(n: number, size: number): Promise<{ sent: number; got: number }> {
    const t = guest.t!;
    guest.got.length = 0;
    for (let i = 0; i < n; i++) {
      const m = pattern(size, i + 1);
      m[0] = i & 255;
      t.send(UNRELIABLE, m);
    }
    await new Promise((r) => setTimeout(r, 1000));
    return { sent: n, got: guest.got.filter((g) => g.channel === UNRELIABLE).length };
  },
  guestState() {
    return { open: guest.t?.open ?? false, closed: guest.closed, buffered: guest.t ? [guest.t.bufferedBytes(RELIABLE), guest.t.bufferedBytes(UNRELIABLE)] : null };
  },
  closeGuest(): void {
    guest.t?.close('bye');
  },
  closeHostSide(): void {
    for (const t of host.transports) t.close('bye');
  },

  // ---- manual
  async manualHost(): Promise<string> {
    const m = new ManualSignaller({ random });
    const room = new RoomListener(m, deps());
    room.onGuest = echo;
    room.onGuestFailed = (e) => host.failures.push(describe(e));
    await room.open('MANUAL');
    host.room = room;
    host.manual = m;
    return m.invite();
  },
  manualAccept(answer: string): boolean {
    try {
      host.manual!.accept(answer);
      return true;
    } catch (e) {
      host.failures.push(describe(e));
      return false;
    }
  },
  /** Join with an invitation: resolves with the answer code as soon as it is made; the connection follows (guestState). */
  manualJoin(invite: string): Promise<string> {
    const m = new ManualSignaller({ random });
    guest.manual = m;
    return new Promise((resolve, reject) => {
      m.onAnswer = resolve;
      joinRoom(m, invite, deps()).then(keepGuest, (e: unknown) => reject(new Error(describe(e))));
    });
  },

  // ---- a real server
  async gameHost(code: string): Promise<void> {
    const server = new ServerHost({
      clock: { now: () => performance.now(), epochMs: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as number) },
      openStorage: () => Promise.resolve({ storage: new MemoryStorage(), persistent: true }),
      report: () => undefined,
      rabbits: false,
    });
    await server.control({ type: 'create', meta: { id: 'rtc', name: 'RTC', seed: '7', seedHash: 7, mode: 'creative', createdAt: 1, lastPlayed: 1, version: SAVE_VERSION, time: 0 }, options: { generator: FLAT, exampleShip: false } });
    host.server = server;
    const room = new RoomHost({
      server: {
        // As the game's host page (client/server.ts LocalServer.connectGuest): a MessageChannel into the server.
        connectGuest: () => {
          const ch = new MessageChannel();
          server.connect(new PortTransport(ch.port2), false);
          ch.port1.start();
          return ch.port1;
        },
        openRoom: () => void server.control({ type: 'openRoom' }),
        closeRoom: () => void server.control({ type: 'closeRoom' }),
      },
      signaller: broadcast(),
      code,
      deps: deps(),
      intervals: timers,
      onGuestFailed: (e) => host.failures.push(describe(e)),
    });
    await room.open();
    host.game = room;
  },
  /** Change cells next to the spawn on the server (deltas for the guest). */
  hostEdit(n: number): void {
    const sim = host.server!.sim;
    for (let i = 0; i < n; i++) sim.world.setCell(i % 8, 4 + (i >> 3), 3, makeCell(i % 2 === 0 ? B.PLANKS_OAK : B.GLASS));
  },
  /** The guest's replica digest compared with the server's view of that guest: the differences. */
  compare(key: string, client: Serial): string[] {
    const server = host.server!;
    const view = server.replicator.clientView(key);
    if (view === undefined) return [`${key} is not a client of the server`];
    const d = serverDigest(new DigestContext(server.sim.generator), server.sim, { columns: view.columns, structures: view.structures, entities: view.entities });
    return compareReplica(d, unserial(client), { poses: false });
  },
  serverTick(): number {
    return host.server?.sim.ticks ?? -1;
  },
  async gameJoin(code: string, key: string): Promise<{ ok: boolean; ms: number; failure: string | null }> {
    const t0 = performance.now();
    let failure: string | null = null;
    const net = new NetClient({
      openTransport: (ready, failed) => {
        joinRoom(broadcast(), code, deps()).then(
          (t) => {
            guest.t = t;
            ready(t);
          },
          (e: unknown) => {
            failure = describe(e);
            failed(failure);
          },
        );
      },
      now: () => performance.now(),
      chunkSource: (spec) => {
        const gen = generatorFromSpec(spec);
        return { generate: (cx, cz, done) => done(gen.generate(cx, cz)) };
      },
      playerKey: key,
      name: 'Guest',
      viewRadius: 3,
    });
    guest.net = net;
    const frame = (): void => {
      net.frame(performance.now());
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    setInterval(() => net.heartbeat(performance.now()), 1000);
    net.start();
    const deadline = t0 + 60_000;
    while (net.status !== 'ready' && failure === null && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    guest.joinMs = Math.round(performance.now() - t0);
    return { ok: net.status === 'ready', ms: guest.joinMs, failure };
  },
  guestNet() {
    const net = guest.net;
    return { status: net?.status ?? null, tick: net?.replica?.state.tick ?? -1, columns: net?.replica?.world.chunks.size ?? 0, structures: net?.replica?.state.structures.size ?? 0, kick: net?.kick?.reason ?? null };
  },
  guestDigest(): Serial | null {
    const st = guest.net?.replica?.state;
    return st ? serial(replicaDigest(st)) : null;
  },
  /** Shut the server down: the guest must get Kick(shutdown) through the forwarder and the data channels. */
  async hostShutdown(): Promise<void> {
    await host.server?.control({ type: 'shutdown', save: false });
  },
};

declare global {
  interface Window {
    rtc: typeof rtc;
  }
}
window.rtc = rtc;
