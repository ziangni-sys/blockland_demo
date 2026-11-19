/**
 * The glue lifetime with partial blocks through the StructureManager's change hooks, on the three
 * kinds of grid (docs/SHAPES.md 10.2, the table of effects; ACCEPTANCE 27 and 42): the world, a
 * ship and a rotor. Cells are changed by direct writes (the chisel comes in M2.4); the hooks run
 * pruneGlueAt with the listener's old content on every change, so chiselling the touching material
 * removes the glue while removing a whole block keeps it on the other side. Also: the clean-up when
 * a chunk arrives applies only the state rule, and a rotor's sail count follows chiselling.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, withoutOctant } from '../../src/blocks/shapes';
import { NX, NZ, PX, PY, type Dir } from '../../src/core/dirs';
import type { GlueStore } from '../../src/structures/glue';
import type { Rotor } from '../../src/structures/structure';
import { connected } from '../../src/structures/stick';
import { Chunk, cellIndex } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { getPacked } from '../../src/voxel/parts';
import { EAST, LOWER, slab, UPPER, WEST } from '../shapes';
import { c, facing, fill, scene, windmill, type Scene } from './helpers';

interface Grid {
  name: string;
  s: Scene;
  grid: VoxelGrid;
  glue: GlueStore;
  /** Write a cell at scenario coordinates (relative to an empty spot of the grid). */
  set(x: number, y: number, z: number, packed: number): void;
  get(x: number, y: number, z: number): number;
  glueFace(x: number, y: number, z: number, d: Dir): void;
  has(x: number, y: number, z: number, d: Dir): boolean;
  joined(x: number, y: number, z: number, d: Dir): boolean;
}

/** An empty spot of `grid` (local coordinates) for the scenarios. */
const O = { x: 6, y: 70, z: 6 };

function wrap(name: string, s: Scene, grid: VoxelGrid, glue: GlueStore): Grid {
  return {
    name,
    s,
    grid,
    glue,
    set: (x, y, z, p) => void grid.setCell(O.x + x, O.y + y, O.z + z, p),
    get: (x, y, z) => getPacked(grid, O.x + x, O.y + y, O.z + z),
    glueFace: (x, y, z, d) => void glue.add(O.x + x, O.y + y, O.z + z, d),
    has: (x, y, z, d) => glue.has(O.x + x, O.y + y, O.z + z, d),
    joined: (x, y, z, d) => connected(grid, glue, O.x + x, O.y + y, O.z + z, d),
  };
}

function worldGrid(): Grid {
  const s = scene();
  return wrap('world', s, s.world, s.host.worldGlue);
}

function shipGrid(): Grid {
  const s = scene();
  fill(s.world, -1, 60, -1, 1, 60, 1, c(B.PLANKS_OAK));
  s.world.setCell(0, 61, 0, facing(B.HELM, 5));
  const r = s.mgr.assembleShip(0, 61, 0);
  if (!r.ok) throw new Error(r.reason);
  return wrap('ship', s, r.structure.grid, r.structure.glue);
}

function rotorGrid(): Grid & { rotor: Rotor } {
  const s = scene();
  windmill(s.world, 0, 65, 0, 1); // hub + 4 felt arms: 5 sails
  const r = s.mgr.startRotor(s.world, 0, 65, 0);
  if (!r.ok) throw new Error(r.reason);
  return { ...wrap('rotor', s, r.structure.grid, r.structure.glue), rotor: r.structure };
}

const GRIDS: ReadonlyArray<() => Grid> = [worldGrid, shipGrid, rotorGrid];

// Stone and bricks never auto-stick: only glue can join them.
const STONE = makeCell(B.STONE);
const BRICKS = makeCell(B.BRICKS);

describe('the table of effects (SHAPES 10.2) on the world, a ship and a rotor', () => {
  for (const make of GRIDS) {
    const name = make().name;

    it(`[${name}] two glued full blocks, one removed: the glue stays on the other's face; both removed: gone (ACCEPTANCE 27)`, () => {
      const g = make();
      g.set(0, 0, 0, STONE);
      g.set(1, 0, 0, BRICKS);
      g.glueFace(0, 0, 0, PX);
      g.set(0, 0, 0, 0);
      expect(g.has(0, 0, 0, PX)).toBe(true);
      g.set(0, 0, 0, STONE); // put back against the glued face: joined again
      expect(g.joined(0, 0, 0, PX)).toBe(true);
      g.set(0, 0, 0, 0);
      g.set(1, 0, 0, 0);
      expect(g.has(0, 0, 0, PX)).toBe(false);
    });

    it(`[${name}] chiselling the touching material of one of two glued blocks removes the glue, though the block stays (ACCEPTANCE 42)`, () => {
      const g = make();
      g.set(0, 0, 0, STONE);
      g.set(1, 0, 0, BRICKS);
      g.glueFace(0, 0, 0, PX);
      g.set(0, 0, 0, withoutOctant(STONE, 1)); // one octant of the face: still touching
      expect(g.has(0, 0, 0, PX)).toBe(true);
      expect(g.joined(0, 0, 0, PX)).toBe(true);
      for (const o of [3, 5, 7]) g.set(0, 0, 0, withoutOctant(g.get(0, 0, 0), o)); // the rest of the +X half
      expect(g.get(0, 0, 0)).toBe(slab(B.STONE, WEST));
      expect(g.has(0, 0, 0, PX)).toBe(false);
      expect(g.joined(0, 0, 0, PX)).toBe(false);
    });

    it(`[${name}] a two-part cell: removing the part against the glued face removes the glue, removing the other part keeps it`, () => {
      for (const [keep, kept] of [[slab(B.STONE, WEST), false], [slab(B.PLANKS_OAK, EAST), true]] as const) {
        const g = make();
        g.set(0, 0, 0, canonCell(slab(B.STONE, WEST), slab(B.PLANKS_OAK, EAST)));
        g.set(1, 0, 0, BRICKS);
        g.glueFace(0, 0, 0, PX);
        g.set(0, 0, 0, keep);
        expect(g.has(0, 0, 0, PX), `keeping ${keep}`).toBe(kept);
      }
    });

    it(`[${name}] a part put across a glued face without touching it keeps the glue; a touching part joins; chiselling it off removes the glue`, () => {
      const g = make();
      g.set(0, 0, 0, STONE);
      g.glueFace(0, 0, 0, PX);
      g.glueFace(0, 0, 0, PY);
      g.set(1, 0, 0, slab(B.BRICKS, EAST)); // far half of the cell across +X
      g.set(0, 1, 0, slab(B.BRICKS, UPPER)); // upper slab in the cell above
      expect(g.has(0, 0, 0, PX)).toBe(true);
      expect(g.has(0, 0, 0, PY)).toBe(true);
      expect(g.joined(0, 0, 0, PX)).toBe(false);
      expect(g.joined(0, 0, 0, PY)).toBe(false);
      g.set(1, 0, 0, canonCell(slab(B.BRICKS, WEST), slab(B.BRICKS, EAST))); // now touching
      expect(g.joined(0, 0, 0, PX)).toBe(true);
      g.set(1, 0, 0, slab(B.BRICKS, EAST)); // chiselled apart again
      expect(g.has(0, 0, 0, PX)).toBe(false);
      expect(g.has(0, 0, 0, PY)).toBe(true);
    });

    it(`[${name}] a lower and an upper slab side by side: glue between them stays without joining; a touching part then joins`, () => {
      const g = make();
      g.set(0, 0, 0, slab(B.STONE, LOWER));
      g.set(1, 0, 0, slab(B.BRICKS, UPPER));
      g.glueFace(1, 0, 0, NX);
      g.set(1, 0, 0, slab(B.PLANKS_OAK, UPPER)); // the cell changes, still not touching: no contact to lose
      expect(g.has(0, 0, 0, PX)).toBe(true);
      expect(g.joined(0, 0, 0, PX)).toBe(false);
      g.set(1, 0, 0, canonCell(slab(B.BRICKS, LOWER), slab(B.PLANKS_OAK, UPPER)));
      expect(g.joined(0, 0, 0, PX)).toBe(true);
    });
  }

  it('[rotor] the sail count follows the volume: a felt cell chiselled down to a slab is half a sail less, and back', () => {
    const g = rotorGrid() as Grid & { rotor: Rotor };
    const rotor = g.rotor;
    expect(rotor.sails).toBe(5);
    const arm = [1, 65, 1] as const; // a felt arm cell (local = world coordinates at the start)
    const felt = getPacked(rotor.grid, ...arm);
    rotor.grid.setCell(...arm, withoutOctant(felt, 7));
    expect(rotor.sails).toBe(5 - 1 / 8);
    rotor.grid.setCell(...arm, slab(B.WOOL_RED, LOWER));
    expect(rotor.sails).toBe(4.5);
    rotor.grid.setCell(...arm, canonCell(slab(B.WOOL_RED, LOWER), slab(B.PLANKS_OAK, UPPER)));
    expect(rotor.sails).toBe(4.5);
    rotor.grid.setCell(...arm, canonCell(slab(B.WOOL_RED, LOWER), slab(B.CANVAS, UPPER)));
    expect(rotor.sails).toBe(5);
    rotor.grid.setCell(...arm, 0);
    expect(rotor.sails).toBe(4);
  });
});

describe('glue left behind by an assembly (SHAPES 11.2)', () => {
  it('a glued face towards a cell that stays but is not on the face goes when the moved cell leaves; one the staying cell is on stays', () => {
    const s = scene();
    fill(s.world, -1, 60, -1, 1, 60, 1, c(B.PLANKS_OAK));
    s.world.setCell(0, 61, 0, facing(B.HELM, 5));
    // East and west of the deck: bricks slabs on the far half, behind glued deck faces (not on the
    // faces, so not glued in).
    s.world.setCell(2, 60, 0, slab(B.BRICKS, EAST));
    s.host.worldGlue.add(1, 60, 0, PX);
    s.world.setCell(-2, 60, 0, slab(B.BRICKS, WEST));
    s.host.worldGlue.add(-1, 60, 0, NX);
    // North: a full stone block behind a glued face (stone never sticks to planks; the glue joins them).
    s.world.setCell(0, 60, -2, STONE);
    s.host.worldGlue.add(0, 60, -1, NZ);
    const r = s.mgr.assembleShip(0, 61, 0);
    if (!r.ok) throw new Error(r.reason);
    const ship = r.structure;
    expect(ship.grid.count).toBe(9 + 1 + 1); // deck, helm, the stone glued on
    expect(getPacked(ship.grid, 0, 60, -2)).toBe(STONE);
    expect(ship.glue.has(0, 60, -1, NZ)).toBe(true); // travelled with both cells
    // The faces towards the far-half slabs stayed in the world (the slabs hold glue) and were then
    // cleaned by the world's hook: nothing is on them any more.
    expect(s.host.worldGlue.has(1, 60, 0, PX)).toBe(false);
    expect(s.host.worldGlue.has(-1, 60, 0, NX)).toBe(false);
    expect(s.host.worldGlue.size).toBe(0);
    expect(getPacked(s.world, 2, 60, 0)).toBe(slab(B.BRICKS, EAST));
  });
});

/** A chunk whose cells are air except the given (chunk-local) cells, each a part value (holes allowed). */
function chunkWithParts(cx: number, cz: number, cells: Array<[number, number, number, number]>): Chunk {
  const base = new Uint16Array(16 * 16 * 128);
  const holes = new Uint8Array(16 * 16 * 128);
  for (const [lx, y, lz, part] of cells) {
    base[cellIndex(lx, y, lz)] = part & 0xffff;
    holes[cellIndex(lx, y, lz)] = (part >>> 16) & 0xff;
  }
  return new Chunk(cx, cz, base, undefined, holes, null);
}

describe('when a chunk arrives only the state rule applies (SHAPES 10.2)', () => {
  it('glue towards an unloaded column is kept; the column loads: kept when a side is on the face, touching or not; removed when none is', () => {
    const lower = slab(B.STONE, LOWER); // on the +X face (its lower half)
    const westLower = slab(B.STONE, LOWER & WEST); // not on the +X face
    const cases: Array<[string, number, number, boolean]> = [
      ['a lower slab beside air', lower, 0, true],
      ['a lower slab beside an upper slab (both on the face, not touching)', lower, slab(B.BRICKS, UPPER), true],
      ['a slab off the face beside air', westLower, 0, false],
      ['a slab off the face beside a slab off the face', westLower, slab(B.BRICKS, EAST), false],
      ['a slab off the face beside a slab on the face', westLower, slab(B.BRICKS, WEST), true],
    ];
    for (const [what, near, across, kept] of cases) {
      const s = scene(); // chunks loaded for x in -32..31
      const g = s.host.worldGlue;
      s.world.setCell(31, 70, 0, near);
      g.add(31, 70, 0, PX); // towards the unloaded column x = 32 (the sentinel counts as on the face)
      s.world.setCell(31, 71, 0, STONE); // an unrelated change nearby leaves it alone
      expect(g.has(31, 70, 0, PX), `${what}: kept while the other side is unloaded`).toBe(true);
      s.world.addChunk(chunkWithParts(2, 0, across === 0 ? [] : [[0, 70, 0, across]]));
      expect(g.has(31, 70, 0, PX), what).toBe(kept);
    }
  });

  it('a block chiselled off the face while its neighbour is unloaded loses the glue whatever the column holds', () => {
    // From covering the face fully to covering none: either nothing is on the face any more, or
    // the neighbour is on it and the block stopped touching it. Both remove the glue.
    const s = scene();
    const g = s.host.worldGlue;
    s.world.setCell(31, 70, 0, STONE);
    g.add(31, 70, 0, PX);
    s.world.setCell(31, 70, 0, slab(B.STONE, WEST));
    expect(g.has(31, 70, 0, PX)).toBe(false);
  });
});
