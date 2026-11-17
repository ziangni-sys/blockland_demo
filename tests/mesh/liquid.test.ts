import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { layersState, liquidState, makeCell } from '../../src/blocks/cell';
import { blockDef } from '../../src/blocks/registry';
import { Rng } from '../../src/core/rng';
import { LIQUID_FULL_HEIGHT, buildMesh } from '../../src/mesh/mesher';
import { VFLAG_EMISSIVE, VFLAG_LIQUID_SURFACE, type GeometryData, type MeshData, type MeshInput } from '../../src/mesh/types';
import {
  allQuads,
  checkInvariants,
  cornerAt,
  diagonalOf,
  dirOfQuad,
  makeInput,
  put,
  putLight,
  quadsOf,
  type Quad,
} from './helpers';

const SOURCE = liquidState(0, false);
const SURF = VFLAG_LIQUID_SURFACE;
const water = (level = 0, falling = false) => makeCell(B.WATER, liquidState(level, falling));
const lava = (level = 0) => makeCell(B.LAVA, liquidState(level, false));
/** Surface height of a flowing cell with `amount` (1..8) and open sky above. */
const heightOf = (amount: number) => (amount / 8) * LIQUID_FULL_HEIGHT;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const key = (x: number, y: number, z: number) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;

/** Top-surface quads (both copies) with at least one corner on a free surface. */
function surfaces(m: MeshData): Quad[] {
  return allQuads(m).filter((q) => q.nb[1] !== 0 && q.flags.some((f) => (f & SURF) !== 0));
}
/** Upward-facing surface quad of the cell whose x range is [x, x+1]. */
function topOf(m: MeshData, x: number, z = 0): Quad {
  const q = surfaces(m).find((q) => q.n.y > 0 && q.p.every((p) => p.x >= x && p.x <= x + 1 && p.z >= z && p.z <= z + 1));
  if (!q) throw new Error(`no top surface at x=${x}`);
  return q;
}
function heightAt(q: Quad, x: number, z: number): number {
  const k = q.p.findIndex((p) => near(p.x, x) && near(p.z, z));
  expect(k).toBeGreaterThanOrEqual(0);
  return q.p[k]!.y;
}
/** Quads whose corners all lie on the plane `axis` = c. */
function onPlane(qs: Quad[], axis: 'x' | 'y' | 'z', c: number): Quad[] {
  return qs.filter((q) => q.p.every((p) => near(p[axis], c)));
}
/** The quad's two triangles, each as a sorted point-set key (order-independent). */
function triangles(q: Quad): string[] {
  return [0, 1]
    .map((t) =>
      q.idx
        .slice(t * 3, t * 3 + 3)
        .map((i) => key(q.p[i]!.x, q.p[i]!.y, q.p[i]!.z))
        .sort()
        .join('|'),
    )
    .sort();
}
/** Expect `qs` to be one front quad and its exact back copy (same corners, light, flags, triangles; opposite normal). */
function expectFrontAndBack(qs: Quad[]): void {
  expect(qs.length).toBe(2);
  const [a, b] = qs as [Quad, Quad];
  expect(b.nb).toEqual([0 - a.nb[0], 0 - a.nb[1], 0 - a.nb[2]]); // 0 - x, not -x: no -0
  expect(triangles(b)).toEqual(triangles(a));
  for (let k = 0; k < 4; k++) {
    const j = cornerAt(b, a.p[k]!.x, a.p[k]!.y, a.p[k]!.z);
    expect(j).toBeGreaterThanOrEqual(0);
    expect([b.sky[j], b.block[j], b.flags[j], b.uv[j]![0], b.uv[j]![1]]).toEqual([a.sky[k], a.block[k], a.flags[k], a.uv[k]![0], a.uv[k]![1]]);
  }
}

/**
 * Every pair of coincident liquid vertices agrees on the wave flag: the renderer displaces
 * flagged vertices by a function of world xz only, so a disagreement opens a crack.
 * Returns the flag per vertex position for further checks.
 */
function waveFlagsByPosition(g: GeometryData | null): Map<string, number> {
  const seen = new Map<string, number>();
  for (const q of quadsOf(g, 'translucent')) {
    for (let k = 0; k < 4; k++) {
      const p = q.p[k]!;
      const id = key(p.x, p.y, p.z);
      const f = q.flags[k]! & SURF;
      const prev = seen.get(id);
      if (prev !== undefined && prev !== f) throw new Error(`liquid vertices at ${id} disagree on the wave flag`);
      seen.set(id, f);
    }
  }
  return seen;
}

/**
 * A 7x2x7 pool of still water on stone with a waterfall standing on it: falling cells at
 * y = 3, 4 and a source at y = 5, all at x = z = 3.
 */
function poolWithWaterfall(): MeshInput {
  const input = makeInput(7, 6, 7);
  for (let z = -1; z <= 7; z++) {
    for (let x = -1; x <= 7; x++) {
      put(input, x, -1, z, makeCell(B.STONE));
      put(input, x, 0, z, makeCell(B.STONE));
      const inside = x >= 0 && x < 7 && z >= 0 && z < 7;
      for (let y = 1; y <= 2; y++) put(input, x, y, z, inside ? water() : makeCell(B.STONE));
    }
  }
  put(input, 3, 3, 3, water(0, true));
  put(input, 3, 4, 3, water(0, true));
  put(input, 3, 5, 3, water());
  return input;
}

type V = [number, number, number];

/** Number of triangles of g hit by the ray o + t d (t > 0) whose normal faces the ray origin. */
function frontHits(g: GeometryData | null, o: V, d: V): number {
  if (!g) return 0;
  let hits = 0;
  const P = g.positions;
  for (let t = 0; t < g.indexCount; t += 3) {
    const ia = g.indices[t]!;
    const ib = g.indices[t + 1]!;
    const ic = g.indices[t + 2]!;
    const a: V = [P[ia * 3]!, P[ia * 3 + 1]!, P[ia * 3 + 2]!];
    const e1: V = [P[ib * 3]! - a[0], P[ib * 3 + 1]! - a[1], P[ib * 3 + 2]! - a[2]];
    const e2: V = [P[ic * 3]! - a[0], P[ic * 3 + 1]! - a[1], P[ic * 3 + 2]! - a[2]];
    const n: V = [g.normals[ia * 3]!, g.normals[ia * 3 + 1]!, g.normals[ia * 3 + 2]!];
    if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] >= 0) continue; // back-facing for this viewer
    // Moller-Trumbore
    const p: V = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const s: V = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < 0 || u > 1) continue;
    const q: V = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > 1e-6) hits++;
  }
  return hits;
}

describe('liquid surface heights', () => {
  it('a lone source is a 14/16 slab whose six faces are all double-sided, in the translucent group', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water());
    const m = buildMesh(input);
    checkInvariants(m);
    expect(m.opaque).toBeNull();
    expect(m.cutout).toBeNull();
    const top = topOf(m, 0);
    for (const p of top.p) expect(p.y).toBeCloseTo(14 / 16, 6);
    expect(top.nb).toEqual([0, 127, 0]);
    const qs = quadsOf(m.translucent, 'translucent');
    // (top + 4 sides + bottom) x (outside + inside copy)
    expect(qs.length).toBe(12);
    const sides = qs.filter((q) => q.nb[1] === 0);
    expect(sides.length).toBe(8);
    for (const s of sides) {
      const ys = s.p.map((p) => p.y).sort();
      expect(ys[0]).toBe(0);
      expect(ys[3]).toBeCloseTo(14 / 16, 6);
    }
  });

  it('a source next to a flowing cell shares averaged corner heights, with no face between', () => {
    const input = makeInput(2, 1, 1);
    put(input, 0, 0, 0, water(0));
    put(input, 1, 0, 0, water(4)); // amount 4
    const m = buildMesh(input);
    checkInvariants(m);
    const a = topOf(m, 0);
    const b = topOf(m, 1);
    const shared = (heightOf(8) + heightOf(4)) / 2;
    expect(heightAt(a, 0, 0)).toBeCloseTo(heightOf(8), 6);
    expect(heightAt(a, 0, 1)).toBeCloseTo(heightOf(8), 6);
    expect(heightAt(a, 1, 0)).toBeCloseTo(shared, 6);
    expect(heightAt(a, 1, 1)).toBeCloseTo(shared, 6);
    expect(heightAt(b, 1, 0)).toBeCloseTo(shared, 6);
    expect(heightAt(b, 2, 1)).toBeCloseTo(heightOf(4), 6);
    // nothing on the shared plane x = 1
    expect(onPlane(allQuads(m), 'x', 1).length).toBe(0);
    // the surface slopes down toward +x: normal leans to +x
    expect(a.nb[0]).toBeGreaterThan(0);
    expect(a.nb[1]).toBeGreaterThan(0);
  });

  it('height is monotone in the amount', () => {
    let prev = 0;
    for (let level = 7; level >= 0; level--) {
      const input = makeInput(1, 1, 1);
      put(input, 0, 0, 0, water(level));
      const h = topOf(buildMesh(input), 0).p[0]!.y;
      expect(h).toBeGreaterThan(prev);
      prev = h;
    }
    expect(prev).toBeCloseTo(14 / 16, 6);
  });

  it('a falling cell is full height, like a source', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water(5, true));
    for (const p of topOf(buildMesh(input), 0).p) expect(p.y).toBeCloseTo(14 / 16, 6);
  });

  it('with the same liquid above: no top face, sides reach the cell top', () => {
    const input = makeInput(1, 2, 1);
    put(input, 0, 0, 0, water());
    put(input, 0, 1, 0, water(0, true));
    const m = buildMesh(input);
    checkInvariants(m);
    const tops = surfaces(m).filter((q) => q.n.y > 0);
    expect(tops.length).toBe(1);
    expect(tops[0]!.p.every((p) => near(p.y, 1 + 14 / 16))).toBe(true);
    // the lower cell's sides span 0..1 (outside + inside copy each), the upper's 1..1+14/16;
    // no face at y = 1
    const lowerSides = allQuads(m).filter((q) => [0, 1, 4, 5].includes(dirOfQuad(q)) && q.p.some((p) => p.y === 0));
    expect(lowerSides.length).toBe(8);
    for (const s of lowerSides) expect(Math.max(...s.p.map((p) => p.y))).toBe(1);
    expect(onPlane(allQuads(m), 'y', 1).length).toBe(0);
  });

  it('a neighbour fed from above forces the shared corners to 1.0', () => {
    const input = makeInput(2, 2, 1);
    put(input, 0, 0, 0, water(3));
    put(input, 1, 0, 0, water());
    put(input, 1, 1, 0, water(0, true));
    const a = topOf(buildMesh(input), 0);
    expect(heightAt(a, 1, 0)).toBe(1);
    expect(heightAt(a, 1, 1)).toBe(1);
    expect(heightAt(a, 0, 0)).toBeCloseTo(heightOf(5), 6);
  });

  it('reads neighbours across the box margin', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water(4));
    put(input, -1, 0, 0, water(0)); // margin source to the west
    const m = buildMesh(input);
    const a = topOf(m, 0);
    expect(heightAt(a, 0, 0)).toBeCloseTo((heightOf(8) + heightOf(4)) / 2, 6);
    expect(heightAt(a, 1, 0)).toBeCloseTo(heightOf(4), 6);
    // no face (either copy) toward the margin water
    expect(onPlane(allQuads(m), 'x', 0).length).toBe(0);
  });
});

describe('liquid faces', () => {
  it('the top is double-sided: a back copy with the same corners, light, flags and triangles', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water(2));
    const m = buildMesh(input);
    const s = surfaces(m);
    expectFrontAndBack(s);
    // free-surface corners carry the wave flag on both sides
    for (const q of s) expect(q.flags.every((f) => (f & SURF) !== 0)).toBe(true);
  });

  it('non-planar surfaces fold along the flatter diagonal, identically on both sides', () => {
    // Which two corners the quad's triangles share, as "x,z" pairs.
    const splitOf = (q: Quad): string => {
      const [i, j] = diagonalOf(q) === '02' ? [0, 2] : [1, 3];
      return [q.p[i]!, q.p[j]!].map((p) => `${p.x},${p.z}`).sort().join(' ');
    };
    const cell00 = (m: MeshData) => surfaces(m).filter((q) => q.p.every((p) => p.x <= 1 && p.z <= 1));

    // Source at (0,0), amount-2 cells elsewhere. Cell (0,0) corner heights: (0,0) 0.875,
    // (1,0) = (0,1) = 0.547, (1,1) = 0.383. The (1,0)-(0,1) diagonal is flat.
    const a = makeInput(2, 1, 2);
    put(a, 0, 0, 0, water(0));
    put(a, 1, 0, 0, water(6));
    put(a, 0, 0, 1, water(6));
    put(a, 1, 0, 1, water(6));
    const ma = buildMesh(a);
    checkInvariants(ma);
    const qa = cell00(ma);
    expectFrontAndBack(qa);
    for (const q of qa) expect(splitOf(q)).toBe('0,1 1,0');

    // Source at (1,0) instead. Cell (0,0): (0,0) = (0,1) = 0.219, (1,0) 0.547, (1,1) 0.383:
    // now the (0,0)-(1,1) diagonal is the flatter one.
    const b = makeInput(2, 1, 2);
    put(b, 0, 0, 0, water(6));
    put(b, 1, 0, 0, water(0));
    put(b, 0, 0, 1, water(6));
    put(b, 1, 0, 1, water(6));
    const mb = buildMesh(b);
    checkInvariants(mb);
    const qb = cell00(mb);
    expectFrontAndBack(qb);
    for (const q of qb) expect(splitOf(q)).toBe('0,0 1,1');
  });

  it('sides and bottom are skipped against opaque cells and the same liquid, kept against others', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water());
    put(input, 1, 0, 0, makeCell(B.STONE));
    put(input, -1, 0, 0, makeCell(B.GLASS));
    put(input, 0, 0, 1, water(3));
    put(input, 0, 0, -1, lava());
    put(input, 0, -1, 0, makeCell(B.SAND));
    const qs = allQuads(buildMesh(input));
    // glass side and lava side, outward only (both neighbours draw their own face there)
    expect(qs.filter((q) => q.nb[1] === 0).map(dirOfQuad).sort()).toEqual([1, 5]);
    expect(onPlane(qs, 'y', 0).length).toBe(0); // no bottom on sand
  });

  it('a boundary toward open space is double-sided; toward a block that draws its own face there, outward only', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water());
    put(input, -1, 0, 0, makeCell(B.GLASS)); // full cube: seals the plane
    put(input, 0, 0, -1, lava()); // another liquid: seals the plane
    put(input, 1, 0, 0, makeCell(B.TALL_GRASS)); // plant: nothing on the plane
    // +z and below: air
    const qs = allQuads(buildMesh(input));
    expect(onPlane(qs, 'x', 0).map(dirOfQuad)).toEqual([1]);
    expect(onPlane(qs, 'z', 0).map(dirOfQuad)).toEqual([5]);
    expectFrontAndBack(onPlane(qs, 'x', 1));
    expectFrontAndBack(onPlane(qs, 'z', 1));
    expectFrontAndBack(onPlane(qs, 'y', 0));
  });

  it('the bottom is outward-only on a block that draws its top on the shared plane', () => {
    const cases: Array<[number, number]> = [
      [makeCell(B.GLASS), 1],
      [makeCell(B.CACTUS), 1],
      [makeCell(B.SNOW_LAYER, layersState(8)), 1], // a full stack's top is on the plane
      [makeCell(B.SNOW_LAYER, layersState(4)), 2], // a half stack's is not
      [makeCell(B.TORCH), 2],
      [0, 2],
    ];
    for (const [below, expected] of cases) {
      const input = makeInput(1, 1, 1);
      put(input, 0, 0, 0, water());
      put(input, 0, -1, 0, below);
      const bottom = onPlane(quadsOf(buildMesh(input).translucent, 'translucent'), 'y', 0);
      expect(bottom.length, `below = ${below}`).toBe(expected);
      expect(bottom.some((q) => q.nb[1] < 0)).toBe(true);
    }
  });

  it('a full-height surface keeps its inside copy under air, but not under a block whose bottom is on that plane', () => {
    const fullHeight = (above: number): Quad[] => {
      const input = makeInput(1, 1, 1);
      put(input, 0, 0, 0, water());
      put(input, 0, 1, 0, above);
      // every corner forced to 1.0 by a fed neighbour (all of these are margin cells)
      for (const [x, z] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        put(input, x, 0, z, water());
        put(input, x, 1, z, water(0, true));
      }
      return onPlane(quadsOf(buildMesh(input).translucent, 'translucent'), 'y', 1);
    };
    const open = fullHeight(0);
    expectFrontAndBack(open);
    // a forced surface is pinned: no wave flag anywhere on it
    for (const q of open) expect(q.flags.every((f) => (f & SURF) === 0)).toBe(true);
    const glass = fullHeight(makeCell(B.GLASS));
    expect(glass.map((q) => q.nb)).toEqual([[0, 127, 0]]);
  });

  it('uses the still tile on top and bottom and the flow tile on the sides', () => {
    const [still, flow] = blockDef(B.WATER).tileIds as [number, number];
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water());
    for (const q of allQuads(buildMesh(input))) expect(q.tile).toBe(q.nb[1] === 0 ? flow : still);
  });

  it('side faces of a partial cell show the matching part of the tile', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water(4));
    for (const q of allQuads(buildMesh(input))) {
      if (q.nb[1] !== 0) continue;
      for (let k = 0; k < 4; k++) expect(q.uv[k]![1]).toBeCloseTo(q.p[k]!.y, 6);
    }
  });

  it('lava goes to the opaque group, emissive', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, lava());
    const m = buildMesh(input);
    expect(m.translucent).toBeNull();
    expect(m.cutout).toBeNull();
    const qs = quadsOf(m.opaque, 'opaque');
    expect(qs.length).toBe(12);
    for (const q of qs) for (const f of q.flags) expect(f & VFLAG_EMISSIVE).toBe(VFLAG_EMISSIVE);
  });

  it('lights the surface with the brighter of its own layer and the layer above', () => {
    const input = makeInput(1, 1, 1, 0);
    put(input, 0, 0, 0, water());
    putLight(input, 0, 0, 0, 13, 0); // dimmed inside the water
    putLight(input, 0, 1, 0, 15, 0); // open sky above
    const top = topOf(buildMesh(input), 0);
    // corner (0,0): own layer = water cell (13) + margin cells (0); above layer = 15 + margin 0s
    const k = cornerAt(top, 0, 14 / 16, 0);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(top.sky[k]).toBe(Math.round((15 / 4) * 17));
    // and no AO on liquids
    expect(top.ao).toEqual([255, 255, 255, 255]);
  });

  it('keeps a top face under an opaque block unless the surface is full height', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water());
    put(input, 0, 1, 0, makeCell(B.STONE));
    expect(surfaces(buildMesh(input)).length).toBe(2);
    // full height (corners forced by a fed neighbour on every side) under stone: hidden
    const full = makeInput(1, 1, 1);
    put(full, 0, 0, 0, water());
    put(full, 0, 1, 0, makeCell(B.STONE));
    for (const [x, z] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      put(full, x, 0, z, water());
      put(full, x, 1, z, water(0, true));
    }
    expect(onPlane(allQuads(buildMesh(full)), 'y', 1).length).toBe(0);
  });

  it('marks the source level constant consistently', () => {
    expect(SOURCE).toBe(0);
    expect(LIQUID_FULL_HEIGHT).toBe(14 / 16);
  });
});

describe('liquid seams: coincident surface vertices agree', () => {
  /**
   * Regression (review): four sources in a 2x2 pool share the corner (1, 14/16, 1). Above the
   * pool a diagonal pair of stones sits at (1,1,0) and (0,1,1); the two open cells above are
   * lit differently. A layer-above sample with base-relative rules (diagonal exclusion,
   * opaque-base fallback) gave quad (0,0) sky 255 and the other three 221 at that vertex —
   * a lighting crease along the shared edges.
   */
  it('gives every quad the same light at a shared corner even with an opaque cell above', () => {
    const input = makeInput(2, 2, 2, 0);
    for (const [x, z] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      put(input, x, 0, z, water());
      putLight(input, x, 0, z, 13, 0);
    }
    put(input, 1, 1, 0, makeCell(B.STONE)); // light 0, as the light engine stores for opaque cells
    put(input, 0, 1, 1, makeCell(B.STONE));
    putLight(input, 0, 1, 0, 15, 0);
    putLight(input, 1, 1, 1, 5, 0);

    const tops = surfaces(buildMesh(input)).filter((q) => q.n.y > 0);
    expect(tops.length).toBe(4);
    const skyAtSharedCorner = tops.map((q) => {
      const k = cornerAt(q, 1, 14 / 16, 1);
      expect(k).toBeGreaterThanOrEqual(0);
      return q.sky[k]!;
    });
    expect(new Set(skyAtSharedCorner).size).toBe(1);
    // own layer: four water cells at 13 -> 221; layer above: the two open cells,
    // (15 + 5) / 2 = 10 -> 170. The brighter one wins.
    expect(skyAtSharedCorner[0]).toBe(13 * 17);
  });

  it('fuzz: top quads agree on sky and block light at every shared vertex', () => {
    const rng = new Rng(4242);
    for (let t = 0; t < 30; t++) {
      // An all-water layer (random levels and light) under a layer of random stone / air.
      // With no opaque cell in the water layer, no diagonal-wall exception applies: every
      // quad touching a vertex must compute exactly the same light there.
      const input = makeInput(5, 2, 5, 0);
      for (let z = -1; z <= 5; z++) {
        for (let x = -1; x <= 5; x++) {
          put(input, x, 0, z, water(rng.chance(0.4) ? 0 : rng.int(0, 7)));
          putLight(input, x, 0, z, rng.int(0, 15), rng.int(0, 15));
          put(input, x, 1, z, rng.chance(0.45) ? makeCell(B.STONE) : 0);
          putLight(input, x, 1, z, rng.int(0, 15), rng.int(0, 15));
        }
      }
      const tops = surfaces(buildMesh(input)).filter((q) => q.n.y > 0);
      expect(tops.length).toBe(25);
      const seen = new Map<string, string>();
      for (const q of tops) {
        for (let k = 0; k < 4; k++) {
          const id = key(q.p[k]!.x, q.p[k]!.y, q.p[k]!.z);
          const v = `${q.sky[k]}/${q.block[k]}`;
          const prev = seen.get(id);
          if (prev !== undefined && prev !== v) throw new Error(`case ${t}: vertex ${id} lit ${prev} and ${v}`);
          seen.set(id, v);
        }
      }
    }
  });

  it('fuzz: top quads sharing an edge agree on light at both ends, with walls in both layers', () => {
    const rng = new Rng(777);
    let sharedEdges = 0;
    for (let t = 0; t < 40; t++) {
      const input = makeInput(5, 2, 5, 0);
      for (let z = -1; z <= 5; z++) {
        for (let x = -1; x <= 5; x++) {
          put(input, x, 0, z, rng.chance(0.25) ? makeCell(B.STONE) : water(rng.chance(0.4) ? 0 : rng.int(0, 7)));
          putLight(input, x, 0, z, rng.int(0, 15), rng.int(0, 15));
          put(input, x, 1, z, rng.chance(0.45) ? makeCell(B.STONE) : 0);
          putLight(input, x, 1, z, rng.int(0, 15), rng.int(0, 15));
        }
      }
      const tops = surfaces(buildMesh(input)).filter((q) => q.n.y > 0);
      const edges = new Map<string, Array<[Quad, number, number]>>();
      for (const q of tops) {
        for (let k = 0; k < 4; k++) {
          const a = q.p[k]!;
          const b = q.p[(k + 1) & 3]!;
          const id = [key(a.x, a.y, a.z), key(b.x, b.y, b.z)].sort().join(' ');
          const list = edges.get(id) ?? [];
          list.push([q, k, (k + 1) & 3]);
          edges.set(id, list);
        }
      }
      for (const [id, list] of edges) {
        if (list.length < 2) continue;
        sharedEdges++;
        const [q0, a0, b0] = list[0]!;
        for (const [q1] of list.slice(1)) {
          for (const k of [a0, b0]) {
            const p = q0.p[k]!;
            const j = cornerAt(q1, p.x, p.y, p.z);
            if (q1.sky[j] !== q0.sky[k] || q1.block[j] !== q0.block[k]) throw new Error(`case ${t}: crease on edge ${id}`);
          }
        }
      }
    }
    expect(sharedEdges).toBeGreaterThan(500);
  });

  it('lets no light through two diagonal pillars into the column they wall off', () => {
    const input = makeInput(2, 2, 2, 0);
    put(input, 0, 0, 0, water());
    put(input, 1, 0, 1, water());
    for (const y of [0, 1]) {
      put(input, 1, y, 0, makeCell(B.STONE));
      put(input, 0, y, 1, makeCell(B.STONE));
    }
    putLight(input, 0, 0, 0, 2, 0);
    putLight(input, 0, 1, 0, 2, 0); // dim air above the walled-in pool cell
    putLight(input, 1, 1, 1, 15, 0); // bright air beyond the pillars
    const q = surfaces(buildMesh(input)).find((q) => q.n.y > 0 && q.p.every((p) => p.x <= 1 && p.z <= 1))!;
    const k = cornerAt(q, 1, 14 / 16, 1);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(q.sky[k]).toBe(2 * 17);
  });

  /**
   * Regression (review): the renderer displaces every VFLAG_LIQUID_SURFACE vertex
   * vertically. The side faces' top corners coincide with the surface corners, so they must
   * carry the flag too, or the surface separates from the side walls when it waves.
   */
  it("flags the side faces' top-edge vertices like the surface vertices they coincide with", () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water());
    const m = buildMesh(input);
    const qs = allQuads(m);
    const surf = surfaces(m);
    const sides = qs.filter((q) => q.nb[1] === 0);
    expect(sides.length).toBe(8); // 4 sides x (outside + inside copy)
    let coincident = 0;
    for (const s of sides) {
      for (let k = 0; k < 4; k++) {
        const p = s.p[k]!;
        const onSurface = surf.some((t) => cornerAt(t, p.x, p.y, p.z) >= 0);
        if (onSurface) coincident++;
        // top corners (on the surface) wave, floor corners stay put
        expect(s.flags[k]! & SURF, `side vertex ${p.x},${p.y},${p.z}`).toBe(onSurface ? SURF : 0);
      }
    }
    expect(coincident).toBe(16);
  });

  it('pins forced full-height corners where a waterfall meets a pool, and agrees on every shared vertex', () => {
    const m = buildMesh(poolWithWaterfall());
    checkInvariants(m);
    const flags = waveFlagsByPosition(m.translucent);
    // the pool corners around the column's foot are forced to 1.0 (y = 3) and pinned
    for (const [x, z] of [
      [3, 3],
      [4, 3],
      [3, 4],
      [4, 4],
    ] as const) {
      expect(flags.get(key(x, 3, z)), `corner ${x},${z}`).toBe(0);
    }
    // the open pool surface and the source's rim wave
    expect(flags.get(key(1, 2 + 14 / 16, 1))).toBe(SURF);
    expect(flags.get(key(3, 5 + 14 / 16, 3))).toBe(SURF);
    // column walls: floor and full-height corners pinned
    expect(flags.get(key(3, 4, 3))).toBe(0);
  });

  it('fuzz: coincident liquid vertices always agree on the wave flag', () => {
    const rng = new Rng(99);
    for (let t = 0; t < 40; t++) {
      const n = rng.int(2, 6);
      const input = makeInput(n, n, n, true);
      for (let i = 0; i < input.cells.length; i++) {
        const r = rng.next();
        input.cells[i] = r < 0.45 ? water(rng.int(0, 7), rng.chance(0.3)) : r < 0.6 ? makeCell(B.STONE) : r < 0.65 ? makeCell(B.GLASS) : 0;
      }
      const m = buildMesh(input);
      checkInvariants(m);
      waveFlagsByPosition(m.translucent);
    }
  });
});

describe('liquid boundaries seen from inside the liquid', () => {
  /**
   * Regression (review): a swimmer under the pool looks obliquely up into the waterfall
   * column. The ray crosses the surface plane inside the column's footprint (where the pool
   * cell correctly has no top face) and leaves the column through its +X wall into open air.
   * With outward-only side faces nothing on that ray faces the viewer, so a renderer that
   * culls back faces showed a sky-coloured hole in the underside of the lake.
   */
  const mesh = buildMesh(poolWithWaterfall());
  const eye: V = [1.5, 1.5, 5.5];

  it('control: looking straight up from under the pool surface hits the surface', () => {
    expect(frontHits(mesh.translucent, eye, [0, 1, 0])).toBeGreaterThan(0);
  });

  it('a swimmer looking up into a waterfall column sees its wall (no sky-coloured hole)', () => {
    // Crosses the plane y = 3 at (3.4, 3, 3.7), then leaves the column through x = 4.
    const through: V = [3.4, 3.0, 3.7];
    const dir: V = [through[0] - eye[0], through[1] - eye[1], through[2] - eye[2]];
    expect(frontHits(mesh.translucent, eye, dir)).toBeGreaterThan(0);
  });

  it('a swimmer inside the column sees every wall around it', () => {
    const inside: V = [3.5, 3.5, 3.5];
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as V[]) {
      expect(frontHits(mesh.translucent, inside, d), `dir ${d.join(',')}`).toBeGreaterThan(0);
    }
  });
});
