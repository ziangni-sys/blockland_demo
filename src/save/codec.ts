/**
 * Save codecs: pure functions between simulation data and bytes.
 *
 * Every blob uses the same envelope:
 *
 *     magic    4 ASCII bytes   what the blob is ("BLKC" chunk, "BLKT" ticks, "BLKM" meta ...)
 *     version  varuint         SAVE_VERSION of the build that wrote it
 *     payload  ...             format depends on magic + version
 *     crc      u32 LE          CRC-32 of every byte before it
 *
 * The envelope itself is frozen: every version of every blob with these magics keeps exactly
 * this framing (a future change of framing would need new magics). That is what lets the
 * decoder verify the checksum BEFORE trusting the version byte, so:
 *  - any corruption, including a flipped version byte, is a SaveFormatError ("corrupted");
 *  - an intact blob from a newer build is a SaveVersionError ("update the game"), which the
 *    orchestrator must treat differently: never regenerate or overwrite such data;
 *  - an intact blob from an older build is a SaveFormatError too: there is no backward
 *    compatibility (docs/DESIGN.md), only SAVE_VERSION itself is read. The client refuses an
 *    older world before reading any blob (WorldMeta.version, isOlderSave) with its own message.
 * The payload is then parsed strictly and must be consumed exactly. Future codecs
 * (structures, glue, entities, player) should use beginBlob / sealBlob / openBlob with
 * their own magic.
 *
 * Pure module (simulation layer): no DOM, no clock, no randomness.
 */
import { CHUNK_VOLUME, WORLD_HEIGHT } from '../core/constants';
import { MAX_BLOCK_ID } from '../blocks/cell';
import type { Chunk } from '../voxel/chunk';
import type { ScheduledTick } from '../voxel/world';
import { ByteReader, ByteWriter, SaveFormatError, isUint8Array } from './bytes';
import { crc32 } from './crc32';

/**
 * Save format version written into every blob header and into WorldMeta.version. Bump it when
 * any blob layout changes. Only this version is read: worlds saved by an older build cannot be
 * opened (they stay listed so the player can delete them); there is no migration code.
 * 2: the player's off-hand slot; glue that outlives one side of its face; no hub-glue flag.
 * 3: players saved by PlayerKey in their own blob (offline ones too); world rules in the sim blob.
 */
export const SAVE_VERSION = 3;

/**
 * Intact data written by a newer build of the game (its format version is above
 * SAVE_VERSION). It extends SaveFormatError so generic handlers still catch it, but unlike
 * corruption it must never be "repaired": do not regenerate, overwrite or delete the data,
 * tell the player to update instead.
 */
export class SaveVersionError extends SaveFormatError {
  override readonly name: string = 'SaveVersionError';
  /** The format version found in the data (> SAVE_VERSION). */
  readonly version: number;
  constructor(message: string, version: number) {
    super(message);
    this.version = version;
  }
}

/**
 * True when the world was last saved by a newer build (meta.version > SAVE_VERSION). Such a
 * world can be listed but must not be loaded or saved by this build; storage adapters also
 * refuse writes that would downgrade it (see SaveStorage).
 */
export function isNewerSave(meta: Pick<WorldMeta, 'version'>): boolean {
  return meta.version > SAVE_VERSION;
}

/**
 * True when the world was last saved by an older build (meta.version < SAVE_VERSION). Such a
 * world can be listed and deleted but not loaded: older formats are not read.
 */
export function isOlderSave(meta: Pick<WorldMeta, 'version'>): boolean {
  return meta.version < SAVE_VERSION;
}

/**
 * Blob type tags. Reserved for upcoming codecs (pick these so tags never collide):
 * 'BLKS' structures, 'BLKG' glue, 'BLKE' entities, 'BLKP' player.
 */
export const BLOB_MAGIC = Object.freeze({
  chunk: 'BLKC',
  ticks: 'BLKT',
  meta: 'BLKM',
} as const);

// ====================================================================== envelope

const CRC_BYTES = 4;
const MAGIC_BYTES = 4;
/** magic + 1-byte version + crc: nothing valid is shorter. */
const MIN_BLOB_BYTES = MAGIC_BYTES + 1 + CRC_BYTES;

function checkMagic(magic: string): void {
  if (typeof magic !== 'string' || !/^[\x20-\x7e]{4}$/.test(magic)) {
    throw new RangeError(`blob magic must be 4 printable ASCII characters, got ${JSON.stringify(magic)}`);
  }
}

/** Printable rendering of the first 4 bytes, for "wrong magic" messages. */
function showMagic(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < MAGIC_BYTES && i < bytes.length; i++) {
    const b = bytes[i]!;
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return s;
}

/** Start a blob: a writer that already holds the magic and the current SAVE_VERSION. */
export function beginBlob(magic: string, capacity = 256): ByteWriter {
  checkMagic(magic);
  const w = new ByteWriter(capacity);
  for (let i = 0; i < MAGIC_BYTES; i++) w.u8(magic.charCodeAt(i));
  w.varuint(SAVE_VERSION);
  return w;
}

/** Finish a blob started with beginBlob: append the CRC and return the exact bytes. */
export function sealBlob(w: ByteWriter): Uint8Array {
  w.u32(crc32(w.subarray()));
  return w.finish();
}

/** An opened blob: a reader positioned at the payload (it cannot see the CRC). */
export interface OpenedBlob {
  reader: ByteReader;
  /** SAVE_VERSION of the writer (always the current one). */
  version: number;
}

/**
 * Verify a blob's magic, checksum and version (in that order, see the file comment) and
 * return a reader over its payload.
 * Throws SaveVersionError for an intact blob from a newer build, SaveFormatError otherwise.
 * @param label names the blob in error messages (defaults to the magic).
 */
export function openBlob(bytes: Uint8Array, magic: string, label: string = magic): OpenedBlob {
  checkMagic(magic);
  if (!isUint8Array(bytes)) throw new SaveFormatError(`${label}: expected a Uint8Array, got ${typeof bytes}`);
  const n = bytes.length;
  if (n < MIN_BLOB_BYTES) throw new SaveFormatError(`${label}: too short to be a save blob (${n} bytes)`);
  for (let i = 0; i < MAGIC_BYTES; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) {
      throw new SaveFormatError(`${label}: wrong blob type (expected "${magic}", found "${showMagic(bytes)}")`);
    }
  }
  const stored = (bytes[n - 4]! | (bytes[n - 3]! << 8) | (bytes[n - 2]! << 16) | (bytes[n - 1]! << 24)) >>> 0;
  if (stored !== crc32(bytes, 0, n - CRC_BYTES)) {
    throw new SaveFormatError(`${label}: checksum mismatch, the data is corrupted`);
  }
  const reader = new ByteReader(bytes.subarray(0, n - CRC_BYTES), label);
  reader.skip(MAGIC_BYTES);
  const version = reader.varuint();
  if (version > SAVE_VERSION) {
    throw new SaveVersionError(
      `${label}: saved by a newer version of the game (format ${version}; this build reads ${SAVE_VERSION})`,
      version,
    );
  }
  if (version < SAVE_VERSION) reader.fail(`format ${version} is from an older version of the game and is no longer read (this build reads ${SAVE_VERSION})`);
  return { reader, version };
}

// ====================================================================== chunks
//
// Payload v1:
//   varint cx, varint cz
//   u8 encoding
//   encoding 0 (palette RLE):
//     varuint P (1..CHUNK_VOLUME), P x u16 palette (first-appearance order)
//     tokens until all CHUNK_VOLUME cells are covered, in cell index order
//     (lx | lz<<4 | y<<8, so each y layer of 256 cells is contiguous):
//       varuint token = (runLength - 1) << B | paletteIndex,  B = bit length of (P - 1)
//   encoding 1 (raw):
//     u16Array of exactly CHUNK_VOLUME cells
//
// Packing the palette index into the run token makes short runs (ore specks, tree trunks,
// cave walls) cost one byte instead of two, and is never larger than a separate index +
// length pair. The encoder computes the exact RLE size and falls back to raw whenever RLE
// would not be smaller, so an incompressible chunk costs 64 KB + at most 19 bytes of framing.
// Light and heightmap are not stored: they are recomputed on load.

const CHUNK_RLE = 0;
const CHUNK_RAW = 1;
/** Raw payload size: u16Array count prefix (3 bytes for 32768) + 2 bytes per cell. */
const RAW_CELL_BYTES = 3 + CHUNK_VOLUME * 2;
/** chunkKey() supports chunk coordinates in [-CHUNK_COORD_LIMIT, CHUNK_COORD_LIMIT). */
const CHUNK_COORD_LIMIT = 0x80000;

/** Result of decodeChunk: build the Chunk with `new Chunk(cx, cz, cells)`. */
export interface DecodedChunk {
  cx: number;
  cz: number;
  /** Fresh array of CHUNK_VOLUME cells, index = lx | lz<<4 | y<<8. */
  cells: Uint16Array;
}

function varuintSize(v: number): number {
  return v < 0x80 ? 1 : v < 0x4000 ? 2 : v < 0x200000 ? 3 : v < 0x10000000 ? 4 : 5;
}

/** Number of bits needed to store values 0..n (0 for n = 0). */
function bitLength(n: number): number {
  return n === 0 ? 0 : 32 - Math.clz32(n);
}

function checkChunkCoord(v: number, name: string): void {
  if (!Number.isInteger(v) || v < -CHUNK_COORD_LIMIT || v >= CHUNK_COORD_LIMIT) {
    throw new RangeError(`chunk ${name} out of range: ${v}`);
  }
}

/**
 * Palettes larger than this go raw without finishing the scan. Real chunks hold a few dozen
 * distinct cells; only synthetic noise gets here, where building a huge palette map would
 * cost milliseconds for (at best) a marginal gain. Choosing raw is always a valid encoding.
 */
const PALETTE_BAIL = 4096;

/** Serialise a chunk's cells (not light). Typical terrain: a few hundred bytes to a few KB. */
export function encodeChunk(chunk: Chunk): Uint8Array {
  const cells = chunk.cells;
  // Local copy: an imported binding can be a live-binding getter in dev/test transforms,
  // which would sit inside the 32768-iteration loop below.
  const n = CHUNK_VOLUME;
  checkChunkCoord(chunk.cx, 'cx');
  checkChunkCoord(chunk.cz, 'cz');
  if (cells.length !== n) throw new RangeError(`chunk has ${cells.length} cells, expected ${n}`);

  // The only pass over the cells: collect runs (palette index + length) and the palette in
  // first-appearance order. The per-cell work is one load and one compare; the map is only
  // touched at run boundaries. Bail out to raw as soon as even a 1-byte-per-run lower bound
  // cannot beat it (noise-like chunks).
  const paletteIndex = new Map<number, number>();
  const palette: number[] = [];
  const runIndex: number[] = [];
  const runLength: number[] = [];
  let prev = cells[0]!;
  let prevIndex = 0;
  paletteIndex.set(prev, 0);
  palette.push(prev);
  let start = 0;
  let rle = true;
  for (let i = 1; i < n; i++) {
    const v = cells[i]!;
    if (v === prev) continue;
    runIndex.push(prevIndex);
    runLength.push(i - start);
    start = i;
    prev = v;
    let index = paletteIndex.get(v);
    if (index === undefined) {
      index = palette.length;
      paletteIndex.set(v, index);
      palette.push(v);
      if (index >= PALETTE_BAIL) {
        rle = false;
        break;
      }
    }
    prevIndex = index;
    if (runIndex.length + palette.length * 2 >= RAW_CELL_BYTES) {
      rle = false;
      break;
    }
  }

  let rleBytes = 0;
  const bits = bitLength(palette.length - 1);
  if (rle) {
    runIndex.push(prevIndex);
    runLength.push(n - start);
    // Exact RLE size, so the choice below is never worse than raw.
    rleBytes = varuintSize(palette.length) + palette.length * 2;
    for (let k = 0; k < runIndex.length; k++) rleBytes += varuintSize(((runLength[k]! - 1) << bits) | runIndex[k]!);
    rle = rleBytes < RAW_CELL_BYTES;
  }

  const w = beginBlob(BLOB_MAGIC.chunk, 32 + (rle ? rleBytes : RAW_CELL_BYTES));
  w.varint(chunk.cx).varint(chunk.cz);
  if (rle) {
    w.u8(CHUNK_RLE).varuint(palette.length);
    for (let k = 0; k < palette.length; k++) w.u16(palette[k]!);
    for (let k = 0; k < runIndex.length; k++) w.varuint(((runLength[k]! - 1) << bits) | runIndex[k]!);
  } else {
    w.u8(CHUNK_RAW).u16Array(cells);
  }
  return sealBlob(w);
}

/**
 * Inverse of encodeChunk. Throws SaveFormatError on malformed or corrupted data and
 * SaveVersionError (a SaveFormatError) on data from a newer build.
 */
export function decodeChunk(bytes: Uint8Array): DecodedChunk {
  const { reader: r } = openBlob(bytes, BLOB_MAGIC.chunk, 'chunk');
  const cx = r.varint();
  const cz = r.varint();
  if (cx < -CHUNK_COORD_LIMIT || cx >= CHUNK_COORD_LIMIT || cz < -CHUNK_COORD_LIMIT || cz >= CHUNK_COORD_LIMIT) {
    r.fail(`chunk coordinates out of range (${cx}, ${cz})`);
  }
  const encoding = r.u8();
  let cells: Uint16Array;
  if (encoding === CHUNK_RLE) {
    const volume = CHUNK_VOLUME; // local: see encodeChunk
    const n = r.count(2);
    if (n < 1 || n > volume) r.fail(`invalid palette size ${n}`);
    const palette = new Uint16Array(n);
    for (let k = 0; k < n; k++) palette[k] = r.u16();
    const bits = bitLength(n - 1);
    const mask = (1 << bits) - 1;
    const tokenLimit = volume * 2 ** bits; // tokens are below this, so bit ops are safe
    cells = new Uint16Array(volume);
    let filled = 0;
    while (filled < volume) {
      const token = r.varuint();
      if (token >= tokenLimit) r.fail(`run token ${token} out of range`);
      const index = token & mask;
      const len = (token >>> bits) + 1;
      if (index >= n) r.fail(`palette index ${index} out of range (palette has ${n})`);
      if (len > volume - filled) r.fail(`run of ${len} cells overflows the chunk (${filled} filled)`);
      const v = palette[index]!;
      if (v !== 0) cells.fill(v, filled, filled + len); // fresh array is already air
      filled += len;
    }
  } else if (encoding === CHUNK_RAW) {
    cells = r.u16Array();
    if (cells.length !== CHUNK_VOLUME) r.fail(`raw chunk has ${cells.length} cells, expected ${CHUNK_VOLUME}`);
  } else {
    return r.fail(`unknown chunk encoding ${encoding}`);
  }
  r.expectEnd();
  return { cx, cz, cells };
}

// ====================================================================== scheduled ticks
//
// Payload v1:
//   varuint count
//   count x { varint dx, varint dy, varint dz (delta to the previous tick's position,
//             starting from 0,0,0), varuint id, varuint delay (>= 1) }
//
// Order is preserved exactly: TickQueue fires same-tick entries in scheduling order, and
// liquid spreading must replay identically after a load. Pending ticks are spatially
// coherent (a spreading pool), so position deltas are mostly 1-byte varints.
// Absolute times are not stored: `delay = at - now` makes ticks independent of the world
// clock base, and overdue ticks (at <= now) are clamped to fire on the very next tick.

/** posKey() supports world x/z in [-TICK_XZ_LIMIT, TICK_XZ_LIMIT). */
const TICK_XZ_LIMIT = 0x400000;
const MIN_TICK_BYTES = 5;

function tickProblem(x: number, y: number, z: number, id: number): string | null {
  if (!Number.isInteger(x) || x < -TICK_XZ_LIMIT || x >= TICK_XZ_LIMIT) return `x ${x} out of range`;
  if (!Number.isInteger(z) || z < -TICK_XZ_LIMIT || z >= TICK_XZ_LIMIT) return `z ${z} out of range`;
  if (!Number.isInteger(y) || y < 0 || y >= WORLD_HEIGHT) return `y ${y} out of range`;
  if (!Number.isInteger(id) || id < 0 || id > MAX_BLOCK_ID) return `block id ${id} out of range`;
  return null;
}

/** Serialise pending block ticks relative to the current world tick `now`. */
export function encodeTicks(ticks: readonly ScheduledTick[], now: number): Uint8Array {
  if (!Number.isSafeInteger(now)) throw new RangeError(`now must be a safe integer, got ${now}`);
  const w = beginBlob(BLOB_MAGIC.ticks, 16 + ticks.length * 6);
  w.varuint(ticks.length);
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    const problem = tickProblem(t.x, t.y, t.z, t.id);
    if (problem) throw new RangeError(`tick ${i}: ${problem}`);
    if (!Number.isSafeInteger(t.at)) throw new RangeError(`tick ${i}: time ${t.at} is not a safe integer`);
    const delay = Math.max(1, t.at - now);
    if (!Number.isSafeInteger(delay)) throw new RangeError(`tick ${i}: delay ${delay} is not a safe integer`);
    w.varint(t.x - px).varint(t.y - py).varint(t.z - pz).varuint(t.id).varuint(delay);
    px = t.x;
    py = t.y;
    pz = t.z;
  }
  return sealBlob(w);
}

/** Inverse of encodeTicks: absolute times are rebuilt as `now + delay`, order is preserved. */
export function decodeTicks(bytes: Uint8Array, now: number): ScheduledTick[] {
  if (!Number.isSafeInteger(now)) throw new RangeError(`now must be a safe integer, got ${now}`);
  const { reader: r } = openBlob(bytes, BLOB_MAGIC.ticks, 'ticks');
  const n = r.count(MIN_TICK_BYTES);
  const out: ScheduledTick[] = [];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    x += r.varint();
    y += r.varint();
    z += r.varint();
    const id = r.varuint();
    const problem = tickProblem(x, y, z, id);
    if (problem) r.fail(`tick ${i}: ${problem}`);
    const delay = r.varuint();
    if (delay < 1) r.fail(`tick ${i}: delay must be >= 1`);
    const at = now + delay;
    if (!Number.isSafeInteger(at)) r.fail(`tick ${i}: time overflows`);
    out.push({ x, y, z, id, at });
  }
  r.expectEnd();
  return out;
}

// ====================================================================== world meta

/** Descriptive record of one saved world (the world list shows these). */
export interface WorldMeta {
  /** Stable unique id; key of every record of this world. 1..128 characters. */
  id: string;
  /** Display name (<= 256 characters). */
  name: string;
  /** The seed text the player typed (<= 256 characters). */
  seed: string;
  /** The uint32 actually used to generate the world. */
  seedHash: number;
  mode: 'creative' | 'survival';
  /** ms since epoch, supplied by the client (the simulation has no clock). */
  createdAt: number;
  /** ms since epoch, supplied by the client. */
  lastPlayed: number;
  /**
   * SAVE_VERSION the world was last written with. Write SAVE_VERSION; a stored value above
   * it means a newer build saved the world (isNewerSave): list it, but do not load or save it.
   */
  version: number;
  /** World tick. */
  time: number;
}

export const META_MAX_ID_LENGTH = 128;
export const META_MAX_NAME_LENGTH = 256;
export const META_MAX_SEED_LENGTH = 256;

/** Wire order of game modes (index stored in meta blobs: append only). */
const MODES: readonly WorldMeta['mode'][] = Object.freeze(['creative', 'survival'] as const);

/** Why `meta` is not a valid WorldMeta, or null when it is. */
export function metaProblem(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return 'meta must be an object';
  const m = meta as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length < 1 || m.id.length > META_MAX_ID_LENGTH) {
    return `id must be a string of 1..${META_MAX_ID_LENGTH} characters`;
  }
  if (typeof m.name !== 'string' || m.name.length > META_MAX_NAME_LENGTH) {
    return `name must be a string of at most ${META_MAX_NAME_LENGTH} characters`;
  }
  if (typeof m.seed !== 'string' || m.seed.length > META_MAX_SEED_LENGTH) {
    return `seed must be a string of at most ${META_MAX_SEED_LENGTH} characters`;
  }
  if (typeof m.seedHash !== 'number' || m.seedHash >>> 0 !== m.seedHash) return 'seedHash must be a uint32';
  if (!MODES.includes(m.mode as WorldMeta['mode'])) return `mode must be 'creative' or 'survival'`;
  if (typeof m.createdAt !== 'number' || !Number.isFinite(m.createdAt) || m.createdAt < 0) {
    return 'createdAt must be a finite number >= 0';
  }
  if (typeof m.lastPlayed !== 'number' || !Number.isFinite(m.lastPlayed) || m.lastPlayed < 0) {
    return 'lastPlayed must be a finite number >= 0';
  }
  if (typeof m.version !== 'number' || !Number.isSafeInteger(m.version) || m.version < 1) {
    return 'version must be an integer >= 1';
  }
  if (typeof m.time !== 'number' || !Number.isSafeInteger(m.time) || m.time < 0) {
    return 'time must be an integer >= 0';
  }
  return null;
}

/** Throw a TypeError unless `meta` is a valid WorldMeta. */
export function validateMeta(meta: unknown): asserts meta is WorldMeta {
  const problem = metaProblem(meta);
  if (problem) throw new TypeError(`invalid world meta: ${problem}`);
}

/** Copy with exactly the WorldMeta fields (drops anything extra). Does not validate. */
export function copyMeta(meta: WorldMeta): WorldMeta {
  return {
    id: meta.id,
    name: meta.name,
    seed: meta.seed,
    seedHash: meta.seedHash,
    mode: meta.mode,
    createdAt: meta.createdAt,
    lastPlayed: meta.lastPlayed,
    version: meta.version,
    time: meta.time,
  };
}

// Payload v1: string id, string name, string seed, u32 seedHash, u8 mode index,
// f64 createdAt, f64 lastPlayed, varuint version, varuint time.

/** Serialise world meta. Throws TypeError when the meta is invalid. */
export function encodeMeta(meta: WorldMeta): Uint8Array {
  validateMeta(meta);
  const w = beginBlob(BLOB_MAGIC.meta, 64 + meta.id.length + meta.name.length * 3 + meta.seed.length * 3);
  w.string(meta.id).string(meta.name).string(meta.seed);
  w.u32(meta.seedHash).u8(MODES.indexOf(meta.mode));
  w.f64(meta.createdAt).f64(meta.lastPlayed);
  w.varuint(meta.version).varuint(meta.time);
  return sealBlob(w);
}

/** Inverse of encodeMeta; the result is validated (SaveFormatError when invalid). */
export function decodeMeta(bytes: Uint8Array): WorldMeta {
  const { reader: r } = openBlob(bytes, BLOB_MAGIC.meta, 'world meta');
  const id = r.string();
  const name = r.string();
  const seed = r.string();
  const seedHash = r.u32();
  const modeIndex = r.u8();
  const mode = MODES[modeIndex];
  if (mode === undefined) r.fail(`unknown game mode ${modeIndex}`);
  const createdAt = r.f64();
  const lastPlayed = r.f64();
  const version = r.varuint();
  const time = r.varuint();
  r.expectEnd();
  const meta: WorldMeta = { id, name, seed, seedHash, mode, createdAt, lastPlayed, version, time };
  const problem = metaProblem(meta);
  if (problem) throw new SaveFormatError(`world meta: ${problem}`);
  return meta;
}
