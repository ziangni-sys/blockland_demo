/**
 * Random protocol messages for the codec tests. Every value lies on its field's wire grid (Pos32
 * multiples of 1/512, Ang16 and i16 steps computed with the decoder's own formulas, f32 values,
 * Rot64 quaternions that quantise exactly), so decode(encode(m)) must deep-equal m.
 */
import { CHUNK_VOLUME } from '../../src/core/constants';
import type { Axis, Dir } from '../../src/core/dirs';
import type { Quat, Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import type { ItemStack } from '../../src/blocks/items';
import type { Message } from '../../src/sim/view';
import {
  ENTITY_KINDS,
  HOTBAR_SLOTS,
  MAIN_SLOTS,
  MAX_COORD,
  MAX_VIEW_RADIUS,
  REFUSE_REASONS,
  KICK_REASONS,
  type ChunkDelta,
  type ChunkSnapshot,
  type ClientMessage,
  type EntityMotion,
  type EntityRecord,
  type EntitySample,
  type EntityUpdate,
  type GeneratorSpec,
  type Globals,
  type HostCommand,
  type Mode,
  type NetCorrection,
  type NetInventory,
  type NetMoveReport,
  type PlayerFlags,
  type PlayerHeld,
  type PlayerListChange,
  type Pose,
  type PrivateEvent,
  type PrivateState,
  type ServerMessage,
  type StructureDelta,
  type StructureRecord,
  type Target,
  type TickBatchMsg,
  type ViewUpdate,
  type WorldEvent,
} from '../../src/net/protocol';

/** Quaternions that survive Rot64 exactly (symmetric rounding, then normalisation). */
export const EXACT_QUATS: readonly Quat[] = [
  { x: 0, y: 0, z: 0, w: 1 },
  { x: 1, y: 0, z: 0, w: 0 },
  { x: 0, y: 1, z: 0, w: 0 },
  { x: 0, y: 0, z: -1, w: 0 },
  { x: 0, y: 0, z: 0, w: -1 },
  { x: 0.5, y: 0.5, z: 0.5, w: 0.5 },
  { x: -0.5, y: 0.5, z: -0.5, w: 0.5 },
];

export class Gen {
  readonly rng: Rng;
  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  int(lo: number, hi: number): number {
    return this.rng.int(lo, hi);
  }
  bool(): boolean {
    return this.rng.chance(0.5);
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(0, a.length - 1)]!;
  }
  maybe<T>(f: () => T): T | undefined {
    return this.bool() ? f() : undefined;
  }
  list<T>(f: () => T, max = 4, min = 0): T[] {
    const n = this.int(min, max);
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(f());
    return out;
  }

  /** varuint: small most of the time, sometimes up to 2^53 - 1. */
  vu(): number {
    const k = this.int(0, 9);
    if (k < 5) return this.int(0, 127);
    if (k < 8) return this.int(0, 1 << 21);
    if (k < 9) return this.int(0, 0xffffffff);
    return Number.MAX_SAFE_INTEGER - this.int(0, 1000);
  }
  id(): number {
    return this.int(1, 50_000);
  }
  coord(): number {
    return this.bool() ? this.int(-300, 300) : this.int(-MAX_COORD, MAX_COORD);
  }
  f64(): number {
    return this.bool() ? (this.rng.next() - 0.5) * 2e6 : this.rng.next() * 3 - 1.5;
  }
  f32(): number {
    return Math.fround((this.rng.next() - 0.5) * 2000);
  }
  vec64(): Vec3 {
    return { x: this.f64(), y: this.f64(), z: this.f64() };
  }
  vec32(): Vec3 {
    return { x: this.f32(), y: this.f32(), z: this.f32() };
  }
  quat64(): Quat {
    return { x: this.f64(), y: this.f64(), z: this.f64(), w: this.f64() };
  }
  pos32(): number {
    return this.int(-(2 ** 31), 2 ** 31 - 1) / 512;
  }
  pos32v(): Vec3 {
    return { x: this.pos32(), y: this.pos32(), z: this.pos32() };
  }
  ang16(): number {
    return (this.int(0, 65535) / 65536) * (2 * Math.PI);
  }
  pitch16(): number {
    return (this.int(-32767, 32767) / 32767) * (Math.PI / 2);
  }
  pose(): Pose {
    return { pos: this.pos32v(), rot: { ...this.pick(EXACT_QUATS) } };
  }
  cell(): number {
    return this.bool() ? this.int(0, 127) : this.int(0, 0xffff);
  }
  dir(): Dir {
    return this.int(0, 5) as Dir;
  }
  axis(): Axis {
    return this.int(0, 2) as Axis;
  }
  str(max = 12): string {
    const chars = 'abcXYZ019 _-.é漢🙂';
    let s = '';
    const n = this.int(0, max);
    for (let i = 0; i < n; i++) s += this.pick([...chars]);
    return s;
  }
  mode(): Mode {
    return this.bool() ? 'creative' : 'survival';
  }
  message(): Message {
    const key = `toast.${this.str(8)}`;
    if (this.bool()) return { key };
    const params: Record<string, number | string> = {};
    const n = this.int(1, 3);
    for (let i = 0; i < n; i++) params[`p${i}${this.str(3)}`] = this.bool() ? this.f64() : this.str(6);
    return { key, params };
  }
  target(): Target {
    return { gridId: this.int(0, 3000), x: this.coord(), y: this.coord(), z: this.coord(), face: this.dir(), sub: this.int(0, 255), cell: this.cell() };
  }
  optTarget(): Target | null {
    return this.bool() ? this.target() : null;
  }
  stack(): ItemStack | null {
    return this.int(0, 3) === 0 ? null : { item: this.int(1, 1100), count: this.int(1, 64) };
  }
  flags(): PlayerFlags {
    return { sneaking: this.bool(), sprinting: this.bool(), flying: this.bool(), dead: this.bool(), onGround: this.bool() };
  }

  // ------------------------------------------------------------ client -> server

  moveReport(): NetMoveReport {
    return {
      seq: this.vu(),
      epoch: this.vu(),
      viewTick: this.vu(),
      carrierId: this.int(0, 3) === 0 ? 0 : this.id(),
      pos: this.vec64(),
      vel: this.vec32(),
      yaw: this.f32(),
      pitch: this.f32(),
      onGround: this.bool(),
      sneaking: this.bool(),
      sprinting: this.bool(),
      flying: this.bool(),
      forward: this.int(-127, 127) / 127,
      strafe: this.int(-127, 127) / 127,
      sneak: this.bool(),
      landings: this.int(0, 255),
    };
  }

  hostCommand(): HostCommand {
    switch (this.int(0, 5)) {
      case 0:
        return { kind: 'setRules', rules: { defaultMode: this.mode(), dropsEnabled: this.bool() } };
      case 1:
        return { kind: 'setPlayerMode', entityId: this.int(0, 99), mode: this.mode() };
      case 2:
        return { kind: 'setDayTime', t: Math.fround(this.rng.next()) };
      case 3:
        return { kind: 'teleport', x: this.f64(), y: this.f64(), z: this.f64() };
      case 4:
        return { kind: 'give', item: this.int(1, 1100), count: this.int(1, 640) };
      default:
        return { kind: 'kick', entityId: this.id() };
    }
  }

  /** One random client message of every type, in id order. */
  clientMessages(): ClientMessage[] {
    const seq = (): number => this.vu();
    const use = this.optTarget();
    return [
      { type: 'hello', build: this.str(20), playerKey: this.str(32), name: this.str(24), viewRadius: this.int(0, MAX_VIEW_RADIUS) },
      { type: 'bye' },
      { type: 'ping', clientMs: this.int(0, 0xffffffff), rttMs: this.int(0, 60_000) },
      { type: 'moveReport', ...this.moveReport() },
      { type: 'aim', seq: seq(), moveSeq: seq(), use, mine: this.bool() ? (use === null ? null : { ...use }) : this.optTarget() },
      { type: 'use', seq: seq(), moveSeq: seq(), slot: this.int(0, 8), sneak: this.bool(), target: this.optTarget() },
      { type: 'useRelease', seq: seq() },
      { type: 'attack', seq: seq(), moveSeq: seq(), slot: this.int(0, 8), target: this.optTarget() },
      { type: 'attackRelease', seq: seq() },
      { type: 'swapHands', seq: seq() },
      { type: 'selectSlot', seq: seq(), slot: this.int(0, 8) },
      { type: 'pickBlock', seq: seq(), moveSeq: seq(), target: this.target() },
      { type: 'invClick', seq: seq(), area: this.pick(['hotbar', 'inventory', 'offhand'] as const), index: this.int(0, 255), button: this.bool() ? 0 : 2, shift: this.bool() },
      { type: 'creativePick', seq: seq(), item: this.int(0, 2000), shift: this.bool() },
      { type: 'dropCursor', seq: seq() },
      { type: 'closeInventory', seq: seq() },
      { type: 'releaseHelm', seq: seq() },
      { type: 'respawn', seq: seq() },
      { type: 'setViewRadius', seq: seq(), radius: this.int(0, MAX_VIEW_RADIUS) },
      { type: 'hostCommand', seq: seq(), command: this.hostCommand() },
    ];
  }

  // ------------------------------------------------------------ server -> client

  generator(): GeneratorSpec {
    const seed = this.int(0, 0xffffffff);
    switch (this.int(0, 2)) {
      case 0:
        return { kind: 'terrain', seed };
      case 1:
        return { kind: 'flat', seed, layers: this.list(() => ({ cell: this.cell(), thickness: this.int(0, 200) }), 5) };
      default:
        return { kind: 'void', seed };
    }
  }

  /** A column of terrain-like layers with a few specks (compresses like real chunks). */
  chunkCells(): Uint16Array {
    const cells = new Uint16Array(CHUNK_VOLUME);
    const top = this.int(10, 100);
    for (let y = 0; y < top; y++) cells.fill(y < top - 4 ? 1 : y < top - 1 ? 3 : 4, y << 8, (y + 1) << 8);
    for (let k = this.int(0, 60); k > 0; k--) cells[this.int(0, CHUNK_VOLUME - 1)] = this.cell();
    return cells;
  }

  chunkFace(): number {
    return this.int(0, 15) | (this.int(0, 15) << 4) | (this.int(0, 127) << 8) | (this.axis() << 15);
  }

  snapshot(): ChunkSnapshot {
    return { cx: this.coord(), cz: this.coord(), cells: this.int(0, 2) === 0 ? this.chunkCells() : 'pristine', glue: this.list(() => this.chunkFace(), 5) };
  }

  chunkDelta(): ChunkDelta {
    const idx = new Set<number>();
    for (let k = this.int(0, 8); k > 0; k--) idx.add(this.int(0, CHUNK_VOLUME - 1));
    const cells = [...idx].sort((a, b) => a - b).map((i): [number, number] => [i, this.cell()]);
    return { cx: this.coord(), cz: this.coord(), cells, glue: this.list((): [number, boolean] => [this.chunkFace(), this.bool()], 4) };
  }

  glueList(): Int32Array {
    const n = this.int(0, 6);
    const a = new Int32Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      a[i] = this.int(-5000, 5000);
      a[i + 1] = this.int(-100, 300);
      a[i + 2] = this.int(-5000, 5000);
      a[i + 3] = this.axis();
    }
    return a;
  }

  structureRecord(): StructureRecord {
    const empty = this.int(0, 5) === 0;
    const sx = empty ? 0 : this.int(1, 9);
    const sy = empty ? 0 : this.int(1, 5);
    const sz = empty ? 0 : this.int(1, 9);
    const cells = new Uint16Array(sx * sy * sz);
    for (let i = 0; i < cells.length; i++) cells[i] = this.int(0, 2) === 0 ? 0 : this.pick([10, 11, 8, 14, 50, 51, 40, this.cell()]);
    const base = {
      id: this.id(),
      parentId: this.bool() ? 0 : this.id(),
      minX: empty ? 0 : this.coord(),
      minY: empty ? 0 : this.coord(),
      minZ: empty ? 0 : this.coord(),
      sx,
      sy,
      sz,
      cells,
      pivot: this.vec64(),
      position: this.vec64(),
      rotation: this.quat64(),
      glue: this.glueList(),
    };
    if (this.bool()) {
      return {
        kind: 'rotor',
        ...base,
        bearing: { x: this.coord(), y: this.coord(), z: this.coord() },
        axis: this.dir(),
        baseRotation: this.quat64(),
        angle: this.f64(),
        angularSpeed: this.f64(),
        sails: this.int(0, 400),
        frozen: this.bool(),
      };
    }
    return {
      kind: 'ship',
      ...base,
      helm: { x: this.coord(), y: this.coord(), z: this.coord() },
      forward: this.dir(),
      throttle: this.f32(),
      rudder: this.f32(),
      helmsmanId: this.bool() ? 0 : this.id(),
    };
  }

  structureDelta(): StructureDelta {
    const d: StructureDelta = { id: this.id() };
    if (this.bool()) d.cells = this.list((): [number, number, number, number] => [this.coord(), this.coord(), this.coord(), this.cell()], 5);
    if (this.bool()) d.glue = this.list((): [number, number, number, Axis, boolean] => [this.coord(), this.coord(), this.coord(), this.axis(), this.bool()], 5);
    if (this.bool()) d.pivot = this.vec64();
    if (this.bool()) d.helm = { x: this.coord(), y: this.coord(), z: this.coord(), forward: this.dir(), helmsmanId: this.id() };
    if (this.bool()) d.control = { throttle: this.f32(), rudder: this.f32() };
    if (this.bool()) d.rotor = { angle: this.f64(), angularSpeed: this.f64(), sails: this.int(0, 40), frozen: this.bool() };
    return d;
  }

  motion(): EntityMotion {
    const kind = this.pick(ENTITY_KINDS);
    return {
      kind,
      carrierId: this.bool() ? 0 : this.id(),
      pos: this.pos32v(),
      yaw: this.ang16(),
      look: kind === 'player' ? { pitch: this.pitch16(), flags: this.flags() } : null,
    };
  }

  entitySample(): EntitySample {
    return { id: this.id(), ...this.motion() };
  }

  held(): PlayerHeld {
    return { flags: this.flags(), steeringShipId: this.bool() ? 0 : this.id(), heldItem: this.bool() ? null : this.int(0, 1100) };
  }

  entityRecord(): EntityRecord {
    const base = { id: this.id(), carrierId: this.bool() ? 0 : this.id(), pos: this.pos32v(), yaw: this.ang16() };
    switch (this.pick(ENTITY_KINDS)) {
      case 'player':
        return { ...base, kind: 'player', pitch: this.pitch16(), ...this.held() };
      case 'item':
        return { ...base, kind: 'item', item: this.int(1, 1100), count: this.int(1, 64) };
      case 'falling':
        return { ...base, kind: 'falling', cell: this.cell() };
      case 'tnt':
        return { ...base, kind: 'tnt', fuse: this.int(0, 80) };
      default:
        return { ...base, kind: 'rabbit' };
    }
  }

  entityUpdate(): EntityUpdate {
    const u: EntityUpdate = { id: this.id() };
    if (this.bool()) u.final = this.motion();
    if (this.bool()) u.stack = { item: this.int(1, 1100), count: this.int(1, 64) };
    if (this.bool()) u.fuse = this.int(0, 80);
    if (this.bool()) u.player = this.held();
    return u;
  }

  correction(): NetCorrection {
    const seated = this.bool();
    return {
      epoch: this.vu(),
      cause: this.pick(['drive', 'check:speed', 'release', 'unseat:pushed', 'knock', '']),
      carrierId: this.bool() ? 0 : this.id(),
      pos: this.vec64(),
      vel: this.vec32(),
      yaw: this.f32(),
      pitch: this.f32(),
      flying: this.bool(),
      onGround: this.bool(),
      seatShipId: seated ? this.id() : 0,
      seat: seated ? this.vec64() : null,
    };
  }

  inventory(): NetInventory {
    const slots = (n: number): Array<ItemStack | null> => Array.from({ length: n }, () => this.stack());
    return { selected: this.int(0, 8), hotbar: slots(HOTBAR_SLOTS), main: slots(MAIN_SLOTS), offhand: this.stack(), cursor: this.stack() };
  }

  view(): ViewUpdate {
    const v: ViewUpdate = {};
    const progress = (): number => this.int(0, 255) / 255;
    if (this.bool()) v.mining = this.bool() ? null : { gridId: this.int(0, 99), x: this.coord(), y: this.coord(), z: this.coord(), sub: this.int(0, 7), progress: progress() };
    if (this.bool()) v.gluing = this.bool() ? null : { gridId: this.int(0, 99), x: this.coord(), y: this.coord(), z: this.coord(), face: this.dir(), sub: 0, progress: progress() };
    if (this.bool()) {
      if (this.int(0, 3) === 0) v.preview = null;
      else {
        // Distinct cells in the decoder's (bitmap) order: y, then z, then x.
        const ox = this.int(-500, 500);
        const oy = this.int(0, 120);
        const oz = this.int(-500, 500);
        const keep: number[] = [];
        for (let y = 0; y < 4; y++) for (let z = 0; z < 5; z++) for (let x = 0; x < 6; x++) if (this.int(0, 2) === 0) keep.push(ox + x, oy + y, oz + z);
        v.preview = { gridId: this.int(0, 99), kind: this.bool() ? 'ship' : 'rotor', cells: Int32Array.from(keep) };
      }
    }
    if (this.bool()) v.conflicts = this.list(() => ({ x: this.coord(), y: this.coord(), z: this.coord() }), 4);
    if (this.bool()) v.hint = this.bool() ? null : this.message();
    return v;
  }

  privateEvent(): PrivateEvent {
    switch (this.int(0, 4)) {
      case 0:
        return { type: 'toast', message: this.message(), kind: this.pick(['info', 'warn', 'error'] as const) };
      case 1:
        return { type: 'playerHurt', amount: this.f32(), cause: this.str() };
      case 2:
        return { type: 'playerDied', cause: this.str() };
      case 3:
        return { type: 'playerPickup', item: this.int(1, 1100), count: this.int(1, 64) };
      default:
        return { type: 'helmReleased', cause: this.str() };
    }
  }

  privateState(): PrivateState {
    const p: PrivateState = {};
    if (this.bool()) p.correction = this.correction();
    if (this.bool()) p.inventory = this.inventory();
    if (this.bool()) p.vitals = { health: this.f32(), maxHealth: this.f32(), air: this.int(0, 300), maxAir: 300, dead: this.bool(), mode: this.mode() };
    if (this.bool()) p.view = this.view();
    if (this.bool()) p.events = this.list(() => this.privateEvent(), 3);
    if (this.bool()) p.ack = this.vu();
    if (this.bool()) p.moveAck = this.vu();
    return p;
  }

  worldEvent(): WorldEvent {
    switch (this.int(0, 3)) {
      case 0:
        return { type: 'blockBroken', gridId: this.int(0, 99), x: this.coord(), y: this.coord(), z: this.coord(), cell: this.cell() };
      case 1:
        return { type: 'blockPlaced', gridId: this.int(0, 99), x: this.coord(), y: this.coord(), z: this.coord(), cell: this.cell() };
      case 2:
        return { type: 'explosion', x: this.f32(), y: this.f32(), z: this.f32(), power: this.f32() };
      default:
        return { type: 'sound', name: this.str(), x: this.f32(), y: this.f32(), z: this.f32() };
    }
  }

  globals(): Globals {
    const g: Globals = {};
    if (this.bool()) g.dayOffset = this.int(0, 23999);
    if (this.bool()) g.rules = { defaultMode: this.mode(), dropsEnabled: this.bool() };
    if (this.bool()) g.players = this.list((): PlayerListChange => {
      const op = this.int(0, 2);
      if (op === 0) return { op: 'join', entityId: this.id(), name: this.str(24), host: this.bool(), mode: this.mode() };
      if (op === 1) return { op: 'leave', entityId: this.id() };
      return { op: 'mode', entityId: this.id(), mode: this.mode() };
    }, 3);
    if (this.bool()) g.tps = this.int(0, 300) / 10;
    if (this.bool()) g.ready = true;
    if (this.bool()) g.roomOpen = this.bool();
    return g;
  }

  tickBatch(): TickBatchMsg {
    const some = <T>(f: () => T, max = 3): T[] => (this.bool() ? this.list(f, max, 1) : []);
    return {
      type: 'tickBatch',
      tick: this.vu(),
      unsubscribe: some(() => ({ cx: this.coord(), cz: this.coord() })),
      snapshots: some(() => this.snapshot()),
      chunkDeltas: some(() => this.chunkDelta()),
      structureRemoves: some(() => this.id()),
      structureSpawns: some(() => this.structureRecord()),
      structureDeltas: some(() => this.structureDelta()),
      structureRests: some(() => ({ id: this.id(), pose: this.pose() })),
      entityDespawns: some(() => this.id()),
      entitySpawns: some(() => this.entityRecord()),
      entityUpdates: some(() => this.entityUpdate()),
      private: this.bool() ? this.privateState() : null,
      events: some(() => this.worldEvent()),
      globals: this.bool() ? this.globals() : null,
    };
  }

  /** One random server message of every type, in id order. */
  serverMessages(): ServerMessage[] {
    return [
      {
        type: 'welcome',
        entityId: this.id(),
        generator: this.generator(),
        worldTime: this.vu(),
        dayOffset: this.int(0, 23999),
        rules: { defaultMode: this.mode(), dropsEnabled: this.bool() },
        isHost: this.bool(),
        roomOpen: this.bool(),
        players: this.list(() => ({ entityId: this.id(), name: this.str(24), host: this.bool(), mode: this.mode() }), 4),
      },
      { type: 'refuse', reason: this.pick(REFUSE_REASONS), detail: this.str(40) },
      { type: 'kick', reason: this.pick(KICK_REASONS), detail: this.str(40) },
      { type: 'pong', clientMs: this.int(0, 0xffffffff), tick: this.vu() },
      this.tickBatch(),
      { type: 'samples', tick: this.vu(), seq: this.vu(), ships: this.list(() => ({ id: this.id(), pose: this.pose() }), 3), entities: this.list(() => this.entitySample(), 6) },
    ];
  }
}
