/**
 * Chunk lifecycle: which chunk columns should be loaded around the points of interest,
 * feeding generated (or saved) cells into the world, and unloading far chunks while
 * keeping their modifications.
 *
 * Generation is PULLED: `wanted()` lists the columns that are needed; whoever owns the
 * generator (a Worker pool in the browser, a synchronous generator in tests) produces
 * the cells and hands them to `provide()`. Chunks that the player has modified are kept
 * as encoded bytes (`stash`) once unloaded and are restored from there — never
 * regenerated — so edits survive unloading and saving.
 */
import { CHUNK_SHIFT } from '../core/constants';
import { Chunk, chunkKey, chunkKeyX, chunkKeyZ } from '../voxel/chunk';
import type { World } from '../voxel/world';
import type { LightEngine } from '../light/engine';
import type { Fluids } from '../liquid/fluids';
import { decodeChunk, encodeChunk } from '../save/codec';
import type { ChunkGenerator } from '../worldgen/generator';

export interface ChunkRequest {
  cx: number;
  cz: number;
}

/** A point around which chunks must stay loaded (the player, every physical structure). */
export interface LoadAnchor {
  x: number;
  z: number;
  /** Radius in chunks. */
  radius: number;
}

export class ChunkManager {
  /** Encoded cells of modified chunks that are currently not loaded. key = chunkKey. */
  readonly stash = new Map<number, Uint8Array>();
  /** Columns handed out by wanted() and not yet provided. */
  private readonly pending = new Set<number>();
  /** Called after a chunk was removed from the world (the client drops its meshes). */
  onUnload: ((cx: number, cz: number) => void) | null = null;
  /** Called after a chunk was added and lit. */
  onLoad: ((chunk: Chunk) => void) | null = null;
  /** Extra chunks kept beyond an anchor's radius before unloading (hysteresis). */
  unloadMargin = 2;

  private anchors: LoadAnchor[] = [];

  constructor(
    private readonly world: World,
    private readonly light: LightEngine,
    private readonly fluids: Fluids,
  ) {}

  /** Replace the points of interest. Call every tick (cheap). */
  setAnchors(anchors: LoadAnchor[]): void {
    this.anchors = anchors;
  }

  /** True when the column is inside some anchor's radius (+ extra). */
  private inRange(cx: number, cz: number, extra: number): boolean {
    for (const a of this.anchors) {
      const acx = Math.floor(a.x) >> CHUNK_SHIFT;
      const acz = Math.floor(a.z) >> CHUNK_SHIFT;
      const r = a.radius + extra;
      const dx = cx - acx;
      const dz = cz - acz;
      if (dx * dx + dz * dz <= r * r + r) return true;
    }
    return false;
  }

  /**
   * Columns that should be loaded but are neither loaded nor pending, nearest to an
   * anchor first, at most `max`. Returned columns become pending until provide() or
   * cancel(). Columns that exist in the stash are restored immediately and not returned.
   */
  wanted(max: number): ChunkRequest[] {
    const out: Array<ChunkRequest & { d: number }> = [];
    const seen = new Set<number>();
    for (const a of this.anchors) {
      const acx = Math.floor(a.x) >> CHUNK_SHIFT;
      const acz = Math.floor(a.z) >> CHUNK_SHIFT;
      const r = a.radius;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = dx * dx + dz * dz;
          if (d > r * r + r) continue;
          const cx = acx + dx;
          const cz = acz + dz;
          const key = chunkKey(cx, cz);
          if (seen.has(key)) continue;
          seen.add(key);
          if (this.pending.has(key) || this.world.getChunk(cx, cz)) continue;
          out.push({ cx, cz, d });
        }
      }
    }
    out.sort((p, q) => p.d - q.d || p.cx - q.cx || p.cz - q.cz);
    const result: ChunkRequest[] = [];
    for (const c of out) {
      const key = chunkKey(c.cx, c.cz);
      const saved = this.stash.get(key);
      if (saved) {
        this.restore(key, saved);
        continue;
      }
      if (result.length >= max) continue;
      this.pending.add(key);
      result.push({ cx: c.cx, cz: c.cz });
    }
    return result;
  }

  /** Give up on a pending request (e.g. the worker was terminated). */
  cancel(cx: number, cz: number): void {
    this.pending.delete(chunkKey(cx, cz));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Insert freshly generated cells. Ignored when the column is already loaded. */
  provide(cx: number, cz: number, cells: Uint16Array): Chunk | null {
    const key = chunkKey(cx, cz);
    this.pending.delete(key);
    if (this.world.getChunk(cx, cz)) return null;
    const saved = this.stash.get(key);
    if (saved) return this.restore(key, saved);
    return this.insert(new Chunk(cx, cz, cells));
  }

  private restore(key: number, bytes: Uint8Array): Chunk {
    const dec = decodeChunk(bytes);
    const chunk = new Chunk(dec.cx, dec.cz, dec.cells);
    chunk.modified = true;
    this.stash.delete(key);
    this.pending.delete(key);
    return this.insert(chunk);
  }

  private insert(chunk: Chunk): Chunk {
    this.world.addChunk(chunk);
    this.light.initChunk(chunk);
    // Liquids at the borders of already-loaded neighbours may now have somewhere to go.
    this.fluids.rescheduleChunk(chunk);
    for (let d = 0; d < 4; d++) {
      const n = this.world.getChunk(chunk.cx + (d === 0 ? 1 : d === 1 ? -1 : 0), chunk.cz + (d === 2 ? 1 : d === 3 ? -1 : 0));
      if (n) this.fluids.rescheduleChunk(n);
    }
    this.onLoad?.(chunk);
    return chunk;
  }

  /** Generate (or restore) synchronously every column within `radius` chunks of a world position. */
  loadAround(generator: ChunkGenerator, x: number, z: number, radius: number): void {
    const acx = Math.floor(x) >> CHUNK_SHIFT;
    const acz = Math.floor(z) >> CHUNK_SHIFT;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        this.loadColumn(generator, acx + dx, acz + dz);
      }
    }
  }

  /** Generate (or restore) one column synchronously if it is not loaded. */
  loadColumn(generator: ChunkGenerator, cx: number, cz: number): Chunk | null {
    if (this.world.getChunk(cx, cz)) return null;
    const key = chunkKey(cx, cz);
    const saved = this.stash.get(key);
    if (saved) return this.restore(key, saved);
    this.pending.delete(key);
    return this.insert(new Chunk(cx, cz, generator.generate(cx, cz)));
  }

  /**
   * Unload columns that are outside every anchor's radius + unloadMargin. Modified
   * columns go to the stash. Returns the number of columns removed.
   */
  unloadFar(maxPerCall = 8): number {
    let removed = 0;
    for (const [key, chunk] of this.world.chunks) {
      if (removed >= maxPerCall) break;
      if (this.inRange(chunk.cx, chunk.cz, this.unloadMargin)) continue;
      if (chunk.modified) this.stash.set(key, encodeChunk(chunk));
      this.world.removeChunk(chunk.cx, chunk.cz);
      this.onUnload?.(chunk.cx, chunk.cz);
      removed++;
    }
    return removed;
  }

  /**
   * Everything that must be written to a save: encoded bytes of every modified chunk,
   * loaded or stashed.
   */
  modifiedChunks(): Array<[number, Uint8Array]> {
    const out: Array<[number, Uint8Array]> = [];
    for (const [key, bytes] of this.stash) out.push([key, bytes]);
    for (const [key, chunk] of this.world.chunks) {
      if (chunk.modified) out.push([key, encodeChunk(chunk)]);
    }
    return out;
  }

  /** Load the modified chunks of a save (they are restored lazily when they come into range). */
  setSaved(entries: Iterable<readonly [number, Uint8Array]>): void {
    this.stash.clear();
    for (const [key, bytes] of entries) this.stash.set(key, bytes);
  }

  /** Chunk coordinates of a stash key (for debugging). */
  static keyCoords(key: number): { cx: number; cz: number } {
    return { cx: chunkKeyX(key), cz: chunkKeyZ(key) };
  }
}
