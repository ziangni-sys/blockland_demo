/**
 * Review (robustness): liquid boundaries must be visible from INSIDE the liquid.
 *
 * Scene: a 7x2x7 pool of still water on stone with a waterfall column standing on it
 * (falling cells at y = 3, 4 and a source at y = 5, all at x = z = 3). A swimmer under the
 * pool surface looks obliquely up into the column: the ray crosses the surface plane inside
 * the column's footprint (where, correctly, the pool cell has no top face because the
 * same liquid is above it) and then leaves the column through its +X wall into open air.
 *
 * Along that ray there is exactly one water/air boundary: the column wall. A renderer that
 * culls back faces (the convention in mesher.ts) can only show it if some liquid face on the
 * ray faces the viewer. Today the column's side faces are emitted single-sided, facing out,
 * so nothing on the ray faces the viewer and the swimmer sees a sky-coloured window in the
 * underside of the lake wherever a waterfall enters it.
 *
 * The control case checks the helper: a ray straight up away from the column does hit the
 * (double-sided) surface from below.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { buildMesh } from '../../src/mesh/mesher';
import type { GeometryData, MeshInput } from '../../src/mesh/types';
import { makeInput, put } from './helpers';

function poolWithWaterfall(): MeshInput {
  const input = makeInput(7, 6, 7);
  for (let z = -1; z <= 7; z++) {
    for (let x = -1; x <= 7; x++) {
      put(input, x, -1, z, makeCell(B.STONE));
      put(input, x, 0, z, makeCell(B.STONE));
      const inside = x >= 0 && x < 7 && z >= 0 && z < 7;
      for (let y = 1; y <= 2; y++) put(input, x, y, z, inside ? makeCell(B.WATER, 0) : makeCell(B.STONE));
    }
  }
  put(input, 3, 3, 3, makeCell(B.WATER, liquidState(0, true)));
  put(input, 3, 4, 3, makeCell(B.WATER, liquidState(0, true)));
  put(input, 3, 5, 3, makeCell(B.WATER, 0));
  return input;
}

type V = [number, number, number];

/** Number of triangles of g hit by the ray (t > eps) whose normal faces the ray origin. */
function frontHits(g: GeometryData | null, o: V, d: V): number {
  if (!g) return 0;
  let hits = 0;
  const P = g.positions;
  for (let t = 0; t < g.indexCount; t += 3) {
    const ia = g.indices[t]!, ib = g.indices[t + 1]!, ic = g.indices[t + 2]!;
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
    const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (tt > 1e-6) hits++;
  }
  return hits;
}

describe('review: liquid boundaries seen from inside the liquid', () => {
  const mesh = buildMesh(poolWithWaterfall());
  const eye: V = [1.5, 1.5, 5.5];

  it('control: looking straight up from under the pool surface hits the surface', () => {
    expect(frontHits(mesh.translucent, eye, [0, 1, 0])).toBeGreaterThan(0);
  });

  it('a swimmer looking up into a waterfall column sees its wall (no sky-coloured hole)', () => {
    // Crosses the surface plane y = 3 at (3.4, 3, 3.7), inside the column footprint, then
    // leaves the column through its +X wall at about (4, 3.47, 3.13) into open air.
    const through: V = [3.4, 3.0, 3.7];
    const dir: V = [through[0] - eye[0], through[1] - eye[1], through[2] - eye[2]];
    expect(frontHits(mesh.translucent, eye, dir)).toBeGreaterThan(0);
  });
});
