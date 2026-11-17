/** Flowing-liquid rules on hand-built worlds (docs/DESIGN.md 液体). */
import { describe, expect, it } from 'vitest';
import { AIR, ID_MASK, cellState, isLiquidSource, liquidAmount, liquidFalling, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SET_NO_NEIGHBOR_UPDATE } from '../../src/voxel/grid';
import {
  CONTACT_TICK_DELAY,
  LAVA_TICK_DELAY,
  WATER_TICK_DELAY,
  pumpTicks,
} from '../../src/liquid/fluids';
import {
  FLOOR_Y,
  STONE,
  SURFACE,
  amountAt,
  buildWorld,
  diamond,
  isSourceAt,
  lava,
  liquidCells,
  countLiquid,
  pumpUntilQuiet,
  water,
  type CellFn,
  type FluidWorld,
} from './helpers';

const OBSIDIAN = makeCell(B.OBSIDIAN);
const RUBBLE = makeCell(B.COBBLE);

/** Settled single water source on the standard platform, source at (8, SURFACE, 8). */
function settledDiamond(): FluidWorld {
  const fw = buildWorld();
  fw.world.setCell(8, SURFACE, 8, water());
  pumpUntilQuiet(fw);
  return fw;
}

describe('water on a large flat platform', () => {
  it('one source ends as exactly the |dx|+|dz| <= 7 diamond (113 cells), then the queue is empty', () => {
    const fw = settledDiamond();
    const cells = liquidCells(fw.world);
    expect(cells.length).toBe(113);
    expect(fw.world.ticks.size).toBe(0);
    expect(fw.fluids.deferredCount).toBe(0);
    const shape = diamond(8, 8, 7);
    for (const c of cells) {
      expect(c.id).toBe(B.WATER);
      expect(c.y).toBe(SURFACE);
      expect(shape.has(`${c.x},${c.z}`)).toBe(true);
      const ring = Math.abs(c.x - 8) + Math.abs(c.z - 8);
      expect(liquidAmount(c.state)).toBe(8 - ring);
      expect(isLiquidSource(c.state)).toBe(ring === 0);
      expect(liquidFalling(c.state)).toBe(false);
    }
  });

  it('advances one ring every 5 ticks', () => {
    const fw = buildWorld();
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, water());
    for (let k = 1; k <= 7; k++) {
      pumpTicks(world, fluids, WATER_TICK_DELAY - 1);
      expect(amountAt(world, 8 + k, SURFACE, 8)).toBe(0);
      pumpTicks(world, fluids, 1);
      expect(world.time).toBe(WATER_TICK_DELAY * k);
      expect(amountAt(world, 8 + k, SURFACE, 8)).toBe(8 - k);
      expect(amountAt(world, 8, SURFACE, 8 - k)).toBe(8 - k);
    }
  });
});

describe('lava on a large flat platform', () => {
  it('spreads to the radius-3 diamond (25 cells), one ring every 30 ticks', () => {
    const fw = buildWorld();
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, lava());
    for (let k = 1; k <= 3; k++) {
      pumpTicks(world, fluids, LAVA_TICK_DELAY - 1);
      expect(amountAt(world, 8 - k, SURFACE, 8)).toBe(0);
      expect(countLiquid(world)).toBe(2 * k * (k - 1) + 1);
      pumpTicks(world, fluids, 1);
      expect(world.time).toBe(LAVA_TICK_DELAY * k);
      expect(amountAt(world, 8 - k, SURFACE, 8)).toBe(8 - 2 * k);
      expect(countLiquid(world)).toBe(2 * k * (k + 1) + 1);
    }
    pumpUntilQuiet(fw);
    const cells = liquidCells(world, B.LAVA);
    expect(cells.length).toBe(25);
    const shape = diamond(8, 8, 3);
    for (const c of cells) expect(shape.has(`${c.x},${c.z}`)).toBe(true);
    expect(world.ticks.size).toBe(0);
  });
});

describe('draining', () => {
  it('removing the water source drains every cell and the queue goes quiet', () => {
    const fw = settledDiamond();
    fw.world.setCell(8, SURFACE, 8, AIR);
    pumpUntilQuiet(fw);
    expect(countLiquid(fw.world)).toBe(0);
    expect(fw.world.ticks.size).toBe(0);
  });

  it('removing the lava source drains the lava too', () => {
    const fw = buildWorld();
    fw.world.setCell(8, SURFACE, 8, lava());
    pumpUntilQuiet(fw);
    expect(countLiquid(fw.world)).toBe(25);
    fw.world.setCell(8, SURFACE, 8, AIR);
    pumpUntilQuiet(fw);
    expect(countLiquid(fw.world)).toBe(0);
  });

  it('a waterfall drains from the top when its source is removed', () => {
    const fw = buildWorld();
    const { world } = fw;
    world.setCell(8, 30, 8, water());
    pumpUntilQuiet(fw);
    expect(amountAt(world, 8, SURFACE + 5, 8)).toBe(8);
    world.setCell(8, 30, 8, AIR);
    pumpUntilQuiet(fw);
    expect(countLiquid(world)).toBe(0);
  });
});

describe('slope search', () => {
  /** Platform with a hole 3 cells east of the source, and a cave floor at y = 4 below. */
  const holeWorld: CellFn = (x, y, z) => {
    if (y === 4) return STONE;
    if (y === FLOOR_Y) return x === 11 && z === 8 ? AIR : STONE;
    return AIR;
  };

  it('a hole 3 cells away attracts the flow; the far side stays dry; it falls and spreads at the bottom', () => {
    const fw = buildWorld(holeWorld);
    const { world } = fw;
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);

    // Up top only the straight path to the hole is wet.
    const top = liquidCells(world).filter((c) => c.y === SURFACE);
    expect(top.map((c) => `${c.x},${c.z}`)).toEqual(['8,8', '9,8', '10,8', '11,8']);
    expect(amountAt(world, 11, SURFACE, 8)).toBe(5);
    // The far side, wet in the open-platform run, stays dry.
    const open = settledDiamond().world;
    for (const [x, z] of [[7, 8], [5, 8], [8, 9], [8, 6], [12, 8]] as const) {
      expect(amountAt(open, x, SURFACE, z)).toBeGreaterThan(0);
      expect(amountAt(world, x, SURFACE, z)).toBe(0);
    }
    // A falling column through the hole down to the cave floor ...
    for (let y = 5; y <= FLOOR_Y; y++) {
      const c = world.getCell(11, y, 8);
      expect(c & ID_MASK).toBe(B.WATER);
      expect(liquidFalling(cellState(c))).toBe(true);
    }
    // ... with no side spread on the way down, and a full diamond at the bottom.
    for (let y = 6; y <= FLOOR_Y; y++) expect(liquidCells(world).filter((c) => c.y === y).length).toBe(1);
    const bottom = liquidCells(world).filter((c) => c.y === 5);
    expect(bottom.length).toBe(113);
    const shape = diamond(11, 8, 7);
    for (const c of bottom) expect(shape.has(`${c.x},${c.z}`)).toBe(true);
    expect(world.ticks.size).toBe(0);
  });

  it('spreads toward every direction that ties for the nearest hole', () => {
    const twoHoles: CellFn = (x, y, z) => {
      if (y === 4) return STONE;
      if (y === FLOOR_Y) return (x === 5 || x === 11) && z === 8 ? AIR : STONE;
      return AIR;
    };
    const fw = buildWorld(twoHoles);
    fw.world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    const top = liquidCells(fw.world).filter((c) => c.y === SURFACE);
    expect(top.map((c) => `${c.x},${c.z}`)).toEqual(['5,8', '6,8', '7,8', '8,8', '9,8', '10,8', '11,8']);
  });

  it('holes beyond the search distance are ignored', () => {
    // Hole 7 cells east: the first neighbour plus 4 search steps reaches x = 13, not 15.
    const far: CellFn = (x, y, z) => {
      if (y === 4) return STONE;
      if (y === FLOOR_Y) return x === 15 && z === 8 ? AIR : STONE;
      return AIR;
    };
    const fw = buildWorld(far);
    fw.world.setCell(8, SURFACE, 8, water());
    pumpTicks(fw.world, fw.fluids, WATER_TICK_DELAY);
    // The source does not see the hole: it spreads in all four directions.
    expect(liquidCells(fw.world).length).toBe(5);
  });

  it('lava looks only 2 steps beyond its first neighbour', () => {
    const holeAt =
      (hx: number): CellFn =>
      (x, y, z) => {
        if (y === 4) return STONE;
        if (y === FLOOR_Y) return x === hx && z === 8 ? AIR : STONE;
        return AIR;
      };
    // Hole 3 east (first neighbour + 2 steps): only the east neighbour receives lava.
    const near = buildWorld(holeAt(11));
    near.world.setCell(8, SURFACE, 8, lava());
    pumpTicks(near.world, near.fluids, LAVA_TICK_DELAY);
    expect(liquidCells(near.world).map((c) => `${c.x},${c.z}`)).toEqual(['8,8', '9,8']);
    // Hole 4 east: out of reach, lava spreads in all four directions.
    const far = buildWorld(holeAt(12));
    far.world.setCell(8, SURFACE, 8, lava());
    pumpTicks(far.world, far.fluids, LAVA_TICK_DELAY);
    expect(liquidCells(far.world).length).toBe(5);
  });

  it('a wall between the liquid and the hole forces the detour to be counted', () => {
    // Hole 2 east, but a wall right next to the source on the east: no path within reach
    // except around the wall (6 steps from the source), so the source spreads everywhere open.
    const walled: CellFn = (x, y, z) => {
      if (y === 4) return STONE;
      if (y === FLOOR_Y) return x === 10 && z === 8 ? AIR : STONE;
      if (y === SURFACE && x === 9 && z >= 4 && z <= 12) return STONE;
      return AIR;
    };
    const fw = buildWorld(walled);
    fw.world.setCell(8, SURFACE, 8, water());
    pumpTicks(fw.world, fw.fluids, WATER_TICK_DELAY);
    const top = liquidCells(fw.world).map((c) => `${c.x},${c.z}`);
    expect(top).toEqual(['8,7', '7,8', '8,8', '8,9']);
  });
});

describe('falling liquid', () => {
  it('liquid over a hole only falls; a falling column spreads 7 when it lands', () => {
    const fw = buildWorld();
    const { world, fluids } = fw;
    world.setCell(8, 20, 8, water());
    pumpTicks(world, fluids, WATER_TICK_DELAY);
    // First tick of a source over air: it only falls.
    expect(liquidCells(world).map((c) => c.y)).toEqual([19, 20]);
    // Next tick it cannot flow into its own column any more, so (being a source) it spreads
    // sideways; those cells stand over air and fall too: a plus of five columns lands.
    pumpUntilQuiet(fw);
    const plus = [
      [8, 8],
      [9, 8],
      [7, 8],
      [8, 9],
      [8, 7],
    ];
    for (const [x, z] of plus) {
      expect(liquidFalling(cellState(world.getCell(x!, SURFACE, z!)))).toBe(true);
      expect(liquidFalling(cellState(world.getCell(x!, SURFACE + 4, z!)))).toBe(true);
    }
    // Each landed column spreads as a full cell (7, 6, ...); overlapping fans take the max.
    let expected = 0;
    for (let z = -8; z <= 24; z++) {
      for (let x = -8; x <= 24; x++) {
        let d = Infinity;
        for (const [px, pz] of plus) d = Math.min(d, Math.abs(x - px!) + Math.abs(z - pz!));
        const want = d <= 7 ? 8 - d : 0;
        if (want > 0) expected++;
        expect(amountAt(world, x, SURFACE, z)).toBe(want);
      }
    }
    expect(liquidCells(world).filter((c) => c.y === SURFACE).length).toBe(expected);
  });

  it('a mid-air source becomes a plus of five waterfalls; a waterfall into a pool leaves no surface film', () => {
    // 9 x 9 pool of sources sunk into a stone layer at y = SURFACE.
    const pool: CellFn = (x, y, z) => {
      if (y === FLOOR_Y) return STONE;
      if (y === SURFACE) return x >= 4 && x <= 12 && z >= 4 && z <= 12 ? water() : STONE;
      return AIR;
    };
    const fw = buildWorld(pool);
    const { world } = fw;
    world.setCell(8, SURFACE + 3, 8, water());
    pumpUntilQuiet(fw);
    const above = liquidCells(world).filter((c) => c.y > SURFACE);
    // Columns at the centre and its four neighbours, three cells high, nothing else.
    expect(above.length).toBe(15);
    expect(liquidCells(world).filter((c) => c.y === SURFACE + 1).map((c) => `${c.x},${c.z}`)).toEqual([
      '8,7',
      '7,8',
      '8,8',
      '9,8',
      '8,9',
    ]);
    // The pool itself is untouched.
    expect(liquidCells(world).filter((c) => c.y === SURFACE && isLiquidSource(c.state)).length).toBe(81);
  });
});

describe('infinite water source', () => {
  it('two sources one cell apart over solid ground create a third', () => {
    const fw = buildWorld();
    const { world } = fw;
    world.setCell(8, SURFACE, 8, water());
    world.setCell(10, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(isSourceAt(world, 9, SURFACE, 8, B.WATER)).toBe(true);
    expect(liquidCells(world).filter((c) => isLiquidSource(c.state)).length).toBe(3);
  });

  it('works over a water source as ground too', () => {
    const fw = buildWorld((x, y) => (y === FLOOR_Y ? STONE : y === SURFACE && x === 9 ? water() : AIR));
    const { world } = fw;
    // Row x = 9 at SURFACE is a line of sources; the new sources stand on top of it.
    world.setCell(8, SURFACE + 1, 8, water());
    world.setCell(10, SURFACE + 1, 8, water());
    pumpUntilQuiet(fw);
    expect(isSourceAt(world, 9, SURFACE + 1, 8, B.WATER)).toBe(true);
  });

  it('does not form when the gap cell has air below', () => {
    const gapOverAir: CellFn = (x, y, z) => {
      if (y === 4) return STONE;
      if (y === FLOOR_Y) return x === 9 && z === 8 ? AIR : STONE;
      return AIR;
    };
    const fw = buildWorld(gapOverAir);
    fw.world.setCell(8, SURFACE, 8, water());
    fw.world.setCell(10, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(isSourceAt(fw.world, 9, SURFACE, 8, B.WATER)).toBe(false);
    expect(amountAt(fw.world, 9, SURFACE, 8)).toBe(7);
  });

  it('does not form between two sources floating over air', () => {
    const fw = buildWorld((_x, y) => (y === 4 ? STONE : AIR));
    fw.world.setCell(8, SURFACE, 8, water());
    fw.world.setCell(10, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(isSourceAt(fw.world, 9, SURFACE, 8, B.WATER)).toBe(false);
  });

  it('lava has no infinite source', () => {
    const fw = buildWorld();
    fw.world.setCell(8, SURFACE, 8, lava());
    fw.world.setCell(10, SURFACE, 8, lava());
    pumpUntilQuiet(fw);
    expect(isSourceAt(fw.world, 9, SURFACE, 8, B.LAVA)).toBe(false);
    expect(amountAt(fw.world, 9, SURFACE, 8)).toBe(6);
  });
});

describe('lava meets water', () => {
  /** Stone layer at SURFACE with single-cell pockets; open air above. */
  const pockets: CellFn = (x, y, z) => {
    if (y === FLOOR_Y) return STONE;
    if (y === SURFACE) return (x === 8 || x === 9) && z === 8 ? AIR : STONE;
    return AIR;
  };

  it('water placed beside a lava source turns it into obsidian; the water stays', () => {
    const fw = buildWorld(pockets);
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, lava());
    world.setCell(9, SURFACE, 8, water());
    pumpTicks(world, fluids, CONTACT_TICK_DELAY);
    expect(world.getCell(8, SURFACE, 8)).toBe(OBSIDIAN);
    expect(isSourceAt(world, 9, SURFACE, 8, B.WATER)).toBe(true);
    pumpUntilQuiet(fw);
    expect(countLiquid(world, B.LAVA)).toBe(0);
    expect(isSourceAt(world, 9, SURFACE, 8, B.WATER)).toBe(true);
  });

  it('a lava source placed beside water turns into obsidian', () => {
    const fw = buildWorld(pockets);
    const { world, fluids } = fw;
    world.setCell(9, SURFACE, 8, water());
    world.setCell(8, SURFACE, 8, lava());
    pumpTicks(world, fluids, CONTACT_TICK_DELAY);
    expect(world.getCell(8, SURFACE, 8)).toBe(OBSIDIAN);
    expect(isSourceAt(world, 9, SURFACE, 8, B.WATER)).toBe(true);
  });

  it('flowing lava beside water turns into rubble', () => {
    const fw = buildWorld(pockets);
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, lava(2));
    world.setCell(9, SURFACE, 8, water());
    pumpTicks(world, fluids, CONTACT_TICK_DELAY);
    expect(world.getCell(8, SURFACE, 8)).toBe(RUBBLE);
  });

  it('water above lava: a source becomes obsidian, flowing lava becomes rubble', () => {
    for (const [lavaCell, expected] of [
      [lava(), OBSIDIAN],
      [lava(2), RUBBLE],
    ] as const) {
      const fw = buildWorld(pockets);
      const { world, fluids } = fw;
      world.setCell(8, SURFACE, 8, lavaCell);
      world.setCell(8, SURFACE + 1, 8, water());
      pumpTicks(world, fluids, CONTACT_TICK_DELAY);
      expect(world.getCell(8, SURFACE, 8)).toBe(expected);
      expect(isSourceAt(world, 8, SURFACE + 1, 8, B.WATER)).toBe(true);
    }
  });

  it('lava above water: a lava source placed on water hardens to obsidian', () => {
    const fw = buildWorld(pockets);
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, water());
    world.setCell(8, SURFACE + 1, 8, lava());
    pumpTicks(world, fluids, CONTACT_TICK_DELAY);
    expect(world.getCell(8, SURFACE + 1, 8)).toBe(OBSIDIAN);
    expect(isSourceAt(world, 8, SURFACE, 8, B.WATER)).toBe(true);
  });

  it('lava pouring down onto water forms rubble where it lands; the water stays', () => {
    const fw = buildWorld(pockets);
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, water());
    world.setCell(8, SURFACE + 2, 8, lava());
    pumpTicks(world, fluids, LAVA_TICK_DELAY);
    expect(world.getCell(8, SURFACE + 1, 8)).toBe(RUBBLE);
    expect(isSourceAt(world, 8, SURFACE, 8, B.WATER)).toBe(true);
    expect(isSourceAt(world, 8, SURFACE + 2, 8, B.LAVA)).toBe(true);
  });

  /** 1-wide channel along +x at SURFACE (x 2..14, z 8) over the platform; `basin` replaces the floor at x = 10. */
  const channel =
    (basin: number): CellFn =>
    (x, y, z) => {
      if (y < FLOOR_Y - 1) return AIR;
      if (y === FLOOR_Y - 1) return STONE;
      if (y === FLOOR_Y) return x === 10 && z === 8 ? basin : STONE;
      if (y === SURFACE) return z === 8 && x >= 2 && x <= 14 ? AIR : STONE;
      return AIR;
    };

  it('flowing lava arriving next to water hardens into rubble at the front; the water is not consumed', () => {
    const fw = buildWorld(channel(water()));
    const { world, fluids } = fw;
    world.setCell(7, SURFACE, 8, lava());
    pumpTicks(world, fluids, 3 * LAVA_TICK_DELAY);
    expect(world.getCell(10, SURFACE, 8)).toBe(RUBBLE);
    expect(amountAt(world, 9, SURFACE, 8)).toBe(4);
    expect(isSourceAt(world, 10, FLOOR_Y, 8, B.WATER)).toBe(true);
    pumpUntilQuiet(fw);
    expect(world.getCell(10, SURFACE, 8)).toBe(RUBBLE);
    expect(amountAt(world, 11, SURFACE, 8)).toBe(0);
  });

  it('water flowing over a lava source turns it into obsidian', () => {
    const fw = buildWorld(channel(lava()));
    const { world, fluids } = fw;
    world.setCell(7, SURFACE, 8, water());
    pumpTicks(world, fluids, 3 * WATER_TICK_DELAY);
    expect(amountAt(world, 10, SURFACE, 8)).toBe(5);
    expect(world.getId(10, FLOOR_Y, 8)).toBe(B.LAVA);
    pumpTicks(world, fluids, CONTACT_TICK_DELAY);
    expect(world.getCell(10, FLOOR_Y, 8)).toBe(OBSIDIAN);
    pumpUntilQuiet(fw);
    expect(countLiquid(world, B.LAVA)).toBe(0);
  });

  it('flowing lava in a channel touched by water from the side turns into rubble', () => {
    const fw = buildWorld(channel(STONE));
    const { world, fluids } = fw;
    world.setCell(4, SURFACE, 8, lava());
    pumpTicks(world, fluids, 2 * LAVA_TICK_DELAY);
    expect(amountAt(world, 6, SURFACE, 8)).toBe(4);
    world.setCell(7, SURFACE, 8, water());
    pumpTicks(world, fluids, CONTACT_TICK_DELAY);
    expect(world.getCell(6, SURFACE, 8)).toBe(RUBBLE);
    expect(isSourceAt(world, 4, SURFACE, 8, B.LAVA)).toBe(true);
    expect(amountAt(world, 5, SURFACE, 8)).toBe(6);
  });
});

describe('soft blocks are washed away', () => {
  it('torch, flowers, grass tuft and snow cover are overwritten and reported through the change hook', () => {
    const fw = buildWorld();
    const { world } = fw;
    const plants: Array<[number, number, number]> = [
      [10, 8, B.TORCH],
      [8, 10, B.FLOWER_RED],
      [6, 8, B.SNOW_LAYER],
      [8, 6, B.TALL_GRASS],
      [11, 11, B.FLOWER_YELLOW],
    ];
    for (const [x, z, id] of plants) world.setCell(x, SURFACE, z, makeCell(id));
    const washed: number[] = [];
    world.onCellChange((_x, _y, _z, oldCell, newCell) => {
      if ((newCell & ID_MASK) === B.WATER && (oldCell & ID_MASK) !== B.WATER && oldCell !== AIR) {
        washed.push(oldCell & ID_MASK);
      }
    });
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    for (const [x, z] of plants) expect(world.getId(x, SURFACE, z)).toBe(B.WATER);
    expect(washed.sort((a, b) => a - b)).toEqual(plants.map((p) => p[2]).sort((a, b) => a - b));
    expect(countLiquid(world)).toBe(113);
  });

  it('hard blocks (cactus, glass) are not', () => {
    const fw = buildWorld();
    const { world } = fw;
    world.setCell(9, SURFACE, 8, makeCell(B.CACTUS));
    world.setCell(7, SURFACE, 8, makeCell(B.GLASS));
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(world.getId(9, SURFACE, 8)).toBe(B.CACTUS);
    expect(world.getId(7, SURFACE, 8)).toBe(B.GLASS);
  });
});

describe('scheduling contract', () => {
  it('handles() accepts water and lava only', () => {
    const { fluids } = buildWorld();
    expect(fluids.handles(B.WATER)).toBe(true);
    expect(fluids.handles(B.LAVA)).toBe(true);
    expect(fluids.handles(B.STONE)).toBe(false);
    expect(fluids.handles(B.AIR)).toBe(false);
    expect(fluids.handles(B.SAND)).toBe(false);
  });

  it('placing a liquid schedules it after its tick delay; a changed neighbour re-schedules settled liquid', () => {
    const fw = settledDiamond();
    const { world } = fw;
    expect(world.ticks.size).toBe(0);
    world.setCell(12, SURFACE + 1, 8, makeCell(B.STONE)); // above a ring-4 cell
    expect(world.ticks.has(12, SURFACE, 8, B.WATER)).toBe(true);
    world.setCell(30, SURFACE + 3, 30, lava());
    expect(world.ticks.has(30, SURFACE + 3, 30, B.LAVA)).toBe(true);
    const at = world.ticks.all().find((t) => t.x === 30)!.at;
    expect(at - world.time).toBe(LAVA_TICK_DELAY);
  });

  it('SET_NO_NEIGHBOR_UPDATE writes do not wake neighbouring liquid', () => {
    const fw = settledDiamond();
    const { world } = fw;
    world.setCell(11, FLOOR_Y, 8, AIR, SET_NO_NEIGHBOR_UPDATE);
    expect(world.ticks.size).toBe(0);
    world.setCell(11, FLOOR_Y, 8, makeCell(B.DIRT));
    expect(world.ticks.has(11, SURFACE, 8, B.WATER)).toBe(true);
  });

  it('a stale tick (block changed meanwhile) is ignored', () => {
    const fw = buildWorld();
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, makeCell(B.STONE));
    fluids.tick(8, SURFACE, 8, B.WATER);
    fluids.tick(8, SURFACE, 8, B.STONE);
    expect(world.getCell(8, SURFACE, 8)).toBe(STONE);
    expect(world.ticks.size).toBe(0);
  });

  it('attach() is idempotent and its unsubscribe stops all scheduling', () => {
    const { world, fluids } = buildWorld(undefined, undefined, false);
    world.setCell(2, SURFACE, 2, water());
    expect(world.ticks.size).toBe(0); // not attached yet
    const off = fluids.attach();
    expect(fluids.attach()).toBe(off);
    world.setCell(4, SURFACE, 4, water());
    expect(world.ticks.size).toBe(1); // one subscription, one tick
    world.ticks.clear();
    off();
    off(); // harmless twice
    world.setCell(6, SURFACE, 6, water());
    expect(world.ticks.size).toBe(0);
    const again = fluids.attach();
    expect(again).not.toBe(off);
    off(); // a stale unsubscribe must not detach the new subscription
    world.setCell(8, SURFACE, 8, water());
    expect(world.ticks.has(8, SURFACE, 8, B.WATER)).toBe(true);
  });

  it('runs are deterministic', () => {
    const run = (): string => {
      const fw = buildWorld();
      fw.world.setCell(8, SURFACE, 8, water());
      fw.world.setCell(14, SURFACE, 3, lava());
      fw.world.setCell(1, SURFACE, 12, water());
      pumpUntilQuiet(fw);
      return liquidCells(fw.world)
        .map((c) => `${c.x},${c.y},${c.z}:${c.id}/${c.state}`)
        .join(' ');
    };
    expect(run()).toBe(run());
  });
});
