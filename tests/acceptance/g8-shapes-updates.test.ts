/**
 * Acceptance scenarios 45 (the sand and lost-support parts) and 46 (docs/ACCEPTANCE.md "形状与凿子";
 * docs/SHAPES.md 9.1-9.3, 16.4), headless, whole simulation, in both modes:
 *  - 46: water flows around partial cells and into none (also under an upper slab a layer up, and a
 *    cell up over a slab sunk into the floor); when a cell's last part goes, water flows in; a bucket
 *    refuses to pour into a cell with parts.
 *  - 45: sand falling onto a lower slab, an upper slab or a single octant never sinks into it and
 *    rests as a block in the cell above; a torch stays on a covered top face and falls off when the
 *    top face is no longer covered.
 *
 * Scenes are written on the server (w.sim): the tools that make partial blocks come in M2.4. The
 * player's actions are mining full blocks (a dam that holds back water, the dirt that holds up
 * sand) and the bucket. Placing torches on slabs by hand, and the drop of a torch whose support is
 * chiselled away, are in g8-shapes-parts.test.ts; here torches are written directly and the block
 * updates decide whether they stay.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
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
  /** An upper slab a layer up over the flow's way: the water runs on under it. */
  const ROOF_SLAB: [number, number, number, number] = [3, GROUND + 1, -3, slab(B.STONE, UPPER)];

  function scene(sim: Simulation): void {
    const w = sim.world;
    for (const [x, z] of [[0, -3], [1, -4], [1, -2], [0, -4], [0, -2]] as const) w.setCell(x, GROUND, z, makeCell(B.STONE));
    w.setCell(2, GROUND, -3, makeCell(B.STONE)); // the dam
    w.setCell(1, GROUND, -3, makeCell(B.WATER));
    for (const [x, z, c] of PARTS) w.setCell(x, GROUND, z, c);
    w.setCell(FLOOR_SLAB[0], FLOOR_SLAB[1], FLOOR_SLAB[2], FLOOR_SLAB[3]);
    w.setCell(ROOF_SLAB[0], ROOF_SLAB[1], ROOF_SLAB[2], ROOF_SLAB[3]);
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
    // Under the upper slab a layer up the water runs on; the slab's empty lower half stays dry.
    expect(getPacked(sim.world, ROOF_SLAB[0], ROOF_SLAB[1], ROOF_SLAB[2])).toBe(ROOF_SLAB[3]);
    expect(isWater(sim, ROOF_SLAB[0], GROUND, ROOF_SLAB[2])).toBe(true);
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

describe('46. 往有部件的格子里倒水倒不进去。', () => {
  it('a bucket of water refuses to pour into a cell with parts: the player clicks the floor under an upper slab (the cell across that face is the slab\'s), nothing changes; beside it the bucket pours', () => {
    const w = newWorld(shapesSpec(346));
    const { sim, me } = w;
    sim.world.setCell(0, GROUND, -2, slab(B.STONE, UPPER));
    w.tick(2);
    me.hold(I.BUCKET_WATER);
    // The ray from the eyes passes through the slab's empty lower half to the turf's top face.
    expect(me.aimAt(0, GROUND - 1, -2, PY)).toBe(true);
    me.use();
    w.tick(10);
    expect(getPacked(sim.world, 0, GROUND, -2)).toBe(slab(B.STONE, UPPER));
    for (let x = -2; x <= 2; x++) for (let z = -4; z <= 0; z++) expect(isWater(sim, x, GROUND, z), `no water at ${x},${z}`).toBe(false);
    // The turf beside it: the bucket pours into the empty cell above.
    expect(me.aimAt(1, GROUND - 1, -2, PY)).toBe(true);
    me.use();
    w.tick();
    expect(isWater(sim, 1, GROUND, -2)).toBe(true);
    // The water spreads around the slab's cell but never into it.
    w.tick(60);
    expect(isWater(sim, 1, GROUND, -3)).toBe(true);
    expect(getPacked(sim.world, 0, GROUND, -2)).toBe(slab(B.STONE, UPPER));
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
    // While they fall, the falling blocks never sink into a support: the lowest feet over each
    // support column (supports at x 0, 1, 2) is at least the top of the half slab (P3, 5.9).
    const lowest = [Infinity, Infinity, Infinity];
    const watch = (): void => {
      for (const e of sim.entities.all()) {
        if (e.kind !== 'falling' || e.removed) continue;
        const i = Math.floor(e.pos.x);
        if (i >= 0 && i < lowest.length) lowest[i] = Math.min(lowest[i]!, e.pos.y);
      }
    };
    for (let i = 0; i < supports.length; i++) {
      expect(me.mine(i, GROUND + 3, 2, NZ)).toBe(true);
      watch();
    }
    for (let t = 0; t < 60; t++) {
      w.tick();
      watch();
    }
    expect(lowest[0], 'over the lower slab').toBeGreaterThanOrEqual(GROUND + 0.5);
    expect(lowest[1], 'over the upper slab').toBeGreaterThanOrEqual(GROUND + 1);
    expect(lowest[2], 'over the single octant').toBeGreaterThanOrEqual(GROUND + 0.5);
    expect(lowest.every((y) => y < GROUND + 3), '(premise) every sand block was seen falling').toBe(true);
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
