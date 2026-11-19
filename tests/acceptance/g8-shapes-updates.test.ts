/**
 * Acceptance scenarios 45 (the sand and lost-support parts) and 46 (docs/ACCEPTANCE.md "形状与凿子";
 * docs/SHAPES.md 9.1-9.3, 16.4), headless, whole simulation, in both modes.
 *
 * Scenes are written on the server (w.sim): the tools that make partial blocks come in M2.4. The
 * player's actions are mining full blocks: a dam that holds back water, the dirt that holds up sand.
 * Placing torches on slabs (refused on a lower slab, accepted on an upper one) is the placement part
 * of scenario 45 and belongs to package P8b (g8-shapes-parts.test.ts); here torches are written
 * directly and the block updates decide whether they stay. Only what package P6 is responsible for
 * is asserted (16.4): for the sand, the cell where it finally rests.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { LIQUID } from '../../src/blocks/registry';
import { canonCell } from '../../src/blocks/shapes';
import { NZ, PX, PY } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { getPacked } from '../../src/voxel/parts';
import { EAST, LOWER, UPPER, WEST, slab, stairFill } from '../shapes';
import { newWorld } from './g6-save-helpers';
import { GROUND, shapesSpec } from './g8-shapes-helpers';

const idAt = (sim: Simulation, x: number, y: number, z: number): number => sim.world.getCell(x, y, z) & ID_MASK;
const isWater = (sim: Simulation, x: number, y: number, z: number): boolean => idAt(sim, x, y, z) === B.WATER;

describe('46. 水不流进有部件的格子。', () => {
  /**
   * A water source at (1, GROUND, -3) walled in, a stone dam east of it at (2, GROUND, -3); beyond
   * the dam, on the turf, partial cells of every kind in the flow's way, and a lower slab sunk
   * into the turf floor at (4, GROUND - 1, -2).
   */
  const PARTS: ReadonlyArray<[number, number, number]> = [
    [4, -3, slab(B.STONE, LOWER)],
    [3, -4, slab(B.GLASS, UPPER)],
    [3, -2, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER))],
    [5, -4, slab(B.BRICKS, stairFill(PX))],
    [5, -2, slab(B.IRON_BLOCK, 0x01)],
    [6, -3, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST))],
  ];
  const FLOOR_SLAB: [number, number, number, number] = [4, GROUND - 1, -1, slab(B.STONE, LOWER)];

  function scene(sim: Simulation): void {
    const w = sim.world;
    for (const [x, z] of [[0, -3], [1, -4], [1, -2], [0, -4], [0, -2]] as const) w.setCell(x, GROUND, z, makeCell(B.STONE));
    w.setCell(2, GROUND, -3, makeCell(B.STONE)); // the dam
    w.setCell(1, GROUND, -3, makeCell(B.WATER));
    for (const [x, z, c] of PARTS) w.setCell(x, GROUND, z, c);
    w.setCell(FLOOR_SLAB[0], FLOOR_SLAB[1], FLOOR_SLAB[2], FLOOR_SLAB[3]);
  }

  it('the player breaks the dam: the water flows around every partial cell and into none; over a slab in the floor it stays a cell up', () => {
    const w = newWorld(shapesSpec(46));
    const { sim, me } = w;
    scene(sim);
    w.tick(20);
    expect(isWater(sim, 3, GROUND, -3), '(premise) the dam holds').toBe(false);
    expect(me.mine(2, GROUND, -3, PY)).toBe(true); // creative: breaks at once
    w.tick(200);
    for (const [x, z, c] of PARTS) {
      expect(getPacked(sim.world, x, GROUND, z), `the cell ${x},${z} keeps its parts`).toBe(c);
      expect(LIQUID[idAt(sim, x, GROUND, z)]).toBe(0);
    }
    expect(getPacked(sim.world, FLOOR_SLAB[0], FLOOR_SLAB[1], FLOOR_SLAB[2])).toBe(FLOOR_SLAB[3]);
    // The water did get out and around them, and over the sunk slab it lies one cell up.
    for (const [x, z] of [[2, -3], [3, -3], [2, -4], [4, -2], [4, -4]] as const) expect(isWater(sim, x, GROUND, z), `water at ${x},${z}`).toBe(true);
    expect(isWater(sim, FLOOR_SLAB[0], GROUND, FLOOR_SLAB[2])).toBe(true);
    // (5, -3) has partial cells on all four sides: they hold the water out like full blocks.
    expect(isWater(sim, 5, GROUND, -3)).toBe(false);
  });

  it('when the last part of a cell is gone, the water flows in', () => {
    const w = newWorld(shapesSpec(146));
    const { sim, me } = w;
    scene(sim);
    w.tick(20);
    expect(me.mine(2, GROUND, -3, PY)).toBe(true);
    w.tick(120);
    const [x, z] = [PARTS[0]![0], PARTS[0]![1]];
    expect(isWater(sim, x, GROUND, z)).toBe(false);
    sim.world.setCell(x, GROUND, z, 0); // its only part goes
    w.tick(40);
    expect(isWater(sim, x, GROUND, z)).toBe(true);
  });
});

describe('45. 沙子落到半砖上停住；火把失去完整的顶面就掉落。', () => {
  it('sand held up by dirt falls when the player mines the dirt, and rests in the cell above a lower slab, an upper slab and a single octant', () => {
    const w = newWorld(shapesSpec(45));
    const { sim, me } = w;
    const supports = [slab(B.STONE, LOWER), slab(B.STONE, UPPER), slab(B.IRON_BLOCK, 0x01)];
    supports.forEach((c, i) => {
      sim.world.setCell(i, GROUND, 2, c);
      sim.world.setCell(i, GROUND + 3, 2, makeCell(B.DIRT));
      sim.world.setCell(i, GROUND + 4, 2, makeCell(B.SAND));
    });
    w.tick(10);
    supports.forEach((_c, i) => expect(idAt(sim, i, GROUND + 4, 2), '(premise) the sand is held up').toBe(B.SAND));
    for (let i = 0; i < supports.length; i++) expect(me.mine(i, GROUND + 3, 2, NZ)).toBe(true);
    w.tick(60);
    supports.forEach((_c, i) => {
      expect(idAt(sim, i, GROUND + 1, 2), `sand rests above support ${i}`).toBe(B.SAND);
      expect(idAt(sim, i, GROUND + 2, 2)).toBe(B.AIR);
    });
    expect(sim.entities.all().filter((e) => e.kind === 'falling' && !e.removed)).toHaveLength(0);
  });

  it('a torch stands on an upper slab and on two halves that cover the top face; it falls off when the top face is no longer covered', () => {
    const w = newWorld(shapesSpec(245));
    const { sim } = w;
    const wd = sim.world;
    wd.setCell(-3, GROUND, 2, slab(B.PLANKS_OAK, UPPER));
    wd.setCell(-5, GROUND, 2, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
    wd.setCell(-7, GROUND, 2, slab(B.PLANKS_OAK, LOWER));
    w.tick(2);
    for (const x of [-3, -5, -7]) wd.setCell(x, GROUND + 1, 2, makeCell(B.TORCH));
    w.tick(5);
    expect(idAt(sim, -3, GROUND + 1, 2)).toBe(B.TORCH);
    expect(idAt(sim, -5, GROUND + 1, 2)).toBe(B.TORCH);
    expect(idAt(sim, -7, GROUND + 1, 2), 'nothing holds a torch on a lower slab').toBe(B.AIR);
    // An octant of the upper slab's top goes; so does the east half under the other torch.
    wd.setCell(-3, GROUND, 2, slab(B.PLANKS_OAK, 0x4c)); // upper slab without octant 7
    wd.setCell(-5, GROUND, 2, slab(B.PLANKS_OAK, WEST));
    w.tick(5);
    expect(idAt(sim, -3, GROUND + 1, 2)).toBe(B.AIR);
    expect(idAt(sim, -5, GROUND + 1, 2)).toBe(B.AIR);
    expect(getPacked(wd, -3, GROUND, 2)).toBe(slab(B.PLANKS_OAK, 0x4c));
  });
});
