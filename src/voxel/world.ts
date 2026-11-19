/**
 * The world grid: chunk storage, light storage, change hooks, scheduled block ticks and
 * mesh-dirty tracking. Pure data — no generation, no lighting logic, no rendering.
 *
 * Every mutation of a world cell goes through World.setCell(), which is the single
 * "block changed / removed" hook point (docs/LESSONS.md: 移除方块有好几条路径，要统一挂钩子).
 * Cells that arrive with a chunk (generated or restored) do not pass through setCell; addChunk
 * reports the chunk instead (onChunkAdd).
 */
import { CHUNK_MASK, CHUNK_SHIFT, SECTION_SIZE, SECTIONS_PER_CHUNK, WORLD_HEIGHT } from '../core/constants';
import { quat, vec3, type Quat, type Vec3 } from '../core/math';
import { AIR, CELL_MULTI_BIT, FULL_LIMIT, HOLES_SHIFT, ID_MASK, PACK_SCALE } from '../blocks/cell';
import { CELL_BELOW_WORLD, CELL_UNLOADED } from '../blocks/defs';
import { Chunk, chunkKey, sectionKey } from './chunk';
import { SET_DEFAULT, type CellBounds, type VoxelGrid } from './grid';
import { checkCanonical } from './parts';

/**
 * Called after a world cell changed. `oldCell` and `newCell` are PACKED cells (blocks/cell.ts:
 * both parts); a change of only the holes or only the second part fires too. `flags` are the
 * SET_* flags passed to setCell. Read the current state from the world, not from the arguments
 * (docs/LESSONS.md: 光照引擎必须是第一个监听器才正确).
 */
export type CellChangeListener = (
  x: number,
  y: number,
  z: number,
  oldCell: number,
  newCell: number,
  flags: number,
) => void;

/** Called after a chunk was added to the world, its cells in place and readable. */
export type ChunkAddListener = (chunk: Chunk) => void;

/** A pending block tick. Fires only if the block id at the position still matches. */
export interface ScheduledTick {
  x: number;
  y: number;
  z: number;
  /** Block id that scheduled the tick. */
  id: number;
  /** Absolute world tick at which it fires. */
  at: number;
}

const POS_BIAS = 0x400000; // world x/z must stay within +-4,194,304
/** Numeric key of a world cell position (valid for |x|,|z| < 2^22 and 0 <= y < 128). */
export function posKey(x: number, y: number, z: number): number {
  return ((x + POS_BIAS) * 0x800000 + (z + POS_BIAS)) * 128 + y;
}

/**
 * Scheduled block ticks (liquids, falling blocks ...). At most one pending tick per
 * position; re-scheduling the same block id keeps the earlier time, a different block id
 * replaces the entry.
 */
export class TickQueue {
  private byPos = new Map<number, ScheduledTick>();
  private buckets = new Map<number, ScheduledTick[]>();
  /** The last `now` passed to takeDue (ticks at or before it can no longer fire by themselves). */
  private lastNow = -Infinity;

  get size(): number {
    return this.byPos.size;
  }

  schedule(x: number, y: number, z: number, id: number, at: number): void {
    const k = posKey(x, y, z);
    const cur = this.byPos.get(k);
    // Keep an earlier pending tick for the same block — unless it is already overdue
    // (the clock jumped past it): such an entry would never fire and must not block
    // rescheduling.
    if (cur && cur.id === id && cur.at <= at && cur.at > this.lastNow) return;
    const t: ScheduledTick = { x, y, z, id, at };
    this.byPos.set(k, t);
    let b = this.buckets.get(at);
    if (!b) {
      b = [];
      this.buckets.set(at, b);
    }
    b.push(t);
  }

  /** True when a tick for this block id is pending at the position. */
  has(x: number, y: number, z: number, id: number): boolean {
    const cur = this.byPos.get(posKey(x, y, z));
    return !!cur && cur.id === id;
  }

  /**
   * Remove and return every tick due at or before `now`, earliest first and in scheduling
   * order within one time. Normally called once per world tick with consecutive `now`
   * values; if the clock jumps, overdue ticks fire on the next call instead of being lost.
   */
  takeDue(now: number): ScheduledTick[] {
    const prev = this.lastNow;
    this.lastNow = now;
    let b = this.buckets.get(now);
    if (now !== prev + 1 && this.buckets.size > 0) {
      // Clock jump: gather every overdue bucket.
      const times: number[] = [];
      for (const at of this.buckets.keys()) if (at <= now) times.push(at);
      if (times.length === 0) return [];
      times.sort((p, q) => p - q);
      const merged: ScheduledTick[] = [];
      for (const at of times) {
        for (const t of this.buckets.get(at)!) merged.push(t);
        this.buckets.delete(at);
      }
      b = merged;
    } else {
      if (!b) return [];
      this.buckets.delete(now);
    }
    const out: ScheduledTick[] = [];
    for (const t of b) {
      const k = posKey(t.x, t.y, t.z);
      if (this.byPos.get(k) === t) {
        this.byPos.delete(k);
        out.push(t);
      }
    }
    return out;
  }

  /** All pending ticks (for saving). */
  all(): ScheduledTick[] {
    return [...this.byPos.values()];
  }
  clear(): void {
    this.byPos.clear();
    this.buckets.clear();
    this.lastNow = -Infinity;
  }
}

export class World implements VoxelGrid {
  readonly gridId = 0;
  readonly parent = null;
  readonly isWorld = true;

  readonly seed: number;
  /** Current world tick (incremented by the simulation). */
  time = 0;

  readonly chunks = new Map<number, Chunk>();
  readonly ticks = new TickQueue();
  /** Keys (sectionKey) of mesh sections whose geometry is stale. The client drains this. */
  readonly dirtySections = new Set<number>();

  private listeners: CellChangeListener[] = [];
  private chunkListeners: ChunkAddListener[] = [];
  private lastChunk: Chunk | null = null;
  private readonly chunkCache: Array<Chunk | null> = [null, null, null, null];
  private lastDirtyKey = -1;

  constructor(seed = 0) {
    this.seed = seed >>> 0;
  }

  // ------------------------------------------------------------ chunks

  getChunk(cx: number, cz: number): Chunk | undefined {
    const lc = this.lastChunk;
    if (lc && lc.cx === cx && lc.cz === cz) return lc;
    // 4-entry direct-mapped cache: queries that straddle a chunk border alternate between
    // neighbouring chunks, and a Map lookup with a non-small-integer key allocates.
    const slot = (cx & 1) | ((cz & 1) << 1);
    const cached = this.chunkCache[slot];
    if (cached && cached.cx === cx && cached.cz === cz) {
      this.lastChunk = cached;
      return cached;
    }
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) {
      this.lastChunk = c;
      this.chunkCache[slot] = c;
    }
    return c;
  }
  /** Chunk containing world column (x,z), if loaded. */
  chunkAt(x: number, z: number): Chunk | undefined {
    return this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
  }
  /**
   * Insert a chunk, mark it and its neighbours' border sections for meshing, then report it to
   * the onChunkAdd listeners.
   */
  addChunk(chunk: Chunk): void {
    this.chunks.set(chunkKey(chunk.cx, chunk.cz), chunk);
    this.lastChunk = chunk;
    this.chunkCache.fill(null);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!this.getChunk(chunk.cx + dx, chunk.cz + dz)) continue;
        for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
          this.dirtySections.add(sectionKey(chunk.cx + dx, sy, chunk.cz + dz));
        }
      }
    }
    this.lastDirtyKey = -1;
    const ls = this.chunkListeners;
    for (let k = 0; k < ls.length; k++) ls[k]!(chunk);
  }
  removeChunk(cx: number, cz: number): Chunk | undefined {
    const k = chunkKey(cx, cz);
    const c = this.chunks.get(k);
    if (!c) return undefined;
    this.chunks.delete(k);
    if (this.lastChunk === c) this.lastChunk = null;
    this.chunkCache.fill(null);
    return c;
  }
  isLoaded(x: number, z: number): boolean {
    return this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT) !== undefined;
  }
  /** True when every chunk touching the world-space XZ rectangle is loaded. */
  isAreaLoaded(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    const c0x = Math.floor(minX) >> CHUNK_SHIFT;
    const c1x = Math.floor(maxX) >> CHUNK_SHIFT;
    const c0z = Math.floor(minZ) >> CHUNK_SHIFT;
    const c1z = Math.floor(maxZ) >> CHUNK_SHIFT;
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        if (!this.getChunk(cx, cz)) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------ cells

  /**
   * Cell value at integer world coordinates: the first part plus CELL_MULTI_BIT when the cell has
   * a second part (< 2^25; read the second part with getPart2, or both with voxel/parts.ts
   * getPacked). y < 0 -> deeprock; y >= WORLD_HEIGHT -> AIR; unloaded chunk -> CELL_UNLOADED (solid).
   */
  getCell(x: number, y: number, z: number): number {
    if (y < 0) return CELL_BELOW_WORLD;
    if (y >= WORLD_HEIGHT) return AIR;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return CELL_UNLOADED;
    const i = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8);
    const h = c.holes;
    const q = c.part2;
    if (h === null && q === null) return c.cells[i]!;
    return c.cells[i]! | (h !== null ? h[i]! << HOLES_SHIFT : 0) | (q !== null && q[i] !== 0 ? CELL_MULTI_BIT : 0);
  }
  /** Second part's value at integer world coordinates; 0 when there is none, outside the world or unloaded. */
  getPart2(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c || c.part2 === null) return 0;
    return c.part2[(x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8)]!;
  }
  /** Block id of the first part at integer world coordinates. */
  getId(x: number, y: number, z: number): number {
    return this.getCell(x, y, z) & ID_MASK;
  }

  /**
   * Write a packed cell (both parts, blocks/cell.ts) and notify listeners once. Returns false
   * (and does nothing) when out of the vertical range, in an unloaded chunk, or when the cell is
   * unchanged. A value below FULL_LIMIT (a full block) is never checked, whatever layers the
   * column has (docs/SHAPES.md 1.3, 3.4): in a column without holes / second-part layers it takes
   * the M1 path, in one with layers it also clears the cell's entries there. Any value >= FULL_LIMIT
   * must be in canonical form (I1-I6 of docs/SHAPES.md 1.3), else RangeError and nothing changes.
   */
  setCell(x: number, y: number, z: number, packed: number, flags: number = SET_DEFAULT): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return false;
    const i = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8);
    let old: number;
    if (packed < FULL_LIMIT && c.holes === null && c.part2 === null) {
      old = c.cells[i]!;
      if (old === packed) return false;
      c.cells[i] = packed;
    } else {
      const full = packed < FULL_LIMIT; // false for NaN too, which checkCanonical refuses
      if (!full) checkCanonical(packed);
      const h = c.holes;
      const q = c.part2;
      const p2 = q !== null ? q[i]! : 0;
      old = (c.cells[i]! | (h !== null ? h[i]! << HOLES_SHIFT : 0) | (p2 !== 0 ? CELL_MULTI_BIT : 0)) + p2 * PACK_SCALE;
      if (old === packed) return false;
      // A full block stores like the M1 path (16 bits), clearing the holes and second part.
      if (full) c.writeCell(i, packed & 0xffff, 0);
      else if (packed < PACK_SCALE) c.writeCell(i, packed, 0);
      else c.writeCell(i, packed % PACK_SCALE, Math.floor(packed / PACK_SCALE));
    }
    c.modified = true;
    this.markDirty(x, y, z);
    const ls = this.listeners;
    for (let k = 0; k < ls.length; k++) ls[k]!(x, y, z, old, packed, flags);
    return true;
  }

  /** Subscribe to cell changes. Listeners run synchronously inside setCell, in subscription order. */
  onCellChange(fn: CellChangeListener): () => void {
    // Copy-on-write: a dispatch in progress keeps iterating the array it started with, so
    // subscribing or unsubscribing from inside a listener never skips or repeats one.
    this.listeners = [...this.listeners, fn];
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  /**
   * Subscribe to chunk additions (addChunk). Listeners run synchronously at the end of
   * addChunk, in subscription order, and may read the new chunk's cells. Copy-on-write like
   * onCellChange.
   */
  onChunkAdd(fn: ChunkAddListener): () => void {
    this.chunkListeners = [...this.chunkListeners, fn];
    return () => {
      this.chunkListeners = this.chunkListeners.filter((f) => f !== fn);
    };
  }

  // ------------------------------------------------------------ light

  /** Sky light 0..15. Above the world 15, below 0, unloaded 15. */
  getSkyLight(x: number, y: number, z: number): number {
    if (y >= WORLD_HEIGHT) return 15;
    if (y < 0) return 0;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return 15;
    return c.light[(x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8)]! >> 4;
  }
  /** Block light 0..15. Outside loaded space 0. */
  getBlockLight(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return 0;
    return c.light[(x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8)]! & 15;
  }
  /** Raw light byte (sky << 4 | block). Same out-of-range rules as the getters. */
  getLightRaw(x: number, y: number, z: number): number {
    if (y >= WORLD_HEIGHT) return 0xf0;
    if (y < 0) return 0;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return 0xf0;
    return c.light[(x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8)]!;
  }
  setSkyLight(x: number, y: number, z: number, v: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return;
    const i = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8);
    const cur = c.light[i]!;
    const next = (cur & 0x0f) | (v << 4);
    if (cur !== next) {
      c.light[i] = next;
      this.markDirty(x, y, z);
    }
  }
  setBlockLight(x: number, y: number, z: number, v: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return;
    const i = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8);
    const cur = c.light[i]!;
    const next = (cur & 0xf0) | (v & 15);
    if (cur !== next) {
      c.light[i] = next;
      this.markDirty(x, y, z);
    }
  }

  // ------------------------------------------------------------ mesh dirtiness

  /**
   * Mark the mesh section containing the cell stale; also the adjacent sections when the
   * cell lies on a section border (meshing reads a 1-cell margin for culling, AO and light).
   */
  markDirty(x: number, y: number, z: number): void {
    const cx = x >> CHUNK_SHIFT;
    const cz = z >> CHUNK_SHIFT;
    const sy = Math.floor(y / SECTION_SIZE);
    const lx = x & CHUNK_MASK;
    const lz = z & CHUNK_MASK;
    const ly = y - sy * SECTION_SIZE;
    const interior = lx > 0 && lx < 15 && lz > 0 && lz < 15 && ly > 0 && ly < 15;
    const key = sectionKey(cx, sy, cz);
    if (interior) {
      if (key !== this.lastDirtyKey) {
        this.dirtySections.add(key);
        this.lastDirtyKey = key;
      }
      return;
    }
    const x0 = lx === 0 ? -1 : 0;
    const x1 = lx === 15 ? 1 : 0;
    const z0 = lz === 0 ? -1 : 0;
    const z1 = lz === 15 ? 1 : 0;
    const y0 = ly === 0 ? -1 : 0;
    const y1 = ly === 15 ? 1 : 0;
    for (let dx = x0; dx <= x1; dx++) {
      for (let dz = z0; dz <= z1; dz++) {
        for (let dy = y0; dy <= y1; dy++) {
          const s = sy + dy;
          if (s < 0 || s >= SECTIONS_PER_CHUNK) continue;
          this.dirtySections.add(sectionKey(cx + dx, s, cz + dz));
        }
      }
    }
    this.lastDirtyKey = -1;
  }

  /**
   * Remove and return all stale section keys. ALWAYS drain through this method (it also
   * resets the internal fast-path cache); never clear `dirtySections` directly.
   */
  takeDirtySections(): number[] {
    const out = [...this.dirtySections];
    this.dirtySections.clear();
    this.lastDirtyKey = -1;
    return out;
  }

  // ------------------------------------------------------------ scheduled ticks

  /** Schedule a block tick `delay` ticks from now for the block id currently expected at the position. */
  scheduleTick(x: number, y: number, z: number, blockId: number, delay: number): void {
    this.ticks.schedule(x, y, z, blockId, this.time + Math.max(1, delay));
  }

  // ------------------------------------------------------------ VoxelGrid transform (identity)

  toWorld(p: Vec3, out: Vec3 = vec3()): Vec3 {
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    return out;
  }
  toLocal(p: Vec3, out: Vec3 = vec3()): Vec3 {
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    return out;
  }
  dirToWorld(d: Vec3, out: Vec3 = vec3()): Vec3 {
    out.x = d.x;
    out.y = d.y;
    out.z = d.z;
    return out;
  }
  dirToLocal(d: Vec3, out: Vec3 = vec3()): Vec3 {
    out.x = d.x;
    out.y = d.y;
    out.z = d.z;
    return out;
  }
  velocityAt(_worldPoint: Vec3, out: Vec3 = vec3()): Vec3 {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  worldRotation(out: Quat = quat()): Quat {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return out;
  }
  cellBounds(): CellBounds | null {
    return null;
  }
}
