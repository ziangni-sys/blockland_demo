/**
 * The Replicator (docs/NETCODE.md sections 5 to 9, 11, 13): after every sim.tick() the host calls
 * endTick(), which sends every client exactly one TickBatch on the reliable channel (also when it
 * is empty: it is the heartbeat and the clock sample) and zero or more Samples on the unreliable
 * one. It does not own connections: each client is a ClientSink (send on a channel, read the
 * backlog), and the values other packages compute arrive through a ClientFeed.
 *
 * LIFE CYCLE (the host, package 8): sim.join(key) and setDrive('client'), then addClient(); from
 * then on endTick() after every tick; removeClient() when the player leaves. Changes are collected
 * continuously (capture.ts), so what happens between two ticks goes into the next batch.
 *
 * PER CLIENT the Replicator keeps what that client has been given: the columns whose snapshot was
 * sent and the ones waiting (nearest first), the structures and entities whose spawn was sent with
 * the fields last sent, the private state last sent, the player table and the globals. Nothing is
 * ever sent about a column, structure or entity the client has not been given; what it is given
 * later comes as its state at that time.
 *
 * MUST-SEND AND MAY-DEFER (section 5). Every change to what the client already has is sent whole
 * in the tick it happened: unsubscriptions, deltas (or a resent snapshot / structure), removals,
 * despawns, rests, entity updates, the private section, events, globals, and the spawn of anything
 * that appeared in this tick inside the client's interest (with a structure: its whole root group,
 * so a new rotor never waits for a deferred ship). What entered the interest because the player
 * moved or just joined may wait: structure groups (nearest first), then entities (nearest first),
 * then column snapshots (nearest first). They fill the reliable backlog up to the line,
 * max(RELIABLE_BACKLOG_FLOOR, BACKLOG_WINDOW_S of the measured send rate), and at most
 * SNAPSHOT_BUDGET bytes per tick (section 2; package 13): a must-send batch then waits behind about
 * 0.1 s of the link at most. An item longer than what is left waits, except the first of a tick
 * while the backlog is under half the floor, so a large structure or snapshot is never starved.
 * The send rate is smoothed, but never below what a channel that emptied carried in the tick (the
 * line doubles every tick while the link keeps up). The host's own connection has no link to
 * protect (a port inside one machine that reports no backlog): it gets SNAPSHOT_BUDGET a tick,
 * the item that crosses it included, and every sample that fits the messages. The cells of all
 * CellVolumes of one batch stay within MAX_BATCH_CELLS: a deferred item that does not fit waits,
 * a resend that does not fit goes as a delta.
 *
 * SAMPLES (section 13 step 3; package 13) share the link with the batches and are stale a tick
 * later: none in a tick while more than max(SAMPLE_FLOOR_BYTES, a tick of the unreliable send
 * rate) is still queued, or while the reliable backlog is above the line (must-send content
 * already queues longer than 0.1 s: the link is over its share, samples would only deepen it),
 * otherwise at most max(SAMPLE_FLOOR_BYTES, two ticks of it), and never
 * more than SAMPLE_MESSAGES_PER_TICK messages. What does not fit waits, stalest first, staleness
 * weighted by nearness (sendSamples).
 *
 * INTEREST (interest.ts). The subscription circle is recomputed whenever the player's column or
 * the radius changes (not on a fixed 4-tick beat): every column whose snapshot was sent then lies
 * within r + 2 of the player's present column, which the structure sphere test relies on (a
 * structure with a cell in a subscribed column is in interest). Structure interest is decided
 * every tick per root group; a root counts as already in (exit threshold) while the client knows
 * it or one of its rotors, so a rotor that changes parent is not dropped on the way. Entities
 * follow what the client has: a carrier's spawn, or the snapshot of the column under the feet.
 *
 * SHARED ENCODING. A column's snapshot is encoded once per content version (ChangeCapture
 * columnVersion) and a structure's spawn record once per tick; the same bytes go into every
 * client's batch (codec.ts encodeTickBatch).
 *
 * COST WHEN NOTHING HAPPENS. Entities are kept across ticks (EntityInfo) and compared by their
 * quantised numbers; per client only the entities that changed in the tick are visited (despawn,
 * updates, samples), except after the client lost columns or structures (every known entity is
 * checked for interest) or gained some (every entity is a spawn candidate).
 *
 * TOO MUCH TO SEND. When the must-send content of one batch does not fit MAX_BATCH_CELLS or the
 * encoded batch is longer than MAX_RELIABLE_BYTES (not reachable in normal play: no tool acts on a
 * region, assembly makes one structure per click), the client is marked too slow and gets nothing
 * more; tooSlow() reports it at once and the host kicks it (too_slow).
 *
 * STATISTICS. Bytes per client and per section (stats()), from the start (section 13).
 */
import { CHUNK_SIZE, TICK_DT, WORLD_HEIGHT } from '../../core/constants';
import type { Dir } from '../../core/dirs';
import { quat, vec3, wrapAngle, type Quat, type Vec3 } from '../../core/math';
import { FallingBlockEntity, ItemEntity, Player, TntEntity, type Entity } from '../../entities/entity';
import { headingOf } from '../../entities/structs';
import type { PlayerControl } from '../../sim/players';
import type { Simulation } from '../../sim/simulation';
import type { InteractionView, Message, PlayerKey, SimEvent } from '../../sim/view';
import { Rotor, Ship, type Structure } from '../../structures/structure';
import { chunkKey, chunkKeyX, chunkKeyZ } from '../../voxel/chunk';
import { encodeSnapshotPiece, encodeStructureRecordPiece, encodeTickBatch, packSamples, type EncodedPiece } from '../codec';
import {
  CHUNK_RESEND_CELLS,
  emptyTickBatch,
  HOTBAR_SLOTS,
  MAIN_SLOTS,
  MAX_BACKLOG,
  MAX_BATCH_CELLS,
  MAX_RELIABLE_BYTES,
  MAX_UNRELIABLE_BYTES,
  MAX_VIEW_RADIUS,
  READY_CHUNK_RADIUS,
  ROTOR_RESYNC_TICKS,
  SNAPSHOT_BUDGET,
  STRUCTURE_RESEND_CELLS,
  type CellVolume,
  type ChunkDelta,
  type ChunkPos,
  type ChunkSnapshot,
  type EntityMotion,
  type EntityRecord,
  type EntitySample,
  type EntityUpdate,
  type Globals,
  type NetCorrection,
  type NetInventory,
  type NetVitals,
  type PlayerEntry,
  type PlayerFlags,
  type PlayerHeld,
  type PlayerListChange,
  type Pose,
  type PrivateEvent,
  type PrivateState,
  type ShipSample,
  type StructureDelta,
  type StructureRecord,
  type TickBatchMsg,
  type ViewUpdate,
  type WorldEvent,
  type WorldRules,
} from '../protocol';
import { RELIABLE, UNRELIABLE, type Channel } from '../transport';
import { ChangeCapture, type CaptureTake } from './capture';
import { chunkOf, circleOffsets, depthOf, inChunkCircle, rootOf, sphereGap, StructureSpheres, structureInterest } from './interest';

// ====================================================================== the host's side

/** Where a client's messages go: a Transport satisfies it (package 8 owns the connections). */
export interface ClientSink {
  send(channel: Channel, bytes: Uint8Array): void;
  /** Bytes handed to send() and not yet on the network (back-pressure, section 2). */
  bufferedBytes(channel: Channel): number;
}

/** Values other packages compute for a client, read once per endTick(). */
export interface ClientFeed {
  /** Highest intent seq processed so far (package 7), or null before the first. */
  intentAck(): number | null;
  /** Seq of the last movement report accepted in this tick (package 6), or null when none was. */
  moveAck(): number | null;
}

/** The size limits of one TickBatch (protocol.ts; tests use smaller ones to reach them). */
export interface BatchLimits {
  /** Cells of all CellVolumes in one batch (MAX_BATCH_CELLS). */
  readonly cells: number;
  /** Encoded bytes of one batch (MAX_RELIABLE_BYTES). */
  readonly bytes: number;
}

const PROTOCOL_LIMITS: BatchLimits = Object.freeze({ cells: MAX_BATCH_CELLS, bytes: MAX_RELIABLE_BYTES });

export interface ClientOptions {
  /** The joined player (sim.join(key) came first). */
  key: PlayerKey;
  /** For the player table. */
  name: string;
  /** The host's own connection. */
  host: boolean;
  /** Subscription radius in chunks (Hello.viewRadius), 0..MAX_VIEW_RADIUS. */
  viewRadius: number;
  sink: ClientSink;
  feed?: ClientFeed;
}

/** Bytes sent to one client so far (section 13). */
export interface ClientStats {
  batches: number;
  /** Encoded TickBatch bytes (message id included). */
  reliableBytes: number;
  sampleMessages: number;
  sampleBytes: number;
  /** Encoded bytes per TickBatch section, by SECTION bit. */
  readonly sectionBytes: number[];
  largestBatch: number;
  lastBatch: number;
}

/** What one client has been given (debugging, tests). */
export interface ClientView {
  readonly columns: ReadonlySet<number>;
  readonly pendingColumns: number;
  readonly structures: ReadonlySet<number>;
  readonly entities: ReadonlySet<number>;
  readonly ready: boolean;
}

// ====================================================================== constants (completed here)

/** At most this many Samples messages per client per tick (section 13). */
const SAMPLE_MESSAGES_PER_TICK = 4;
/** Upper bounds of one ship / entity sample's encoded size, for choosing what fits the messages above. */
const SHIP_SAMPLE_MAX_BYTES = 23;
const ENTITY_SAMPLE_MAX_BYTES = 24;
/** Header of a Samples message, at most (id, tick, seq, two counts). */
const SAMPLES_HEADER_MAX_BYTES = 16;
/**
 * The reliable line: deferred new interest fills the reliable backlog up to max(this, rate x
 * BACKLOG_WINDOW_S) and no further (sections 2, 13; package 13).
 */
const RELIABLE_BACKLOG_FLOOR = 2 * 1024;
const BACKLOG_WINDOW_S = 0.1;
/**
 * Samples (section 13 step 3; package 13): none in a tick while more than max(this, one tick of
 * the unreliable send rate) is still queued (they would be stale); otherwise at most
 * max(this, two ticks of that rate) bytes of them, and never more than SAMPLE_MESSAGES_PER_TICK messages.
 */
const SAMPLE_FLOOR_BYTES = 512;
/** Sample priority: ticks since an entity's (or ship's) last sample x SAMPLE_NEAR / (SAMPLE_NEAR + horizontal distance in blocks). */
const SAMPLE_NEAR = 32;
/** A reliable backlog above MAX_BACKLOG this long (ticks, 10 s) makes a client too slow (section 2). */
const TOO_SLOW_TICKS = 200;
/** Weight of the newest measurement in the smoothed send rate. */
const RATE_SMOOTHING = 0.25;
/** Budget charge of one entity spawn record (they are 17 to 30 bytes). */
const ENTITY_RECORD_COST = 32;
/** Shared snapshot bytes unused for this long are dropped (ticks). */
const SNAPSHOT_CACHE_TICKS = 200;

// ====================================================================== quantised motion

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

function roundSym(v: number): number {
  const a = Math.round(Math.abs(v));
  return v < 0 ? -a : a;
}
const qPos = (v: number): number => Math.round(v * 512);
const qRot = (c: number): number => roundSym(c * 32767);
const qAng = (a: number): number => {
  const k = Math.round((a / TWO_PI) * 65536) % 65536;
  return k < 0 ? k + 65536 : k;
};
const qPitch = (p: number): number => Math.max(-32767, Math.min(32767, roundSym((p / HALF_PI) * 32767)));

function poseKey(p: Vec3, q: Quat): string {
  return `${qPos(p.x)},${qPos(p.y)},${qPos(p.z)},${qRot(q.x)},${qRot(q.y)},${qRot(q.z)},${qRot(q.w)}`;
}

function flagBits(f: PlayerFlags): number {
  return (f.sneaking ? 1 : 0) | (f.sprinting ? 2 : 0) | (f.flying ? 4 : 0) | (f.dead ? 8 : 0) | (f.onGround ? 16 : 0);
}

function playerFlags(p: Player): PlayerFlags {
  return { sneaking: p.sneaking, sprinting: p.sprinting, flying: p.flying, dead: p.dead, onGround: p.onGround };
}

function playerFlagBits(p: Player): number {
  return (p.sneaking ? 1 : 0) | (p.sprinting ? 2 : 0) | (p.flying ? 4 : 0) | (p.dead ? 8 : 0) | (p.onGround ? 16 : 0);
}

const v3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const q4 = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

// ====================================================================== per tick, shared by all clients

/**
 * One live entity, kept from the tick it appeared and updated in place by every buildFrame(): its
 * wire motion as quantised numbers (compared with the last tick's, no strings, no allocation)
 * and what changed in this tick.
 */
interface EntityInfo {
  readonly e: Entity;
  /** The carrier as sent: 0 when it has none or the carrier no longer exists. */
  carrierId: number;
  /** Quantised position (Pos32, local to the carrier), yaw (Ang16), pitch (i16) and flag bits (-1: not a player). */
  qx: number;
  qy: number;
  qz: number;
  qyaw: number;
  qpitch: number;
  qflags: number;
  /** Column under the feet (for a free entity's interest). */
  column: number;
  /** World position and yaw quantised last (a free entity that has not moved needs no work). */
  rx: number;
  ry: number;
  rz: number;
  ryaw: number;
  moving: boolean;
  /** This tick: its quantised motion differs from the last tick's (a sample). */
  moved: boolean;
  /** This tick: it stopped moving (its final state goes into entityUpdates). */
  stopped: boolean;
  /** Items: the stack of the last tick. Blast crates: the fuse at fuseTick. */
  item: number;
  count: number;
  fuse: number;
  fuseTick: number;
  /** It appeared since the last tick (nothing to compare with yet). */
  fresh: boolean;
  /** This tick: its stack changed, or its fuse is not where the clients' countdown puts it. */
  fieldsChanged: boolean;
  /** The wire motion, built on first use in a tick (motionTick). */
  motion: EntityMotion | null;
  motionTick: number;
}

interface StructureChangeLists {
  cells?: Array<[number, number, number, number]>;
  glue?: Array<[number, number, number, 0 | 1 | 2, boolean]>;
}

interface Frame {
  readonly tick: number;
  readonly take: CaptureTake;
  readonly appearedStructures: ReadonlySet<Structure>;
  /** Entities that appeared in this tick (an id whose object was replaced included). */
  readonly appearedEntities: readonly EntityInfo[];
  /** Ids of the entities that went in this tick. */
  readonly goneEntities: readonly number[];
  /** Entities that appeared, moved, stopped or changed a field in this tick, and every player. */
  readonly changedEntities: readonly EntityInfo[];
  /** Entities whose quantised motion changed in this tick. */
  readonly movedEntities: readonly EntityInfo[];
  /** Deltas of the columns that changed, by chunk key (resent columns have none). */
  readonly chunkDeltas: Map<number, ChunkDelta>;
  /** Columns that changed in more than CHUNK_RESEND_CELLS cells. */
  readonly chunkResend: Set<number>;
  readonly structureDeltas: Map<number, StructureChangeLists>;
  readonly structureResend: Set<number>;
  /** Spawn records of this tick, encoded on first use. */
  readonly records: Map<number, EncodedPiece>;
  readonly shipSamples: Map<number, ShipSample>;
  readonly shipRests: Map<number, Pose>;
  /** Every live entity by id. */
  readonly entities: ReadonlyMap<number, EntityInfo>;
  /** World events and addressed events of the interval, in order. */
  readonly events: readonly SimEvent[];
}

interface ShipMotion {
  readonly obj: Structure;
  key: string;
  moving: boolean;
}

// ====================================================================== per client

interface SentStructure {
  readonly s: Structure;
  /** Tick of the batch that carried its spawn record. */
  since: number;
  parentId: number;
  bearingX: number;
  bearingY: number;
  bearingZ: number;
  readonly baseRotation: Quat;
  readonly rotorPosition: Vec3;
  readonly pivot: Vec3;
  helmX: number;
  helmY: number;
  helmZ: number;
  forward: Dir;
  helmsmanId: number;
  throttle: number;
  rudder: number;
  sails: number;
  frozen: boolean;
  rotorTick: number;
  /** Tick of its last sample (its spawn before the first). */
  sampled: number;
}

interface SentEntity {
  readonly e: Entity;
  since: number;
  item: number;
  count: number;
  fuse: number;
  fuseTick: number;
  flags: number;
  steering: number;
  held: number | null;
  /** Tick of its last sample (its spawn before the first). */
  sampled: number;
}

interface SentView {
  mining: string;
  gluing: string;
  previewCells: Int32Array | null;
  conflicts: string;
  hint: string;
}

interface Client {
  readonly key: PlayerKey;
  readonly name: string;
  readonly host: boolean;
  readonly sink: ClientSink;
  readonly feed: ClientFeed | null;
  viewRadius: number;
  // ---- chunks
  centerCx: number;
  centerCz: number;
  recomputeRadius: number;
  readonly columns: Set<number>;
  pending: number[];
  // ---- structures and entities
  readonly interestRoots: Set<number>;
  readonly structures: Map<number, SentStructure>;
  readonly entities: Map<number, SentEntity>;
  /** Roots in interest at the first batch (the ready condition, section 3); null once ready. */
  joinRoots: Set<number> | null;
  ready: boolean;
  // ---- samples
  sampleSeq: number;
  /** Every entity is a spawn candidate at the next deferral (the client gained columns or structures, or a deferral was cut short). */
  entityScan: boolean;
  /** Its must-send content did not fit a batch: it gets nothing more (tooSlow()). */
  overflowed: boolean;
  // ---- back-pressure, per channel
  readonly backlog: [number, number];
  readonly sentLast: [number, number];
  readonly rate: [number, number];
  slowTicks: number;
  // ---- private state last sent
  inventory: string;
  vitals: string;
  readonly view: SentView;
  ack: number | null;
  moveAck: number | null;
  // ---- globals last sent
  dayOffset: number;
  rules: string;
  readonly players: Map<number, PlayerEntry>;
  tps: number | null;
  roomOpen: boolean;
  readonly stats: ClientStats;
}

function rulesKey(r: WorldRules): string {
  return `${r.defaultMode},${r.dropsEnabled}`;
}

function messageKey(m: Message | null): string {
  return m === null ? '' : JSON.stringify([m.key, m.params ?? null]);
}

// ====================================================================== the replicator

export class Replicator {
  private readonly capture: ChangeCapture;
  private readonly spheres = new StructureSpheres();
  private readonly clients = new Map<PlayerKey, Client>();
  private readonly ships = new Map<number, ShipMotion>();
  private readonly entityInfo = new Map<number, EntityInfo>();
  private readonly scratchV = vec3();
  private readonly scratchQ = quat();
  private readonly snapshots = new Map<number, { version: number; piece: EncodedPiece; used: number }>();
  /** Subscription circle offsets by radius. */
  private readonly circles = new Map<number, Int32Array>();
  /** The player table of the tick being sent (playerTable(), once per endTick). */
  private table: PlayerEntry[] = [];
  private tpsValue: number | null = null;
  private roomOpenValue = false;

  constructor(
    private readonly sim: Simulation,
    private readonly limits: BatchLimits = PROTOCOL_LIMITS,
  ) {
    this.capture = new ChangeCapture(sim);
  }

  // ------------------------------------------------------------------ host interface

  /**
   * Start replicating to the player `key` (it has joined the simulation). Its first batch goes
   * out at the next endTick(). The player table and globals it starts from are what Welcome
   * carries (playerTable(), the simulation's rules and day offset, roomOpen).
   */
  addClient(o: ClientOptions): void {
    if (this.clients.has(o.key)) throw new Error(`replicator: client '${o.key}' already added`);
    if (this.sim.players.get(o.key) === undefined) throw new Error(`replicator: player '${o.key}' has not joined`);
    const c: Client = {
      key: o.key,
      name: o.name,
      host: o.host,
      sink: o.sink,
      feed: o.feed ?? null,
      viewRadius: clampRadius(o.viewRadius),
      centerCx: 0,
      centerCz: 0,
      recomputeRadius: -1,
      columns: new Set(),
      pending: [],
      interestRoots: new Set(),
      structures: new Map(),
      entities: new Map(),
      joinRoots: null,
      ready: false,
      sampleSeq: 0,
      entityScan: true,
      overflowed: false,
      backlog: [0, 0],
      sentLast: [0, 0],
      rate: [0, 0],
      slowTicks: 0,
      inventory: '',
      vitals: '',
      view: { mining: '', gluing: '', previewCells: null, conflicts: '', hint: '' },
      ack: null,
      moveAck: null,
      dayOffset: this.sim.dayOffset,
      rules: rulesKey(this.sim.rules),
      players: new Map(),
      tps: null,
      roomOpen: this.roomOpenValue,
      stats: { batches: 0, reliableBytes: 0, sampleMessages: 0, sampleBytes: 0, sectionBytes: new Array<number>(13).fill(0), largestBatch: 0, lastBatch: 0 },
    };
    this.clients.set(o.key, c);
    for (const p of this.playerTable()) c.players.set(p.entityId, p);
  }

  /** Stop replicating to `key` (it left, or its connection was replaced). */
  removeClient(key: PlayerKey): void {
    this.clients.delete(key);
  }

  /** SetViewRadius (section 10): takes effect at the next endTick(). */
  setViewRadius(key: PlayerKey, r: number): void {
    const c = this.clients.get(key);
    if (c !== undefined) c.viewRadius = clampRadius(r);
  }

  /**
   * The measured ticks per second (section 4); every change goes into the next batch's globals.
   * ServerHost, which has the wall clock, gives a new value at most once a second.
   */
  set tps(v: number) {
    this.tpsValue = Math.round(v * 10) / 10;
  }

  /** Whether the room accepts guests (globals; package 11). */
  set roomOpen(v: boolean) {
    this.roomOpenValue = v;
  }

  /** The player table (Welcome, globals): every client whose player is in the world, by entity id. */
  playerTable(): PlayerEntry[] {
    const out: PlayerEntry[] = [];
    for (const c of this.clients.values()) {
      const ctrl = this.sim.players.get(c.key);
      if (ctrl !== undefined) out.push({ entityId: ctrl.entityId, name: c.name, host: c.host, mode: ctrl.player.mode });
    }
    return out.sort((a, b) => a.entityId - b.entityId);
  }

  /**
   * Clients the host kicks (too_slow): the reliable backlog stayed above MAX_BACKLOG for 10 s, or a
   * batch's must-send content did not fit the batch limits (they get nothing more).
   */
  tooSlow(): PlayerKey[] {
    const out: PlayerKey[] = [];
    for (const c of this.clients.values()) if (c.slowTicks >= TOO_SLOW_TICKS || c.overflowed) out.push(c.key);
    return out;
  }

  stats(key: PlayerKey): Readonly<ClientStats> | undefined {
    return this.clients.get(key)?.stats;
  }

  /** What a client has been given (debugging, tests). */
  clientView(key: PlayerKey): ClientView | undefined {
    const c = this.clients.get(key);
    if (c === undefined) return undefined;
    return {
      columns: c.columns,
      pendingColumns: c.pending.length,
      structures: new Set(c.structures.keys()),
      entities: new Set(c.entities.keys()),
      ready: c.ready,
    };
  }

  /** Unhook from the simulation. */
  dispose(): void {
    this.capture.dispose();
    this.clients.clear();
  }

  // ------------------------------------------------------------------ the tick

  /** After every sim.tick(): one TickBatch per client (reliable) and its Samples (unreliable). */
  endTick(): void {
    const frame = this.buildFrame();
    this.table = this.playerTable();
    for (const c of this.clients.values()) {
      const ctrl = this.sim.players.get(c.key);
      if (ctrl === undefined || !ctrl.online || c.overflowed) continue;
      this.sendTo(c, ctrl, frame);
    }
    if (frame.tick % SNAPSHOT_CACHE_TICKS === 0) {
      for (const [k, v] of this.snapshots) if (v.used < frame.tick - SNAPSHOT_CACHE_TICKS) this.snapshots.delete(k);
    }
  }

  private buildFrame(): Frame {
    const sim = this.sim;
    const tick = sim.ticks;
    const sync = this.capture.sync();
    const take = this.capture.take();
    this.spheres.update(sim.structures.all());

    // ---- columns
    const chunkDeltas = new Map<number, ChunkDelta>();
    const chunkResend = new Set<number>();
    for (const [key, col] of take.columns) {
      if (col.cells.size > CHUNK_RESEND_CELLS) {
        chunkResend.add(key);
        continue;
      }
      const cells = [...col.cells].sort((a, b) => a[0] - b[0]);
      chunkDeltas.set(key, { cx: col.cx, cz: col.cz, cells, glue: [...col.glue] });
    }

    // ---- structure cells and glue
    const structureDeltas = new Map<number, StructureChangeLists>();
    const structureResend = new Set<number>();
    for (const [id, ch] of take.structures) {
      if (ch.cells.size > STRUCTURE_RESEND_CELLS) {
        structureResend.add(id);
        continue;
      }
      const d: StructureChangeLists = {};
      if (ch.cells.size > 0) d.cells = [...ch.cells.values()];
      if (ch.glue.size > 0) d.glue = [...ch.glue.values()];
      structureDeltas.set(id, d);
    }

    // ---- ship poses: a sample when the quantised pose changed, a rest when it stopped changing
    const shipSamples = new Map<number, ShipSample>();
    const shipRests = new Map<number, Pose>();
    const liveShips = new Set<number>();
    for (const s of sim.structures.ships()) {
      liveShips.add(s.id);
      const g = s.grid;
      const key = poseKey(g.position, g.rotation);
      const st = this.ships.get(s.id);
      if (st === undefined || st.obj !== s) {
        this.ships.set(s.id, { obj: s, key, moving: false });
        continue;
      }
      if (st.key !== key) {
        st.key = key;
        st.moving = true;
        shipSamples.set(s.id, { id: s.id, pose: { pos: v3(g.position), rot: q4(g.rotation) } });
      } else if (st.moving) {
        st.moving = false;
        shipRests.set(s.id, { pos: v3(g.position), rot: q4(g.rotation) });
      }
    }
    for (const id of this.ships.keys()) if (!liveShips.has(id)) this.ships.delete(id);

    // ---- entities
    const entities = this.entityInfo;
    for (const id of sync.goneEntities) entities.delete(id);
    const appearedEntities: EntityInfo[] = [];
    for (const e of sync.appearedEntities) {
      const info = newEntityInfo(e);
      entities.set(e.id, info);
      appearedEntities.push(info);
    }
    const changedEntities: EntityInfo[] = [];
    const movedEntities: EntityInfo[] = [];
    for (const info of entities.values()) {
      const fresh = info.fresh;
      info.fresh = false;
      const changed = this.quantise(info);
      info.moved = false;
      info.stopped = false;
      if (fresh) {
        // Nothing to compare with: its spawn record carries this state.
      } else if (changed) {
        info.moving = true;
        info.moved = true;
        movedEntities.push(info);
      } else if (info.moving) {
        info.moving = false;
        info.stopped = true;
      }
      info.fieldsChanged = this.fieldsChanged(info, fresh, tick);
      if (fresh || info.moved || info.stopped || info.fieldsChanged || info.e instanceof Player) changedEntities.push(info);
    }

    return {
      tick,
      take,
      appearedStructures: sync.appearedStructures,
      chunkDeltas,
      chunkResend,
      structureDeltas,
      structureResend,
      records: new Map(),
      shipSamples,
      shipRests,
      entities,
      appearedEntities,
      goneEntities: sync.goneEntities,
      changedEntities,
      movedEntities,
      events: take.events,
    };
  }

  /**
   * Update an entity's quantised wire motion (local to its carrier, yaw relative to the carrier's
   * heading; world when it has no carrier or the carrier is gone) and its column; true when the
   * quantised motion differs from the one held.
   */
  private quantise(info: EntityInfo): boolean {
    const e = info.e;
    const ep = e.pos;
    if (e.carrierId === 0 && info.carrierId === 0 && ep.x === info.rx && ep.y === info.ry && ep.z === info.rz && e.yaw === info.ryaw && !(e instanceof Player)) {
      return false;
    }
    info.rx = ep.x;
    info.ry = ep.y;
    info.rz = ep.z;
    info.ryaw = e.yaw;
    let carrierId = e.carrierId;
    let p: Vec3 = e.pos;
    let yaw = e.yaw;
    if (carrierId !== 0) {
      const carrier = this.sim.structures.get(carrierId);
      if (carrier === undefined) carrierId = 0;
      else {
        p = carrier.grid.toLocal(e.pos, this.scratchV);
        yaw = wrapAngle(e.yaw - headingOf(carrier.grid.worldRotation(this.scratchQ)));
      }
    }
    const qx = qPos(p.x);
    const qy = qPos(p.y);
    const qz = qPos(p.z);
    const qyaw = qAng(yaw);
    const player = e instanceof Player ? e : null;
    const qpitch = player !== null ? qPitch(player.pitch) : 0;
    const qflags = player !== null ? playerFlagBits(player) : -1;
    info.column = chunkKey(chunkOf(e.pos.x), chunkOf(e.pos.z));
    if (carrierId === info.carrierId && qx === info.qx && qy === info.qy && qz === info.qz && qyaw === info.qyaw && qpitch === info.qpitch && qflags === info.qflags) {
      return false;
    }
    info.carrierId = carrierId;
    info.qx = qx;
    info.qy = qy;
    info.qz = qz;
    info.qyaw = qyaw;
    info.qpitch = qpitch;
    info.qflags = qflags;
    return true;
  }

  /** Did the stack change, or the fuse leave the countdown the clients run, since the last tick? */
  private fieldsChanged(info: EntityInfo, fresh: boolean, tick: number): boolean {
    const e = info.e;
    if (e instanceof ItemEntity) {
      const changed = !fresh && (e.stack.item !== info.item || e.stack.count !== info.count);
      info.item = e.stack.item;
      info.count = e.stack.count;
      return changed;
    }
    if (e instanceof TntEntity) {
      const fuse = Math.max(0, e.fuse);
      const changed = !fresh && fuse !== Math.max(0, info.fuse - (tick - info.fuseTick));
      info.fuse = fuse;
      info.fuseTick = tick;
      return changed;
    }
    return false;
  }

  /** An entity's motion in its wire frames (as quantise() measures it), built once per tick. */
  private motionOf(info: EntityInfo, tick: number): EntityMotion {
    if (info.motion !== null && info.motionTick === tick) return info.motion;
    const e = info.e;
    let pos: Vec3 = v3(e.pos);
    let yaw = e.yaw;
    if (info.carrierId !== 0) {
      const carrier = this.sim.structures.get(info.carrierId)!;
      pos = carrier.grid.toLocal(e.pos);
      yaw = wrapAngle(e.yaw - headingOf(carrier.grid.worldRotation()));
    }
    const look = e instanceof Player ? { pitch: e.pitch, flags: playerFlags(e) } : null;
    const m: EntityMotion = { kind: e.kind, carrierId: info.carrierId, pos, yaw, look };
    info.motion = m;
    info.motionTick = tick;
    return m;
  }

  // ------------------------------------------------------------------ one client

  private sendTo(c: Client, ctrl: PlayerControl, f: Frame): void {
    const tick = f.tick;
    const sink = c.sink;
    // Back-pressure (section 2): measured before anything of this tick is handed over.
    const backlogR = this.measure(c, RELIABLE);
    const backlogU = this.measure(c, UNRELIABLE);
    c.slowTicks = backlogR > MAX_BACKLOG ? c.slowTicks + 1 : 0;
    // Deferred new interest fills the reliable backlog up to the line, never past one item more.
    // The host's own connection has no link to protect (a port in one machine that reports no
    // backlog): its line is the whole budget.
    const line = c.host ? SNAPSHOT_BUDGET : Math.max(RELIABLE_BACKLOG_FLOOR, BACKLOG_WINDOW_S * c.rate[RELIABLE]);
    const deferBudget = Math.min(SNAPSHOT_BUDGET, line - backlogR);
    const mayDefer = deferBudget > 0;

    const b = emptyTickBatch(tick);
    const snapshotPieces: EncodedPiece[] = [];
    let cellBudget = this.limits.cells;
    const player = ctrl.player;
    const pcx = chunkOf(player.pos.x);
    const pcz = chunkOf(player.pos.z);
    const r = c.viewRadius;

    // ---- 0. unsubscribe (and the new subscription circle)
    if (pcx !== c.centerCx || pcz !== c.centerCz || r !== c.recomputeRadius) b.unsubscribe = this.recomputeColumns(c, pcx, pcz, r);

    // ---- 1, 2. deltas of the columns the client has, or their resent snapshot
    for (const key of f.chunkResend) {
      if (!c.columns.has(key)) continue;
      const piece = this.snapshotPiece(key, tick);
      if (piece.cells <= cellBudget) {
        cellBudget -= piece.cells;
        snapshotPieces.push(piece);
      } else {
        // No room for its cells in this batch: the delta says the same.
        b.chunkDeltas.push(this.fullDelta(key, f));
      }
    }
    for (const [key, d] of f.chunkDeltas) if (c.columns.has(key)) b.chunkDeltas.push(d);

    // ---- 3 to 6. structures
    const spawnList: Structure[] = [];
    this.updateStructureInterest(c, pcx, pcz, r);
    b.structureRemoves = this.structureRemovals(c);
    const deferredGroups: Array<{ gap: number; group: Structure[] }> = [];
    for (const rootId of c.interestRoots) {
      const root = this.sim.structures.get(rootId)!;
      const group: Structure[] = [root, ...root.children];
      const knownRoot = this.knows(c, root);
      if (!knownRoot) {
        const must = group.some((s) => f.appearedStructures.has(s) || c.structures.has(s.id));
        if (must) spawnList.push(...group);
        else deferredGroups.push({ gap: sphereGap(this.spheres.get(rootId)!, pcx, pcz), group });
        continue;
      }
      for (const s of group) {
        const sent = c.structures.get(s.id);
        if (sent === undefined || sent.s !== s || f.structureResend.has(s.id) || frameChanged(sent, s)) spawnList.push(s);
      }
    }
    for (const s of spawnList) cellBudget -= this.recordPiece(s, f).cells;
    if (cellBudget < 0) {
      this.overflow(c);
      return;
    }
    const spawning = new Set(spawnList);
    for (const [id, sent] of c.structures) {
      if (spawning.has(sent.s)) continue;
      const d = this.structureDelta(sent, f);
      if (d !== null) b.structureDeltas.push(d);
      const rest = f.shipRests.get(id);
      if (rest !== undefined) b.structureRests.push({ id, pose: rest });
    }
    for (const s of spawnList) this.markSpawned(c, s, tick);

    // ---- 7 to 9. entities. Interest changes only with the entity (it moved, changed carrier,
    // went) or with what the client has: after it lost columns or structures, every known entity
    // is checked; otherwise only the ones that changed in this tick.
    const own = ctrl.entityId;
    if (b.unsubscribe.length > 0 || b.structureRemoves.length > 0) {
      for (const id of c.entities.keys()) this.despawnIfOut(c, id, f, own, b);
    } else {
      for (const id of f.goneEntities) this.despawnIfOut(c, id, f, own, b);
      for (const info of f.changedEntities) this.despawnIfOut(c, info.e.id, f, own, b);
    }
    for (const info of f.changedEntities) {
      const sent = c.entities.get(info.e.id);
      if (sent === undefined || sent.e !== info.e) continue;
      const u = this.entityUpdate(sent, info, tick);
      if (u !== null) b.entityUpdates.push(u);
    }
    for (const info of f.appearedEntities) {
      if (c.entities.has(info.e.id) || !this.entityInInterest(c, info, own)) continue;
      b.entitySpawns.push(this.spawnEntity(c, info, tick));
    }
    // No scan for the must-send spawns above: a structure that appeared in this tick carries only
    // entities whose carrier changed in this tick (changed entities, looked at below), and a
    // resent one only entities the client already has. Deferred groups set entityScan below.

    // ---- 10 to 12. private, events, globals
    b.private = this.privateFor(c, ctrl, f);
    b.events = this.eventsFor(c, f);
    const globals = this.globalsFor(c, tick);

    // ---- deferred new interest, in budget (section 13 step 2)
    if (!mayDefer) c.entityScan = true;
    else {
      let budget = deferBudget;
      // An item longer than what is left of the budget waits; on an almost empty link the first
      // item of the tick goes whatever its size, so a big structure or snapshot is never starved.
      // The host's own connection (nothing queues behind its items) sends while budget is left.
      let first = backlogR < RELIABLE_BACKLOG_FLOOR / 2;
      const goes = (bytes: number): boolean => (c.host ? budget > 0 : bytes <= budget || first);
      deferredGroups.sort((p, q) => p.gap - q.gap);
      for (const { group } of deferredGroups) {
        let cells = 0;
        let bytes = 0;
        for (const s of group) {
          const piece = this.recordPiece(s, f);
          cells += piece.cells;
          bytes += piece.bytes.length;
        }
        if (cells > cellBudget || !goes(bytes)) break;
        first = false;
        cellBudget -= cells;
        budget -= bytes;
        for (const s of group) {
          spawnList.push(s);
          this.markSpawned(c, s, tick);
        }
        c.entityScan = true;
      }
      const before = budget;
      budget = this.deferredEntities(c, f, own, b, budget, tick);
      if (budget !== before) first = false;
      let taken = 0;
      while (taken < c.pending.length) {
        const key = c.pending[taken]!;
        const piece = this.snapshotPiece(key, tick);
        if (piece.cells > cellBudget || !goes(piece.bytes.length)) break;
        first = false;
        cellBudget -= piece.cells;
        budget -= piece.bytes.length;
        snapshotPieces.push(piece);
        c.columns.add(key);
        taken++;
      }
      c.pending.splice(0, taken);
      // Free entities over the columns just sent may come along in the budget that is left.
      if (taken > 0) {
        c.entityScan = true;
        this.deferredEntities(c, f, own, b, budget, tick);
      }
    }

    // ---- ready (section 3)
    if (!c.ready && this.readyNow(c, f, pcx, pcz, r, own)) {
      c.ready = true;
      c.joinRoots = null;
      globals.ready = true;
    }
    if (Object.keys(globals).length > 0) b.globals = globals;

    // ---- encode and send
    spawnList.sort((p, q) => depthOf(p) - depthOf(q));
    const bytes = encodeTickBatch(b, { snapshots: snapshotPieces, structureSpawns: spawnList.map((s) => this.recordPiece(s, f)) }, c.stats.sectionBytes);
    if (bytes.length > this.limits.bytes) {
      this.overflow(c);
      return;
    }
    sink.send(RELIABLE, bytes);
    c.sentLast[RELIABLE] = bytes.length;
    const st = c.stats;
    st.batches++;
    st.reliableBytes += bytes.length;
    st.lastBatch = bytes.length;
    if (bytes.length > st.largestBatch) st.largestBatch = bytes.length;

    // ---- samples (section 13 step 3)
    c.sentLast[UNRELIABLE] = 0;
    if (c.host) {
      this.sendSamples(c, f, player.pos, Infinity);
      return;
    }
    const perTickU = c.rate[UNRELIABLE] * TICK_DT;
    if (backlogU > Math.max(SAMPLE_FLOOR_BYTES, perTickU) || backlogR > line) return;
    this.sendSamples(c, f, player.pos, Math.max(SAMPLE_FLOOR_BYTES, 2 * perTickU));
  }

  /** The client's must-send content does not fit a batch: it gets nothing more and the host kicks it (tooSlow()). */
  private overflow(c: Client): void {
    c.overflowed = true;
  }

  /**
   * Backlog of a channel now, and the smoothed send rate it implies (section 2). A channel that
   * emptied carried all it was given, which is less than it can carry: the rate is then at least
   * this tick's, so it follows a link that has more room at once (the line doubles every tick
   * while each tick's bytes go through, like a slow start).
   */
  private measure(c: Client, ch: Channel): number {
    const now = c.sink.bufferedBytes(ch);
    const drained = Math.max(0, c.backlog[ch] + c.sentLast[ch] - now) / TICK_DT;
    c.rate[ch] += RATE_SMOOTHING * (drained - c.rate[ch]);
    if (now === 0 && drained > c.rate[ch]) c.rate[ch] = drained;
    c.backlog[ch] = now;
    return now;
  }

  // ------------------------------------------------------------------ columns

  /**
   * The subscription circle about (cx, cz), recomputed whenever the player's column or the
   * radius changes (section 6 says every 4 ticks; see the file comment): returns the columns let
   * go (outside r + 2); rebuilds the waiting list (inside r, not sent yet), nearest first.
   */
  private recomputeColumns(c: Client, cx: number, cz: number, r: number): ChunkPos[] {
    c.centerCx = cx;
    c.centerCz = cz;
    c.recomputeRadius = r;
    const out: ChunkPos[] = [];
    for (const key of c.columns) {
      const kx = chunkKeyX(key);
      const kz = chunkKeyZ(key);
      if (inChunkCircle(kx - cx, kz - cz, r + 2)) continue;
      c.columns.delete(key);
      out.push({ cx: kx, cz: kz });
    }
    c.pending = [];
    let offsets = this.circles.get(r);
    if (offsets === undefined) {
      offsets = circleOffsets(r);
      this.circles.set(r, offsets);
    }
    for (let i = 0; i < offsets.length; i += 2) {
      const key = chunkKey(cx + offsets[i]!, cz + offsets[i + 1]!);
      if (!c.columns.has(key)) c.pending.push(key);
    }
    return out;
  }

  /** The column's snapshot as the server knows it now (section 6), encoded once per content version. */
  private snapshotPiece(key: number, tick: number): EncodedPiece {
    const cx = chunkKeyX(key);
    const cz = chunkKeyZ(key);
    const version = this.capture.columnVersion(cx, cz);
    const cached = this.snapshots.get(key);
    if (cached !== undefined && cached.version === version) {
      cached.used = tick;
      return cached.piece;
    }
    const piece = encodeSnapshotPiece(this.columnSnapshot(cx, cz));
    this.snapshots.set(key, { version, piece, used: tick });
    return piece;
  }

  /**
   * What the server knows of a column: loaded and modified -> its cells; not loaded but stashed
   * -> the stashed cells (pristine when they cannot be decoded: the column then regenerates);
   * otherwise pristine. Plus the world glue faces whose canonical end lies in the column.
   */
  private columnSnapshot(cx: number, cz: number): ChunkSnapshot {
    const sim = this.sim;
    const chunk = sim.world.getChunk(cx, cz);
    let cells: ChunkSnapshot['cells'] = 'pristine';
    if (chunk !== undefined) {
      // The layers by reference: the snapshot is encoded right away (snapshotPiece), before any
      // further write to the chunk.
      if (chunk.modified) cells = chunk.layers();
    } else {
      cells = sim.chunks.stashedCells(cx, cz) ?? 'pristine';
    }
    return { cx, cz, cells, glue: this.columnGlue(cx, cz) };
  }

  private columnGlue(cx: number, cz: number): number[] {
    const glue: number[] = [];
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    this.sim.worldGlue.forEachInBox(x0, 0, z0, x0 + CHUNK_SIZE - 1, WORLD_HEIGHT - 1, z0 + CHUNK_SIZE - 1, (x, y, z, axis) => {
      if (x < x0 || x >= x0 + CHUNK_SIZE || z < z0 || z >= z0 + CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return;
      glue.push((x - x0) | ((z - z0) << 4) | (y << 8) | (axis << 15));
    });
    return glue;
  }

  /** A resent column as a delta of every changed cell (when its cells do not fit the batch). */
  private fullDelta(key: number, f: Frame): ChunkDelta {
    const col = f.take.columns.get(key)!;
    return { cx: col.cx, cz: col.cz, cells: [...col.cells].sort((a, b) => a[0] - b[0]), glue: [...col.glue] };
  }

  // ------------------------------------------------------------------ structures

  private knows(c: Client, s: Structure): boolean {
    return c.structures.get(s.id)?.s === s;
  }

  /** Recompute which roots are in the client's interest (hysteresis; a root counts as in when the client knows one of its rotors). */
  private updateStructureInterest(c: Client, cx: number, cz: number, r: number): void {
    const next = new Set<number>();
    for (const sphere of this.spheres.all()) {
      const root = sphere.root;
      const wasIn = c.interestRoots.has(root.id) || this.knows(c, root) || root.children.some((ch) => this.knows(c, ch));
      if (structureInterest(sphere, cx, cz, r, wasIn)) next.add(root.id);
    }
    c.interestRoots.clear();
    for (const id of next) c.interestRoots.add(id);
  }

  /** Structures the client knows that are gone or out of its interest; children before parents. */
  private structureRemovals(c: Client): number[] {
    const out: Array<{ id: number; depth: number }> = [];
    for (const [id, sent] of c.structures) {
      const s = sent.s;
      const live = this.sim.structures.get(id) === s;
      if (live && c.interestRoots.has(rootOf(s).id)) continue;
      out.push({ id, depth: sent.parentId === 0 ? 0 : 1 });
    }
    out.sort((a, b) => b.depth - a.depth);
    for (const o of out) c.structures.delete(o.id);
    return out.map((o) => o.id);
  }

  private recordPiece(s: Structure, f: Frame): EncodedPiece {
    let p = f.records.get(s.id);
    if (p === undefined) {
      p = encodeStructureRecordPiece(structureRecord(s));
      f.records.set(s.id, p);
    }
    return p;
  }

  private markSpawned(c: Client, s: Structure, tick: number): void {
    const g = s.grid;
    const rotor = s instanceof Rotor ? s : null;
    const ship = s instanceof Ship ? s : null;
    c.structures.set(s.id, {
      s,
      since: tick,
      parentId: s.parent?.id ?? 0,
      bearingX: rotor?.bearingX ?? 0,
      bearingY: rotor?.bearingY ?? 0,
      bearingZ: rotor?.bearingZ ?? 0,
      baseRotation: q4(rotor?.baseRotation ?? { x: 0, y: 0, z: 0, w: 1 }),
      rotorPosition: v3(g.position),
      pivot: v3(g.pivot),
      helmX: ship?.helmX ?? 0,
      helmY: ship?.helmY ?? 0,
      helmZ: ship?.helmZ ?? 0,
      forward: ship?.forward ?? 5,
      helmsmanId: ship?.helmsmanId ?? 0,
      throttle: Math.fround(ship?.throttle ?? 0),
      rudder: Math.fround(ship?.rudder ?? 0),
      sails: rotor?.sails ?? 0,
      frozen: s.frozen,
      rotorTick: tick,
      sampled: tick,
    });
  }

  /** The changes of a structure the client has (known before this batch, not resent). */
  private structureDelta(sent: SentStructure, f: Frame): StructureDelta | null {
    const s = sent.s;
    const d: StructureDelta = { id: s.id };
    let any = false;
    const ch = f.structureDeltas.get(s.id);
    if (ch !== undefined) {
      if (ch.cells !== undefined) d.cells = ch.cells;
      if (ch.glue !== undefined) d.glue = ch.glue;
      any = ch.cells !== undefined || ch.glue !== undefined;
    }
    const p = s.grid.pivot;
    if (p.x !== sent.pivot.x || p.y !== sent.pivot.y || p.z !== sent.pivot.z) {
      d.pivot = v3(p);
      sent.pivot.x = p.x;
      sent.pivot.y = p.y;
      sent.pivot.z = p.z;
      any = true;
    }
    if (s instanceof Ship) {
      if (s.helmX !== sent.helmX || s.helmY !== sent.helmY || s.helmZ !== sent.helmZ || s.forward !== sent.forward || s.helmsmanId !== sent.helmsmanId) {
        d.helm = { x: s.helmX, y: s.helmY, z: s.helmZ, forward: s.forward, helmsmanId: s.helmsmanId };
        sent.helmX = s.helmX;
        sent.helmY = s.helmY;
        sent.helmZ = s.helmZ;
        sent.forward = s.forward;
        sent.helmsmanId = s.helmsmanId;
        any = true;
      }
      const t = Math.fround(s.throttle);
      const ru = Math.fround(s.rudder);
      if (t !== sent.throttle || ru !== sent.rudder) {
        d.control = { throttle: s.throttle, rudder: s.rudder };
        sent.throttle = t;
        sent.rudder = ru;
        any = true;
      }
    } else if (s instanceof Rotor) {
      if (s.sails !== sent.sails || s.frozen !== sent.frozen || f.tick - sent.rotorTick >= ROTOR_RESYNC_TICKS) {
        d.rotor = { angle: s.angle, angularSpeed: s.angularSpeed, sails: s.sails, frozen: s.frozen };
        sent.sails = s.sails;
        sent.frozen = s.frozen;
        sent.rotorTick = f.tick;
        any = true;
      }
    }
    return any ? d : null;
  }

  // ------------------------------------------------------------------ entities

  /** Section 8: a carried entity with its carrier's spawn, a free one with the snapshot of the column under it. Never the client's own. */
  private entityInInterest(c: Client, info: EntityInfo, own: number): boolean {
    if (info.e.id === own) return false;
    const carrier = info.carrierId;
    if (carrier !== 0) {
      const s = this.sim.structures.get(carrier);
      return s !== undefined && this.knows(c, s);
    }
    return c.columns.has(info.column);
  }

  /** Despawn a known entity that went, was replaced, or left the client's interest. */
  private despawnIfOut(c: Client, id: number, f: Frame, own: number, b: TickBatchMsg): void {
    const sent = c.entities.get(id);
    if (sent === undefined) return;
    const info = f.entities.get(id);
    if (info !== undefined && info.e === sent.e && this.entityInInterest(c, info, own)) return;
    b.entityDespawns.push(id);
    c.entities.delete(id);
  }

  private spawnEntity(c: Client, info: EntityInfo, tick: number): EntityRecord {
    const e = info.e;
    const m = this.motionOf(info, tick);
    const sent: SentEntity = { e, since: tick, item: 0, count: 0, fuse: 0, fuseTick: tick, flags: 0, steering: 0, held: null, sampled: tick };
    c.entities.set(e.id, sent);
    const base = { id: e.id, carrierId: m.carrierId, pos: m.pos, yaw: m.yaw };
    if (e instanceof Player) {
      const held = playerHeld(e);
      sent.flags = flagBits(held.flags);
      sent.steering = held.steeringShipId;
      sent.held = held.heldItem;
      return { ...base, kind: 'player', pitch: e.pitch, ...held };
    }
    if (e instanceof ItemEntity) {
      sent.item = e.stack.item;
      sent.count = e.stack.count;
      return { ...base, kind: 'item', item: e.stack.item, count: e.stack.count };
    }
    if (e instanceof FallingBlockEntity) return { ...base, kind: 'falling', cell: e.cell };
    if (e instanceof TntEntity) {
      sent.fuse = Math.max(0, e.fuse);
      return { ...base, kind: 'tnt', fuse: sent.fuse };
    }
    return { ...base, kind: 'rabbit' };
  }

  private entityUpdate(sent: SentEntity, info: EntityInfo, tick: number): EntityUpdate | null {
    if (sent.since === tick) return null;
    const e = info.e;
    const u: EntityUpdate = { id: e.id };
    let any = false;
    if (info.stopped) {
      u.final = this.motionOf(info, tick);
      any = true;
    }
    if (e instanceof ItemEntity && (e.stack.item !== sent.item || e.stack.count !== sent.count)) {
      u.stack = { item: e.stack.item, count: e.stack.count };
      sent.item = e.stack.item;
      sent.count = e.stack.count;
      any = true;
    } else if (e instanceof TntEntity) {
      const fuse = Math.max(0, e.fuse);
      if (fuse !== Math.max(0, sent.fuse - (tick - sent.fuseTick))) {
        u.fuse = fuse;
        sent.fuse = fuse;
        sent.fuseTick = tick;
        any = true;
      }
    } else if (e instanceof Player) {
      const held = playerHeld(e);
      const flags = flagBits(held.flags);
      if (flags !== sent.flags || held.steeringShipId !== sent.steering || held.heldItem !== sent.held) {
        u.player = held;
        sent.flags = flags;
        sent.steering = held.steeringShipId;
        sent.held = held.heldItem;
        any = true;
      }
    }
    return any ? u : null;
  }

  /**
   * Spawn entities in interest that the client lacks, nearest first, within the budget; returns
   * the budget left. The candidates are every entity when c.entityScan is set, else the ones
   * that changed in this tick (an entity that did not change enters the interest only when the
   * client gains columns or structures, which sets entityScan).
   */
  private deferredEntities(c: Client, f: Frame, own: number, b: TickBatchMsg, budget: number, tick: number): number {
    const all = c.entityScan;
    if (budget <= 0) {
      c.entityScan = true;
      return budget;
    }
    const ctrl = this.sim.players.get(c.key)!;
    const at = ctrl.player.pos;
    const list: Array<{ info: EntityInfo; d: number }> = [];
    for (const info of all ? f.entities.values() : f.changedEntities) {
      if (c.entities.has(info.e.id) || !this.entityInInterest(c, info, own)) continue;
      const p = info.e.pos;
      list.push({ info, d: (p.x - at.x) ** 2 + (p.z - at.z) ** 2 });
    }
    list.sort((p, q) => p.d - q.d || p.info.e.id - q.info.e.id);
    let sent = 0;
    for (const { info } of list) {
      if (budget <= 0) break;
      b.entitySpawns.push(this.spawnEntity(c, info, tick));
      budget -= ENTITY_RECORD_COST;
      sent++;
    }
    // Candidates left over wait for the next deferral, which looks at every entity again.
    if (sent < list.length) c.entityScan = true;
    else if (all) c.entityScan = false;
    return budget;
  }

  // ------------------------------------------------------------------ private, events, globals

  private privateFor(c: Client, ctrl: PlayerControl, f: Frame): PrivateState | null {
    const p = ctrl.player;
    const out: PrivateState = {};
    let any = false;
    const corr = ctrl.takeCorrection();
    if (corr !== null) {
      const net: NetCorrection = {
        epoch: corr.epoch,
        cause: corr.cause,
        carrierId: corr.carrierId,
        pos: v3(corr.pos),
        vel: v3(corr.vel),
        yaw: corr.yaw,
        pitch: corr.pitch,
        flying: corr.flying,
        onGround: corr.onGround,
        seatShipId: corr.seatShipId,
        seat: corr.seatShipId !== 0 ? v3(corr.seat) : null,
      };
      out.correction = net;
      any = true;
    }
    const inv = netInventory(p);
    const invKey = JSON.stringify(inv);
    if (invKey !== c.inventory) {
      c.inventory = invKey;
      out.inventory = inv;
      any = true;
    }
    const vitals: NetVitals = { health: p.health, maxHealth: p.maxHealth, air: Math.max(0, Math.round(p.air)), maxAir: Math.max(0, Math.round(p.maxAir)), dead: p.dead, mode: p.mode };
    const vitalsKey = `${Math.fround(vitals.health)},${Math.fround(vitals.maxHealth)},${vitals.air},${vitals.maxAir},${vitals.dead},${vitals.mode}`;
    if (vitalsKey !== c.vitals) {
      c.vitals = vitalsKey;
      out.vitals = vitals;
      any = true;
    }
    const view = this.viewUpdate(c, ctrl.view);
    if (view !== null) {
      out.view = view;
      any = true;
    }
    const events: PrivateEvent[] = [];
    for (const ev of f.events) {
      if (!('player' in ev) || ev.player !== c.key) continue;
      const pe = privateEvent(ev);
      if (pe !== null) events.push(pe);
    }
    if (events.length > 0) {
      out.events = events;
      any = true;
    }
    if (c.feed !== null) {
      const ack = c.feed.intentAck();
      if (ack !== null && ack !== c.ack) {
        c.ack = ack;
        out.ack = ack;
        any = true;
      }
      const moveAck = c.feed.moveAck();
      if (moveAck !== null && moveAck !== c.moveAck) {
        c.moveAck = moveAck;
        out.moveAck = moveAck;
        any = true;
      }
    }
    return any ? out : null;
  }

  /** The server-only parts of the interaction view (section 9), each only when it changed. */
  private viewUpdate(c: Client, v: InteractionView): ViewUpdate | null {
    const sent = c.view;
    const out: ViewUpdate = {};
    let any = false;
    const m = v.mining;
    const miningKey = m === null ? '' : `${m.gridId},${m.x},${m.y},${m.z},${m.sub},${Math.round(m.progress * 255)}`;
    if (miningKey !== sent.mining) {
      sent.mining = miningKey;
      out.mining = m === null ? null : { gridId: m.gridId, x: m.x, y: m.y, z: m.z, sub: m.sub, progress: m.progress };
      any = true;
    }
    const g = v.gluing;
    const gluingKey = g === null ? '' : `${g.gridId},${g.x},${g.y},${g.z},${g.face},${g.sub},${Math.round(g.progress * 255)}`;
    if (gluingKey !== sent.gluing) {
      sent.gluing = gluingKey;
      out.gluing = g === null ? null : { gridId: g.gridId, x: g.x, y: g.y, z: g.z, face: g.face, sub: g.sub, progress: g.progress };
      any = true;
    }
    const cells = v.preview?.cells ?? null;
    if (cells !== sent.previewCells) {
      sent.previewCells = cells;
      out.preview = v.preview === null ? null : { gridId: v.preview.gridId, kind: v.preview.kind, cells: v.preview.cells };
      any = true;
    }
    const conflictsKey = v.conflicts.map((p) => `${p.x},${p.y},${p.z}`).join(';');
    if (conflictsKey !== sent.conflicts) {
      sent.conflicts = conflictsKey;
      out.conflicts = v.conflicts.map((p) => ({ x: p.x, y: p.y, z: p.z }));
      any = true;
    }
    const hintKey = messageKey(v.hint);
    if (hintKey !== sent.hint) {
      sent.hint = hintKey;
      out.hint = v.hint;
      any = true;
    }
    return any ? out : null;
  }

  /** World events the client can see (section 11): in a column it had before this batch, or on a structure it had. */
  private eventsFor(c: Client, f: Frame): WorldEvent[] {
    const out: WorldEvent[] = [];
    for (const ev of f.events) {
      switch (ev.type) {
        case 'blockBroken':
        case 'blockPlaced': {
          const seen =
            ev.gridId === 0 ? c.columns.has(chunkKey(chunkOf(ev.x), chunkOf(ev.z))) : (c.structures.get(ev.gridId)?.since ?? f.tick) < f.tick;
          if (seen) out.push({ type: ev.type, gridId: ev.gridId, x: ev.x, y: ev.y, z: ev.z, cell: ev.cell });
          break;
        }
        case 'explosion':
          if (c.columns.has(chunkKey(chunkOf(ev.x), chunkOf(ev.z)))) out.push({ type: 'explosion', x: ev.x, y: ev.y, z: ev.z, power: ev.power });
          break;
        case 'sound':
          if (c.columns.has(chunkKey(chunkOf(ev.x), chunkOf(ev.z)))) out.push({ type: 'sound', name: ev.name, x: ev.x, y: ev.y, z: ev.z });
          break;
        default:
          break;
      }
    }
    return out;
  }

  private globalsFor(c: Client, tick: number): Globals {
    const g: Globals = {};
    const sim = this.sim;
    if (sim.dayOffset !== c.dayOffset) {
      c.dayOffset = sim.dayOffset;
      g.dayOffset = sim.dayOffset;
    }
    const rk = rulesKey(sim.rules);
    if (rk !== c.rules) {
      c.rules = rk;
      g.rules = { defaultMode: sim.rules.defaultMode, dropsEnabled: sim.rules.dropsEnabled };
    }
    const table = this.table;
    const ops: PlayerListChange[] = [];
    const now = new Set<number>();
    for (const p of table) {
      now.add(p.entityId);
      const was = c.players.get(p.entityId);
      if (was !== undefined && was.name === p.name && was.host === p.host) {
        if (was.mode !== p.mode) {
          ops.push({ op: 'mode', entityId: p.entityId, mode: p.mode });
          c.players.set(p.entityId, p);
        }
        continue;
      }
      if (was !== undefined) ops.push({ op: 'leave', entityId: p.entityId });
      ops.push({ op: 'join', ...p });
      c.players.set(p.entityId, p);
    }
    for (const id of [...c.players.keys()]) {
      if (now.has(id)) continue;
      ops.push({ op: 'leave', entityId: id });
      c.players.delete(id);
    }
    if (ops.length > 0) g.players = ops;
    if (this.tpsValue !== null && this.tpsValue !== c.tps) {
      c.tps = this.tpsValue;
      g.tps = this.tpsValue;
    }
    if (this.roomOpenValue !== c.roomOpen) {
      c.roomOpen = this.roomOpenValue;
      g.roomOpen = this.roomOpenValue;
    }
    return g;
  }

  /**
   * Section 3: the snapshots of the ready zone (the 7 x 7 columns about the player's, inside the
   * subscription circle), the entities in interest there (and those riding structures it has),
   * and every structure that was in interest at the first batch have been sent.
   */
  private readyNow(c: Client, f: Frame, cx: number, cz: number, r: number, own: number): boolean {
    if (c.joinRoots === null) c.joinRoots = new Set(c.interestRoots);
    for (let dz = -READY_CHUNK_RADIUS; dz <= READY_CHUNK_RADIUS; dz++) {
      for (let dx = -READY_CHUNK_RADIUS; dx <= READY_CHUNK_RADIUS; dx++) {
        if (inChunkCircle(dx, dz, r) && !c.columns.has(chunkKey(cx + dx, cz + dz))) return false;
      }
    }
    for (const id of c.joinRoots) {
      const root = this.sim.structures.get(id);
      if (root === undefined || !c.interestRoots.has(id)) continue;
      if (!this.knows(c, root) || root.children.some((ch) => !this.knows(c, ch))) return false;
    }
    for (const info of f.entities.values()) {
      if (c.entities.has(info.e.id) || !this.entityInInterest(c, info, own)) continue;
      if (info.carrierId !== 0) return false;
      const ex = chunkKeyX(info.column) - cx;
      const ez = chunkKeyZ(info.column) - cz;
      if (Math.abs(ex) <= READY_CHUNK_RADIUS && Math.abs(ez) <= READY_CHUNK_RADIUS) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ samples

  /**
   * Samples of the ships and entities the client has whose pose changed in this tick, at most
   * `room` bytes (and SAMPLE_MESSAGES_PER_TICK messages). When they do not all fit, the ones whose
   * samples are stalest go first, staleness weighted by nearness: ticks since the last sample x
   * SAMPLE_NEAR / (SAMPLE_NEAR + horizontal distance). Every moving thing gets its turn, a far
   * one less often than a near one: at 150 blocks about every sixth tick when the near ones fill
   * every tick (package 13). One left out that does not move again has stopped: its final pose
   * goes reliably (rest, final state), so it needs no sample.
   */
  private sendSamples(c: Client, f: Frame, at: Vec3, room: number): void {
    const tick = f.tick;
    const cand: Array<{ w: number; size: number; ship: ShipSample | null; entity: EntitySample | null; sent: SentStructure | SentEntity }> = [];
    let total = 0;
    for (const [id, sample] of f.shipSamples) {
      const sent = c.structures.get(id);
      const s = sent?.s;
      if (sent === undefined || !(s instanceof Ship) || this.sim.structures.get(id) !== s) continue;
      const p = s.grid.position;
      cand.push({ w: weight(tick - sent.sampled, p, at), size: SHIP_SAMPLE_MAX_BYTES, ship: sample, entity: null, sent });
      total += SHIP_SAMPLE_MAX_BYTES;
    }
    for (const info of f.movedEntities) {
      const sent = c.entities.get(info.e.id);
      if (sent === undefined || sent.e !== info.e) continue;
      cand.push({ w: weight(tick - sent.sampled, info.e.pos, at), size: ENTITY_SAMPLE_MAX_BYTES, ship: null, entity: { id: info.e.id, ...this.motionOf(info, tick) }, sent });
      total += ENTITY_SAMPLE_MAX_BYTES;
    }
    if (cand.length === 0) return;
    const limit = Math.min(room, SAMPLE_MESSAGES_PER_TICK * (MAX_UNRELIABLE_BYTES - SAMPLES_HEADER_MAX_BYTES - ENTITY_SAMPLE_MAX_BYTES));
    if (total > limit) cand.sort((p, q) => q.w - p.w);
    const ships: ShipSample[] = [];
    const ents: EntitySample[] = [];
    let used = 0;
    for (const x of cand) {
      if (used + x.size > limit) continue;
      used += x.size;
      x.sent.sampled = tick;
      if (x.ship !== null) ships.push(x.ship);
      else ents.push(x.entity!);
    }
    if (ships.length === 0 && ents.length === 0) return;
    const msgs = packSamples(tick, c.sampleSeq, ships, ents);
    let bytes = 0;
    for (const m of msgs) {
      c.sink.send(UNRELIABLE, m);
      bytes += m.length;
    }
    c.sampleSeq += msgs.length;
    c.sentLast[UNRELIABLE] = bytes;
    c.stats.sampleMessages += msgs.length;
    c.stats.sampleBytes += bytes;
  }
}

/** Sample priority (sendSamples): staleness in ticks weighted by nearness. */
function weight(stale: number, p: Vec3, at: Vec3): number {
  return (stale * SAMPLE_NEAR) / (SAMPLE_NEAR + Math.hypot(p.x - at.x, p.z - at.z));
}

// ====================================================================== records

function newEntityInfo(e: Entity): EntityInfo {
  return {
    e,
    carrierId: -1,
    qx: 0,
    qy: 0,
    qz: 0,
    qyaw: 0,
    qpitch: 0,
    qflags: -1,
    column: 0,
    rx: NaN,
    ry: NaN,
    rz: NaN,
    ryaw: NaN,
    moving: false,
    moved: false,
    stopped: false,
    item: 0,
    count: 0,
    fuse: 0,
    fuseTick: 0,
    fresh: true,
    fieldsChanged: false,
    motion: null,
    motionTick: -1,
  };
}

function clampRadius(r: number): number {
  return Number.isFinite(r) ? Math.max(0, Math.min(MAX_VIEW_RADIUS, Math.floor(r))) : 0;
}

/** Was the structure's frame re-gridded since its record was sent (section 7)? Then it is resent whole. */
function frameChanged(sent: SentStructure, s: Structure): boolean {
  if ((s.parent?.id ?? 0) !== sent.parentId) return true;
  if (!(s instanceof Rotor)) return false;
  const q = s.baseRotation;
  const b = sent.baseRotation;
  const p = s.grid.position;
  const rp = sent.rotorPosition;
  return (
    s.bearingX !== sent.bearingX ||
    s.bearingY !== sent.bearingY ||
    s.bearingZ !== sent.bearingZ ||
    q.x !== b.x ||
    q.y !== b.y ||
    q.z !== b.z ||
    q.w !== b.w ||
    p.x !== rp.x ||
    p.y !== rp.y ||
    p.z !== rp.z
  );
}

/** The full record of a structure at the end of the tick (section 7). */
function structureRecord(s: Structure): StructureRecord {
  const g = s.grid;
  const b = g.cellBounds();
  let minX = 0;
  let minY = 0;
  let minZ = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let cells: CellVolume = { base: new Uint16Array(0), holes: null, part2: null };
  if (b !== null) {
    minX = b.minX;
    minY = b.minY;
    minZ = b.minZ;
    sx = b.maxX - b.minX;
    sy = b.maxY - b.minY;
    sz = b.maxZ - b.minZ;
    cells = g.copyBox(minX, minY, minZ, sx, sy, sz);
  }
  const base = {
    id: s.id,
    parentId: s.parent?.id ?? 0,
    minX,
    minY,
    minZ,
    sx,
    sy,
    sz,
    cells,
    pivot: v3(g.pivot),
    position: v3(g.position),
    rotation: q4(g.rotation),
    glue: s.glue.toArray(),
  };
  if (s instanceof Rotor) {
    return {
      kind: 'rotor',
      ...base,
      bearing: { x: s.bearingX, y: s.bearingY, z: s.bearingZ },
      axis: s.axis,
      baseRotation: q4(s.baseRotation),
      angle: s.angle,
      angularSpeed: s.angularSpeed,
      sails: s.sails,
      frozen: s.frozen,
    };
  }
  const ship = s as Ship;
  return {
    kind: 'ship',
    ...base,
    helm: { x: ship.helmX, y: ship.helmY, z: ship.helmZ },
    forward: ship.forward,
    throttle: ship.throttle,
    rudder: ship.rudder,
    helmsmanId: ship.helmsmanId,
  };
}

function playerHeld(p: Player): PlayerHeld {
  const st = p.inventory.selectedStack();
  return { flags: playerFlags(p), steeringShipId: p.steeringShipId, heldItem: st !== null && st.count > 0 ? st.item : null };
}

function netInventory(p: Player): NetInventory {
  const inv = p.inventory;
  const copy = (s: { item: number; count: number } | null | undefined): { item: number; count: number } | null =>
    s !== null && s !== undefined && s.count > 0 ? { item: s.item, count: s.count } : null;
  const hotbar = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) hotbar.push(copy(inv.hotbar[i]));
  const main = [];
  for (let i = 0; i < MAIN_SLOTS; i++) main.push(copy(inv.main[i]));
  return { selected: inv.selected, hotbar, main, offhand: copy(inv.offhand), cursor: copy(inv.cursor) };
}

function privateEvent(ev: SimEvent): PrivateEvent | null {
  switch (ev.type) {
    case 'toast':
      return { type: 'toast', message: ev.message, kind: ev.kind };
    case 'playerHurt':
      return { type: 'playerHurt', amount: ev.amount, cause: ev.cause };
    case 'playerDied':
      return { type: 'playerDied', cause: ev.cause };
    case 'playerPickup':
      return { type: 'playerPickup', item: ev.item, count: ev.count };
    case 'helmReleased':
      return { type: 'helmReleased', cause: ev.cause };
    default:
      return null;
  }
}
