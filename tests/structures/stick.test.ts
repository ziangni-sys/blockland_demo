import { describe, expect, it } from 'vitest';
import { axisState, facingState, layersState, liquidState, makeCell } from '../../src/blocks/cell';
import { B, CELL_BELOW_WORLD, CELL_UNLOADED, WOOL_COLORS } from '../../src/blocks/defs';
import { BLOCKS } from '../../src/blocks/registry';
import { ALL_DIRS, DIR_X, DIR_Y, DIR_Z, NX, NY, NZ, PX, PY, PZ, opposite, type Dir } from '../../src/core/dirs';
import {
  autoSticks,
  canGlue,
  canJoinStructure,
  cellFunc,
  connected,
  connectedCells,
  isFunctionalCell,
  isSailCell,
  mountSticks,
} from '../../src/structures/stick';
import { GlueStore } from '../../src/structures/glue';
import { World } from '../../src/voxel/world';
import { Chunk } from '../../src/voxel/chunk';
import { HARNESSES, c, type Harness } from './harness';

const WOOLS = WOOL_COLORS.map((_, i) => makeCell(B.WOOL_WHITE + i));
const CLOTH = [...WOOLS, makeCell(B.CANVAS)];
const logC = (id: number, axis: 0 | 1 | 2): number => makeCell(id, axisState(axis));
const facing = (id: number, d: Dir): number => makeCell(id, facingState(d));

/** Every registered block with a representative spread of state values. */
function allCellValues(): number[] {
  const out: number[] = [];
  for (const def of BLOCKS) {
    if (!def) continue;
    const states =
      def.stateKind === 'axis'
        ? [0, 1, 2]
        : def.stateKind === 'facing'
          ? [0, 1, 2, 3, 4, 5]
          : def.stateKind === 'liquid'
            ? [liquidState(0, false), liquidState(3, false), liquidState(0, true)]
            : def.stateKind === 'layers'
              ? [layersState(1), layersState(8)]
              : [0];
    for (const s of states) out.push(makeCell(def.id, s));
  }
  return out;
}

describe('stick: per-cell predicates', () => {
  it('canJoinStructure rejects air, liquids and unbreakable blocks only', () => {
    for (const cell of [c(B.AIR), c(B.WATER), c(B.WATER, liquidState(5, true)), c(B.LAVA), c(B.LAVA, 3), c(B.DEEPROCK), CELL_UNLOADED, CELL_BELOW_WORLD]) {
      expect(canJoinStructure(cell), `cell ${cell}`).toBe(false);
    }
    for (const id of [B.STONE, B.COBBLE, B.DIRT, B.SAND, B.PLANKS_OAK, B.LOG_PINE, B.WOOL_RED, B.CANVAS, B.GLASS, B.HELM, B.BEARING, B.PROPELLER, B.TORCH, B.TNT, B.FLOWER_RED, B.TALL_GRASS, B.SNOW_LAYER, B.CACTUS, B.LEAVES_OAK, B.OBSIDIAN]) {
      expect(canJoinStructure(c(id)), `id ${id}`).toBe(true);
    }
    // Unregistered ids (corrupt data) never join.
    expect(canJoinStructure(c(999))).toBe(false);
  });

  it('canGlue additionally rejects every non-solid block', () => {
    for (const cell of [c(B.AIR), c(B.WATER), c(B.LAVA), c(B.DEEPROCK), CELL_UNLOADED, c(B.TORCH), c(B.FLOWER_RED), c(B.FLOWER_YELLOW), c(B.TALL_GRASS), c(B.SNOW_LAYER, layersState(8)), c(999)]) {
      expect(canGlue(cell), `cell ${cell}`).toBe(false);
    }
    for (const id of [B.STONE, B.COBBLE, B.PLANKS_OAK, B.WOOL_BLUE, B.GLASS, B.LEAVES_PINE, B.HELM, B.BEARING, B.PROPELLER, B.CACTUS, B.TNT, B.ICE]) {
      expect(canGlue(c(id)), `id ${id}`).toBe(true);
    }
  });

  it('classifies sails and functional blocks', () => {
    for (const cell of CLOTH) expect(isSailCell(cell)).toBe(true);
    for (const id of [B.PLANKS_OAK, B.STONE, B.AIR, B.HELM]) expect(isSailCell(c(id))).toBe(false);
    expect(cellFunc(c(B.HELM))).toBe('helm');
    expect(cellFunc(facing(B.BEARING, PZ))).toBe('bearing');
    expect(cellFunc(c(B.PROPELLER))).toBe('propeller');
    expect(cellFunc(c(B.TORCH))).toBe('none');
    expect(cellFunc(c(999))).toBe('none');
    for (const id of [B.HELM, B.BEARING, B.PROPELLER]) expect(isFunctionalCell(c(id))).toBe(true);
    for (const id of [B.TORCH, B.PLANKS_OAK, B.AIR, B.CANVAS]) expect(isFunctionalCell(c(id))).toBe(false);
  });
});

describe('stick: auto-stick rules (acceptance 1, 2)', () => {
  it('every felt colour and canvas stick to each other', () => {
    for (const a of CLOTH) for (const b of CLOTH) for (const d of ALL_DIRS) expect(autoSticks(a, b, d)).toBe(true);
  });
  it('planks stick to planks of any wood; planks and cloth do not', () => {
    for (const d of ALL_DIRS) {
      expect(autoSticks(c(B.PLANKS_OAK), c(B.PLANKS_PINE), d)).toBe(true);
      expect(autoSticks(c(B.PLANKS_PINE), c(B.PLANKS_PINE), d)).toBe(true);
      for (const w of CLOTH) {
        expect(autoSticks(c(B.PLANKS_OAK), w, d)).toBe(false);
        expect(autoSticks(w, c(B.PLANKS_PINE), d)).toBe(false);
      }
    }
  });
  it('terrain-list blocks never stick, not even to themselves', () => {
    const terrain = [B.STONE, B.COBBLE, B.DIRT, B.TURF, B.SAND, B.GRAVEL, B.LEAVES_OAK, B.LEAVES_PINE, B.OBSIDIAN, B.COAL_ORE, B.IRON_ORE, B.COPPER_ORE, B.SNOW_BLOCK, B.ICE, B.CLAY, B.CACTUS, B.FLOWER_RED, B.TALL_GRASS];
    for (const id of terrain) for (const d of ALL_DIRS) expect(autoSticks(c(id), c(id), d), `id ${id}`).toBe(false);
  });
  it('other building blocks stick only to the same kind', () => {
    for (const id of [B.STONE_BRICKS, B.BRICKS, B.GLASS, B.SANDSTONE, B.IRON_BLOCK, B.LAMP, B.TNT]) {
      for (const d of ALL_DIRS) expect(autoSticks(c(id), c(id), d), `id ${id}`).toBe(true);
    }
    expect(autoSticks(c(B.STONE_BRICKS), c(B.BRICKS), PX)).toBe(false);
    expect(autoSticks(c(B.GLASS), c(B.STONE_BRICKS), PY)).toBe(false);
    expect(autoSticks(c(B.STONE_BRICKS), c(B.STONE), PZ)).toBe(false);
  });
  it('vertical logs connect up and down only', () => {
    const v = logC(B.LOG_OAK, 1);
    expect(autoSticks(v, v, PY)).toBe(true);
    expect(autoSticks(v, v, NY)).toBe(true);
    for (const d of [PX, NX, PZ, NZ]) expect(autoSticks(v, v, d)).toBe(false);
  });
  it('horizontal logs connect only along their own axis', () => {
    const lx = logC(B.LOG_PINE, 0);
    const lz = logC(B.LOG_PINE, 2);
    expect(autoSticks(lx, lx, PX)).toBe(true);
    expect(autoSticks(lx, lx, NX)).toBe(true);
    for (const d of [PY, NY, PZ, NZ]) expect(autoSticks(lx, lx, d)).toBe(false);
    expect(autoSticks(lz, lz, PZ)).toBe(true);
    expect(autoSticks(lz, lz, NZ)).toBe(true);
    for (const d of [PX, NX, PY, NY]) expect(autoSticks(lz, lz, d)).toBe(false);
    // Crossing logs: different axes never stick, whichever face they share.
    for (const d of ALL_DIRS) expect(autoSticks(lx, lz, d)).toBe(false);
    for (const d of ALL_DIRS) expect(autoSticks(lx, logC(B.LOG_PINE, 1), d)).toBe(false);
  });
  it('different log kinds never stick; logs do not stick to planks', () => {
    for (const axis of [0, 1, 2] as const) {
      for (const d of ALL_DIRS) {
        expect(autoSticks(logC(B.LOG_OAK, axis), logC(B.LOG_PINE, axis), d)).toBe(false);
        expect(autoSticks(logC(B.LOG_OAK, axis), c(B.PLANKS_OAK), d)).toBe(false);
      }
    }
  });
  it('functional blocks, liquids, air and unbreakable blocks never auto-stick', () => {
    const never = [c(B.HELM), facing(B.BEARING, PX), facing(B.PROPELLER, NZ), c(B.TORCH), c(B.WATER), c(B.LAVA), c(B.AIR), c(B.DEEPROCK), CELL_UNLOADED];
    for (const a of never) for (const d of ALL_DIRS) {
      expect(autoSticks(a, a, d)).toBe(false);
      expect(autoSticks(a, c(B.PLANKS_OAK), d)).toBe(false);
    }
  });
  it('is symmetric over every block and state', () => {
    const cells = allCellValues();
    for (const a of cells) {
      for (const b of cells) {
        for (const d of ALL_DIRS) {
          if (autoSticks(a, b, d) !== autoSticks(b, a, opposite(d))) {
            throw new Error(`autoSticks asymmetric for ${a}, ${b}, dir ${d}`);
          }
        }
      }
    }
  });
});

describe('stick: functional mounting (acceptance 3)', () => {
  it('helm and torch stick to the hard block directly below, terrain included', () => {
    for (const top of [facing(B.HELM, NZ), facing(B.HELM, PX), c(B.TORCH)]) {
      for (const id of [B.COBBLE, B.STONE, B.DIRT, B.SAND, B.PLANKS_OAK, B.GLASS, B.LEAVES_OAK, B.OBSIDIAN, B.HELM, B.WOOL_RED]) {
        expect(mountSticks(top, c(id), NY), `on ${id}`).toBe(true);
        for (const d of [PX, NX, PY, PZ, NZ]) expect(mountSticks(top, c(id), d)).toBe(false);
      }
      // Not on soft, liquid or unbreakable blocks.
      for (const below of [c(B.AIR), c(B.WATER), c(B.LAVA), c(B.TORCH), c(B.TALL_GRASS), c(B.SNOW_LAYER), c(B.DEEPROCK), CELL_UNLOADED]) {
        expect(mountSticks(top, below, NY)).toBe(false);
      }
    }
  });
  it('bearing and propeller stick to the hard block behind them, never in front', () => {
    for (const id of [B.BEARING, B.PROPELLER]) {
      for (const f of ALL_DIRS) {
        const cell = facing(id, f);
        for (const d of ALL_DIRS) {
          expect(mountSticks(cell, c(B.COBBLE), d), `id ${id} facing ${f} dir ${d}`).toBe(d === opposite(f));
          expect(mountSticks(cell, c(B.PLANKS_OAK), d)).toBe(d === opposite(f));
        }
        expect(mountSticks(cell, c(B.WATER), opposite(f))).toBe(false);
        expect(mountSticks(cell, c(B.DEEPROCK), opposite(f))).toBe(false);
        expect(mountSticks(cell, c(B.TORCH), opposite(f))).toBe(false);
      }
    }
  });
  it('blocks without a mounting face never mount', () => {
    for (const a of [c(B.PLANKS_OAK), c(B.COBBLE), c(B.CANVAS), c(B.AIR), c(B.WATER)]) {
      for (const d of ALL_DIRS) expect(mountSticks(a, c(B.STONE), d)).toBe(false);
    }
  });
});

/** Place a at the origin and b next to it, then return connected() checked from both sides. */
function pair(h: Harness, a: number, b: number, dir: Dir, glued = false): boolean {
  const [x, y, z] = h.abs(0, 0, 0);
  const nx = x + DIR_X[dir]!;
  const ny = y + DIR_Y[dir]!;
  const nz = z + DIR_Z[dir]!;
  h.set(0, 0, 0, a);
  h.set(DIR_X[dir]!, DIR_Y[dir]!, DIR_Z[dir]!, b);
  if (glued) h.glueFace(0, 0, 0, dir);
  const ab = connected(h.grid, h.glue, x, y, z, dir);
  const ba = connected(h.grid, h.glue, nx, ny, nz, opposite(dir));
  expect(ba, 'connected() must be symmetric').toBe(ab);
  // Reset for the next pair.
  h.set(0, 0, 0, c(B.AIR));
  h.set(DIR_X[dir]!, DIR_Y[dir]!, DIR_Z[dir]!, c(B.AIR));
  h.glue.clear();
  return ab;
}

for (const make of HARNESSES) {
  describe(`stick: connected() on a ${make().name}`, () => {
    it('acceptance 1: cloth group, planks group, same-kind building blocks', () => {
      const h = make();
      expect(pair(h, c(B.WOOL_RED), c(B.WOOL_BLUE), PX)).toBe(true);
      expect(pair(h, c(B.WOOL_BLACK), c(B.CANVAS), NZ)).toBe(true);
      expect(pair(h, c(B.CANVAS), c(B.WOOL_WHITE), PY)).toBe(true);
      expect(pair(h, c(B.PLANKS_OAK), c(B.PLANKS_PINE), PZ)).toBe(true);
      expect(pair(h, c(B.PLANKS_OAK), c(B.WOOL_YELLOW), PX)).toBe(false);
      expect(pair(h, c(B.COBBLE), c(B.COBBLE), PX)).toBe(false);
      expect(pair(h, c(B.COBBLE), c(B.COBBLE), PY)).toBe(false);
      expect(pair(h, c(B.STONE_BRICKS), c(B.STONE_BRICKS), NX)).toBe(true);
      expect(pair(h, c(B.STONE_BRICKS), c(B.BRICKS), NX)).toBe(false);
    });
    it('acceptance 2: logs connect only along their own trunk', () => {
      const h = make();
      const v = logC(B.LOG_OAK, 1);
      expect(pair(h, v, v, PY)).toBe(true);
      expect(pair(h, v, v, NY)).toBe(true);
      expect(pair(h, v, v, PX)).toBe(false);
      expect(pair(h, v, v, NZ)).toBe(false);
      const lx = logC(B.LOG_OAK, 0);
      expect(pair(h, lx, lx, NX)).toBe(true);
      expect(pair(h, lx, lx, PZ)).toBe(false);
      expect(pair(h, lx, lx, PY)).toBe(false);
      const lz = logC(B.LOG_PINE, 2);
      expect(pair(h, lz, lz, PZ)).toBe(true);
      expect(pair(h, lz, lz, PX)).toBe(false);
      expect(pair(h, logC(B.LOG_OAK, 2), logC(B.LOG_PINE, 2), PZ)).toBe(false);
      expect(pair(h, lx, logC(B.LOG_OAK, 2), PX)).toBe(false);
    });
    it('acceptance 3: helm sticks to the rubble under it; bearing to its back, not its front', () => {
      const h = make();
      expect(pair(h, facing(B.HELM, NZ), c(B.COBBLE), NY)).toBe(true);
      expect(pair(h, facing(B.HELM, NZ), c(B.COBBLE), PX)).toBe(false); // beside it
      expect(pair(h, facing(B.HELM, NZ), c(B.COBBLE), PY)).toBe(false); // block on top of the helm
      expect(pair(h, c(B.TORCH), c(B.PLANKS_OAK), NY)).toBe(true);
      expect(pair(h, c(B.TORCH), c(B.PLANKS_OAK), PZ)).toBe(false);
      for (const f of ALL_DIRS) {
        const bearing = facing(B.BEARING, f);
        expect(pair(h, bearing, c(B.STONE), opposite(f)), `bearing facing ${f}, back`).toBe(true);
        expect(pair(h, bearing, c(B.CANVAS), f), `bearing facing ${f}, front`).toBe(false);
        expect(pair(h, bearing, c(B.CANVAS), f, true), `bearing facing ${f}, glued front`).toBe(true);
      }
      expect(pair(h, facing(B.PROPELLER, PX), c(B.PLANKS_OAK), NX)).toBe(true);
      expect(pair(h, facing(B.PROPELLER, PX), c(B.PLANKS_OAK), PX)).toBe(false);
    });
    it('acceptance 3: deeprock never joins, glued or not', () => {
      const h = make();
      expect(pair(h, c(B.STONE), c(B.DEEPROCK), NY)).toBe(false);
      expect(pair(h, c(B.STONE), c(B.DEEPROCK), NY, true)).toBe(false);
      expect(pair(h, facing(B.HELM, PX), c(B.DEEPROCK), NY)).toBe(false);
      expect(pair(h, facing(B.BEARING, PY), c(B.DEEPROCK), NY)).toBe(false);
      expect(pair(h, c(B.DEEPROCK), c(B.DEEPROCK), PX, true)).toBe(false);
    });
    it('glue joins any two breakable hard blocks, and only those', () => {
      const h = make();
      expect(pair(h, c(B.COBBLE), c(B.COBBLE), PX, true)).toBe(true);
      expect(pair(h, c(B.STONE), c(B.DIRT), PY, true)).toBe(true);
      expect(pair(h, c(B.PLANKS_OAK), c(B.WOOL_GREEN), NZ, true)).toBe(true);
      expect(pair(h, c(B.LEAVES_OAK), c(B.GLASS), NX, true)).toBe(true);
      expect(pair(h, logC(B.LOG_OAK, 1), logC(B.LOG_OAK, 1), PX, true)).toBe(true);
      expect(pair(h, facing(B.HELM, PX), c(B.PLANKS_OAK), PX, true)).toBe(true);
      // Stale glue next to a cell that cannot carry glue does not count.
      expect(pair(h, c(B.TORCH), c(B.PLANKS_OAK), PX, true)).toBe(false);
      expect(pair(h, c(B.FLOWER_RED), c(B.STONE), NZ, true)).toBe(false);
      expect(pair(h, c(B.WATER), c(B.PLANKS_OAK), PX, true)).toBe(false);
      expect(pair(h, c(B.AIR), c(B.PLANKS_OAK), PX, true)).toBe(false);
    });
    it('liquids and air never connect', () => {
      const h = make();
      expect(pair(h, c(B.WATER), c(B.WATER), PX)).toBe(false);
      expect(pair(h, c(B.LAVA), c(B.LAVA), PY)).toBe(false);
      expect(pair(h, c(B.AIR), c(B.AIR), PZ)).toBe(false);
    });
    it('agrees with the pure rules for every pairing of a block sample', () => {
      const h = make();
      const glue = new GlueStore();
      const sample = [c(B.PLANKS_OAK), c(B.WOOL_RED), c(B.COBBLE), c(B.STONE_BRICKS), logC(B.LOG_OAK, 0), logC(B.LOG_OAK, 1), facing(B.HELM, NZ), facing(B.BEARING, PY), facing(B.BEARING, NX), c(B.TORCH), c(B.WATER), c(B.AIR), c(B.DEEPROCK)];
      for (const a of sample) {
        for (const b of sample) {
          for (const d of ALL_DIRS) {
            const expected = autoSticks(a, b, d) || mountSticks(a, b, d) || mountSticks(b, a, opposite(d));
            expect(pair(h, a, b, d)).toBe(expected && canJoinStructure(a) && canJoinStructure(b));
            const [x, y, z] = h.abs(0, 0, 0);
            expect(connectedCells(a, b, d, glue, x, y, z)).toBe(expected && canJoinStructure(a) && canJoinStructure(b));
          }
        }
      }
    });
  });
}

describe('stick: connected() at the edges of the world', () => {
  function world(): World {
    const w = new World(3);
    w.addChunk(new Chunk(0, 0));
    return w;
  }
  it('cells below the world are deeprock and never join, even with glue', () => {
    const w = world();
    const g = new GlueStore();
    w.setCell(3, 0, 3, c(B.STONE));
    g.add(3, 0, 3, NY);
    expect(connected(w, g, 3, 0, 3, NY)).toBe(false);
    expect(connected(w, g, 3, -1, 3, PY)).toBe(false);
    w.setCell(4, 0, 3, facing(B.HELM, PX));
    expect(connected(w, g, 4, 0, 3, NY)).toBe(false);
  });
  it('unloaded chunks never join, even with glue', () => {
    const w = world();
    const g = new GlueStore();
    w.setCell(15, 10, 5, c(B.PLANKS_OAK));
    g.add(15, 10, 5, PX);
    expect(w.getCell(16, 10, 5)).toBe(CELL_UNLOADED);
    expect(connected(w, g, 15, 10, 5, PX)).toBe(false);
    expect(connected(w, g, 16, 10, 5, NX)).toBe(false);
    w.setCell(0, 10, 5, facing(B.BEARING, PX));
    expect(connected(w, g, 0, 10, 5, NX)).toBe(false); // its back is unloaded
  });
});
