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
 * UNLOADED SPACE. Chunks that are not in the world, or are in it but not yet lit
 * (chunk.lit === false), do not exist for lighting: no light enters or leaves them and the
 * engine never writes into them. initChunk() later pulls light across the border, which is
 * an increase-only operation because adding space can only add sources and paths.
 *
 * INCREMENTAL UPDATES (cellChanged + update):
 *  - A change that cannot lower the light at the cell is handled by raising the cell
 *    (to its new emission / what its neighbours provide through its new opacity) and
 *    flood-filling from it.
 *  - Otherwise the cell is reset to its source value and a removal BFS runs: every neighbour
 *    whose level could have come from the removed level (strictly lower, or equal straight
 *    below for sky) is reset and removed in turn; every other lit neighbour is a seed for
 *    re-propagation. Over-removal is always safe (supporters are re-seeded), under-removal
 *    never happens, which is what makes this robust to budgeted, interleaved processing.
 *  - Raising a column's heightmap removes the open-sky status of every cell between the old
 *    top and the new block; that is expressed as a removal at the new block with level 15,
 *    whose lossless "straight down" chain covers exactly those cells.
 *
 * QUEUES. Additions use a bucket queue keyed by light level, processed from 15 down: the
 * BFS then behaves like Dijkstra and finalises most cells on their first visit even with
 * mixed costs (water 2, leaves 1). Removals use a plain stack. All queues are growable flat
 * Int32Array stacks of (x, y, z) world coordinates owned by the engine instance; there are
 * no per-cell objects. Chunks are resolved through a small direct-mapped cache, so the inner
 * loops do no Map lookups.
 *
 * DIRTY MARKING. Incremental writes go straight to chunk.light followed by
 * world.markDirty(x,y,z) — exactly what World.setSkyLight/setBlockLight do, minus their
 * chunk lookup. initChunk writes the new chunk's own light without marking (addChunk already
 * marked all of its sections) but marks every cell it changes in neighbouring chunks.
 */
import { CHUNK_SHIFT, CHUNK_SIZE, MAX_LIGHT, WORLD_HEIGHT } from '../core/constants';
import { ID_MASK } from '../blocks/cell';
import { EMIT, LIGHT_OPACITY } from '../blocks/registry';
import type { Chunk } from '../voxel/chunk';
import type { World } from '../voxel/world';

// Chunk cell index = lx | lz << 4 | y << 8 (voxel/chunk.ts). The offsets below follow from it.
const TOP_Y = WORLD_HEIGHT - 1;
const COLUMNS = CHUNK_SIZE * CHUNK_SIZE;
const DY = COLUMNS; // index step for y +/- 1
const DZ = CHUNK_SIZE; // index step for z +/- 1
const EDGE = CHUNK_SIZE - 1;
const WRAP_X = EDGE; // index delta from lx = 0 to lx = 15 in the neighbouring chunk
const WRAP_Z = EDGE * DZ; // index delta from lz = 0 to lz = 15 in the neighbouring chunk
const OPAQUE_LEVEL = 15;

/** Removal entries pack (y, old level) into one int. */
const REM_LEVEL_SHIFT = 8;
const REM_Y_MASK = 0xff;

/** Direct-mapped cache of lit chunks: 8 x 8 slots indexed by the low chunk-coordinate bits. */
const CACHE_BITS = 3;
const CACHE_MASK = (1 << CACHE_BITS) - 1;
const CACHE_SLOTS = 1 << (2 * CACHE_BITS);

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

  constructor() {
    for (let l = 0; l <= MAX_LIGHT; l++) this.buckets.push(new TripleStack(l === 0 ? 1 : 64));
  }

  push(level: number, x: number, y: number, z: number): void {
    this.buckets[level]!.push(x, y, z);
    if (level > this.top) this.top = level;
    this.total++;
  }
}

export class LightEngine {
  private readonly world: World;

  // Incremental work, per channel.
  private readonly skyRem = new TripleStack(256);
  private readonly blockRem = new TripleStack(256);
  private readonly skyAdd = new LevelQueue();
  private readonly blockAdd = new LevelQueue();
  // Private queues of initChunk, always drained before it returns.
  private readonly initSky = new LevelQueue();
  private readonly initBlock = new LevelQueue();
  /** Per column of the chunk being initialised: highest y whose straight-down sky is 0, or -1. */
  private readonly darkFrom = new Int16Array(COLUMNS);

  private readonly cacheChunk: Array<Chunk | null> = new Array<Chunk | null>(CACHE_SLOTS).fill(null);
  private readonly cacheCx = new Int32Array(CACHE_SLOTS);
  private readonly cacheCz = new Int32Array(CACHE_SLOTS);
  private readonly cacheGen = new Float64Array(CACHE_SLOTS);
  /** Bumped whenever chunks may have been added, removed or lit since the last lookup. */
  private gen = 1;

  private detach: (() => void) | null = null;

  constructor(world: World) {
    this.world = world;
  }

  /** Number of queued incremental entries (both channels, removals + additions). */
  get pending(): number {
    return this.skyRem.size + this.blockRem.size + this.skyAdd.total + this.blockAdd.total;
  }

  /** Subscribe to world.onCellChange so edits enqueue incremental updates. Returns the unsubscribe function. */
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
   */
  initChunk(chunk: Chunk): void {
    if (this.world.getChunk(chunk.cx, chunk.cz) !== chunk) {
      throw new Error(`LightEngine.initChunk: chunk ${chunk.cx},${chunk.cz} is not the world's chunk at that position`);
    }
    const cells = chunk.cells;
    const light = chunk.light;
    const hm = chunk.heightmap;
    const ox = chunk.cx << CHUNK_SHIFT;
    const oz = chunk.cz << CHUNK_SHIFT;
    const skyQ = this.initSky;
    const blockQ = this.initBlock;
    const darkFrom = this.darkFrom;

    // Pass 1, one top-down walk per column: heightmap, straight-down sky light, emitters.
    // This overwrites every light byte, so stale data (e.g. from a save) never survives.
    for (let col = 0; col < COLUMNS; col++) {
      let level = MAX_LIGHT;
      let height = 0;
      let dark = -1;
      for (let y = TOP_Y; y >= 0; y--) {
        const i = col | (y * DY);
        const id = cells[i]! & ID_MASK;
        const op = LIGHT_OPACITY[id]!;
        if (op !== 0) {
          if (height === 0) height = y + 1;
          if (level !== 0) {
            level = op >= OPAQUE_LEVEL ? 0 : level - stepCost(op);
            if (level <= 0) {
              level = 0;
              dark = y;
            }
          }
        }
        const e = EMIT[id]!;
        light[i] = (level << 4) | e;
        if (e > 1) blockQ.push(e, ox + (col & EDGE), y, oz + (col >> 4));
      }
      hm[col] = height;
      darkFrom[col] = dark;
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
    const world = this.world;
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
            const ns = vs > sa ? vs : sa;
            const nb = vb > ba ? vb : ba;
            aLight[ia] = (ns << 4) | nb;
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
            const ns = vs > sb ? vs : sb;
            const nb = vb > bb ? vb : bb;
            bLight[ib] = (ns << 4) | nb;
            world.markDirty(bx, y, bz);
            if (vs > sb) skyQ.push(vs, bx, y, bz);
            if (vb > bb && vb > 1) blockQ.push(vb, bx, y, bz);
          }
        }
      }
    }
  }

  // ================================================================== incremental updates

  /** A cell changed (attach() wires this to the world hook). */
  cellChanged(x: number, y: number, z: number, oldCell: number, newCell: number): void {
    if (y < 0 || y > TOP_Y) return;
    const oldId = oldCell & ID_MASK;
    const newId = newCell & ID_MASK;
    // Opacity and emission are per block id: state-only changes (liquid levels, log axes,
    // facings) are free.
    if (oldId === newId) return;
    const opOld = LIGHT_OPACITY[oldId]!;
    const opNew = LIGHT_OPACITY[newId]!;
    const eNew = EMIT[newId]!;
    if (opOld === opNew && EMIT[oldId]! === eNew) return;

    this.gen++;
    const c = this.chunkAt(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    // Unlit / unloaded: initChunk will compute everything from the cells it finds.
    if (!c) return;
    const col = (x & EDGE) | ((z & EDGE) << 4);
    const i = col | (y * DY);

    // ---- heightmap
    const hOld = c.heightmap[col]!;
    let hNew = hOld;
    if (opNew > 0) {
      if (y >= hOld) hNew = y + 1;
    } else if (opOld > 0 && y === hOld - 1) {
      let yy = y - 1;
      while (yy >= 0 && LIGHT_OPACITY[c.cells[col | (yy * DY)]! & ID_MASK]! === 0) yy--;
      hNew = yy + 1;
    }
    c.heightmap[col] = hNew;

    // ---- sky
    const oldSky = c.light[i]! >> 4;
    const skySrc = skySource(y, hNew, opNew);
    if (hNew > hOld) {
      // The cell became its column's top: everything from the old top up to here lost open
      // sky. Removing with level 15 makes the lossless straight-down chain reach all of
      // those cells, whatever their current (possibly still propagating) values are.
      this.writeSky(c, i, x, y, z, skySrc);
      this.skyRem.push(x, z, y | (MAX_LIGHT << REM_LEVEL_SHIFT));
      if (skySrc > 0) this.skyAdd.push(skySrc, x, y, z);
    } else {
      const v = Math.max(skySrc, this.pull(c, i, x, y, z, opNew, true));
      this.settle(c, i, x, y, z, oldSky, v, skySrc, true);
    }

    // ---- block
    const oldBlock = c.light[i]! & 15;
    const v = Math.max(eNew, this.pull(c, i, x, y, z, opNew, false));
    this.settle(c, i, x, y, z, oldBlock, v, eNew, false);
  }

  /**
   * Apply the new level of a changed cell. `target` is what the cell's own source and its
   * neighbours (through its new opacity) give it. Neighbours only depend on this cell through
   * its level, so if the level does not drop nothing around it can be over-lit: raise and
   * flood. If it drops, `target` may be fed by light that came from this very cell, so reset
   * to the bare source and remove.
   *
   * (When target >= old, the neighbour that provides it has level >= old + 1 and therefore
   * cannot have been lit by this cell; when target < old it may have been.)
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
        if (sky) this.writeSky(c, i, x, y, z, target);
        else this.writeBlock(c, i, x, y, z, target);
        (sky ? this.skyAdd : this.blockAdd).push(target, x, y, z);
      }
      return;
    }
    if (sky) this.writeSky(c, i, x, y, z, source);
    else this.writeBlock(c, i, x, y, z, source);
    (sky ? this.skyRem : this.blockRem).push(x, z, y | (old << REM_LEVEL_SHIFT));
    if (source > 0) (sky ? this.skyAdd : this.blockAdd).push(source, x, y, z);
  }

  /** Best level the neighbours of a cell can give it through opacity `op` (sources excluded). */
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
    this.gen++;
    let left = budget;
    if (left > 0 && this.skyRem.size > 0) left -= this.runRemove(this.skyRem, this.skyAdd, true, left);
    if (left > 0 && this.blockRem.size > 0) left -= this.runRemove(this.blockRem, this.blockAdd, false, left);
    if (left > 0 && this.skyRem.size === 0 && this.skyAdd.total > 0) left -= this.runAdd(this.skyAdd, true, left, null);
    if (left > 0 && this.blockRem.size === 0 && this.blockAdd.total > 0) {
      left -= this.runAdd(this.blockAdd, false, left, null);
    }
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
    if (c !== quiet) this.world.markDirty(x, y, z);
    // Level-1 block light cannot travel; level-1 sky light still falls through clear cells.
    if (cand > 1 || sky) q.push(cand, x, y, z);
  }

  /**
   * Removal BFS. Entry = (cell, the level it had before it was reset). A lit neighbour whose
   * level could have come from that level — strictly lower, or for sky the equal level
   * straight below a clear cell — and that is above its own source value is reset to the
   * source and removed in turn. Every other lit neighbour is independent of the removed
   * light and becomes a seed for re-propagation.
   * Returns the number of entries visited.
   */
  private runRemove(rem: TripleStack, add: LevelQueue, sky: boolean, budget: number): number {
    let visits = 0;
    while (visits < budget && rem.size > 0) {
      const k = --rem.size * 3;
      const d = rem.data;
      const x = d[k]!;
      const z = d[k + 1]!;
      const packed = d[k + 2]!;
      const y = packed & REM_Y_MASK;
      const o = packed >> REM_LEVEL_SHIFT;
      visits++;
      const cx = x >> CHUNK_SHIFT;
      const cz = z >> CHUNK_SHIFT;
      const c = this.chunkAt(cx, cz);
      if (!c) continue;
      const lx = x & EDGE;
      const lz = z & EDGE;
      const i = lx | (lz << 4) | (y * DY);

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
    rem: TripleStack,
    add: LevelQueue,
  ): void {
    const lb = c.light[idx]!;
    const nl = sky ? lb >> 4 : lb & 15;
    if (nl === 0) return;
    const id = c.cells[idx]! & ID_MASK;
    const op = LIGHT_OPACITY[id]!;
    const src = sky ? skySource(y, c.heightmap[idx & (COLUMNS - 1)]!, op) : EMIT[id]!;
    const dependent = nl < o || (down && sky && nl === o && op === 0);
    if (dependent && nl > src) {
      c.light[idx] = sky ? (lb & 0x0f) | (src << 4) : (lb & 0xf0) | src;
      this.world.markDirty(x, y, z);
      rem.push(x, z, y | (nl << REM_LEVEL_SHIFT));
      if (src > 1 || (sky && src > 0)) add.push(src, x, y, z);
    } else if (nl > 1 || sky) {
      add.push(nl, x, y, z);
    }
  }

  // ================================================================== helpers

  private writeSky(c: Chunk, i: number, x: number, y: number, z: number, v: number): void {
    const lb = c.light[i]!;
    const next = (lb & 0x0f) | (v << 4);
    if (next !== lb) {
      c.light[i] = next;
      this.world.markDirty(x, y, z);
    }
  }

  private writeBlock(c: Chunk, i: number, x: number, y: number, z: number, v: number): void {
    const lb = c.light[i]!;
    const next = (lb & 0xf0) | v;
    if (next !== lb) {
      c.light[i] = next;
      this.world.markDirty(x, y, z);
    }
  }

  /** The lit chunk at chunk coordinates, or null when unloaded or not yet lit. */
  private chunkAt(cx: number, cz: number): Chunk | null {
    const s = (cx & CACHE_MASK) | ((cz & CACHE_MASK) << CACHE_BITS);
    if (this.cacheGen[s] === this.gen && this.cacheCx[s] === cx && this.cacheCz[s] === cz) {
      return this.cacheChunk[s] as Chunk | null;
    }
    const c = this.world.getChunk(cx, cz);
    const lit = c !== undefined && c.lit ? c : null;
    this.cacheChunk[s] = lit;
    this.cacheCx[s] = cx;
    this.cacheCz[s] = cz;
    this.cacheGen[s] = this.gen;
    return lit;
  }
}
