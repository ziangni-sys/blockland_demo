/**
 * A room of four on a host's home uplink (package 13, docs/NETCODE.md section 13): the scenes that
 * stress the host's uplink, and what each guest gets out of it.
 *
 * THE ROOM. A real ServerHost in the harness, the host's own client on its port (local, not on the
 * uplink) and three guests, each through the host page's real forwarder (client/forward.ts: the
 * backlog reports every 100 ms and at 'bufferedamountlow') into the server's PortTransport, as in
 * a room; their server-to-guest directions leave through ONE SharedUplink of the
 * given bandwidth (net/loopback.ts: fair shares between the guests' connections, 80 header bytes per
 * packet). Every link is 30 ms one way, without loss or jitter, so what a reliable message waits
 * beyond 30 ms is queueing at the host. Guests ask for the default view radius (render distance 8
 * + 1 = 9); the host's own client too.
 *
 * WHAT IS MEASURED, per guest, over a window (Room.start() to Room.stop()):
 *  - bytes per second of each TickBatch section and of the samples (the Replicator's own counts:
 *    payload), and of the wire (payload plus 80 header bytes per started 1150);
 *  - the largest batch;
 *  - how long its batches waited at the host (arrival - departure - latency): every batch carries
 *    must-send content (the heartbeat at least), so this is how long a correction, a block change or
 *    an inventory waits behind what the Replicator queued before it;
 *  - how many ticks its join took (addGuests() to NetClient ready) and until every column of its
 *    subscription circle had been sent.
 * And the host's cost: wall milliseconds of sim.tick() and of Replicator.endTick() per tick.
 *
 * Bounds in tests come from these numbers and count bytes and ticks, never wall time.
 */
import { makeCell, facingState } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { PortForwarder, type ForwardedLink } from '../../src/client/forward';
import { PortTransport } from '../../src/net/host/port';
import { createLoopbackPair, SharedUplink, type LinkConditions, type LoopbackNet } from '../../src/net/loopback';
import { BUFFERED_LOW_BYTES } from '../../src/net/webrtc/transport';
import { decodeServerMessage } from '../../src/net/codec';
import { SECTION } from '../../src/net/protocol';
import type { ClientStats } from '../../src/net/server/replicator';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../../src/net/transport';
import { BEARING_V, DECK_Y } from '../../src/sim/exampleShip';
import type { PlayerControl } from '../../src/sim/players';
import type { Simulation } from '../../src/sim/simulation';
import { Ship } from '../../src/structures/structure';
import type { GeneratorSpec } from '../../src/worldgen/generator';
import { exampleBoat, fill, island, launchBoat, loadArea, SEA, SEA_TOP, useOn } from './e2e-scenes';
import { fakePorts, type FakePort } from './fakeport';
import { netTimers } from './fakertc';
import { NetHarness, testMeta, type HeadlessClient } from './harness';

/** One way, every link. */
export const ROOM_LATENCY_MS = 30;
/** The default render distance 8, plus 1 (game.ts loadRadiusFor). */
export const DEFAULT_VIEW_RADIUS = 9;
/** Height the fliers keep, above the terrain's hills. */
const FLY_Y = 112;
/** Real terrain (the default world). */
export const TERRAIN: GeneratorSpec = { kind: 'terrain', seed: 20261118 };

/** Uplinks of the measurements: 256 kbit/s, 1 Mbit/s, 5 Mbit/s (bytes per second). */
export const UPLINKS: ReadonlyArray<{ name: string; bytesPerSec: number }> = [
  { name: '256 kbit/s', bytesPerSec: 32_000 },
  { name: '1 Mbit/s', bytesPerSec: 125_000 },
  { name: '5 Mbit/s', bytesPerSec: 625_000 },
];

const SECTION_NAMES = Object.keys(SECTION) as Array<keyof typeof SECTION>;
/** Two samples of one thing at most this many ticks apart count as one motion (a sample gap). */
const SAMPLE_GAP_MAX = 40;

/**
 * The host page's end of a guest's data channels (what the forwarder sends on), counting what goes
 * down and when each reliable message was handed over; 'bufferedamountlow' is emulated (checked
 * every 2 ms of virtual time), as WebRtcTransport fires it.
 */
class MeteredEnd implements ForwardedLink {
  onMessage: Transport['onMessage'] = null;
  onClose: Transport['onClose'] = null;
  onBufferedLow: ((channel: Channel) => void) | null = null;
  private readonly high: [boolean, boolean] = [false, false];
  readonly sentAt: number[] = [];
  /** Payload plus headers (80 bytes per started 1150 of a message) sent so far. */
  wire = 0;
  /** The longest reliable message since the last resetLargest(). */
  largest = 0;
  constructor(
    private readonly inner: Transport,
    private readonly net: LoopbackNet,
  ) {
    inner.onMessage = (ch, b) => this.onMessage?.(ch, b);
    inner.onClose = (r) => this.onClose?.(r);
    const poll = (): void => {
      if (!inner.open) return;
      for (const ch of [RELIABLE, UNRELIABLE] as const) {
        const high = inner.bufferedBytes(ch) > BUFFERED_LOW_BYTES;
        if (this.high[ch] && !high) this.onBufferedLow?.(ch);
        this.high[ch] = high;
      }
      net.schedule(net.now + 2, poll);
    };
    poll();
  }
  private now(): number {
    return this.net.now;
  }
  get open(): boolean {
    return this.inner.open;
  }
  send(channel: Channel, bytes: Uint8Array): void {
    if (this.inner.open) {
      this.wire += bytes.length + 80 * Math.ceil(bytes.length / 1150);
      if (channel === RELIABLE) {
        this.sentAt.push(this.now());
        this.largest = Math.max(this.largest, bytes.length);
      }
    }
    this.inner.send(channel, bytes);
  }
  bufferedBytes(channel: Channel): number {
    return this.inner.bufferedBytes(channel);
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
}

/** The client end: records how long each reliable message took beyond the latency. */
class TimedEnd implements Transport {
  onMessage: Transport['onMessage'] = null;
  onClose: Transport['onClose'] = null;
  private next = 0;
  /** Wait of every reliable message received, with the time it arrived. */
  readonly waits: Array<{ at: number; ms: number }> = [];
  /** Tick of the newest sample of each ship and entity (by id; ships negative). */
  private readonly lastSample = new Map<number, number>();
  /** Ticks between two samples of one thing (gaps up to SAMPLE_GAP_MAX: it kept moving), with when. */
  readonly gaps: Array<{ at: number; ticks: number }> = [];
  constructor(
    private readonly inner: Transport,
    private readonly server: MeteredEnd,
    private readonly now: () => number,
  ) {
    inner.onMessage = (ch, b) => {
      if (ch === RELIABLE) this.waits.push({ at: now(), ms: now() - server.sentAt[this.next++]! - ROOM_LATENCY_MS });
      else this.noteSamples(b);
      this.onMessage?.(ch, b);
    };
    inner.onClose = (r) => this.onClose?.(r);
  }
  private noteSamples(b: Uint8Array): void {
    const m = decodeServerMessage(b, UNRELIABLE);
    if (m.type !== 'samples') return;
    const at = this.now();
    const note = (id: number): void => {
      const last = this.lastSample.get(id);
      if (last !== undefined && m.tick > last && m.tick - last <= SAMPLE_GAP_MAX) this.gaps.push({ at, ticks: m.tick - last });
      if (last === undefined || m.tick > last) this.lastSample.set(id, m.tick);
    };
    for (const sh of m.ships) note(-sh.id);
    for (const e of m.entities) note(e.id);
  }
  get open(): boolean {
    return this.inner.open;
  }
  send(channel: Channel, bytes: Uint8Array): void {
    this.inner.send(channel, bytes);
  }
  bufferedBytes(channel: Channel): number {
    return this.inner.bufferedBytes(channel);
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
}

interface Guest {
  client: HeadlessClient;
  server: MeteredEnd | null;
  timed: TimedEnd | null;
  /** Server tick when it was added, when it became ready, when its circle was complete. */
  addedTick: number;
  readyTick: number | null;
  completeTick: number | null;
}

/** What one guest got over a window. */
export interface GuestReport {
  key: string;
  seconds: number;
  /** Payload bytes per second by TickBatch section (only the sections that carried bytes). */
  sections: Record<string, number>;
  /** TickBatch payload bytes per second. */
  batchBps: number;
  /** Samples payload bytes per second. */
  sampleBps: number;
  /** Payload plus header bytes per second (80 per started 1150 bytes of a message). */
  wireBps: number;
  largestBatch: number;
  /** Batch waits at the host beyond the latency, ms: largest and 95th percentile. */
  waitMaxMs: number;
  waitP95Ms: number;
  /** Ticks between two samples of one moving thing at the guest: 95th percentile and largest. */
  sampleGapP95: number;
  sampleGapMax: number;
  /** Ticks from addGuests() to ready, and to every column of the circle sent (null: not within the run). */
  joinTicks: number | null;
  completeTicks: number | null;
}

export interface RoomReport {
  guests: GuestReport[];
  /** Host cost per tick, wall ms: simulation and Replicator, mean and largest. */
  simMeanMs: number;
  simMaxMs: number;
  replicatorMeanMs: number;
  replicatorMaxMs: number;
  ticks: number;
}

export interface RoomOptions {
  generator: GeneratorSpec;
  /** Uplink of the host, bytes per second shared by the guests; null: unlimited. */
  uplinkBytesPerSec: number | null;
  viewRadius?: number;
  /** Columns the server generates between two ticks (the browser's 6 ms is about 2.6). */
  chunkColumns?: number;
  /** Before the first tick (the world as a save would bring it). */
  setup?: (sim: Simulation) => void;
  /** Measure wall time of the server's tick parts (measurements only; tests leave it off). */
  timing?: boolean;
}

const wall = (): number => performance.now();

export class Room {
  readonly h: NetHarness;
  readonly uplink: SharedUplink | null;
  host!: HeadlessClient;
  readonly guests: Guest[] = [];
  private readonly viewRadius: number;
  /** Per-tick hooks of the scene (the harness has one slot, the room takes it). */
  readonly tickHooks: Array<() => void> = [];
  private window: { tick: number; stats: Map<string, ClientStats>; wire: Map<string, number>; waitFrom: number } | null = null;
  private cost = { n: 0, sim: 0, simMax: 0, rep: 0, repMax: 0 };
  /** The Worker's ends of the guests' ports (stall()). */
  private readonly serverPorts: FakePort[] = [];

  private constructor(private readonly o: RoomOptions) {
    this.h = new NetHarness({ chunkColumns: o.chunkColumns ?? 3 });
    this.uplink = o.uplinkBytesPerSec === null ? null : new SharedUplink(this.h.net, o.uplinkBytesPerSec);
    this.viewRadius = o.viewRadius ?? DEFAULT_VIEW_RADIUS;
  }

  /** A world with the host's own client in it, ready; the room is open. */
  static async open(o: RoomOptions): Promise<Room> {
    const r = new Room(o);
    const h = r.h;
    await h.create(testMeta(), { generator: o.generator, exampleShip: false });
    o.setup?.(h.sim);
    if (o.timing === true) r.timeParts();
    h.onTick = () => {
      for (const g of r.guests) {
        if (g.readyTick === null && g.client.ready) g.readyTick = h.sim.ticks;
        if (g.completeTick === null && g.readyTick !== null && h.host.replicator.clientView(g.client.key)?.pendingColumns === 0) g.completeTick = h.sim.ticks;
      }
      for (const f of r.tickHooks) f();
    };
    r.host = h.addClient('host', {}, { local: true, viewRadius: r.viewRadius });
    h.runUntil(() => r.host.ready, 120_000);
    await h.host.control({ type: 'openRoom' });
    return r;
  }

  get sim(): Simulation {
    return this.h.sim;
  }

  /** The server's control of a player. */
  ctrl(c: HeadlessClient): PlayerControl {
    return this.sim.players.get(c.key)!;
  }

  /** `n` guests dial at once; their downward links share the uplink. */
  addGuests(n: number): HeadlessClient[] {
    const out: HeadlessClient[] = [];
    for (let i = 0; i < n; i++) {
      const key = `g${this.guests.length + 1}`;
      const g: Guest = { client: null as unknown as HeadlessClient, server: null, timed: null, addedTick: this.sim.ticks, readyTick: null, completeTick: null };
      const now = (): number => this.h.net.now;
      const up: LinkConditions = { latencyMs: ROOM_LATENCY_MS, jitterMs: 0, loss: 0, seed: 100 + this.guests.length * 2 };
      const down: LinkConditions = { latencyMs: ROOM_LATENCY_MS, jitterMs: 0, loss: 0, seed: 101 + this.guests.length * 2, ...(this.uplink !== null ? { shared: this.uplink } : {}) };
      g.client = this.h.addClient(
        key,
        {},
        {
          viewRadius: this.viewRadius,
          transport: () => {
            // The guest's data channels; the host page's end goes through the real forwarder
            // (backlog reports and all) into the server's PortTransport, as in a room.
            const pair = createLoopbackPair(this.h.net, up, down);
            g.server = new MeteredEnd(pair.server, this.h.net);
            g.timed = new TimedEnd(pair.client, g.server, now);
            const [ps, pf] = fakePorts(this.h.net);
            this.serverPorts.push(ps);
            new PortForwarder(pf, g.server, netTimers(this.h.net));
            this.h.host.connect(new PortTransport(ps, () => this.h.net.now), false);
            return g.timed;
          },
        },
      );
      this.guests.push(g);
      out.push(g.client);
    }
    return out;
  }

  /**
   * The server's Worker is busy for `ms` (one long tick, a GC): no tick runs and nothing from the
   * ports reaches it; then what queued meanwhile (the forwarders' backlog reports among it) is
   * delivered 0.02 ms apart, as a Worker gets its queued messages after a long task.
   */
  stall(ms: number): void {
    this.h.clock.freeze();
    for (const p of this.serverPorts) p.hold();
    this.h.net.advanceBy(ms);
    for (const p of this.serverPorts) p.release();
    this.h.net.advanceBy(1);
    this.h.clock.thaw();
  }

  /** Run until every guest is ready (at most `maxMs`). */
  untilReady(maxMs = 300_000): void {
    this.h.runUntil(() => this.guests.every((g) => g.client.ready), maxMs, 50);
  }

  /** Run until every guest has every column of its circle (at most `maxMs`). */
  untilComplete(maxMs = 300_000): void {
    this.h.runUntil(() => this.guests.every((g) => g.completeTick !== null), maxMs, 50);
  }

  /** Run until nothing waits in the uplink for any guest, then one more second (the window starts clean). */
  settle(): void {
    // Checked off the tick's phase (every 7 ms): right after a tick its batches are always on their way.
    this.h.runUntil(() => this.guests.every((g) => g.server === null || (g.server.bufferedBytes(RELIABLE) === 0 && g.server.bufferedBytes(UNRELIABLE) === 0)), 300_000, 7);
    this.h.run(1000);
  }

  /** Begin a measurement window. */
  start(): void {
    const stats = new Map<string, ClientStats>();
    const wire = new Map<string, number>();
    for (const g of this.guests) {
      const s = this.h.host.replicator.stats(g.client.key);
      if (s !== undefined) stats.set(g.client.key, { ...s, sectionBytes: [...s.sectionBytes] });
      wire.set(g.client.key, g.server?.wire ?? 0);
      if (g.server !== null) g.server.largest = 0;
    }
    this.window = { tick: this.sim.ticks, stats, wire, waitFrom: this.h.net.now };
    this.cost = { n: 0, sim: 0, simMax: 0, rep: 0, repMax: 0 };
  }

  /** End the window: what each guest got. */
  stop(): RoomReport {
    const w = this.window;
    if (w === null) throw new Error('Room.stop() before start()');
    const ticks = this.sim.ticks - w.tick;
    const seconds = ticks / 20;
    const guests: GuestReport[] = [];
    for (const g of this.guests) {
      const key = g.client.key;
      const s = this.h.host.replicator.stats(key);
      const s0 = w.stats.get(key);
      const zero: ClientStats = { batches: 0, reliableBytes: 0, sampleMessages: 0, sampleBytes: 0, sectionBytes: new Array<number>(13).fill(0), largestBatch: 0, lastBatch: 0 };
      const a = s0 ?? zero;
      const b = s ?? a;
      const sections: Record<string, number> = {};
      SECTION_NAMES.forEach((name) => {
        const bit = SECTION[name];
        const d = b.sectionBytes[bit]! - a.sectionBytes[bit]!;
        if (d > 0) sections[name] = Math.round(d / seconds);
      });
      const waits = (g.timed?.waits ?? []).filter((x) => x.at >= w.waitFrom).map((x) => x.ms).sort((p, q) => p - q);
      const gaps = (g.timed?.gaps ?? []).filter((x) => x.at >= w.waitFrom).map((x) => x.ticks).sort((p, q) => p - q);
      guests.push({
        key,
        seconds,
        sections,
        batchBps: Math.round((b.reliableBytes - a.reliableBytes) / seconds),
        sampleBps: Math.round((b.sampleBytes - a.sampleBytes) / seconds),
        wireBps: Math.round(((g.server?.wire ?? 0) - (w.wire.get(key) ?? 0)) / seconds),
        largestBatch: g.server?.largest ?? 0,
        waitMaxMs: Math.round(waits.at(-1) ?? 0),
        waitP95Ms: Math.round(waits[Math.floor(waits.length * 0.95)] ?? 0),
        sampleGapP95: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
        sampleGapMax: gaps.at(-1) ?? 0,
        joinTicks: g.readyTick === null ? null : g.readyTick - g.addedTick,
        completeTicks: g.completeTick === null ? null : g.completeTick - g.addedTick,
      });
    }
    const c = this.cost;
    this.window = null;
    return {
      guests,
      simMeanMs: c.n > 0 ? c.sim / c.n : 0,
      simMaxMs: c.simMax,
      replicatorMeanMs: c.n > 0 ? c.rep / c.n : 0,
      replicatorMaxMs: c.repMax,
      ticks,
    };
  }

  private timeParts(): void {
    const sim = this.sim;
    const rep = this.h.host.replicator;
    const tick = sim.tick.bind(sim);
    const endTick = rep.endTick.bind(rep);
    let simMs = 0;
    sim.tick = () => {
      const t0 = wall();
      tick();
      simMs = wall() - t0;
    };
    rep.endTick = () => {
      const t0 = wall();
      endTick();
      const repMs = wall() - t0;
      const c = this.cost;
      c.n++;
      c.sim += simMs;
      c.rep += repMs;
      c.simMax = Math.max(c.simMax, simMs);
      c.repMax = Math.max(c.repMax, repMs);
    };
  }
}

// ====================================================================== scenes

/** A terrain column made "modified" by a player: a few blocks placed on it. */
function touchColumns(sim: Simulation, cx0: number, cz0: number, radius: number, rng: Rng): void {
  for (let cx = cx0 - radius; cx <= cx0 + radius; cx++) {
    for (let cz = cz0 - radius; cz <= cz0 + radius; cz++) {
      if (sim.world.getChunk(cx, cz) === undefined) sim.chunks.loadColumn(sim.generator, cx, cz);
      for (let i = 0; i < 6; i++) {
        const x = cx * 16 + rng.int(0, 15);
        const z = cz * 16 + rng.int(0, 15);
        sim.world.setCell(x, 100 + rng.int(0, 10), z, makeCell(B.PLANKS_OAK));
      }
    }
  }
}

/**
 * Scene 1: three guests join at once beside a built-up area: the 11 x 11 columns about the spawn
 * modified (a few blocks placed on each: their snapshots are the terrain's, about 2.6 KB). While
 * they load, a block changes beside the spawn every tick (must-send content for the guests that
 * have that column). Window: from the dial to every guest's full circle.
 */
export async function joinBuiltUp(uplink: number | null, timing = false, stall: { everyTicks: number; ms: number } | null = null): Promise<RoomReport> {
  const room = await Room.open({
    generator: TERRAIN,
    uplinkBytesPerSec: uplink,
    timing,
    setup: (sim) => touchColumns(sim, Math.floor(sim.spawnPoint.x) >> 4, Math.floor(sim.spawnPoint.z) >> 4, 5, new Rng(3)),
  });
  const sim = room.sim;
  const sx = Math.floor(sim.spawnPoint.x) + 3;
  const sz = Math.floor(sim.spawnPoint.z) + 3;
  room.tickHooks.push(() => sim.world.setCell(sx, 110, sz, makeCell(sim.ticks % 2 === 0 ? B.STONE : B.DIRT)));
  room.start();
  room.addGuests(3);
  if (stall !== null) {
    // The server's Worker is busy for stall.ms every stall.everyTicks ticks while they load.
    const complete = (): boolean => room.guests.every((g) => g.completeTick !== null);
    for (let n = 0; n < 1000 && !complete(); n++) {
      const next = sim.ticks + stall.everyTicks;
      room.h.runUntil(() => sim.ticks >= next || complete(), 300_000, 1);
      if (!complete()) room.stall(stall.ms);
    }
  }
  room.untilComplete();
  return room.stop();
}

/**
 * Scene 2: a 3700-cell plank deck assembles beside all four players (standing on an island next to
 * it), sails 10 s and docks. Window: from the assembly to 2 s after the docking.
 */
export async function bigShip(uplink: number | null, timing = false): Promise<RoomReport> {
  const DECK = SEA_TOP - 1;
  const bigX = 12;
  const room = await Room.open({
    generator: SEA,
    uplinkBytesPerSec: uplink,
    timing,
    setup: (sim) => {
      loadArea(sim, -40, -70, 90, 70);
      island(sim, -6, -6, 6, 6);
      fill(sim, bigX, DECK, -50, bigX + 36, DECK, 49, B.PLANKS_OAK);
      sim.world.setCell(bigX + 18, SEA_TOP, 40, makeCell(B.HELM, facingState(NZ)));
    },
  });
  room.addGuests(3);
  room.untilComplete();
  room.settle();
  const sim = room.sim;
  const bot = sim.join('bot');
  bot.emptyHand();
  bot.teleport(bigX + 18.5, SEA_TOP, 41.5);
  room.h.ticks(2);
  useOn(room.h, bot, bigX + 18, SEA_TOP, 40);
  room.start();
  useOn(room.h, bot, bigX + 18, SEA_TOP, 40);
  const ship = sim.structures.ships()[0];
  if (!(ship instanceof Ship)) throw new Error('the big ship did not assemble');
  bot.player.input.forward = 1;
  room.h.ticks(200);
  bot.player.input.forward = 0;
  room.h.ticks(60);
  bot.player.input.sneak = true;
  bot.use();
  room.h.ticks(1);
  bot.player.input.sneak = false;
  room.h.ticks(40);
  if (!ship.removed) throw new Error('the big ship did not dock');
  return room.stop();
}

/**
 * Scene 3: the four fly apart at full speed (creative, sprint-flying) for 15 s, over terrain nobody
 * has visited or (`modified`) over terrain whose every column in their way was modified.
 */
export async function flyApart(uplink: number | null, modified: boolean, timing = false): Promise<RoomReport> {
  const room = await Room.open({
    generator: TERRAIN,
    uplinkBytesPerSec: uplink,
    timing,
    setup: modified
      ? (sim) => {
          const cx = Math.floor(sim.spawnPoint.x) >> 4;
          const cz = Math.floor(sim.spawnPoint.z) >> 4;
          const rng = new Rng(9);
          // Four swaths 21 columns wide and 30 long, one along each direction of flight.
          for (let along = 0; along < 30; along++) {
            for (let across = -10; across <= 10; across++) {
              for (const [dx, dz] of [
                [along, across],
                [-along, across],
                [across, along],
                [across, -along],
              ] as const) {
                touchColumns(sim, cx + dx, cz + dz, 0, rng);
              }
            }
          }
        }
      : undefined,
  });
  room.addGuests(3);
  room.untilComplete();
  room.settle();
  const players = [room.host, ...room.guests.map((g) => g.client)];
  for (const c of players) {
    c.emptyHand();
    c.input.jumpPresses += 2;
  }
  room.h.run(500);
  // Above the hills (the server moves them: a correction each), still flying.
  const sp = room.sim.spawnPoint;
  for (const c of players) room.ctrl(c).teleport(sp.x, FLY_Y, sp.z);
  room.h.run(1000);
  room.start();
  players.forEach((c, i) => {
    c.input.yaw = (i * Math.PI) / 2;
    c.input.pitch = 0;
    c.input.forward = 1;
    c.input.sprint = true;
  });
  room.h.run(15_000);
  for (const c of players) c.stopInput();
  return room.stop();
}

/** Scene 4: all four stand on the example windmill boat while a helmsman sails it in circles for 30 s. */
export async function windmillShip(uplink: number | null, timing = false): Promise<RoomReport> {
  let boat: ReturnType<typeof exampleBoat> | null = null;
  const room = await Room.open({ generator: SEA, uplinkBytesPerSec: uplink, timing, setup: (sim) => (boat = exampleBoat(sim)) });
  room.addGuests(3);
  room.untilComplete();
  room.settle();
  const sim = room.sim;
  const bot = sim.join('bot');
  const { ship } = launchBoat(room.h, boat!, bot);
  // Everybody onto the deck, spread along it (the server moves them: a correction each).
  const players = [room.host, ...room.guests.map((g) => g.client)];
  players.forEach((c, i) => {
    const at = boat!.at(-1 + (i % 2) * 2, BEARING_V - 2 - Math.floor(i / 2) * 2, DECK_Y);
    room.ctrl(c).teleport(at.x + 0.5, DECK_Y, at.z + 0.5);
  });
  room.h.run(2000);
  room.start();
  bot.player.input.forward = 1;
  bot.player.input.strafe = 0.5;
  room.h.run(30_000);
  if (ship.removed) throw new Error('the windmill boat went');
  return room.stop();
}

/**
 * Scene 5: a chain of blast crates (a 6 x 6 x 2 block of them on an island, drops on) goes off 30
 * blocks from the players; with `line`, a longer chain: a 26 x 1 x 4 line of 104 crates from 20
 * blocks away, whose must-send content alone is more than a guest's share of 256 kbit/s at its
 * peak. Window: from the fuse to 3 s after the last crate.
 */
export async function blastChain(uplink: number | null, timing = false, line = false): Promise<RoomReport> {
  const room = await Room.open({
    generator: SEA,
    uplinkBytesPerSec: uplink,
    timing,
    setup: (sim) => {
      if (line) {
        loadArea(sim, -40, -40, 80, 40);
        island(sim, -8, -8, 60, 12);
        fill(sim, 20, SEA_TOP - 3, -2, 50, SEA_TOP - 1, 6, B.DIRT);
        fill(sim, 22, SEA_TOP, 0, 47, SEA_TOP, 3, B.TNT);
      } else {
        loadArea(sim, -40, -40, 70, 40);
        island(sim, -6, -6, 50, 10);
        fill(sim, 30, SEA_TOP - 4, -3, 40, SEA_TOP - 1, 7, B.DIRT);
        fill(sim, 32, SEA_TOP, -1, 37, SEA_TOP + 1, 4, B.TNT);
      }
      sim.setRules({ defaultMode: sim.rules.defaultMode, dropsEnabled: true });
    },
  });
  room.addGuests(3);
  room.untilComplete();
  room.settle();
  const sim = room.sim;
  room.start();
  const [fx, fy, fz] = line ? [22, SEA_TOP, 0] : [32, SEA_TOP + 1, -1];
  sim.world.setCell(fx, fy, fz, makeCell(B.AIR));
  sim.entities.spawnTnt(fx + 0.5, fy, fz + 0.5, 1);
  let quiet = 0;
  room.h.runUntil(() => {
    const crates = sim.entities.all().some((e) => e.kind === 'tnt');
    quiet = crates ? 0 : quiet + 1;
    return quiet > 300;
  }, 120_000);
  return room.stop();
}

/** Scene 6: a dam of 16 x 16 x 4 water sources on an island breaks beside the players; 30 s. */
export async function damBreak(uplink: number | null, timing = false): Promise<RoomReport> {
  let breakIt: (() => void) | null = null;
  const room = await Room.open({
    generator: SEA,
    uplinkBytesPerSec: uplink,
    timing,
    setup: (sim) => {
      loadArea(sim, -40, -40, 70, 40);
      island(sim, -6, -6, 60, 30);
      breakIt = bigDam(sim, 20, 0);
    },
  });
  room.addGuests(3);
  room.untilComplete();
  room.settle();
  room.start();
  breakIt!();
  room.h.run(30_000);
  return room.stop();
}

/** A glass basin of 16 x 16 water sources, 4 deep, whose +X wall is stone; returns what breaks it. */
function bigDam(sim: Simulation, x0: number, z0: number): () => void {
  const y0 = SEA_TOP;
  const n = 17;
  for (let x = x0; x <= x0 + n; x++) {
    for (let z = z0; z <= z0 + n; z++) {
      for (let y = y0; y <= y0 + 3; y++) {
        const wall = x === x0 || x === x0 + n || z === z0 || z === z0 + n;
        sim.world.setCell(x, y, z, makeCell(wall ? (x === x0 + n ? B.STONE : B.GLASS) : B.WATER));
      }
    }
  }
  return () => fill(sim, x0 + n, y0, z0 + 1, x0 + n, y0 + 3, z0 + n - 1, B.AIR);
}


/** One line of the measurement table. */
export function formatReport(scene: string, uplink: string, r: RoomReport): string[] {
  const out: string[] = [];
  for (const g of r.guests) {
    const sec = Object.entries(g.sections)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    out.push(
      `${scene} | ${uplink} | ${g.key} | batch ${g.batchBps} B/s (${sec}) | samples ${g.sampleBps} B/s | wire ${g.wireBps} B/s | largest ${g.largestBatch} | wait max ${g.waitMaxMs} ms p95 ${g.waitP95Ms} ms | sample gap p95 ${g.sampleGapP95} max ${g.sampleGapMax} t | join ${g.joinTicks ?? '-'} t | complete ${g.completeTicks ?? '-'} t`,
    );
  }
  out.push(
    `${scene} | ${uplink} | host cost over ${r.ticks} ticks: sim ${r.simMeanMs.toFixed(2)} ms mean, ${r.simMaxMs.toFixed(1)} max; replicator ${r.replicatorMeanMs.toFixed(2)} mean, ${r.replicatorMaxMs.toFixed(1)} max`,
  );
  return out;
}
