/** Shared world builders and probes for the liquid tests. Worlds are built by hand (no worldgen). */
import { CHUNK_SHIFT, CHUNK_VOLUME, WORLD_HEIGHT } from '../../src/core/constants';
import { AIR, ID_MASK, cellState, isLiquidSource, liquidAmount, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { LIQUID } from '../../src/blocks/registry';
import { Chunk, chunkKey } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { Fluids, pumpTicks } from '../../src/liquid/fluids';

export const STONE = makeCell(B.STONE);
/** Top of the standard platform. Liquid placed on it lives at y = SURFACE. */
export const FLOOR_Y = 10;
export const SURFACE = FLOOR_Y + 1;

export type CellFn = (x: number, y: number, z: number) => number;

/** Stone slab at FLOOR_Y everywhere. */
export const platform: CellFn = (_x, y) => (y === FLOOR_Y ? STONE : AIR);

/** Build one chunk from a world-space cell function. */
export function makeChunk(cx: number, cz: number, fn: CellFn): Chunk {
  const chunk = new Chunk(cx, cz);
  const x0 = cx << CHUNK_SHIFT;
  const z0 = cz << CHUNK_SHIFT;
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const c = fn(x0 + lx, y, z0 + lz);
        if (c !== AIR) chunk.set(lx, y, lz, c);
      }
    }
  }
  return chunk;
}

export interface ChunkRange {
  minCx: number;
  maxCx: number;
  minCz: number;
  maxCz: number;
}

/** 3 x 3 chunks around the origin: world x, z in [-16, 32). */
export const AROUND_ORIGIN: ChunkRange = { minCx: -1, maxCx: 1, minCz: -1, maxCz: 1 };

export function chunkCoords(r: ChunkRange): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let cz = r.minCz; cz <= r.maxCz; cz++) {
    for (let cx = r.minCx; cx <= r.maxCx; cx++) out.push([cx, cz]);
  }
  return out;
}

export interface FluidWorld {
  world: World;
  fluids: Fluids;
}

/** A world holding the chunks of `range` filled by `fn`, with a Fluids (attached unless told otherwise). */
export function buildWorld(fn: CellFn = platform, range: ChunkRange = AROUND_ORIGIN, attach = true): FluidWorld {
  const world = new World(1);
  for (const [cx, cz] of chunkCoords(range)) world.addChunk(makeChunk(cx, cz, fn));
  const fluids = new Fluids(world);
  if (attach) fluids.attach();
  return { world, fluids };
}

export const water = (level = 0, falling = false): number => makeCell(B.WATER, (level & 7) | (falling ? 8 : 0));
export const lava = (level = 0, falling = false): number => makeCell(B.LAVA, (level & 7) | (falling ? 8 : 0));

/** Pump until no tick is pending; returns the number of ticks pumped. Throws when it never settles. */
export function pumpUntilQuiet(fw: FluidWorld, maxTicks = 5000): number {
  let n = 0;
  while (fw.world.ticks.size > 0) {
    if (n >= maxTicks) throw new Error(`liquids did not settle within ${maxTicks} ticks`);
    pumpTicks(fw.world, fw.fluids, 1);
    n++;
  }
  return n;
}

export interface LiquidCell {
  x: number;
  y: number;
  z: number;
  id: number;
  state: number;
}

/** Every liquid cell in the world, sorted by (y, z, x). */
export function liquidCells(world: World, id?: number): LiquidCell[] {
  const out: LiquidCell[] = [];
  for (const chunk of world.chunks.values()) {
    const x0 = chunk.cx << CHUNK_SHIFT;
    const z0 = chunk.cz << CHUNK_SHIFT;
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      const c = chunk.cells[i]!;
      const cid = c & ID_MASK;
      if (LIQUID[cid] === 0 || (id !== undefined && cid !== id)) continue;
      out.push({ x: x0 + (i & 15), y: i >> 8, z: z0 + ((i >> 4) & 15), id: cid, state: cellState(c) });
    }
  }
  out.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  return out;
}

export function countLiquid(world: World, id?: number): number {
  return liquidCells(world, id).length;
}

export function amountAt(world: World, x: number, y: number, z: number): number {
  const c = world.getCell(x, y, z);
  return LIQUID[c & ID_MASK] === 0 ? 0 : liquidAmount(cellState(c));
}

export function isSourceAt(world: World, x: number, y: number, z: number, id: number): boolean {
  const c = world.getCell(x, y, z);
  return (c & ID_MASK) === id && isLiquidSource(cellState(c));
}

/** Copy of every chunk's cells, keyed by chunk key. */
export function snapshotCells(world: World): Map<number, Uint16Array> {
  const out = new Map<number, Uint16Array>();
  for (const [k, c] of world.chunks) out.set(k, c.cells.slice());
  return out;
}

/** Fresh world holding copies of the given chunks' cells (no ticks), with an attached Fluids. */
export function cloneWorld(src: World, time = src.time): FluidWorld {
  const world = new World(src.seed);
  world.time = time;
  for (const c of src.chunks.values()) world.addChunk(new Chunk(c.cx, c.cz, c.cells.slice(), c.light.slice()));
  const fluids = new Fluids(world);
  fluids.attach();
  return { world, fluids };
}

/** Index of the |dx|+|dz| <= r diamond as "x,z" keys. */
export function diamond(cx: number, cz: number, r: number): Set<string> {
  const s = new Set<string>();
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) if (Math.abs(dx) + Math.abs(dz) <= r) s.add(`${cx + dx},${cz + dz}`);
  }
  return s;
}

export function chunkKeyOf(cx: number, cz: number): number {
  return chunkKey(cx, cz);
}
