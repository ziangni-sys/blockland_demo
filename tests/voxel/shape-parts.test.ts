/**
 * The box queries of src/voxel/shape.ts with partial cells (docs/SHAPES.md section 5): each
 * describe of tests/voxel/shape.test.ts (which stays as it is: full blocks only) gets its partial
 * twin here, plus the reference comparisons of section 16.2 P3:
 *  - full blocks only: bit for bit what M1 answered (tests/voxel/m1-shape.ts, the frozen M1 code);
 *  - partial cells only: what M1 answers on a world twice the size where every octant is a full
 *    cell ("the scaled world"), depths bit for bit, normals where the best (unit, exposed face)
 *    is unique (section 5.3);
 *  - rotated structures: an exact LP reference per octant (helpers.ts overlapMarginBox);
 *  - the World's direct chunk scans = the getCell / getPart2 path = getPacked + solidFill;
 *  - a chunk whose layers are all 0 = a chunk without layers; a full cell next to a partial one
 *    in the neighbouring chunk (with layers while its own chunk has none) is pushed per octant.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, solidFill } from '../../src/blocks/shapes';
import { qfromYaw, qidentity, vec3, type AABB, type Quat, type Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { Chunk } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { getPacked, solidAtHalf } from '../../src/voxel/parts';
import { StructureGrid } from '../../src/voxel/sgrid';
import {
  CONTACT_EPS,
  boxOverlapsSolid,
  columnHasSolidBelow,
  deepestPenetration,
  forEachSolidCellOverlapping,
  hasSupportBelow,
  nearestFreeOffset,
  resolvePenetration,
  sweepAxis,
  type Penetration,
} from '../../src/voxel/shape';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, NORTH, slab, SOUTH, stairFill, UPPER, WEST } from '../shapes';
import { axisAngle, box, emptyWorld, overlapMarginBox, randomQuat, structure } from './helpers';
import * as M1 from './m1-shape';

const STONE = makeCell(B.STONE);
const stone = (fill: number): number => slab(B.STONE, fill);
const planks = (fill: number): number => slab(B.PLANKS_OAK, fill);

/** A box with feet (min corner) at (x, y, z) and size (w, h, d). */
function feetBox(x: number, y: number, z: number, w: number, h: number, d: number): AABB {
  return box(x, y, z, x + w, y + h, z + d);
}

/** A player-sized box (0.6 x 1.8) standing with its feet centre at (x, y, z). */
function body(x: number, y: number, z: number, hw = 0.3, h = 1.8): AABB {
  return box(x - hw, y, z - hw, x + hw, y + h, z + hw);
}

function scale(b: AABB, k: number): AABB {
  return box(b.minX * k, b.minY * k, b.minZ * k, b.maxX * k, b.maxY * k, b.maxZ * k);
}

/** Coordinates within `tol` of a half-cell plane (the lattice of both the world and the scaled world). */
function nearHalf(b: AABB, tol = 1e-6): boolean {
  return [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].some((v) => Math.abs(v * 2 - Math.round(v * 2)) < tol);
}

function randomBox(rng: Rng, c: Vec3, spread: number, maxHalf: number): AABB {
  const x = c.x + rng.range(-spread, spread);
  const y = c.y + rng.range(-spread, spread);
  const z = c.z + rng.range(-spread, spread);
  const hx = rng.range(0.05, maxHalf);
  const hy = rng.range(0.05, maxHalf);
  const hz = rng.range(0.05, maxHalf);
  return box(x - hx, y - hy, z - hz, x + hx, y + hy, z + hz);
}

/** A random part fill that is neither empty nor full. */
function partialFill(rng: Rng): number {
  return rng.int(1, 254);
}

/**
 * Fill the region [x0,x1) x [y0,y1) x [z0,z1) of `g` with random PARTIAL cells (density p): single
 * parts, and two-part cells whose union still leaves an octant empty. Never a full cell.
 */
function randomPartialScene(g: VoxelGrid, rng: Rng, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, p: number): void {
  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        if (!rng.chance(p)) continue;
        if (rng.chance(0.2)) {
          // Two parts, disjoint, not filling the cell.
          const f1 = partialFill(rng);
          const rest = ~f1 & 0xff;
          let f2 = rest & rng.int(1, 255);
          if (f2 === rest) f2 &= f2 - 1; // leave one octant empty
          if (f2 === 0) {
            g.setCell(x, y, z, stone(f1));
            continue;
          }
          g.setCell(x, y, z, canonCell(stone(f1), planks(f2)));
        } else {
          g.setCell(x, y, z, stone(partialFill(rng)));
        }
      }
    }
  }
}

/** The scaled world: every solid octant (half-cell h) of `src` in the region becomes the full cell h of a new world. */
function scaledWorld(src: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): World {
  const w = emptyWorld(-3, 2);
  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const f = solidFill(getPacked(src, x, y, z));
        for (let o = 0; o < 8; o++) if ((f >> o) & 1) w.setCell(2 * x + (o & 1), 2 * y + ((o >> 1) & 1), 2 * z + ((o >> 2) & 1), STONE);
      }
    }
  }
  return w;
}

/**
 * Is the best push of `b` against `g` unique (section 5.3)? Brute force over every solid octant
 * the box overlaps (all units are octants in a partial-only scene): its true overlap (smallest of
 * its six face depths) and, for each exposed face, the push; the best is the largest true overlap,
 * then the smallest push. Unique when exactly one (octant, face) pair reaches it.
 */
function uniqueBestPush(g: VoxelGrid, b: AABB): boolean {
  const h0 = [Math.floor((b.minX + CONTACT_EPS) * 2), Math.floor((b.minY + CONTACT_EPS) * 2), Math.floor((b.minZ + CONTACT_EPS) * 2)];
  const h1 = [Math.ceil((b.maxX - CONTACT_EPS) * 2) - 1, Math.ceil((b.maxY - CONTACT_EPS) * 2) - 1, Math.ceil((b.maxZ - CONTACT_EPS) * 2) - 1];
  const lmin = [b.minX, b.minY, b.minZ];
  const lmax = [b.maxX, b.maxY, b.maxZ];
  const pairs: Array<{ overlap: number; push: number }> = [];
  for (let hx = h0[0]!; hx <= h1[0]!; hx++) {
    for (let hy = h0[1]!; hy <= h1[1]!; hy++) {
      for (let hz = h0[2]!; hz <= h1[2]!; hz++) {
        if (!solidAtHalf(g, hx, hy, hz)) continue;
        const h = [hx, hy, hz];
        // Unit min corner, as the implementation computes it: cell + 0.5 * octant bit.
        const u = h.map((v) => (v >> 1) + 0.5 * (v & 1));
        const depths: number[] = [];
        for (let a = 0; a < 3; a++) {
          depths.push(u[a]! + 0.5 - lmin[a]!);
          depths.push(lmax[a]! - u[a]!);
        }
        const overlap = Math.min(...depths);
        for (let d = 0; d < 6; d++) {
          const a = d >> 1;
          const n = [hx, hy, hz];
          n[a] = n[a]! + ((d & 1) === 0 ? 1 : -1);
          if (solidAtHalf(g, n[0]!, n[1]!, n[2]!)) continue;
          pairs.push({ overlap, push: depths[d]! });
        }
      }
    }
  }
  if (pairs.length === 0) return false;
  const best = Math.max(...pairs.map((p) => p.overlap));
  const top = pairs.filter((p) => p.overlap === best);
  const minPush = Math.min(...top.map((p) => p.push));
  return top.filter((p) => p.push === minPush).length === 1;
}

/** Solid cells (with packed value and overlapping octants) that forEachSolidCellOverlapping visits. */
function visits(g: VoxelGrid, b: AABB): string[] {
  const out: string[] = [];
  forEachSolidCellOverlapping(g, b, (x, y, z, packed, octants) => {
    out.push(`${x},${y},${z}:${packed}:${octants}`);
  });
  return out;
}

/** Solid octants (cell and octant) a box overlaps, from forEachSolidCellOverlapping. */
function octantsOf(g: VoxelGrid, b: AABB): Set<string> {
  const out = new Set<string>();
  forEachSolidCellOverlapping(g, b, (x, y, z, _packed, octants) => {
    for (let o = 0; o < 8; o++) if ((octants >> o) & 1) out.add(`${x},${y},${z},${o}`);
  });
  return out;
}

function penFields(p: Penetration | null): number[] | null {
  return p === null ? null : [p.nx, p.ny, p.nz, p.depth, p.cx, p.cy, p.cz, p.octant];
}

/**
 * A world grid that is not a World instance: shape.ts reads it only through getCell / getPart2,
 * the generic path, which must answer what the World's direct chunk scans answer.
 */
class ProxyWorld implements VoxelGrid {
  readonly gridId = 0;
  readonly parent = null;
  readonly isWorld = true;
  constructor(private readonly w: World) {}
  getCell(x: number, y: number, z: number): number {
    return this.w.getCell(x, y, z);
  }
  getPart2(x: number, y: number, z: number): number {
    return this.w.getPart2(x, y, z);
  }
  setCell(x: number, y: number, z: number, cell: number, flags?: number): boolean {
    return this.w.setCell(x, y, z, cell, flags);
  }
  toWorld(p: Vec3, out?: Vec3): Vec3 {
    return this.w.toWorld(p, out);
  }
  toLocal(p: Vec3, out?: Vec3): Vec3 {
    return this.w.toLocal(p, out);
  }
  dirToWorld(d: Vec3, out?: Vec3): Vec3 {
    return this.w.dirToWorld(d, out);
  }
  dirToLocal(d: Vec3, out?: Vec3): Vec3 {
    return this.w.dirToLocal(d, out);
  }
  velocityAt(p: Vec3, out?: Vec3): Vec3 {
    return this.w.velocityAt(p, out);
  }
  worldRotation(out?: Quat): Quat {
    return this.w.worldRotation(out);
  }
  cellBounds(): null {
    return null;
  }
}

// ====================================================================== references

describe('full blocks only: every query answers bit for bit what M1 answered (frozen M1 copy)', () => {
  it('world, axis-aligned and rotated structures: overlap, visits, push-out, resolve, sweeps, support, columns, free spots', () => {
    const rng = new Rng(3301);
    const w = emptyWorld();
    const world = new World();
    const grids: VoxelGrid[] = [w, structure(world, 1, vec3(0.5, 0, 0.5), qfromYaw(Math.PI / 2)), structure(world, 2, vec3(0.3, 0.1, -0.2), randomQuat(rng))];
    for (let i = 0; i < 700; i++) {
      const x = rng.int(-6, 5);
      const y = rng.int(40, 47);
      const z = rng.int(-6, 5);
      for (const g of grids) g.setCell(x, y, z, STONE);
    }
    let compared = 0;
    for (let i = 0; i < 1500; i++) {
      const b = randomBox(rng, vec3(0, 43.5, 0), 6, 1.1);
      for (const g of grids) {
        compared++;
        expect(boxOverlapsSolid(g, b)).toBe(M1.boxOverlapsSolid(g, b));
        const m1v: string[] = [];
        M1.forEachSolidCellOverlapping(g, b, (x, y, z, c) => {
          m1v.push(`${x},${y},${z}:${c}`);
        });
        const v: string[] = [];
        forEachSolidCellOverlapping(g, b, (x, y, z, c) => {
          v.push(`${x},${y},${z}:${c}`);
        });
        expect(v).toEqual(m1v);
        const p = deepestPenetration(g, b);
        const q = M1.deepestPenetration(g, b);
        expect(p === null).toBe(q === null);
        if (p !== null && q !== null) {
          for (const k of ['nx', 'ny', 'nz', 'depth', 'cx', 'cy', 'cz'] as const) expect(Object.is(p[k], q[k]), `${k} ${p[k]} ${q[k]}`).toBe(true);
          expect(p.octant).toBe(-1);
        }
        const pref = { prefer: vec3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)), preferWeight: rng.range(0, 0.6) };
        const pb = deepestPenetration(g, b, pref);
        const qb = M1.deepestPenetration(g, b, pref);
        expect(pb === null).toBe(qb === null);
        if (pb !== null && qb !== null) for (const k of ['nx', 'ny', 'nz', 'depth', 'cx', 'cy', 'cz'] as const) expect(Object.is(pb[k], qb[k])).toBe(true);
        const r = resolvePenetration(g, b, 8);
        const rm = M1.resolvePenetration(g, b, 8);
        for (const k of ['dx', 'dy', 'dz', 'resolved', 'iterations', 'nx', 'ny', 'nz'] as const) expect(Object.is(r[k], rm[k]), k).toBe(true);
        const gap = rng.range(0.01, 2);
        const inset = rng.range(0, 0.4);
        expect(hasSupportBelow(g, b, gap, inset)).toBe(M1.hasSupportBelow(g, b, gap, inset));
        expect(columnHasSolidBelow(g, b, gap * 4, inset)).toBe(M1.columnHasSolidBelow(g, b, gap * 4, inset));
        if (g.isWorld) {
          for (const axis of [0, 1, 2] as const) {
            const d = rng.range(-3, 3);
            expect(Object.is(sweepAxis(g, b, axis, d), M1.sweepAxis(g, b, axis, d))).toBe(true);
          }
        }
      }
      if (i % 10 === 0) {
        const a = nearestFreeOffset(grids, b, 1.5);
        const m = M1.nearestFreeOffset(grids, b, 1.5);
        expect(a).toEqual(m);
      }
    }
    expect(compared).toBe(4500);
  });

  it('deepestPenetration with `out` writes the result there (M1 fields, octant -1) and leaves it alone when there is none', () => {
    const w = emptyWorld();
    w.setCell(0, 10, 0, STONE);
    const out: Penetration = { nx: 9, ny: 9, nz: 9, depth: 9, cx: 9, cy: 9, cz: 9, octant: 9 };
    const b = box(0.2, 10.7, 0.2, 0.8, 11.7, 0.8);
    expect(deepestPenetration(w, b, undefined, out)).toBe(out);
    const m = M1.deepestPenetration(w, b)!;
    expect([out.nx, out.ny, out.nz, out.depth, out.cx, out.cy, out.cz, out.octant]).toEqual([m.nx, m.ny, m.nz, m.depth, m.cx, m.cy, m.cz, -1]);
    // No push: null, and `out` is left as it was.
    expect(deepestPenetration(w, box(5, 50, 5, 6, 51, 6), undefined, out)).toBeNull();
    expect(out.depth).toBe(m.depth);
  });
});

describe('partial cells only: M1 on the scaled world (every octant a full cell, everything twice as large)', () => {
  // Region of the partial scene; the scaled world holds it at twice the coordinates.
  const X0 = -6;
  const X1 = 6;
  const Y0 = 20;
  const Y1 = 27;
  const rng = new Rng(4402);
  const w = emptyWorld(-3, 2);
  randomPartialScene(w, rng, X0, Y0, X0, X1, Y1, X1, 0.45);
  const w2 = scaledWorld(w, X0, Y0, X0, X1, Y1, X1);

  it('overlap, support, columns and sweeps (all axes, both ways) are equal, sweeps bit for bit', () => {
    let overlaps = 0;
    let blocked = 0;
    let n = 0;
    for (let i = 0; i < 4000; i++) {
      const b = randomBox(rng, vec3(0, 23.5, 0), 4.5, 1.0);
      if (nearHalf(b)) continue;
      n++;
      const b2 = scale(b, 2);
      const o = boxOverlapsSolid(w, b);
      expect(o).toBe(boxOverlapsSolid(w2, b2));
      if (o) overlaps++;
      const gap = rng.range(0.02, 1.5);
      const inset = rng.range(0, 0.4);
      expect(hasSupportBelow(w, b, gap, inset)).toBe(hasSupportBelow(w2, b2, gap * 2, inset * 2));
      expect(columnHasSolidBelow(w, b, gap * 3, inset)).toBe(columnHasSolidBelow(w2, b2, gap * 6, inset * 2));
      for (const axis of [0, 1, 2] as const) {
        const d = rng.range(-3, 3);
        const r = sweepAxis(w, b, axis, d);
        const r2 = sweepAxis(w2, b2, axis, d * 2);
        expect(Object.is(r * 2, r2) || (r === 0 && r2 === 0), `axis ${axis} delta ${d}: ${r} vs ${r2 / 2}`).toBe(true);
        if (r !== d) blocked++;
      }
    }
    expect(n).toBeGreaterThan(3900);
    expect(overlaps).toBeGreaterThan(800);
    expect(blocked).toBeGreaterThan(3000);
  });

  it('push-out: the depth bit for bit, the normal wherever the best (octant, exposed face) is unique', () => {
    let pushes = 0;
    let unique = 0;
    for (let i = 0; i < 3000; i++) {
      const b = randomBox(rng, vec3(0, 23.5, 0), 4.5, 0.9);
      if (nearHalf(b)) continue;
      const p = deepestPenetration(w, b);
      const p2 = deepestPenetration(w2, scale(b, 2));
      expect(p === null).toBe(p2 === null);
      if (p === null || p2 === null) continue;
      pushes++;
      expect(p.depth * 2).toBe(p2.depth);
      expect(p.octant).toBeGreaterThanOrEqual(0); // every unit here is an octant
      if (!uniqueBestPush(w, b)) continue;
      unique++;
      expect([p.nx, p.ny, p.nz]).toEqual([p2.nx, p2.ny, p2.nz]);
      // ... and the unit is that octant of the scaled cell.
      expect([2 * p.cx + (p.octant & 1), 2 * p.cy + ((p.octant >> 1) & 1), 2 * p.cz + ((p.octant >> 2) & 1)]).toEqual([p2.cx, p2.cy, p2.cz]);
    }
    expect(pushes).toBeGreaterThan(1000);
    expect(unique).toBeGreaterThan(pushes * 0.5);
  });
});

describe('rotated structures with partial cells: an exact LP reference per octant', () => {
  it('boxOverlapsSolid and the visited octants match overlapMarginBox over every solid octant', () => {
    const rng = new Rng(5503);
    const world = new World();
    for (let trial = 0; trial < 6; trial++) {
      const s = structure(world, trial + 1, vec3(rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)), randomQuat(rng));
      randomPartialScene(s, rng, -2, -2, -2, 2, 2, 2, 0.5);
      s.setCell(2, 0, 0, STONE); // a full cell among them
      const solid: Array<[number, number, number, number]> = [];
      for (let y = -2; y <= 2; y++)
        for (let z = -2; z <= 2; z++)
          for (let x = -2; x <= 2; x++) {
            const f = solidFill(getPacked(s, x, y, z));
            for (let o = 0; o < 8; o++) if ((f >> o) & 1) solid.push([x, y, z, o]);
          }
      let decided = 0;
      for (let i = 0; i < 150; i++) {
        const c = s.toWorld(vec3(rng.range(-2.5, 3.5), rng.range(-2.5, 2.5), rng.range(-2.5, 2.5)));
        const b = box(c.x - rng.range(0.05, 0.8), c.y - rng.range(0.05, 0.8), c.z - rng.range(0.05, 0.8), c.x + rng.range(0.05, 0.8), c.y + rng.range(0.05, 0.8), c.z + rng.range(0.05, 0.8));
        const margins = solid.map(([x, y, z, o]) => {
          const ox = x + 0.5 * (o & 1);
          const oy = y + 0.5 * ((o >> 1) & 1);
          const oz = z + 0.5 * ((o >> 2) & 1);
          return { key: `${x},${y},${z},${o}`, m: overlapMarginBox(s, b, ox, oy, oz, ox + 0.5, oy + 0.5, oz + 0.5) };
        });
        if (margins.some((e) => Math.abs(e.m) < 1e-7)) continue; // too close to touching to judge
        decided++;
        const want = new Set(margins.filter((e) => e.m > 0).map((e) => e.key));
        expect(boxOverlapsSolid(s, b)).toBe(want.size > 0);
        expect(octantsOf(s, b)).toEqual(want);
      }
      expect(decided).toBeGreaterThan(100);
    }
  });

  it('an axis-aligned structure (identity and a quarter turn) answers what the world answers, translated', () => {
    const rng = new Rng(6604);
    const w = emptyWorld();
    const world = new World();
    const ident = structure(world, 1, vec3(0, 0, 0), qidentity());
    randomPartialScene(w, rng, -4, 30, -4, 4, 36, 4, 0.5);
    for (let y = 30; y < 36; y++) for (let z = -4; z < 4; z++) for (let x = -4; x < 4; x++) ident.setCell(x, y, z, getPacked(w, x, y, z));
    // A quarter turn about y maps local (x, z) to world (z', -x'); its grid holds the scene turned back.
    const turned = structure(world, 2, vec3(0, 0, 0), qfromYaw(Math.PI / 2));
    for (let y = 30; y < 36; y++)
      for (let z = -4; z < 4; z++)
        for (let x = -4; x < 4; x++) {
          const c = turned.toLocal(vec3(x + 0.5, y + 0.5, z + 0.5));
          const f = solidFill(getPacked(w, x, y, z));
          // Octant o of world cell (x, y, z) lands in local octant of the turned grid.
          let lf = 0;
          for (let o = 0; o < 8; o++) {
            if (((f >> o) & 1) === 0) continue;
            const lp = turned.toLocal(vec3(x + 0.25 + 0.5 * (o & 1), y + 0.25 + 0.5 * ((o >> 1) & 1), z + 0.25 + 0.5 * ((o >> 2) & 1)));
            lf |= 1 << ((Math.floor(lp.x * 2) & 1) | ((Math.floor(lp.y * 2) & 1) << 1) | ((Math.floor(lp.z * 2) & 1) << 2));
          }
          if (lf !== 0) turned.setCell(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z), lf === 0xff ? STONE : stone(lf));
        }
    for (let i = 0; i < 1500; i++) {
      const b = randomBox(rng, vec3(0, 33, 0), 3.5, 1.0);
      if (nearHalf(b)) continue;
      const o = boxOverlapsSolid(w, b);
      expect(boxOverlapsSolid(ident, b)).toBe(o);
      expect(boxOverlapsSolid(turned, b)).toBe(o);
      expect(hasSupportBelow(ident, b, 0.3, 0.1)).toBe(hasSupportBelow(w, b, 0.3, 0.1));
      expect(hasSupportBelow(turned, b, 0.3, 0.1)).toBe(hasSupportBelow(w, b, 0.3, 0.1));
      const pw = deepestPenetration(w, b);
      const pi = deepestPenetration(ident, b);
      expect(pi === null).toBe(pw === null);
      if (pw !== null && pi !== null) {
        expect([pi.nx, pi.ny, pi.nz, pi.cx, pi.cy, pi.cz, pi.octant]).toEqual([pw.nx, pw.ny, pw.nz, pw.cx, pw.cy, pw.cz, pw.octant]);
        expect(pi.depth).toBeCloseTo(pw.depth, 9);
      }
    }
  });
});

describe("the World's direct chunk scans = the getCell / getPart2 path = getPacked + solidFill", () => {
  it('random partial and full cells across chunk borders, into unloaded chunks, deeprock and the build limit', () => {
    const rng = new Rng(7705);
    const w = emptyWorld(-1, 0); // x, z in [-16, 16); every other column is unloaded (solid)
    randomPartialScene(w, rng, -16, 0, -16, 16, 6, 16, 0.3);
    randomPartialScene(w, rng, -16, 122, -16, 16, 128, 16, 0.3);
    randomPartialScene(w, rng, -16, 40, -16, 16, 48, 16, 0.4);
    for (let i = 0; i < 400; i++) w.setCell(rng.int(-16, 15), rng.int(0, 127), rng.int(-16, 15), STONE);
    const p = new ProxyWorld(w);
    // Brute force: solid fill of the packed cell, octant boxes against the box (with the tolerance).
    const brute = (b: AABB): boolean => {
      for (let y = Math.floor(b.minY); y <= Math.floor(b.maxY); y++)
        for (let z = Math.floor(b.minZ); z <= Math.floor(b.maxZ); z++)
          for (let x = Math.floor(b.minX); x <= Math.floor(b.maxX); x++) {
            const f = solidFill(getPacked(w, x, y, z));
            for (let o = 0; o < 8; o++) {
              if (((f >> o) & 1) === 0) continue;
              const lo = [x + 0.5 * (o & 1), y + 0.5 * ((o >> 1) & 1), z + 0.5 * ((o >> 2) & 1)];
              const mins = [b.minX, b.minY, b.minZ];
              const maxs = [b.maxX, b.maxY, b.maxZ];
              if ([0, 1, 2].every((a) => maxs[a]! - lo[a]! > CONTACT_EPS && lo[a]! + 0.5 - mins[a]! > CONTACT_EPS)) return true;
            }
          }
      return false;
    };
    let overlaps = 0;
    for (let i = 0; i < 3000; i++) {
      const band = i % 3;
      const cy = band === 0 ? rng.range(-2, 7) : band === 1 ? rng.range(121, 131) : rng.range(39, 49);
      const b = randomBox(rng, vec3(rng.range(-19, 19), cy, rng.range(-19, 19)), 0, 1.3);
      if (nearHalf(b)) continue;
      const o = boxOverlapsSolid(w, b);
      expect(o).toBe(boxOverlapsSolid(p, b));
      if (b.minY >= 0 && b.maxY < 128 && Math.floor(b.minX) >= -16 && Math.floor(b.maxX) < 16 && Math.floor(b.minZ) >= -16 && Math.floor(b.maxZ) < 16) expect(o).toBe(brute(b));
      if (o) overlaps++;
      const gap = rng.range(0.01, 3);
      const inset = rng.range(0, 0.4);
      expect(hasSupportBelow(w, b, gap, inset)).toBe(hasSupportBelow(p, b, gap, inset));
      expect(columnHasSolidBelow(w, b, gap * 3, inset)).toBe(columnHasSolidBelow(p, b, gap * 3, inset));
      const axis = rng.int(0, 2) as 0 | 1 | 2;
      const delta = rng.range(-40, 40);
      expect(Object.is(sweepAxis(w, b, axis, delta), sweepAxis(p, b, axis, delta))).toBe(true);
      expect(penFields(deepestPenetration(w, b))).toEqual(penFields(deepestPenetration(p, b)));
      expect(visits(w, b)).toEqual(visits(p, b));
    }
    expect(overlaps).toBeGreaterThan(400);
  });
});

describe('layers: all-zero layers answer like no layers; a partial cell in the neighbouring chunk changes the full cell beside it', () => {
  it('a chunk whose layers were allocated and emptied again gives every query the same answer as a chunk that never had them', () => {
    const rng = new Rng(8806);
    const a = emptyWorld(-1, 0);
    const b = emptyWorld(-1, 0);
    for (let i = 0; i < 1500; i++) {
      const x = rng.int(-16, 15);
      const y = rng.int(20, 27);
      const z = rng.int(-16, 15);
      a.setCell(x, y, z, STONE);
      b.setCell(x, y, z, STONE);
    }
    // In `b`, every column gets layers by writing a slab and its full block back over it.
    for (let cx = -1; cx <= 0; cx++)
      for (let cz = -1; cz <= 0; cz++) {
        const x = cx * 16 + 3;
        const z = cz * 16 + 3;
        const keep = b.getCell(x, 60, z);
        b.setCell(x, 60, z, canonCell(stone(LOWER), planks(0x40)));
        b.setCell(x, 60, z, keep);
        expect(b.getChunk(cx, cz)!.holes).not.toBeNull();
        expect(b.getChunk(cx, cz)!.part2).not.toBeNull();
        expect(a.getChunk(cx, cz)!.holes).toBeNull();
      }
    for (let i = 0; i < 1500; i++) {
      const bx = randomBox(rng, vec3(rng.range(-17, 17), rng.range(19, 29), rng.range(-17, 17)), 0, 1.2);
      expect(boxOverlapsSolid(b, bx)).toBe(boxOverlapsSolid(a, bx));
      expect(penFields(deepestPenetration(b, bx))).toEqual(penFields(deepestPenetration(a, bx)));
      const axis = rng.int(0, 2) as 0 | 1 | 2;
      const d = rng.range(-5, 5);
      expect(Object.is(sweepAxis(b, bx, axis, d), sweepAxis(a, bx, axis, d))).toBe(true);
      expect(hasSupportBelow(b, bx, 0.2, 0.1)).toBe(hasSupportBelow(a, bx, 0.2, 0.1));
    }
  });

  it('a full cell at a chunk border, its chunk without layers, whose face neighbour across the border is partial: pushed per octant', () => {
    const w = emptyWorld(-1, 0);
    // The full cell (-1, 10, 3) in chunk -1, walled in on five sides by full cells; its +X
    // neighbour (0, 10, 3), in chunk 0, is a lower slab: only the lower half of its +X face is covered.
    for (const [x, y, z] of [[-1, 10, 3], [-1, 11, 3], [-1, 9, 3], [-2, 10, 3], [-1, 10, 2], [-1, 10, 4]]) w.setCell(x!, y!, z!, STONE);
    w.setCell(0, 10, 3, stone(LOWER));
    expect(w.getChunk(-1, 0)!.holes).toBeNull();
    expect(w.getChunk(0, 0)!.holes).not.toBeNull();
    // A small box embedded in the upper half of (-1, 10, 3), 0.15 from its +X face: the only way
    // out is through the exposed upper half of that face. (With the whole-cell rule the face would
    // count as covered and nothing could push the box out.)
    const b = box(-0.15, 10.6, 3.4, -0.05, 10.8, 3.6);
    const p = deepestPenetration(w, b)!;
    expect(p).not.toBeNull();
    expect([p.nx, p.ny, p.nz]).toEqual([1, 0, 0]);
    expect(p.depth).toBeCloseTo(0.15, 12);
    expect([p.cx, p.cy, p.cz]).toEqual([-1, 10, 3]);
    expect(p.octant & 3).toBe(3); // an upper octant on the +X side
    // In the lower half the face is covered by the slab: no way out there.
    expect(deepestPenetration(w, box(-0.15, 10.2, 3.4, -0.05, 10.4, 3.6))).toBeNull();
    // With a full block across the border the cell is a whole-cell unit again, fully covered.
    w.setCell(0, 10, 3, STONE);
    expect(deepestPenetration(w, b)).toBeNull();
  });
});

// ====================================================================== overlap

describe('overlap — half slabs (world fast path)', () => {
  const w = emptyWorld();
  w.setCell(0, 10, 0, stone(LOWER));
  w.setCell(1, 10, 0, stone(UPPER));
  w.setCell(2, 10, 0, canonCell(stone(LOWER), planks(UPPER))); // fills its cell: a whole-cell unit
  w.setCell(3, 10, 0, stone(WEST));
  w.setCell(-1, 10, -1, stone(0x80)); // one octant, negative coordinates

  it('a box on the top of a lower slab (y + 0.5) touches but does not overlap; sunk by 1e-6 it does', () => {
    expect(boxOverlapsSolid(w, feetBox(0.2, 10.5, 0.2, 0.6, 1.8, 0.6))).toBe(false);
    expect(boxOverlapsSolid(w, feetBox(0.2, 10.5 - 1e-10, 0.2, 0.6, 1.8, 0.6))).toBe(false); // within CONTACT_EPS
    expect(boxOverlapsSolid(w, feetBox(0.2, 10.5 - 1e-6, 0.2, 0.6, 1.8, 0.6))).toBe(true);
  });

  it('the empty half of a cell is empty: under an upper slab, beside a west slab, around a single octant', () => {
    expect(boxOverlapsSolid(w, box(1.1, 10.05, 0.1, 1.9, 10.5, 0.9))).toBe(false); // under the upper slab
    expect(boxOverlapsSolid(w, box(1.1, 10.05, 0.1, 1.9, 10.51, 0.9))).toBe(true);
    expect(boxOverlapsSolid(w, box(3.5, 10.1, 0.1, 3.9, 10.9, 0.9))).toBe(false); // east half of the west slab
    expect(boxOverlapsSolid(w, box(3.49, 10.1, 0.1, 3.9, 10.9, 0.9))).toBe(true);
    expect(boxOverlapsSolid(w, box(-0.9, 10.1, -0.9, -0.1, 10.45, -0.1))).toBe(false); // the single octant is at +x+y+z
    expect(boxOverlapsSolid(w, box(-0.45, 10.55, -0.45, -0.1, 10.9, -0.1))).toBe(true);
  });

  it('a body standing on a row of lower slabs with its side exactly on the seam overlaps nothing', () => {
    const row = emptyWorld();
    for (let x = 0; x < 6; x++) row.setCell(x, 20, 0, stone(LOWER));
    for (const x of [0.5, 1, 1.3, 2, 2.5]) expect(boxOverlapsSolid(row, body(x, 20.5, 0.5))).toBe(false);
    // ... and a body beside the row at floor level, its side on the row's edge plane, either.
    row.setCell(0, 19, 1, STONE);
    expect(boxOverlapsSolid(row, box(0.2, 20, 1, 0.8, 21.8, 1.6))).toBe(false);
  });

  it('a zero-width box on a 0.5 plane counts against a full cell (as in M1), not against the octants of a partial one', () => {
    expect(boxOverlapsSolid(w, box(2.5, 10.2, 0.2, 2.5, 10.8, 0.8))).toBe(true); // full (two-part) cell
    expect(boxOverlapsSolid(w, box(0.5, 10.2, 0.2, 0.5, 10.4, 0.8))).toBe(false); // partial cell
  });

  it('forEachSolidCellOverlapping passes the packed cell and the overlapping octants, in y, z, x order', () => {
    const b = box(0.4, 10.4, 0.1, 3.6, 10.6, 0.4);
    // The box covers the north quarter (z < 0.5) of each cell's octants: sub = 0x0f.
    expect(visits(w, b)).toEqual([
      `0,10,0:${stone(LOWER)}:${LOWER & 0x0f}`,
      `1,10,0:${stone(UPPER)}:${UPPER & 0x0f}`,
      `2,10,0:${canonCell(stone(LOWER), planks(UPPER))}:15`,
      `3,10,0:${stone(WEST)}:${WEST & 0x0f}`,
    ]);
    let n = 0;
    forEachSolidCellOverlapping(w, b, () => {
      n++;
      return true;
    });
    expect(n).toBe(1);
  });
});

// ====================================================================== push-out

describe('deepestPenetration — half slabs, stair edges, seams', () => {
  it('a body sunk into a lower slab is pushed up to y + 0.5 (the octant is reported)', () => {
    const w = emptyWorld();
    for (let x = -2; x < 3; x++) for (let z = -2; z < 3; z++) w.setCell(x, 10, z, stone(LOWER));
    const p = deepestPenetration(w, body(0.5, 10.45, 0.5))!;
    expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
    expect(p.depth).toBeCloseTo(0.05, 12);
    expect(p.octant & 2).toBe(0); // a lower octant
    // Straddling the seam of two slab cells, sunk more than the horizontal overlap: still up.
    const q = deepestPenetration(w, body(1.0, 10.2, 0.5))!;
    expect([q.nx, q.ny, q.nz]).toEqual([0, 1, 0]);
    expect(q.depth).toBeCloseTo(0.3, 12);
  });

  it('a full block beside an upper slab (a flush floor): a body across the seam, sunk 0.35, is pushed up, never sideways (LESSONS 接缝)', () => {
    // World and an axis-aligned structure: the same floor, a row of full blocks (x = 0) beside a
    // row of upper slabs (x = 1), tops level at y = 11.
    const w = emptyWorld();
    const s = structure(new World(), 1, vec3(0, 0, 0), qidentity());
    for (const g of [w, s] as VoxelGrid[])
      for (let z = 0; z < 4; z++) {
        g.setCell(0, 10, z, STONE);
        g.setCell(1, 10, z, stone(UPPER));
      }
    // 0.3 over each, 0.35 deep (a landing in one sub-step). The block's +X face is covered by the
    // slab in its upper half, so only its lower half is exposed and the block is pushed octant by
    // octant: its upper octants have no exposed side face. As a whole cell its +X face (0.3 to clear)
    // would win over its top (0.35) and shove the body sideways into the slab.
    const b = box(0.7, 10.65, 1.2, 1.3, 12.45, 1.8);
    for (const g of [w, s] as VoxelGrid[]) {
      const p = deepestPenetration(g, b)!;
      expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
      expect(p.depth).toBeCloseTo(0.35, 12);
      expect(p.octant).toBeGreaterThanOrEqual(0);
    }
  });

  it('a stair: a box sunk into the edge of the lower tread from above is pushed up, onto the tread', () => {
    const w = emptyWorld();
    w.setCell(0, 10, 0, stone(stairFill(5 /* NZ: the high side is north */)));
    // The high part is north (z < 0.5), the tread south. A box on the tread, sunk 0.04.
    const b = box(0.2, 10.46, 0.55, 0.8, 11.5, 0.95);
    const p = deepestPenetration(w, b)!;
    expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
    expect(p.depth).toBeCloseTo(0.04, 12);
    // Against the riser (the face at z = 0.5, from the south), 0.03 into it: pushed south.
    const r = deepestPenetration(w, box(0.2, 10.6, 0.47, 0.8, 11.4, 0.9))!;
    expect([r.nx, r.ny, r.nz]).toEqual([0, 0, 1]);
    expect(r.depth).toBeCloseTo(0.03, 12);
  });

  it('a face between two octants of one cell is a contact face when the octant across it is empty', () => {
    const w = emptyWorld();
    w.setCell(0, 10, 0, stone(0x01)); // only octant 0
    const p = deepestPenetration(w, box(0.4, 10.1, 0.1, 0.9, 10.4, 0.4))!; // overlaps octant 0 by 0.1 along x
    expect([p.nx, p.ny, p.nz]).toEqual([1, 0, 0]);
    expect(p.depth).toBeCloseTo(0.1, 12);
    expect([p.cx, p.cy, p.cz, p.octant]).toEqual([0, 10, 0, 0]);
  });

  it('a two-part cell that fills its cell is one whole-cell unit; the bias picks faces but the true depth is reported', () => {
    const w = emptyWorld();
    w.setCell(0, 10, 0, canonCell(stone(WEST), planks(EAST)));
    const b = box(0.3, 10.8, 0.3, 0.7, 11.8, 0.7);
    const p = deepestPenetration(w, b)!;
    expect([p.ny, p.octant]).toEqual([1, -1]);
    expect(p.depth).toBeCloseTo(0.2, 12);
    const q = deepestPenetration(w, b, { prefer: vec3(1, 0, 0), preferWeight: 1 })!;
    expect(q.nx).toBe(1);
    expect(q.depth).toBeCloseTo(0.7, 12);
  });

  it('rotated structure: a slab deck pushes along the deck normal; on an aligned one the octant matches the world', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0, 0, 0), axisAngle(1, 0, 0.3, 0.2));
    for (let x = -3; x < 3; x++) for (let z = -3; z < 3; z++) s.setCell(x, 0, z, stone(LOWER));
    const up = s.dirToWorld(vec3(0, 1, 0));
    const top = s.toWorld(vec3(0.5, 0.5, 0.5));
    const b = box(top.x - 0.3, top.y - 0.05, top.z - 0.3, top.x + 0.3, top.y + 1.75, top.z + 0.3);
    const p = deepestPenetration(s, b)!;
    expect(p.nx).toBeCloseTo(up.x, 9);
    expect(p.ny).toBeCloseTo(up.y, 9);
    expect(p.nz).toBeCloseTo(up.z, 9);
    expect(p.octant & 2).toBe(0);
  });
});

// ====================================================================== sweep

describe('sweepAxis — half layers', () => {
  it('a fast fall lands exactly on the top of a lower slab (y + 0.5) and on the bottom of an upper slab going up', () => {
    const w = emptyWorld();
    w.setCell(0, 10, 0, stone(LOWER));
    w.setCell(0, 20, 0, stone(UPPER));
    const b = feetBox(0.2, 15, 0.2, 0.6, 1.8, 0.6);
    expect(sweepAxis(w, b, 1, -40)).toBe(10.5 - 15);
    expect(sweepAxis(w, b, 1, 40)).toBe(20.5 - 16.8);
    // From inside the empty upper half of the lower slab's cell: blocked at once.
    expect(sweepAxis(w, feetBox(0.2, 10.5, 0.2, 0.6, 1.8, 0.6), 1, -1)).toBe(0);
    expect(sweepAxis(w, feetBox(0.2, 10.7, 0.2, 0.6, 1.8, 0.6), 1, -1)).toBeCloseTo(-0.2, 12);
  });

  it('walking along and over a row of lower slabs: never caught on a seam; a lower slab is a step, a half-thick wall stops at its face', () => {
    const w = emptyWorld();
    for (let x = -6; x < 6; x++) w.setCell(x, 10, 0, stone(LOWER));
    for (let x = -6; x < 6; x++) w.setCell(x, 9, 1, STONE);
    // On top of the row (feet at 10.5), both directions along x and diagonal steps: free.
    for (const d of [3, -3]) expect(sweepAxis(w, body(0.5, 10.5, 0.5), 0, d)).toBe(d);
    // Beside the row at floor level (feet at 10, side exactly on the row's face z = 1): free along x.
    expect(sweepAxis(w, box(-3, 10, 1, -2.4, 11.8, 1.6), 0, 5)).toBe(5);
    // Into the row from the side: stopped at the row's face.
    expect(sweepAxis(w, box(-3, 10, 1.1, -2.4, 11.8, 1.7), 2, -1)).toBeCloseTo(-0.1, 12);
    // A wall 0.5 thick (the east halves of a column of cells), approached from the west: stopped at x + 0.5.
    const wall = emptyWorld();
    for (let y = 10; y < 13; y++) wall.setCell(4, y, 0, stone(EAST));
    expect(sweepAxis(wall, box(3, 10, 0.2, 3.6, 11.8, 0.8), 0, 3)).toBeCloseTo(4.5 - 3.6, 12);
    // From the east: stopped at x + 1.
    expect(sweepAxis(wall, box(5.4, 10, 0.2, 6, 11.8, 0.8), 0, -3)).toBeCloseTo(5 - 5.4, 12);
  });

  it('a box can always move out of the octants it overlaps, and a blocked sweep leaves it touching (random partial fields)', () => {
    const rng = new Rng(9907);
    const w = emptyWorld();
    randomPartialScene(w, rng, -8, 30, -8, 8, 38, 8, 0.4);
    let blocked = 0;
    for (let i = 0; i < 2500; i++) {
      const b = randomBox(rng, vec3(0, 34, 0), 6, 1.2);
      if (nearHalf(b)) continue;
      const axis = rng.int(0, 2) as 0 | 1 | 2;
      const delta = rng.range(-4, 4);
      const r = sweepAxis(w, b, axis, delta);
      const off = (v: number): [number, number, number] => (axis === 0 ? [v, 0, 0] : axis === 1 ? [0, v, 0] : [0, 0, v]);
      const before = octantsOf(w, b);
      const end = box(b.minX + off(r)[0], b.minY + off(r)[1], b.minZ + off(r)[2], b.maxX + off(r)[0], b.maxY + off(r)[1], b.maxZ + off(r)[2]);
      const swept = box(Math.min(b.minX, end.minX), Math.min(b.minY, end.minY), Math.min(b.minZ, end.minZ), Math.max(b.maxX, end.maxX), Math.max(b.maxY, end.maxY), Math.max(b.maxZ, end.maxZ));
      for (const k of octantsOf(w, swept)) expect(before.has(k), `entered ${k}`).toBe(true);
      if (Math.abs(r) < Math.abs(delta)) {
        blocked++;
        const s = Math.sign(delta) * 1e-7;
        const further = octantsOf(w, box(end.minX + off(s)[0], end.minY + off(s)[1], end.minZ + off(s)[2], end.maxX + off(s)[0], end.maxY + off(s)[1], end.maxZ + off(s)[2]));
        expect([...further].some((k) => !before.has(k))).toBe(true);
      }
    }
    expect(blocked).toBeGreaterThan(800);
  });

  it('a side or feet within CONTACT_EPS past a half-cell plane touch the octants beyond it: along a wall of vertical half slabs and on top of a row of lower ones, free (docs/SHAPES.md 5.1)', () => {
    const w = emptyWorld();
    // The wall: south halves of cells x -6..5, z = 2 (face at z = 2.5). The row: lower slabs, z = -2.
    for (let x = -6; x < 6; x++) {
      for (let y = 10; y < 12; y++) w.setCell(x, y, 2, stone(SOUTH));
      w.setCell(x, 10, -2, stone(LOWER));
    }
    const past = 1e-10; // a rounding error's worth past the plane, well within CONTACT_EPS
    for (const d of [4, -4]) {
      // The side 1e-10 past the wall's face (into the octants the row's cells occupy), sweeping along x.
      expect(sweepAxis(w, box(-1, 10, 1.9 + past, -0.4, 11.8, 2.5 + past), 0, d)).toBe(d);
      // The feet 1e-10 below the row's top (into the lower octants), sweeping along x.
      expect(sweepAxis(w, box(-1, 10.5 - past, -2, -0.4, 12.3 - past, -1.4), 0, d)).toBe(d);
    }
    // A real overlap (1e-6 past) is in the cross-section: blocked at the next cell's octant.
    expect(Math.abs(sweepAxis(w, box(-1, 10, 1.9 + 1e-6, -0.4, 11.8, 2.5 + 1e-6), 0, 4))).toBeLessThan(4);
    expect(Math.abs(sweepAxis(w, box(-1, 10.5 - 1e-6, -2, -0.4, 12.3 - 1e-6, -1.4), 0, 4))).toBeLessThan(4);
  });

  it('a box across a chunk border: a full cell ahead in one chunk, a partial cell in the far half of the layer it reaches into in the other chunk: stopped by the partial cell', () => {
    // The box (z 15.7..16.3) straddles the border between chunks z 0 and z 1 (cells 15 | 16);
    // sweeping +X from maxX 3.2: cell (3, 10, 16) holds its +X half (stops at 3.5), cell
    // (4, 10, 15) is a full block (would stop at 4). M1's scan of cell layer 4 meets the full
    // block in the first column it reads; the answer must still account for chunk z 1's layers.
    const pos = (w: World): number => sweepAxis(w, box(2.6, 10, 15.7, 3.2, 11.8, 16.3), 0, 1);
    const w = emptyWorld();
    w.setCell(4, 10, 15, STONE);
    w.setCell(3, 10, 16, stone(EAST));
    expect(pos(w)).toBeCloseTo(0.3, 12);
    // And going -X, mirrored: from minX 3.8 the -X half of (3, 10, 16) at 3.5, a full block at (2, 10, 15).
    const v = emptyWorld();
    v.setCell(2, 10, 15, STONE);
    v.setCell(3, 10, 16, stone(WEST));
    expect(sweepAxis(v, box(3.8, 10, 15.7, 4.4, 11.8, 16.3), 0, -1)).toBeCloseTo(-0.3, 12);
    // Across z the same: the box straddles chunks x 0 | x 1 (cells 15 | 16) and sweeps +Z.
    const u = emptyWorld();
    u.setCell(15, 10, 4, STONE);
    u.setCell(16, 10, 3, stone(SOUTH));
    expect(sweepAxis(u, box(15.7, 10, 2.6, 16.3, 11.8, 3.2), 2, 1)).toBeCloseTo(0.3, 12);
  });

  it('M1 detail kept: a box of zero thickness along a horizontal swept axis, on a cell plane, returns delta', () => {
    const w = emptyWorld();
    w.setCell(2, 10, 0, stone(LOWER));
    expect(sweepAxis(w, box(1, 10, 0.2, 1, 10.4, 0.8), 0, 3)).toBe(3);
  });
});

// ====================================================================== support

describe('support — half slabs', () => {
  const w = emptyWorld();
  w.setCell(0, 10, 0, stone(LOWER));
  w.setCell(2, 10, 0, stone(NORTH)); // the north half (z < 0.5), full height
  w.setCell(4, 10, 0, stone(UPPER));

  it('standing on a lower slab is supported; hovering over the empty half of a north slab is not', () => {
    expect(hasSupportBelow(w, feetBox(0.2, 10.5, 0.2, 0.6, 1.8, 0.6), 0.08)).toBe(true);
    expect(hasSupportBelow(w, feetBox(0.2, 10.6, 0.2, 0.6, 1.8, 0.6), 0.08)).toBe(false);
    expect(hasSupportBelow(w, feetBox(2.2, 11, 0.55, 0.6, 1.8, 0.4), 0.08)).toBe(false); // over the empty south half
    expect(hasSupportBelow(w, feetBox(2.2, 11, 0.4, 0.6, 1.8, 0.4), 0.08)).toBe(true); // reaches 0.1 over the north half
    expect(hasSupportBelow(w, feetBox(2.2, 11, 0.4, 0.6, 1.8, 0.4), 0.08, 0.15)).toBe(false); // the inset leaves it
    expect(hasSupportBelow(w, feetBox(4.2, 11, 0.2, 0.6, 1.8, 0.6), 0.08)).toBe(true); // on an upper slab
  });

  it('columnHasSolidBelow counts only octants under the footprint', () => {
    expect(columnHasSolidBelow(w, feetBox(2.2, 14, 0.55, 0.6, 1.8, 0.4), 6)).toBe(false);
    expect(columnHasSolidBelow(w, feetBox(2.2, 14, 0.45, 0.6, 1.8, 0.4), 6)).toBe(true);
  });

  it('a rotated deck of lower slabs: attach (inset) strictly inside stand (inset 0)', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0, 0, 0), qfromYaw(0.5));
    for (let x = -3; x < 3; x++) for (let z = -3; z < 3; z++) s.setCell(x, 0, z, stone(LOWER));
    const rng = new Rng(1108);
    for (let i = 0; i < 400; i++) {
      const c = s.toWorld(vec3(rng.range(-4, 4), 0.5 + rng.range(0, 0.05), rng.range(-4, 4)));
      const b = feetBox(c.x - 0.3, c.y, c.z - 0.3, 0.6, 1.8, 0.6);
      if (hasSupportBelow(s, b, 0.08, 0.1)) expect(hasSupportBelow(s, b, 0.08, 0)).toBe(true);
    }
  });
});

// ====================================================================== free spot

describe('nearestFreeOffset — half slabs', () => {
  it('a box sunk into a lower slab goes to the nearest free lattice spot, on top of the slab or beside it', () => {
    const w = emptyWorld();
    w.setCell(0, 10, 0, stone(LOWER));
    const b = feetBox(0.3, 10.3, 0.3, 0.4, 0.4, 0.4);
    const off = nearestFreeOffset([w], b, 2)!;
    const moved = box(b.minX + off.x, b.minY + off.y, b.minZ + off.z, b.maxX + off.x, b.maxY + off.y, b.maxZ + off.z);
    expect(boxOverlapsSolid(w, moved)).toBe(false);
    expect(Math.hypot(off.x, off.y, off.z)).toBeCloseTo(0.25, 12); // up by 0.25 clears the slab top (10.55)
    expect(off.y).toBe(0.25);
  });

  it('a structure of partial cells is avoided too', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0, 0, 0), qfromYaw(0.3));
    s.setCell(0, 0, 0, stone(UPPER));
    const c = s.toWorld(vec3(0.5, 0.75, 0.5));
    const b = box(c.x - 0.1, c.y - 0.1, c.z - 0.1, c.x + 0.1, c.y + 0.1, c.z + 0.1);
    expect(boxOverlapsSolid(s, b)).toBe(true);
    const off = nearestFreeOffset([s], b, 2)!;
    expect(boxOverlapsSolid(s, box(b.minX + off.x, b.minY + off.y, b.minZ + off.z, b.maxX + off.x, b.maxY + off.y, b.maxZ + off.z))).toBe(false);
  });
});

// ====================================================================== robustness

describe('robustness with partial cells', () => {
  it('invalid boxes are empty, infinite deltas stop (World and the generic path), StructureGrid octant paths terminate', () => {
    const w = emptyWorld(-1, 0);
    const rng = new Rng(1209);
    randomPartialScene(w, rng, -16, 0, -16, 16, 8, 16, 0.5);
    randomPartialScene(w, rng, -16, 120, -16, 16, 128, 16, 0.5);
    const p = new ProxyWorld(w);
    for (const bad of [box(NaN, 1, 1, 2, 2, 2), box(-Infinity, 1, 1, 2, 2, 2), box(1, 1, 1, 0, 2, 2)]) {
      expect(boxOverlapsSolid(w, bad)).toBe(false);
      expect(deepestPenetration(w, bad)).toBeNull();
      expect(sweepAxis(w, bad, 1, -5)).toBe(0);
    }
    const b = box(0.1, 60.1, 0.1, 0.7, 61.9, 0.7);
    for (const g of [w, p] as VoxelGrid[]) {
      expect(sweepAxis(g, b, 1, -Infinity)).toBeLessThan(0);
      expect(Number.isFinite(sweepAxis(g, b, 1, Infinity))).toBe(true);
      expect(Number.isFinite(sweepAxis(g, b, 0, Infinity))).toBe(true);
      expect(Number.isFinite(sweepAxis(g, b, 2, -Infinity))).toBe(true);
    }
    const s = new StructureGrid(5, new World());
    s.setPoseImmediate(vec3(0, 0, 0), qfromYaw(0.7));
    randomPartialScene(s, rng, -3, -3, -3, 3, 3, 3, 0.6);
    const r = resolvePenetration(s, box(-1, -1, -1, 1, 1, 1), 64);
    expect(r.iterations).toBeLessThanOrEqual(64);
  });
});
