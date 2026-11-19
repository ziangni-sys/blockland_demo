/**
 * Chunk lifecycle on the server: which chunk columns should be loaded around the points of
 * interest, generating (or restoring) them, and unloading far chunks while keeping their
 * modifications.
 *
 * `wanted()` lists the columns that are needed, nearest first; the server host generates them
 * between ticks within a time budget (net/host/host.ts generateChunks), tests and tools inside the
 * tick (SimOptions.syncChunks), both through `loadColumn()`. Chunks that the player has modified
 * are kept as encoded bytes (`stash`) once unloaded and are restored from there — never
 * regenerated — so edits survive unloading and saving.
 *
 * NO LIGHT (docs/NETCODE.md section 15, package 9). The game rules never read light, so the server
 * computes none: light is the client's (net/client/replica.ts). Every chunk of one manager shares
 * one light array that nobody writes, holding open sky (sky 15, block 0: what World reports where
 * it has no light data, e.g. above the world or in an unloaded column), which saves 32 KB a column.
 */
import { CHUNK_SHIFT, CHUNK_VOLUME } from '../core/constants';
import { Chunk, chunkKey } from '../voxel/chunk';
import type { World } from '../voxel/world';
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

/** The light byte of open sky (sky light 15, block light 0). */
const OPEN_SKY = 0xf0;

export class ChunkManager {
  /** Encoded cells of modified chunks that are currently not loaded. key = chunkKey. */
  readonly stash = new Map<number, Uint8Array>();
  /** Keys of stashed chunks that could not be decoded and were regenerated instead. */
  readonly corrupted: number[] = [];
  /** Extra chunks kept beyond an anchor's radius before unloading (hysteresis). */
  unloadMargin = 2;

  private anchors: LoadAnchor[] = [];
  /** The light array every chunk of this manager shares (open sky; never written: see the file comment). */
  private readonly light = new Uint8Array(CHUNK_VOLUME).fill(OPEN_SKY);

  constructor(
    private readonly world: World,
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
   * Columns that should be loaded but are not, nearest to an anchor first, at most `max` (load
   * them with loadColumn). Columns that exist in the stash are restored immediately and not
   * returned.
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
          if (this.world.getChunk(cx, cz)) continue;
          out.push({ cx, cz, d });
        }
      }
    }
    out.sort((p, q) => p.d - q.d || p.cx - q.cx || p.cz - q.cz);
    const result: ChunkRequest[] = [];
    for (const c of out) {
      const key = chunkKey(c.cx, c.cz);
      if (this.tryRestore(key)) continue;
      if (result.length >= max) continue;
      result.push({ cx: c.cx, cz: c.cz });
    }
    return result;
  }

  /**
   * Restore a column from the stash. Returns null when there is nothing stashed, or when
   * the stashed bytes are unreadable — a corrupted chunk must not throw in the middle of
   * a tick; it is dropped (recorded in `corrupted`) and the column is regenerated.
   */
  private tryRestore(key: number): Chunk | null {
    const bytes = this.stash.get(key);
    if (!bytes) return null;
    this.stash.delete(key);
    let dec: { cx: number; cz: number; cells: Uint16Array };
    try {
      dec = decodeChunk(bytes);
    } catch {
      this.corrupted.push(key);
      return null;
    }
    const chunk = new Chunk(dec.cx, dec.cz, dec.cells, this.light);
    chunk.modified = true;
    return this.insert(chunk);
  }

  private insert(chunk: Chunk): Chunk {
    this.world.addChunk(chunk);
    // Wakes the chunk's restless liquid and re-checks the facing border columns of the
    // already-loaded neighbours (their liquid may now have somewhere to go).
    this.fluids.rescheduleChunk(chunk);
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
    const restored = this.tryRestore(key);
    if (restored) return restored;
    return this.insert(new Chunk(cx, cz, generator.generate(cx, cz), this.light));
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

  /**
   * The cells of a stashed (modified, unloaded) column, decoded without restoring it; null when
   * the column is not stashed or its bytes cannot be decoded (it is then regenerated when it
   * loads, so its cells are the generator's). The network replication answers a subscription to
   * an unloaded column with this (NETCODE section 6).
   */
  stashedCells(cx: number, cz: number): Uint16Array | null {
    const bytes = this.stash.get(chunkKey(cx, cz));
    if (bytes === undefined) return null;
    try {
      return decodeChunk(bytes).cells;
    } catch {
      return null;
    }
  }
}
