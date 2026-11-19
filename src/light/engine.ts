/**
 * Voxel lighting: sky light + block light, both 0..15, stored in Chunk.light
 * (sky = high nibble, block = low nibble). One light value per cell. The light runs on the
 * client's replica only (docs/ARCHITECTURE.md); the model is docs/SHAPES.md section 7.
 *
 * THE MODEL. Light is the unique fixed point of a local rule over the FACES between cells, so
 * "correct" never depends on the order in which chunks were added or edits were processed. A
 * cell holds up to two parts (material + the octants it fills). For a cell c and a direction d
 * with neighbour n:
 *
 *   oc(c, d)   quadrants of face d covered by c's opaque material (4 bits, FACE_COVER)
 *   open(c, d) (oc(c, d) | oc(n, d ^ 1)) !== 15: both sides together do not cover the face
 *              (one side is not enough: a lower slab beside an upper slab closes it)
 *   op(c)      opacity of the medium: the largest LIGHT_OPACITY < 15 among the parts; with no
 *              such part 15 when opaque material fills all 8 octants, else 0 (the rest is air)
 *   emit(c)    largest EMIT among the parts
 *   emitInto(c, d)  largest EMIT among n's parts that touch the face where c does not cover it
 *              with opaque material: an emitting part shines out of its own faces
 *
 *   from(c, d) = open(c, d) ? level(n) : (block light ? emitInto(c, d) : 0)
 *   take(c, d) = from(c, d) - cost(c),   cost(c) = max(1, op(c))
 *                except sky light straight down: d = up, op(c) = 0, open(c, up) -> level(n)
 *   block(c)   = max(emit(c),   max over d of take(c, d))
 *   sky(c)     = max(skySrc(c), max over d of take(c, d))
 *
 *   skySrc(c) = 15 at or above the column's heightmap; on the top layer below it, one step
 *   from the virtual all-15 layer above the world: 15 - cost(c) when the top face is open.
 *   heightmap = 1 + the highest y where the straight-down sky stops: op(y) !== 0, or the face
 *   between y and y + 1 is closed.
 *
 * Every step costs >= 1 except "straight down into an op 0 cell", and those free edges only go
 * down, so every cycle has positive cost and the fixed point is unique. emitInto does not depend
 * on any light level: it acts as a source. The engine and the brute-force reference in the tests
 * (written from the specification, not from this file) are two ways of reaching the fixed point.
 * Known approximation (one value per cell): empty octants of a cell that are not connected inside
 * it still pass light to each other; likewise an emitting part that opaque material of its own
 * cell walls off from the cell's empty octants still gives the whole cell its emit, which leaves
 * through every open face (tests/light/shapes.test.ts pins both).
 *
 * FULL BLOCKS (M1). Between two full blocks (no holes, no second part) every rule above reduces
 * to the M1 rule: the face is closed exactly when one side is opaque, an opaque cell receives
 * nothing, and an opaque neighbour's level is exactly its EMIT (block) or 0 (sky), which equals
 * from(). So a face between two full cells is handled with from = level(n) and no cell reads,
 * and the face rule runs only on faces that touch a partial cell. In code:
 *  - a chunk without a holes layer runs the M1 code unchanged (initChunk's column walk, pull,
 *    supported, offer, the removal step); only its border cells next to a chunk with a holes
 *    layer may need more, and that is checked only once such a chunk exists (`shapes`);
 *  - in a chunk with a holes layer, a full cell all of whose neighbours are full uses the same
 *    M1 tests (fullAround); a partial cell, or a full one with a partial neighbour, is handled by
 *    the per-cell routines of the face rule: scan (what the six faces give it), offerGeneral,
 *    unlightGeneral, changeGeneral, and the layered column walk and exchangePair of initChunk.
 * A cell is partial exactly when its first part has holes: a second part always comes with holes
 * in the first (docs/SHAPES.md 4.1), so a chunk without a holes layer has no second part either.
 * The engine reads the base, holes and second-part layers and tables; it never forms the packed
 * value of a two-part cell.
 *
 * WHICH CHUNKS EXIST. Only chunks this engine has lit (initChunk) and that are still the
 * world's chunk at their position take part: no light enters or leaves any other chunk and
 * the engine never writes into one. The engine keeps its own registry of lit chunks and, at
 * the start of every update() and initChunk(), notices chunks that left the world (or are
 * being re-initialised) and relights their lit neighbours without them (see "orphans"
 * below). So unloading needs no hook, and the light is always the fixed point of the chunks
 * that are present: when an unloaded chunk comes back, initChunk pulls its light back in.
 *
 * SOURCES AND SUPPORT. A cell's own source src(c) is skySrc(c) for sky light; for block light
 * it is emit(c) together with emitInto - cost(c) over every closed face that touches a partial
 * cell (a closed face between two full cells has an opaque full neighbour whose level is its
 * EMIT, so that neighbour counts as a supporter instead, as in M1). The incremental algorithm
 * keeps this invariant between calls: every cell brighter than its own source is either
 * SUPPORTED (a present neighbour n across a face that passes light has level(n) - cost(c) >=
 * level(c), or is directly above an op 0 c across an open face with level(n) >= level(c) for
 * sky) or COVERED (a queued removal entry (r, o) next to it could have supported it, by the same
 * test with o as r's level and whatever the face between them is now). Support strictly
 * increases (level, height), so support chains cannot loop: once the removal queue is empty
 * every value is reachable from a real source, i.e. never too bright, and the addition queue
 * then makes it never too dark.
 *
 * INCREMENTAL UPDATES (cellChanged + update):
 *  - cellChanged reads the cell as it is NOW (never the event's old/new arguments, which are
 *    stale when another listener rewrote the cell first) and computes what the cell's own
 *    source and its neighbours give it. If that does not lower the cell, raise and flood fill.
 *    Otherwise reset the cell to its bare source and queue a removal. A change that involves a
 *    partial cell (either argument has holes or a second part) also re-settles the six
 *    neighbours the same way: a face that closes, or an emitting part that no longer touches a
 *    face, can leave the changed cell as bright as before while a neighbour loses its light.
 *  - Removal BFS: a neighbour the removed level could have supported is reset to its source
 *    and removed in turn, unless a strictly brighter neighbour still supports it (then it
 *    keeps its light; if that supporter turns out to be stale too, its own removal comes back
 *    for the cell). Whether the face between the two is open now is not looked at: it may have
 *    just closed. A reset cell that a neighbour which kept its light could raise is queued
 *    once as a refill request in the addition queue. Removing too much is always safe (the
 *    hole refills from what is left); too little never happens (the invariant above). That is
 *    what makes budgeted, interleaved processing safe.
 *  - Raising a column's heightmap removes the open-sky status of every cell between the old
 *    top and the new one; each of those cells is reset and removed explicitly. Lowering it
 *    needs nothing special: the cell that changed becomes a 15 source and its flood fill falls
 *    losslessly down the newly opened cells (or, when the change only opened the face below it,
 *    the re-settled cell below starts that fill).
 *  - Orphans: when a chunk disappears, a lit neighbour's border cell facing it that is no
 *    longer supported by anything else is reset and removed like any other unsupported cell.
 *    Only border cells can lose support that way; everything further in is covered through
 *    them. Re-initialising a lit chunk first orphans its neighbours the same way, so stale
 *    light that the chunk used to feed them is never pulled back in.
 *
 * QUEUES. Both additions and removals use bucket queues keyed by light level, processed from
 * 15 down. For additions (and refill requests, which share the queue) this makes the BFS
 * behave like Dijkstra: most cells are settled on their first visit even with mixed costs.
 * For removals it means a wave is reset in order of decreasing level, so by the time a cell's
 * support is judged the brighter cells of the wave are already reset. (The first version used
 * a stack and re-seeded every surviving neighbour; closing a skylight in a high roof took
 * 87k visits for 20k changed bytes, now 43k.) All queues are growable flat Int32Array stacks
 * of (x, y, z) world coordinates owned by the engine instance; there are no per-cell objects.
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
import * as D from '../core/dirs';
import * as CELL from '../blocks/cell';
import { EMIT as EMIT_TABLE, LIGHT_OPACITY as OPACITY_TABLE, OPAQUE as OPAQUE_TABLE } from '../blocks/registry';
import { FACE_COVER as FACE_COVER_TABLE } from '../blocks/shapes';
import { chunkKey as chunkKeyOf, type Chunk } from '../voxel/chunk';
import type { World } from '../voxel/world';

// Module-level copies of everything imported that the per-cell loops touch. Some module
// runners (vite-node / vitest, i.e. every headless test) turn each use of an imported binding
// into a namespace getter call; that tripled initChunk's cost. Plain consts are free
// everywhere. The tables are filled once at startup by the block registry (FACE_COVER by
// blocks/shapes.ts) and never change.
const LIGHT_OPACITY = OPACITY_TABLE;
const EMIT = EMIT_TABLE;
const OPAQUE = OPAQUE_TABLE;
/** [opaque fill]: bit (dir * 4 + quadrant) = that quadrant of face dir is covered (docs/SHAPES.md 2.3). */
const FACE_COVER = FACE_COVER_TABLE;
const ID_MASK = CELL.ID_MASK;
const HOLES_SHIFT = CELL.HOLES_SHIFT;
const PART_MASK = CELL.PART_MASK;
const FULL_LIMIT = CELL.FULL_LIMIT;
const PACK_SCALE = CELL.PACK_SCALE;
const chunkKey = chunkKeyOf;
const CHUNK_SHIFT = K.CHUNK_SHIFT;
const CHUNK_SIZE = K.CHUNK_SIZE;
const CHUNK_VOLUME = K.CHUNK_VOLUME;
const MAX_LIGHT = K.MAX_LIGHT;
const SECTION_SIZE = K.SECTION_SIZE;
const SECTIONS_PER_CHUNK = K.SECTIONS_PER_CHUNK;
const PX = D.PX;
const NX = D.NX;
const PY = D.PY;
const NY = D.NY;
const PZ = D.PZ;
const NZ = D.NZ;

// Chunk cell index = lx | lz << 4 | y << 8 (voxel/chunk.ts). The offsets below follow from it.
const TOP_Y = K.WORLD_HEIGHT - 1;
const COLUMNS = CHUNK_SIZE * CHUNK_SIZE;
const DY = COLUMNS; // index step for y +/- 1
const DZ = CHUNK_SIZE; // index step for z +/- 1
const EDGE = CHUNK_SIZE - 1;
const WRAP_X = EDGE; // index delta from lx = 0 to lx = 15 in the neighbouring chunk
const WRAP_Z = EDGE * DZ; // index delta from lz = 0 to lz = 15 in the neighbouring chunk
const OPAQUE_LEVEL = 15;
/** Shift of the top face's / bottom face's quadrants in a FACE_COVER entry. */
const COVER_UP = PY * 4;
const COVER_DOWN = NY * 4;
/** World-coordinate step per direction (Dir order). */
const STEP_X = new Int8Array(D.DIR_X);
const STEP_Y = new Int8Array(D.DIR_Y);
const STEP_Z = new Int8Array(D.DIR_Z);

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
 * Open-sky source level of a FULL cell: 15 at/above the heightmap. Below it the only source is
 * the virtual layer above the world, which reaches the top layer through one attenuating step.
 * (For a full cell the top face is open toward the virtual layer exactly when op < 15.)
 */
function skySource(y: number, height: number, op: number): number {
  if (y >= height) return MAX_LIGHT;
  if (y === TOP_Y && op < OPAQUE_LEVEL) return MAX_LIGHT - stepCost(op);
  return 0;
}

/**
 * skySrc of any cell (op and its opaque FACE_COVER entry): 15 at/above the heightmap; on the top
 * layer, one step from the virtual layer when the cell's top face is open (the virtual layer
 * covers nothing).
 */
function skySourceOf(y: number, height: number, op: number, cover: number): number {
  if (y >= height) return MAX_LIGHT;
  if (y === TOP_Y && op < OPAQUE_LEVEL && ((cover >>> COVER_UP) & 15) !== 15) return MAX_LIGHT - stepCost(op);
  return 0;
}

// ---- reading cells from the three layers (docs/SHAPES.md 4.1); results are part values < 2^24

/** First part of cell i: id + state from the base layer, holes from the holes layer. */
function firstPart(c: Chunk, i: number): number {
  const h = c.holes;
  return h === null ? c.cells[i]! : c.cells[i]! | (h[i]! << HOLES_SHIFT);
}

/** Second part of cell i, 0 for none. */
function secondPart(c: Chunk, i: number): number {
  const p = c.part2;
  return p === null ? 0 : p[i]!;
}

/** Cell i holds a partial shape (its first part has holes; a second part implies that). */
function isPartial(c: Chunk, i: number): boolean {
  const h = c.holes;
  return h !== null && h[i] !== 0;
}

/** Octants of a part value filled with opaque material (0 for no part: OPAQUE[air] is 0). */
function partOpaque(p: number): number {
  return OPAQUE[p & ID_MASK] !== 0 ? ~(p >>> HOLES_SHIFT) & 0xff : 0;
}

/** Octants of cell i filled with opaque material. */
function opaqueFillAt(c: Chunk, i: number): number {
  return partOpaque(firstPart(c, i)) | partOpaque(secondPart(c, i));
}

/**
 * op(c) of the model from the cell's two parts and its opaque fill: the largest LIGHT_OPACITY
 * below 15 among the parts; with no such part 15 when opaque material fills every octant, else 0.
 * For a full block this is LIGHT_OPACITY[id] (15 for every opaque block).
 */
function opacityOf(p1: number, p2: number, opaqueFill: number): number {
  let m = -1;
  const id1 = p1 & ID_MASK;
  if (id1 !== 0) {
    const o = LIGHT_OPACITY[id1]!;
    if (o < OPAQUE_LEVEL) m = o;
  }
  if (p2 !== 0) {
    const o = LIGHT_OPACITY[p2 & ID_MASK]!;
    if (o < OPAQUE_LEVEL && o > m) m = o;
  }
  if (m >= 0) return m;
  return opaqueFill === 0xff ? OPAQUE_LEVEL : 0;
}

/** emit(c): the largest EMIT among the parts. */
function emitOf(p1: number, p2: number): number {
  const a = EMIT[p1 & ID_MASK]!;
  const b = EMIT[p2 & ID_MASK]!;
  return a > b ? a : b;
}

/**
 * emitInto from a cell with parts (p1, p2) through its face `face` into the cell on the other
 * side, whose opaque material leaves the quadrants `open` of that face uncovered: the largest
 * EMIT among the parts whose cover of the face meets `open`.
 */
function emitThrough(p1: number, p2: number, face: number, open: number): number {
  if (open === 0) return 0;
  const shift = face << 2;
  let m = 0;
  const e1 = EMIT[p1 & ID_MASK]!;
  if (e1 !== 0 && ((FACE_COVER[~(p1 >>> HOLES_SHIFT) & 0xff]! >>> shift) & open) !== 0) m = e1;
  if (p2 !== 0) {
    const e2 = EMIT[p2 & ID_MASK]!;
    if (e2 > m && ((FACE_COVER[~(p2 >>> HOLES_SHIFT) & 0xff]! >>> shift) & open) !== 0) m = e2;
  }
  return m;
}

/**
 * The two cells (parts p1, p2 and q1, q2) affect light alike: neither emits, the same opacity,
 * and the same opaque cover on all six faces (docs/SHAPES.md 7.2, cellChanged step 1).
 */
function sameLight(p1: number, p2: number, q1: number, q2: number): boolean {
  if (emitOf(p1, p2) !== 0 || emitOf(q1, q2) !== 0) return false;
  const fp = partOpaque(p1) | partOpaque(p2);
  const fq = partOpaque(q1) | partOpaque(q2);
  return opacityOf(p1, p2, fp) === opacityOf(q1, q2, fq) && FACE_COVER[fp] === FACE_COVER[fq];
}

/** Index of the neighbour of cell i in direction d, inside the chunk that holds that neighbour. */
function neighbourIndex(i: number, d: number): number {
  switch (d) {
    case PX:
      return (i & EDGE) < EDGE ? i + 1 : i - WRAP_X;
    case NX:
      return (i & EDGE) > 0 ? i - 1 : i + WRAP_X;
    case PY:
      return i + DY;
    case NY:
      return i - DY;
    case PZ:
      return ((i >> 4) & EDGE) < EDGE ? i + DZ : i - WRAP_Z;
    default:
      return ((i >> 4) & EDGE) > 0 ? i - DZ : i + WRAP_Z;
  }
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

  /**
   * Every chunk this engine has lit, by chunk key. A chunk only exists for lighting while it
   * is here AND still the world's chunk at its position.
   */
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

  /**
   * A chunk with a holes layer has been lit, or a change involving a partial cell has been
   * heard. Until then every chunk holds full blocks only, so no cell can be on a border with a
   * chunk that has a holes layer and the checks for that (borderGeneral) are skipped: a world of
   * full blocks runs the M1 code. (A chunk only gets a holes layer through a write of a partial
   * cell, which the attached engine hears, or arrives with one through initChunk.)
   */
  private shapes = false;

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
    const light = chunk.light;
    const hm = chunk.heightmap;
    if (chunk.holes !== null) this.shapes = true;
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
    const darkFrom = this.darkFrom;

    // Pass 1, one top-down walk per column: heightmap, straight-down sky light, emitters.
    // Every light byte is rewritten, so stale data (e.g. from a save) never survives.
    light.fill(0);
    if (chunk.holes === null) this.columnsFull(chunk, ox, oz);
    else this.columnsLayered(chunk, ox, oz);

    // Pass 2, sideways seeds. After pass 1 the column values never increase going down, so
    // nothing can flow downward or upward yet; the only possible gains are sideways into a
    // neighbour column BELOW ITS heightmap (above it everything is already 15). So a cell
    // can only be a donor when it is lit (>= 2) and below the highest in-chunk neighbour
    // heightmap. Cross-border flow is handled by the exchange below. (The seeds are a
    // superset of the donors; the flood fill applies the face rules.)
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
    if (w) this.exchange(chunk, w, 0, EDGE, DZ, NX);
    const e = this.chunkAt(chunk.cx + 1, chunk.cz);
    if (e) this.exchange(chunk, e, EDGE, 0, DZ, PX);
    const n = this.chunkAt(chunk.cx, chunk.cz - 1);
    if (n) this.exchange(chunk, n, 0, WRAP_Z, 1, NZ);
    const s = this.chunkAt(chunk.cx, chunk.cz + 1);
    if (s) this.exchange(chunk, s, WRAP_Z, 0, 1, PZ);

    // One BFS per channel from every seed at once: bucket order finalises most cells on
    // their first visit. It may cross into lit neighbours (marking them dirty).
    this.runAdd(skyQ, true, Infinity, chunk);
    this.runAdd(this.initBlock, false, Infinity, chunk);

    if (reinit) {
      // No addChunk marked this chunk's sections for us.
      const before = this.reinitBefore!;
      for (let i = 0; i < CHUNK_VOLUME; i++) if (before[i] !== light[i]) this.touch(chunk, i);
    }
    this.finishCall(false);
  }

  /** Pass 1 of initChunk for a chunk of full blocks only (the M1 walk). */
  private columnsFull(chunk: Chunk, ox: number, oz: number): void {
    const cells = chunk.cells;
    const light = chunk.light;
    const hm = chunk.heightmap;
    const blockQ = this.initBlock;
    const darkFrom = this.darkFrom;
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
  }

  /**
   * Pass 1 of initChunk for a chunk with a holes layer: the same walk with the face rule. The
   * straight-down sky continues from y + 1 into y only through an open face (the bottom cover of
   * y + 1 together with the top cover of y), losslessly into an op 0 cell; the heightmap is set
   * at the first cell where that stops (op !== 0, or the face above it closed).
   */
  private columnsLayered(chunk: Chunk, ox: number, oz: number): void {
    const light = chunk.light;
    const hm = chunk.heightmap;
    const blockQ = this.initBlock;
    const darkFrom = this.darkFrom;
    for (let col = 0; col < COLUMNS; col++) {
      const wx = ox + (col & EDGE);
      const wz = oz + (col >> 4);
      let level = MAX_LIGHT;
      let height = 0;
      let coverAbove = 0; // bottom cover of the cell above (the virtual layer covers nothing)
      let y = TOP_Y;
      for (; y >= 0; y--) {
        const i = col | (y * DY);
        const p1 = firstPart(chunk, i);
        const p2 = secondPart(chunk, i);
        const fill = partOpaque(p1) | partOpaque(p2);
        const op = opacityOf(p1, p2, fill);
        const cover = FACE_COVER[fill]!;
        const open = (((cover >>> COVER_UP) & 15) | coverAbove) !== 15;
        if (height === 0 && (op !== 0 || !open)) height = y + 1;
        if (!open || op >= OPAQUE_LEVEL) level = 0;
        else if (op !== 0) {
          level -= stepCost(op);
          if (level < 0) level = 0;
        }
        const e = emitOf(p1, p2);
        light[i] = (level << 4) | e;
        if (e > 1) blockQ.push(e, wx, y, wz);
        coverAbove = (cover >>> COVER_DOWN) & 15;
        if (level === 0) break;
      }
      hm[col] = height;
      darkFrom[col] = y;
      for (y--; y >= 0; y--) {
        const i = col | (y * DY);
        const e = emitOf(firstPart(chunk, i), secondPart(chunk, i));
        if (e !== 0) {
          light[i] = e;
          if (e > 1) blockQ.push(e, wx, y, wz);
        }
      }
    }
  }

  /**
   * Compare every border cell pair of `a` (the chunk being initialised) and neighbour `b` and
   * raise whichever side can receive more from the other. Columns: a's border column t is
   * baseA + t * stride, its partner in b is baseB + t * stride; dAB is the direction from a to b.
   */
  private exchange(a: Chunk, b: Chunk, baseA: number, baseB: number, stride: number, dAB: number): void {
    const aCells = a.cells;
    const aLight = a.light;
    const bCells = b.cells;
    const bLight = b.light;
    const aHoles = a.holes;
    const bHoles = b.holes;
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
        // Equal bytes cannot flow either way (every sideways step costs >= 1, and what an
        // emitting part shines through a closed face is at most the emitter's own level).
        // This skips the solid underground and the open sky in one compare.
        if (la === lb) continue;
        if ((aHoles !== null && aHoles[ia] !== 0) || (bHoles !== null && bHoles[ib] !== 0)) {
          this.exchangePair(a, ia, ax, az, b, ib, bx, bz, y, dAB, la, lb);
          continue;
        }
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

  /** One border pair of exchange() where at least one cell is partial: the face rule of the model. */
  private exchangePair(
    a: Chunk,
    ia: number,
    ax: number,
    az: number,
    b: Chunk,
    ib: number,
    bx: number,
    bz: number,
    y: number,
    dAB: number,
    la: number,
    lb: number,
  ): void {
    const a1 = firstPart(a, ia);
    const a2 = secondPart(a, ia);
    const b1 = firstPart(b, ib);
    const b2 = secondPart(b, ib);
    const aFill = partOpaque(a1) | partOpaque(a2);
    const bFill = partOpaque(b1) | partOpaque(b2);
    const ocA = (FACE_COVER[aFill]! >>> (dAB << 2)) & 15;
    const ocB = (FACE_COVER[bFill]! >>> ((dAB ^ 1) << 2)) & 15;
    const open = (ocA | ocB) !== 15;
    const sa = la >> 4;
    const ba = la & 15;
    const sb = lb >> 4;
    const bb = lb & 15;

    const opA = opacityOf(a1, a2, aFill);
    if (opA < OPAQUE_LEVEL) {
      const cost = stepCost(opA);
      const vs = open ? sb - cost : 0;
      const vb = (open ? bb : emitThrough(b1, b2, dAB ^ 1, ~ocA & 15)) - cost;
      if (vs > sa || vb > ba) {
        a.light[ia] = ((vs > sa ? vs : sa) << 4) | (vb > ba ? vb : ba);
        if (vs > sa) this.initSky.push(vs, ax, y, az);
        if (vb > ba && vb > 1) this.initBlock.push(vb, ax, y, az);
      }
    }

    // Through a closed face b takes nothing here, not even what an emitting part of a shines
    // through it (emitInto): every emitting cell of a was queued by pass 1, and the flood that
    // spreads from it (spreadGeneral / offerAcross) sends emitInto across this face into b.
    // The cells of b, which are already lit, are queued by nobody, so the a-half above has to
    // take b's emitInto here.
    const opB = opacityOf(b1, b2, bFill);
    if (opB < OPAQUE_LEVEL && open) {
      const cost = stepCost(opB);
      const vs = sa - cost;
      const vb = ba - cost;
      if (vs > sb || vb > bb) {
        b.light[ib] = ((vs > sb ? vs : sb) << 4) | (vb > bb ? vb : bb);
        this.touch(b, ib);
        if (vs > sb) this.initSky.push(vs, bx, y, bz);
        if (vb > bb && vb > 1) this.initBlock.push(vb, bx, y, bz);
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
    const worldChunks = this.world.chunks; // keyed by chunkKey, like litChunks
    // forEach rather than for..of over entries: no [key, value] array per chunk per call.
    this.litChunks.forEach((c, key) => {
      const present = worldChunks.get(key) === c;
      if (present && c.lit) return;
      // A chunk object that left the world keeps no maintained light: if it is ever added
      // again it must go through initChunk.
      if (!present) c.lit = false;
      this.litChunks.delete(key);
      gone.push(c.cx, c.cz);
    });
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
    // Only a chunk with a holes layer, or next to one, has cells that need the face rule.
    const layeredNear =
      c.holes !== null ||
      (this.shapes && (this.layered(c.cx - 1, c.cz) || this.layered(c.cx + 1, c.cz) || this.layered(c.cx, c.cz - 1) || this.layered(c.cx, c.cz + 1)));
    for (let t = 0; t < CHUNK_SIZE; t++) {
      const col = base + t * stride;
      const x = ox + (col & EDGE);
      const z = oz + (col >> 4);
      const height = c.heightmap[col]!;
      for (let y = 0; y <= TOP_Y; y++) {
        const i = col | (y * DY);
        const lb = light[i]!;
        if (lb === 0) continue;
        const s = lb >> 4;
        const b = lb & 15;
        if (layeredNear && this.general(c, i)) {
          if (s > 0) {
            const r = this.scan(c, i, x, y, z, true);
            const src = r & 15;
            if (s > src && ((r >> 4) & 15) < s) this.reset(c, i, x, y, z, s, src, true);
          }
          if (b > 0) {
            const r = this.scan(c, i, x, y, z, false);
            const src = r & 15;
            if (b > src && ((r >> 4) & 15) < b) this.reset(c, i, x, y, z, b, src, false);
          }
          continue;
        }
        const id = cells[i]! & ID_MASK;
        const op = LIGHT_OPACITY[id]!;
        if (s > 0) {
          const src = skySource(y, height, op);
          if (s > src && this.pull(c, i, x, y, z, op, true) < s) this.reset(c, i, x, y, z, s, src, true);
        }
        if (b > 0) {
          const src = EMIT[id]!;
          if (b > src && this.pull(c, i, x, y, z, op, false) < b) this.reset(c, i, x, y, z, b, src, false);
        }
      }
    }
  }

  // ================================================================== incremental updates

  /**
   * A cell changed (attach() wires this to the world hook). The arguments (packed cell
   * contents) only decide whether the change can matter for light and whether it involves a
   * partial cell; the cell's light properties are read from the chunk, so out-of-order delivery
   * (another listener rewrote the cell before this event reached the engine) is harmless.
   */
  cellChanged(x: number, y: number, z: number, oldCell: number, newCell: number): void {
    if (y < 0 || y > TOP_Y) return;
    if (oldCell === newCell) return;
    // Skipping an event whose own arguments do not differ in light is safe even when events
    // arrive out of order: every change that does differ is processed against the cell's state
    // at processing time, and a run of non-differing changes after that cannot alter light.
    const partial = oldCell >= FULL_LIMIT || newCell >= FULL_LIMIT;
    if (partial) this.shapes = true;
    if (!partial) {
      // Full blocks: opacity and emission are per block id, so state-only changes (liquid
      // levels, log axes, facings) are free.
      const oldId = oldCell & ID_MASK;
      const newId = newCell & ID_MASK;
      if (oldId === newId) return;
      if (LIGHT_OPACITY[oldId]! === LIGHT_OPACITY[newId]! && EMIT[oldId]! === EMIT[newId]!) return;
    } else {
      // Split the packed values into parts (< 2^24) right here: nothing below gets them.
      const o2 = oldCell < PACK_SCALE ? 0 : Math.floor(oldCell / PACK_SCALE);
      const n2 = newCell < PACK_SCALE ? 0 : Math.floor(newCell / PACK_SCALE);
      if (sameLight((oldCell - o2 * PACK_SCALE) & PART_MASK, o2, (newCell - n2 * PACK_SCALE) & PART_MASK, n2)) return;
    }

    this.gen++;
    const c = this.chunkAt(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    // Unlit / unloaded: initChunk will compute everything from the cells it finds.
    if (!c) return;
    const col = (x & EDGE) | ((z & EDGE) << 4);
    const i = col | (y * DY);
    if (partial || this.general(c, i)) {
      this.changeGeneral(c, i, col, x, y, z, partial);
      this.finishCall(false);
      return;
    }
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
    if (hNew > hOld) this.loseDirectSky(c, col, x, y, z, hOld);
    const skySrc = skySource(y, hNew, op);
    this.settle(c, i, x, y, z, c.light[i]! >> 4, Math.max(skySrc, this.pull(c, i, x, y, z, op, true)), skySrc, true);

    // ---- block
    this.settle(c, i, x, y, z, c.light[i]! & 15, Math.max(emit, this.pull(c, i, x, y, z, op, false)), emit, false);
    this.finishCall(false);
  }

  /**
   * The column's heightmap rose above hOld because of a change at y: every cell from y - 1 down
   * to the old top lost open sky. Reset each one explicitly instead of relying on the removal
   * chain from the changed cell to reach them, which would assume they currently hold exactly
   * what the chain expects; with budgeted processing they may still be mid-propagation.
   */
  private loseDirectSky(c: Chunk, col: number, x: number, y: number, z: number, hOld: number): void {
    for (let yy = y - 1; yy >= hOld; yy--) {
      const k = col | (yy * DY);
      const l = c.light[k]! >> 4;
      if (l === 0) continue;
      this.writeSky(c, k, 0);
      this.skyRem.push(l, x, yy, z);
    }
  }

  /**
   * cellChanged for a cell that needs the general rule (its chunk has a holes layer, it is on a
   * border with such a chunk, or the change involves a partial cell). `neighbours`: the change
   * involves a partial cell, so the six neighbours are re-settled too (section 7.2 step 3).
   */
  private changeGeneral(c: Chunk, i: number, col: number, x: number, y: number, z: number, neighbours: boolean): void {
    // ---- heightmap: a change at y alters whether the straight-down sky stops at y (its
    // opacity and top face) and at y - 1 (the face between them).
    const hOld = c.heightmap[col]!;
    let hNew = hOld;
    if (y >= hOld - 1) {
      if (this.stopsSky(c, col, y)) hNew = y + 1;
      else if (y > 0 && this.stopsSky(c, col, y - 1)) hNew = y;
      else if (y <= hOld) {
        // The old top was y or y - 1 and is gone: scan down for the next one. For y < 2 there
        // is nothing below y - 1 to scan (y = 0 has no cell below at all), so the column is open
        // to the bottom: start at -1, which gives hNew = 0 (never -1, which the Uint8Array
        // heightmap would store as 255).
        let yy = y >= 2 ? y - 2 : -1;
        while (yy >= 0 && !this.stopsSky(c, col, yy)) yy--;
        hNew = yy + 1;
      }
    }
    c.heightmap[col] = hNew;
    if (hNew > hOld) this.loseDirectSky(c, col, x, y, z, hOld);

    this.settleAt(c, i, x, y, z);
    if (!neighbours) return;
    for (let d = 0; d < 6; d++) {
      const n = this.neighbourChunk(c, i, y, d);
      if (n !== null) this.settleAt(n, neighbourIndex(i, d), x + STEP_X[d]!, y + STEP_Y[d]!, z + STEP_Z[d]!);
    }
  }

  /** The straight-down sky stops at cell y of the column: op(y) !== 0, or the face above y is closed. */
  private stopsSky(c: Chunk, col: number, y: number): boolean {
    const i = col | (y * DY);
    const p1 = firstPart(c, i);
    const p2 = secondPart(c, i);
    const fill = partOpaque(p1) | partOpaque(p2);
    if (opacityOf(p1, p2, fill) !== 0) return true;
    const above = y < TOP_Y ? (FACE_COVER[opaqueFillAt(c, i + DY)]! >>> COVER_DOWN) & 15 : 0;
    return (((FACE_COVER[fill]! >>> COVER_UP) & 15) | above) === 15;
  }

  /** Settle both channels of a cell by the general rule (target = max(source, what the neighbours give)). */
  private settleAt(c: Chunk, i: number, x: number, y: number, z: number): void {
    let r = this.scan(c, i, x, y, z, true);
    let src = r & 15;
    let got = (r >> 4) & 15;
    this.settle(c, i, x, y, z, c.light[i]! >> 4, got > src ? got : src, src, true);
    r = this.scan(c, i, x, y, z, false);
    src = r & 15;
    got = (r >> 4) & 15;
    this.settle(c, i, x, y, z, c.light[i]! & 15, got > src ? got : src, src, false);
  }

  /**
   * Apply the new level of a changed cell. `target` is what the cell's own source and its
   * neighbours (through its new contents) give it. Neighbours only depend on this cell through
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

  /**
   * Best level the present neighbours of a cell can give it through opacity `op` (sources
   * excluded). For a cell all of whose faces are between full blocks (see general()).
   */
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
   * True when a present neighbour other than the cell itself gives cell `i` (opacity `op`,
   * known to be < 15) at least `level` and is strictly brighter than it. "Strictly brighter"
   * leaves out a same-level cell straight above a clear cell: in a removal wave that one is
   * almost always part of the same wave, and counting it would keep cells that the wave then
   * has to come back for. For a cell all of whose faces are between full blocks.
   */
  private supported(c: Chunk, i: number, x: number, y: number, z: number, op: number, sky: boolean, level: number): boolean {
    const shift = sky ? 4 : 0;
    const light = c.light;
    // A neighbour must hold at least `need` to give `level` with a normal step.
    const need = level + stepCost(op);
    if (need > MAX_LIGHT && !(sky && op === 0)) return false;
    if (y < TOP_Y) {
      const v = (light[i + DY]! >> shift) & 15;
      if (v >= need || (sky && op === 0 && v > level)) return true;
    }
    if (need > MAX_LIGHT) return false;
    if (y > 0 && ((light[i - DY]! >> shift) & 15) >= need) return true;
    const lx = x & EDGE;
    const lz = z & EDGE;
    const cx = x >> CHUNK_SHIFT;
    const cz = z >> CHUNK_SHIFT;
    let n: Chunk | null;
    if (lx > 0) {
      if (((light[i - 1]! >> shift) & 15) >= need) return true;
    } else if ((n = this.chunkAt(cx - 1, cz)) && ((n.light[i + WRAP_X]! >> shift) & 15) >= need) return true;
    if (lx < EDGE) {
      if (((light[i + 1]! >> shift) & 15) >= need) return true;
    } else if ((n = this.chunkAt(cx + 1, cz)) && ((n.light[i - WRAP_X]! >> shift) & 15) >= need) return true;
    if (lz > 0) {
      if (((light[i - DZ]! >> shift) & 15) >= need) return true;
    } else if ((n = this.chunkAt(cx, cz - 1)) && ((n.light[i + WRAP_Z]! >> shift) & 15) >= need) return true;
    if (lz < EDGE) {
      if (((light[i + DZ]! >> shift) & 15) >= need) return true;
    } else if ((n = this.chunkAt(cx, cz + 1)) && ((n.light[i - WRAP_Z]! >> shift) & 15) >= need) return true;
    return false;
  }

  /**
   * The general rule for one cell and channel, in one pass over its six faces. Returns
   * src | pull << 4 | support << 8 | op << 12, each 0..15:
   *  - src: the cell's own source (sky: skySrc; block: emit together with emitInto - cost over
   *    the closed faces that touch a partial cell);
   *  - pull: the best take over all faces (closed faces give emitInto for block light);
   *  - support: the highest level some neighbour across a face that passes light supports in
   *    the strict sense of supported() (a same-level cell straight above does not count);
   *  - op: the cell's opacity.
   * A face between two full cells uses from = level(n), as in M1 (see FULL BLOCKS).
   */
  private scan(c: Chunk, i: number, x: number, y: number, z: number, sky: boolean): number {
    const p1 = firstPart(c, i);
    const p2 = secondPart(c, i);
    const fill = partOpaque(p1) | partOpaque(p2);
    const op = opacityOf(p1, p2, fill);
    const cover = FACE_COVER[fill]!;
    let src = sky ? skySourceOf(y, c.heightmap[i & (COLUMNS - 1)]!, op, cover) : emitOf(p1, p2);
    // Opaque material fills every octant: every face is closed by the cell itself and no
    // emitting part reaches it, so it receives nothing.
    if (op >= OPAQUE_LEVEL) return src | (op << 12);
    const cost = stepCost(op);
    const shift = sky ? 4 : 0;
    const partial = (p1 >>> HOLES_SHIFT) !== 0;
    let pull = 0;
    let support = 0;
    let shine = 0;
    for (let d = 0; d < 6; d++) {
      const n = this.neighbourChunk(c, i, y, d);
      if (n === null) continue;
      const j = neighbourIndex(i, d);
      if (partial || isPartial(n, j)) {
        const ocC = (cover >>> (d << 2)) & 15;
        const q1 = firstPart(n, j);
        const q2 = secondPart(n, j);
        const ocN = (FACE_COVER[partOpaque(q1) | partOpaque(q2)]! >>> ((d ^ 1) << 2)) & 15;
        if ((ocC | ocN) === 15) {
          if (!sky) {
            const e = emitThrough(q1, q2, d ^ 1, ~ocC & 15) - cost;
            if (e > shine) shine = e;
          }
          continue;
        }
      }
      const v = (n.light[j]! >> shift) & 15;
      // Straight down into an op 0 cell sky light is lossless; it supports only a lower level.
      const free = sky && d === PY && op === 0;
      const take = free ? v : v - cost;
      const strict = free ? v - 1 : take;
      if (take > pull) pull = take;
      if (strict > support) support = strict;
    }
    if (shine > src) src = shine;
    if (shine > pull) pull = shine;
    return src | (pull << 4) | (support << 8) | (op << 12);
  }

  /**
   * Process queued incremental work. budget = max cells to visit this call (default:
   * unlimited). Returns true when nothing is pending.
   *
   * Per channel, removals run before additions so stale light is not spread first (an
   * efficiency choice; correctness does not depend on it). A visit is one queue entry.
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
   * Flood-fill increases from the queue, highest level first. An entry (cell, level L):
   *  - cell holds L: offer it to every neighbour (through the face rule);
   *  - cell holds more: stale (the raise that overtook it pushed its own entry), skip;
   *  - cell holds less: a refill request queued by runRemove at the level it expected (or an
   *    entry overtaken by a removal). Pull what the neighbours give the cell now; if that
   *    raises it, write it and offer it on (now if it reached L, else from a lower bucket).
   *    Pulling is always safe: the value is supported by the neighbour it came from.
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
      let l = (c.light[i]! >> shift) & 15;
      if (l !== level) {
        if (l > level) continue;
        const p = this.pullAny(c, i, x, y, z, sky);
        if (p <= l) continue;
        const lb = c.light[i]!;
        c.light[i] = sky ? (lb & 0x0f) | (p << 4) : (lb & 0xf0) | p;
        if (c !== quiet) this.touch(c, i);
        if (p !== level) {
          if (p > 1 || sky) q.push(p, x, y, z);
          if (q.top > level) level = q.top;
          continue;
        }
        l = p;
      }

      if (c.holes !== null) {
        if (c.holes[i] !== 0) this.spreadGeneral(c, i, x, y, z, l, sky, q, quiet);
        else this.spreadFromFull(c, c.holes, i, x, y, z, l, sky, q, quiet);
        if (q.top > level) level = q.top;
        continue;
      }
      // A cell of a chunk without holes is a full block, and so is every neighbour inside its
      // chunk; only a neighbour across a chunk border can be partial.
      if (y > 0) this.offer(c, i - DY, x, y - 1, z, l, sky, true, q, quiet);
      if (y < TOP_Y) this.offer(c, i + DY, x, y + 1, z, l, sky, false, q, quiet);
      if (lx > 0) this.offer(c, i - 1, x - 1, y, z, l, sky, false, q, quiet);
      else {
        const n = this.chunkAt(cx - 1, cz);
        if (n) {
          if (n.holes !== null) this.offerAcross(c, i, n, i + WRAP_X, x - 1, y, z, l, sky, NX, q, quiet);
          else this.offer(n, i + WRAP_X, x - 1, y, z, l, sky, false, q, quiet);
        }
      }
      if (lx < EDGE) this.offer(c, i + 1, x + 1, y, z, l, sky, false, q, quiet);
      else {
        const n = this.chunkAt(cx + 1, cz);
        if (n) {
          if (n.holes !== null) this.offerAcross(c, i, n, i - WRAP_X, x + 1, y, z, l, sky, PX, q, quiet);
          else this.offer(n, i - WRAP_X, x + 1, y, z, l, sky, false, q, quiet);
        }
      }
      if (lz > 0) this.offer(c, i - DZ, x, y, z - 1, l, sky, false, q, quiet);
      else {
        const n = this.chunkAt(cx, cz - 1);
        if (n) {
          if (n.holes !== null) this.offerAcross(c, i, n, i + WRAP_Z, x, y, z - 1, l, sky, NZ, q, quiet);
          else this.offer(n, i + WRAP_Z, x, y, z - 1, l, sky, false, q, quiet);
        }
      }
      if (lz < EDGE) this.offer(c, i + DZ, x, y, z + 1, l, sky, false, q, quiet);
      else {
        const n = this.chunkAt(cx, cz + 1);
        if (n) {
          if (n.holes !== null) this.offerAcross(c, i, n, i - WRAP_Z, x, y, z + 1, l, sky, PZ, q, quiet);
          else this.offer(n, i - WRAP_Z, x, y, z + 1, l, sky, false, q, quiet);
        }
      }
      // Pushes never exceed the level being processed, but stay safe if that ever changes.
      if (q.top > level) level = q.top;
    }
    return visits;
  }

  /**
   * Try to raise one neighbour from a cell at level `l` across a face between two full
   * blocks. `down` = the neighbour is below.
   */
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
    // (raise() inlined: this is the hottest function of the engine.)
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

  /** Raise a cell to `cand` if that is brighter than what it holds, and queue it to spread. */
  private raise(c: Chunk, idx: number, x: number, y: number, z: number, cand: number, sky: boolean, q: LevelQueue, quiet: Chunk | null): void {
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
   * offer() from a full cell (i of chunk r, which has no holes layer) to the sideways
   * neighbour across a chunk border, in direction d: that one may be partial.
   */
  private offerAcross(
    r: Chunk,
    i: number,
    t: Chunk,
    j: number,
    x: number,
    y: number,
    z: number,
    l: number,
    sky: boolean,
    d: number,
    q: LevelQueue,
    quiet: Chunk | null,
  ): void {
    if (isPartial(t, j)) this.offerGeneral(r.cells[i]!, 0, d, t, j, x, y, z, l, sky, q, quiet);
    else this.offer(t, j, x, y, z, l, sky, false, q, quiet);
  }

  /**
   * runAdd's spreading step for a full block (i of chunk c, at level l) of a chunk with a holes
   * layer h: a face to a full neighbour is a face between full blocks, a face to a partial one
   * goes by the face rule.
   */
  private spreadFromFull(c: Chunk, h: Uint8Array, i: number, x: number, y: number, z: number, l: number, sky: boolean, q: LevelQueue, quiet: Chunk | null): void {
    const p1 = c.cells[i]!;
    const lx = x & EDGE;
    const lz = z & EDGE;
    let j: number;
    if (y > 0) {
      j = i - DY;
      if (h[j] !== 0) this.offerGeneral(p1, 0, NY, c, j, x, y - 1, z, l, sky, q, quiet);
      else this.offer(c, j, x, y - 1, z, l, sky, true, q, quiet);
    }
    if (y < TOP_Y) {
      j = i + DY;
      if (h[j] !== 0) this.offerGeneral(p1, 0, PY, c, j, x, y + 1, z, l, sky, q, quiet);
      else this.offer(c, j, x, y + 1, z, l, sky, false, q, quiet);
    }
    let n: Chunk | null;
    if (lx > 0) {
      j = i - 1;
      if (h[j] !== 0) this.offerGeneral(p1, 0, NX, c, j, x - 1, y, z, l, sky, q, quiet);
      else this.offer(c, j, x - 1, y, z, l, sky, false, q, quiet);
    } else if ((n = this.chunkAt(c.cx - 1, c.cz)) !== null) this.offerAcross(c, i, n, i + WRAP_X, x - 1, y, z, l, sky, NX, q, quiet);
    if (lx < EDGE) {
      j = i + 1;
      if (h[j] !== 0) this.offerGeneral(p1, 0, PX, c, j, x + 1, y, z, l, sky, q, quiet);
      else this.offer(c, j, x + 1, y, z, l, sky, false, q, quiet);
    } else if ((n = this.chunkAt(c.cx + 1, c.cz)) !== null) this.offerAcross(c, i, n, i - WRAP_X, x + 1, y, z, l, sky, PX, q, quiet);
    if (lz > 0) {
      j = i - DZ;
      if (h[j] !== 0) this.offerGeneral(p1, 0, NZ, c, j, x, y, z - 1, l, sky, q, quiet);
      else this.offer(c, j, x, y, z - 1, l, sky, false, q, quiet);
    } else if ((n = this.chunkAt(c.cx, c.cz - 1)) !== null) this.offerAcross(c, i, n, i + WRAP_Z, x, y, z - 1, l, sky, NZ, q, quiet);
    if (lz < EDGE) {
      j = i + DZ;
      if (h[j] !== 0) this.offerGeneral(p1, 0, PZ, c, j, x, y, z + 1, l, sky, q, quiet);
      else this.offer(c, j, x, y, z + 1, l, sky, false, q, quiet);
    } else if ((n = this.chunkAt(c.cx, c.cz + 1)) !== null) this.offerAcross(c, i, n, i - WRAP_Z, x, y, z + 1, l, sky, PZ, q, quiet);
  }

  /** runAdd's spreading step for a partial cell (i of chunk c, at level l): every face by the face rule. */
  private spreadGeneral(c: Chunk, i: number, x: number, y: number, z: number, l: number, sky: boolean, q: LevelQueue, quiet: Chunk | null): void {
    const p1 = firstPart(c, i);
    const p2 = secondPart(c, i);
    for (let d = 0; d < 6; d++) {
      const n = this.neighbourChunk(c, i, y, d);
      if (n !== null) this.offerGeneral(p1, p2, d, n, neighbourIndex(i, d), x + STEP_X[d]!, y + STEP_Y[d]!, z + STEP_Z[d]!, l, sky, q, quiet);
    }
  }

  /**
   * Offer light from a cell with parts (p1, p2) at level `l` to its neighbour (j of chunk t) in
   * direction d by the face rule: through an open face `l` minus the neighbour's cost (losslessly
   * straight down into an op 0 cell for sky light); through a closed face only what the cell's
   * emitting parts shine into the neighbour (block light), minus the cost.
   */
  private offerGeneral(
    p1: number,
    p2: number,
    d: number,
    t: Chunk,
    j: number,
    x: number,
    y: number,
    z: number,
    l: number,
    sky: boolean,
    q: LevelQueue,
    quiet: Chunk | null,
  ): void {
    const t1 = firstPart(t, j);
    const t2 = secondPart(t, j);
    const tFill = partOpaque(t1) | partOpaque(t2);
    const op = opacityOf(t1, t2, tFill);
    if (op >= OPAQUE_LEVEL) return;
    const ocT = (FACE_COVER[tFill]! >>> ((d ^ 1) << 2)) & 15;
    const ocR = (FACE_COVER[partOpaque(p1) | partOpaque(p2)]! >>> (d << 2)) & 15;
    let cand: number;
    if ((ocR | ocT) !== 15) cand = sky && d === NY && op === 0 ? l : l - stepCost(op);
    else if (sky) return;
    else cand = emitThrough(p1, p2, d, ~ocT & 15) - stepCost(op);
    this.raise(t, j, x, y, z, cand, sky, q, quiet);
  }

  /**
   * Removal BFS, highest old level first. Entry = (cell r, bucket = the level r had before it
   * was reset). A lit neighbour that level could have supported (see SUPPORT) and that is
   * above its own source is reset to the source and removed in turn.
   *
   * Refilling: instead of re-seeding every neighbour that keeps its light (one push per reset
   * neighbour, most of them wasted), r itself is queued once as a refill request (see runAdd)
   * at the level the best such neighbour would give it. That covers every pair (lit cell,
   * reset cell), because every reset cell gets an entry here and looks at all its neighbours,
   * and keeps refills in the same level order as the additions.
   * Returns the number of entries visited.
   */
  private runRemove(rem: LevelQueue, add: LevelQueue, sky: boolean, budget: number): number {
    const shift = sky ? 4 : 0;
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

      // Each unlight() returns the neighbour's level after the visit; `side` collects the
      // ones that reach r with a normal step, `above` may fall into r for free. When r's chunk
      // or a neighbour chunk across a border has a holes layer, some face of r may touch a
      // partial cell: then r's refill is computed by refill() instead.
      let side = 0;
      let above = 0;
      let mixed = c.holes !== null;
      let v: number;
      if (y > 0) {
        v = this.unlight(c, i - DY, x, y - 1, z, o, sky, true, rem);
        if (v > side) side = v;
      }
      if (y < TOP_Y) above = this.unlight(c, i + DY, x, y + 1, z, o, sky, false, rem);
      let n: Chunk | null;
      if (lx > 0) v = this.unlight(c, i - 1, x - 1, y, z, o, sky, false, rem);
      else if ((n = this.chunkAt(cx - 1, cz)) !== null) {
        if (n.holes !== null) mixed = true;
        v = this.unlight(n, i + WRAP_X, x - 1, y, z, o, sky, false, rem);
      } else v = 0;
      if (v > side) side = v;
      if (lx < EDGE) v = this.unlight(c, i + 1, x + 1, y, z, o, sky, false, rem);
      else if ((n = this.chunkAt(cx + 1, cz)) !== null) {
        if (n.holes !== null) mixed = true;
        v = this.unlight(n, i - WRAP_X, x + 1, y, z, o, sky, false, rem);
      } else v = 0;
      if (v > side) side = v;
      if (lz > 0) v = this.unlight(c, i - DZ, x, y, z - 1, o, sky, false, rem);
      else if ((n = this.chunkAt(cx, cz - 1)) !== null) {
        if (n.holes !== null) mixed = true;
        v = this.unlight(n, i + WRAP_Z, x, y, z - 1, o, sky, false, rem);
      } else v = 0;
      if (v > side) side = v;
      if (lz < EDGE) v = this.unlight(c, i + DZ, x, y, z + 1, o, sky, false, rem);
      else if ((n = this.chunkAt(cx, cz + 1)) !== null) {
        if (n.holes !== null) mixed = true;
        v = this.unlight(n, i - WRAP_Z, x, y, z + 1, o, sky, false, rem);
      } else v = 0;
      if (v > side) side = v;

      if (mixed) this.refill(c, i, x, y, z, sky, add);
      else {
        const op = LIGHT_OPACITY[c.cells[i]! & ID_MASK]!;
        if (op < OPAQUE_LEVEL) {
          const cost = stepCost(op);
          let best = side - cost;
          const fromAbove = sky && op === 0 ? above : above - cost;
          if (fromAbove > best) best = fromAbove;
          if (best > ((c.light[i]! >> shift) & 15)) add.push(best, x, y, z);
        }
      }
      // Pushes never exceed the level being processed (a dependent neighbour is at most as
      // bright), but stay safe if that ever changes.
      if (rem.top > level) level = rem.top;
    }
    return visits;
  }

  /** Queue a refill request for a removed cell at what its neighbours give it now, if that raises it. */
  private refill(c: Chunk, i: number, x: number, y: number, z: number, sky: boolean, add: LevelQueue): void {
    const best = this.pullAny(c, i, x, y, z, sky);
    if (best > ((c.light[i]! >> (sky ? 4 : 0)) & 15)) add.push(best, x, y, z);
  }

  /** What the neighbours of any cell give it now (pull() among full blocks, else by the face rule). */
  private pullAny(c: Chunk, i: number, x: number, y: number, z: number, sky: boolean): number {
    if ((c.holes === null && !(this.shapes && this.borderGeneral(c, i))) || this.fullAround(c, i, y)) {
      return this.pull(c, i, x, y, z, LIGHT_OPACITY[c.cells[i]! & ID_MASK]!, sky);
    }
    return (this.scan(c, i, x, y, z, sky) >> 4) & 15;
  }

  /**
   * Visit neighbour `idx` of a removed cell that held level `o`; `down` = the neighbour is
   * below it. Resets the neighbour if `o` could have supported it. Returns its level after.
   */
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
  ): number {
    const lb = c.light[idx]!;
    const nl = sky ? lb >> 4 : lb & 15;
    if (nl === 0) return 0;
    const h = c.holes;
    if (h !== null && h[idx] !== 0) return this.unlightGeneral(c, idx, x, y, z, nl, o, sky, down, rem);
    // A full block.
    const id = c.cells[idx]! & ID_MASK;
    const op = LIGHT_OPACITY[id]!;
    const src = sky ? skySource(y, c.heightmap[idx & (COLUMNS - 1)]!, op) : EMIT[id]!;
    if (nl <= src) return nl;
    // Could the removed level have supported this cell? An opaque cell receives nothing, so
    // any light it holds above its source is unsupported anyway.
    if (op < OPAQUE_LEVEL && (down && sky && op === 0 ? nl > o : nl > o - stepCost(op))) return nl;
    // A neighbour may be partial (its chunk, or the chunk across a border, has a holes layer):
    // then the face rule decides. (The exits above hold for it too: its opacity is its block's,
    // and its general source is at least the one used above.)
    if ((h !== null || (this.shapes && this.borderGeneral(c, idx))) && !this.fullAround(c, idx, y)) {
      return this.unlightGeneral(c, idx, x, y, z, nl, o, sky, down, rem);
    }
    if (this.supported(c, idx, x, y, z, op, sky, nl)) return nl;
    c.light[idx] = sky ? (lb & 0x0f) | (src << 4) : (lb & 0xf0) | src;
    this.touch(c, idx);
    rem.push(nl, x, y, z);
    if (src > 1 || (sky && src > 0)) (sky ? this.skyAdd : this.blockAdd).push(src, x, y, z);
    return src;
  }

  /** unlight() by the face rule, for a partial cell or a full one with a partial neighbour; `nl` (> 0) is the cell's level. */
  private unlightGeneral(
    c: Chunk,
    idx: number,
    x: number,
    y: number,
    z: number,
    nl: number,
    o: number,
    sky: boolean,
    down: boolean,
    rem: LevelQueue,
  ): number {
    const p1 = firstPart(c, idx);
    const p2 = secondPart(c, idx);
    const fill = partOpaque(p1) | partOpaque(p2);
    // The cheap exits of unlight() first: the source the cell has without looking at its
    // neighbours, and whether the removed level could have supported it at all. Whether the
    // face toward the removed cell is open now is not looked at (it may have just closed).
    const op = opacityOf(p1, p2, fill);
    if (nl <= (sky ? skySourceOf(y, c.heightmap[idx & (COLUMNS - 1)]!, op, FACE_COVER[fill]!) : emitOf(p1, p2))) return nl;
    if (op < OPAQUE_LEVEL && (down && sky && op === 0 ? nl > o : nl > o - stepCost(op))) return nl;
    const r = this.scan(c, idx, x, y, z, sky);
    const src = r & 15;
    if (nl <= src || ((r >> 8) & 15) >= nl) return nl;
    const lb = c.light[idx]!;
    c.light[idx] = sky ? (lb & 0x0f) | (src << 4) : (lb & 0xf0) | src;
    this.touch(c, idx);
    rem.push(nl, x, y, z);
    if (src > 1 || (sky && src > 0)) (sky ? this.skyAdd : this.blockAdd).push(src, x, y, z);
    return src;
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

  /** The present chunk holding the neighbour of cell i (at height y) of chunk c in direction d, or null. */
  private neighbourChunk(c: Chunk, i: number, y: number, d: number): Chunk | null {
    switch (d) {
      case PX:
        return (i & EDGE) < EDGE ? c : this.chunkAt(c.cx + 1, c.cz);
      case NX:
        return (i & EDGE) > 0 ? c : this.chunkAt(c.cx - 1, c.cz);
      case PY:
        return y < TOP_Y ? c : null;
      case NY:
        return y > 0 ? c : null;
      case PZ:
        return ((i >> 4) & EDGE) < EDGE ? c : this.chunkAt(c.cx, c.cz + 1);
      default:
        return ((i >> 4) & EDGE) > 0 ? c : this.chunkAt(c.cx, c.cz - 1);
    }
  }

  /**
   * Cell i of chunk c needs the general rule: its chunk has a holes layer (it or a neighbour
   * may be partial), or it is on a border with a present chunk that has one.
   */
  private general(c: Chunk, i: number): boolean {
    return c.holes !== null || (this.shapes && this.borderGeneral(c, i));
  }

  /**
   * Cell i (at height y) of chunk c is a full block and so is every present neighbour: all its
   * faces are between full blocks, so M1's pull(), supported() and sources apply to it.
   */
  private fullAround(c: Chunk, i: number, y: number): boolean {
    const h = c.holes;
    if (h !== null && (h[i] !== 0 || (y < TOP_Y && h[i + DY] !== 0) || (y > 0 && h[i - DY] !== 0))) return false;
    const lx = i & EDGE;
    const lz = (i >> 4) & EDGE;
    let n: Chunk | null;
    if (lx > 0) {
      if (h !== null && h[i - 1] !== 0) return false;
    } else if ((n = this.chunkAt(c.cx - 1, c.cz)) !== null && isPartial(n, i + WRAP_X)) return false;
    if (lx < EDGE) {
      if (h !== null && h[i + 1] !== 0) return false;
    } else if ((n = this.chunkAt(c.cx + 1, c.cz)) !== null && isPartial(n, i - WRAP_X)) return false;
    if (lz > 0) {
      if (h !== null && h[i - DZ] !== 0) return false;
    } else if ((n = this.chunkAt(c.cx, c.cz - 1)) !== null && isPartial(n, i + WRAP_Z)) return false;
    if (lz < EDGE) {
      if (h !== null && h[i + DZ] !== 0) return false;
    } else if ((n = this.chunkAt(c.cx, c.cz + 1)) !== null && isPartial(n, i - WRAP_Z)) return false;
    return true;
  }

  /** The present chunk at these chunk coordinates has a holes layer. */
  private layered(cx: number, cz: number): boolean {
    const c = this.chunkAt(cx, cz);
    return c !== null && c.holes !== null;
  }

  /** Cell i of chunk c lies on a border with a present chunk that has a holes layer. */
  private borderGeneral(c: Chunk, i: number): boolean {
    const lx = i & EDGE;
    const lz = (i >> 4) & EDGE;
    let n: Chunk | null;
    if (lx === 0) {
      if ((n = this.chunkAt(c.cx - 1, c.cz)) !== null && n.holes !== null) return true;
    } else if (lx === EDGE && (n = this.chunkAt(c.cx + 1, c.cz)) !== null && n.holes !== null) return true;
    if (lz === 0) {
      if ((n = this.chunkAt(c.cx, c.cz - 1)) !== null && n.holes !== null) return true;
    } else if (lz === EDGE && (n = this.chunkAt(c.cx, c.cz + 1)) !== null && n.holes !== null) return true;
    return false;
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
        const wx = ((cx + BIT_DX[b]!) << CHUNK_SHIFT) + half;
        const wz = ((cz + BIT_DZ[b]!) << CHUNK_SHIFT) + half;
        this.world.markDirty(wx, ty * SECTION_SIZE + half, wz);
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
