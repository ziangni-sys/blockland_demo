/**
 * Worlds of full blocks light exactly as in M1 (docs/SHAPES.md section 7.3): every light byte and
 * every heightmap byte.
 *
 * The expected hashes were produced by the M1 light engine (commit c20ea8e) running these very
 * scenes: this file was copied into that checkout and run with P5_PRINT_M1_HASHES=1, which prints
 * the hashes instead of checking them. The scenes use only APIs that exist unchanged in both
 * versions (World.setCell with full-block values, Chunk.cells, LightEngine), so they mean the same
 * thing on both sides. Unlike the comparisons against tests/light/reference.ts, this check does not
 * depend on any reading of the specification: it pins the bytes themselves.
 *
 * The second part checks that the reference of section 7.4 (reference.ts, written from the face
 * model) and the M1 rule (reference-m1.ts) give the same values on these worlds. (It was added
 * after the hashes were taken: those two files do not exist in the M1 checkout.)
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { Rng } from '../../src/core/rng';
import { LightEngine } from '../../src/light/engine';
import { cellIndex, Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { computeReference } from './reference';
import { computeReferenceM1 } from './reference-m1';
import { makeFlatChunk, makeTerrainChunk } from './terrain';

const AIR = 0;
const STONE = makeCell(B.STONE);
const LEAVES = makeCell(B.LEAVES_OAK);
const WATER = makeCell(B.WATER);
const LAVA = makeCell(B.LAVA);
const ICE = makeCell(B.ICE);
const GLASS = makeCell(B.GLASS);
const LAMP = makeCell(B.LAMP);
const TORCH = makeCell(B.TORCH);
const PLANKS = makeCell(B.PLANKS_OAK);
const CELLS = [AIR, AIR, AIR, STONE, STONE, LEAVES, WATER, ICE, GLASS, LAMP, TORCH, LAVA, PLANKS];

/** FNV-1a over every lit chunk (in key order): coordinates, light bytes, heightmap bytes. */
function lightHash(world: World): string {
  const chunks = [...world.chunks.values()].filter((c) => c.lit).sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  let h = 0x811c9dc5;
  const byte = (b: number) => {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const c of chunks) {
    byte(c.cx);
    byte(c.cz);
    for (let i = 0; i < c.light.length; i++) byte(c.light[i]!);
    for (let i = 0; i < c.heightmap.length; i++) byte(c.heightmap[i]!);
  }
  return `${chunks.length}:${h.toString(16)}`;
}

function setup(): { world: World; engine: LightEngine } {
  const world = new World(1);
  const engine = new LightEngine(world);
  engine.attach();
  return { world, engine };
}

function addLit(world: World, engine: LightEngine, chunk: Chunk): void {
  world.addChunk(chunk);
  engine.initChunk(chunk);
}

/** A random full-block edit in [minX, maxX] x [minZ, maxZ]: single cells, slabs of cells, column tops. */
function edit(world: World, rng: Rng, minX: number, maxX: number, minZ: number, maxZ: number): void {
  const x = rng.int(minX, maxX);
  const z = rng.int(minZ, maxZ);
  const r = rng.next();
  const cell = CELLS[rng.int(0, CELLS.length - 1)]!;
  if (r < 0.2) {
    const c = world.chunkAt(x, z);
    if (!c) return;
    const h = c.heightmap[(x & 15) | ((z & 15) << 4)]!;
    world.setCell(x, Math.min(h + rng.int(-1, 3), WORLD_HEIGHT - 1), z, cell);
  } else if (r < 0.3) {
    const y = rng.int(20, 90);
    for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 3; dz++) world.setCell(x + dx, y, z + dz, cell);
  } else {
    world.setCell(x, rng.chance(0.1) ? rng.int(0, WORLD_HEIGHT - 1) : rng.int(20, 90), z, cell);
  }
}

function drain(engine: LightEngine): void {
  while (!engine.update()) {
    /* empty */
  }
}

const SCENES: Record<string, () => World> = {
  terrain3x3(): World {
    const { world, engine } = setup();
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      addLit(world, engine, makeTerrainChunk(cx, cz, 1));
    }
    return world;
  },
  editsWithBudgets(): World {
    const { world, engine } = setup();
    for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) addLit(world, engine, makeTerrainChunk(cx, cz, 2));
    const rng = new Rng(31);
    for (let k = 0; k < 700; k++) {
      edit(world, rng, -16, 15, -16, 15);
      if (rng.chance(0.4)) engine.update(rng.int(0, 120));
    }
    drain(engine);
    return world;
  },
  streamingAndUnloading(): World {
    const { world, engine } = setup();
    const rng = new Rng(32);
    const away: Chunk[] = [];
    for (let k = 0; k < 9; k++) addLit(world, engine, makeTerrainChunk(k % 3, Math.floor(k / 3), 3));
    for (let k = 0; k < 400; k++) {
      edit(world, rng, 0, 47, 0, 47);
      if (rng.chance(0.3)) engine.update(rng.int(0, 200));
      const r = rng.next();
      const present = [...world.chunks.values()];
      if (r < 0.04 && present.length > 5) {
        const c = present[rng.int(0, present.length - 1)]!;
        world.removeChunk(c.cx, c.cz);
        away.push(c);
      } else if (r < 0.08 && away.length > 0) {
        const c = away.splice(rng.int(0, away.length - 1), 1)[0]!;
        addLit(world, engine, new Chunk(c.cx, c.cz, c.cells.slice()));
      }
    }
    drain(engine);
    return world;
  },
  highRoof(): World {
    const { world, engine } = setup();
    for (let cz = -1; cz <= 2; cz++) for (let cx = -1; cx <= 2; cx++) addLit(world, engine, makeFlatChunk(cx, cz, 4));
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) world.setCell(x, 120, z, STONE);
    drain(engine);
    for (let k = 0; k < 6; k++) {
      world.setCell(16 + k, 120, 16, AIR);
      engine.update(3000);
      world.setCell(10, 60 + k, 10 + k, LAMP);
      engine.update(500);
    }
    world.setCell(17, 120, 16, STONE);
    drain(engine);
    return world;
  },
  caveLamps(): World {
    const { world, engine } = setup();
    for (let cx = 0; cx <= 1; cx++) {
      for (let cz = 0; cz <= 1; cz++) {
        const c = makeFlatChunk(cx, cz, 60);
        for (let y = 20; y < 26; y++) for (let lz = 2; lz < 14; lz++) for (let lx = 0; lx < 16; lx++) c.cells[cellIndex(lx, y, lz)] = AIR;
        addLit(world, engine, c);
      }
    }
    const rng = new Rng(33);
    for (let k = 0; k < 300; k++) {
      const x = rng.int(0, 31);
      const z = rng.int(0, 31);
      const y = rng.int(19, 27);
      world.setCell(x, y, z, [AIR, STONE, LAMP, TORCH, LAVA, GLASS, WATER][rng.int(0, 6)]!);
      if (rng.chance(0.5)) engine.update(rng.int(0, 60));
    }
    drain(engine);
    return world;
  },
};

/** Hashes printed by the M1 engine (c20ea8e) for the scenes above. */
const M1_HASHES: Record<string, string> = {
  terrain3x3: '9:e99d3b6f',
  editsWithBudgets: '4:4627b3b4',
  streamingAndUnloading: '7:159dcf04',
  highRoof: '16:8bb2ea29',
  caveLamps: '4:cd33fcdf',
};

describe('full-block worlds light exactly as in M1', () => {
  for (const [name, scene] of Object.entries(SCENES)) {
    it(name, () => {
      const got = lightHash(scene());
      if (process.env.P5_PRINT_M1_HASHES) {
        console.log(`[m1 hash] ${name}: '${got}'`);
        return;
      }
      expect(got).toBe(M1_HASHES[name]);
    });
  }
});

describe('the reference of section 7.4 and the M1 rule agree on full blocks', () => {
  for (const name of ['terrain3x3', 'editsWithBudgets', 'caveLamps']) {
    it(name, () => {
      const world = SCENES[name]!();
      const a = computeReference(world);
      const b = computeReferenceM1(world);
      expect(a.sx).toBe(b.sx);
      let differ = 0;
      for (let i = 0; i < a.sky.length; i++) if (a.sky[i] !== b.sky[i] || a.block[i] !== b.block[i]) differ++;
      expect(differ).toBe(0);
    });
  }
});
