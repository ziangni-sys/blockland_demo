/**
 * The world grid: chunk storage, light storage, change hooks, scheduled block ticks and
 * mesh-dirty tracking. Pure data — no generation, no lighting logic, no rendering.
 *
 * Every mutation of a world cell goes through World.setCell(), which is the single
 * "block changed / removed" hook point (docs/LESSONS.md: 移除方块有好几条路径，要统一挂钩子).
 */
import { CHUNK_MASK, CHUNK_SHIFT, SECTION_SIZE, SECTIONS_PER_CHUNK, WORLD_HEIGHT } from '../core/constants';
import { quat, vec3, type Quat, type Vec3 } from '../core/math';
import { AIR, ID_MASK } from '../blocks/cell';
import { CELL_BELOW_WORLD, CELL_UNLOADED } from '../blocks/defs';
import { Chunk, chunkKey, sectionKey } from './chunk';
import { SET_DEFAULT, type CellBounds, type VoxelGrid } from './grid';

/** Called after a world cell changed. `flags` are the SET_* flags passed to setCell. */
export type CellChangeListener = (
  x: number,
  y: number,
  z: number,
  oldCell: number,
  newCell: number,
  flags: number,
) => void;

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

  get size(): number {
    return this.byPos.size;
  }

  schedule(x: number, y: number, z: number, id: number, at: number): void {
    const k = posKey(x, y, z);
    const cur = this.byPos.get(k);
    if (cur && cur.id === id && cur.at <= at) return;
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
   * Remove and return every tick due at exactly `now`, in scheduling order.
   * The caller must call this once per world tick with consecutive `now` values.
   */
  takeDue(now: number): ScheduledTick[] {
    const b = this.buckets.get(now);
    if (!b) return [];
    this.buckets.delete(now);
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
  private lastChunk: Chunk | null = null;
  private lastDirtyKey = -1;

  constructor(seed = 0) {
    this.seed = seed >>> 0;
  }

  // ------------------------------------------------------------ chunks

  getChunk(cx: number, cz: number): Chunk | undefined {
    const lc = this.lastChunk;
    if (lc && lc.cx === cx && lc.cz === cz) return lc;
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) this.lastChunk = c;
    return c;
  }
  /** Chunk containing world column (x,z), if loaded. */
  chunkAt(x: number, z: number): Chunk | undefined {
    return this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
  }
  /** Insert a chunk and mark it and its neighbours' border sections for meshing. */
  addChunk(chunk: Chunk): void {
    this.chunks.set(chunkKey(chunk.cx, chunk.cz), chunk);
    this.lastChunk = chunk;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!this.getChunk(chunk.cx + dx, chunk.cz + dz)) continue;
        for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
          this.dirtySections.add(sectionKey(chunk.cx + dx, sy, chunk.cz + dz));
        }
      }
    }
    this.lastDirtyKey = -1;
  }
  removeChunk(cx: number, cz: number): Chunk | undefined {
    const k = chunkKey(cx, cz);
    const c = this.chunks.get(k);
    if (!c) return undefined;
    this.chunks.delete(k);
    if (this.lastChunk === c) this.lastChunk = null;
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
   * Cell at integer world coordinates.
   * y < 0 -> deeprock; y >= WORLD_HEIGHT -> AIR; unloaded chunk -> CELL_UNLOADED (solid).
   */
  getCell(x: number, y: number, z: number): number {
    if (y < 0) return CELL_BELOW_WORLD;
    if (y >= WORLD_HEIGHT) return AIR;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return CELL_UNLOADED;
    return c.cells[(x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8)]!;
  }
  /** Block id at integer world coordinates. */
  getId(x: number, y: number, z: number): number {
    return this.getCell(x, y, z) & ID_MASK;
  }

  /**
   * Write a cell and notify listeners. Returns false (and does nothing) when out of the
   * vertical range, in an unloaded chunk, or when the cell is unchanged.
   */
  setCell(x: number, y: number, z: number, cell: number, flags: number = SET_DEFAULT): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const c = this.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!c) return false;
    const i = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8);
    const old = c.cells[i]!;
    if (old === cell) return false;
    c.cells[i] = cell;
    c.modified = true;
    this.markDirty(x, y, z);
    const ls = this.listeners;
    for (let k = 0; k < ls.length; k++) ls[k]!(x, y, z, old, cell, flags);
    return true;
  }

  /** Subscribe to cell changes. Listeners run synchronously inside setCell, in subscription order. */
  onCellChange(fn: CellChangeListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
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
