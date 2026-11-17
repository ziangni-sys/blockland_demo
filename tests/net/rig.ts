/**
 * Test rig for the Replicator (package 4): a real Simulation, a Replicator attached to it, and
 * clients whose sink is a recorder. Every message a client receives is decoded (codec.ts) and
 * applied to its ReplicaState (batches with applyBatch, then the samples of the same tick with
 * applySamples: a lossless link, unless the client drops its samples). After every tick the rig
 * compares the server's and every replica's digests (digest.ts) over the columns that changed in
 * that tick, every structure and entity; check('full') compares every column.
 *
 * WHAT THE CLIENT SHOULD HAVE is decided here from the rules of sections 6 to 8, not from the
 * Replicator's own bookkeeping (interestOracle): the server digest is taken over that scope, so
 * an entity or structure the Replicator sent outside the interest, or one it forgot, shows up as
 * a difference.
 *  - Every tick: the replica's columns lie within r + 2 of the player's column; each entity it
 *    holds is not the player's own and is either free over a column it holds or carried by a
 *    structure it holds; each structure it holds exists on the server (content compared).
 *  - check('full') (call it when nothing is deferred any more) also requires: every column of the
 *    circle r; every server structure with a cell in a column the replica holds, with its whole
 *    root group; every entity in the interest so defined; no world glue outside its columns.
 *
 * Scripted actions that tick the simulation (PlayerControl.useOn, mine) are re-implemented here so
 * that every tick is followed by Replicator.endTick().
 */
import { expect } from 'vitest';
import { ID_MASK } from '../../src/blocks/cell';
import type { Dir } from '../../src/core/dirs';
import { applyBatch, applySamples, applyWelcome, ReplicaState } from '../../src/net/client/apply';
import { decodeServerMessage } from '../../src/net/codec';
import type { SamplesMsg, TickBatchMsg } from '../../src/net/protocol';
import { Replicator, type BatchLimits, type ClientFeed } from '../../src/net/server/replicator';
import { RELIABLE, UNRELIABLE, type Channel } from '../../src/net/transport';
import type { PlayerControl } from '../../src/sim/players';
import type { Simulation } from '../../src/sim/simulation';
import type { PlayerKey } from '../../src/sim/view';
import { chunkKey } from '../../src/voxel/chunk';
import type { World } from '../../src/voxel/world';
import { compareReplica, DigestContext, replicaDigest, serverDigest, type Scope } from './digest';

/** A ClientSink that records what is sent and reports a backlog the test sets. */
export class Recorder {
  readonly queue: Array<{ channel: Channel; bytes: Uint8Array }> = [];
  /** Reported backlog per channel. */
  readonly backlog: [number, number] = [0, 0];
  send(channel: Channel, bytes: Uint8Array): void {
    this.queue.push({ channel, bytes: bytes.slice() });
  }
  bufferedBytes(channel: Channel): number {
    return this.backlog[channel];
  }
}

export interface BatchLog {
  tick: number;
  bytes: number;
  batch: TickBatchMsg;
  raw: Uint8Array;
}

export class TestClient {
  readonly sink = new Recorder();
  readonly state: ReplicaState;
  readonly batches: BatchLog[] = [];
  readonly samples: Array<{ msg: SamplesMsg; bytes: number }> = [];
  /** Every byte array received (to search for things that must never be sent). */
  readonly raw: Uint8Array[] = [];
  /** Called after each applied batch (before its samples). */
  onBatch: ((b: TickBatchMsg) => void) | null = null;
  /** Columns snapshotted or unsubscribed by the batches since the last take. */
  touched = new Set<number>();
  /** Samples are recorded but not applied (a lossy unreliable channel). */
  dropSamples = false;

  constructor(
    readonly key: PlayerKey,
    sim: Simulation,
    /** The subscription radius the Replicator was given. */
    public viewRadius: number,
  ) {
    this.state = new ReplicaState({ generate: (cx, cz) => sim.generator.generate(cx, cz) });
  }

  /** Decode and apply everything recorded; returns the number of TickBatches. */
  drain(): number {
    let n = 0;
    const q = this.sink.queue.splice(0);
    for (const m of q) {
      this.raw.push(m.bytes);
      const msg = decodeServerMessage(m.bytes, m.channel);
      if (msg.type === 'tickBatch') {
        expect(m.channel).toBe(RELIABLE);
        applyBatch(this.state, msg);
        for (const s of msg.snapshots) this.touched.add(chunkKey(s.cx, s.cz));
        for (const u of msg.unsubscribe) this.touched.add(chunkKey(u.cx, u.cz));
        this.batches.push({ tick: msg.tick, bytes: m.bytes.length, batch: msg, raw: m.bytes });
        this.onBatch?.(msg);
        n++;
      } else if (msg.type === 'samples') {
        expect(m.channel).toBe(UNRELIABLE);
        // Nothing is sampled that the client has not been given (its batch came first).
        for (const sh of msg.ships) expect(this.state.structures.has(sh.id), `${this.key}: sample of unknown ship ${sh.id}`).toBe(true);
        for (const e of msg.entities) expect(this.state.entities.has(e.id), `${this.key}: sample of unknown entity ${e.id}`).toBe(true);
        if (!this.dropSamples) applySamples(this.state, msg);
        this.samples.push({ msg, bytes: m.bytes.length });
      } else {
        throw new Error(`unexpected server message ${msg.type}`);
      }
    }
    return n;
  }
}

export interface JoinOpts {
  viewRadius?: number;
  name?: string;
  host?: boolean;
  feed?: ClientFeed;
  /** Join the simulation first (default true; false when the player has already joined). */
  join?: boolean;
}

export class Rig {
  readonly rep: Replicator;
  readonly ctx: DigestContext;
  readonly clients = new Map<PlayerKey, TestClient>();
  /** Columns changed (cells or world glue) during the last tick. */
  private changed = new Set<number>();
  /** Compare digests after every tick. */
  checkEveryTick = true;
  /** Compare poses in the per-tick checks (off where samples may be deferred). */
  checkPoses = true;

  constructor(
    readonly sim: Simulation,
    limits?: BatchLimits,
  ) {
    this.rep = new Replicator(sim, limits);
    this.ctx = new DigestContext(sim.generator);
    sim.world.onCellChange((x, _y, z) => this.changed.add(chunkKey(x >> 4, z >> 4)));
    sim.worldGlue.onChange((_a, x, _y, z) => this.changed.add(chunkKey(x >> 4, z >> 4)));
  }

  join(key: PlayerKey, o: JoinOpts = {}): TestClient {
    if (o.join ?? true) this.sim.join(key);
    const c = new TestClient(key, this.sim, o.viewRadius ?? 3);
    this.rep.addClient({ key, name: o.name ?? key, host: o.host ?? false, viewRadius: c.viewRadius, sink: c.sink, ...(o.feed !== undefined ? { feed: o.feed } : {}) });
    const ctrl = this.sim.players.get(key)!;
    applyWelcome(c.state, {
      type: 'welcome',
      entityId: ctrl.entityId,
      generator: { kind: 'void', seed: 0 },
      worldTime: this.sim.ticks,
      dayOffset: this.sim.dayOffset,
      rules: { ...this.sim.rules },
      isHost: o.host ?? false,
      roomOpen: false,
      players: this.rep.playerTable(),
    });
    this.clients.set(key, c);
    return c;
  }

  leave(key: PlayerKey): void {
    this.rep.removeClient(key);
    this.sim.leave(key);
    this.clients.delete(key);
  }

  setViewRadius(key: PlayerKey, r: number): void {
    this.rep.setViewRadius(key, r);
    this.clients.get(key)!.viewRadius = r;
  }

  ctrl(key: PlayerKey): PlayerControl {
    return this.sim.players.get(key)!;
  }

  /** Run ticks: sim.tick, endTick, deliver and apply, check. */
  /** Milliseconds spent in each phase (profiling the tests themselves). */
  readonly ms = { sim: 0, replicator: 0, apply: 0, check: 0 };

  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      let t = performance.now();
      this.sim.tick();
      this.ms.sim += performance.now() - t;
      t = performance.now();
      this.rep.endTick();
      this.ms.replicator += performance.now() - t;
      t = performance.now();
      for (const c of this.clients.values()) expect(c.drain(), `${c.key}: one TickBatch per tick`).toBe(1);
      this.ms.apply += performance.now() - t;
      t = performance.now();
      if (this.checkEveryTick) this.check('tick');
      this.ms.check += performance.now() - t;
      this.changed = new Set();
      for (const c of this.clients.values()) c.touched = new Set();
    }
  }

  /** Compare every client's replica with the server: the columns changed or touched in the last tick ('tick'), or all ('full'). */
  check(kind: 'tick' | 'full' = 'full', poses = this.checkPoses): void {
    for (const c of this.clients.values()) {
      let cols: Set<number> | undefined;
      if (kind === 'tick') cols = new Set([...this.changed, ...c.touched]);
      const { scope, violations } = interestOracle(this.sim, c, kind === 'full');
      const s = serverDigest(this.ctx, this.sim, scope, cols);
      const r = replicaDigest(c.state, cols);
      const diff = [...violations, ...compareReplica(s, r, { poses })];
      expect(diff, `${c.key} at tick ${this.sim.ticks}`).toEqual([]);
    }
  }

  /** Aim at a cell and right-click once, then one tick (PlayerControl.useOn with endTick). */
  useOn(key: PlayerKey, x: number, y: number, z: number, face?: Dir, gridId = 0): void {
    const ctrl = this.ctrl(key);
    expect(ctrl.aimAt(x, y, z, face, gridId), `${key} aims at ${x},${y},${z} of grid ${gridId}`).toBe(true);
    ctrl.use();
    this.tick();
  }

  /** Aim at a cell and hold attack until it changes (PlayerControl.mine with endTick). */
  mine(key: PlayerKey, x: number, y: number, z: number, face?: Dir, gridId = 0, maxTicks = 400): void {
    const ctrl = this.ctrl(key);
    expect(ctrl.aimAt(x, y, z, face, gridId, true), `${key} aims at ${x},${y},${z}`).toBe(true);
    const grid = this.sim.structures.gridById(gridId)!;
    const before = grid.getCell(x, y, z);
    const input = ctrl.player.input;
    ctrl.attack();
    input.attack = true;
    try {
      for (let i = 0; i < maxTicks; i++) {
        this.tick();
        const g = this.sim.structures.gridById(gridId);
        if (g === undefined || g.getCell(x, y, z) !== before) return;
        ctrl.aimAt(x, y, z, face, gridId, true);
      }
      throw new Error(`${key} could not mine ${x},${y},${z}`);
    } finally {
      input.attack = false;
    }
  }
}

const inCircle = (dx: number, dz: number, r: number): boolean => dx * dx + dz * dz <= r * r + r;
const columnOf = (x: number, z: number): number => chunkKey(Math.floor(x) >> 4, Math.floor(z) >> 4);

/**
 * What a client should hold, from the rules of sections 6 to 8 and what its replica holds (see the
 * file comment), and the rules it breaks. `full`: nothing is deferred any more.
 */
export function interestOracle(sim: Simulation, c: TestClient, full: boolean): { scope: Scope; violations: string[] } {
  const state = c.state;
  const ctrl = sim.players.get(c.key)!;
  const own = ctrl.entityId;
  const pcx = Math.floor(ctrl.player.pos.x) >> 4;
  const pcz = Math.floor(ctrl.player.pos.z) >> 4;
  const r = Math.max(0, Math.min(17, Math.floor(c.viewRadius)));
  const violations: string[] = [];
  const columns = state.world.chunks;
  for (const chunk of columns.values()) {
    if (!inCircle(chunk.cx - pcx, chunk.cz - pcz, r + 2)) violations.push(`column ${chunk.cx},${chunk.cz} outside r + 2 of the player's column ${pcx},${pcz}`);
  }
  const structures = new Set(state.structures.keys());
  if (full) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) if (inCircle(dx, dz, r) && !columns.has(chunkKey(pcx + dx, pcz + dz))) violations.push(`column ${pcx + dx},${pcz + dz} of the circle missing`);
    }
    const p = { x: 0, y: 0, z: 0 };
    for (const s of sim.structures.all()) {
      let hit = false;
      s.grid.forEachCell((x, y, z) => {
        if (hit) return;
        p.x = x + 0.5;
        p.y = y + 0.5;
        p.z = z + 0.5;
        const w = s.grid.toWorld(p);
        hit = columns.has(columnOf(w.x, w.z));
      });
      if (!hit) continue;
      const root = s.parent ?? s;
      structures.add(root.id);
      for (const ch of root.children) structures.add(ch.id);
    }
    const glue = state.worldGlue.toArray();
    for (let i = 0; i < glue.length; i += 4) {
      if (!columns.has(columnOf(glue[i]!, glue[i + 2]!))) violations.push(`world glue at ${glue[i]},${glue[i + 1]},${glue[i + 2]} outside the replica's columns`);
    }
  }
  const entities = new Set<number>();
  for (const e of sim.entities.all()) {
    if (e.removed) continue;
    const carrier = e.carrierId !== 0 && sim.structures.get(e.carrierId) !== undefined ? e.carrierId : 0;
    const inInterest = e.id !== own && (carrier !== 0 ? state.structures.has(carrier) : columns.has(columnOf(e.pos.x, e.pos.z)));
    if (inInterest && (full || state.entities.has(e.id))) entities.add(e.id);
  }
  if (state.entities.has(own)) violations.push(`the player's own entity ${own} is in its replica`);
  return { scope: { columns: columns.keys(), structures, entities }, violations };
}

/** Cells of block `id` among the world cells of an inclusive box (straight over the chunk arrays). */
function countWorld(world: World, id: number, box: Box): number {
  const [x0, y0, z0, x1, y1, z1] = box;
  let n = 0;
  for (const chunk of world.chunks.values()) {
    const bx = chunk.cx * 16;
    const bz = chunk.cz * 16;
    const lx0 = Math.max(0, x0 - bx);
    const lx1 = Math.min(15, x1 - bx);
    const lz0 = Math.max(0, z0 - bz);
    const lz1 = Math.min(15, z1 - bz);
    if (lx0 > lx1 || lz0 > lz1) continue;
    const cells = chunk.cells;
    for (let y = Math.max(0, y0); y <= Math.min(127, y1); y++) {
      for (let lz = lz0; lz <= lz1; lz++) {
        for (let lx = lx0; lx <= lx1; lx++) if ((cells[lx | (lz << 4) | (y << 8)]! & ID_MASK) === id) n++;
      }
    }
  }
  return n;
}

function countStructures(structures: Iterable<{ grid: { forEachCell(fn: (x: number, y: number, z: number, c: number) => void): void } }>, id: number): number {
  let n = 0;
  for (const s of structures) {
    s.grid.forEachCell((_x, _y, _z, c) => {
      if ((c & ID_MASK) === id) n++;
    });
  }
  return n;
}

/** An inclusive box of world cells: x0, y0, z0, x1, y1, z1. */
export type Box = [number, number, number, number, number, number];

/** Cells of block `id` in a replica: in its world (inside the box) plus in all its structures. */
export function countReplica(state: ReplicaState, id: number, box: Box): number {
  return countWorld(state.world, id, box) + countStructures([...state.structures.values()].map((r) => r.structure), id);
}

/** The same count on the server (loaded columns only). */
export function countServer(sim: Simulation, id: number, box: Box): number {
  return countWorld(sim.world, id, box) + countStructures(sim.structures.all(), id);
}
