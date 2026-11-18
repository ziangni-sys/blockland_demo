/**
 * The multiplayer protocol as data (docs/NETCODE.md): its constants, the message ids and
 * channels, and a plain-data TypeScript type for every message, TickBatch section and record.
 * The byte layouts are in codec.ts (section 14).
 *
 * Every value in these types is plain data (numbers, strings, booleans, plain objects, arrays,
 * typed arrays): no classes, no references into a simulation or a replica. Fields carried in a
 * lossy fixed-point form on the wire (Pos32, Rot64, Ang16, i16 pitch, u8 progress, i8 stick
 * axes, f32) come back quantised from a decode; codec.ts says how.
 *
 * "Only sent when it changed" fields are optional (`?`): absent means unchanged. Lists of a
 * TickBatch are always present (empty = nothing in that section).
 *
 * Imports: core, blocks, save/bytes, and types from sim/view.ts and worldgen/generator.ts only
 * (NETCODE section 15).
 */
import { ROTOR_MAX_CELLS, SHIP_MAX_CELLS, STRUCTURE_MAX_BOX_CELLS } from '../core/constants';
import type { Axis, Dir } from '../core/dirs';
import type { Quat, Vec3 } from '../core/math';
import type { ItemStack } from '../blocks/items';
import type { MoveReport } from '../entities/drive';
import type { Message } from '../sim/view';
import type { GeneratorSpec } from '../worldgen/generator';
import { RELIABLE, UNRELIABLE, type Channel } from './transport';

// ====================================================================== build identity

/** Replaced at build time (vite.config.ts, vitest.config.ts). */
declare const __BUILD_ID__: string;

/**
 * Identity of this build, sent in Hello: two builds connect only when it is equal (there is no
 * separate protocol version, section 3). The commit for a deployed build (with '-dirty-<time>'
 * when built from uncommitted sources), 'dev-' plus the start time on the dev server, 'test'
 * under Vitest.
 */
export const BUILD_ID: string = __BUILD_ID__;

// ====================================================================== constants (spec)

/** Longest message on the reliable channel (section 2); transports fragment as needed. */
export const MAX_RELIABLE_BYTES = 4 * 1024 * 1024;
/** Longest message on the unreliable channel: one UDP packet, never fragmented (section 2). */
export const MAX_UNRELIABLE_BYTES = 1150;
/** Reliable backlog above which a client that stays there for 10 s is kicked as too slow (section 2). */
export const MAX_BACKLOG = 8 * 1024 * 1024;
/** Players on one server, the host included (section 3). */
export const MAX_PLAYERS = 4;
/** No message from a connection for this long counts as leaving (section 3). */
export const CONNECTION_TIMEOUT_MS = 75_000;
/** A client-driven helmsman without a movement report for this many ticks lets go (section 3). */
export const STEER_TIMEOUT_TICKS = 40;
/** At most this many ticks are run to catch up after a late wake-up (section 4). */
export const MAX_CATCHUP_TICKS = 5;
/** No TickBatch for this long while Pongs still arrive: the host is throttled (section 4). */
export const HOST_STALL_MS = 1500;
/** Half-size of the 7x7 columns that must be in the replica before a client is ready (section 3). */
export const READY_CHUNK_RADIUS = 3;
/** A subscribed column changed in more cells than this in one tick is resent whole (section 5). */
export const CHUNK_RESEND_CELLS = 1024;
/** A structure changed in more cells than this in one tick is resent whole (section 5). */
export const STRUCTURE_RESEND_CELLS = 1024;
/** Largest view (subscription) radius in chunks (section 6). */
export const MAX_VIEW_RADIUS = 17;
/** The server loads and simulates at most this many chunks around each player (section 6). */
export const SIM_RADIUS_CAP = 10;
/** Cell bit 24: a second part follows (M2.3; section 6). */
export const CELL_MULTI_BIT = 1 << 24;
/** A rotor's state is resent this often even when nothing changed (section 7). */
export const ROTOR_RESYNC_TICKS = 100;
/** Pose samples kept per ship / entity on the client (section 7). */
export const SAMPLE_BUFFER_TICKS = 32;
/** Movement reports remembered per player for the intents' eyes (section 8). */
export const MOVE_HISTORY = 40;
/** Reach slack added by the server's intent check, blocks (section 10). */
export const REACH_SLACK = 0.5;
/** Intents applied per player per tick (Aim not counted, section 10). */
export const INTENTS_PER_TICK = 16;
/** More queued intents than this disconnect the client (section 10). */
export const INTENT_QUEUE_LIMIT = 1024;
/** Autosave interval in simulated ticks (section 12). */
export const AUTOSAVE_TICKS = 600;
/** Bytes of deferred new interest (chunk snapshots ...) per client per tick at most (section 13). */
export const SNAPSHOT_BUDGET = 16 * 1024;
/** Longest PlayerKey accepted (section 13). */
export const MAX_PLAYER_KEY_LENGTH = 128;

// ====================================================================== constants (completed here)
// Limits section 13 states without a name, and limits the codec needs that the spec leaves open.

/** Longest client -> server message (section 13). */
export const MAX_CLIENT_MESSAGE_BYTES = 2048;
/** Longest Hello (section 13). */
export const MAX_HELLO_BYTES = 512;
/** Longest player name, in characters (sections 3, 13). */
export const MAX_NAME_LENGTH = 24;
/** Reliable-channel retransmission timer of the loopback when LinkConditions.rtoMs is not set (section 2). */
export const DEFAULT_RTO_MS = 400;
/**
 * Bound of every integer cell coordinate on the wire (|v| <= MAX_COORD), the same bound the
 * structure save uses: keeps all integer arithmetic downstream exact.
 */
export const MAX_COORD = 1 << 28;
/** A CellVolume with more distinct values than this is sent raw (section 14). */
export const PALETTE_LIMIT = 4096;
/**
 * Largest structure cell box (sx * sy * sz) a StructureRecord or an assembly preview may carry:
 * the game rule STRUCTURE_MAX_BOX_CELLS (2^21), so every structure the game can hold can be sent.
 * Both ends hold the box densely (a preview as a bitmap of at most 256 KiB, which fits a message);
 * the bound keeps a corrupted size from allocating gigabytes on the client.
 */
export const MAX_STRUCTURE_BOX_CELLS = STRUCTURE_MAX_BOX_CELLS;
/**
 * Most cells an assembly preview may show: the largest ship (or rotor; a preview is only made for
 * a structure the game would assemble, or for a rotor that lacks sails, both within their cell limit).
 */
export const MAX_PREVIEW_CELLS = Math.max(SHIP_MAX_CELLS, ROTOR_MAX_CELLS);
/**
 * Most cells all CellVolumes of one TickBatch may describe together (1024 chunk columns). RLE lets
 * a few bytes describe a whole column; this bounds what one message can make the decoder allocate.
 */
export const MAX_BATCH_CELLS = 1 << 25;
/** Inventory slots on the wire (section 14 PrivateState bit 1); equal to entities/inventory.ts. */
export const HOTBAR_SLOTS = 9;
export const MAIN_SLOTS = 27;

// ====================================================================== enumerations

export type Mode = 'creative' | 'survival';
/** Wire order of the game modes (index = wire value), the same as save/codec.ts. */
export const MODES: readonly Mode[] = Object.freeze(['creative', 'survival'] as const);

/** The same strings as entities/entity.ts EntityKind. */
export type EntityKind = 'player' | 'item' | 'falling' | 'tnt' | 'rabbit';
/** Wire tag = index + 1 (entities/manager.ts KIND_TAG). */
export const ENTITY_KINDS: readonly EntityKind[] = Object.freeze(['player', 'item', 'falling', 'tnt', 'rabbit'] as const);

export type StructureKind = 'ship' | 'rotor';
/** Wire value = index. */
export const STRUCTURE_KINDS: readonly StructureKind[] = Object.freeze(['ship', 'rotor'] as const);

export type InventoryArea = 'hotbar' | 'inventory' | 'offhand';
/** Wire value = index (same strings as entities/inventory.ts InventoryArea). */
export const INVENTORY_AREAS: readonly InventoryArea[] = Object.freeze(['hotbar', 'inventory', 'offhand'] as const);

export type ToastKind = 'info' | 'warn' | 'error';
/** Wire value = index. */
export const TOAST_KINDS: readonly ToastKind[] = Object.freeze(['info', 'warn', 'error'] as const);

export type RefuseReason = 'build' | 'bad_hello' | 'full' | 'closed' | 'shutting_down' | 'same_key';
/** Wire value = index + 1. The Refuse layout and reason 1 ('build') never change (section 3). */
export const REFUSE_REASONS: readonly RefuseReason[] = Object.freeze(['build', 'bad_hello', 'full', 'closed', 'shutting_down', 'same_key'] as const);

export type KickReason = 'replaced' | 'too_slow' | 'protocol_error' | 'shutdown' | 'kicked' | 'timeout';
/** Wire value = index + 1. */
export const KICK_REASONS: readonly KickReason[] = Object.freeze(['replaced', 'too_slow', 'protocol_error', 'shutdown', 'kicked', 'timeout'] as const);

// ====================================================================== message ids

/** Message id (first byte) of every message, by its `type`. Client -> server below 0x80. */
export const MSG = Object.freeze({
  hello: 0x01,
  bye: 0x02,
  ping: 0x03,
  moveReport: 0x10,
  aim: 0x20,
  use: 0x21,
  useRelease: 0x22,
  attack: 0x23,
  attackRelease: 0x24,
  swapHands: 0x25,
  selectSlot: 0x26,
  pickBlock: 0x27,
  invClick: 0x28,
  creativePick: 0x29,
  dropCursor: 0x2a,
  closeInventory: 0x2b,
  releaseHelm: 0x2c,
  respawn: 0x2d,
  setViewRadius: 0x2e,
  hostCommand: 0x30,
  welcome: 0x81,
  refuse: 0x82,
  kick: 0x83,
  pong: 0x84,
  tickBatch: 0x85,
  samples: 0x86,
} as const);

export type MessageType = keyof typeof MSG;

/** The channel each message travels on. */
export const MESSAGE_CHANNEL: Readonly<Record<MessageType, Channel>> = Object.freeze({
  hello: RELIABLE,
  bye: RELIABLE,
  ping: UNRELIABLE,
  moveReport: UNRELIABLE,
  aim: RELIABLE,
  use: RELIABLE,
  useRelease: RELIABLE,
  attack: RELIABLE,
  attackRelease: RELIABLE,
  swapHands: RELIABLE,
  selectSlot: RELIABLE,
  pickBlock: RELIABLE,
  invClick: RELIABLE,
  creativePick: RELIABLE,
  dropCursor: RELIABLE,
  closeInventory: RELIABLE,
  releaseHelm: RELIABLE,
  respawn: RELIABLE,
  setViewRadius: RELIABLE,
  hostCommand: RELIABLE,
  welcome: RELIABLE,
  refuse: RELIABLE,
  kick: RELIABLE,
  pong: UNRELIABLE,
  tickBatch: RELIABLE,
  samples: UNRELIABLE,
});

// ====================================================================== shared records

/** A cell value on the wire (section 6). M2.1: below 2^16 (id 10 bits + state 6 bits). */
export type Cell = number;

/**
 * Cells of a box, dense, in the box's index order (chunk: lx | lz<<4 | y<<8; structure:
 * (x-minX) + (z-minZ)*sx + (y-minY)*sx*sz). Its length is the box volume.
 */
export type CellVolume = Uint16Array;

/** Glue faces in GlueStore.toArray() form: (x, y, z, axis) quadruples in canonical order. */
export type GlueList = Int32Array;

/** A position (Pos32 on the wire: 1/512 block) and a rotation (Rot64: unit quaternion). */
export interface Pose {
  pos: Vec3;
  rot: Quat;
}

/** What a client aims at (section 10): grid-local cell, face, part, and the cell value it saw. */
export interface Target {
  gridId: number;
  x: number;
  y: number;
  z: number;
  face: Dir;
  /** Part or octant (M2.3, M2.4); 0 in M2.1. */
  sub: number;
  cell: Cell;
}

export interface WorldRules {
  defaultMode: Mode;
  dropsEnabled: boolean;
}

export interface PlayerEntry {
  entityId: number;
  name: string;
  host: boolean;
}

/**
 * How a client builds pristine chunks itself (section 3). Defined with the generators
 * (worldgen/generator.ts: ChunkGenerator.spec(), generatorFromSpec()).
 */
export type { GeneratorSpec };

// ====================================================================== movement (package 2 on the wire)

/**
 * A client tick of a client-driven player (section 9): package 2's MoveReport, which carries
 * `viewTick` and `landings` since package 6. Positions and velocities are in the carrier's frame
 * (world when carrierId is 0). On the wire: pos f64, vel / yaw / pitch f32, the stick axes i8 x 127.
 */
export type NetMoveReport = MoveReport;

/** The server's authoritative state of a client-driven player (section 9; package 2's Correction). */
export interface NetCorrection {
  epoch: number;
  /** Package 2's cause string, as is. */
  cause: string;
  carrierId: number;
  /** Feet in the carrier's frame, f64. */
  pos: Vec3;
  /** Relative to the carrier, f32. */
  vel: Vec3;
  /** f32. */
  yaw: number;
  /** f32. */
  pitch: number;
  flying: boolean;
  onGround: boolean;
  /** The ship whose wheel the player holds, 0 = none. */
  seatShipId: number;
  /** The seat (feet, local to that ship, f64); present exactly when seatShipId is not 0. */
  seat: Vec3 | null;
}

// ====================================================================== client -> server

export interface HelloMsg {
  type: 'hello';
  build: string;
  playerKey: string;
  name: string;
  viewRadius: number;
}
export interface ByeMsg {
  type: 'bye';
}
export interface PingMsg {
  type: 'ping';
  /** u32 (the client's clock in ms, wrapped). */
  clientMs: number;
}
export interface MoveReportMsg extends NetMoveReport {
  type: 'moveReport';
}
export interface AimMsg {
  type: 'aim';
  seq: number;
  moveSeq: number;
  /** Target of the use ray (follows the held item). */
  use: Target | null;
  /** Target of the mining ray (always the plain ray). */
  mine: Target | null;
}
export interface UseMsg {
  type: 'use';
  seq: number;
  moveSeq: number;
  /** Selected hotbar slot 0..8. */
  slot: number;
  sneak: boolean;
  target: Target | null;
}
export interface UseReleaseMsg {
  type: 'useRelease';
  seq: number;
}
export interface AttackMsg {
  type: 'attack';
  seq: number;
  moveSeq: number;
  slot: number;
  target: Target | null;
}
export interface AttackReleaseMsg {
  type: 'attackRelease';
  seq: number;
}
export interface SwapHandsMsg {
  type: 'swapHands';
  seq: number;
}
export interface SelectSlotMsg {
  type: 'selectSlot';
  seq: number;
  slot: number;
}
export interface PickBlockMsg {
  type: 'pickBlock';
  seq: number;
  moveSeq: number;
  target: Target;
}
export interface InvClickMsg {
  type: 'invClick';
  seq: number;
  area: InventoryArea;
  index: number;
  button: 0 | 2;
  shift: boolean;
}
export interface CreativePickMsg {
  type: 'creativePick';
  seq: number;
  item: number;
  shift: boolean;
}
export interface DropCursorMsg {
  type: 'dropCursor';
  seq: number;
}
export interface CloseInventoryMsg {
  type: 'closeInventory';
  seq: number;
}
export interface ReleaseHelmMsg {
  type: 'releaseHelm';
  seq: number;
}
export interface RespawnMsg {
  type: 'respawn';
  seq: number;
}
export interface SetViewRadiusMsg {
  type: 'setViewRadius';
  seq: number;
  /** 0..MAX_VIEW_RADIUS. */
  radius: number;
}

export type HostCommand =
  | { kind: 'setRules'; rules: WorldRules }
  /** entityId 0 = the host itself. */
  | { kind: 'setPlayerMode'; entityId: number; mode: Mode }
  /** Time of day 0..1 (f32). */
  | { kind: 'setDayTime'; t: number }
  | { kind: 'teleport'; x: number; y: number; z: number }
  | { kind: 'give'; item: number; count: number }
  | { kind: 'kick'; entityId: number };

/** Wire value of each HostCommand kind = index. */
export const HOST_COMMAND_KINDS: readonly HostCommand['kind'][] = Object.freeze([
  'setRules',
  'setPlayerMode',
  'setDayTime',
  'teleport',
  'give',
  'kick',
] as const);

export interface HostCommandMsg {
  type: 'hostCommand';
  seq: number;
  command: HostCommand;
}

export type ClientMessage =
  | HelloMsg
  | ByeMsg
  | PingMsg
  | MoveReportMsg
  | AimMsg
  | UseMsg
  | UseReleaseMsg
  | AttackMsg
  | AttackReleaseMsg
  | SwapHandsMsg
  | SelectSlotMsg
  | PickBlockMsg
  | InvClickMsg
  | CreativePickMsg
  | DropCursorMsg
  | CloseInventoryMsg
  | ReleaseHelmMsg
  | RespawnMsg
  | SetViewRadiusMsg
  | HostCommandMsg;

/**
 * The messages that go to the intents (package 7, net/server/intents.ts): everything a client
 * sends after Hello except Bye, Ping and movement reports.
 */
export type IntentMessage = Exclude<ClientMessage, HelloMsg | ByeMsg | PingMsg | MoveReportMsg>;

// ====================================================================== server -> client

export interface WelcomeMsg {
  type: 'welcome';
  /** The joining player's own entity id. */
  entityId: number;
  generator: GeneratorSpec;
  worldTime: number;
  dayOffset: number;
  rules: WorldRules;
  isHost: boolean;
  roomOpen: boolean;
  players: PlayerEntry[];
}
export interface RefuseMsg {
  type: 'refuse';
  reason: RefuseReason;
  detail: string;
}
export interface KickMsg {
  type: 'kick';
  reason: KickReason;
  detail: string;
}
export interface PongMsg {
  type: 'pong';
  clientMs: number;
  tick: number;
}

// ---------------------------------------------------------------- chunks (section 6)

export interface ChunkPos {
  cx: number;
  cz: number;
}

/**
 * A glued world face in a snapshot or delta: lx | lz<<4 | y<<8 | axis<<15 of its canonical
 * (smaller) end cell, which lies in the column.
 */
export type ChunkGlueFace = number;

export interface ChunkSnapshot {
  cx: number;
  cz: number;
  /** 'pristine': the client generates the column itself from the GeneratorSpec. */
  cells: 'pristine' | CellVolume;
  glue: ChunkGlueFace[];
}

export interface ChunkDelta {
  cx: number;
  cz: number;
  /** [index, cell], index ascending (lx | lz<<4 | y<<8). */
  cells: Array<[number, Cell]>;
  /** [face, added]. */
  glue: Array<[ChunkGlueFace, boolean]>;
}

// ---------------------------------------------------------------- structures (section 7)

interface StructureRecordBase {
  id: number;
  /** 0 = the world. */
  parentId: number;
  /** Tight cell box; all six 0 (and cells empty) for a structure without cells. */
  minX: number;
  minY: number;
  minZ: number;
  sx: number;
  sy: number;
  sz: number;
  cells: CellVolume;
  /** f64. */
  pivot: Vec3;
  /** f64, parent space. */
  position: Vec3;
  /** f64. */
  rotation: Quat;
  glue: GlueList;
}

export interface ShipRecord extends StructureRecordBase {
  kind: 'ship';
  helm: Vec3;
  forward: Dir;
  /** f32. */
  throttle: number;
  /** f32. */
  rudder: number;
  helmsmanId: number;
}

export interface RotorRecord extends StructureRecordBase {
  kind: 'rotor';
  /** In the parent's local cells. */
  bearing: Vec3;
  axis: Dir;
  baseRotation: Quat;
  angle: number;
  angularSpeed: number;
  sails: number;
  frozen: boolean;
}

export type StructureRecord = ShipRecord | RotorRecord;

export interface StructureDelta {
  id: number;
  /** [x, y, z, cell], local cells, each cell once. */
  cells?: Array<[number, number, number, Cell]>;
  /** [x, y, z, axis, added]: canonical end cell of the face. */
  glue?: Array<[number, number, number, Axis, boolean]>;
  /** New pivot (f64) after the ship's cells changed. */
  pivot?: Vec3;
  helm?: { x: number; y: number; z: number; forward: Dir; helmsmanId: number };
  /** f32. */
  control?: { throttle: number; rudder: number };
  rotor?: { angle: number; angularSpeed: number; sails: number; frozen: boolean };
}

/** The final pose of a ship that stopped moving (section 7). */
export interface StructureRest {
  id: number;
  pose: Pose;
}

// ---------------------------------------------------------------- entities (section 8)

export interface PlayerFlags {
  sneaking: boolean;
  sprinting: boolean;
  flying: boolean;
  dead: boolean;
  onGround: boolean;
}

/** A player's look (i16 pitch) and flags, carried by player samples. */
export interface PlayerLook {
  pitch: number;
  flags: PlayerFlags;
}

/** The moving part of an entity: kind (to decode without the replica), carrier, Pos32, Ang16 yaw. */
export interface EntityMotion {
  kind: EntityKind;
  /** 0 = none (then pos is in the world). */
  carrierId: number;
  pos: Vec3;
  yaw: number;
  /** Present exactly for players. */
  look: PlayerLook | null;
}

export interface EntitySample extends EntityMotion {
  id: number;
}

export interface PlayerHeld {
  flags: PlayerFlags;
  /** 0 = none. */
  steeringShipId: number;
  /** Item id in the selected hotbar slot, null = empty hand. */
  heldItem: number | null;
}

interface EntityRecordBase {
  id: number;
  carrierId: number;
  /** Pos32: local to the carrier, or world. */
  pos: Vec3;
  /** Ang16. */
  yaw: number;
}

export type EntityRecord =
  | (EntityRecordBase & { kind: 'player'; pitch: number } & PlayerHeld)
  | (EntityRecordBase & { kind: 'item'; item: number; count: number })
  | (EntityRecordBase & { kind: 'falling'; cell: Cell })
  | (EntityRecordBase & { kind: 'tnt'; fuse: number })
  | (EntityRecordBase & { kind: 'rabbit' });

export interface EntityUpdate {
  id: number;
  /** The entity stopped moving: its final motion state. */
  final?: EntityMotion;
  /** An item drop's merged stack. */
  stack?: { item: number; count: number };
  /** A blast-shortened TNT fuse (ticks). */
  fuse?: number;
  /** A player's flags, helm and held item. */
  player?: PlayerHeld;
}

// ---------------------------------------------------------------- private state (section 9)

export interface NetInventory {
  /** 0..8. */
  selected: number;
  /** HOTBAR_SLOTS entries. */
  hotbar: Array<ItemStack | null>;
  /** MAIN_SLOTS entries. */
  main: Array<ItemStack | null>;
  offhand: ItemStack | null;
  cursor: ItemStack | null;
}

export interface NetVitals {
  /** f32. */
  health: number;
  /** f32. */
  maxHealth: number;
  air: number;
  maxAir: number;
  dead: boolean;
  mode: Mode;
}

/** Mining progress the server computed (u8 progress on the wire: 0..1 in steps of 1/255). */
export interface MiningView {
  gridId: number;
  x: number;
  y: number;
  z: number;
  sub: number;
  progress: number;
}

export interface GluingView extends MiningView {
  face: Dir;
}

export interface PreviewView {
  gridId: number;
  kind: StructureKind;
  /**
   * Grid-local x, y, z triples, distinct, in the bitmap's (CellVolume) order: at most
   * MAX_PREVIEW_CELLS cells in a box of at most MAX_STRUCTURE_BOX_CELLS, coordinates within MAX_COORD.
   */
  cells: Int32Array;
}

/** The server-only parts of the interaction view; absent = unchanged. */
export interface ViewUpdate {
  mining?: MiningView | null;
  gluing?: GluingView | null;
  preview?: PreviewView | null;
  /** World cells. */
  conflicts?: Vec3[];
  hint?: Message | null;
}

/** Addressed events (the SimEvent strings without `player`). */
export type PrivateEvent =
  | { type: 'toast'; message: Message; kind: ToastKind }
  /** amount f32. */
  | { type: 'playerHurt'; amount: number; cause: string }
  | { type: 'playerDied'; cause: string }
  | { type: 'playerPickup'; item: number; count: number }
  | { type: 'helmReleased'; cause: string };

export interface PrivateState {
  correction?: NetCorrection;
  inventory?: NetInventory;
  vitals?: NetVitals;
  view?: ViewUpdate;
  events?: PrivateEvent[];
  /** Highest intent seq the server has processed. */
  ack?: number;
  /** Seq of the last movement report package 2 accepted in this tick. */
  moveAck?: number;
}

// ---------------------------------------------------------------- world events (section 11)

/** World events (the SimEvent strings); explosion and sound positions are f32. */
export type WorldEvent =
  | { type: 'blockBroken'; gridId: number; x: number; y: number; z: number; cell: Cell }
  | { type: 'blockPlaced'; gridId: number; x: number; y: number; z: number; cell: Cell }
  | { type: 'explosion'; x: number; y: number; z: number; power: number }
  | { type: 'sound'; name: string; x: number; y: number; z: number };

// ---------------------------------------------------------------- globals

export type PlayerListChange = ({ op: 'join' } & PlayerEntry) | { op: 'leave'; entityId: number };

/** Absent = unchanged. */
export interface Globals {
  dayOffset?: number;
  rules?: WorldRules;
  players?: PlayerListChange[];
  /** Ticks per second over the last 2 s of wall time, in steps of 0.1. */
  tps?: number;
  /** The ready zone has been sent (section 3). */
  ready?: true;
  roomOpen?: boolean;
}

// ---------------------------------------------------------------- the batch

/**
 * Bit of each TickBatch section in the `sections` mask (= application order, section 5).
 */
export const SECTION = Object.freeze({
  unsubscribe: 0,
  snapshots: 1,
  chunkDeltas: 2,
  structureRemoves: 3,
  structureSpawns: 4,
  structureDeltas: 5,
  structureRests: 6,
  entityDespawns: 7,
  entitySpawns: 8,
  entityUpdates: 9,
  private: 10,
  events: 11,
  globals: 12,
} as const);

/** The one reliable message per client per tick (section 5): the state at the end of `tick`. */
export interface TickBatchMsg {
  type: 'tickBatch';
  tick: number;
  unsubscribe: ChunkPos[];
  snapshots: ChunkSnapshot[];
  chunkDeltas: ChunkDelta[];
  /** Children before parents. */
  structureRemoves: number[];
  /** Parents before children. */
  structureSpawns: StructureRecord[];
  structureDeltas: StructureDelta[];
  structureRests: StructureRest[];
  entityDespawns: number[];
  entitySpawns: EntityRecord[];
  entityUpdates: EntityUpdate[];
  private: PrivateState | null;
  events: WorldEvent[];
  globals: Globals | null;
}

/** A TickBatch with every section empty (6 bytes encoded). */
export function emptyTickBatch(tick: number): TickBatchMsg {
  return {
    type: 'tickBatch',
    tick,
    unsubscribe: [],
    snapshots: [],
    chunkDeltas: [],
    structureRemoves: [],
    structureSpawns: [],
    structureDeltas: [],
    structureRests: [],
    entityDespawns: [],
    entitySpawns: [],
    entityUpdates: [],
    private: null,
    events: [],
    globals: null,
  };
}

export interface ShipSample {
  id: number;
  pose: Pose;
}

/** Pose and motion samples of one tick (unreliable, at most MAX_UNRELIABLE_BYTES; section 7, 8). */
export interface SamplesMsg {
  type: 'samples';
  tick: number;
  /** Increases by one per Samples message to this client (loss rate). */
  seq: number;
  ships: ShipSample[];
  entities: EntitySample[];
}

export type ServerMessage = WelcomeMsg | RefuseMsg | KickMsg | PongMsg | TickBatchMsg | SamplesMsg;

export type AnyMessage = ClientMessage | ServerMessage;
