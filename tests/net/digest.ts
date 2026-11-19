/**
 * Digests of the server's state and of a client's replica, and their comparison (docs/NETCODE.md
 * section 15 "tests/net/digest.ts"): per column a hash of the cells and the set of world glue faces;
 * per structure its kind, parent, cell box and cells, glue, fields, pivot, pose and (rotors) the
 * angle at the replica's tick; per entity its kind, carrier, position and fields.
 *
 * The server side is computed over a SCOPE (the columns, structures and entities the replicator
 * believes the client has, see Replicator.clientView), so comparing also checks that bookkeeping
 * against what the replica really holds. Both sides can be narrowed to a subset of the columns
 * (the ones that changed in a tick) for cheap per-tick checks; a full comparison takes every column.
 *
 * Poses compare with the tolerance of the wire's fixed-point forms (Pos32 1/512 block, Rot64,
 * Ang16, i16 pitch); everything else exactly (throttle and rudder as f32).
 */
import { TICK_DT } from '../../src/core/constants';
import { wrapAngle, type Quat, type Vec3 } from '../../src/core/math';
import { FallingBlockEntity, ItemEntity, Player, TntEntity, type Entity } from '../../src/entities/entity';
import { headingOf } from '../../src/entities/structs';
import type { ReplicaState } from '../../src/net/client/apply';
import type { Simulation } from '../../src/sim/simulation';
import { advanceRotor, holdRotor } from '../../src/structures/rotor';
import { Rotor, Ship, type Structure } from '../../src/structures/structure';
import type { GlueStore } from '../../src/structures/glue';
import { chunkKey, chunkKeyX, chunkKeyZ } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import type { ChunkGenerator } from '../../src/worldgen/generator';

export interface ColumnDigest {
  hash: number;
  glue: string;
}

export interface StructureDigest {
  kind: string;
  parentId: number;
  box: string;
  cells: number;
  glue: number;
  /** Kind-specific fields compared exactly. */
  fields: string;
  pivot: Vec3;
  pos: Vec3;
  rot: Quat;
  /** Rotors: the angle at the digest's tick. */
  angle: number;
}

export interface EntityDigest {
  kind: string;
  carrierId: number;
  pos: Vec3;
  yaw: number;
  pitch: number;
  fields: string;
}

export interface Digest {
  tick: number;
  columns: Map<number, ColumnDigest>;
  structures: Map<number, StructureDigest>;
  entities: Map<number, EntityDigest>;
}

export interface Scope {
  columns: Iterable<number>;
  structures: Iterable<number>;
  entities: Iterable<number>;
}

/** FNV-1a over the 32-bit words of a cell array. */
export function hashCells(cells: Uint16Array): number {
  let h = 0x811c9dc5;
  const n = cells.length;
  for (let i = 0; i < n; i++) {
    h ^= cells[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashInts(a: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]! | 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function columnGlue(glue: GlueStore, cx: number, cz: number): string {
  const x0 = cx * 16;
  const z0 = cz * 16;
  const out: string[] = [];
  glue.forEachInBox(x0, 0, z0, x0 + 15, 127, z0 + 15, (x, y, z, axis) => {
    if (x >= x0 && x < x0 + 16 && z >= z0 && z < z0 + 16 && y >= 0) out.push(`${x},${y},${z},${axis}`);
  });
  return out.sort().join(';');
}

/** Server-side digests need the generator's output of pristine columns; their hashes are cached here. */
export class DigestContext {
  private readonly pristine = new Map<number, number>();
  constructor(readonly generator: ChunkGenerator) {}

  pristineHash(cx: number, cz: number): number {
    const key = chunkKey(cx, cz);
    let h = this.pristine.get(key);
    if (h === undefined) {
      h = hashCells(this.generator.generate(cx, cz));
      this.pristine.set(key, h);
    }
    return h;
  }
}

/** The server's state over a scope; `columns` narrows the columns further (per-tick checks). */
export function serverDigest(ctx: DigestContext, sim: Simulation, scope: Scope, columns?: ReadonlySet<number>): Digest {
  const d: Digest = { tick: sim.ticks, columns: new Map(), structures: new Map(), entities: new Map() };
  for (const key of scope.columns) {
    if (columns !== undefined && !columns.has(key)) continue;
    const cx = chunkKeyX(key);
    const cz = chunkKeyZ(key);
    const chunk = sim.world.getChunk(cx, cz);
    let hash: number;
    if (chunk !== undefined) hash = hashCells(chunk.cells);
    else {
      const stashed = sim.chunks.stashedCells(cx, cz);
      hash = stashed !== null ? hashCells(stashed) : ctx.pristineHash(cx, cz);
    }
    d.columns.set(key, { hash, glue: columnGlue(sim.worldGlue, cx, cz) });
  }
  for (const id of scope.structures) {
    const s = sim.structures.get(id);
    if (s === undefined) continue;
    d.structures.set(id, structureDigest(s, s instanceof Rotor ? s.angle : 0, s.grid.position, s.grid.rotation));
  }
  for (const id of scope.entities) {
    const e = sim.entities.get(id);
    if (e === undefined || e.removed) continue;
    d.entities.set(id, serverEntity(sim, e));
  }
  return d;
}

/** The replica's state; `columns` narrows the columns (per-tick checks). */
export function replicaDigest(state: ReplicaState, columns?: ReadonlySet<number>): Digest {
  const d: Digest = { tick: state.tick, columns: new Map(), structures: new Map(), entities: new Map() };
  for (const [key, chunk] of state.world.chunks) {
    if (columns !== undefined && !columns.has(key)) continue;
    d.columns.set(key, { hash: hashCells(chunk.cells), glue: columnGlue(state.worldGlue, chunk.cx, chunk.cz) });
  }
  for (const [id, rs] of state.structures) {
    const s = rs.structure;
    const angle = s instanceof Rotor ? rotorAngleAt(s, state.tick - rs.rotorTick) : 0;
    d.structures.set(id, structureDigest(s, angle, rs.pose.pos, rs.pose.rot));
  }
  for (const [id, e] of state.entities) {
    let fields = '';
    if (e.kind === 'item') fields = `${e.item}x${e.count}`;
    else if (e.kind === 'falling') fields = `${e.cell}`;
    else if (e.kind === 'tnt') fields = `${Math.max(0, e.fuse - (state.tick - e.fuseTick))}`;
    else if (e.kind === 'player' && e.player !== null) fields = playerFields(e.player.flags, e.player.steeringShipId, e.player.heldItem);
    d.entities.set(id, { kind: e.kind, carrierId: e.carrierId, pos: { ...e.pos }, yaw: e.yaw, pitch: e.look?.pitch ?? 0, fields });
  }
  return d;
}

/** A rotor's angle `ticks` ticks after its state, as the server's step advances it (frozen: held). */
function rotorAngleAt(r: Rotor, ticks: number): number {
  if (ticks <= 0 || r.frozen) return r.angle;
  const scratch = new Rotor(1, new World());
  scratch.axis = r.axis;
  scratch.sails = r.sails;
  scratch.angle = r.angle;
  scratch.angularSpeed = r.angularSpeed;
  const q = scratch.baseRotation;
  q.x = r.baseRotation.x;
  q.y = r.baseRotation.y;
  q.z = r.baseRotation.z;
  q.w = r.baseRotation.w;
  for (let i = 0; i < ticks; i++) {
    if (r.frozen) holdRotor(scratch);
    else advanceRotor(scratch, TICK_DT);
  }
  return scratch.angle;
}

/** `pos` / `rot`: the pose to compare (the server's grid; the replica's latest pose from the server). */
function structureDigest(s: Structure, angle: number, pos: Vec3, rot: Quat): StructureDigest {
  const g = s.grid;
  const b = g.cellBounds();
  const box = b === null ? 'empty' : `${b.minX},${b.minY},${b.minZ},${b.maxX},${b.maxY},${b.maxZ}`;
  const cells: number[] = [];
  if (b !== null) {
    for (let y = b.minY; y < b.maxY; y++) for (let z = b.minZ; z < b.maxZ; z++) for (let x = b.minX; x < b.maxX; x++) cells.push(g.getCell(x, y, z));
  }
  let fields: string;
  if (s instanceof Rotor) {
    const q = s.baseRotation;
    fields = `rotor ${s.bearingX},${s.bearingY},${s.bearingZ} axis ${s.axis} base ${q.x},${q.y},${q.z},${q.w} sails ${s.sails} frozen ${s.frozen}`;
  } else {
    const sh = s as Ship;
    fields = `ship helm ${sh.helmX},${sh.helmY},${sh.helmZ} fwd ${sh.forward} by ${sh.helmsmanId} thr ${Math.fround(sh.throttle)} rud ${Math.fround(sh.rudder)}`;
  }
  return {
    kind: s.kind,
    parentId: s.parent?.id ?? 0,
    box,
    cells: hashInts(cells),
    glue: hashInts(s.glue.toArray()),
    fields,
    pivot: { ...g.pivot },
    pos: { ...pos },
    rot: { ...rot },
    angle,
  };
}

function playerFields(f: { sneaking: boolean; sprinting: boolean; flying: boolean; dead: boolean; onGround: boolean }, steering: number, held: number | null): string {
  return `${+f.sneaking}${+f.sprinting}${+f.flying}${+f.dead}${+f.onGround} steer ${steering} held ${held}`;
}

function serverEntity(sim: Simulation, e: Entity): EntityDigest {
  let carrierId = e.carrierId;
  let pos: Vec3 = { ...e.pos };
  let yaw = e.yaw;
  const carrier = carrierId !== 0 ? sim.structures.get(carrierId) : undefined;
  if (carrier === undefined) carrierId = 0;
  else {
    pos = carrier.grid.toLocal(e.pos);
    yaw = wrapAngle(e.yaw - headingOf(carrier.grid.worldRotation()));
  }
  let fields = '';
  if (e instanceof ItemEntity) fields = `${e.stack.item}x${e.stack.count}`;
  else if (e instanceof FallingBlockEntity) fields = `${e.cell}`;
  else if (e instanceof TntEntity) fields = `${Math.max(0, e.fuse)}`;
  else if (e instanceof Player) {
    const st = e.inventory.selectedStack();
    fields = playerFields(
      { sneaking: e.sneaking, sprinting: e.sprinting, flying: e.flying, dead: e.dead, onGround: e.onGround },
      e.steeringShipId,
      st !== null && st.count > 0 ? st.item : null,
    );
  }
  return { kind: e.kind, carrierId, pos, yaw, pitch: e instanceof Player ? e.pitch : 0, fields };
}

/** Tolerances of the wire's fixed-point forms. */
const POS_TOL = 1.5 / 512;
const ROT_TOL = 1e-4;
const ANG_TOL = 2e-4;
const PIVOT_TOL = 1e-9;

function vecDiff(a: Vec3, b: Vec3): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}
function quatDiff(a: Quat, b: Quat): number {
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  return Math.max(Math.abs(a.x - s * b.x), Math.abs(a.y - s * b.y), Math.abs(a.z - s * b.z), Math.abs(a.w - s * b.w));
}
function angDiff(a: number, b: number): number {
  return Math.abs(wrapAngle(a - b));
}

/** Differences between the server's digest and a client's (empty when they agree). */
export function compareReplica(server: Digest, client: Digest, opts: { poses?: boolean } = {}): string[] {
  const out: string[] = [];
  const poses = opts.poses ?? true;
  const keys = <T>(a: Map<number, T>, b: Map<number, T>, what: string, name: (k: number) => string): void => {
    for (const k of a.keys()) if (!b.has(k)) out.push(`${what} ${name(k)} missing on the client`);
    for (const k of b.keys()) if (!a.has(k)) out.push(`${what} ${name(k)} on the client only`);
  };
  const col = (k: number): string => `${chunkKeyX(k)},${chunkKeyZ(k)}`;
  keys(server.columns, client.columns, 'column', col);
  for (const [k, s] of server.columns) {
    const c = client.columns.get(k);
    if (c === undefined) continue;
    if (s.hash !== c.hash) out.push(`column ${col(k)}: cells differ`);
    if (s.glue !== c.glue) out.push(`column ${col(k)}: glue differs (server ${s.glue} / client ${c.glue})`);
  }
  keys(server.structures, client.structures, 'structure', String);
  for (const [k, s] of server.structures) {
    const c = client.structures.get(k);
    if (c === undefined) continue;
    for (const f of ['kind', 'parentId', 'box', 'cells', 'glue', 'fields'] as const) {
      if (s[f] !== c[f]) out.push(`structure ${k}: ${f} differs (server ${s[f]} / client ${c[f]})`);
    }
    if (vecDiff(s.pivot, c.pivot) > PIVOT_TOL) out.push(`structure ${k}: pivot differs`);
    if (s.kind === 'rotor' && Math.abs(wrapAngle(s.angle - c.angle)) > 1e-9) out.push(`structure ${k}: rotor angle ${s.angle} / ${c.angle}`);
    if (poses && s.kind === 'ship') {
      if (vecDiff(s.pos, c.pos) > POS_TOL) out.push(`structure ${k}: position differs by ${vecDiff(s.pos, c.pos)}`);
      if (quatDiff(s.rot, c.rot) > ROT_TOL) out.push(`structure ${k}: rotation differs by ${quatDiff(s.rot, c.rot)}`);
    }
  }
  keys(server.entities, client.entities, 'entity', String);
  for (const [k, s] of server.entities) {
    const c = client.entities.get(k);
    if (c === undefined) continue;
    if (s.kind !== c.kind || s.fields !== c.fields) out.push(`entity ${k}: ${s.kind} ${s.fields} / ${c.kind} ${c.fields}`);
    if (!poses) continue;
    if (s.carrierId !== c.carrierId) out.push(`entity ${k}: carrier ${s.carrierId} / ${c.carrierId}`);
    else if (vecDiff(s.pos, c.pos) > POS_TOL) out.push(`entity ${k}: position differs by ${vecDiff(s.pos, c.pos)}`);
    if (angDiff(s.yaw, c.yaw) > ANG_TOL) out.push(`entity ${k}: yaw ${s.yaw} / ${c.yaw}`);
    if (Math.abs(s.pitch - c.pitch) > ANG_TOL) out.push(`entity ${k}: pitch ${s.pitch} / ${c.pitch}`);
  }
  return out;
}
