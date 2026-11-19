/**
 * The collision and buoyancy view of a grid with partial cells (docs/SHAPES.md 12.4, 12.5):
 * occupancy codes and octant masks, the two passes of sample points, half-cube displacement and
 * the owner of a pinned point.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { solidFill } from '../../src/blocks/shapes';
import { Rng } from '../../src/core/rng';
import { analyzeHull, hullKindAt, hullOctantKind, HULL_SEALED } from '../../src/structures/hull';
import { GridShape, nearestOwnerCell, OCC_OPEN, OCC_PARTIAL, OCC_SEALED, OCC_SOLID } from '../../src/structures/physics/shape';
import { Ship } from '../../src/structures/structure';
import { getPacked } from '../../src/voxel/parts';
import { World } from '../../src/voxel/world';
import { addHelm, bigShip, makeSea, newShip as newSeaShip, shipBox } from './helpers';
import { LOWER, slab, UPPER } from '../shapes';
import { boatOf, randomCell } from './shapes-helpers';

const P = makeCell(B.PLANKS_OAK);

function shapeOf(s: Ship, bilgeDry = true): GridShape {
  const h = analyzeHull(s.grid);
  const g = new GridShape();
  g.build(s.grid, h, bilgeDry);
  return g;
}

function newShip(): Ship {
  return new Ship(1, new World(0));
}

/** Directions of exposed faces of hard octants around half-lattice point (hx, hy, hz). */
function exposure(g: GridShape, hx: number, hy: number, hz: number): { hard: number; open: number; mask: number } {
  let hard = 0;
  let open = 0;
  let mask = 0;
  for (let k = 0; k < 8; k++) {
    const ax = hx - 1 + (k & 1);
    const ay = hy - 1 + ((k >> 1) & 1);
    const az = hz - 1 + (k >> 2);
    if (g.isSolidHalf(ax, ay, az)) {
      hard++;
      // neighbours around the point along each axis
      const nx = ax === hx - 1 ? ax + 1 : ax - 1;
      const ny = ay === hy - 1 ? ay + 1 : ay - 1;
      const nz = az === hz - 1 ? az + 1 : az - 1;
      if (g.isOpenHalf(nx, ay, az)) mask |= 1 << (nx > ax ? 0 : 1);
      if (g.isOpenHalf(ax, ny, az)) mask |= 1 << (ny > ay ? 2 : 3);
      if (g.isOpenHalf(ax, ay, nz)) mask |= 1 << (nz > az ? 4 : 5);
    } else if (g.isOpenHalf(ax, ay, az)) {
      open++;
    }
  }
  return { hard, open, mask };
}

describe('occupancy (12.4)', () => {
  it('occ, the hard-octant masks and the sealed masks equal solidFill(getPacked) and the hull kinds (random grids)', () => {
    const rng = new Rng(21);
    let partial = 0;
    for (let trial = 0; trial < 30; trial++) {
      const s = newShip();
      for (let y = 0; y < 4; y++) for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) s.grid.setCell(x, y, z, randomCell(rng, 0.3, 0.4, 0.1));
      if (s.grid.count === 0) continue;
      const h = analyzeHull(s.grid)!;
      const g = new GridShape();
      g.build(s.grid, h, true);
      let solidCells = 0;
      for (let y = g.oy - 1; y <= g.oy + g.sy; y++) {
        for (let z = g.oz - 1; z <= g.oz + g.sz; z++) {
          for (let x = g.ox - 1; x <= g.ox + g.sx; x++) {
            const f = solidFill(getPacked(s.grid, x, y, z));
            const c = g.occAt(x, y, z);
            if (f === 0xff) expect(c).toBe(OCC_SOLID);
            else if (f !== 0) {
              expect(c).toBe(OCC_PARTIAL);
              partial++;
            } else expect(c).toBe(hullKindAt(h, x, y, z) === HULL_SEALED ? OCC_SEALED : OCC_OPEN);
            if (f !== 0) solidCells++;
            expect(g.isSolid(x, y, z)).toBe(f === 0xff);
            expect(g.isPartial(x, y, z)).toBe(f !== 0 && f !== 0xff);
            for (let o = 0; o < 8; o++) {
              const hx = 2 * x + (o & 1);
              const hy = 2 * y + ((o >> 1) & 1);
              const hz = 2 * z + (o >> 2);
              const hard = ((f >> o) & 1) !== 0;
              expect(g.isSolidHalf(hx, hy, hz)).toBe(hard);
              expect(g.isOpenHalf(hx, hy, hz)).toBe(!hard && hullOctantKind(h, x, y, z, o) !== HULL_SEALED);
            }
          }
        }
      }
      expect(g.solidCount).toBe(solidCells);
      expect(g.hasPartial).toBe(partial > 0 || g.hasPartial);
    }
    expect(partial).toBeGreaterThan(100);
  });

  it('a ship of slabs only is not empty: it has hard cells and bounds', () => {
    const s = newShip();
    s.grid.setCell(2, 3, 4, slab(B.PLANKS_OAK, UPPER));
    const g = shapeOf(s);
    expect(g.solidCount).toBe(1);
    expect([g.minX, g.minY, g.minZ, g.maxX, g.maxY, g.maxZ]).toEqual([2, 3, 4, 3, 4, 5]);
    expect(g.hasPartial).toBe(true);
  });

  it('a ship of full blocks allocates no octant masks', () => {
    const g = shapeOf(boatOf(new World(0), 1, 0, 0, 0, 5, 5, 3, P));
    expect(g.hasPartial).toBe(false);
    expect(g.solidMask.length).toBe(0);
    expect(g.sealedMask.length).toBe(0);
  });
});

describe('sample points (12.4)', () => {
  it('ships of full blocks keep their M1 point counts (open hold 16258, sealed bigShip 5322)', () => {
    const world = makeSea();
    const open = newSeaShip(world, 1);
    shipBox(open, -30, 43, -28, 29, 45, 29, B.PLANKS_OAK, true);
    addHelm(open, 0, 44, 27, 5);
    expect(open.grid.count).toBe(3945);
    expect(shapeOf(open, true).pointCount).toBe(16258);
    const big = bigShip(world, 2, 50, 16, 8, 3500, 46, 0);
    expect(shapeOf(big, true).pointCount).toBe(5322);
  });

  it('a lower slab: 9 points on its top face (a unit face has 5), 18 in all, with the right normals', () => {
    const s = newShip();
    s.grid.setCell(0, 0, 0, slab(B.PLANKS_OAK, LOWER));
    const g = shapeOf(s);
    expect(g.pointCount).toBe(18);
    let top = 0;
    for (let i = 0; i < g.pointCount; i++) {
      if (g.py[i] === 0.5) {
        top++;
        expect(g.pmask[i]! & (1 << 2)).not.toBe(0); // +Y
        expect(g.pmask[i]! & (1 << 3)).toBe(0);
      } else {
        expect(g.py[i]).toBe(0);
        expect(g.pmask[i]! & (1 << 3)).not.toBe(0); // -Y
      }
    }
    expect(top).toBe(9);
    // the corner (1, 0.5, 1) carries +X, +Y and +Z
    let found = false;
    for (let i = 0; i < g.pointCount; i++) if (g.px[i] === 1 && g.py[i] === 0.5 && g.pz[i] === 1) found = g.pmask[i] === (1 | 4 | 16);
    expect(found).toBe(true);
  });

  it('every point lies on the exposed surface and its mask equals the normals of the exposed faces through it (random grids)', () => {
    const rng = new Rng(3);
    for (let trial = 0; trial < 25; trial++) {
      const s = newShip();
      for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) s.grid.setCell(x, y, z, randomCell(rng, 0.3, 0.4, 0.1));
      if (s.grid.count === 0) continue;
      const g = shapeOf(s);
      const seen = new Set<string>();
      for (let i = 0; i < g.pointCount; i++) {
        const hx = g.px[i]! * 2;
        const hy = g.py[i]! * 2;
        const hz = g.pz[i]! * 2;
        const key = `${hx},${hy},${hz}`;
        // half-lattice points, no duplicates
        expect(Number.isInteger(hx) && Number.isInteger(hy) && Number.isInteger(hz)).toBe(true);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        const e = exposure(g, hx, hy, hz);
        expect(e.hard).toBeGreaterThan(0);
        expect(e.open).toBeGreaterThan(0);
        // Equal, not just a subset: a point that lacks the normal of a face it lies on can only be
        // pushed out through its other faces (a pass-2 point on the edge of a pass-1 unit face
        // used to lack that face's normal, and a raft on a kerb was shoved sideways).
        expect(e.mask).not.toBe(0);
        expect(g.pmask[i]).toBe(e.mask);
      }
    }
  });

  it('a full block beside an upper slab: the exposed lower half of the face towards the slab has its points, with +X', () => {
    // pass 1 skips the full cell's +X face (its neighbour is partial); pass 2 must cover its
    // exposed lower half, or that half of the face has no points at all
    const s = newShip();
    s.grid.setCell(0, 0, 0, P);
    s.grid.setCell(1, 0, 0, slab(B.PLANKS_OAK, UPPER));
    const g = shapeOf(s);
    const at = new Map<string, number>();
    for (let i = 0; i < g.pointCount; i++) at.set(`${g.px[i]},${g.py[i]},${g.pz[i]}`, g.pmask[i]!);
    for (const y of [0, 0.5]) {
      for (const z of [0, 0.5, 1]) {
        const m = at.get(`1,${y},${z}`);
        expect(m).toBeDefined();
        expect(m! & 1).toBe(1); // +X
      }
    }
    // the upper half of that face is covered by the slab: the point on its top edge (shared by the
    // two top faces) carries +Y only
    expect(at.get('1,1,0.5')).toBe(1 << 2);
  });

  it('every exposed quarter face next to a partial cell has its 4 corners as points carrying its normal (random grids)', () => {
    const rng = new Rng(29);
    let faces = 0;
    for (let trial = 0; trial < 25; trial++) {
      const s = newShip();
      for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) s.grid.setCell(x, y, z, randomCell(rng, 0.3, 0.4, 0.1));
      if (s.grid.count === 0) continue;
      const g = shapeOf(s);
      const at = new Map<string, number>();
      for (let i = 0; i < g.pointCount; i++) at.set(`${g.px[i]! * 2},${g.py[i]! * 2},${g.pz[i]! * 2}`, g.pmask[i]!);
      for (let y = g.oy; y < g.oy + g.sy; y++) {
        for (let z = g.oz; z < g.oz + g.sz; z++) {
          for (let x = g.ox; x < g.ox + g.sx; x++) {
            for (let o = 0; o < 8; o++) {
              const h = [2 * x + (o & 1), 2 * y + ((o >> 1) & 1), 2 * z + (o >> 2)] as const;
              if (!g.isSolidHalf(h[0], h[1], h[2])) continue;
              for (let d = 0; d < 6; d++) {
                const a = d >> 1;
                const step = (d & 1) === 0 ? 1 : -1;
                const n = [h[0], h[1], h[2]];
                n[a] = n[a]! + step;
                if (!g.isOpenHalf(n[0]!, n[1]!, n[2]!)) continue;
                const near = g.isPartial(x, y, z) || g.isPartial(n[0]! >> 1, n[1]! >> 1, n[2]! >> 1);
                if (!near) continue; // a unit face of pass 1: corners and centre only
                faces++;
                const u = (a + 1) % 3;
                const v = (a + 2) % 3;
                for (let k = 0; k < 4; k++) {
                  const c = [h[0], h[1], h[2]];
                  c[a] = c[a]! + ((d & 1) === 0 ? 1 : 0);
                  c[u] = c[u]! + (k & 1);
                  c[v] = c[v]! + (k >> 1);
                  const m = at.get(`${c[0]},${c[1]},${c[2]}`);
                  expect(m).toBeDefined();
                  expect((m! >> d) & 1).toBe(1);
                }
              }
            }
          }
        }
      }
    }
    expect(faces).toBeGreaterThan(500);
  });

  it('every partial cell adds at most 27 points (its 3 x 3 x 3 half-lattice points) to the ship of full blocks it was carved from', () => {
    const rng = new Rng(17);
    for (let trial = 0; trial < 30; trial++) {
      const s = boatOf(new World(0), 1, 0, 0, 0, rng.int(3, 7), rng.int(3, 7), rng.int(2, 4), P);
      const n0 = shapeOf(s).pointCount;
      const cells: Array<[number, number, number]> = [];
      s.grid.forEachCell((x, y, z) => cells.push([x, y, z]));
      const k = rng.int(1, Math.min(8, cells.length));
      for (let j = 0; j < k; j++) {
        const [x, y, z] = cells[rng.int(0, cells.length - 1)]!;
        s.grid.setCell(x, y, z, slab(B.PLANKS_OAK, rng.int(1, 254)));
      }
      let partials = 0;
      s.grid.forEachCell((_x, _y, _z, c) => {
        const f = solidFill(c);
        if (f !== 0 && f !== 0xff) partials++;
      });
      expect(shapeOf(s).pointCount).toBeLessThanOrEqual(n0 + 27 * partials);
    }
  });

  it('faces towards sealed octants carry no points (a cabin roofed with upper slabs)', () => {
    const s = newShip();
    for (let y = 0; y <= 3; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          const wall = y === 0 || x === 0 || z === 0 || x === 4 || z === 4;
          if (wall) s.grid.setCell(x, y, z, P);
          else if (y === 3) s.grid.setCell(x, y, z, slab(B.PLANKS_OAK, UPPER));
        }
      }
    }
    const g = shapeOf(s);
    for (let i = 0; i < g.pointCount; i++) {
      const inside = g.px[i]! > 1 && g.px[i]! < 4 && g.pz[i]! > 1 && g.pz[i]! < 4 && g.py[i]! > 1 && g.py[i]! < 4;
      expect(inside).toBe(false);
    }
    // the roof's top is exposed: points at y = 4 over the cabin
    let roof = 0;
    for (let i = 0; i < g.pointCount; i++) if (g.py[i] === 4 && g.px[i]! > 1 && g.px[i]! < 4) roof++;
    expect(roof).toBeGreaterThan(0);
  });

  it('is deterministic: two builds give the same points in the same order', () => {
    const rng = new Rng(9);
    const s = newShip();
    for (let y = 0; y < 4; y++) for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) s.grid.setCell(x, y, z, randomCell(rng));
    const a = shapeOf(s);
    const b = shapeOf(s);
    expect(Array.from(a.px)).toEqual(Array.from(b.px));
    expect(Array.from(a.py)).toEqual(Array.from(b.py));
    expect(Array.from(a.pz)).toEqual(Array.from(b.pz));
    expect(Array.from(a.pmask)).toEqual(Array.from(b.pmask));
  });
});

describe('displacement (12.5)', () => {
  it('cells displacing as a whole are unit cubes, the other displacing octants half cubes; dispVolume is the hull volume', () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 5, 5, 3, P, slab(B.PLANKS_OAK, LOWER));
    const h = analyzeHull(s.grid)!;
    const g = new GridShape();
    g.build(s.grid, h, true);
    // unit cubes: full planks cells (floor 25, walls one course 16) + the bilge hold below the rim (9)
    expect(g.dispCount).toBe(25 + 16 + 9);
    // half cubes: the rim (16 cells x 4 lower octants) and the hold's lower halves at the rim layer (9 x 4)
    expect(g.halfCount).toBe(16 * 4 + 9 * 4);
    expect(g.dispVolume).toBe(g.dispCount + g.halfCount / 8);
    expect(g.dispVolume).toBe(h.maxDisplacement);
    for (let i = 0; i < g.halfCount; i++) {
      expect((g.hcx[i]! * 4) % 2).toBe(1); // octant centres: x.25 or x.75
      expect(g.hcy[i]).toBe(12.25);
    }
    // a flooded bilge (the ship cannot float) displaces nothing
    g.build(s.grid, h, false);
    expect(g.dispCount).toBe(25 + 16);
    expect(g.halfCount).toBe(16 * 4);
  });

  it('a cell whose hard and sealed octants make it whole is one unit cube', () => {
    const s = newShip();
    for (let y = 0; y <= 3; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          const wall = y === 0 || x === 0 || z === 0 || x === 4 || z === 4;
          if (wall) s.grid.setCell(x, y, z, P);
          else if (y === 3) s.grid.setCell(x, y, z, slab(B.PLANKS_OAK, UPPER));
        }
      }
    }
    const g = shapeOf(s, false);
    expect(g.halfCount).toBe(0);
    expect(g.dispVolume).toBe(s.grid.count + 18); // every cell of the closed box (the roof layer hard + sealed)
  });
});

describe('nearestOwnerCell (12.4, 12.7)', () => {
  it('in a partial cell it names the nearest hard octant whose closure holds the point; in a full cell the cell and the octant on the point side', () => {
    const s = newShip();
    s.grid.setCell(0, 0, 0, slab(B.PLANKS_OAK, LOWER));
    s.grid.setCell(1, 0, 0, P);
    const g = shapeOf(s);
    const out = { x: 0, y: 0, z: 0, octant: -1 };
    // a point on the top face of the slab, towards a target above its +Z half
    expect(nearestOwnerCell(g, 0.25, 0.5, 0.75, 0.25, 2, 0.75, out)).toBe(true);
    expect(out).toEqual({ x: 0, y: 0, z: 0, octant: 4 });
    // a point in the empty upper half of the slab cell touches no hard octant of it, nor the full neighbour
    expect(nearestOwnerCell(g, 0.25, 0.75, 0.25, 0.25, 2, 0.25, out)).toBe(false);
    // on the shared face x = 1, lower half: the slab's octant 1 and the full block compete; the target lies west
    expect(nearestOwnerCell(g, 1, 0.25, 0.25, -3, 0.25, 0.25, out)).toBe(true);
    expect(out).toEqual({ x: 0, y: 0, z: 0, octant: 1 });
    // same point, target east: the full block, its octant on the point's side (x low, y low, z low)
    expect(nearestOwnerCell(g, 1, 0.25, 0.25, 5, 0.25, 0.25, out)).toBe(true);
    expect(out).toEqual({ x: 1, y: 0, z: 0, octant: 0 });
    // upper half of the shared face: only the full block
    expect(nearestOwnerCell(g, 1, 0.75, 0.75, -3, 0.75, 0.75, out)).toBe(true);
    expect(out).toEqual({ x: 1, y: 0, z: 0, octant: 6 });
  });
});
