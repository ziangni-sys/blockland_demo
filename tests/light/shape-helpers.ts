/**
 * Helpers of the light tests with partial cells (docs/SHAPES.md section 7): worlds lit by a
 * LightEngine, the comparison with the reference of section 7.4, a palette of partial cells,
 * terrain with partial cells near the surface, and the check of section 7.4 that does not depend
 * on section 7.1 (a flood fill on the half-cell grid).
 */
import { expect } from 'vitest';
import { cellPrimary, cellSecond, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, opaqueFill } from '../../src/blocks/shapes';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { NX, NZ, PX, PZ } from '../../src/core/dirs';
import { rand3, type Rng } from '../../src/core/rng';
import { LightEngine } from '../../src/light/engine';
import { cellIndex, Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, NORTH, slab, SOUTH, stairFill, UPPER, WEST } from '../shapes';
import { chunkCell, describeMismatches, diffAgainstReference, heightmapErrors } from './reference';
import { makeTerrainChunk } from './terrain';

export const AIR = 0;
export const STONE = makeCell(B.STONE);
export const GLASS = makeCell(B.GLASS);
export const LAMP = makeCell(B.LAMP);
export const TORCH = makeCell(B.TORCH);
export const WATER = makeCell(B.WATER);
export const LEAVES = makeCell(B.LEAVES_OAK);
export const ICE = makeCell(B.ICE);
export const PLANKS = makeCell(B.PLANKS_OAK);

export const SLAB_FILLS: readonly number[] = [LOWER, UPPER, WEST, EAST, NORTH, SOUTH];

/** A world with an attached engine. */
export function lightWorld(seed = 1): { world: World; engine: LightEngine } {
  const world = new World(seed);
  const engine = new LightEngine(world);
  engine.attach();
  return { world, engine };
}

export function addLit(world: World, engine: LightEngine, chunk: Chunk): void {
  world.addChunk(chunk);
  engine.initChunk(chunk);
}

export function drain(engine: LightEngine): void {
  expect(engine.update()).toBe(true);
  expect(engine.pending).toBe(0);
}

/** The engine's light equals the reference of section 7.4 and every heightmap follows direct(). */
export function expectConsistent(world: World, label: string): void {
  const m = diffAgainstReference(world);
  expect(m.length, `${label}: ${describeMismatches(m)}`).toBe(0);
  const hm = heightmapErrors(world);
  expect(hm.length, `${label}: ${hm.slice(0, 4).join('; ')}`).toBe(0);
}

/** A copy of a chunk (all three layers), as a reload from storage would make it. */
export function copyChunk(c: Chunk): Chunk {
  const l = c.layers();
  return new Chunk(c.cx, c.cz, l.base.slice(), undefined, l.holes?.slice() ?? null, l.part2?.slice() ?? null);
}

/**
 * The partial cells the randomized comparisons use (section 7.4): slabs in the six directions of
 * opaque and transparent materials, stairs, two-part cells of an opaque and a transparent part,
 * crystal-lamp slabs and two-part cells of a lamp and stone.
 */
export const PARTIAL_PALETTE: readonly number[] = Object.freeze([
  ...SLAB_FILLS.map((f) => slab(B.STONE, f)),
  ...SLAB_FILLS.map((f) => slab(B.GLASS, f)),
  slab(B.ICE, LOWER),
  slab(B.LEAVES_OAK, UPPER),
  slab(B.PLANKS_OAK, NORTH),
  slab(B.STONE, stairFill(PX)),
  slab(B.BRICKS, stairFill(NZ)),
  slab(B.PLANKS_OAK, stairFill(PZ)),
  slab(B.STONE, stairFill(NX)),
  canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER)),
  canonCell(slab(B.GLASS, LOWER), slab(B.STONE, UPPER)),
  canonCell(slab(B.PLANKS_OAK, WEST), slab(B.ICE, EAST)),
  canonCell(slab(B.LEAVES_OAK, NORTH), slab(B.STONE, SOUTH)),
  slab(B.LAMP, LOWER),
  slab(B.LAMP, EAST),
  slab(B.LAMP, 0x80),
  canonCell(slab(B.STONE, LOWER), slab(B.LAMP, UPPER)),
  canonCell(slab(B.LAMP, LOWER), slab(B.STONE, UPPER)),
  canonCell(slab(B.LAMP, WEST), slab(B.GLASS, EAST)),
]);

const CUT_MATERIALS = [B.STONE, B.PLANKS_OAK, B.GLASS, B.ICE, B.LEAVES_OAK, B.LAMP];

/** A random partial cell: from the palette, a single part with an arbitrary fill, or two parts with arbitrary disjoint fills. */
export function randomPartial(rng: Rng): number {
  const r = rng.next();
  if (r < 0.5) return PARTIAL_PALETTE[rng.int(0, PARTIAL_PALETTE.length - 1)]!;
  const material = (): number => CUT_MATERIALS[rng.int(0, CUT_MATERIALS.length - 1)]!;
  const fa = rng.int(1, 254);
  if (r < 0.75 || fa === 0xff) return slab(material(), fa);
  const rest = ~fa & 0xff;
  const fb = rest & rng.int(1, 255);
  return fb === 0 ? slab(material(), fa) : canonCell(slab(material(), fa), slab(material(), fb));
}

/** Write packed contents into cell i of three layer arrays. */
export function writeLayers(base: Uint16Array, holes: Uint8Array, part2: Uint32Array, i: number, packed: number): void {
  const cell = cellPrimary(packed);
  base[i] = cell & 0xffff;
  holes[i] = (cell >>> 16) & 0xff;
  part2[i] = cellSecond(packed);
}

/**
 * Test terrain (terrain.ts) with partial cells near the surface: at about `rate` of the cells from
 * two below to six above the ground, a random partial cell. Pure function of the coordinates and
 * the seed, like makeTerrainChunk.
 */
export function makeShapedTerrainChunk(cx: number, cz: number, seed: number, rate: number): Chunk {
  const plain = makeTerrainChunk(cx, cz, seed);
  const base = plain.cells;
  const holes = new Uint8Array(base.length);
  const part2 = new Uint32Array(base.length);
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      let top = 0;
      for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
        if (base[cellIndex(lx, y, lz)] !== 0) {
          top = y;
          break;
        }
      }
      for (let y = Math.max(0, top - 2); y <= Math.min(WORLD_HEIGHT - 1, top + 6); y++) {
        const x = cx * 16 + lx;
        const z = cz * 16 + lz;
        if (rand3(x, y, z, seed + 21) >= rate) continue;
        const pick = Math.floor(rand3(z, x, y, seed + 22) * PARTIAL_PALETTE.length);
        writeLayers(base, holes, part2, cellIndex(lx, y, lz), PARTIAL_PALETTE[pick]!);
      }
    }
  }
  return new Chunk(cx, cz, base, undefined, holes, part2);
}

/**
 * The check of section 7.4 that does not depend on section 7.1: a flood fill over the half-cell
 * grid of the lit chunks, from the open-sky octants (no octant filled by opaque material above
 * them in their half-cell column) through octants not filled by opaque material, by face-adjacent
 * steps. Absent chunks pass nothing. Returns whether some octant of the cell was reached.
 */
export function skyReachable(world: World): (x: number, y: number, z: number) => boolean {
  const chunks = [...world.chunks.values()].filter((c) => c.lit);
  let minCx = Infinity;
  let minCz = Infinity;
  let maxCx = -Infinity;
  let maxCz = -Infinity;
  for (const c of chunks) {
    minCx = Math.min(minCx, c.cx);
    minCz = Math.min(minCz, c.cz);
    maxCx = Math.max(maxCx, c.cx);
    maxCz = Math.max(maxCz, c.cz);
  }
  const sx = (maxCx - minCx + 1) * 16;
  const sz = (maxCz - minCz + 1) * 16;
  const H = WORLD_HEIGHT;
  // Opaque fill per cell; 0x100 marks a cell outside every lit chunk (nothing passes).
  const fill = new Uint16Array(sx * sz * H).fill(0x100);
  for (const c of chunks) {
    const bx = (c.cx - minCx) * 16;
    const bz = (c.cz - minCz) * 16;
    for (let y = 0; y < H; y++) {
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) fill[(y * sz + bz + lz) * sx + bx + lx] = opaqueFill(chunkCell(c, cellIndex(lx, y, lz)));
    }
  }
  const hx = sx * 2;
  const hy = H * 2;
  const hz = sz * 2;
  const passable = (X: number, Y: number, Z: number): boolean => {
    const f = fill[((Y >> 1) * sz + (Z >> 1)) * sx + (X >> 1)]!;
    return f !== 0x100 && ((f >> ((X & 1) | ((Y & 1) << 1) | ((Z & 1) << 2))) & 1) === 0;
  };
  const seen = new Uint8Array(hx * hy * hz);
  const id = (X: number, Y: number, Z: number): number => (Y * hz + Z) * hx + X;
  let stack = new Int32Array(1 << 16);
  let top = 0;
  const push = (X: number, Y: number, Z: number): void => {
    seen[id(X, Y, Z)] = 1;
    if (top + 3 > stack.length) {
      const next = new Int32Array(stack.length * 2);
      next.set(stack);
      stack = next;
    }
    stack[top++] = X;
    stack[top++] = Y;
    stack[top++] = Z;
  };
  for (let Z = 0; Z < hz; Z++) {
    for (let X = 0; X < hx; X++) {
      for (let Y = hy - 1; Y >= 0 && passable(X, Y, Z); Y--) push(X, Y, Z);
    }
  }
  const STEPS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const;
  while (top > 0) {
    const Z = stack[--top]!;
    const Y = stack[--top]!;
    const X = stack[--top]!;
    for (const [dx, dy, dz] of STEPS) {
      const A = X + dx;
      const Bh = Y + dy;
      const C = Z + dz;
      if (A < 0 || Bh < 0 || C < 0 || A >= hx || Bh >= hy || C >= hz) continue;
      if (seen[id(A, Bh, C)] || !passable(A, Bh, C)) continue;
      push(A, Bh, C);
    }
  }
  const x0 = minCx * 16;
  const z0 = minCz * 16;
  return (x, y, z) => {
    const lx = x - x0;
    const lz = z - z0;
    for (let o = 0; o < 8; o++) if (seen[id(2 * lx + (o & 1), 2 * y + ((o >> 1) & 1), 2 * lz + ((o >> 2) & 1))]) return true;
    return false;
  };
}

/** Every lit cell with sky light the half-cell flood cannot reach ("leaks"). */
export function skyLeaks(world: World): string[] {
  const reach = skyReachable(world);
  const out: string[] = [];
  for (const c of world.chunks.values()) {
    if (!c.lit) continue;
    for (let i = 0; i < c.light.length; i++) {
      if (c.light[i]! >> 4 === 0) continue;
      const x = c.cx * 16 + (i & 15);
      const y = i >> 8;
      const z = c.cz * 16 + ((i >> 4) & 15);
      if (!reach(x, y, z)) out.push(`(${x},${y},${z}) sky ${c.light[i]! >> 4}`);
    }
  }
  return out;
}
