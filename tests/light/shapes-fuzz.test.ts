/**
 * Randomized comparisons of the light engine with partial cells (docs/SHAPES.md 7.4, 16.2 P5)
 * against the reference of section 7.4 (tests/light/reference.ts), built like the full-block
 * comparisons of engine.test.ts (which stay as they are): random edits with budgeted, interleaved
 * update() calls, chunks streaming in and out, chunk borders with a holes layer on one side only.
 * The edits include partial cells of every kind of the palette, changes of only the holes of a
 * part and changes of only the second part.
 *
 * And the check of section 7.4 that does not depend on section 7.1: in random scenes whose cells
 * keep their non-opaque octants connected (slabs, stairs, cubes missing one or two adjacent
 * octants), no cell the half-cell flood fill from the open sky cannot reach has sky light.
 */
import { describe, expect, it } from 'vitest';
import { CELL_MULTI_BIT, ID_MASK, partHoles, withHoles } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { CUTTABLE } from '../../src/blocks/registry';
import { canonCell, opaqueFill } from '../../src/blocks/shapes';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { NX, NZ, PX, PZ } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import type { LightEngine } from '../../src/light/engine';
import { cellIndex, chunkKey, type Chunk } from '../../src/voxel/chunk';
import { getPacked } from '../../src/voxel/parts';
import type { World } from '../../src/voxel/world';
import { slab, stairFill } from '../shapes';
import { chunkCell, lightSnapshot } from './reference';
import {
  addLit,
  AIR,
  copyChunk,
  drain,
  expectConsistent,
  GLASS,
  ICE,
  LAMP,
  LEAVES,
  lightWorld,
  makeShapedTerrainChunk,
  PLANKS,
  randomPartial,
  skyLeaks,
  STONE,
  TORCH,
  WATER,
} from './shape-helpers';
import { makeFlatChunk, makeTerrainChunk } from './terrain';

const FULL_EDITS = [AIR, AIR, AIR, STONE, STONE, LEAVES, WATER, ICE, GLASS, LAMP, TORCH, PLANKS];

function grid(x0: number, x1: number, z0: number, z1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) out.push([cx, cz]);
  return out;
}

/** A random edit position, biased toward chunk borders and corners and the column tops. */
function randomPos(world: World, rng: Rng, minX: number, maxX: number, minZ: number, maxZ: number): [number, number, number] {
  let x = rng.int(minX, maxX);
  let z = rng.int(minZ, maxZ);
  const r = rng.next();
  if (r < 0.25) {
    if (rng.chance(0.5)) x = Math.floor(x / 16) * 16 + (rng.chance(0.5) ? 0 : 15);
    else z = Math.floor(z / 16) * 16 + (rng.chance(0.5) ? 0 : 15);
  } else if (r < 0.32) {
    x = Math.floor(x / 16) * 16 + (rng.chance(0.5) ? 0 : 15);
    z = Math.floor(z / 16) * 16 + (rng.chance(0.5) ? 0 : 15);
  }
  const c = world.chunkAt(x, z);
  const h = c ? c.heightmap[(x & 15) | ((z & 15) << 4)]! : 40;
  const t = rng.next();
  const y = t < 0.45 ? h - 1 + rng.int(-1, 2) : t < 0.55 ? (rng.chance(0.5) ? 0 : WORLD_HEIGHT - 1) : rng.int(20, 80);
  return [x, Math.max(0, Math.min(WORLD_HEIGHT - 1, y)), z];
}

/**
 * A new content for the cell at (x, y, z) whose chunk may hold partial cells: a random partial
 * cell, a full block, or, for a cell of cuttable material, the same part with other holes, or
 * the same first part with another second part.
 */
function shapedContent(world: World, rng: Rng, x: number, y: number, z: number): number {
  const r = rng.next();
  const cur = getPacked(world, x, y, z);
  const first = cur % 2 ** 25 & 0xffffff;
  const id = first & ID_MASK;
  if (r < 0.2 && id !== 0 && CUTTABLE[id] === 1 && cur < CELL_MULTI_BIT) {
    // Only the holes change (the base layer keeps its id and state).
    let holes = rng.int(1, 254);
    if (holes === partHoles(first)) holes ^= 1;
    return withHoles(first, holes);
  }
  if (r < 0.3 && cur >= 2 ** 25) {
    // Only the second part changes (its material; its octants stay).
    const second = Math.floor(cur / 2 ** 25);
    const fill = ~partHoles(second) & 0xff;
    const mats = [B.STONE, B.GLASS, B.LAMP, B.ICE, B.PLANKS_OAK];
    return canonCell(first, slab(mats[rng.int(0, mats.length - 1)]!, fill));
  }
  if (r < 0.75) return randomPartial(rng);
  return FULL_EDITS[rng.int(0, FULL_EDITS.length - 1)]!;
}

interface FuzzOptions {
  seed: number;
  coords: Array<[number, number]>;
  /** Chunks that may hold partial cells (from their terrain and from edits). */
  layered: (cx: number, cz: number) => boolean;
  edits: number;
  checkEvery: number;
  maxBudget: number;
  /** Chunks unload and reload (with their three layers) now and then. */
  streaming?: boolean;
}

function shapedFuzz(o: FuzzOptions): void {
  const { world, engine } = lightWorld();
  const make = (cx: number, cz: number): Chunk => (o.layered(cx, cz) ? makeShapedTerrainChunk(cx, cz, 1, 0.06) : makeTerrainChunk(cx, cz, 1));
  for (const [cx, cz] of o.coords) addLit(world, engine, make(cx, cz));
  const rng = new Rng(o.seed);
  const xs = o.coords.map((c) => c[0]);
  const zs = o.coords.map((c) => c[1]);
  const minX = Math.min(...xs) * 16;
  const maxX = Math.max(...xs) * 16 + 15;
  const minZ = Math.min(...zs) * 16;
  const maxZ = Math.max(...zs) * 16 + 15;
  const away = new Map<number, Chunk>();
  let partialEdits = 0;
  for (let k = 1; k <= o.edits; k++) {
    const [x, y, z] = randomPos(world, rng, minX, maxX, minZ, maxZ);
    const c = world.chunkAt(x, z);
    if (c) {
      const shaped = o.layered(c.cx, c.cz);
      const r = rng.next();
      if (r < 0.12 && shaped) {
        // A small roof of slabs over the edit position, alternating lower and upper or west and east.
        const a = rng.chance(0.5) ? [0x33, 0xcc] : [0x55, 0xaa];
        for (let dx = 0; dx < 3; dx++) {
          for (let dz = 0; dz < 3; dz++) {
            const xx = x + dx;
            const zz = z + dz;
            const cc = world.chunkAt(xx, zz);
            if (cc && o.layered(cc.cx, cc.cz)) world.setCell(xx, y, zz, slab(B.STONE, a[(dx + dz) & 1]!));
          }
        }
        partialEdits++;
      } else {
        const content = shaped ? shapedContent(world, rng, x, y, z) : FULL_EDITS[rng.int(0, FULL_EDITS.length - 1)]!;
        if (content >= 1 << 16) partialEdits++;
        world.setCell(x, y, z, content);
      }
    }
    const r = rng.next();
    if (r < 0.3) engine.update(rng.int(0, o.maxBudget));
    else if (r < 0.4) engine.update();
    if (o.streaming) {
      const s = rng.next();
      const present = [...world.chunks.values()];
      if (s < 0.03 && present.length > 3) {
        const v = present[rng.int(0, present.length - 1)]!;
        world.removeChunk(v.cx, v.cz);
        away.set(chunkKey(v.cx, v.cz), v);
        if (rng.chance(0.5)) engine.update(rng.int(0, 100));
      } else if (s < 0.06 && away.size > 0) {
        const keys = [...away.keys()];
        const key = keys[rng.int(0, keys.length - 1)]!;
        const v = away.get(key)!;
        away.delete(key);
        addLit(world, engine, rng.chance(0.7) ? copyChunk(v) : v);
      } else if (s < 0.08) {
        const v = present[rng.int(0, present.length - 1)]!;
        if (world.getChunk(v.cx, v.cz) === v) engine.initChunk(v);
      }
    }
    if (k % o.checkEvery === 0 || k === o.edits) {
      drain(engine);
      expectConsistent(world, `seed ${o.seed} after ${k} edits`);
    }
  }
  expect(partialEdits).toBeGreaterThan(o.edits / 10);
}

describe('randomized edits with partial cells vs the reference of section 7.4', () => {
  it('2x2 chunks around the origin, every chunk with partial cells, interleaved budgets', () => {
    shapedFuzz({ seed: 101, coords: grid(-1, 0, -1, 0), layered: () => true, edits: 500, checkEvery: 50, maxBudget: 60 });
  });

  it('3x1 chunks, tiny budgets', () => {
    shapedFuzz({ seed: 102, coords: grid(0, 2, 0, 0), layered: () => true, edits: 400, checkEvery: 50, maxBudget: 8 });
  });

  it('borders with a holes layer on one side only (checkerboard of chunks), large budgets', () => {
    shapedFuzz({ seed: 103, coords: grid(0, 2, 0, 1), layered: (cx, cz) => ((cx + cz) & 1) === 0, edits: 600, checkEvery: 75, maxBudget: 2000 });
  });

  it('borders with a holes layer on one side only, tiny budgets, several seeds', () => {
    for (const seed of [104, 105, 106]) {
      shapedFuzz({ seed, coords: grid(-1, 0, 0, 1), layered: (cx) => cx === 0, edits: 250, checkEvery: 125, maxBudget: 12 });
    }
  });

  it('chunks streaming in and out (with their layers) and re-initialised while edits are pending', () => {
    shapedFuzz({ seed: 107, coords: grid(0, 2, 0, 2), layered: (cx, cz) => cx !== 1 || cz !== 1, edits: 500, checkEvery: 50, maxBudget: 150, streaming: true });
  });

  it('a sealed cave across a border with a holes layer on one side only: block light and its removal, no sky', () => {
    // Sky light hides much of the block-light bookkeeping (most cells are lit from above), so
    // here two chunks of solid stone hold a small sealed cave x 10..21, y 20..24, z 5..10 across
    // the border x = 15 | 16. Partial cells go only into chunk 0 (x < 16); chunk 1 keeps full
    // blocks only (no holes layer), and the edits there are lamps, air and stone, so removal
    // waves from chunk 1 keep running up to partial cells of chunk 0. Border cells of chunk 0
    // are often slabs whose opaque part covers the shared face by itself: light on their west
    // side must never pass that face, whichever way a cell of chunk 1 is lit, reset or refilled.
    const CAVE_FULL = [AIR, AIR, AIR, LAMP, LAMP, STONE, STONE, GLASS, TORCH];
    const EAST_CLOSED = [0xaa, 0xaa | 0x01, 0xaa | 0x44, 0xbb, 0xee, 0xfe];
    for (const seed of [111, 112, 113, 114, 115, 116, 117, 118]) {
      const { world, engine } = lightWorld();
      for (const cx of [0, 1]) {
        const c = makeFlatChunk(cx, 0, 40);
        for (let y = 20; y <= 24; y++) for (let z = 5; z <= 10; z++) for (let x = 10; x <= 21; x++) if (x >> 4 === cx) c.cells[cellIndex(x & 15, y, z)] = 0;
        addLit(world, engine, c);
      }
      const rng = new Rng(seed);
      for (let k = 1; k <= 300; k++) {
        const r0 = rng.next();
        const x = r0 < 0.5 ? rng.int(15, 16) : r0 < 0.8 ? rng.int(13, 18) : rng.int(10, 21);
        const y = rng.int(20, 24);
        const z = rng.int(5, 10);
        let cell: number;
        if (x === 15 && rng.chance(0.4)) {
          cell = slab(rng.chance(0.8) ? B.STONE : B.LAMP, EAST_CLOSED[rng.int(0, EAST_CLOSED.length - 1)]!);
        } else if (x < 16 && rng.chance(0.5)) {
          cell = randomPartial(rng);
        } else {
          cell = CAVE_FULL[rng.int(0, CAVE_FULL.length - 1)]!;
        }
        world.setCell(x, y, z, cell);
        const r = rng.next();
        if (r < 0.3) engine.update(rng.int(0, 40));
        else if (r < 0.45) engine.update();
        if (k % 25 === 0) {
          drain(engine);
          expect(world.getChunk(1, 0)!.holes).toBe(null);
          expectConsistent(world, `cave seed ${seed} after ${k} edits`);
        }
      }
    }
  });

  it('result does not depend on how update(budget) calls interleave with the edits', () => {
    const rng0 = new Rng(108);
    const edits: Array<[number, number, number, number]> = [];
    for (let k = 0; k < 250; k++) {
      const x = rng0.int(0, 31);
      const z = rng0.int(0, 15);
      const y = rng0.int(30, 70);
      edits.push([x, y, z, rng0.chance(0.6) ? randomPartial(rng0) : FULL_EDITS[rng0.int(0, FULL_EDITS.length - 1)]!]);
    }
    const run = (schedule: (engine: LightEngine) => void): Map<number, Uint8Array> => {
      const { world, engine } = lightWorld();
      for (const [cx, cz] of grid(0, 1, 0, 0)) addLit(world, engine, makeShapedTerrainChunk(cx, cz, 1, 0.06));
      for (const [x, y, z, cell] of edits) {
        world.setCell(x, y, z, cell);
        schedule(engine);
      }
      drain(engine);
      return lightSnapshot(world);
    };
    const eager = run((e) => e.update());
    const lazy = run(() => {});
    const r = new Rng(3);
    const budgeted = run((e) => e.update(r.int(0, 30)));
    for (const [key, bytes] of eager) {
      expect(Buffer.from(lazy.get(key)!).equals(Buffer.from(bytes))).toBe(true);
      expect(Buffer.from(budgeted.get(key)!).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('a shaped terrain world matches the reference and is independent of the order chunks are added in', () => {
    const coords = grid(-1, 1, -1, 1);
    let first: Map<number, Uint8Array> | null = null;
    for (const order of [coords, coords.slice().reverse()]) {
      const { world, engine } = lightWorld();
      for (const [cx, cz] of order) addLit(world, engine, makeShapedTerrainChunk(cx, cz, 2, 0.1));
      drain(engine);
      if (!first) {
        expectConsistent(world, 'shaped terrain');
        first = lightSnapshot(world);
      } else {
        const snap = lightSnapshot(world);
        for (const [k, bytes] of first) expect(Buffer.from(snap.get(k)!).equals(Buffer.from(bytes)), `chunk ${k}`).toBe(true);
      }
    }
  });
});

/** Shapes whose non-opaque octants are connected inside the cell (section 7.4). */
const CONNECTED: number[] = [0xff, 0x33, 0xcc, 0x55, 0xaa, 0x0f, 0xf0, stairFill(PX), stairFill(NX), stairFill(PZ), stairFill(NZ)];
for (let o = 0; o < 8; o++) CONNECTED.push(0xff & ~(1 << o));
for (let o = 0; o < 8; o++) {
  for (let a = 0; a < 3; a++) {
    const p = o ^ (1 << a);
    if (p > o) CONNECTED.push(0xff & ~(1 << o) & ~(1 << p));
  }
}

describe('the half-cell flood check of section 7.4 (independent of section 7.1)', () => {
  it('no sky light where the flood from the open sky cannot reach, in random rubble of slabs, stairs and chipped cubes', () => {
    const rng = new Rng(109);
    let darkCells = 0;
    for (let scene = 0; scene < 12; scene++) {
      const { world, engine } = lightWorld();
      const chunks = grid(0, 1, 0, 0).map(([cx, cz]) => makeFlatChunk(cx, cz, 10));
      for (const c of chunks) world.addChunk(c);
      const density = 0.6 + 0.35 * rng.next();
      for (let y = 11; y < 30; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 32; x++) {
            if (!rng.chance(density)) continue;
            const fill = CONNECTED[rng.int(0, CONNECTED.length - 1)]!;
            const material = rng.chance(0.1) ? B.GLASS : rng.chance(0.5) ? B.STONE : B.PLANKS_OAK;
            world.setCell(x, y, z, slab(material, fill));
          }
        }
      }
      if (scene % 2 === 0) {
        for (const c of chunks) engine.initChunk(c);
      } else {
        // Same kind of scene, built incrementally on lit chunks.
        for (const c of chunks) engine.initChunk(c);
        for (let k = 0; k < 300; k++) {
          const fill = CONNECTED[rng.int(0, CONNECTED.length - 1)]!;
          world.setCell(rng.int(0, 31), rng.int(11, 29), rng.int(0, 15), rng.chance(0.2) ? AIR : slab(B.STONE, fill));
          if (rng.chance(0.3)) engine.update(rng.int(0, 50));
        }
      }
      drain(engine);
      const leaks = skyLeaks(world);
      expect(leaks.length, `scene ${scene}: ${leaks.slice(0, 5).join(', ')}`).toBe(0);
      expectConsistent(world, `rubble scene ${scene}`);
      // Cells with room for light (some octant not opaque) that stay dark.
      for (const c of chunks) {
        for (let i = cellIndex(0, 11, 0); i < cellIndex(0, 30, 0); i++) if (c.light[i]! >> 4 === 0 && opaqueFill(chunkCell(c, i)) !== 0xff) darkCells++;
      }
    }
    // The scenes do contain closed-off space (the check is not vacuous).
    expect(darkCells).toBeGreaterThan(200);
  });
});
