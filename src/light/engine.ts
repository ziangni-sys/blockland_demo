/**
 * Voxel lighting: sky light + block light, both 0..15, stored in Chunk.light
 * (sky = high nibble, block = low nibble).
 *
 * THE MODEL. Light is the unique fixed point of a local rule, so "correct" never depends on
 * the order in which chunks were added or edits were processed:
 *
 *   block(c) = max(EMIT(c),  max over neighbours n of  block(n) - cost(c))
 *   sky(c)   = max(skySrc(c), max over neighbours n of  sky(n) - cost(c),
 *                             sky(cell above) when c has lightOpacity 0)      <- straight down, lossless
 *
 *   cost(c) = max(1, lightOpacity(c)); cells with lightOpacity >= 15 receive nothing.
 *   skySrc(c) = 15 at or above the column's heightmap (open sky). Above the world there is a
 *   virtual all-15 layer, which is why an attenuating cell at the top layer gets 15 - cost.
 *
 * Every step costs >= 1 except "straight down through a transparent cell", and those free
 * edges only go down, so every cycle has positive cost and the fixed point is unique. The
 * engine and the brute-force reference in the tests are two ways of reaching it.
 *
 * WHICH CHUNKS EXIST. Only chunks this engine has lit (initChunk) and that are still the
 * world's chunk at their position take part: no light enters or leaves any other chunk and
 * the engine never writes into one. The engine keeps its own registry of lit chunks and, at
 * the start of every update() and initChunk(), notices chunks that left the world (or are
 * being re-initialised) and relights their lit neighbours without them (see "orphans"
 * below). So unloading needs no hook, and the light is always the fixed point of the chunks
 * that are present: when an unloaded chunk comes back, initChunk pulls its light back in.
 *
 * SUPPORT. The incremental algorithm keeps this invariant between calls: every cell brighter
 * than its own source is either SUPPORTED (some present neighbour n has
 * level(n) - cost(c) >= level(c), or is directly above a transparent c with level(n) >=
 * level(c) for sky) or COVERED (a queued removal entry (r, o) next to it could have supported
 * it, by the same test with o as r's level). Support strictly increases (level, height), so
 * support chains cannot loop: once the removal queue is empty every value is reachable from a
 * real source, i.e. never too bright, and the addition queue then makes it never too dark.
 *
 * INCREMENTAL UPDATES (cellChanged + update):
 *  - cellChanged reads the cell as it is NOW (never the event's old/new arguments, which are
 *    stale when another listener rewrote the cell first) and computes what the cell's own
 *    source and its neighbours give it. If that does not lower the cell, raise and flood fill.
 *    Otherwise reset the cell to its bare source and queue a removal.
 *  - Removal (classic removal BFS): every neighbour the removed level could have supported is
 *    reset to its source and removed in turn; every other lit neighbour is re-seeded so the
 *    hole refills. Removing too much is always safe (supporters are re-seeded); too little
 *    never happens. That is what makes budgeted, interleaved processing safe.
 *  - Raising a column's heightmap removes the open-sky status of every cell between the old
 *    top and the new block; each of those cells is reset and removed explicitly. Lowering it
 *    needs nothing special: the cell that changed becomes a 15 source and its flood fill falls
 *    losslessly down the newly opened clear cells.
 *  - Orphans: when a chunk disappears, a lit neighbour's border cell facing it that is no
 *    longer supported by anything else is reset and removed like any other unsupported cell.
 *    Only border cells can lose support that way; everything further in is covered through
 *    them. Re-initialising a lit chunk first orphans its neighbours the same way, so stale
 *    light that the chunk used to feed them is never pulled back in.
 *
 * QUEUES. Both additions and removals use bucket queues keyed by light level, processed from
 * 15 down. For additions this makes the BFS behave like Dijkstra (most cells are settled on
 * their first visit even with mixed costs). For removals it means a wave is reset in order of
 * decreasing level, so a lit neighbour is only ever re-seeded once the brighter cells that
 * could have fed it have been reset (with a stack, depth-first order kept re-seeding cells
 * that were about to be removed anyway). All queues are growable flat Int32Array stacks of
 * (x, y, z) world coordinates owned by the engine instance; there are no per-cell objects.
 * Chunks are resolved through a small direct-mapped cache, so inner loops do no Map lookups.
 *
 * DIRTY MARKING. Light is written straight into chunk.light. Which mesh sections that makes
 * stale follows World.markDirty exactly (the cell's section, plus the neighbouring sections
 * when the cell lies on a section border, since meshing reads a 1-cell margin), but instead
 * of a markDirty call per changed cell the engine ORs a 27-bit "affected neighbour sections"
 * mask per section (per-cell markDirty was about half the cost of placing a lamp).
 * The masks are handed to world.markDirty only when the engine has no pending work: a
 * removal that runs out of budget leaves cells reset but not yet refilled, and meshing that
 * intermediate state would flash dark for a tick. If the engine stays busy for
 * MAX_DEFERRED_UPDATES update() calls in a row it flushes anyway, so meshes never freeze.
 * initChunk writes a newly added chunk's own light without marking (addChunk already marked
 * all of its sections) but marks every cell it changes in neighbouring chunks, and every cell
 * whose byte changed when it re-initialises an already lit chunk.
 */
import * as K from '../core/constants';
import { ID_MASK as CELL_ID_MASK } from '../blocks/cell';
import { EMIT as EMIT_TABLE, LIGHT_OPACITY as OPACITY_TABLE } from '../blocks/registry';
import { chunkKey as chunkKeyOf, type Chunk } from '../voxel/chunk';
import type { World } from '../voxel/world';

// Module-level copies of everything imported that the per-cell loops touch. Some module
// runners (vite-node / vitest, i.e. every headless test) turn each use of an imported binding
// into a namespace getter call; that tripled initChunk's cost. Plain consts are free
// everywhere. The tables are filled once at startup by the block registry and never change.
const LIGHT_OPACITY = OPACITY_TABLE;
const EMIT = EMIT_TABLE;
const ID_MASK = CELL_ID_MASK;
const chunkKey = chunkKeyOf;
const CHUNK_SHIFT = K.CHUNK_SHIFT;
const CHUNK_SIZE = K.CHUNK_SIZE;
const CHUNK_VOLUME = K.CHUNK_VOLUME;
const MAX_LIGHT = K.MAX_LIGHT;
const SECTION_SIZE = K.SECTION_SIZE;
const SECTIONS_PER_CHUNK = K.SECTIONS_PER_CHUNK;

// Chunk cell index = lx | lz << 4 | y << 8 (voxel/chunk.ts). The offsets below follow from it.
const TOP_Y = K.WORLD_HEIGHT - 1;
const COLUMNS = CHUNK_SIZE * CHUNK_SIZE;
const DY = COLUMNS; // index step for y +/- 1
const DZ = CHUNK_SIZE; // index step for z +/- 1
const EDGE = CHUNK_SIZE - 1;
const WRAP_X = EDGE; // index delta from lx = 0 to lx = 15 in the neighbouring chunk
const WRAP_Z = EDGE * DZ; // index delta from lz = 0 to lz = 15 in the neighbouring chunk
const OPAQUE_LEVEL = 15;

/** Direct-mapped tables keyed by chunk: 8 x 8 slots indexed by the low chunk-coordinate bits. */
const SLOT_BITS = 3;
const SLOT_MASK = (1 << SLOT_BITS) - 1;
const SLOTS = 1 << (2 * SLOT_BITS);

/**
 * Consecutive update() calls that may end with work still pending before the dirty sections
 * collected so far are flushed anyway (one second at 20 ticks per second). Only a sustained
 * overload of the per-call budget gets here; normally every call ends with nothing pending.
 */
const MAX_DEFERRED_UPDATES = 20;

// ---- dirty-section masks (immutable lookup tables)
// A bit b in 0..26 stands for the section at offset (b % 3 - 1, floor(b / 3) % 3 - 1,
// floor(b / 9) - 1) in (x, y, z) from the section that owns the mask.
/** Per coordinate within a section (0..15): 0 interior, 1 low border, 2 high border. */
const BORDER_CLASS = new Uint8Array(SECTION_SIZE);
BORDER_CLASS[0] = 1;
BORDER_CLASS[SECTION_SIZE - 1] = 2;
/** Sections a changed cell affects, by border class x + 3 y + 9 z (same rule as World.markDirty). */
const CLASS_MASK = new Int32Array(27);
const BIT_DX = new Int8Array(27);
const BIT_DY = new Int8Array(27);
const BIT_DZ = new Int8Array(27);
for (let b = 0; b < 27; b++) {
  BIT_DX[b] = (b % 3) - 1;
  BIT_DY[b] = (Math.floor(b / 3) % 3) - 1;
  BIT_DZ[b] = Math.floor(b / 9) - 1;
}
for (let cls = 0; cls < 27; cls++) {
  const offsets = (k: number): number[] => (k === 0 ? [0] : k === 1 ? [0, -1] : [0, 1]);
  let m = 0;
  for (const dx of offsets(cls % 3)) {
    for (const dy of offsets(Math.floor(cls / 3) % 3)) {
      for (const dz of offsets(Math.floor(cls / 9))) m |= 1 << (dx + 1 + 3 * (dy + 1) + 9 * (dz + 1));
    }
  }
  CLASS_MASK[cls] = m;
}

/** Light lost entering a cell of the given opacity (callers exclude opacity >= 15). */
function stepCost(op: number): number {
  return op > 1 ? op : 1;
}

/**
 * Open-sky source level of a cell: 15 at/above the heightmap. Below it the only source is the
 * virtual layer above the world, which reaches the top layer through one attenuating step.
 */
function skySource(y: number, height: number, op: number): number {
  if (y >= height) return MAX_LIGHT;
  if (y === TOP_Y && op < OPAQUE_LEVEL) return MAX_LIGHT - stepCost(op);
  return 0;
}

/** Growable LIFO of int triples. */
class TripleStack {
  data: Int32Array;
  /** Number of triples stored. */
  size = 0;

  constructor(initialTriples: number) {
    this.data = new Int32Array(initialTriples * 3);
  }

  push(a: number, b: number, c: number): void {
    const k = this.size * 3;
    if (k + 3 > this.data.length) this.grow();
    const d = this.data;
    d[k] = a;
    d[k + 1] = b;
    d[k + 2] = c;
    this.size++;
  }

  private grow(): void {
    const next = new Int32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }
}

/** Bucket queue of (x, y, z) keyed by light level 1..15; pops from the highest level. */
class LevelQueue {
  readonly buckets: TripleStack[] = [];
  /** Upper bound of the highest non-empty bucket. */
  top = 0;
  total = 0;

  constructor(initialTriples: number) {
    for (let l = 0; l <= MAX_LIGHT; l++) this.buckets.push(new TripleStack(l === 0 ? 1 : initialTriples));
  }

  push(level: number, x: number, y: number, z: number): void {
    this.buckets[level]!.push(x, y, z);
    if (level > this.top) this.top = level;
    this.total++;
  }
}

export class LightEngine {
  private readonly world: World;

  // Incremental work, per channel. Removal entries are keyed by the level the cell had
  // before it was reset; addition entries by the level it was raised to.
  private readonly skyRem = new LevelQueue(64);
  private readonly blockRem = new LevelQueue(64);
  private readonly skyAdd = new LevelQueue(64);
  private readonly blockAdd = new LevelQueue(64);
  // Private queues of initChunk, always drained before it returns.
  private readonly initSky = new LevelQueue(64);
  private readonly initBlock = new LevelQueue(64);
  /** Per column of the chunk being initialised: highest y whose straight-down sky is 0, or -1. */
  private readonly darkFrom = new Int16Array(COLUMNS);
  /** Light bytes of a chunk being re-initialised, to mark exactly the cells that changed. */
  private reinitBefore: Uint8Array | null = null;

  /** Every chunk this engine has lit, by chunk key. A chunk only exists for lighting while it is here AND still the world's chunk. */
  private readonly litChunks = new Map<number, Chunk>();
  /** Scratch for syncChunks(): coordinates of chunks found gone (pairs). */
  private readonly goneCoords: number[] = [];

  // Lit-chunk lookup cache.
  private readonly cacheChunk: Array<Chunk | null> = new Array<Chunk | null>(SLOTS).fill(null);
  private readonly cacheCx = new Int32Array(SLOTS);
  private readonly cacheCz = new Int32Array(SLOTS);
  private readonly cacheGen = new Float64Array(SLOTS);
  /** Bumped at every public call and whenever chunks may have been added, removed or lit. */
  private gen = 1;

  // Pending dirty-section masks (see DIRTY MARKING). The direct-mapped slots serve the hot
  // path; a chunk evicted from its slot by another chunk spills its masks into `dirtySpill`.
  private readonly dirtyOwner: Array<Chunk | null> = new Array<Chunk | null>(SLOTS).fill(null);
  private readonly dirtyMask = new Int32Array(SLOTS * SECTIONS_PER_CHUNK);
  private readonly dirtySlots = new Int32Array(SLOTS);
  private dirtySlotCount = 0;
  private readonly dirtySpill = new Map<Chunk, Int32Array>();
  /** update() calls in a row that ended with work pending and did not flush. */
  private deferredUpdates = 0;

  private detach: (() => void) | null = null;

  constructor(world: World) {
    this.world = world;
  }

  /** Number of queued incremental entries (both channels, removals + additions). */
  get pending(): number {
    return this.skyRem.total + this.blockRem.total + this.skyAdd.total + this.blockAdd.total;
  }

  /**
   * Subscribe to world.onCellChange so edits enqueue incremental updates. Returns the
   * unsubscribe function. Calling it again while attached returns the same function. The
   * engine does not need to be the first listener: it always reads the cell's current state.
   */
  attach(): () => void {
    if (!this.detach) {
      const off = this.world.onCellChange((x, y, z, oldCell, newCell) => this.cellChanged(x, y, z, oldCell, newCell));
      this.detach = () => {
        off();
        this.detach = null;
      };
    }
    return this.detach;
  }

  // ================================================================== chunk initialisation

  /**
   * Full lighting of a newly added chunk: heightmap, sky light, block light, and exchange with
   * already-lit neighbour chunks across its 4 vertical borders (light flows both ways).
   * Sets chunk.lit = true. Call right after world.addChunk(chunk).
   *
   * Calling it again on a lit chunk recomputes the chunk from its cells as if it had been
   * removed and added again (neighbours included); the cells whose light changed are marked.
   */
  initChunk(chunk: Chunk): void {
    if (this.world.getChunk(chunk.cx, chunk.cz) !== chunk) {
      throw new Error(`LightEngine.initChunk: chunk ${chunk.cx},${chunk.cz} is not the world's chunk at that position`);
    }
    const key = chunkKey(chunk.cx, chunk.cz);
    const cells = chunk.cells;
    const light = chunk.light;
    const hm = chunk.heightmap;
    const reinit = chunk.lit || this.litChunks.get(key) === chunk;
    if (reinit) {
      if (!this.reinitBefore) this.reinitBefore = new Uint8Array(CHUNK_VOLUME);
      this.reinitBefore.set(light);
    }
    // Absent for lighting until its fresh light is in place. If it was lit, syncChunks()
    // orphans what its neighbours got from it, together with any chunk that left the world.
    chunk.lit = false;
    this.syncChunks();

    const ox = chunk.cx << CHUNK_SHIFT;
    const oz = chunk.cz << CHUNK_SHIFT;
    const skyQ = this.initSky;
    const blockQ = this.initBlock;
    const darkFrom = this.darkFrom;

    // Pass 1, one top-down walk per column: heightmap, straight-down sky light, emitters.
    // Every light byte is rewritten, so stale data (e.g. from a save) never survives.
    light.fill(0);
    for (let col = 0; col < COLUMNS; col++) {
      const wx = ox + (col & EDGE);
      const wz = oz + (col >> 4);
      let level = MAX_LIGHT;
      let height = 0;
      let y = TOP_Y;
      for (; y >= 0; y--) {
        const i = col | (y * DY);
        const id = cells[i]! & ID_MASK;
        const op = LIGHT_OPACITY[id]!;
        if (op !== 0) {
          if (height === 0) height = y + 1;
          level = op >= OPAQUE_LEVEL ? 0 : level - stepCost(op);
          if (level < 0) level = 0;
        }
        const e = EMIT[id]!;
        light[i] = (level << 4) | e;
        if (e > 1) blockQ.push(e, wx, y, wz);
        if (level === 0) break;
      }
      // The first opacity > 0 cell is at or above the point where the sky ran out.
      hm[col] = height;
      darkFrom[col] = y;
      // Below that the straight-down sky is 0: only emitters remain to be found.
      for (y--; y >= 0; y--) {
        const i = col | (y * DY);
        const e = EMIT[cells[i]! & ID_MASK]!;
        if (e !== 0) {
          light[i] = e;
          if (e > 1) blockQ.push(e, wx, y, wz);
        }
      }
    }

    // Pass 2, sideways seeds. After pass 1 the column values never increase going down, so
    // nothing can flow downward or upward yet; the only possible gains are sideways into a
    // neighbour column BELOW ITS heightmap (above it everything is already 15). So a cell
    // can only be a donor when it is lit (>= 2) and below the highest in-chunk neighbour
    // heightmap. Cross-border flow is handled by the exchange below.
    for (let col = 0; col < COLUMNS; col++) {
      const lx = col & EDGE;
      const lz = col >> 4;
      let top = 0;
      if (lx > 0 && hm[col - 1]! > top) top = hm[col - 1]!;
      if (lx < EDGE && hm[col + 1]! > top) top = hm[col + 1]!;
      if (lz > 0 && hm[col - DZ]! > top) top = hm[col - DZ]!;
      if (lz < EDGE && hm[col + DZ]! > top) top = hm[col + DZ]!;
      for (let y = darkFrom[col]! + 1; y < top; y++) {
        const v = light[col | (y * DY)]! >> 4;
        if (v >= 2) skyQ.push(v, ox + lx, y, oz + lz);
      }
    }

    chunk.lit = true;
    this.litChunks.set(key, chunk);
    this.gen++;

    // Exchange across the 4 vertical borders with lit neighbours, both directions, both channels.
    const w = this.chunkAt(chunk.cx - 1, chunk.cz);
    if (w) this.exchange(chunk, w, 0, EDGE, DZ);
    const e = this.chunkAt(chunk.cx + 1, chunk.cz);
    if (e) this.exchange(chunk, e, EDGE, 0, DZ);
    const n = this.chunkAt(chunk.cx, chunk.cz - 1);
    if (n) this.exchange(chunk, n, 0, WRAP_Z, 1);
    const s = this.chunkAt(chunk.cx, chunk.cz + 1);
    if (s) this.exchange(chunk, s, WRAP_Z, 0, 1);

    // One BFS per channel from every seed at once: bucket order finalises most cells on
    // their first visit. It may cross into lit neighbours (marking them dirty).
    this.runAdd(skyQ, true, Infinity, chunk);
    this.runAdd(blockQ, false, Infinity, chunk);

    if (reinit) {
      // No addChunk marked this chunk's sections for us.
      const before = this.reinitBefore!;
      for (let i = 0; i < CHUNK_VOLUME; i++) if (before[i] !== light[i]) this.touch(chunk, i);
    }
    this.finishCall(false);
  }

  /**
   * Compare every border cell pair of `a` (the chunk being initialised) and neighbour `b` and
   * raise whichever side can receive more from the other. Columns: a's border column t is
   * baseA + t * stride, its partner in b is baseB + t * stride.
   */
  private exchange(a: Chunk, b: Chunk, baseA: number, baseB: number, stride: number): void {
    const aCells = a.cells;
    const aLight = a.light;
    const bCells = b.cells;
    const bLight = b.light;
    const aox = a.cx << CHUNK_SHIFT;
    const aoz = a.cz << CHUNK_SHIFT;
    const box = b.cx << CHUNK_SHIFT;
    const boz = b.cz << CHUNK_SHIFT;
    const skyQ = this.initSky;
    const blockQ = this.initBlock;
    for (let t = 0; t < CHUNK_SIZE; t++) {
      const colA = baseA + t * stride;
      const colB = baseB + t * stride;
      const ax = aox + (colA & EDGE);
      const az = aoz + (colA >> 4);
      const bx = box + (colB & EDGE);
      const bz = boz + (colB >> 4);
      for (let y = 0; y <= TOP_Y; y++) {
        const ia = colA | (y * DY);
        const ib = colB | (y * DY);
        const la = aLight[ia]!;
        const lb = bLight[ib]!;
        // Equal bytes cannot flow either way (every sideways step costs >= 1). This skips
        // the solid underground and the open sky in one compare.
        if (la === lb) continue;
        const sa = la >> 4;
        const ba = la & 15;
        const sb = lb >> 4;
        const bb = lb & 15;

        const opA = LIGHT_OPACITY[aCells[ia]! & ID_MASK]!;
        if (opA < OPAQUE_LEVEL) {
          const cost = stepCost(opA);
          const vs = sb - cost;
          const vb = bb - cost;
          if (vs > sa || vb > ba) {
            aLight[ia] = ((vs > sa ? vs : sa) << 4) | (vb > ba ? vb : ba);
            if (vs > sa) skyQ.push(vs, ax, y, az);
            if (vb > ba && vb > 1) blockQ.push(vb, ax, y, az);
          }
        }

        const opB = LIGHT_OPACITY[bCells[ib]! & ID_MASK]!;
        if (opB < OPAQUE_LEVEL) {
          const cost = stepCost(opB);
          // Use a's values from before this pair's pull: a value just pulled from b can never
          // flow back into b (it is at least 2 below b's own).
          const vs = sa - cost;
          const vb = ba - cost;
          if (vs > sb || vb > bb) {
            bLight[ib] = ((vs > sb ? vs : sb) << 4) | (vb > bb ? vb : bb);
            this.touch(b, ib);
            if (vs > sb) skyQ.push(vs, bx, y, bz);
            if (vb > bb && vb > 1) blockQ.push(vb, bx, y, bz);
          }
        }
      }
    }
  }

  // ================================================================== chunks leaving

  /**
   * Forget every registered chunk that is no longer the world's lit chunk at its position
   * (removed, replaced, or flagged unlit for re-initialisation) and orphan the border light of
   * its lit neighbours. One map walk over the lit chunks; called once per update() and
   * initChunk(), never per edit.
   */
  private syncChunks(): void {
    const gone = this.goneCoords;
    for (const [key, c] of this.litChunks) {
      const present = this.world.getChunk(c.cx, c.cz) === c;
      if (present && c.lit) continue;
      // A chunk object that left the world keeps no maintained light: if it is ever added
      // again it must go through initChunk.
      if (!present) c.lit = false;
      this.litChunks.delete(key);
      gone.push(c.cx, c.cz);
    }
    this.gen++;
    if (gone.length === 0) return;
    for (let k = 0; k < gone.length; k += 2) {
      const cx = gone[k]!;
      const cz = gone[k + 1]!;
      // Each neighbour's border column facing the departed chunk.
      const w = this.chunkAt(cx - 1, cz);
      if (w) this.orphanBorder(w, EDGE, DZ);
      const e = this.chunkAt(cx + 1, cz);
      if (e) this.orphanBorder(e, 0, DZ);
      const n = this.chunkAt(cx, cz - 1);
      if (n) this.orphanBorder(n, WRAP_Z, 1);
      const s = this.chunkAt(cx, cz + 1);
      if (s) this.orphanBorder(s, 0, 1);
    }
    gone.length = 0;
  }

  /**
   * A neighbouring chunk is gone: each cell of column base + t * stride (t = 0..15) of `c`
   * that is brighter than its own source and no longer supported by any present neighbour is
   * reset and queued for removal. Cells deeper inside `c` that the departed chunk fed are
   * reached through these, by the removal pass.
   */
  private orphanBorder(c: Chunk, base: number, stride: number): void {
    const cells = c.cells;
    const light = c.light;
    const ox = c.cx << CHUNK_SHIFT;
    const oz = c.cz << CHUNK_SHIFT;
    for (let t = 0; t < CHUNK_SIZE; t++) {
      const col = base + t * stride;
      const x = ox + (col & EDGE);
      const z = oz + (col >> 4);
      const height = c.heightmap[col]!;
      for (let y = 0; y <= TOP_Y; y++) {
        const i = col | (y * DY);
        const lb = light[i]!;
        if (lb === 0) continue;
        const id = cells[i]! & ID_MASK;
        const op = LIGHT_OPACITY[id]!;
        const s = lb >> 4;
        if (s > 0) {
          const src = skySource(y, height, op);
          if (s > src && this.pull(c, i, x, y, z, op, true) < s) this.reset(c, i, x, y, z, s, src, true);
        }
        const b = lb & 15;
        if (b > 0) {
          const src = EMIT[id]!;
          if (b > src && this.pull(c, i, x, y, z, op, false) < b) this.reset(c, i, x, y, z, b, src, false);
        }
      }
    }
  }

  // ================================================================== incremental updates

  /**
   * A cell changed (attach() wires this to the world hook). Only the position and whether
   * the block id's opacity / emission changed are taken from the arguments; the cell's light
   * properties are read from the chunk, so out-of-order delivery (another listener rewrote
   * the cell before this event reached the engine) is harmless.
   */
  cellChanged(x: number, y: number, z: number, oldCell: number, newCell: number): void {
    if (y < 0 || y > TOP_Y) return;
    const oldId = oldCell & ID_MASK;
    const newId = newCell & ID_MASK;
    // Opacity and emission are per block id: state-only changes (liquid levels, log axes,
    // facings) are free. Skipping an event whose own arguments do not differ is safe even
    // when events arrive out of order: every change that does differ is processed against
    // the cell's state at processing time, and a run of non-differing changes after that
    // cannot alter opacity or emission.
    if (oldId === newId) return;
    if (LIGHT_OPACITY[oldId]! === LIGHT_OPACITY[newId]! && EMIT[oldId]! === EMIT[newId]!) return;

    this.gen++;
    const c = this.chunkAt(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    // Unlit / unloaded: initChunk will compute everything from the cells it finds.
    if (!c) return;
    const col = (x & EDGE) | ((z & EDGE) << 4);
    const i = col | (y * DY);
    const id = c.cells[i]! & ID_MASK;
    const op = LIGHT_OPACITY[id]!;
    const emit = EMIT[id]!;

    // ---- heightmap (from the cell's current state: correct whatever order events come in)
    const hOld = c.heightmap[col]!;
    let hNew = hOld;
    if (op > 0) {
      if (y >= hOld) hNew = y + 1;
    } else if (y === hOld - 1) {
      let yy = y - 1;
      while (yy >= 0 && LIGHT_OPACITY[c.cells[col | (yy * DY)]! & ID_MASK]! === 0) yy--;
      hNew = yy + 1;
    }
    c.heightmap[col] = hNew;

    // ---- sky
    if (hNew > hOld) {
      // The cell became its column's top: every (clear) cell between the old top and here
      // lost open sky. Reset each one explicitly instead of relying on the removal chain
      // from this cell to reach them, which would assume they currently hold exactly what
      // the chain expects; with budgeted processing they may still be mid-propagation.
      for (let yy = y - 1; yy >= hOld; yy--) {
        const k = col | (yy * DY);
        const l = c.light[k]! >> 4;
        if (l === 0) continue;
        this.writeSky(c, k, 0);
        this.skyRem.push(l, x, yy, z);
      }
    }
    const skySrc = skySource(y, hNew, op);
    this.settle(c, i, x, y, z, c.light[i]! >> 4, Math.max(skySrc, this.pull(c, i, x, y, z, op, true)), skySrc, true);

    // ---- block
    this.settle(c, i, x, y, z, c.light[i]! & 15, Math.max(emit, this.pull(c, i, x, y, z, op, false)), emit, false);
    this.finishCall(false);
  }

  /**
   * Apply the new level of a changed cell. `target` is what the cell's own source and its
   * neighbours (through its new opacity) give it. Neighbours only depend on this cell through
   * its level, so if the level does not drop nothing around it can be over-lit: raise and
   * flood. If it drops, `target` may be fed by light that came from this very cell, so reset
   * to the bare source and remove.
   *
   * (A raise is never self-feeding in a harmful way: a value taken from a neighbour is
   * strictly below that neighbour's, so if the neighbour turns out to be stale its removal
   * chain covers this cell too.)
   */
  private settle(
    c: Chunk,
    i: number,
    x: number,
    y: number,
    z: number,
    old: number,
    target: number,
    source: number,
    sky: boolean,
  ): void {
    if (target >= old) {
      if (target > old) {
        if (sky) this.writeSky(c, i, target);
        else this.writeBlock(c, i, target);
        (sky ? this.skyAdd : this.blockAdd).push(target, x, y, z);
      }
      return;
    }
    this.reset(c, i, x, y, z, old, source, sky);
  }

  /** Reset a cell holding `old` to its own source `src` and queue the removal of what it fed. */
  private reset(c: Chunk, i: number, x: number, y: number, z: number, old: number, src: number, sky: boolean): void {
    if (sky) {
      this.writeSky(c, i, src);
      this.skyRem.push(old, x, y, z);
      if (src > 0) this.skyAdd.push(src, x, y, z);
    } else {
      this.writeBlock(c, i, src);
      this.blockRem.push(old, x, y, z);
      // Level-1 block light cannot travel.
      if (src > 1) this.blockAdd.push(src, x, y, z);
    }
  }

  /** Best level the present neighbours of a cell can give it through opacity `op` (sources excluded). */
  private pull(c: Chunk, i: number, x: number, y: number, z: number, op: number, sky: boolean): number {
    if (op >= OPAQUE_LEVEL) return 0;
    const cost = stepCost(op);
    const shift = sky ? 4 : 0;
    const light = c.light;
    let best = 0;
    if (y < TOP_Y) {
      const v = (light[i + DY]! >> shift) & 15;
      const cand = sky && op === 0 ? v : v - cost;
      if (cand > best) best = cand;
    }
    if (y > 0) {
      const cand = ((light[i - DY]! >> shift) & 15) - cost;
      if (cand > best) best = cand;
    }
    const lx = x & EDGE;
    const lz = z & EDGE;
    const cx = x >> CHUNK_SHIFT;
    const cz = z >> CHUNK_SHIFT;
    let v: number;
    if (lx > 0) v = light[i - 1]!;
    else {
      const n = this.chunkAt(cx - 1, cz);
      v = n ? n.light[i + WRAP_X]! : 0;
    }
    v = ((v >> shift) & 15) - cost;
    if (v > best) best = v;
    if (lx < EDGE) v = light[i + 1]!;
    else {
      const n = this.chunkAt(cx + 1, cz);
      v = n ? n.light[i - WRAP_X]! : 0;
    }
    v = ((v >> shift) & 15) - cost;
    if (v > best) best = v;
    if (lz > 0) v = light[i - DZ]!;
    else {
      const n = this.chunkAt(cx, cz - 1);
      v = n ? n.light[i + WRAP_Z]! : 0;
    }
    v = ((v >> shift) & 15) - cost;
    if (v > best) best = v;
    if (lz < EDGE) v = light[i + DZ]!;
    else {
      const n = this.chunkAt(cx, cz + 1);
      v = n ? n.light[i - WRAP_Z]! : 0;
    }
    v = ((v >> shift) & 15) - cost;
    if (v > best) best = v;
    return best;
  }

  /**
   * Process queued incremental work. budget = max cells to visit this call (default:
   * unlimited). Returns true when nothing is pending.
   *
   * Per channel, removals run before additions so stale light is not spread first (this is
   * an efficiency choice; correctness does not depend on it). A visit is one queue entry.
   */
  update(budget: number = Infinity): boolean {
    this.syncChunks();
    let left = budget;
    if (left > 0 && this.skyRem.total > 0) left -= this.runRemove(this.skyRem, this.skyAdd, true, left);
    if (left > 0 && this.blockRem.total > 0) left -= this.runRemove(this.blockRem, this.blockAdd, false, left);
    if (left > 0 && this.skyRem.total === 0 && this.skyAdd.total > 0) left -= this.runAdd(this.skyAdd, true, left, null);
    if (left > 0 && this.blockRem.total === 0 && this.blockAdd.total > 0) {
      left -= this.runAdd(this.blockAdd, false, left, null);
    }
    this.finishCall(true);
    return this.pending === 0;
  }

  // ================================================================== BFS kernels

  /**
   * Flood-fill increases from the queue, highest level first. An entry whose cell no longer
   * holds the entry's level is stale and skipped: a raise always pushes a fresh entry, and a
   * removal that lowered the cell re-seeds whatever must refill it.
   * Writes into `quiet` (the chunk being initialised) skip dirty marking.
   * Returns the number of entries visited.
   */
  private runAdd(q: LevelQueue, sky: boolean, budget: number, quiet: Chunk | null): number {
    const shift = sky ? 4 : 0;
    const buckets = q.buckets;
    let visits = 0;
    let level = q.top;
    while (visits < budget) {
      while (level > 0 && buckets[level]!.size === 0) level--;
      // q.top stays an upper bound of the highest non-empty bucket: pushes only raise it.
      q.top = level;
      if (level === 0) break;
      const st = buckets[level]!;
      const k = --st.size * 3;
      q.total--;
      const d = st.data;
      const x = d[k]!;
      const y = d[k + 1]!;
      const z = d[k + 2]!;
      visits++;
      const cx = x >> CHUNK_SHIFT;
      const cz = z >> CHUNK_SHIFT;
      const c = this.chunkAt(cx, cz);
      if (!c) continue;
      const lx = x & EDGE;
      const lz = z & EDGE;
      const i = lx | (lz << 4) | (y * DY);
      const l = (c.light[i]! >> shift) & 15;
      if (l !== level) continue;

      if (y > 0) this.offer(c, i - DY, x, y - 1, z, l, sky, true, q, quiet);
      if (y < TOP_Y) this.offer(c, i + DY, x, y + 1, z, l, sky, false, q, quiet);
      if (lx > 0) this.offer(c, i - 1, x - 1, y, z, l, sky, false, q, quiet);
      else {
        const n = this.chunkAt(cx - 1, cz);
        if (n) this.offer(n, i + WRAP_X, x - 1, y, z, l, sky, false, q, quiet);
      }
      if (lx < EDGE) this.offer(c, i + 1, x + 1, y, z, l, sky, false, q, quiet);
      else {
        const n = this.chunkAt(cx + 1, cz);
        if (n) this.offer(n, i - WRAP_X, x + 1, y, z, l, sky, false, q, quiet);
      }
      if (lz > 0) this.offer(c, i - DZ, x, y, z - 1, l, sky, false, q, quiet);
      else {
        const n = this.chunkAt(cx, cz - 1);
        if (n) this.offer(n, i + WRAP_Z, x, y, z - 1, l, sky, false, q, quiet);
      }
      if (lz < EDGE) this.offer(c, i + DZ, x, y, z + 1, l, sky, false, q, quiet);
      else {
        const n = this.chunkAt(cx, cz + 1);
        if (n) this.offer(n, i - WRAP_Z, x, y, z + 1, l, sky, false, q, quiet);
      }
      // Pushes never exceed the level being processed, but stay safe if that ever changes.
      if (q.top > level) level = q.top;
    }
    return visits;
  }

  /** Try to raise one neighbour from a cell at level `l`. `down` = the neighbour is below. */
  private offer(
    c: Chunk,
    idx: number,
    x: number,
    y: number,
    z: number,
    l: number,
    sky: boolean,
    down: boolean,
    q: LevelQueue,
    quiet: Chunk | null,
  ): void {
    const op = LIGHT_OPACITY[c.cells[idx]! & ID_MASK]!;
    if (op >= OPAQUE_LEVEL) return;
    const cand = down && sky && op === 0 ? l : l - stepCost(op);
    if (cand <= 0) return;
    const lb = c.light[idx]!;
    if (sky) {
      if (cand <= lb >> 4) return;
      c.light[idx] = (lb & 0x0f) | (cand << 4);
    } else {
      if (cand <= (lb & 15)) return;
      c.light[idx] = (lb & 0xf0) | cand;
    }
    if (c !== quiet) this.touch(c, idx);
    // Level-1 block light cannot travel; level-1 sky light still falls through clear cells.
    if (cand > 1 || sky) q.push(cand, x, y, z);
  }

  /**
   * Removal BFS, highest old level first. Entry = (cell, bucket = the level it had before it
   * was reset). A lit neighbour that level could have supported (see SUPPORT) and that is
   * above its own source is reset to the source and removed in turn. Every other lit
   * neighbour is independent of the removed light and becomes a seed for re-propagation.
   * Returns the number of entries visited.
   */
  private runRemove(rem: LevelQueue, add: LevelQueue, sky: boolean, budget: number): number {
    const buckets = rem.buckets;
    let visits = 0;
    let level = rem.top;
    while (visits < budget) {
      while (level > 0 && buckets[level]!.size === 0) level--;
      rem.top = level;
      if (level === 0) break;
      const st = buckets[level]!;
      const k = --st.size * 3;
      rem.total--;
      const d = st.data;
      const x = d[k]!;
      const y = d[k + 1]!;
      const z = d[k + 2]!;
      visits++;
      const cx = x >> CHUNK_SHIFT;
      const cz = z >> CHUNK_SHIFT;
      const c = this.chunkAt(cx, cz);
      // The chunk is gone: syncChunks() orphaned whatever its neighbours got from it.
      if (!c) continue;
      const lx = x & EDGE;
      const lz = z & EDGE;
      const i = lx | (lz << 4) | (y * DY);
      const o = level;

      if (y > 0) this.unlight(c, i - DY, x, y - 1, z, o, sky, true, rem, add);
      if (y < TOP_Y) this.unlight(c, i + DY, x, y + 1, z, o, sky, false, rem, add);
      if (lx > 0) this.unlight(c, i - 1, x - 1, y, z, o, sky, false, rem, add);
      else {
        const n = this.chunkAt(cx - 1, cz);
        if (n) this.unlight(n, i + WRAP_X, x - 1, y, z, o, sky, false, rem, add);
      }
      if (lx < EDGE) this.unlight(c, i + 1, x + 1, y, z, o, sky, false, rem, add);
      else {
        const n = this.chunkAt(cx + 1, cz);
        if (n) this.unlight(n, i - WRAP_X, x + 1, y, z, o, sky, false, rem, add);
      }
      if (lz > 0) this.unlight(c, i - DZ, x, y, z - 1, o, sky, false, rem, add);
      else {
        const n = this.chunkAt(cx, cz - 1);
        if (n) this.unlight(n, i + WRAP_Z, x, y, z - 1, o, sky, false, rem, add);
      }
      if (lz < EDGE) this.unlight(c, i + DZ, x, y, z + 1, o, sky, false, rem, add);
      else {
        const n = this.chunkAt(cx, cz + 1);
        if (n) this.unlight(n, i - WRAP_Z, x, y, z + 1, o, sky, false, rem, add);
      }
      // Pushes never exceed the level being processed (a dependent neighbour is at most as
      // bright), but stay safe if that ever changes.
      if (rem.top > level) level = rem.top;
    }
    return visits;
  }

  private unlight(
    c: Chunk,
    idx: number,
    x: number,
    y: number,
    z: number,
    o: number,
    sky: boolean,
    down: boolean,
    rem: LevelQueue,
    add: LevelQueue,
  ): void {
    const lb = c.light[idx]!;
    const nl = sky ? lb >> 4 : lb & 15;
    if (nl === 0) return;
    const id = c.cells[idx]! & ID_MASK;
    const op = LIGHT_OPACITY[id]!;
    const src = sky ? skySource(y, c.heightmap[idx & (COLUMNS - 1)]!, op) : EMIT[id]!;
    // Could the removed level have supported this cell? An opaque cell receives nothing, so
    // any light it holds above its source is unsupported anyway.
    const dependent = op >= OPAQUE_LEVEL || (down && sky && op === 0 ? nl <= o : nl <= o - stepCost(op));
    if (dependent && nl > src) {
      c.light[idx] = sky ? (lb & 0x0f) | (src << 4) : (lb & 0xf0) | src;
      this.touch(c, idx);
      rem.push(nl, x, y, z);
      if (src > 1 || (sky && src > 0)) add.push(src, x, y, z);
    } else if (nl > 1 || sky) {
      add.push(nl, x, y, z);
    }
  }

  // ================================================================== helpers

  private writeSky(c: Chunk, i: number, v: number): void {
    const lb = c.light[i]!;
    const next = (lb & 0x0f) | (v << 4);
    if (next !== lb) {
      c.light[i] = next;
      this.touch(c, i);
    }
  }

  private writeBlock(c: Chunk, i: number, v: number): void {
    const lb = c.light[i]!;
    const next = (lb & 0xf0) | v;
    if (next !== lb) {
      c.light[i] = next;
      this.touch(c, i);
    }
  }

  /** The chunk at chunk coordinates if it exists for lighting (lit by this engine and still in the world), else null. */
  private chunkAt(cx: number, cz: number): Chunk | null {
    const s = (cx & SLOT_MASK) | ((cz & SLOT_MASK) << SLOT_BITS);
    if (this.cacheGen[s] === this.gen && this.cacheCx[s] === cx && this.cacheCz[s] === cz) {
      return this.cacheChunk[s] as Chunk | null;
    }
    const c = this.litChunks.get(chunkKey(cx, cz));
    const lit = c !== undefined && c.lit && this.world.getChunk(cx, cz) === c ? c : null;
    this.cacheChunk[s] = lit;
    this.cacheCx[s] = cx;
    this.cacheCz[s] = cz;
    this.cacheGen[s] = this.gen;
    return lit;
  }

  /** Record that the light of cell `idx` of chunk `c` changed (see DIRTY MARKING). */
  private touch(c: Chunk, idx: number): void {
    const s = (c.cx & SLOT_MASK) | ((c.cz & SLOT_MASK) << SLOT_BITS);
    if (this.dirtyOwner[s] !== c) this.claimDirtySlot(s, c);
    // Chunks are exactly one section wide, so the chunk-local x/z double as section-local.
    const y = idx >> 8;
    this.dirtyMask[s * SECTIONS_PER_CHUNK + ((y / SECTION_SIZE) | 0)] |=
      CLASS_MASK[BORDER_CLASS[idx & EDGE]! + 3 * BORDER_CLASS[y & (SECTION_SIZE - 1)]! + 9 * BORDER_CLASS[(idx >> 4) & EDGE]!]!;
  }

  private claimDirtySlot(s: number, c: Chunk): void {
    const prev = this.dirtyOwner[s];
    if (prev) {
      // Keep the evicted chunk's masks until the next flush (flushing now could mesh an
      // intermediate state, see DIRTY MARKING).
      const base = s * SECTIONS_PER_CHUNK;
      let spill = this.dirtySpill.get(prev);
      if (!spill) {
        spill = new Int32Array(SECTIONS_PER_CHUNK);
        this.dirtySpill.set(prev, spill);
      }
      for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
        spill[sy] |= this.dirtyMask[base + sy]!;
        this.dirtyMask[base + sy] = 0;
      }
    } else {
      this.dirtySlots[this.dirtySlotCount++] = s;
    }
    this.dirtyOwner[s] = c;
  }

  /** Mark every section recorded in `masks[offset .. offset + SECTIONS_PER_CHUNK)` for chunk (cx, cz) dirty, and clear them. */
  private flushMasks(cx: number, cz: number, masks: Int32Array, offset: number): void {
    for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
      let m = masks[offset + sy]!;
      if (m === 0) continue;
      masks[offset + sy] = 0;
      while (m !== 0) {
        const b = 31 - Math.clz32(m & -m);
        m &= m - 1;
        const ty = sy + BIT_DY[b]!;
        if (ty < 0 || ty >= SECTIONS_PER_CHUNK) continue;
        // An interior cell of the target section marks exactly that section.
        const half = SECTION_SIZE >> 1;
        this.world.markDirty(((cx + BIT_DX[b]!) << CHUNK_SHIFT) + half, ty * SECTION_SIZE + half, ((cz + BIT_DZ[b]!) << CHUNK_SHIFT) + half);
      }
    }
  }

  private flushDirty(): void {
    for (let k = 0; k < this.dirtySlotCount; k++) {
      const s = this.dirtySlots[k]!;
      const c = this.dirtyOwner[s]!;
      this.flushMasks(c.cx, c.cz, this.dirtyMask, s * SECTIONS_PER_CHUNK);
      this.dirtyOwner[s] = null;
    }
    this.dirtySlotCount = 0;
    if (this.dirtySpill.size > 0) {
      for (const [c, masks] of this.dirtySpill) this.flushMasks(c.cx, c.cz, masks, 0);
      this.dirtySpill.clear();
    }
  }

  /** End of a public call: hand the dirty sections over once the light is consistent (see DIRTY MARKING). */
  private finishCall(fromUpdate: boolean): void {
    if (this.pending === 0) {
      this.flushDirty();
      this.deferredUpdates = 0;
    } else if (fromUpdate && ++this.deferredUpdates >= MAX_DEFERRED_UPDATES) {
      this.flushDirty();
      this.deferredUpdates = 0;
    }
  }
}
