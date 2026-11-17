/**
 * Binary persistence of structures (docs/ARCHITECTURE.md "存档"; ACCEPTANCE 23: after a round
 * trip structures — nested ones too —, glue and rotor angles are identical).
 *
 * Layout (all through ByteWriter / ByteReader, little-endian):
 *
 *   u8       format (STRUCTURES_FORMAT)
 *   varuint  nextId                      id counter: ids are never reused within a world
 *   varuint  structure count
 *   per structure, in id order:
 *     u8       kind (0 ship, 1 rotor)
 *     varuint  id
 *     varuint  parent id (0 = the world; a rotor's parent must be a ship in this file)
 *     cells    varint minX minY minZ, varuint sx sy sz, u16Array of the dense tight box
 *              (index = (x-minX) + (z-minZ)*sx + (y-minY)*sx*sz)
 *     pose     f64 x 23: pivot, position, rotation, prevPosition, prevRotation,
 *              linearVelocity, angularVelocity
 *     glue     i32Array: GlueStore.toArray() (canonical x, y, z, axis quadruples)
 *     rotor:   varint bearing x y z, u8 axis, f64 x 4 baseRotation, f64 angle,
 *              f64 angularSpeed, varuint sails, bool hubGlue
 *     ship:    varint helm x y z, u8 forward, f64 throttle, f64 rudder, bool asleep,
 *              varuint restTicks
 *
 * Not stored: the helmsman (entities re-take the wheel), frozen flags and ship.sails
 * (recomputed every step), hull / mass / inertia (rebuilt by the dynamics' refresh).
 *
 * Reading validates everything it relies on and throws SaveFormatError (via ByteReader.fail)
 * on malformed data; it builds fresh objects and touches no live state, so a failed load
 * leaves the caller's structures intact.
 */
import { AIR, ID_MASK } from '../blocks/cell';
import { BLOCKS } from '../blocks/registry';
import type { Dir } from '../core/dirs';
import type { Quat, Vec3 } from '../core/math';
import type { ByteReader, ByteWriter } from '../save/bytes';
import { SET_STRUCTURE_MOVE } from '../voxel/grid';
import type { StructureGrid } from '../voxel/sgrid';
import type { World } from '../voxel/world';
import type { GlueStore } from './glue';
import { Rotor, Ship, type Structure } from './structure';

export const STRUCTURES_FORMAT = 1;

const KIND_SHIP = 0;
const KIND_ROTOR = 1;
/** Largest dense cell box accepted on read (a 4000-cell ship needs far less). */
const MAX_BOX_CELLS = 1 << 24;
/** Coordinates stay well inside int32 so every integer computation downstream is exact. */
const MAX_COORD = 1 << 28;
/**
 * Lower bound of the bytes one structure record takes (kind, id, parent, empty cell box,
 * 23 f64 pose, empty glue, smallest kind-specific tail): lets the reader reject a corrupted
 * structure count before looping over it.
 */
const MIN_RECORD_BYTES = 200;

export interface DecodedStructures {
  nextId: number;
  /** In id order, parent links rebuilt (rotor.parent, rotor.grid.parent, ship.children). */
  structures: Structure[];
}

// ------------------------------------------------------------ write

/**
 * Write `structures` (every live structure of a manager) and the id counter. Throws when a
 * rotor's parent ship is not part of the list (that would be a save no load could resolve).
 */
export function writeStructures(w: ByteWriter, nextId: number, structures: readonly Structure[]): void {
  const sorted = [...structures].sort((a, b) => a.id - b.id);
  const ids = new Set<number>();
  for (const s of sorted) {
    if (s.id >= nextId) throw new Error(`writeStructures: structure id ${s.id} is not below nextId ${nextId}`);
    ids.add(s.id);
  }
  w.u8(STRUCTURES_FORMAT);
  w.varuint(nextId);
  w.varuint(sorted.length);
  for (const s of sorted) {
    const parentId = s.parent !== null ? s.parent.id : 0;
    if (parentId !== 0 && !ids.has(parentId)) throw new Error(`writeStructures: parent ${parentId} of structure ${s.id} is missing`);
    w.u8(s instanceof Ship ? KIND_SHIP : KIND_ROTOR);
    w.varuint(s.id);
    w.varuint(parentId);
    writeCells(w, s.grid);
    writePose(w, s.grid);
    w.i32Array(s.glue.toArray());
    if (s instanceof Rotor) {
      w.varint(s.bearingX).varint(s.bearingY).varint(s.bearingZ);
      w.u8(s.axis);
      writeQuat(w, s.baseRotation);
      w.f64(s.angle).f64(s.angularSpeed);
      w.varuint(s.sails);
      w.bool(s.hubGlue);
    } else if (s instanceof Ship) {
      w.varint(s.helmX).varint(s.helmY).varint(s.helmZ);
      w.u8(s.forward);
      w.f64(s.throttle).f64(s.rudder);
      w.bool(s.asleep);
      w.varuint(s.restTicks);
    }
  }
}

function writeCells(w: ByteWriter, g: StructureGrid): void {
  const b = g.cellBounds();
  if (b === null) {
    w.varint(0).varint(0).varint(0).varuint(0).varuint(0).varuint(0);
    w.u16Array(new Uint16Array(0));
    return;
  }
  const sx = b.maxX - b.minX;
  const sy = b.maxY - b.minY;
  const sz = b.maxZ - b.minZ;
  const dense = new Uint16Array(sx * sy * sz);
  g.forEachCell((x, y, z, cell) => {
    dense[x - b.minX + (z - b.minZ) * sx + (y - b.minY) * sx * sz] = cell;
  });
  w.varint(b.minX).varint(b.minY).varint(b.minZ).varuint(sx).varuint(sy).varuint(sz);
  w.u16Array(dense);
}

function writeVec(w: ByteWriter, v: Vec3): void {
  w.f64(v.x).f64(v.y).f64(v.z);
}
function writeQuat(w: ByteWriter, q: Quat): void {
  w.f64(q.x).f64(q.y).f64(q.z).f64(q.w);
}
function writePose(w: ByteWriter, g: StructureGrid): void {
  writeVec(w, g.pivot);
  writeVec(w, g.position);
  writeQuat(w, g.rotation);
  writeVec(w, g.prevPosition);
  writeQuat(w, g.prevRotation);
  writeVec(w, g.linearVelocity);
  writeVec(w, g.angularVelocity);
}

// ------------------------------------------------------------ read

/**
 * Read what writeStructures wrote. New structures are created with `world` as the parent
 * grid and re-parented onto their ships; no hooks are attached (the manager does that).
 */
export function readStructures(r: ByteReader, world: World): DecodedStructures {
  const format = r.u8();
  if (format !== STRUCTURES_FORMAT) r.fail(`unsupported structures format ${format}`);
  const nextId = r.varuint();
  if (nextId < 1) r.fail('structure id counter must be at least 1');
  const n = r.count(MIN_RECORD_BYTES);
  const byId = new Map<number, Structure>();
  const parents = new Map<Structure, number>();
  for (let i = 0; i < n; i++) {
    const kind = r.u8();
    if (kind !== KIND_SHIP && kind !== KIND_ROTOR) r.fail(`unknown structure kind ${kind}`);
    const id = r.varuint();
    if (id < 1 || id >= nextId) r.fail(`structure id ${id} outside 1..${nextId - 1}`);
    if (byId.has(id)) r.fail(`duplicate structure id ${id}`);
    const parentId = r.varuint();
    if (kind === KIND_SHIP && parentId !== 0) r.fail(`ship ${id} has a parent (${parentId})`);
    const s: Structure = kind === KIND_SHIP ? new Ship(id, world) : new Rotor(id, world);
    readCells(r, s.grid);
    readPose(r, s.grid);
    readGlue(r, s.glue);
    if (s instanceof Rotor) {
      s.bearingX = readCoord(r);
      s.bearingY = readCoord(r);
      s.bearingZ = readCoord(r);
      s.axis = readDir(r);
      readQuat(r, s.baseRotation);
      s.angle = readFinite(r);
      s.angularSpeed = readFinite(r);
      s.sails = r.varuint();
      s.hubGlue = r.bool();
    } else if (s instanceof Ship) {
      s.helmX = readCoord(r);
      s.helmY = readCoord(r);
      s.helmZ = readCoord(r);
      s.forward = readDir(r);
      s.throttle = readFinite(r);
      s.rudder = readFinite(r);
      s.asleep = r.bool();
      s.restTicks = r.varuint();
    }
    byId.set(id, s);
    parents.set(s, parentId);
  }
  const structures = [...byId.values()].sort((a, b) => a.id - b.id);
  for (const s of structures) {
    const parentId = parents.get(s)!;
    if (parentId === 0) continue;
    const p = byId.get(parentId);
    if (!(p instanceof Ship)) r.fail(`rotor ${s.id} is mounted on ${parentId}, which is not a ship in this save`);
    s.parent = p;
    s.grid.parent = p.grid;
    p.children.push(s as Rotor); // id order, like creation order
  }
  return { nextId, structures };
}

function readCoord(r: ByteReader): number {
  const v = r.varint();
  if (v < -MAX_COORD || v > MAX_COORD) r.fail(`coordinate ${v} out of range`);
  return v;
}

function readDir(r: ByteReader): Dir {
  const d = r.u8();
  if (d > 5) r.fail(`invalid direction ${d}`);
  return d as Dir;
}

function readFinite(r: ByteReader): number {
  const v = r.f64();
  if (!Number.isFinite(v)) r.fail(`non-finite number ${v}`);
  return v;
}

function readVec(r: ByteReader, out: Vec3): void {
  out.x = readFinite(r);
  out.y = readFinite(r);
  out.z = readFinite(r);
}

function readQuat(r: ByteReader, out: Quat): void {
  out.x = readFinite(r);
  out.y = readFinite(r);
  out.z = readFinite(r);
  out.w = readFinite(r);
  const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w);
  if (Math.abs(len - 1) > 1e-3) r.fail(`rotation is not a unit quaternion (|q| = ${len})`);
}

function readPose(r: ByteReader, g: StructureGrid): void {
  readVec(r, g.pivot);
  readVec(r, g.position);
  readQuat(r, g.rotation);
  readVec(r, g.prevPosition);
  readQuat(r, g.prevRotation);
  readVec(r, g.linearVelocity);
  readVec(r, g.angularVelocity);
}

function readCells(r: ByteReader, g: StructureGrid): void {
  const minX = readCoord(r);
  const minY = readCoord(r);
  const minZ = readCoord(r);
  const sx = r.varuint();
  const sy = r.varuint();
  const sz = r.varuint();
  if (sx > MAX_COORD || sy > MAX_COORD || sz > MAX_COORD) r.fail('cell box too large');
  const volume = sx * sy * sz;
  if (volume > MAX_BOX_CELLS) r.fail(`cell box of ${volume} cells is too large`);
  const dense = r.u16Array();
  if (dense.length !== volume) r.fail(`cell box holds ${dense.length} cells, expected ${volume}`);
  if (volume === 0) return;
  g.resize(minX, minY, minZ, sx, sy, sz);
  const layer = sx * sz;
  for (let i = 0; i < volume; i++) {
    const cell = dense[i]!;
    if (cell === AIR) continue;
    if (BLOCKS[cell & ID_MASK] === undefined) r.fail(`unknown block id ${cell & ID_MASK} in structure`);
    const y = Math.floor(i / layer);
    const rem = i - y * layer;
    const z = Math.floor(rem / sx);
    g.setCell(minX + rem - z * sx, minY + y, minZ + z, cell, SET_STRUCTURE_MOVE);
  }
}

function readGlue(r: ByteReader, glue: GlueStore): void {
  const a = r.i32Array();
  if (a.length % 4 !== 0) r.fail(`glue array length ${a.length} is not a multiple of 4`);
  for (let i = 0; i < a.length; i += 4) {
    const axis = a[i + 3]!;
    if (axis !== 0 && axis !== 1 && axis !== 2) r.fail(`invalid glue axis ${axis}`);
    try {
      glue.add(a[i]!, a[i + 1]!, a[i + 2]!, (axis * 2) as Dir);
    } catch (e) {
      r.fail(`invalid glue face: ${(e as Error).message}`);
    }
  }
}
