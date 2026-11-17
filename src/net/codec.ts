/**
 * Byte layouts of the multiplayer protocol (docs/NETCODE.md section 14), over save/bytes.ts.
 *
 * ENTRY POINTS. encodeClientMessage / decodeClientMessage, encodeServerMessage /
 * decodeServerMessage, packSamples (splits a tick's samples into messages that fit the unreliable
 * channel), readHelloBuild (the part of Hello that never changes), and encodeTickBatch with
 * encodeSnapshotPiece / encodeStructureRecordPiece (a server encodes a snapshot or a structure
 * record once and writes the same bytes into several clients' batches). The write* / read*
 * functions are the building blocks (basic types, Cell, CellVolume, GlueList, records).
 *
 * ERRORS.
 *  - Encoding invalid data (a value outside its field, a message too long for its channel) is
 *    a caller bug: RangeError, never silent truncation.
 *  - Decoding: the read* functions fail through ByteReader (SaveFormatError); every decode*
 *    entry point turns any failure into a ProtocolError, the only error it throws (the
 *    connection then ends with protocol_error / bad_hello). Every decode* ends with expectEnd().
 *  - The decoder accepts exactly what the encoder can produce for the field domains the layout
 *    defines (enumerations, flag bits, Cell < 2^16, coordinates within MAX_COORD, i8 / i16 never
 *    -128 / -32768, a non-zero Rot64, ascending chunk delta indices, ...). Semantic checks
 *    (does this id exist, is the name acceptable) are the receiver's. Floats pass through as they
 *    are, NaN included: a non-finite movement report is a failed check, not a protocol error.
 *
 * BOUNDED DECODING. Reading never goes out of bounds (ByteReader). Every list count is checked
 * against the remaining input at the smallest size of one element before anything is allocated,
 * and every loop consumes input, so allocation is proportional to the input and no loop runs
 * without bound. Two layouts expand their input, so they have fixed caps, checked before
 * allocating and enforced by the encoder too:
 *  - the run-length CellVolume lets a few bytes describe a whole column: its volume is fixed by
 *    the context (32768 for a chunk, a structure box of at most MAX_STRUCTURE_BOX_CELLS) and all
 *    CellVolumes of one TickBatch together may describe at most MAX_BATCH_CELLS cells;
 *  - the preview bitmap turns one bit into three coordinates: at most MAX_PREVIEW_CELLS set bits
 *    in a box of at most MAX_STRUCTURE_BOX_CELLS.
 *
 * Pure and re-entrant: no module-level mutable state, no scratch objects shared between calls.
 */
import { CHUNK_VOLUME } from '../core/constants';
import type { Axis, Dir } from '../core/dirs';
import type { Quat, Vec3 } from '../core/math';
import type { ItemStack } from '../blocks/items';
import type { Message } from '../sim/view';
import { ByteReader, ByteWriter } from '../save/bytes';
import {
  ENTITY_KINDS,
  HOST_COMMAND_KINDS,
  HOTBAR_SLOTS,
  INVENTORY_AREAS,
  KICK_REASONS,
  MAIN_SLOTS,
  MAX_BATCH_CELLS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_COORD,
  MAX_HELLO_BYTES,
  MAX_PREVIEW_CELLS,
  MAX_RELIABLE_BYTES,
  MAX_STRUCTURE_BOX_CELLS,
  MAX_UNRELIABLE_BYTES,
  MAX_VIEW_RADIUS,
  MESSAGE_CHANNEL,
  MODES,
  MSG,
  PALETTE_LIMIT,
  REFUSE_REASONS,
  SECTION,
  STRUCTURE_KINDS,
  TOAST_KINDS,
  type Cell,
  type CellVolume,
  type ChunkDelta,
  type ChunkSnapshot,
  type ClientMessage,
  type EntityMotion,
  type EntityRecord,
  type EntitySample,
  type EntityUpdate,
  type GeneratorSpec,
  type GlueList,
  type Globals,
  type GluingView,
  type HostCommand,
  type MessageType,
  type MiningView,
  type Mode,
  type NetCorrection,
  type NetInventory,
  type NetMoveReport,
  type NetVitals,
  type PlayerEntry,
  type PlayerFlags,
  type PlayerHeld,
  type PlayerListChange,
  type Pose,
  type PreviewView,
  type PrivateEvent,
  type PrivateState,
  type SamplesMsg,
  type ServerMessage,
  type ShipSample,
  type StructureDelta,
  type StructureRecord,
  type StructureRest,
  type Target,
  type TickBatchMsg,
  type ViewUpdate,
  type WorldEvent,
  type WorldRules,
} from './protocol';
import { RELIABLE, type Channel } from './transport';

/** Malformed, truncated or unexpected protocol data. The connection ends with protocol_error. */
export class ProtocolError extends Error {
  override readonly name: string = 'ProtocolError';
}

// ====================================================================== helpers

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;
const CELL_LIMIT = 0x10000;
/** Largest chunk delta glue value: face (17 bits) + added << 17. */
const CHUNK_GLUE_FACE_LIMIT = 1 << 17;

function bad(what: string, v: unknown): never {
  throw new RangeError(`${what} out of range: ${typeof v === 'number' ? v : `${typeof v} ${String(v)}`}`);
}

function isUint(v: number, max: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= max;
}

/** Bytes of a varuint (any safe integer). */
function varuintSize(v: number): number {
  let n = 1;
  while (v >= 128) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

/** Number of bits needed for the values 0..n (0 for n = 0). */
function bitLength(n: number): number {
  return n === 0 ? 0 : 32 - Math.clz32(n);
}

/** Read an enumeration value (wire value = index + offset). */
function readEnum<T>(r: ByteReader, table: readonly T[], what: string, offset = 0): T {
  const v = r.u8();
  const e = table[v - offset];
  if (e === undefined) r.fail(`unknown ${what} ${v}`);
  return e;
}

function writeEnum<T>(w: ByteWriter, table: readonly T[], value: T, what: string, offset = 0): void {
  const i = table.indexOf(value);
  if (i < 0) bad(what, value);
  w.u8(i + offset);
}

/** Flag bits: only the bits in `allowed` may be set. */
function readFlags(r: ByteReader, allowed: number, what: string): number {
  const f = r.u8();
  if ((f & ~allowed) !== 0) r.fail(`invalid ${what} bits 0x${f.toString(16)}`);
  return f;
}

// ====================================================================== basic types

/** i8: two's complement in a u8; -128 is not used (stick axes are symmetric). */
export function writeI8(w: ByteWriter, v: number): void {
  if (!Number.isInteger(v) || v < -127 || v > 127) bad('i8', v);
  w.u8(v & 0xff);
}
export function readI8(r: ByteReader): number {
  const b = r.u8();
  if (b === 0x80) r.fail('i8 value -128 is not used');
  return b >= 0x80 ? b - 0x100 : b;
}

/** i16: two's complement in a u16; -32768 is not used (Rot64 and pitch are symmetric). */
export function writeI16(w: ByteWriter, v: number): void {
  if (!Number.isInteger(v) || v < -32767 || v > 32767) bad('i16', v);
  w.u16(v & 0xffff);
}
export function readI16(r: ByteReader): number {
  const b = r.u16();
  if (b === 0x8000) r.fail('i16 value -32768 is not used');
  return b >= 0x8000 ? b - 0x10000 : b;
}

/** Cell: varuint. M2.1 stores 16 bits: the encoder asserts v < 2^16, the decoder rejects more (never truncates). */
export function writeCell(w: ByteWriter, v: Cell): void {
  if (!isUint(v, CELL_LIMIT - 1)) bad('cell (M2.1 stores 16 bits)', v);
  w.varuint(v);
}
export function readCell(r: ByteReader): Cell {
  const v = r.varuint();
  if (v >= CELL_LIMIT) r.fail(`cell value ${v} does not fit the 16-bit cells of this build`);
  return v;
}

function writeCoord(w: ByteWriter, v: number): void {
  if (!Number.isInteger(v) || v < -MAX_COORD || v > MAX_COORD) bad('coordinate', v);
  w.varint(v);
}
function readCoord(r: ByteReader): number {
  const v = r.varint();
  if (v < -MAX_COORD || v > MAX_COORD) r.fail(`coordinate ${v} out of range`);
  return v;
}

/** A coordinate given as a delta to `prev` (lists sorted by position). */
function readCoordDelta(r: ByteReader, prev: number): number {
  const d = r.varint();
  const v = prev + d;
  if (!(v >= -MAX_COORD && v <= MAX_COORD)) r.fail(`coordinate ${prev} + ${d} out of range`);
  return v;
}
function writeCoordDelta(w: ByteWriter, v: number, prev: number): void {
  if (!Number.isInteger(v) || v < -MAX_COORD || v > MAX_COORD) bad('coordinate', v);
  w.varint(v - prev);
}

/** Pos32: i32 of round(v * 512), 1/512 block over +-4 194 304. */
export function writePos32(w: ByteWriter, v: number): void {
  const q = Math.round(v * 512);
  if (!(q >= -0x80000000 && q <= 0x7fffffff)) bad('Pos32', v);
  w.i32(q);
}
export function readPos32(r: ByteReader): number {
  return r.i32() / 512;
}

function writePos32x3(w: ByteWriter, p: Vec3): void {
  writePos32(w, p.x);
  writePos32(w, p.y);
  writePos32(w, p.z);
}
function readPos32x3(r: ByteReader): Vec3 {
  const x = readPos32(r);
  const y = readPos32(r);
  const z = readPos32(r);
  return { x, y, z };
}

/** Round half away from zero (symmetric: q and -q quantise to opposite values). */
function roundSym(v: number): number {
  const a = Math.round(Math.abs(v));
  return v < 0 ? -a : a;
}

/** Rot64: 4 x i16 of round(q * 32767); read back normalised. */
export function writeRot64(w: ByteWriter, q: Quat): void {
  for (const c of [q.x, q.y, q.z, q.w]) {
    if (!(c >= -1.0001 && c <= 1.0001)) bad('Rot64 component', c);
    writeI16(w, Math.max(-32767, Math.min(32767, roundSym(c * 32767))));
  }
}
export function readRot64(r: ByteReader): Quat {
  const x = readI16(r);
  const y = readI16(r);
  const z = readI16(r);
  const q = readI16(r);
  const len = Math.sqrt(x * x + y * y + z * z + q * q);
  if (len === 0) r.fail('zero rotation');
  return { x: x / len, y: y / len, z: z / len, w: q / len };
}

/** Ang16: u16 of angle / 2pi * 65536, modulo a turn; read back in [0, 2pi). */
export function writeAng16(w: ByteWriter, a: number): void {
  if (!Number.isFinite(a)) bad('Ang16', a);
  const k = Math.round((a / TWO_PI) * 65536) % 65536;
  w.u16(k < 0 ? k + 65536 : k);
}
export function readAng16(r: ByteReader): number {
  return (r.u16() / 65536) * TWO_PI;
}

/** A pitch as i16 of pitch / (pi/2) * 32767 (clamped to +-pi/2). */
export function writePitch16(w: ByteWriter, p: number): void {
  if (!Number.isFinite(p)) bad('pitch', p);
  writeI16(w, Math.max(-32767, Math.min(32767, roundSym((p / HALF_PI) * 32767))));
}
export function readPitch16(r: ByteReader): number {
  return (readI16(r) / 32767) * HALF_PI;
}

/** Pose: Pos32 x 3 + Rot64 (20 bytes). */
export function writePose(w: ByteWriter, p: Pose): void {
  writePos32x3(w, p.pos);
  writeRot64(w, p.rot);
}
export function readPose(r: ByteReader): Pose {
  const pos = readPos32x3(r);
  const rot = readRot64(r);
  return { pos, rot };
}

function writeF64x3(w: ByteWriter, v: Vec3): void {
  w.f64(v.x).f64(v.y).f64(v.z);
}
function readF64x3(r: ByteReader): Vec3 {
  const x = r.f64();
  const y = r.f64();
  const z = r.f64();
  return { x, y, z };
}
function writeF32x3(w: ByteWriter, v: Vec3): void {
  w.f32(v.x).f32(v.y).f32(v.z);
}
function readF32x3(r: ByteReader): Vec3 {
  const x = r.f32();
  const y = r.f32();
  const z = r.f32();
  return { x, y, z };
}
function writeQuatF64(w: ByteWriter, q: Quat): void {
  w.f64(q.x).f64(q.y).f64(q.z).f64(q.w);
}
function readQuatF64(r: ByteReader): Quat {
  const x = r.f64();
  const y = r.f64();
  const z = r.f64();
  const q = r.f64();
  return { x, y, z, w: q };
}

function writeDir(w: ByteWriter, d: Dir, what: string): void {
  if (!isUint(d, 5)) bad(what, d);
  w.u8(d);
}
function readDir(r: ByteReader, what: string): Dir {
  const d = r.u8();
  if (d > 5) r.fail(`invalid ${what} ${d}`);
  return d as Dir;
}

function writeAxis(w: ByteWriter, a: Axis): void {
  if (!isUint(a, 2)) bad('axis', a);
  w.u8(a);
}
function readAxis(r: ByteReader): Axis {
  const a = r.u8();
  if (a > 2) r.fail(`invalid axis ${a}`);
  return a as Axis;
}

/** A 0..1 fraction as a u8 (steps of 1/255). */
function writeProgress(w: ByteWriter, p: number): void {
  if (!(p >= 0 && p <= 1)) bad('progress', p);
  w.u8(Math.round(p * 255));
}
function readProgress(r: ByteReader): number {
  return r.u8() / 255;
}

function writeSlot(w: ByteWriter, slot: number): void {
  if (!isUint(slot, HOTBAR_SLOTS - 1)) bad('hotbar slot', slot);
  w.u8(slot);
}
function readSlot(r: ByteReader): number {
  const s = r.u8();
  if (s >= HOTBAR_SLOTS) r.fail(`hotbar slot ${s} out of range`);
  return s;
}

function writeMode(w: ByteWriter, m: Mode): void {
  writeEnum(w, MODES, m, 'game mode');
}
function readMode(r: ByteReader): Mode {
  return readEnum(r, MODES, 'game mode');
}

/** Target: vu gridId, vi x, vi y, vi z, u8 face, u8 sub, Cell cell. */
export function writeTarget(w: ByteWriter, t: Target): void {
  w.varuint(t.gridId);
  writeCoord(w, t.x);
  writeCoord(w, t.y);
  writeCoord(w, t.z);
  writeDir(w, t.face, 'face');
  w.u8(t.sub);
  writeCell(w, t.cell);
}
export function readTarget(r: ByteReader): Target {
  const gridId = r.varuint();
  const x = readCoord(r);
  const y = readCoord(r);
  const z = readCoord(r);
  const face = readDir(r, 'face');
  const sub = r.u8();
  const cell = readCell(r);
  return { gridId, x, y, z, face, sub, cell };
}

/** OptTarget: u8 present + Target. */
export function writeOptTarget(w: ByteWriter, t: Target | null): void {
  w.bool(t !== null);
  if (t !== null) writeTarget(w, t);
}
export function readOptTarget(r: ByteReader): Target | null {
  return r.bool() ? readTarget(r) : null;
}

function targetsEqual(a: Target | null, b: Target | null): boolean {
  if (a === null || b === null) return a === b;
  return a.gridId === b.gridId && a.x === b.x && a.y === b.y && a.z === b.z && a.face === b.face && a.sub === b.sub && a.cell === b.cell;
}

/** Stack: vu (item + 1, 0 = empty), then vu count (>= 1) when not empty. */
export function writeStack(w: ByteWriter, s: ItemStack | null): void {
  if (s === null) {
    w.varuint(0);
    return;
  }
  if (!Number.isSafeInteger(s.item + 1) || s.item < 0) bad('item', s.item);
  if (!Number.isSafeInteger(s.count) || s.count < 1) bad('stack count', s.count);
  w.varuint(s.item + 1).varuint(s.count);
}
export function readStack(r: ByteReader): ItemStack | null {
  const v = r.varuint();
  if (v === 0) return null;
  const count = r.varuint();
  if (count < 1) r.fail('empty stack in a slot');
  return { item: v - 1, count };
}

/** Optional item id as vu (item + 1, 0 = none). */
function writeOptItem(w: ByteWriter, item: number | null): void {
  if (item === null) w.varuint(0);
  else if (!Number.isSafeInteger(item + 1) || item < 0) bad('item', item);
  else w.varuint(item + 1);
}
function readOptItem(r: ByteReader): number | null {
  const v = r.varuint();
  return v === 0 ? null : v - 1;
}

/** Message: str key, vu n, n x (str name, u8 tag: 0 number + f64, 1 text + str). */
export function writeMessage(w: ByteWriter, m: Message): void {
  w.string(m.key);
  const params = m.params;
  const names = params === undefined ? [] : Object.keys(params);
  w.varuint(names.length);
  for (const name of names) {
    const v = params![name];
    w.string(name);
    if (typeof v === 'number') w.u8(0).f64(v);
    else if (typeof v === 'string') w.u8(1).string(v);
    else bad(`message parameter ${name}`, v);
  }
}
export function readMessage(r: ByteReader): Message {
  const key = r.string();
  const n = r.count(3);
  if (n === 0) return { key };
  const params: Record<string, number | string> = {};
  for (let i = 0; i < n; i++) {
    const name = r.string();
    const tag = r.u8();
    let value: number | string;
    if (tag === 0) value = r.f64();
    else if (tag === 1) value = r.string();
    else return r.fail(`unknown message parameter tag ${tag}`);
    if (Object.prototype.hasOwnProperty.call(params, name)) r.fail(`duplicate message parameter "${name}"`);
    // defineProperty: a name such as "__proto__" must become a plain own property.
    Object.defineProperty(params, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return { key, params };
}

// ====================================================================== CellVolume

const VOLUME_PALETTE = 0;
const VOLUME_RAW = 1;

/**
 * CellVolume(n), n = cells.length known to both ends: u8 enc; 0 = palette run-length: vu P
 * (1..n), P x Cell (first-appearance order), then vu tokens until n cells are covered,
 * token = (len - 1) * 2^B + index, B = bit length of P - 1; 1 = raw: n x Cell. The encoder takes
 * whichever is smaller (raw on a tie, and always raw above PALETTE_LIMIT distinct values): the
 * save codec's algorithm (save/codec.ts encodeChunk) with Cell palette entries and no envelope.
 */
export function writeCellVolume(w: ByteWriter, cells: CellVolume): void {
  const n = cells.length;
  if (n < 1) bad('CellVolume length', n);
  const paletteIndex = new Map<number, number>();
  const palette: number[] = [];
  const runIndex: number[] = [];
  const runLength: number[] = [];
  let prev = cells[0]!;
  let prevIndex = 0;
  paletteIndex.set(prev, 0);
  palette.push(prev);
  let start = 0;
  let rawBytes = 0;
  let rle = true;
  for (let i = 0; i < n; i++) {
    const v = cells[i]!;
    rawBytes += v < 0x80 ? 1 : v < 0x4000 ? 2 : 3;
    if (v === prev || !rle) continue;
    runIndex.push(prevIndex);
    runLength.push(i - start);
    start = i;
    prev = v;
    let index = paletteIndex.get(v);
    if (index === undefined) {
      index = palette.length;
      if (index >= PALETTE_LIMIT) {
        rle = false; // keep counting rawBytes
        continue;
      }
      paletteIndex.set(v, index);
      palette.push(v);
    }
    prevIndex = index;
  }
  let rleBytes = Infinity;
  if (rle) {
    runIndex.push(prevIndex);
    runLength.push(n - start);
    const scale = 2 ** bitLength(palette.length - 1);
    rleBytes = varuintSize(palette.length);
    for (let k = 0; k < palette.length; k++) rleBytes += varuintSize(palette[k]!);
    for (let k = 0; k < runIndex.length; k++) rleBytes += varuintSize((runLength[k]! - 1) * scale + runIndex[k]!);
  }
  if (rleBytes < rawBytes) {
    const scale = 2 ** bitLength(palette.length - 1);
    w.u8(VOLUME_PALETTE).varuint(palette.length);
    for (let k = 0; k < palette.length; k++) w.varuint(palette[k]!);
    for (let k = 0; k < runIndex.length; k++) w.varuint((runLength[k]! - 1) * scale + runIndex[k]!);
  } else {
    w.u8(VOLUME_RAW);
    for (let i = 0; i < n; i++) w.varuint(cells[i]!);
  }
}

/** Cells left to decode in one message (see the file comment, BOUNDED DECODING). */
export interface CellBudget {
  cells: number;
}

/** Inverse of writeCellVolume for a volume of `n` cells; charges `n` to the budget first. */
export function readCellVolume(r: ByteReader, n: number, budget: CellBudget): CellVolume {
  if (!(n >= 1 && n <= budget.cells)) r.fail(`cell volume of ${n} cells exceeds what one message may carry (${budget.cells} left)`);
  budget.cells -= n;
  const enc = r.u8();
  if (enc === VOLUME_PALETTE) {
    const p = r.count(1);
    if (p < 1 || p > n || p > PALETTE_LIMIT) r.fail(`invalid palette size ${p}`);
    const palette = new Uint16Array(p);
    for (let k = 0; k < p; k++) palette[k] = readCell(r);
    const scale = 2 ** bitLength(p - 1);
    const out = new Uint16Array(n);
    let filled = 0;
    while (filled < n) {
      const token = r.varuint();
      const index = token % scale;
      const len = Math.floor(token / scale) + 1;
      if (index >= p) r.fail(`palette index ${index} out of range (palette has ${p})`);
      if (len > n - filled) r.fail(`run of ${len} cells overflows the volume (${filled} of ${n} filled)`);
      const v = palette[index]!;
      if (v !== 0) out.fill(v, filled, filled + len);
      filled += len;
    }
    return out;
  }
  if (enc === VOLUME_RAW) {
    if (n > r.remaining) r.fail(`raw cell volume of ${n} cells exceeds the ${r.remaining} remaining bytes`);
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = readCell(r);
    return out;
  }
  return r.fail(`unknown cell volume encoding ${enc}`);
}

/** A CellVolume on its own (sizes, tests). */
export function encodeCellVolume(cells: CellVolume): Uint8Array {
  const w = new ByteWriter(64 + (cells.length >> 3));
  writeCellVolume(w, cells);
  return w.finish();
}
/** Inverse of encodeCellVolume. Throws ProtocolError. */
export function decodeCellVolume(bytes: Uint8Array, n: number): CellVolume {
  return decoding(bytes, 'cell volume', (r) => readCellVolume(r, n, { cells: MAX_BATCH_CELLS }));
}

// ====================================================================== GlueList

/** GlueList: vu n, each face vi dx, vi dy, vi dz (to the previous face, from 0,0,0), u8 axis. */
export function writeGlueList(w: ByteWriter, glue: GlueList): void {
  if (glue.length % 4 !== 0) bad('glue list length', glue.length);
  const n = glue.length / 4;
  w.varuint(n);
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = 0; i < glue.length; i += 4) {
    const x = glue[i]!;
    const y = glue[i + 1]!;
    const z = glue[i + 2]!;
    writeCoordDelta(w, x, px);
    writeCoordDelta(w, y, py);
    writeCoordDelta(w, z, pz);
    writeAxis(w, glue[i + 3]! as Axis);
    px = x;
    py = y;
    pz = z;
  }
}
export function readGlueList(r: ByteReader): GlueList {
  const n = r.count(4);
  const out = new Int32Array(n * 4);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n * 4; i += 4) {
    x = readCoordDelta(r, x);
    y = readCoordDelta(r, y);
    z = readCoordDelta(r, z);
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
    out[i + 3] = readAxis(r);
  }
  return out;
}

// ====================================================================== GeneratorSpec

/** u8 kind: 0 terrain u32 seed; 1 flat u32 seed, vu n, n x (vu cell, vu thickness); 2 void u32 seed. */
export function writeGeneratorSpec(w: ByteWriter, g: GeneratorSpec): void {
  if (g.kind === 'terrain') w.u8(0).u32(g.seed);
  else if (g.kind === 'flat') {
    w.u8(1).u32(g.seed).varuint(g.layers.length);
    for (const l of g.layers) {
      writeCell(w, l.cell);
      w.varuint(l.thickness);
    }
  } else if (g.kind === 'void') w.u8(2).u32(g.seed);
  else bad('generator kind', (g as { kind: unknown }).kind);
}
export function readGeneratorSpec(r: ByteReader): GeneratorSpec {
  const kind = r.u8();
  if (kind === 0) return { kind: 'terrain', seed: r.u32() };
  if (kind === 1) {
    const seed = r.u32();
    const n = r.count(2);
    const layers: Array<{ cell: Cell; thickness: number }> = [];
    for (let i = 0; i < n; i++) {
      const cell = readCell(r);
      const thickness = r.varuint();
      layers.push({ cell, thickness });
    }
    return { kind: 'flat', seed, layers };
  }
  if (kind === 2) return { kind: 'void', seed: r.u32() };
  return r.fail(`unknown generator kind ${kind}`);
}

// ====================================================================== client -> server

const REPORT_ON_GROUND = 1;
const REPORT_SNEAKING = 2;
const REPORT_SPRINTING = 4;
const REPORT_FLYING = 8;
const REPORT_SNEAK_KEY = 16;

function writeAxisI8(w: ByteWriter, v: number, what: string): void {
  if (!Number.isFinite(v)) bad(what, v);
  writeI8(w, Math.round(Math.max(-1, Math.min(1, v)) * 127));
}

function writeMoveReport(w: ByteWriter, m: NetMoveReport): void {
  w.varuint(m.seq).varuint(m.epoch).varuint(m.viewTick).varuint(m.carrierId);
  writeF64x3(w, m.pos);
  writeF32x3(w, m.vel);
  w.f32(m.yaw).f32(m.pitch);
  w.u8(
    (m.onGround ? REPORT_ON_GROUND : 0) |
      (m.sneaking ? REPORT_SNEAKING : 0) |
      (m.sprinting ? REPORT_SPRINTING : 0) |
      (m.flying ? REPORT_FLYING : 0) |
      (m.sneak ? REPORT_SNEAK_KEY : 0),
  );
  writeAxisI8(w, m.forward, 'forward axis');
  writeAxisI8(w, m.strafe, 'strafe axis');
  w.u8(m.landings);
}
function readMoveReport(r: ByteReader): NetMoveReport {
  const seq = r.varuint();
  const epoch = r.varuint();
  const viewTick = r.varuint();
  const carrierId = r.varuint();
  const pos = readF64x3(r);
  const vel = readF32x3(r);
  const yaw = r.f32();
  const pitch = r.f32();
  const f = readFlags(r, 0x1f, 'movement report flag');
  const forward = readI8(r) / 127;
  const strafe = readI8(r) / 127;
  const landings = r.u8();
  return {
    seq,
    epoch,
    viewTick,
    carrierId,
    pos,
    vel,
    yaw,
    pitch,
    onGround: (f & REPORT_ON_GROUND) !== 0,
    sneaking: (f & REPORT_SNEAKING) !== 0,
    sprinting: (f & REPORT_SPRINTING) !== 0,
    flying: (f & REPORT_FLYING) !== 0,
    forward,
    strafe,
    sneak: (f & REPORT_SNEAK_KEY) !== 0,
    landings,
  };
}

function writeHostCommand(w: ByteWriter, c: HostCommand): void {
  writeEnum(w, HOST_COMMAND_KINDS, c.kind, 'host command');
  switch (c.kind) {
    case 'setRules':
      writeMode(w, c.rules.defaultMode);
      w.bool(c.rules.dropsEnabled);
      break;
    case 'setPlayerMode':
      w.varuint(c.entityId);
      writeMode(w, c.mode);
      break;
    case 'setDayTime':
      w.f32(c.t);
      break;
    case 'teleport':
      w.f64(c.x).f64(c.y).f64(c.z);
      break;
    case 'give':
      w.varuint(c.item).varuint(c.count);
      break;
    case 'kick':
      w.varuint(c.entityId);
      break;
  }
}
function readHostCommand(r: ByteReader): HostCommand {
  const kind = readEnum(r, HOST_COMMAND_KINDS, 'host command');
  switch (kind) {
    case 'setRules': {
      const defaultMode = readMode(r);
      return { kind, rules: { defaultMode, dropsEnabled: r.bool() } };
    }
    case 'setPlayerMode': {
      const entityId = r.varuint();
      return { kind, entityId, mode: readMode(r) };
    }
    case 'setDayTime':
      return { kind, t: r.f32() };
    case 'teleport': {
      const x = r.f64();
      const y = r.f64();
      return { kind, x, y, z: r.f64() };
    }
    case 'give': {
      const item = r.varuint();
      return { kind, item, count: r.varuint() };
    }
    case 'kick':
      return { kind, entityId: r.varuint() };
  }
}

function writeClientPayload(w: ByteWriter, m: ClientMessage): void {
  switch (m.type) {
    case 'hello':
      if (!isUint(m.viewRadius, MAX_VIEW_RADIUS)) bad('view radius', m.viewRadius);
      w.string(m.build).string(m.playerKey).string(m.name).u8(m.viewRadius);
      return;
    case 'bye':
      return;
    case 'ping':
      w.u32(m.clientMs);
      return;
    case 'moveReport':
      writeMoveReport(w, m);
      return;
    case 'aim': {
      w.varuint(m.seq).varuint(m.moveSeq);
      writeOptTarget(w, m.use);
      const same = targetsEqual(m.use, m.mine);
      w.bool(same);
      if (!same) writeOptTarget(w, m.mine);
      return;
    }
    case 'use':
      w.varuint(m.seq).varuint(m.moveSeq);
      writeSlot(w, m.slot);
      w.u8(m.sneak ? 1 : 0);
      writeOptTarget(w, m.target);
      return;
    case 'attack':
      w.varuint(m.seq).varuint(m.moveSeq);
      writeSlot(w, m.slot);
      writeOptTarget(w, m.target);
      return;
    case 'selectSlot':
      w.varuint(m.seq);
      writeSlot(w, m.slot);
      return;
    case 'pickBlock':
      w.varuint(m.seq).varuint(m.moveSeq);
      writeTarget(w, m.target);
      return;
    case 'invClick':
      w.varuint(m.seq);
      writeEnum(w, INVENTORY_AREAS, m.area, 'inventory area');
      w.u8(m.index);
      if (m.button !== 0 && m.button !== 2) bad('mouse button', m.button);
      w.u8(m.button).bool(m.shift);
      return;
    case 'creativePick':
      w.varuint(m.seq).varuint(m.item).bool(m.shift);
      return;
    case 'setViewRadius':
      if (!isUint(m.radius, MAX_VIEW_RADIUS)) bad('view radius', m.radius);
      w.varuint(m.seq).u8(m.radius);
      return;
    case 'hostCommand':
      w.varuint(m.seq);
      writeHostCommand(w, m.command);
      return;
    case 'useRelease':
    case 'attackRelease':
    case 'swapHands':
    case 'dropCursor':
    case 'closeInventory':
    case 'releaseHelm':
    case 'respawn':
      w.varuint(m.seq);
      return;
  }
}

function readClientPayload(r: ByteReader, id: number): ClientMessage {
  switch (id) {
    case MSG.hello: {
      const build = r.string();
      const playerKey = r.string();
      const name = r.string();
      const viewRadius = r.u8();
      if (viewRadius > MAX_VIEW_RADIUS) r.fail(`view radius ${viewRadius} above ${MAX_VIEW_RADIUS}`);
      return { type: 'hello', build, playerKey, name, viewRadius };
    }
    case MSG.bye:
      return { type: 'bye' };
    case MSG.ping:
      return { type: 'ping', clientMs: r.u32() };
    case MSG.moveReport:
      return { type: 'moveReport', ...readMoveReport(r) };
    case MSG.aim: {
      const seq = r.varuint();
      const moveSeq = r.varuint();
      const use = readOptTarget(r);
      const same = r.bool();
      const mine = same ? (use === null ? null : { ...use }) : readOptTarget(r);
      if (!same && targetsEqual(use, mine)) r.fail('aim repeats the use target instead of flagging it');
      return { type: 'aim', seq, moveSeq, use, mine };
    }
    case MSG.use: {
      const seq = r.varuint();
      const moveSeq = r.varuint();
      const slot = readSlot(r);
      const sneak = (readFlags(r, 1, 'use flag') & 1) !== 0;
      return { type: 'use', seq, moveSeq, slot, sneak, target: readOptTarget(r) };
    }
    case MSG.attack: {
      const seq = r.varuint();
      const moveSeq = r.varuint();
      const slot = readSlot(r);
      return { type: 'attack', seq, moveSeq, slot, target: readOptTarget(r) };
    }
    case MSG.selectSlot: {
      const seq = r.varuint();
      return { type: 'selectSlot', seq, slot: readSlot(r) };
    }
    case MSG.pickBlock: {
      const seq = r.varuint();
      const moveSeq = r.varuint();
      return { type: 'pickBlock', seq, moveSeq, target: readTarget(r) };
    }
    case MSG.invClick: {
      const seq = r.varuint();
      const area = readEnum(r, INVENTORY_AREAS, 'inventory area');
      const index = r.u8();
      const button = r.u8();
      if (button !== 0 && button !== 2) r.fail(`unknown mouse button ${button}`);
      return { type: 'invClick', seq, area, index, button, shift: r.bool() };
    }
    case MSG.creativePick: {
      const seq = r.varuint();
      const item = r.varuint();
      return { type: 'creativePick', seq, item, shift: r.bool() };
    }
    case MSG.setViewRadius: {
      const seq = r.varuint();
      const radius = r.u8();
      if (radius > MAX_VIEW_RADIUS) r.fail(`view radius ${radius} above ${MAX_VIEW_RADIUS}`);
      return { type: 'setViewRadius', seq, radius };
    }
    case MSG.hostCommand: {
      const seq = r.varuint();
      return { type: 'hostCommand', seq, command: readHostCommand(r) };
    }
    case MSG.useRelease:
      return { type: 'useRelease', seq: r.varuint() };
    case MSG.attackRelease:
      return { type: 'attackRelease', seq: r.varuint() };
    case MSG.swapHands:
      return { type: 'swapHands', seq: r.varuint() };
    case MSG.dropCursor:
      return { type: 'dropCursor', seq: r.varuint() };
    case MSG.closeInventory:
      return { type: 'closeInventory', seq: r.varuint() };
    case MSG.releaseHelm:
      return { type: 'releaseHelm', seq: r.varuint() };
    case MSG.respawn:
      return { type: 'respawn', seq: r.varuint() };
    default:
      return r.fail(`unknown client message id 0x${id.toString(16)}`);
  }
}

// ====================================================================== records

function writeFlagsPlayer(w: ByteWriter, f: PlayerFlags): void {
  w.u8((f.sneaking ? 1 : 0) | (f.sprinting ? 2 : 0) | (f.flying ? 4 : 0) | (f.dead ? 8 : 0) | (f.onGround ? 16 : 0));
}
function readFlagsPlayer(r: ByteReader): PlayerFlags {
  const f = readFlags(r, 0x1f, 'player flag');
  return { sneaking: (f & 1) !== 0, sprinting: (f & 2) !== 0, flying: (f & 4) !== 0, dead: (f & 8) !== 0, onGround: (f & 16) !== 0 };
}

function writeEntityKind(w: ByteWriter, k: EntityRecord['kind']): void {
  writeEnum(w, ENTITY_KINDS, k, 'entity kind', 1);
}
function readEntityKind(r: ByteReader): EntityRecord['kind'] {
  return readEnum(r, ENTITY_KINDS, 'entity kind', 1);
}

/** EntitySample without the id: u8 kind, vu carrierId, Pos32 x 3, Ang16 yaw, players: i16 pitch, u8 flags. */
function writeEntityMotion(w: ByteWriter, m: EntityMotion): void {
  writeEntityKind(w, m.kind);
  w.varuint(m.carrierId);
  writePos32x3(w, m.pos);
  writeAng16(w, m.yaw);
  if ((m.kind === 'player') !== (m.look !== null)) bad('entity look (present exactly for players)', m.kind);
  if (m.look !== null) {
    writePitch16(w, m.look.pitch);
    writeFlagsPlayer(w, m.look.flags);
  }
}
function readEntityMotion(r: ByteReader): EntityMotion {
  const kind = readEntityKind(r);
  const carrierId = r.varuint();
  const pos = readPos32x3(r);
  const yaw = readAng16(r);
  let look: EntityMotion['look'] = null;
  if (kind === 'player') {
    const pitch = readPitch16(r);
    look = { pitch, flags: readFlagsPlayer(r) };
  }
  return { kind, carrierId, pos, yaw, look };
}

function writeEntitySample(w: ByteWriter, s: EntitySample): void {
  w.varuint(s.id);
  writeEntityMotion(w, s);
}
function readEntitySample(r: ByteReader): EntitySample {
  const id = r.varuint();
  return { id, ...readEntityMotion(r) };
}

function writePlayerHeld(w: ByteWriter, p: PlayerHeld): void {
  writeFlagsPlayer(w, p.flags);
  w.varuint(p.steeringShipId);
  writeOptItem(w, p.heldItem);
}
function readPlayerHeld(r: ByteReader): PlayerHeld {
  const flags = readFlagsPlayer(r);
  const steeringShipId = r.varuint();
  return { flags, steeringShipId, heldItem: readOptItem(r) };
}

function writeEntityRecord(w: ByteWriter, e: EntityRecord): void {
  w.varuint(e.id);
  writeEntityKind(w, e.kind);
  w.varuint(e.carrierId);
  writePos32x3(w, e.pos);
  writeAng16(w, e.yaw);
  switch (e.kind) {
    case 'player':
      writePitch16(w, e.pitch);
      writePlayerHeld(w, e);
      break;
    case 'item':
      w.varuint(e.item).varuint(e.count);
      break;
    case 'falling':
      writeCell(w, e.cell);
      break;
    case 'tnt':
      w.varuint(e.fuse);
      break;
    case 'rabbit':
      break;
  }
}
function readEntityRecord(r: ByteReader): EntityRecord {
  const id = r.varuint();
  const kind = readEntityKind(r);
  const carrierId = r.varuint();
  const pos = readPos32x3(r);
  const yaw = readAng16(r);
  switch (kind) {
    case 'player': {
      const pitch = readPitch16(r);
      return { id, kind, carrierId, pos, yaw, pitch, ...readPlayerHeld(r) };
    }
    case 'item': {
      const item = r.varuint();
      return { id, kind, carrierId, pos, yaw, item, count: r.varuint() };
    }
    case 'falling':
      return { id, kind, carrierId, pos, yaw, cell: readCell(r) };
    case 'tnt':
      return { id, kind, carrierId, pos, yaw, fuse: r.varuint() };
    case 'rabbit':
      return { id, kind, carrierId, pos, yaw };
  }
}

function writeEntityUpdate(w: ByteWriter, u: EntityUpdate): void {
  w.varuint(u.id);
  w.u8((u.final !== undefined ? 1 : 0) | (u.stack !== undefined ? 2 : 0) | (u.fuse !== undefined ? 4 : 0) | (u.player !== undefined ? 8 : 0));
  if (u.final !== undefined) writeEntityMotion(w, u.final);
  if (u.stack !== undefined) w.varuint(u.stack.item).varuint(u.stack.count);
  if (u.fuse !== undefined) w.varuint(u.fuse);
  if (u.player !== undefined) writePlayerHeld(w, u.player);
}
function readEntityUpdate(r: ByteReader): EntityUpdate {
  const id = r.varuint();
  const mask = readFlags(r, 0x0f, 'entity update');
  const u: EntityUpdate = { id };
  if (mask & 1) u.final = readEntityMotion(r);
  if (mask & 2) {
    const item = r.varuint();
    u.stack = { item, count: r.varuint() };
  }
  if (mask & 4) u.fuse = r.varuint();
  if (mask & 8) u.player = readPlayerHeld(r);
  return u;
}

/** Volume of a structure or preview box (each side and the product within MAX_STRUCTURE_BOX_CELLS), or -1. */
function boxVolume(sx: number, sy: number, sz: number): number {
  const lim = MAX_STRUCTURE_BOX_CELLS;
  if (!(sx <= lim && sy <= lim && sz <= lim)) return -1;
  const v = sx * sy * sz; // inexact above 2^53, but then far above the bound anyway
  return v <= lim ? v : -1;
}

function writeStructureRecord(w: ByteWriter, s: StructureRecord, budget: CellBudget): void {
  writeEnum(w, STRUCTURE_KINDS, s.kind, 'structure kind');
  w.varuint(s.id).varuint(s.parentId);
  const empty = s.sx === 0 || s.sy === 0 || s.sz === 0;
  if (empty) {
    if (s.sx !== 0 || s.sy !== 0 || s.sz !== 0 || s.minX !== 0 || s.minY !== 0 || s.minZ !== 0 || s.cells.length !== 0) {
      bad('empty structure box (all of minX..sz must be 0)', s.id);
    }
  }
  writeCoord(w, s.minX);
  writeCoord(w, s.minY);
  writeCoord(w, s.minZ);
  w.varuint(s.sx).varuint(s.sy).varuint(s.sz);
  if (!empty) {
    const volume = boxVolume(s.sx, s.sy, s.sz);
    if (volume < 0) bad('structure box volume', s.sx * s.sy * s.sz);
    if (s.cells.length !== volume) bad('structure cell count (must be sx * sy * sz)', s.cells.length);
    if (volume > budget.cells) bad('cells in one TickBatch (MAX_BATCH_CELLS)', volume);
    budget.cells -= volume;
    writeCellVolume(w, s.cells);
  }
  writeF64x3(w, s.pivot);
  writeF64x3(w, s.position);
  writeQuatF64(w, s.rotation);
  writeGlueList(w, s.glue);
  if (s.kind === 'rotor') {
    writeCoord(w, s.bearing.x);
    writeCoord(w, s.bearing.y);
    writeCoord(w, s.bearing.z);
    writeDir(w, s.axis, 'rotor axis');
    writeQuatF64(w, s.baseRotation);
    w.f64(s.angle).f64(s.angularSpeed).varuint(s.sails).bool(s.frozen);
  } else {
    writeCoord(w, s.helm.x);
    writeCoord(w, s.helm.y);
    writeCoord(w, s.helm.z);
    writeDir(w, s.forward, 'ship forward');
    w.f32(s.throttle).f32(s.rudder).varuint(s.helmsmanId);
  }
}

function readCoord3(r: ByteReader): Vec3 {
  const x = readCoord(r);
  const y = readCoord(r);
  const z = readCoord(r);
  return { x, y, z };
}

function readStructureRecord(r: ByteReader, budget: CellBudget): StructureRecord {
  const kind = readEnum(r, STRUCTURE_KINDS, 'structure kind');
  const id = r.varuint();
  const parentId = r.varuint();
  const minX = readCoord(r);
  const minY = readCoord(r);
  const minZ = readCoord(r);
  const sx = r.varuint();
  const sy = r.varuint();
  const sz = r.varuint();
  let cells: CellVolume;
  if (sx === 0 || sy === 0 || sz === 0) {
    if (sx !== 0 || sy !== 0 || sz !== 0 || minX !== 0 || minY !== 0 || minZ !== 0) r.fail('an empty structure box must be all zero');
    cells = new Uint16Array(0);
  } else {
    const volume = boxVolume(sx, sy, sz);
    if (volume < 0) r.fail(`structure box ${sx} x ${sy} x ${sz} is too large`);
    cells = readCellVolume(r, volume, budget);
  }
  const pivot = readF64x3(r);
  const position = readF64x3(r);
  const rotation = readQuatF64(r);
  const glue = readGlueList(r);
  const base = { id, parentId, minX, minY, minZ, sx, sy, sz, cells, pivot, position, rotation, glue };
  if (kind === 'rotor') {
    const bearing = readCoord3(r);
    const axis = readDir(r, 'rotor axis');
    const baseRotation = readQuatF64(r);
    const angle = r.f64();
    const angularSpeed = r.f64();
    const sails = r.varuint();
    return { kind, ...base, bearing, axis, baseRotation, angle, angularSpeed, sails, frozen: r.bool() };
  }
  const helm = readCoord3(r);
  const forward = readDir(r, 'ship forward');
  const throttle = r.f32();
  const rudder = r.f32();
  return { kind, ...base, helm, forward, throttle, rudder, helmsmanId: r.varuint() };
}

function writeStructureDelta(w: ByteWriter, d: StructureDelta): void {
  w.varuint(d.id);
  w.u8(
    (d.cells !== undefined ? 1 : 0) |
      (d.glue !== undefined ? 2 : 0) |
      (d.pivot !== undefined ? 4 : 0) |
      (d.helm !== undefined ? 8 : 0) |
      (d.control !== undefined ? 16 : 0) |
      (d.rotor !== undefined ? 32 : 0),
  );
  if (d.cells !== undefined) {
    w.varuint(d.cells.length);
    let px = 0;
    let py = 0;
    let pz = 0;
    for (const [x, y, z, cell] of d.cells) {
      writeCoordDelta(w, x, px);
      writeCoordDelta(w, y, py);
      writeCoordDelta(w, z, pz);
      writeCell(w, cell);
      px = x;
      py = y;
      pz = z;
    }
  }
  if (d.glue !== undefined) {
    w.varuint(d.glue.length);
    let px = 0;
    let py = 0;
    let pz = 0;
    for (const [x, y, z, axis, added] of d.glue) {
      writeCoordDelta(w, x, px);
      writeCoordDelta(w, y, py);
      writeCoordDelta(w, z, pz);
      if (!isUint(axis, 2)) bad('axis', axis);
      w.u8(axis + (added ? 4 : 0));
      px = x;
      py = y;
      pz = z;
    }
  }
  if (d.pivot !== undefined) writeF64x3(w, d.pivot);
  if (d.helm !== undefined) {
    writeCoord(w, d.helm.x);
    writeCoord(w, d.helm.y);
    writeCoord(w, d.helm.z);
    writeDir(w, d.helm.forward, 'ship forward');
    w.varuint(d.helm.helmsmanId);
  }
  if (d.control !== undefined) w.f32(d.control.throttle).f32(d.control.rudder);
  if (d.rotor !== undefined) w.f64(d.rotor.angle).f64(d.rotor.angularSpeed).varuint(d.rotor.sails).bool(d.rotor.frozen);
}
function readStructureDelta(r: ByteReader): StructureDelta {
  const id = r.varuint();
  const mask = readFlags(r, 0x3f, 'structure delta');
  const d: StructureDelta = { id };
  if (mask & 1) {
    const n = r.count(4);
    const cells: Array<[number, number, number, Cell]> = [];
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < n; i++) {
      x = readCoordDelta(r, x);
      y = readCoordDelta(r, y);
      z = readCoordDelta(r, z);
      cells.push([x, y, z, readCell(r)]);
    }
    d.cells = cells;
  }
  if (mask & 2) {
    const n = r.count(4);
    const glue: Array<[number, number, number, Axis, boolean]> = [];
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < n; i++) {
      x = readCoordDelta(r, x);
      y = readCoordDelta(r, y);
      z = readCoordDelta(r, z);
      const b = r.u8();
      const axis = b & 3;
      if (axis > 2 || b > 6) r.fail(`invalid glue change byte ${b}`);
      glue.push([x, y, z, axis as Axis, b >= 4]);
    }
    d.glue = glue;
  }
  if (mask & 4) d.pivot = readF64x3(r);
  if (mask & 8) {
    const x = readCoord(r);
    const y = readCoord(r);
    const z = readCoord(r);
    const forward = readDir(r, 'ship forward');
    d.helm = { x, y, z, forward, helmsmanId: r.varuint() };
  }
  if (mask & 16) {
    const throttle = r.f32();
    d.control = { throttle, rudder: r.f32() };
  }
  if (mask & 32) {
    const angle = r.f64();
    const angularSpeed = r.f64();
    const sails = r.varuint();
    d.rotor = { angle, angularSpeed, sails, frozen: r.bool() };
  }
  return d;
}

// ---------------------------------------------------------------- chunks

/** Validate a chunk glue face (lx | lz<<4 | y<<8 | axis<<15). */
function chunkFaceOk(face: number): boolean {
  return face < CHUNK_GLUE_FACE_LIMIT && face >>> 15 <= 2;
}

function writeChunkFace(w: ByteWriter, face: number, added: boolean | null): void {
  if (!Number.isInteger(face) || face < 0 || !chunkFaceOk(face)) bad('chunk glue face', face);
  w.varuint(added === null ? face : face + (added ? CHUNK_GLUE_FACE_LIMIT : 0));
}

function writeSnapshot(w: ByteWriter, s: ChunkSnapshot, budget: CellBudget): void {
  writeCoord(w, s.cx);
  writeCoord(w, s.cz);
  if (s.cells === 'pristine') w.u8(0);
  else {
    if (s.cells.length !== CHUNK_VOLUME) bad('chunk snapshot cell count', s.cells.length);
    if (CHUNK_VOLUME > budget.cells) bad('cells in one TickBatch (MAX_BATCH_CELLS)', CHUNK_VOLUME);
    budget.cells -= CHUNK_VOLUME;
    w.u8(1);
    writeCellVolume(w, s.cells);
  }
  w.varuint(s.glue.length);
  for (const face of s.glue) writeChunkFace(w, face, null);
}
function readSnapshot(r: ByteReader, budget: CellBudget): ChunkSnapshot {
  const cx = readCoord(r);
  const cz = readCoord(r);
  const kind = r.u8();
  let cells: ChunkSnapshot['cells'];
  if (kind === 0) cells = 'pristine';
  else if (kind === 1) cells = readCellVolume(r, CHUNK_VOLUME, budget);
  else return r.fail(`unknown snapshot kind ${kind}`);
  const n = r.count(1);
  const glue: number[] = [];
  for (let i = 0; i < n; i++) {
    const face = r.varuint();
    if (!chunkFaceOk(face)) r.fail(`invalid chunk glue face ${face}`);
    glue.push(face);
  }
  return { cx, cz, cells, glue };
}

function writeChunkDelta(w: ByteWriter, d: ChunkDelta): void {
  writeCoord(w, d.cx);
  writeCoord(w, d.cz);
  w.varuint(d.cells.length);
  let prev = 0;
  for (let i = 0; i < d.cells.length; i++) {
    const [index, cell] = d.cells[i]!;
    if (!Number.isInteger(index) || index >= CHUNK_VOLUME || (i === 0 ? index < 0 : index <= prev)) bad('chunk delta index (ascending, < 32768)', index);
    w.varuint(index - prev);
    writeCell(w, cell);
    prev = index;
  }
  w.varuint(d.glue.length);
  for (const [face, added] of d.glue) writeChunkFace(w, face, added);
}
function readChunkDelta(r: ByteReader): ChunkDelta {
  const cx = readCoord(r);
  const cz = readCoord(r);
  const n = r.count(2);
  const cells: Array<[number, Cell]> = [];
  let index = 0;
  for (let i = 0; i < n; i++) {
    const d = r.varuint();
    if (i > 0 && d === 0) r.fail('chunk delta indices must ascend');
    index += d;
    if (index >= CHUNK_VOLUME) r.fail(`chunk delta index ${index} out of range`);
    cells.push([index, readCell(r)]);
  }
  const m = r.count(1);
  const glue: Array<[number, boolean]> = [];
  for (let i = 0; i < m; i++) {
    const v = r.varuint();
    const added = v >= CHUNK_GLUE_FACE_LIMIT;
    const face = added ? v - CHUNK_GLUE_FACE_LIMIT : v;
    if (!chunkFaceOk(face)) r.fail(`invalid chunk glue change ${v}`);
    glue.push([face, added]);
  }
  return { cx, cz, cells, glue };
}

// ---------------------------------------------------------------- private state

const CORRECTION_FLYING = 1;
const CORRECTION_ON_GROUND = 2;

function writeCorrection(w: ByteWriter, c: NetCorrection): void {
  w.varuint(c.epoch).string(c.cause).varuint(c.carrierId);
  writeF64x3(w, c.pos);
  writeF32x3(w, c.vel);
  w.f32(c.yaw).f32(c.pitch);
  w.u8((c.flying ? CORRECTION_FLYING : 0) | (c.onGround ? CORRECTION_ON_GROUND : 0));
  if ((c.seatShipId !== 0) !== (c.seat !== null)) bad('correction seat (present exactly when seatShipId is not 0)', c.seatShipId);
  w.varuint(c.seatShipId);
  if (c.seat !== null) writeF64x3(w, c.seat);
}
function readCorrection(r: ByteReader): NetCorrection {
  const epoch = r.varuint();
  const cause = r.string();
  const carrierId = r.varuint();
  const pos = readF64x3(r);
  const vel = readF32x3(r);
  const yaw = r.f32();
  const pitch = r.f32();
  const f = readFlags(r, 3, 'correction flag');
  const seatShipId = r.varuint();
  const seat = seatShipId !== 0 ? readF64x3(r) : null;
  return { epoch, cause, carrierId, pos, vel, yaw, pitch, flying: (f & CORRECTION_FLYING) !== 0, onGround: (f & CORRECTION_ON_GROUND) !== 0, seatShipId, seat };
}

function writeInventory(w: ByteWriter, inv: NetInventory): void {
  writeSlot(w, inv.selected);
  if (inv.hotbar.length !== HOTBAR_SLOTS) bad('hotbar length', inv.hotbar.length);
  if (inv.main.length !== MAIN_SLOTS) bad('backpack length', inv.main.length);
  for (const s of inv.hotbar) writeStack(w, s);
  for (const s of inv.main) writeStack(w, s);
  writeStack(w, inv.offhand);
  writeStack(w, inv.cursor);
}
function readInventory(r: ByteReader): NetInventory {
  const selected = readSlot(r);
  const hotbar: Array<ItemStack | null> = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) hotbar.push(readStack(r));
  const main: Array<ItemStack | null> = [];
  for (let i = 0; i < MAIN_SLOTS; i++) main.push(readStack(r));
  const offhand = readStack(r);
  return { selected, hotbar, main, offhand, cursor: readStack(r) };
}

function writeVitals(w: ByteWriter, v: NetVitals): void {
  w.f32(v.health).f32(v.maxHealth).varuint(v.air).varuint(v.maxAir).bool(v.dead);
  writeMode(w, v.mode);
}
function readVitals(r: ByteReader): NetVitals {
  const health = r.f32();
  const maxHealth = r.f32();
  const air = r.varuint();
  const maxAir = r.varuint();
  const dead = r.bool();
  return { health, maxHealth, air, maxAir, dead, mode: readMode(r) };
}

function writeMining(w: ByteWriter, m: MiningView | GluingView, face: boolean): void {
  w.varuint(m.gridId);
  writeCoord(w, m.x);
  writeCoord(w, m.y);
  writeCoord(w, m.z);
  if (face) writeDir(w, (m as GluingView).face, 'face');
  w.u8(m.sub);
  writeProgress(w, m.progress);
}
function readMining(r: ByteReader): MiningView {
  const gridId = r.varuint();
  const x = readCoord(r);
  const y = readCoord(r);
  const z = readCoord(r);
  const sub = r.u8();
  return { gridId, x, y, z, sub, progress: readProgress(r) };
}
function readGluing(r: ByteReader): GluingView {
  const gridId = r.varuint();
  const x = readCoord(r);
  const y = readCoord(r);
  const z = readCoord(r);
  const face = readDir(r, 'face');
  const sub = r.u8();
  return { gridId, x, y, z, face, sub, progress: readProgress(r) };
}

/**
 * Preview: vu gridId, u8 kind, vi minX..minZ, vu sx..sz, ceil(volume / 8) bytes of bitmap (bit i of
 * the box = byte i>>3, bit i&7). At most MAX_PREVIEW_CELLS cells in a box of at most
 * MAX_STRUCTURE_BOX_CELLS (a 256 KiB bitmap), every corner within MAX_COORD, on both ends.
 */
function writePreview(w: ByteWriter, p: PreviewView): void {
  w.varuint(p.gridId);
  writeEnum(w, STRUCTURE_KINDS, p.kind, 'preview kind');
  const c = p.cells;
  if (c.length % 3 !== 0) bad('preview cell list length', c.length);
  if (c.length / 3 > MAX_PREVIEW_CELLS) bad('preview cell count (MAX_PREVIEW_CELLS)', c.length / 3);
  if (c.length === 0) {
    w.varint(0).varint(0).varint(0).varuint(0).varuint(0).varuint(0);
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < c.length; i += 3) {
    minX = Math.min(minX, c[i]!);
    maxX = Math.max(maxX, c[i]!);
    minY = Math.min(minY, c[i + 1]!);
    maxY = Math.max(maxY, c[i + 1]!);
    minZ = Math.min(minZ, c[i + 2]!);
    maxZ = Math.max(maxZ, c[i + 2]!);
  }
  writeCoord(w, minX);
  writeCoord(w, minY);
  writeCoord(w, minZ);
  for (const v of [maxX, maxY, maxZ]) if (v > MAX_COORD) bad('coordinate', v);
  const sx = maxX - minX + 1;
  const sy = maxY - minY + 1;
  const sz = maxZ - minZ + 1;
  const volume = boxVolume(sx, sy, sz);
  if (volume < 0) bad('preview box volume (MAX_STRUCTURE_BOX_CELLS)', sx * sy * sz);
  w.varuint(sx).varuint(sy).varuint(sz);
  const bits = new Uint8Array(Math.ceil(volume / 8));
  for (let i = 0; i < c.length; i += 3) {
    const idx = c[i]! - minX + (c[i + 2]! - minZ) * sx + (c[i + 1]! - minY) * sx * sz;
    bits[idx >> 3]! |= 1 << (idx & 7);
  }
  w.raw(bits);
}
function readPreview(r: ByteReader): PreviewView {
  const gridId = r.varuint();
  const kind = readEnum(r, STRUCTURE_KINDS, 'preview kind');
  const minX = readCoord(r);
  const minY = readCoord(r);
  const minZ = readCoord(r);
  const sx = r.varuint();
  const sy = r.varuint();
  const sz = r.varuint();
  if (sx === 0 || sy === 0 || sz === 0) {
    if (sx !== 0 || sy !== 0 || sz !== 0 || minX !== 0 || minY !== 0 || minZ !== 0) r.fail('an empty preview box must be all zero');
    return { gridId, kind, cells: new Int32Array(0) };
  }
  const volume = boxVolume(sx, sy, sz);
  if (volume < 0) r.fail(`preview box ${sx} x ${sy} x ${sz} is too large`);
  if (minX + sx - 1 > MAX_COORD || minY + sy - 1 > MAX_COORD || minZ + sz - 1 > MAX_COORD) r.fail('preview box leaves the coordinate range');
  // The bitmap must be in the input (rawView checks), so the loops below are bounded by the input.
  const bytes = r.rawView(Math.ceil(volume / 8));
  if (volume % 8 !== 0 && bytes[bytes.length - 1]! >> (volume % 8) !== 0) r.fail('preview bitmap has bits past the box');
  // Counted before allocating: a full bitmap would otherwise turn each input byte into 96 bytes.
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i]!;
    while (b !== 0) {
      b &= b - 1;
      count++;
    }
    if (count > MAX_PREVIEW_CELLS) r.fail(`preview of more than ${MAX_PREVIEW_CELLS} cells (MAX_PREVIEW_CELLS)`);
  }
  const cells = new Int32Array(count * 3);
  let o = 0;
  const layer = sx * sz;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0) continue;
    for (let k = 0; k < 8; k++) {
      if ((b & (1 << k)) === 0) continue;
      const idx = i * 8 + k;
      const y = Math.floor(idx / layer);
      const rest = idx - y * layer;
      const z = Math.floor(rest / sx);
      cells[o++] = minX + (rest - z * sx);
      cells[o++] = minY + y;
      cells[o++] = minZ + z;
    }
  }
  return { gridId, kind, cells };
}

function writeView(w: ByteWriter, v: ViewUpdate): void {
  w.u8(
    (v.mining !== undefined ? 1 : 0) |
      (v.gluing !== undefined ? 2 : 0) |
      (v.preview !== undefined ? 4 : 0) |
      (v.conflicts !== undefined ? 8 : 0) |
      (v.hint !== undefined ? 16 : 0),
  );
  if (v.mining !== undefined) {
    w.bool(v.mining !== null);
    if (v.mining !== null) writeMining(w, v.mining, false);
  }
  if (v.gluing !== undefined) {
    w.bool(v.gluing !== null);
    if (v.gluing !== null) writeMining(w, v.gluing, true);
  }
  if (v.preview !== undefined) {
    w.bool(v.preview !== null);
    if (v.preview !== null) writePreview(w, v.preview);
  }
  if (v.conflicts !== undefined) {
    w.varuint(v.conflicts.length);
    let px = 0;
    let py = 0;
    let pz = 0;
    for (const c of v.conflicts) {
      writeCoordDelta(w, c.x, px);
      writeCoordDelta(w, c.y, py);
      writeCoordDelta(w, c.z, pz);
      px = c.x;
      py = c.y;
      pz = c.z;
    }
  }
  if (v.hint !== undefined) {
    w.bool(v.hint !== null);
    if (v.hint !== null) writeMessage(w, v.hint);
  }
}
function readView(r: ByteReader): ViewUpdate {
  const mask = readFlags(r, 0x1f, 'view');
  const v: ViewUpdate = {};
  if (mask & 1) v.mining = r.bool() ? readMining(r) : null;
  if (mask & 2) v.gluing = r.bool() ? readGluing(r) : null;
  if (mask & 4) v.preview = r.bool() ? readPreview(r) : null;
  if (mask & 8) {
    const n = r.count(3);
    const conflicts: Vec3[] = [];
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < n; i++) {
      x = readCoordDelta(r, x);
      y = readCoordDelta(r, y);
      z = readCoordDelta(r, z);
      conflicts.push({ x, y, z });
    }
    v.conflicts = conflicts;
  }
  if (mask & 16) v.hint = r.bool() ? readMessage(r) : null;
  return v;
}

function writePrivateEvent(w: ByteWriter, e: PrivateEvent): void {
  switch (e.type) {
    case 'toast':
      w.u8(0);
      writeMessage(w, e.message);
      writeEnum(w, TOAST_KINDS, e.kind, 'toast kind');
      break;
    case 'playerHurt':
      w.u8(1).f32(e.amount).string(e.cause);
      break;
    case 'playerDied':
      w.u8(2).string(e.cause);
      break;
    case 'playerPickup':
      w.u8(3).varuint(e.item).varuint(e.count);
      break;
    case 'helmReleased':
      w.u8(4).string(e.cause);
      break;
  }
}
function readPrivateEvent(r: ByteReader): PrivateEvent {
  const type = r.u8();
  switch (type) {
    case 0: {
      const message = readMessage(r);
      return { type: 'toast', message, kind: readEnum(r, TOAST_KINDS, 'toast kind') };
    }
    case 1: {
      const amount = r.f32();
      return { type: 'playerHurt', amount, cause: r.string() };
    }
    case 2:
      return { type: 'playerDied', cause: r.string() };
    case 3: {
      const item = r.varuint();
      return { type: 'playerPickup', item, count: r.varuint() };
    }
    case 4:
      return { type: 'helmReleased', cause: r.string() };
    default:
      return r.fail(`unknown private event ${type}`);
  }
}

function writePrivate(w: ByteWriter, p: PrivateState): void {
  w.u8(
    (p.correction !== undefined ? 1 : 0) |
      (p.inventory !== undefined ? 2 : 0) |
      (p.vitals !== undefined ? 4 : 0) |
      (p.view !== undefined ? 8 : 0) |
      (p.events !== undefined ? 16 : 0) |
      (p.ack !== undefined ? 32 : 0) |
      (p.moveAck !== undefined ? 64 : 0),
  );
  if (p.correction !== undefined) writeCorrection(w, p.correction);
  if (p.inventory !== undefined) writeInventory(w, p.inventory);
  if (p.vitals !== undefined) writeVitals(w, p.vitals);
  if (p.view !== undefined) writeView(w, p.view);
  if (p.events !== undefined) {
    w.varuint(p.events.length);
    for (const e of p.events) writePrivateEvent(w, e);
  }
  if (p.ack !== undefined) w.varuint(p.ack);
  if (p.moveAck !== undefined) w.varuint(p.moveAck);
}
function readPrivate(r: ByteReader): PrivateState {
  const mask = readFlags(r, 0x7f, 'private state');
  const p: PrivateState = {};
  if (mask & 1) p.correction = readCorrection(r);
  if (mask & 2) p.inventory = readInventory(r);
  if (mask & 4) p.vitals = readVitals(r);
  if (mask & 8) p.view = readView(r);
  if (mask & 16) {
    const n = r.count(2);
    const events: PrivateEvent[] = [];
    for (let i = 0; i < n; i++) events.push(readPrivateEvent(r));
    p.events = events;
  }
  if (mask & 32) p.ack = r.varuint();
  if (mask & 64) p.moveAck = r.varuint();
  return p;
}

// ---------------------------------------------------------------- events, globals

function writeWorldEvent(w: ByteWriter, e: WorldEvent): void {
  switch (e.type) {
    case 'blockBroken':
    case 'blockPlaced':
      w.u8(e.type === 'blockBroken' ? 0 : 1).varuint(e.gridId);
      writeCoord(w, e.x);
      writeCoord(w, e.y);
      writeCoord(w, e.z);
      writeCell(w, e.cell);
      break;
    case 'explosion':
      w.u8(2).f32(e.x).f32(e.y).f32(e.z).f32(e.power);
      break;
    case 'sound':
      w.u8(3).string(e.name).f32(e.x).f32(e.y).f32(e.z);
      break;
  }
}
function readWorldEvent(r: ByteReader): WorldEvent {
  const type = r.u8();
  switch (type) {
    case 0:
    case 1: {
      const gridId = r.varuint();
      const x = readCoord(r);
      const y = readCoord(r);
      const z = readCoord(r);
      return { type: type === 0 ? 'blockBroken' : 'blockPlaced', gridId, x, y, z, cell: readCell(r) };
    }
    case 2: {
      const x = r.f32();
      const y = r.f32();
      const z = r.f32();
      return { type: 'explosion', x, y, z, power: r.f32() };
    }
    case 3: {
      const name = r.string();
      const x = r.f32();
      const y = r.f32();
      return { type: 'sound', name, x, y, z: r.f32() };
    }
    default:
      return r.fail(`unknown world event ${type}`);
  }
}

function writeRules(w: ByteWriter, rules: WorldRules): void {
  writeMode(w, rules.defaultMode);
  w.bool(rules.dropsEnabled);
}
function readRules(r: ByteReader): WorldRules {
  const defaultMode = readMode(r);
  return { defaultMode, dropsEnabled: r.bool() };
}

function writeGlobals(w: ByteWriter, g: Globals): void {
  if (g.ready !== undefined && g.ready !== true) bad('ready (true or absent)', g.ready);
  w.u8(
    (g.dayOffset !== undefined ? 1 : 0) |
      (g.rules !== undefined ? 2 : 0) |
      (g.players !== undefined ? 4 : 0) |
      (g.tps !== undefined ? 8 : 0) |
      (g.ready === true ? 16 : 0) |
      (g.roomOpen !== undefined ? 32 : 0),
  );
  if (g.dayOffset !== undefined) w.varuint(g.dayOffset);
  if (g.rules !== undefined) writeRules(w, g.rules);
  if (g.players !== undefined) {
    w.varuint(g.players.length);
    for (const c of g.players) {
      if (c.op === 'join') w.u8(0).varuint(c.entityId).string(c.name).bool(c.host);
      else w.u8(1).varuint(c.entityId);
    }
  }
  if (g.tps !== undefined) {
    const tps10 = Math.round(g.tps * 10);
    if (!Number.isSafeInteger(tps10) || tps10 < 0) bad('tps', g.tps);
    w.varuint(tps10);
  }
  if (g.roomOpen !== undefined) w.bool(g.roomOpen);
}
function readGlobals(r: ByteReader): Globals {
  const mask = readFlags(r, 0x3f, 'globals');
  const g: Globals = {};
  if (mask & 1) g.dayOffset = r.varuint();
  if (mask & 2) g.rules = readRules(r);
  if (mask & 4) {
    const n = r.count(2);
    const players: PlayerListChange[] = [];
    for (let i = 0; i < n; i++) {
      const op = r.u8();
      const entityId = r.varuint();
      if (op === 0) {
        const name = r.string();
        players.push({ op: 'join', entityId, name, host: r.bool() });
      } else if (op === 1) players.push({ op: 'leave', entityId });
      else r.fail(`unknown player list change ${op}`);
    }
    g.players = players;
  }
  if (mask & 8) g.tps = r.varuint() / 10;
  if (mask & 16) g.ready = true;
  if (mask & 32) g.roomOpen = r.bool();
  return g;
}

// ====================================================================== server -> client

/** Smallest encoded size of one element of each list (bounds the counts before looping). */
const MIN_BYTES = Object.freeze({
  chunkPos: 2,
  snapshot: 4,
  chunkDelta: 4,
  id: 1,
  structureRecord: 103,
  structureDelta: 2,
  rest: 21,
  entityRecord: 17,
  entityUpdate: 2,
  worldEvent: 6,
  player: 3,
  shipSample: 21,
  entitySample: 17,
});

function writeIdList(w: ByteWriter, ids: readonly number[]): void {
  w.varuint(ids.length);
  for (const id of ids) w.varuint(id);
}
function readIdList(r: ByteReader): number[] {
  const n = r.count(MIN_BYTES.id);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.varuint());
  return out;
}

function writeList<T>(w: ByteWriter, items: readonly T[], write: (w: ByteWriter, item: T) => void): void {
  w.varuint(items.length);
  for (const item of items) write(w, item);
}
function readList<T>(r: ByteReader, minBytes: number, read: (r: ByteReader) => T): T[] {
  const n = r.count(minBytes);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(read(r));
  return out;
}

function writeRest(w: ByteWriter, s: StructureRest | ShipSample): void {
  w.varuint(s.id);
  writePose(w, s.pose);
}
function readRest(r: ByteReader): StructureRest {
  const id = r.varuint();
  return { id, pose: readPose(r) };
}

/**
 * A chunk snapshot or a structure record encoded on its own, to be written into the TickBatches
 * of several clients without encoding it again (NETCODE section 15: a column's snapshot is
 * encoded once per version). `cells` is what it charges to the batch's MAX_BATCH_CELLS.
 */
export interface EncodedPiece {
  readonly bytes: Uint8Array;
  readonly cells: number;
}

/** Pre-encoded entries of a TickBatch's snapshots and structureSpawns sections (encodeTickBatch). */
export interface BatchPieces {
  readonly snapshots: readonly EncodedPiece[];
  readonly structureSpawns: readonly EncodedPiece[];
}

const NO_PIECES: BatchPieces = Object.freeze({ snapshots: Object.freeze([]), structureSpawns: Object.freeze([]) });

/** One snapshot, encoded as it appears in the snapshots section. Throws RangeError on invalid data. */
export function encodeSnapshotPiece(s: ChunkSnapshot): EncodedPiece {
  const budget: CellBudget = { cells: MAX_BATCH_CELLS };
  const w = new ByteWriter(s.cells === 'pristine' ? 16 : 1024);
  writeSnapshot(w, s, budget);
  return { bytes: w.finish(), cells: MAX_BATCH_CELLS - budget.cells };
}

/** One structure record, encoded as it appears in the structureSpawns section. Throws RangeError on invalid data. */
export function encodeStructureRecordPiece(s: StructureRecord): EncodedPiece {
  const budget: CellBudget = { cells: MAX_BATCH_CELLS };
  const w = new ByteWriter(256);
  writeStructureRecord(w, s, budget);
  return { bytes: w.finish(), cells: MAX_BATCH_CELLS - budget.cells };
}

function writePieces(w: ByteWriter, pieces: readonly EncodedPiece[], budget: CellBudget): void {
  for (const p of pieces) {
    if (p.cells > budget.cells) bad('cells in one TickBatch (MAX_BATCH_CELLS)', p.cells);
    budget.cells -= p.cells;
    w.raw(p.bytes);
  }
}

function writeTickBatch(w: ByteWriter, b: TickBatchMsg, pieces: BatchPieces, sectionBytes: number[] | null): void {
  const budget: CellBudget = { cells: MAX_BATCH_CELLS };
  const nSnapshots = b.snapshots.length + pieces.snapshots.length;
  const nSpawns = b.structureSpawns.length + pieces.structureSpawns.length;
  let sections = 0;
  if (b.unsubscribe.length > 0) sections |= 1 << SECTION.unsubscribe;
  if (nSnapshots > 0) sections |= 1 << SECTION.snapshots;
  if (b.chunkDeltas.length > 0) sections |= 1 << SECTION.chunkDeltas;
  if (b.structureRemoves.length > 0) sections |= 1 << SECTION.structureRemoves;
  if (nSpawns > 0) sections |= 1 << SECTION.structureSpawns;
  if (b.structureDeltas.length > 0) sections |= 1 << SECTION.structureDeltas;
  if (b.structureRests.length > 0) sections |= 1 << SECTION.structureRests;
  if (b.entityDespawns.length > 0) sections |= 1 << SECTION.entityDespawns;
  if (b.entitySpawns.length > 0) sections |= 1 << SECTION.entitySpawns;
  if (b.entityUpdates.length > 0) sections |= 1 << SECTION.entityUpdates;
  if (b.private !== null) sections |= 1 << SECTION.private;
  if (b.events.length > 0) sections |= 1 << SECTION.events;
  if (b.globals !== null) sections |= 1 << SECTION.globals;
  w.varuint(b.tick).u16(sections);
  let mark = w.length;
  const measured = (section: number): void => {
    if (sectionBytes !== null) sectionBytes[section] = (sectionBytes[section] ?? 0) + w.length - mark;
    mark = w.length;
  };
  if (sections & (1 << SECTION.unsubscribe)) {
    writeList(w, b.unsubscribe, (w, c) => {
      writeCoord(w, c.cx);
      writeCoord(w, c.cz);
    });
    measured(SECTION.unsubscribe);
  }
  if (sections & (1 << SECTION.snapshots)) {
    w.varuint(nSnapshots);
    for (const s of b.snapshots) writeSnapshot(w, s, budget);
    writePieces(w, pieces.snapshots, budget);
    measured(SECTION.snapshots);
  }
  if (sections & (1 << SECTION.chunkDeltas)) {
    writeList(w, b.chunkDeltas, writeChunkDelta);
    measured(SECTION.chunkDeltas);
  }
  if (sections & (1 << SECTION.structureRemoves)) {
    writeIdList(w, b.structureRemoves);
    measured(SECTION.structureRemoves);
  }
  if (sections & (1 << SECTION.structureSpawns)) {
    w.varuint(nSpawns);
    for (const s of b.structureSpawns) writeStructureRecord(w, s, budget);
    writePieces(w, pieces.structureSpawns, budget);
    measured(SECTION.structureSpawns);
  }
  if (sections & (1 << SECTION.structureDeltas)) {
    writeList(w, b.structureDeltas, writeStructureDelta);
    measured(SECTION.structureDeltas);
  }
  if (sections & (1 << SECTION.structureRests)) {
    writeList(w, b.structureRests, writeRest);
    measured(SECTION.structureRests);
  }
  if (sections & (1 << SECTION.entityDespawns)) {
    writeIdList(w, b.entityDespawns);
    measured(SECTION.entityDespawns);
  }
  if (sections & (1 << SECTION.entitySpawns)) {
    writeList(w, b.entitySpawns, writeEntityRecord);
    measured(SECTION.entitySpawns);
  }
  if (sections & (1 << SECTION.entityUpdates)) {
    writeList(w, b.entityUpdates, writeEntityUpdate);
    measured(SECTION.entityUpdates);
  }
  if (b.private !== null) {
    writePrivate(w, b.private);
    measured(SECTION.private);
  }
  if (sections & (1 << SECTION.events)) {
    writeList(w, b.events, writeWorldEvent);
    measured(SECTION.events);
  }
  if (b.globals !== null) {
    writeGlobals(w, b.globals);
    measured(SECTION.globals);
  }
}

function readTickBatch(r: ByteReader): TickBatchMsg {
  const budget: CellBudget = { cells: MAX_BATCH_CELLS };
  const tick = r.varuint();
  const sections = r.u16();
  if (sections >>> 13 !== 0) r.fail(`unknown TickBatch sections 0x${sections.toString(16)}`);
  const has = (bit: number): boolean => (sections & (1 << bit)) !== 0;
  const b: TickBatchMsg = {
    type: 'tickBatch',
    tick,
    unsubscribe: has(SECTION.unsubscribe)
      ? readList(r, MIN_BYTES.chunkPos, (r) => {
          const cx = readCoord(r);
          return { cx, cz: readCoord(r) };
        })
      : [],
    snapshots: has(SECTION.snapshots) ? readList(r, MIN_BYTES.snapshot, (r) => readSnapshot(r, budget)) : [],
    chunkDeltas: has(SECTION.chunkDeltas) ? readList(r, MIN_BYTES.chunkDelta, readChunkDelta) : [],
    structureRemoves: has(SECTION.structureRemoves) ? readIdList(r) : [],
    structureSpawns: has(SECTION.structureSpawns) ? readList(r, MIN_BYTES.structureRecord, (r) => readStructureRecord(r, budget)) : [],
    structureDeltas: has(SECTION.structureDeltas) ? readList(r, MIN_BYTES.structureDelta, readStructureDelta) : [],
    structureRests: has(SECTION.structureRests) ? readList(r, MIN_BYTES.rest, readRest) : [],
    entityDespawns: has(SECTION.entityDespawns) ? readIdList(r) : [],
    entitySpawns: has(SECTION.entitySpawns) ? readList(r, MIN_BYTES.entityRecord, readEntityRecord) : [],
    entityUpdates: has(SECTION.entityUpdates) ? readList(r, MIN_BYTES.entityUpdate, readEntityUpdate) : [],
    private: has(SECTION.private) ? readPrivate(r) : null,
    events: has(SECTION.events) ? readList(r, MIN_BYTES.worldEvent, readWorldEvent) : [],
    globals: has(SECTION.globals) ? readGlobals(r) : null,
  };
  return b;
}

function writeSamplesBody(w: ByteWriter, tick: number, seq: number, ships: readonly ShipSample[], entities: readonly EntitySample[]): void {
  w.varuint(tick).varuint(seq);
  writeList(w, ships, writeRest);
  writeList(w, entities, writeEntitySample);
}

function writePlayerEntry(w: ByteWriter, p: PlayerEntry): void {
  w.varuint(p.entityId).string(p.name).bool(p.host);
}
function readPlayerEntry(r: ByteReader): PlayerEntry {
  const entityId = r.varuint();
  const name = r.string();
  return { entityId, name, host: r.bool() };
}

function writeServerPayload(w: ByteWriter, m: ServerMessage): void {
  switch (m.type) {
    case 'welcome':
      w.varuint(m.entityId);
      writeGeneratorSpec(w, m.generator);
      w.varuint(m.worldTime).varuint(m.dayOffset);
      writeRules(w, m.rules);
      w.bool(m.isHost).bool(m.roomOpen);
      writeList(w, m.players, writePlayerEntry);
      return;
    case 'refuse':
      writeEnum(w, REFUSE_REASONS, m.reason, 'refuse reason', 1);
      w.string(m.detail);
      return;
    case 'kick':
      writeEnum(w, KICK_REASONS, m.reason, 'kick reason', 1);
      w.string(m.detail);
      return;
    case 'pong':
      w.u32(m.clientMs).varuint(m.tick);
      return;
    case 'tickBatch':
      writeTickBatch(w, m, NO_PIECES, null);
      return;
    case 'samples':
      writeSamplesBody(w, m.tick, m.seq, m.ships, m.entities);
      return;
  }
}

function readServerPayload(r: ByteReader, id: number): ServerMessage {
  switch (id) {
    case MSG.welcome: {
      const entityId = r.varuint();
      const generator = readGeneratorSpec(r);
      const worldTime = r.varuint();
      const dayOffset = r.varuint();
      const rules = readRules(r);
      const isHost = r.bool();
      const roomOpen = r.bool();
      const players = readList(r, MIN_BYTES.player, readPlayerEntry);
      return { type: 'welcome', entityId, generator, worldTime, dayOffset, rules, isHost, roomOpen, players };
    }
    case MSG.refuse: {
      const reason = readEnum(r, REFUSE_REASONS, 'refuse reason', 1);
      return { type: 'refuse', reason, detail: r.string() };
    }
    case MSG.kick: {
      const reason = readEnum(r, KICK_REASONS, 'kick reason', 1);
      return { type: 'kick', reason, detail: r.string() };
    }
    case MSG.pong: {
      const clientMs = r.u32();
      return { type: 'pong', clientMs, tick: r.varuint() };
    }
    case MSG.tickBatch:
      return readTickBatch(r);
    case MSG.samples: {
      const tick = r.varuint();
      const seq = r.varuint();
      const ships = readList(r, MIN_BYTES.shipSample, readRest);
      const entities = readList(r, MIN_BYTES.entitySample, readEntitySample);
      return { type: 'samples', tick, seq, ships, entities };
    }
    default:
      return r.fail(`unknown server message id 0x${id.toString(16)}`);
  }
}

// ====================================================================== entry points

/** Run a decoder over `bytes`, require the input to be consumed, and turn any failure into a ProtocolError. */
function decoding<T>(bytes: Uint8Array, label: string, read: (r: ByteReader) => T): T {
  try {
    const r = new ByteReader(bytes, label);
    const value = read(r);
    r.expectEnd();
    return value;
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw new ProtocolError(e instanceof Error ? e.message : String(e), { cause: e });
  }
}

function channelLimit(channel: Channel): number {
  return channel === RELIABLE ? MAX_RELIABLE_BYTES : MAX_UNRELIABLE_BYTES;
}

function finishMessage(w: ByteWriter, type: MessageType, limit: number): Uint8Array {
  const n = w.length;
  const max = Math.min(limit, channelLimit(MESSAGE_CHANNEL[type]));
  if (n > max) throw new RangeError(`${type} message of ${n} bytes exceeds its limit of ${max}`);
  return w.finish();
}

/** Encode a client -> server message (id byte + payload). Throws RangeError on invalid data or when too long. */
export function encodeClientMessage(m: ClientMessage): Uint8Array {
  const w = new ByteWriter(64);
  w.u8(MSG[m.type]);
  writeClientPayload(w, m);
  return finishMessage(w, m.type, m.type === 'hello' ? MAX_HELLO_BYTES : MAX_CLIENT_MESSAGE_BYTES);
}

/** Encode a server -> client message. Throws RangeError on invalid data or when too long for its channel. */
export function encodeServerMessage(m: ServerMessage): Uint8Array {
  const w = new ByteWriter(m.type === 'tickBatch' ? 256 : 64);
  w.u8(MSG[m.type]);
  writeServerPayload(w, m);
  return finishMessage(w, m.type, Infinity);
}

/**
 * Encode a TickBatch whose snapshots and structureSpawns sections are the batch's own entries
 * followed by the pre-encoded `pieces` (encodeSnapshotPiece / encodeStructureRecordPiece). When
 * `sectionBytes` is given, the encoded size of each present section is added to
 * sectionBytes[bit] (statistics; the message id, tick and mask are not counted). Decodes like any
 * TickBatch. Throws RangeError on invalid data, cells beyond MAX_BATCH_CELLS included. The length
 * is not limited here: the caller compares it with MAX_RELIABLE_BYTES (the Replicator drops a
 * client whose batch is longer, NETCODE section 13) before handing it to a Transport.
 */
export function encodeTickBatch(b: TickBatchMsg, pieces: BatchPieces, sectionBytes: number[] | null = null): Uint8Array {
  const w = new ByteWriter(256);
  w.u8(MSG.tickBatch);
  writeTickBatch(w, b, pieces, sectionBytes);
  return w.finish();
}

/** Message type by id (frozen lookup table). */
const TYPE_BY_ID: ReadonlyArray<MessageType | undefined> = Object.freeze(
  Array.from({ length: 256 }, (_, id) => (Object.keys(MSG) as MessageType[]).find((t) => MSG[t] === id)),
);

function readId(r: ByteReader, channel: Channel, client: boolean): number {
  const id = r.u8();
  const type = TYPE_BY_ID[id];
  if (type === undefined || (id < 0x80) !== client) r.fail(`unknown ${client ? 'client' : 'server'} message id 0x${id.toString(16)}`);
  if (MESSAGE_CHANNEL[type] !== channel) r.fail(`${type} arrived on the wrong channel`);
  return id;
}

/** Decode a client -> server message that arrived on `channel`. Throws ProtocolError only. */
export function decodeClientMessage(bytes: Uint8Array, channel: Channel): ClientMessage {
  return decoding(bytes, 'client message', (r) => {
    if (r.length > MAX_CLIENT_MESSAGE_BYTES) r.fail(`message of ${r.length} bytes exceeds ${MAX_CLIENT_MESSAGE_BYTES}`);
    const id = readId(r, channel, true);
    if (id === MSG.hello && r.length > MAX_HELLO_BYTES) r.fail(`Hello of ${r.length} bytes exceeds ${MAX_HELLO_BYTES}`);
    return readClientPayload(r, id);
  });
}

/** Decode a server -> client message that arrived on `channel`. Throws ProtocolError only. */
export function decodeServerMessage(bytes: Uint8Array, channel: Channel): ServerMessage {
  return decoding(bytes, 'server message', (r) => {
    if (r.length > channelLimit(channel)) r.fail(`message of ${r.length} bytes exceeds the channel limit`);
    return readServerPayload(r, readId(r, channel, false));
  });
}

/**
 * The build id of a Hello: the message id and `str build` at its start never change (section 3),
 * so a server can answer Refuse(build) to any build's Hello. Throws ProtocolError when `bytes` is
 * not a Hello.
 */
export function readHelloBuild(bytes: Uint8Array): string {
  try {
    const r = new ByteReader(bytes, 'hello');
    if (r.u8() !== MSG.hello) r.fail('not a Hello');
    return r.string();
  } catch (e) {
    throw new ProtocolError(e instanceof Error ? e.message : String(e), { cause: e });
  }
}

/**
 * Encode one tick's samples as Samples messages of at most MAX_UNRELIABLE_BYTES each, in the
 * given order (put the nearest first), numbered firstSeq, firstSeq + 1, ... Each message stands
 * alone. Returns no message when there is nothing to send.
 */
export function packSamples(tick: number, firstSeq: number, ships: readonly ShipSample[], entities: readonly EntitySample[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  // Encoded size of every entry, measured with the real writers.
  const w = new ByteWriter(64);
  const shipSize = ships.map((s) => {
    w.reset();
    writeRest(w, s);
    return w.length;
  });
  const entitySize = entities.map((e) => {
    w.reset();
    writeEntitySample(w, e);
    return w.length;
  });
  let i = 0; // next ship
  let j = 0; // next entity
  while (i < ships.length || j < entities.length) {
    const seq = firstSeq + out.length;
    // id + tick + seq + two counts (sized for the worst case of the counts' varuints).
    let size = 1 + varuintSize(tick) + varuintSize(seq) + 2 * varuintSize(ships.length + entities.length);
    const i0 = i;
    const j0 = j;
    while (i < ships.length && size + shipSize[i]! <= MAX_UNRELIABLE_BYTES) size += shipSize[i++]!;
    if (i === ships.length) while (j < entities.length && size + entitySize[j]! <= MAX_UNRELIABLE_BYTES) size += entitySize[j++]!;
    if (i === i0 && j === j0) throw new RangeError('a sample does not fit in one unreliable message');
    const m: SamplesMsg = { type: 'samples', tick, seq, ships: ships.slice(i0, i), entities: entities.slice(j0, j) };
    out.push(encodeServerMessage(m));
  }
  return out;
}
