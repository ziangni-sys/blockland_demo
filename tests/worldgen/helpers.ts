/** Shared helpers for worldgen tests. */
import { CHUNK_SIZE, WORLD_HEIGHT } from '../../src/core/constants';
import type { ChunkGenerator } from '../../src/worldgen/generator';

/** A square of generated chunks addressed in world coordinates. */
export class ChunkArea {
  readonly cx0: number;
  readonly cz0: number;
  readonly n: number;
  readonly x0: number;
  readonly z0: number;
  readonly chunks: Uint16Array[] = [];

  constructor(gen: ChunkGenerator, cx0: number, cz0: number, n: number) {
    this.cx0 = cx0;
    this.cz0 = cz0;
    this.n = n;
    this.x0 = cx0 * CHUNK_SIZE;
    this.z0 = cz0 * CHUNK_SIZE;
    for (let cz = 0; cz < n; cz++) for (let cx = 0; cx < n; cx++) this.chunks.push(gen.generate(cx0 + cx, cz0 + cz));
  }

  get size(): number {
    return this.n * CHUNK_SIZE;
  }

  inside(x: number, z: number): boolean {
    return x >= this.x0 && z >= this.z0 && x < this.x0 + this.size && z < this.z0 + this.size;
  }

  /** Cell at world (x, y, z); -1 outside the area horizontally, 0 above the world. */
  get(x: number, y: number, z: number): number {
    if (!this.inside(x, z)) return -1;
    if (y < 0) return -1;
    if (y >= WORLD_HEIGHT) return 0;
    const lx = x - this.x0;
    const lz = z - this.z0;
    const c = this.chunks[(lx >> 4) + (lz >> 4) * this.n]!;
    return c[(lx & 15) | ((lz & 15) << 4) | (y << 8)]!;
  }

  /** Visit every cell of the area. */
  forEach(fn: (x: number, y: number, z: number, cell: number) => void): void {
    for (let cz = 0; cz < this.n; cz++) {
      for (let cx = 0; cx < this.n; cx++) {
        const c = this.chunks[cx + cz * this.n]!;
        const bx = this.x0 + cx * CHUNK_SIZE;
        const bz = this.z0 + cz * CHUNK_SIZE;
        for (let i = 0; i < c.length; i++) fn(bx + (i & 15), i >> 8, bz + ((i >> 4) & 15), c[i]!);
      }
    }
  }
}

/** FNV-1a over a chunk, for compact equality checks. */
export function chunkHash(cells: Uint16Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cells.length; i++) {
    h ^= cells[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
