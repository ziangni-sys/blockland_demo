/**
 * Sticking and glue with partial blocks (docs/SHAPES.md 10.1, 10.2; ACCEPTANCE 42): two cells
 * connect only where they TOUCH (their hard covers of the shared face overlap), the material that
 * really touches decides the auto-stick, a mounting face must be fully covered, glue joins two
 * cells only where they touch, and the glue lifetime rules (state, and lost contact). Every pair
 * predicate stays symmetric over every block, state and shape. The pure predicates are tested on
 * values; the lifetime rule (pruneGlueAt, pruneGlueInBox) on the two harness grids (a world and a
 * structure grid). The same rules through the manager's hooks on world, ship and rotor grids are in
 * tests/structcore/glue-shapes.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { axisState, CELL_MULTI_BIT, facingState, layersState, liquidState, makeCell } from '../../src/blocks/cell';
import { B, CELL_UNLOADED, WOOL_COLORS } from '../../src/blocks/defs';
import { BLOCKS, CUTTABLE } from '../../src/blocks/registry';
import { canonCell, withoutPartAt } from '../../src/blocks/shapes';
import { ALL_DIRS, NX, NY, NZ, PX, PY, PZ, opposite, type Dir } from '../../src/core/dirs';
import { GlueStore } from '../../src/structures/glue';
import {
  autoSticks,
  canGlue,
  canJoinStructure,
  connected,
  connectedCells,
  glueFaceKept,
  glueSideAt,
  holdsGlue,
  isSailCell,
  mountSticks,
  pruneGlueAt,
  pruneGlueInBox,
  sailVolume8,
  sticksWithoutGlue,
} from '../../src/structures/stick';
import { getPacked } from '../../src/voxel/parts';
import { EAST, LOWER, NORTH, slab, SOUTH, stairFill, UPPER, WEST } from '../shapes';
import { HARNESSES, c } from './harness';

const facing = (id: number, d: Dir): number => makeCell(id, facingState(d));

/** Every registered block with a spread of states (as stick.test.ts), plus the unloaded sentinel. */
function fullValues(): number[] {
  const out: number[] = [];
  for (const def of BLOCKS) {
    if (!def) continue;
    const states =
      def.stateKind === 'axis'
        ? [0, 1, 2]
        : def.stateKind === 'facing'
          ? [0, 1, 2, 3, 4, 5]
          : def.stateKind === 'liquid'
            ? [liquidState(0, false), liquidState(3, true)]
            : def.stateKind === 'layers'
              ? [layersState(1), layersState(8)]
              : [0];
    for (const s of states) out.push(makeCell(def.id, s));
  }
  return out;
}

/** Fills that cover different quadrant patterns of every face. */
const FILLS = [LOWER, UPPER, WEST, EAST, NORTH, SOUTH, stairFill(PX), stairFill(NZ), 0x01, 0x80, 0x7f, 0x69];

/** Partial cells: every cuttable block as a few shapes (logs in every axis), and two-part cells. */
function partialValues(): number[] {
  const out: number[] = [];
  const cut = BLOCKS.filter((d) => d !== undefined && CUTTABLE[d.id] === 1);
  for (const def of cut) {
    const states = def!.stateKind === 'axis' ? [0, 1, 2] : [0];
    for (const s of states) for (const f of [LOWER, UPPER, WEST, 0x80, stairFill(PZ)]) out.push(slab(def!.id, f, s));
  }
  const pairs: Array<[number, number]> = [
    [slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)],
    [slab(B.PLANKS_OAK, WEST), slab(B.WOOL_RED, EAST)],
    [slab(B.WOOL_WHITE, NORTH), slab(B.CANVAS, SOUTH)],
    [slab(B.LOG_OAK, LOWER, 1), slab(B.LOG_OAK, UPPER, 0)],
    [slab(B.BRICKS, 0x01), slab(B.STONE, 0x80)],
    [slab(B.GLASS, 0x69), slab(B.PLANKS_PINE, 0x96)],
  ];
  for (const [a, b] of pairs) out.push(canonCell(a, b));
  for (const f of FILLS) out.push(slab(B.PLANKS_OAK, f), slab(B.WOOL_BLUE, f));
  return out;
}

describe('stick with shapes: contact decides (SHAPES 10.1, 10.2)', () => {
  it('an upper slab and the upper slab in the cell above do not stick (ACCEPTANCE 42); a lower slab under an upper one does', () => {
    const up = slab(B.PLANKS_OAK, UPPER);
    const low = slab(B.PLANKS_OAK, LOWER);
    expect(autoSticks(up, up, PY)).toBe(false);
    expect(autoSticks(up, up, NY)).toBe(false);
    expect(sticksWithoutGlue(up, up, PY)).toBe(false);
    expect(autoSticks(low, up, PY)).toBe(false); // the lower slab's top is empty, the upper slab's bottom too
    expect(autoSticks(up, low, PY)).toBe(true); // an upper slab under a lower slab: they share the face
    expect(autoSticks(up, c(B.PLANKS_OAK), PY)).toBe(true);
    expect(autoSticks(low, c(B.PLANKS_OAK), PY)).toBe(false);
    expect(autoSticks(low, c(B.PLANKS_OAK), NY)).toBe(true);
  });

  it('a lower slab beside an upper slab touches only along an edge: no sticking; two lower slabs side by side stick', () => {
    const up = slab(B.WOOL_RED, UPPER);
    const low = slab(B.WOOL_BLUE, LOWER);
    for (const d of [PX, NX, PZ, NZ] as Dir[]) {
      expect(autoSticks(low, up, d)).toBe(false);
      expect(autoSticks(up, low, d)).toBe(false);
      expect(autoSticks(low, low, d)).toBe(true);
      expect(autoSticks(up, up, d)).toBe(true);
    }
  });

  it('in a two-part cell the part that touches decides: bricks below and planks above stick to planks above, not to bricks above', () => {
    const two = canonCell(slab(B.BRICKS, LOWER), slab(B.PLANKS_OAK, UPPER));
    expect(autoSticks(two, c(B.PLANKS_PINE), PY)).toBe(true);
    expect(autoSticks(two, c(B.BRICKS), PY)).toBe(false);
    expect(autoSticks(two, c(B.BRICKS), NY)).toBe(true);
    expect(autoSticks(two, c(B.PLANKS_OAK), NY)).toBe(false);
    // Sideways both parts touch, each in its own half of the face.
    expect(autoSticks(two, c(B.BRICKS), PX)).toBe(true);
    expect(autoSticks(two, c(B.PLANKS_OAK), PX)).toBe(true);
    expect(autoSticks(two, slab(B.BRICKS, UPPER), PX)).toBe(false); // the bricks above meet the planks
    expect(autoSticks(two, slab(B.PLANKS_OAK, UPPER), PX)).toBe(true);
    // Terrain-list materials (stone) never auto-stick, partial or not.
    expect(autoSticks(slab(B.STONE, LOWER), c(B.STONE), NY)).toBe(false);
  });

  it('a log slab keeps the log rule: same id, same axis, face on the axis, and the touching material', () => {
    const yLow = slab(B.LOG_OAK, LOWER, axisState(1));
    const yUp = slab(B.LOG_OAK, UPPER, axisState(1));
    expect(autoSticks(yUp, makeCell(B.LOG_OAK, axisState(1)), PY)).toBe(true);
    expect(autoSticks(yLow, makeCell(B.LOG_OAK, axisState(1)), PY)).toBe(false); // does not touch
    expect(autoSticks(yUp, makeCell(B.LOG_OAK, axisState(0)), PY)).toBe(false); // other axis
    expect(autoSticks(yLow, yLow, PX)).toBe(false); // touch, but the face is not on the axis
  });

  it('every pair predicate is symmetric over every block, state and shape', () => {
    const cells = [...fullValues(), ...partialValues()];
    const glue = new GlueStore();
    glue.add(0, 0, 0, PX);
    glue.add(0, 0, 0, PY);
    glue.add(0, 0, 0, PZ);
    let checked = 0;
    for (const a of cells) {
      for (const b of cells) {
        for (const d of ALL_DIRS) {
          const o = opposite(d);
          if (autoSticks(a, b, d) !== autoSticks(b, a, o)) throw new Error(`autoSticks asymmetric for ${a}, ${b}, dir ${d}`);
          if (sticksWithoutGlue(a, b, d) !== sticksWithoutGlue(b, a, o)) throw new Error(`sticksWithoutGlue asymmetric for ${a}, ${b}, dir ${d}`);
          if (glueFaceKept(a, b, d) !== glueFaceKept(b, a, o)) throw new Error(`glueFaceKept asymmetric for ${a}, ${b}, dir ${d}`);
          // The glued faces are the positive ones from the origin: a at the origin, b across them.
          if (d === PX || d === PY || d === PZ) {
            const [bx, by, bz] = [d === PX ? 1 : 0, d === PY ? 1 : 0, d === PZ ? 1 : 0];
            if (connectedCells(a, b, d, glue, 0, 0, 0) !== connectedCells(b, a, o, glue, bx, by, bz)) {
              throw new Error(`connectedCells asymmetric for ${a}, ${b}, dir ${d}`);
            }
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(400_000);
  });

  it('full blocks give exactly the M1 answers (two full blocks always touch over the whole face)', () => {
    const cells = fullValues();
    const glue = new GlueStore();
    glue.add(0, 0, 0, PX);
    for (const a of cells) {
      for (const b of cells) {
        // M1: both join, and they stick without glue or both may carry glue.
        const m1 = canJoinStructure(a) && canJoinStructure(b) && (sticksWithoutGlue(a, b, PX) || (canGlue(a) && canGlue(b)));
        if (connectedCells(a, b, PX, glue, 0, 0, 0) !== m1) throw new Error(`full blocks ${a}, ${b}`);
      }
    }
  });
});

describe('mounting needs a fully covered face (SHAPES 10.2 mountSticks)', () => {
  it('helm and torch: an upper slab or a full two-part cell below carries them, a lower slab or a stair does not', () => {
    for (const top of [facing(B.HELM, NZ), c(B.TORCH)]) {
      expect(mountSticks(top, slab(B.PLANKS_OAK, UPPER), NY)).toBe(true);
      expect(mountSticks(top, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)), NY)).toBe(true);
      expect(mountSticks(top, canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.STONE, SOUTH)), NY)).toBe(true);
      expect(mountSticks(top, slab(B.PLANKS_OAK, LOWER), NY)).toBe(false);
      expect(mountSticks(top, slab(B.PLANKS_OAK, stairFill(PX)), NY)).toBe(false);
      expect(mountSticks(top, slab(B.PLANKS_OAK, 0xff & ~0x40), NY)).toBe(false); // one top octant missing
      expect(sticksWithoutGlue(slab(B.PLANKS_OAK, LOWER), top, PY)).toBe(false);
      expect(sticksWithoutGlue(slab(B.PLANKS_OAK, UPPER), top, PY)).toBe(true);
    }
  });

  it('bearing and propeller: the cell behind must cover the whole face towards them', () => {
    for (const id of [B.BEARING, B.PROPELLER]) {
      const cell = facing(id, PX); // back is -X: the cell at -X must cover its +X face
      expect(mountSticks(cell, slab(B.STONE, EAST), NX)).toBe(true);
      expect(mountSticks(cell, slab(B.STONE, WEST), NX)).toBe(false);
      expect(mountSticks(cell, slab(B.STONE, LOWER), NX)).toBe(false);
      expect(mountSticks(cell, canonCell(slab(B.STONE, LOWER), slab(B.BRICKS, UPPER)), NX)).toBe(true);
    }
  });
});

describe('glue joins two cells only where they touch (SHAPES 10.1 connectedCells)', () => {
  // Stone and bricks never auto-stick: only glue can join them.
  const glue = new GlueStore();
  glue.add(0, 0, 0, PX);
  glue.add(0, 0, 0, PY);

  it('across a side face: a lower slab and a full block, or two lower slabs, are glued in; a lower and an upper slab are not', () => {
    expect(connectedCells(slab(B.STONE, LOWER), c(B.BRICKS), PX, glue, 0, 0, 0)).toBe(true);
    expect(connectedCells(slab(B.STONE, LOWER), slab(B.BRICKS, LOWER), PX, glue, 0, 0, 0)).toBe(true);
    expect(connectedCells(slab(B.STONE, LOWER), slab(B.BRICKS, UPPER), PX, glue, 0, 0, 0)).toBe(false);
    expect(connectedCells(slab(B.STONE, WEST), c(B.BRICKS), PX, glue, 0, 0, 0)).toBe(false); // the stone is on the far half
    // Without the glue nothing joins.
    expect(connectedCells(slab(B.STONE, LOWER), c(B.BRICKS), PZ, glue, 0, 0, 0)).toBe(false);
  });

  it('across the top face: an upper slab under a full block is glued in, a lower slab is not', () => {
    expect(connectedCells(slab(B.STONE, UPPER), c(B.BRICKS), PY, glue, 0, 0, 0)).toBe(true);
    expect(connectedCells(slab(B.STONE, LOWER), c(B.BRICKS), PY, glue, 0, 0, 0)).toBe(false);
    expect(connectedCells(c(B.STONE), slab(B.BRICKS, UPPER), PY, glue, 0, 0, 0)).toBe(false);
    expect(connectedCells(c(B.STONE), slab(B.BRICKS, LOWER), PY, glue, 0, 0, 0)).toBe(true);
  });

  it('connected() on a grid reads both parts of each cell', () => {
    for (const make of HARNESSES) {
      const h = make();
      h.set(0, 0, 0, canonCell(slab(B.STONE, WEST), slab(B.WOOL_RED, EAST)));
      h.set(1, 0, 0, c(B.WOOL_BLUE));
      const [x, y, z] = h.abs(0, 0, 0);
      expect(connected(h.grid, h.glue, x, y, z, PX), h.name).toBe(true); // the wool part touches the wool block
      expect(connected(h.grid, h.glue, x + 1, y, z, NX), h.name).toBe(true);
      h.set(1, 0, 0, c(B.BRICKS));
      expect(connected(h.grid, h.glue, x, y, z, PX), h.name).toBe(false);
      h.glueFace(0, 0, 0, PX);
      expect(connected(h.grid, h.glue, x, y, z, PX), h.name).toBe(true); // glued, and the wool part touches
      h.set(0, 0, 0, slab(B.STONE, WEST));
      h.glueFace(0, 0, 0, PX);
      expect(connected(h.grid, h.glue, x, y, z, PX), h.name).toBe(false); // glued, but nothing touches
    }
  });
});

describe('glueSideAt, glueFaceKept: the state rule (SHAPES 10.2)', () => {
  it('a cell is on a face when it holds glue and has hard material on that face; the unloaded sentinel always is', () => {
    expect(glueSideAt(c(B.STONE), PX)).toBe(true);
    expect(glueSideAt(c(B.AIR), PX)).toBe(false);
    expect(glueSideAt(c(B.TORCH), NY)).toBe(false);
    expect(glueSideAt(CELL_UNLOADED, PX)).toBe(true);
    const west = slab(B.STONE, WEST);
    expect(glueSideAt(west, NX)).toBe(true);
    expect(glueSideAt(west, PX)).toBe(false);
    expect(glueSideAt(west, PY)).toBe(true);
    const corner = slab(B.STONE, 0x01);
    expect(ALL_DIRS.map((d) => glueSideAt(corner, d))).toEqual([false, true, false, true, false, true]);
    expect(glueSideAt(canonCell(slab(B.STONE, WEST), slab(B.BRICKS, EAST)), PX)).toBe(true);
  });

  it('glueFaceKept: one side on the face is enough; full blocks keep the M1 rule', () => {
    expect(glueFaceKept(c(B.STONE), c(B.AIR), PX)).toBe(true);
    expect(glueFaceKept(c(B.AIR), c(B.STONE), PX)).toBe(true);
    expect(glueFaceKept(c(B.AIR), c(B.TORCH), PX)).toBe(false);
    expect(glueFaceKept(slab(B.STONE, WEST), c(B.AIR), PX)).toBe(false); // the slab is on the far half
    expect(glueFaceKept(slab(B.STONE, WEST), slab(B.STONE, EAST), PX)).toBe(false);
    expect(glueFaceKept(slab(B.STONE, LOWER), slab(B.STONE, UPPER), PX)).toBe(true); // both on it, though they do not touch
    expect(glueFaceKept(slab(B.STONE, LOWER), slab(B.STONE, UPPER), PY)).toBe(false);
  });

  it('the contact predicates refuse a getCell value of a two-part cell (the tripwire); the per-id ones accept it', () => {
    const two = canonCell(slab(B.STONE, WEST), slab(B.BRICKS, EAST));
    const cellValue = two % 2 ** 25; // what getCell answers: the first part plus CELL_MULTI_BIT
    expect(cellValue).toBeGreaterThanOrEqual(CELL_MULTI_BIT);
    const glue = new GlueStore();
    expect(() => autoSticks(cellValue, c(B.STONE), PX)).toThrow(RangeError);
    expect(() => autoSticks(c(B.STONE), cellValue, PX)).toThrow(RangeError);
    expect(() => mountSticks(c(B.TORCH), cellValue, NY)).toThrow(RangeError);
    expect(() => sticksWithoutGlue(cellValue, c(B.AIR), PX)).toThrow(RangeError);
    expect(() => connectedCells(cellValue, c(B.STONE), PX, glue, 0, 0, 0)).toThrow(RangeError);
    expect(() => glueSideAt(cellValue, PX)).toThrow(RangeError);
    expect(() => glueFaceKept(c(B.AIR), cellValue, PX)).toThrow(RangeError);
    expect(() => sailVolume8(cellValue)).toThrow(RangeError);
    expect(canGlue(cellValue)).toBe(true);
    expect(holdsGlue(cellValue)).toBe(true);
    expect(isSailCell(cellValue)).toBe(false);
  });
});

describe('sails by volume (SHAPES 11.1 sailVolume8)', () => {
  it('counts the octants of sail material over both parts', () => {
    expect(sailVolume8(c(B.WOOL_RED))).toBe(8);
    expect(sailVolume8(c(B.CANVAS))).toBe(8);
    expect(sailVolume8(c(B.PLANKS_OAK))).toBe(0);
    expect(sailVolume8(c(B.AIR))).toBe(0);
    expect(sailVolume8(slab(B.WOOL_RED, LOWER))).toBe(4);
    expect(sailVolume8(slab(B.CANVAS, 0x80))).toBe(1);
    expect(sailVolume8(slab(B.WOOL_RED, stairFill(PX)))).toBe(6);
    expect(sailVolume8(canonCell(slab(B.WOOL_WHITE, LOWER), slab(B.CANVAS, UPPER)))).toBe(8);
    expect(sailVolume8(canonCell(slab(B.WOOL_WHITE, LOWER), slab(B.PLANKS_OAK, UPPER)))).toBe(4);
    expect(sailVolume8(canonCell(slab(B.STONE, 0x01), slab(B.WOOL_BLUE, 0xfe)))).toBe(7);
    for (let i = 0; i < WOOL_COLORS.length; i++) expect(sailVolume8(slab(B.WOOL_WHITE + i, WEST))).toBe(4);
  });
});

describe('the glue lifetime rules on a grid (pruneGlueAt, pruneGlueInBox)', () => {
  for (const make of HARNESSES) {
    const name = make().name;

    it(`[${name}] lost contact: the chiselled cell stays but no longer touches, so its glue goes (ACCEPTANCE 42)`, () => {
      const h = make();
      h.set(0, 0, 0, c(B.STONE));
      h.set(1, 0, 0, c(B.BRICKS));
      h.glueFace(0, 0, 0, PX);
      const [x, y, z] = h.abs(0, 0, 0);
      const old = getPacked(h.grid, x, y, z);
      // Chiselling one octant of the face: still touching, the glue stays.
      h.grid.setCell(x, y, z, slab(B.STONE, 0xff & ~0x02));
      expect(pruneGlueAt(h.grid, h.glue, x, y, z, old)).toBe(0);
      expect(h.glue.has(x, y, z, PX)).toBe(true);
      // Chiselling the whole +X half: no contact any more; the bricks still hold glue, so the
      // state rule alone would keep it.
      const before = getPacked(h.grid, x, y, z);
      h.grid.setCell(x, y, z, slab(B.STONE, WEST));
      expect(glueFaceKept(getPacked(h.grid, x, y, z), getPacked(h.grid, x + 1, y, z), PX)).toBe(true);
      expect(pruneGlueAt(h.grid, h.glue, x, y, z, before)).toBe(1);
      expect(h.glue.size).toBe(0);
    });

    it(`[${name}] a two-part cell losing the part that touched the glued face loses that glue; losing the other part does not`, () => {
      for (const [removeOctant, kept] of [[1, false], [0, true]] as const) {
        const h = make();
        const two = canonCell(slab(B.STONE, WEST), slab(B.PLANKS_OAK, EAST));
        h.set(0, 0, 0, two);
        h.set(1, 0, 0, c(B.BRICKS));
        h.glueFace(0, 0, 0, PX);
        const [x, y, z] = h.abs(0, 0, 0);
        h.grid.setCell(x, y, z, withoutPartAt(two, removeOctant)); // octant 1 is in the east (planks) part
        pruneGlueAt(h.grid, h.glue, x, y, z, two);
        expect(h.glue.has(x, y, z, PX), `remove octant ${removeOctant}`).toBe(kept);
      }
    });

    it(`[${name}] a cell that becomes air is not "lost contact": the glue stays on the neighbour's face (ACCEPTANCE 27)`, () => {
      const h = make();
      h.set(0, 0, 0, c(B.STONE));
      h.set(1, 0, 0, c(B.BRICKS));
      h.glueFace(0, 0, 0, PX);
      const [x, y, z] = h.abs(0, 0, 0);
      h.grid.setCell(x, y, z, 0);
      expect(pruneGlueAt(h.grid, h.glue, x, y, z, c(B.STONE))).toBe(0);
      expect(h.glue.has(x, y, z, PX)).toBe(true);
      // ... and when the bricks go too, so does the glue.
      h.grid.setCell(x + 1, y, z, 0);
      expect(pruneGlueAt(h.grid, h.glue, x + 1, y, z, c(B.BRICKS))).toBe(1);
    });

    it(`[${name}] a part put across a glued face without touching it removes nothing; a touching part then joins, and chiselling it off removes the glue`, () => {
      const h = make();
      h.set(0, 0, 0, c(B.STONE));
      h.glueFace(0, 0, 0, PX);
      h.glueFace(0, 0, 0, PY);
      const [x, y, z] = h.abs(0, 0, 0);
      // A slab on the far half of the cell across +X, an upper slab in the cell above.
      h.grid.setCell(x + 1, y, z, slab(B.BRICKS, EAST));
      expect(pruneGlueAt(h.grid, h.glue, x + 1, y, z, 0)).toBe(0);
      h.grid.setCell(x, y + 1, z, slab(B.BRICKS, UPPER));
      expect(pruneGlueAt(h.grid, h.glue, x, y + 1, z, 0)).toBe(0);
      expect(h.glue.size).toBe(2);
      expect(connected(h.grid, h.glue, x, y, z, PX)).toBe(false);
      expect(connected(h.grid, h.glue, x, y, z, PY)).toBe(false);
      // A part touching the +X face: the two cells are glued together.
      const east = slab(B.BRICKS, EAST);
      const both = canonCell(slab(B.BRICKS, WEST), east);
      h.grid.setCell(x + 1, y, z, both);
      expect(pruneGlueAt(h.grid, h.glue, x + 1, y, z, east)).toBe(0);
      expect(connected(h.grid, h.glue, x, y, z, PX)).toBe(true);
      // Chiselling that part off again: contact lost, the glue goes.
      h.grid.setCell(x + 1, y, z, east);
      expect(pruneGlueAt(h.grid, h.glue, x + 1, y, z, both)).toBe(1);
      expect(h.glue.has(x, y, z, PX)).toBe(false);
      expect(h.glue.has(x, y, z, PY)).toBe(true);
    });

    it(`[${name}] a lower and an upper slab side by side: glue there stays but does not join; a touching part then joins`, () => {
      const h = make();
      h.set(0, 0, 0, slab(B.STONE, LOWER));
      h.set(1, 0, 0, slab(B.BRICKS, UPPER));
      h.glueFace(0, 0, 0, PX);
      const [x, y, z] = h.abs(0, 0, 0);
      expect(pruneGlueAt(h.grid, h.glue, x, y, z, getPacked(h.grid, x, y, z))).toBe(0);
      expect(pruneGlueAt(h.grid, h.glue, x + 1, y, z, getPacked(h.grid, x + 1, y, z))).toBe(0);
      expect(h.glue.has(x, y, z, PX)).toBe(true);
      expect(connected(h.grid, h.glue, x, y, z, PX)).toBe(false);
      const old = getPacked(h.grid, x + 1, y, z);
      h.grid.setCell(x + 1, y, z, canonCell(slab(B.BRICKS, LOWER), slab(B.BRICKS, UPPER)));
      expect(pruneGlueAt(h.grid, h.glue, x + 1, y, z, old)).toBe(0);
      expect(connected(h.grid, h.glue, x, y, z, PX)).toBe(true);
    });

    it(`[${name}] state rule: a face neither side is on any more loses its glue; pruneGlueInBox applies only the state rule`, () => {
      const h = make();
      h.set(0, 0, 0, c(B.STONE));
      h.glueFace(0, 0, 0, PY);
      const [x, y, z] = h.abs(0, 0, 0);
      h.grid.setCell(x, y, z, slab(B.STONE, LOWER)); // its top is empty now, the cell above is air
      expect(pruneGlueAt(h.grid, h.glue, x, y, z, c(B.STONE))).toBe(1);
      // In a box: a face between two cells that do not touch but are both on it stays (no contact
      // was lost here); a face no side is on goes.
      h.set(3, 0, 0, slab(B.STONE, LOWER));
      h.set(4, 0, 0, slab(B.BRICKS, UPPER));
      h.glueFace(3, 0, 0, PX);
      h.set(3, 2, 0, slab(B.STONE, WEST));
      h.set(4, 2, 0, slab(B.BRICKS, EAST));
      h.glueFace(3, 2, 0, PX);
      const [bx, by, bz] = h.abs(3, 0, 0);
      expect(pruneGlueInBox(h.grid, h.glue, bx, by, bz, bx + 1, by + 2, bz)).toBe(1);
      expect(h.glue.has(bx, by, bz, PX)).toBe(true);
      expect(h.glue.has(bx, by + 2, bz, PX)).toBe(false);
    });
  }
});
