/**
 * The contact generator next to partial cells (docs/SHAPES.md 12.6), one direction at a time.
 * Contacts are generated both ways (points of A in B, points of B in A), so a scene alone does not
 * show that one of the four point-in-cell tests handles partial cells: here each test looks for the
 * contact of one known point, inside a hard octant of a partial cell, by its position.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { PY } from '../../src/core/dirs';
import { quat } from '../../src/core/math';
import { Body } from '../../src/structures/physics/body';
import * as CR from '../../src/structures/physics/contacts';
import { ContactGenerator, ContactSet } from '../../src/structures/physics/contacts';
import { refreshShip } from '../../src/structures/physics/massprops';
import { resolveOptions } from '../../src/structures/physics/options';
import { RotorView } from '../../src/structures/physics/rotorview';
import { Rotor, Ship } from '../../src/structures/structure';
import type { World } from '../../src/voxel/world';
import { LOWER, slab, UPPER } from '../shapes';
import { makeWorld } from './helpers';

const O = resolveOptions(undefined);

/** A body for a ship whose cells are written by `fill`, its pose set so that local = world + (0, dy, 0). */
function bodyOf(world: World, id: number, fill: (s: Ship) => void, dy = 0, index = 0): Body {
  const s = new Ship(id, world);
  fill(s);
  const g = s.grid;
  g.setPoseImmediate(g.pivot, quat());
  const b = new Body(s);
  refreshShip(s, b, O);
  g.position.y += dy;
  b.loadPose();
  b.index = index;
  return b;
}

/** Contacts of a set whose point is (x, y, z) (to 1e-9). */
function at(set: ContactSet, x: number, y: number, z: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < set.count; i++) {
    const c = i * CR.STRIDE;
    const f = set.f;
    if (Math.abs(f[c + CR.F_PX]! - x) < 1e-9 && Math.abs(f[c + CR.F_PX + 1]! - y) < 1e-9 && Math.abs(f[c + CR.F_PX + 2]! - z) < 1e-9) out.push(c);
  }
  return out;
}

describe('one direction at a time', () => {
  it('ship points inside a partial cell of another ship: the bottom of a block in the slab of a ship under it', () => {
    const world = makeWorld({ cx0: -1, cx1: 0, cz0: -1, cz1: 0, waterTop: 0, floorTop: 1 });
    // A: a block at local (0, 10, 0); B: an upper slab at local (0, 9, 0), lifted 0.1 into A's bottom
    const a = bodyOf(world, 1, (s) => s.grid.setCell(0, 10, 0, makeCell(B.PLANKS_OAK)), 0, 0);
    const b = bodyOf(world, 2, (s) => s.grid.setCell(0, 9, 0, slab(B.PLANKS_OAK, UPPER)), 0.1, 1);
    expect(b.shape.hasPartial).toBe(true);
    const set = new ContactSet();
    new ContactGenerator().ships(a, b, set, 0.5);
    // A's bottom face centre (0.5, 10, 0.5) lies in B's hard upper octants (9.6 .. 10.1): pushed up
    const cs = at(set, 0.5, 10, 0.5);
    expect(cs).toHaveLength(1);
    expect(set.f[cs[0]! + CR.F_A]).toBe(a.index);
    expect(set.f[cs[0]! + CR.F_NX + 1]).toBe(1);
    expect(set.f[cs[0]! + CR.F_DEPTH]).toBeCloseTo(0.1, 9);
  });

  it('terrain corners inside a partial hull cell: a step corner in the slab of a hull resting on it', () => {
    const world = makeWorld({ cx0: -1, cx1: 0, cz0: -1, cz1: 0, waterTop: 0, floorTop: 10 });
    // a stone step one cell high at x >= 0 (its edge at x = 0, y = 11 is a terrain corner line)
    for (let x = 0; x <= 8; x++) for (let z = -8; z <= 8; z++) world.setCell(x, 10, z, makeCell(B.STONE));
    // a hull of two lower slabs at local (-1, 11, 0) and (0, 11, 0), lowered by 0.2: their hard
    // octants span world y 10.8 .. 11.3, so the step's top edge (x = 0, y = 11) runs through them
    const b = bodyOf(world, 1, (s) => {
      s.grid.setCell(-1, 11, 0, slab(B.PLANKS_OAK, LOWER));
      s.grid.setCell(0, 11, 0, slab(B.PLANKS_OAK, LOWER));
    }, -0.2);
    b.patch.fill(world, -6, 5, -6, 6, 16, 6);
    b.patch.collectCorners(-3, 8, -3, 3, 13, 3);
    b.selectTerrainCandidates(1.6);
    const set = new ContactSet();
    new ContactGenerator().terrain(b, set, 0.5);
    // the corner (0, 11, 0) of the step lies in the slab of cell (0, 11, 0): hard octant 0 (10.8 .. 11.3)
    const cs = at(set, 0, 11, 0);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) expect(set.f[c + CR.F_A]).toBe(b.index);
  });

  it('hull points inside a partial rotor cell, and rotor points inside a partial hull cell', () => {
    const world = makeWorld({ cx0: -1, cx1: 0, cz0: -1, cz1: 0, waterTop: 0, floorTop: 1 });
    for (const rotorPartial of [true, false]) {
      // a rotor of one cell at (0, 10, 0) about +Y through its centre: a lower slab or a block
      const r = new Rotor(50, world);
      r.axis = PY;
      r.grid.pivot.x = 0.5;
      r.grid.pivot.y = 10.5;
      r.grid.pivot.z = 0.5;
      r.grid.setCell(0, 10, 0, rotorPartial ? slab(B.CANVAS, LOWER) : makeCell(B.CANVAS));
      r.grid.setPoseImmediate(r.grid.pivot, quat());
      const rv = new RotorView(r);
      rv.beginTick();
      rv.attachParent(null);
      rv.updateFrames(0, 1);
      // the hull: a block (rotor partial) or an upper slab (rotor full) at (0, 9, 0), lifted into the rotor cell's bottom
      const hull = bodyOf(world, 1, (s) => s.grid.setCell(0, 9, 0, rotorPartial ? makeCell(B.PLANKS_OAK) : slab(B.PLANKS_OAK, UPPER)), 0.2);
      const set = new ContactSet();
      new ContactGenerator().rotor(hull, rv, 0, set, 0.5, 1 / 0.00625);
      if (rotorPartial) {
        // the hull's top face centre (0.5, 10.2, 0.5) is in the rotor slab's hard lower octants
        const cs = at(set, 0.5, 10.2, 0.5);
        expect(cs).toHaveLength(1);
        expect(set.f[cs[0]! + CR.F_HASCELL]).toBe(2);
      } else {
        // the rotor block's bottom face centre (0.5, 10, 0.5) is in the hull slab's hard upper octants (9.7 .. 10.2)
        const cs = at(set, 0.5, 10, 0.5);
        expect(cs).toHaveLength(1);
        expect(set.f[cs[0]! + CR.F_HASCELL]).toBe(1);
        expect([set.f[cs[0]! + CR.F_CELL], set.f[cs[0]! + CR.F_CELL + 1], set.f[cs[0]! + CR.F_CELL + 2]]).toEqual([0, 9, 0]);
      }
    }
  });
});
