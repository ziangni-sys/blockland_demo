/**
 * Mass data and the contact prober with partial cells (docs/SHAPES.md 12.2, 12.6): a mounted rotor
 * of slabs weighs its volume at its parts' centroids, and the prober names the octant of the cell it
 * found (the part a crush removes) on both of its paths, choosing its exit face on the half grid
 * next to partial cells.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS } from '../../src/blocks/registry';
import { canonCell } from '../../src/blocks/shapes';
import { PY } from '../../src/core/dirs';
import { analyzeHull } from '../../src/structures/hull';
import { Prober } from '../../src/structures/physics/contacts';
import { GridShape } from '../../src/structures/physics/shape';
import { Rotor, Ship } from '../../src/structures/structure';
import { World } from '../../src/voxel/world';
import { LOWER, NORTH, slab, SOUTH, UPPER } from '../shapes';
import { launch, makeSea, newShip, setup, shipBox } from './helpers';

describe('mass of a mounted rotor made of slabs (12.2)', () => {
  it('each part counts density x volume at its centroid; the ship mass and centre follow', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, -1, 47, -1, 1, 47, 1, B.PLANKS_OAK);
    launch(s, dyn);
    const r = new Rotor(50, s.grid);
    r.parent = s;
    r.axis = PY;
    r.grid.pivot.x = 0.5;
    r.grid.pivot.y = 49.5;
    r.grid.pivot.z = 0.5;
    // five upper iron slabs and one cell of two halves (north iron, south wool)
    for (let x = -2; x <= 2; x++) r.grid.setCell(x, 49, 0, slab(B.IRON_BLOCK, UPPER));
    r.grid.setCell(0, 50, 0, canonCell(slab(B.IRON_BLOCK, NORTH), slab(B.WOOL_WHITE, SOUTH)));
    r.grid.setPoseImmediate(r.grid.pivot, r.grid.rotation);
    s.children.push(r);
    dyn.refresh(s);
    const iron = BLOCKS[B.IRON_BLOCK]!.density;
    const wool = BLOCKS[B.WOOL_WHITE]!.density;
    const rotor = 5 * iron * 0.5 + iron * 0.5 + wool * 0.5;
    expect(s.mass).toBeCloseTo(4.5 + rotor, 10);
    // the hub counts at its position: the centre moves up by rotor * (hub - old centre) / total
    const hubY = r.grid.position.y;
    expect(s.grid.pivot.y).toBeCloseTo((4.5 * 47.5 + rotor * hubY) / (4.5 + rotor), 9);
    // a lower-slab rotor of the same material weighs the same, a full-block one twice that of the slabs
    for (let x = -2; x <= 2; x++) r.grid.setCell(x, 49, 0, makeCell(B.IRON_BLOCK));
    dyn.refresh(s);
    expect(s.mass).toBeCloseTo(4.5 + 5 * iron + iron * 0.5 + wool * 0.5, 10);
    for (let x = -2; x <= 2; x++) r.grid.setCell(x, 49, 0, slab(B.IRON_BLOCK, LOWER));
    dyn.refresh(s);
    expect(s.mass).toBeCloseTo(4.5 + rotor, 10);
  });
});

describe('the prober names an octant and works on the half grid next to partial cells (12.6)', () => {
  function shapeOf(fill: (s: Ship) => void): GridShape {
    const s = new Ship(1, new World(0));
    fill(s);
    const g = new GridShape();
    g.build(s.grid, analyzeHull(s.grid), true);
    return g;
  }

  it('in a cell of full blocks only (the M1 path): the octant the point lies in', () => {
    const g = shapeOf((s) => {
      for (let x = 0; x < 3; x++) s.grid.setCell(x, 0, 0, canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_PINE, SOUTH)));
    });
    expect(g.hasPartial).toBe(false);
    const p = new Prober();
    p.setFrame(Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    // a point 0.1 under the top face of cell 1, in its high-x, high-z quarter; no intruder normals
    expect(p.probe(g, 1.8, 0.9, 0.7, 0, 0, 0, 0, false)).toBe(true);
    expect([p.cellX, p.cellY, p.cellZ, p.octant]).toEqual([1, 0, 0, 1 | 2 | 4]);
    expect(p.dir).toBe(2); // out through the top
    expect(p.depth).toBeCloseTo(0.1, 12);
    expect(p.probe(g, 1.2, 0.1, 0.3, 0, 0, 0, 0, false)).toBe(true);
    expect(p.octant).toBe(0);
    expect(p.dir).toBe(3);
  });

  it('next to a partial cell: the faces of the octant count, the empty half is not inside, and the octant is named', () => {
    const g = shapeOf((s) => {
      s.grid.setCell(0, 0, 0, makeCell(B.PLANKS_OAK));
      s.grid.setCell(1, 0, 0, slab(B.PLANKS_OAK, LOWER));
    });
    expect(g.hasPartial).toBe(true);
    const p = new Prober();
    p.setFrame(Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    // in the slab, 0.05 under its top (y = 0.5): out through the half-cell top face
    expect(p.probe(g, 1.3, 0.45, 0.6, 0, 0, 0, 0, false)).toBe(true);
    expect([p.cellX, p.cellY, p.cellZ, p.octant]).toEqual([1, 0, 0, 4]);
    expect(p.dir).toBe(2);
    expect(p.depth).toBeCloseTo(0.05, 12);
    // in the slab's empty upper half: nothing
    expect(p.probe(g, 1.3, 0.55, 0.6, 0, 0, 0, 0, false)).toBe(false);
    // in the full block's upper half, 0.1 from its face towards the slab's empty half: the half-grid
    // face of the full block's octant towards the empty octant is exposed (the M1 algorithm would
    // call the whole +X face buried behind the slab cell)
    expect(p.probe(g, 0.9, 0.8, 0.5, 0, 0, 0, 0, false)).toBe(true);
    expect([p.cellX, p.octant, p.dir]).toEqual([0, 1 | 2 | 4, 0]);
    expect(p.depth).toBeCloseTo(0.1, 12);
    // the same block's lower half, by the slab: its +X face is buried behind the slab's lower half,
    // so the nearest other open face is the exit (the bottom, 0.3 away)
    expect(p.probe(g, 0.9, 0.3, 0.5, 0, 0, 0, 0, true)).toBe(true);
    expect(p.dir).toBe(3);
    expect(p.depth).toBeCloseTo(0.3, 12);
  });

  it('deeper than its octant, it walks back up to 2 * WALK_MAX half cells along the intruder\'s normal', () => {
    // a 3 x 3 x 3 block of planks with a lower slab in place of cell (2, 1, 1)
    const g = shapeOf((s) => {
      for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) s.grid.setCell(x, y, z, makeCell(B.PLANKS_OAK));
      s.grid.setCell(2, 1, 1, slab(B.PLANKS_OAK, LOWER));
    });
    const p = new Prober();
    p.setFrame(Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    // the lower +X octant of the centre cell: all six neighbouring octants are hard (the slab's
    // lower half included); an intruder whose normal is +X came from -X
    expect(p.probe(g, 1.8, 1.2, 1.6, 1 << 0, 0, 0, 0, false)).toBe(false);
    expect(p.probe(g, 1.8, 1.2, 1.6, 1 << 0, 0, 0, 0, true)).toBe(true);
    expect(p.dir).toBe(1);
    expect(p.depth).toBeCloseTo(1.8, 12); // to the block's west face at x = 0, four half cells back
    expect([p.cellX, p.cellY, p.cellZ, p.octant]).toEqual([1, 1, 1, 1 | 4]);
  });
});
