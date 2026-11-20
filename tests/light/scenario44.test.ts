/**
 * Scenario 44 (docs/ACCEPTANCE.md, docs/SHAPES.md 7.1 and 16.2 P5): under a roof of half slabs it
 * is dark. Light is computed on the client only (the server's acceptance world has none), so the
 * scenario runs here on a World with a LightEngine, as the client's replica does. The versions that
 * read the client's replica (the player mines a gap; a guest on a lossy link) are
 * tests/acceptance/g8-shapes-light.test.ts and tests/net/e2e-shapes-join.test.ts.
 *
 * A stone room straddles the chunk border x = 16: walls from the floor (y = 11) up to the roof
 * layer, interior x 13..19, z 5..11. Every roof is built three ways: incrementally with setCell
 * after the chunks are lit, with budgeted update() calls interleaved, and in the chunks' cells
 * before they are lit (initChunk). Each time the light must equal the reference of section 7.4
 * and no sky light may sit where the half-cell flood fill from the open sky cannot reach.
 *
 * Dark (sky light 0 in the whole room): lower slabs; upper slabs with the walls built up to the
 * roof layer; rows of lower and upper slabs alternating (both orientations); a checkerboard of
 * lower and upper slabs; a layer of west slabs over a layer of east slabs. Light gets in: one slab
 * removed; one slab replaced by an upright (west) slab, which lines up with the air above and
 * below; upper slabs resting on top of walls that stop one layer below the roof (a half-cell gap
 * runs round under the roof, the roof cells at the edge hold 14), which asserts the rule itself.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { Rng } from '../../src/core/rng';
import type { LightEngine } from '../../src/light/engine';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, slab, UPPER, WEST } from '../shapes';
import { addLit, AIR, drain, expectConsistent, lightWorld, skyLeaks, STONE } from './shape-helpers';
import { makeFlatChunk } from './terrain';

const FLOOR = 11; // first air layer above the flat ground (stone up to y = 10)
const X0 = 12;
const X1 = 20;
const Z0 = 4;
const Z1 = 12;
const ROOF = 16;

type Cell = [number, number, number, number];

/** Walls of the room from the floor up to `wallTop` (inclusive), as cells. */
function walls(wallTop: number): Cell[] {
  const out: Cell[] = [];
  for (let y = FLOOR; y <= wallTop; y++) {
    for (let x = X0; x <= X1; x++) {
      for (let z = Z0; z <= Z1; z++) if (x === X0 || x === X1 || z === Z0 || z === Z1) out.push([x, y, z, STONE]);
    }
  }
  return out;
}

/** One roof layer over the interior (or over the whole room when `overWalls`), fill per column. */
function roofLayer(y: number, fill: (x: number, z: number) => number, overWalls = false): Cell[] {
  const out: Cell[] = [];
  const m = overWalls ? 0 : 1;
  for (let x = X0 + m; x <= X1 - m; x++) for (let z = Z0 + m; z <= Z1 - m; z++) out.push([x, y, z, slab(B.STONE, fill(x, z))]);
  return out;
}

/** Highest sky light in the interior below `top` (inclusive). */
function roomSky(world: World, top: number): number {
  let m = 0;
  for (let y = FLOOR; y <= top; y++) for (let x = X0 + 1; x < X1; x++) for (let z = Z0 + 1; z < Z1; z++) m = Math.max(m, world.getSkyLight(x, y, z));
  return m;
}

const CHUNKS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [0, -1],
  [1, -1],
];

type Mode = 'incremental' | 'budgeted' | 'initChunk';

/** Build the scene in a world of flat chunks, the given way; returns the world and engine, drained. */
function build(cells: Cell[], mode: Mode): { world: World; engine: LightEngine } {
  const { world, engine } = lightWorld();
  if (mode === 'initChunk') {
    // The cells are in the chunks before the engine lights them.
    const chunks = CHUNKS.map(([cx, cz]) => makeFlatChunk(cx, cz, FLOOR - 1));
    for (const c of chunks) world.addChunk(c);
    for (const [x, y, z, cell] of cells) world.setCell(x, y, z, cell);
    for (const c of chunks) engine.initChunk(c);
    drain(engine);
    return { world, engine };
  }
  for (const [cx, cz] of CHUNKS) addLit(world, engine, makeFlatChunk(cx, cz, FLOOR - 1));
  const rng = new Rng(44);
  for (const [x, y, z, cell] of cells) {
    world.setCell(x, y, z, cell);
    if (mode === 'budgeted') engine.update(rng.int(0, 40));
  }
  drain(engine);
  return { world, engine };
}

function check(world: World, label: string): void {
  expectConsistent(world, label);
  const leaks = skyLeaks(world);
  expect(leaks.length, `${label}: sky light the half-cell flood cannot reach: ${leaks.slice(0, 4).join(', ')}`).toBe(0);
}

const MODES: Mode[] = ['incremental', 'budgeted', 'initChunk'];

describe('scenario 44: under a roof of half slabs it is dark', () => {
  const dark: Array<[string, () => Cell[], number]> = [
    ['lower slabs', () => [...walls(ROOF), ...roofLayer(ROOF, () => LOWER)], ROOF - 1],
    ['upper slabs, walls built up to the roof layer', () => [...walls(ROOF), ...roofLayer(ROOF, () => UPPER)], ROOF - 1],
    ['rows of lower and upper slabs alternating along z', () => [...walls(ROOF), ...roofLayer(ROOF, (_x, z) => (z & 1 ? LOWER : UPPER))], ROOF - 1],
    ['rows of lower and upper slabs alternating along x', () => [...walls(ROOF), ...roofLayer(ROOF, (x) => (x & 1 ? LOWER : UPPER))], ROOF - 1],
    ['a checkerboard of lower and upper slabs', () => [...walls(ROOF), ...roofLayer(ROOF, (x, z) => ((x + z) & 1 ? LOWER : UPPER))], ROOF - 1],
    [
      'a layer of west slabs over a layer of east slabs',
      () => [...walls(ROOF), ...roofLayer(ROOF, () => WEST), ...roofLayer(ROOF - 1, () => EAST)],
      ROOF - 2,
    ],
  ];
  for (const [name, scene, top] of dark) {
    for (const mode of MODES) {
      it(`dark: ${name} (${mode})`, () => {
        const { world } = build(scene(), mode);
        check(world, `${name} ${mode}`);
        expect(roomSky(world, top), 'sky light in the room').toBe(0);
        // Outside the room the open sky is untouched.
        expect(world.getSkyLight(X0 - 2, FLOOR, Z0 + 3)).toBe(15);
      });
    }
  }

  it('dark roofs stay dark when a slab is taken out and put back (incremental, partial cells on both sides)', () => {
    for (const [name, scene, top] of dark) {
      const { world, engine } = build(scene(), 'incremental');
      const hole: [number, number, number] = [16, ROOF, 8];
      const roofCell = world.getCell(...hole);
      world.setCell(...hole, AIR);
      drain(engine);
      check(world, `${name} with a hole`);
      if (top === ROOF - 1) {
        expect(world.getSkyLight(16, ROOF - 1, 8), `${name}: straight down through the hole`).toBe(15);
        expect(roomSky(world, top)).toBe(15);
      } else {
        // West over east: the hole opens the upper layer; the east slab below covers only
        // half of its top face, so the sky falls through it into the room.
        expect(world.getSkyLight(16, ROOF - 2, 8)).toBe(15);
      }
      world.setCell(...hole, roofCell);
      drain(engine);
      check(world, `${name} hole closed`);
      expect(roomSky(world, top), `${name}: dark again`).toBe(0);
    }
  });

  describe('light gets in', () => {
    for (const mode of MODES) {
      it(`one slab of a lower-slab roof removed (${mode})`, () => {
        const cells = [...walls(ROOF), ...roofLayer(ROOF, () => LOWER)];
        cells.push([16, ROOF, 8, AIR]);
        const { world } = build(cells, mode);
        check(world, `removed ${mode}`);
        expect(world.getSkyLight(16, FLOOR, 8)).toBe(15);
        expect(world.getSkyLight(14, FLOOR, 6)).toBe(15 - 4);
      });

      it(`one slab replaced by an upright west slab that lines up with the air above and below (${mode})`, () => {
        const cells = [...walls(ROOF), ...roofLayer(ROOF, () => LOWER)];
        cells.push([16, ROOF, 8, slab(B.STONE, WEST)]);
        const { world } = build(cells, mode);
        check(world, `upright ${mode}`);
        // The upright slab's top and bottom faces are half open: the sky falls straight through.
        expect(world.getSkyLight(16, ROOF, 8)).toBe(15);
        expect(world.getSkyLight(16, FLOOR, 8)).toBe(15);
        expect(roomSky(world, ROOF - 1)).toBe(15);
      });

      it(`upper slabs resting on top of walls that stop below the roof layer (${mode})`, () => {
        const cells = [...walls(ROOF - 1), ...roofLayer(ROOF, () => UPPER, true)];
        const { world } = build(cells, mode);
        check(world, `resting ${mode}`);
        // The roof cells at the edge have their lower half open to the outside air: 15 - 1.
        expect(world.getSkyLight(X0, ROOF, 8)).toBe(14);
        expect(world.getSkyLight(X1, ROOF, 6)).toBe(14);
        expect(world.getSkyLight(14, ROOF, Z0)).toBe(14);
        // The half-cell gap under the roof lets light into the room.
        expect(roomSky(world, ROOF - 1)).toBeGreaterThan(0);
        expect(world.getSkyLight(X0 + 1, ROOF, 8)).toBe(13);
      });
    }

    it('aligned upright slabs (west over west) pass light, offset ones (west over east) do not', () => {
      const aligned = build([...walls(ROOF), ...roofLayer(ROOF, () => WEST), ...roofLayer(ROOF - 1, () => WEST)], 'incremental').world;
      check(aligned, 'aligned');
      expect(roomSky(aligned, ROOF - 2)).toBe(15);
      const offset = build([...walls(ROOF), ...roofLayer(ROOF, () => WEST), ...roofLayer(ROOF - 1, () => EAST)], 'incremental').world;
      check(offset, 'offset');
      expect(roomSky(offset, ROOF - 2)).toBe(0);
    });
  });
});
