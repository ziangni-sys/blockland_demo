/**
 * Adversarial review (correctness lens) — liquid surface seams.
 *
 * These tests are expected to FAIL against the current mesher; they document defects for the
 * fixer. See the review report for the analysis.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { buildMesh } from '../../src/mesh/mesher';
import { VFLAG_LIQUID_SURFACE } from '../../src/mesh/types';
import { allQuads, makeInput, put, putLight } from './helpers';

const H = 14 / 16;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('review: liquid top-surface smooth light is continuous across cells', () => {
  /**
   * Four still water sources in a 2x2 pool share the corner (1, 14/16, 1). Above the pool a
   * diagonal pair of stones sits at (1,1,0) and (0,1,1); the two open cells above are lit
   * differently (sky 15 at (0,1,0), sky 5 at (1,1,1)). Inside the water the light is a
   * uniform sky 13.
   *
   * The same physical vertex is shared by the four coplanar top quads, so it must carry ONE
   * light value, otherwise the surface shows a crease along the shared edges. The mesher's
   * "layer above" sample treats whichever cell sits above the quad's own cell as the base and
   * drops the diagonal only when both of *that* base's side cells are opaque. Above (0,0,0)
   * the base is open and both of its sides are stone, so only sky 15 is used (255); above the
   * other three cells the base is stone or the diagonal is not dropped, giving 170 / 85, and
   * max() with the own layer (221) leaves 221. Result: 255 vs 221 at the same vertex.
   */
  it('gives every quad the same light at a shared corner even with an opaque cell above', () => {
    const input = makeInput(2, 2, 2, 0);
    for (const [x, z] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      put(input, x, 0, z, makeCell(B.WATER, liquidState(0, false)));
      putLight(input, x, 0, z, 13, 0);
    }
    put(input, 1, 1, 0, makeCell(B.STONE)); // light 0, as the light engine stores for opaque cells
    put(input, 0, 1, 1, makeCell(B.STONE));
    putLight(input, 0, 1, 0, 15, 0);
    putLight(input, 1, 1, 1, 5, 0);

    const tops = allQuads(buildMesh(input)).filter((q) => (q.flags[0]! & VFLAG_LIQUID_SURFACE) !== 0 && q.n.y > 0);
    expect(tops.length).toBe(4);
    const skyAtSharedCorner = tops.map((q) => {
      const k = q.p.findIndex((p) => near(p.x, 1) && near(p.y, H) && near(p.z, 1));
      expect(k).toBeGreaterThanOrEqual(0);
      return q.sky[k]!;
    });
    // Currently [255, 221, 221, 221] (in some order): a visible light seam on the water.
    expect(new Set(skyAtSharedCorner).size).toBe(1);
  });
});

describe('review: liquid edge vertices move together under the wave flag', () => {
  /**
   * GeometryData.light flags: bit 1 = "liquid surface (wave in shader)". The render backend
   * displaces every flagged vertex vertically (src/render/three/shading.ts waveHeight, about
   * -0.084 .. +0.014 blocks). The top surface's corners are flagged, but the coincident top
   * corners of the liquid's SIDE faces are not, so at every exposed water edge the surface
   * and the side wall separate (a rim when the wave is low, a slit when it is high).
   * A watertight liquid needs coincident vertices to carry the same displacement flag.
   */
  it('flags the side faces\' top-edge vertices like the surface vertices they coincide with', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, makeCell(B.WATER, liquidState(0, false)));
    const qs = allQuads(buildMesh(input));
    const surf = qs.filter((q) => (q.flags[0]! & VFLAG_LIQUID_SURFACE) !== 0);
    const sides = qs.filter((q) => q.nb[1] === 0);
    expect(sides.length).toBe(4);
    let coincident = 0;
    for (const s of sides) {
      for (let k = 0; k < 4; k++) {
        const p = s.p[k]!;
        const onSurface = surf.some((t) => t.p.some((o) => near(o.x, p.x) && near(o.y, p.y) && near(o.z, p.z)));
        if (!onSurface) continue;
        coincident++;
        expect(s.flags[k]! & VFLAG_LIQUID_SURFACE, `side vertex ${p.x},${p.y},${p.z}`).toBe(VFLAG_LIQUID_SURFACE);
      }
    }
    expect(coincident).toBe(8);
  });
});
