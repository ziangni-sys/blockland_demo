/**
 * The pure overlay builders of render/three/boxgeom.ts for partial cells (docs/SHAPES.md 8.6):
 * the target outline and the crack shell of an octant mask, the glue decal and bead of a face's
 * quadrant mask. Each is checked against an independent reading of the rule over all masks, and
 * a whole block's mask against the unit-cube geometry these overlays had before shapes existed.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { quadrantOctant } from '../../src/blocks/shapes';
import type { Dir } from '../../src/core/dirs';
import { beadStrips, crackShell, FACE_ROT, faceQuads, localQuadrants, outlineSegments, type OverlayGeometry } from '../../src/render/three/boxgeom';

const filled = (fill: number, i: number, j: number, k: number): boolean =>
  i >= 0 && i <= 1 && j >= 0 && j <= 1 && k >= 0 && k <= 1 && ((fill >> (i | (j << 1) | (k << 2))) & 1) === 1;

/** Point on axis a at t, the two other axes (u < v) at u, v. */
function pt(a: number, t: number, u: number, v: number): [number, number, number] {
  const p: [number, number, number] = [0, 0, 0];
  p[a] = t;
  p[a === 0 ? 1 : 0] = u;
  p[a === 2 ? 1 : 2] = v;
  return p;
}

/** The rule of 8.6, read independently: half edges (axis, t, u, v in half units) that are drawn. */
function drawnHalfEdges(fill: number): Set<string> {
  const out = new Set<string>();
  for (let a = 0; a < 3; a++) {
    for (let t = 0; t < 2; t++) {
      for (let u = 0; u <= 2; u++) {
        for (let v = 0; v <= 2; v++) {
          const f = [0, 1, 2, 3].map((q) => {
            const p = pt(a, t, u - 1 + (q & 1), v - 1 + (q >> 1));
            return filled(fill, p[0], p[1], p[2]);
          });
          const n = f.filter(Boolean).length;
          const diagonal = n === 2 && f[0] === f[3];
          if (n === 1 || n === 3 || diagonal) out.add(`${a},${t},${u},${v}`);
        }
      }
    }
  }
  return out;
}

/** Drawn diagonal half edges [axis, t, u, v, emptyQuadrantA, emptyQuadrantB] (quadrant q = ju | jv << 1 around the line). */
function diagonalHalfEdges(fill: number): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < 3; a++) {
    for (let t = 0; t < 2; t++) {
      for (let u = 0; u <= 2; u++) {
        for (let v = 0; v <= 2; v++) {
          const f = [0, 1, 2, 3].map((q) => {
            const p = pt(a, t, u - 1 + (q & 1), v - 1 + (q >> 1));
            return filled(fill, p[0], p[1], p[2]);
          });
          if (f.filter(Boolean).length === 2 && f[0] === f[3]) {
            const empty = [0, 1, 2, 3].filter((q) => !f[q]);
            out.push([a, t, u, v, empty[0]!, empty[1]!]);
          }
        }
      }
    }
  }
  return out;
}

/** True when some segment passes within 1e-6 of point p. */
function coversPoint(seg: Float32Array, p: number[]): boolean {
  for (let i = 0; i < seg.length; i += 6) {
    const a = [seg[i]!, seg[i + 1]!, seg[i + 2]!];
    const b = [seg[i + 3]!, seg[i + 4]!, seg[i + 5]!];
    const d = [0, 1, 2].map((k) => b[k]! - a[k]!);
    const len2 = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
    const f = Math.max(0, Math.min(1, [0, 1, 2].reduce((s, k) => s + (p[k]! - a[k]!) * d[k]!, 0) / len2));
    const dist = Math.hypot(...[0, 1, 2].map((k) => a[k]! + d[k]! * f - p[k]!));
    if (dist < 1e-6) return true;
  }
  return false;
}

/** Half edges covered by un-inflated segments (each axis-aligned, endpoints on the half lattice). */
function coveredHalfEdges(seg: Float32Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < seg.length; i += 6) {
    const p = [seg[i]! * 2, seg[i + 1]! * 2, seg[i + 2]! * 2];
    const q = [seg[i + 3]! * 2, seg[i + 4]! * 2, seg[i + 5]! * 2];
    const axes = [0, 1, 2].filter((k) => p[k] !== q[k]);
    expect(axes.length).toBe(1);
    const a = axes[0]!;
    const others = [0, 1, 2].filter((k) => k !== a);
    for (let t = Math.min(p[a]!, q[a]!); t < Math.max(p[a]!, q[a]!); t++) out.add(`${a},${t},${p[others[0]!]},${p[others[1]!]}`);
  }
  return out;
}

/** Segments as a sorted list of strings (endpoint order ignored), rounded. */
function segmentSet(seg: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < seg.length; i += 6) {
    const a = [seg[i]!, seg[i + 1]!, seg[i + 2]!].map((x) => x.toFixed(5)).join(' ');
    const b = [seg[i + 3]!, seg[i + 4]!, seg[i + 5]!].map((x) => x.toFixed(5)).join(' ');
    out.push(a < b ? `${a} | ${b}` : `${b} | ${a}`);
  }
  return out.sort();
}

/** The 12 edges of a box. */
function boxEdgeList(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const c = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  return e.flatMap((k) => c[k]!);
}

/** Triangles of an indexed geometry as sorted strings of (position, uv) corners, rotation-normalised. */
function triangleSet(pos: ArrayLike<number>, uv: ArrayLike<number>, idx: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const corners = [0, 1, 2].map((k) => {
      const v = idx[t + k]!;
      return [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!, uv[v * 2]!, uv[v * 2 + 1]!].map((x) => (Math.abs(x) < 5e-7 ? 0 : x).toFixed(5)).join(' ');
    });
    // Same triangle with the same winding whatever corner it starts at.
    let best = corners;
    for (let r = 1; r < 3; r++) {
      const c = [corners[r]!, corners[(r + 1) % 3]!, corners[(r + 2) % 3]!];
      if (c.join() < best.join()) best = c;
    }
    out.push(best.join(' / '));
  }
  return out.sort();
}

function geoTriangles(g: OverlayGeometry): string[] {
  return triangleSet(g.positions, g.uvs, g.indices);
}
function threeTriangles(g: THREE.BufferGeometry): string[] {
  return triangleSet(g.getAttribute('position').array, g.getAttribute('uv').array, g.getIndex()!.array);
}

/** Face tile coordinates of a point on face d (the convention of three's BoxGeometry). */
function tileUV(d: number, p: number[]): [number, number] {
  switch (d) {
    case 0:
      return [1 - p[2]!, p[1]!];
    case 1:
      return [p[2]!, p[1]!];
    case 2:
      return [p[0]!, 1 - p[2]!];
    case 3:
      return [p[0]!, p[2]!];
    case 4:
      return [p[0]!, p[1]!];
    default:
      return [1 - p[0]!, p[1]!];
  }
}

const NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

describe('target outline of an octant mask (docs/SHAPES.md 8.6)', () => {
  it('a whole block: exactly the 12 edges of the unit cube grown by the inflation (the outline it always had)', () => {
    const e = 0.004;
    expect(segmentSet(outlineSegments(0xff, e))).toEqual(segmentSet(boxEdgeList(-e, -e, -e, 1 + e, 1 + e, 1 + e)));
  });

  it('a half slab and one octant: the 12 edges of their box, grown outwards', () => {
    const e = 0.004;
    expect(segmentSet(outlineSegments(0x33, e))).toEqual(segmentSet(boxEdgeList(-e, -e, -e, 1 + e, 0.5 + e, 1 + e)));
    expect(segmentSet(outlineSegments(0xcc, e))).toEqual(segmentSet(boxEdgeList(-e, 0.5 - e, -e, 1 + e, 1 + e, 1 + e)));
    for (let o = 0; o < 8; o++) {
      const x = (o & 1) * 0.5;
      const y = ((o >> 1) & 1) * 0.5;
      const z = ((o >> 2) & 1) * 0.5;
      expect(segmentSet(outlineSegments(1 << o, e))).toEqual(segmentSet(boxEdgeList(x - e, y - e, z - e, x + 0.5 + e, y + 0.5 + e, z + 0.5 + e)));
    }
  });

  it('every mask: a half edge is drawn iff 1 or 3 of its 4 octants are filled, or 2 diagonal ones; nothing for an empty mask', () => {
    expect(outlineSegments(0, 0.004).length).toBe(0);
    for (let fill = 1; fill < 256; fill++) {
      const seg = outlineSegments(fill, 0);
      const covered = coveredHalfEdges(seg);
      expect([...covered].sort(), `fill ${fill.toString(16)}`).toEqual([...drawnHalfEdges(fill)].sort());
      // Collinear runs are merged (no two segments share an endpoint on the same line with the same
      // push); a diagonal half edge is drawn twice, once into each of its empty quadrants.
      expect(seg.length / 6, `fill ${fill.toString(16)}`).toBeLessThanOrEqual(covered.size + diagonalHalfEdges(fill).length);
    }
  });

  it('a diagonal edge is drawn twice, pushed into each of its two empty quadrants', () => {
    const e = 0.004;
    let seen = 0;
    for (let fill = 1; fill < 256; fill++) {
      const seg = outlineSegments(fill, e);
      for (const [a, t, u, v, emptyA, emptyB] of diagonalHalfEdges(fill)) {
        // The midpoint of the half edge, pushed by e into each empty quadrant (+-1 per axis).
        for (const q of [emptyA, emptyB]) {
          const mid = pt(a, (t + 0.5) * 0.5, u * 0.5 + (q & 1 ? e : -e), v * 0.5 + (q & 2 ? e : -e));
          const onSome = coversPoint(seg, mid);
          expect(onSome, `fill ${fill.toString(16)} edge ${[a, t, u, v].join(',')} quadrant ${q}`).toBe(true);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(100);
  });

  it('every mask: the inflated outline stays outside the shape (no end inside a filled octant; the line itself off every filled octant by the inflation)', () => {
    const e = 0.004;
    for (let fill = 1; fill < 256; fill++) {
      const seg = outlineSegments(fill, e);
      const boxes: number[][] = [];
      for (let o = 0; o < 8; o++) if ((fill >> o) & 1) boxes.push([(o & 1) * 0.5, ((o >> 1) & 1) * 0.5, ((o >> 2) & 1) * 0.5]);
      // Inside the box grown by g (g < 0: strictly inside by more than -g).
      const inBox = (p: number[], lo: number[], g: number): boolean => [0, 1, 2].every((k) => p[k]! > lo[k]! - g && p[k]! < lo[k]! + 0.5 + g);
      for (let i = 0; i < seg.length; i += 6) {
        const a = [seg[i]!, seg[i + 1]!, seg[i + 2]!];
        const b = [seg[i + 3]!, seg[i + 4]!, seg[i + 5]!];
        for (const lo of boxes) {
          for (const p of [a, b]) expect(inBox(p, lo, -1e-6), `fill ${fill.toString(16)} end ${p.join(',')}`).toBe(false);
          // Points along the line (away from its ends): off the octant by at least half the inflation.
          for (const f of [0.25, 0.5, 0.75]) {
            const p = [0, 1, 2].map((k) => a[k]! + (b[k]! - a[k]!) * f);
            expect(inBox(p, lo, e / 2), `fill ${fill.toString(16)} point ${p.join(',')}`).toBe(false);
          }
        }
      }
    }
  });
});

describe('crack shell of an octant mask (docs/SHAPES.md 8.6)', () => {
  it("a whole block: the crack box it always had (BoxGeometry(1.006) around the cell's centre), same triangles and tile coordinates", () => {
    const box = new THREE.BoxGeometry(1.006, 1.006, 1.006);
    box.translate(0.5, 0.5, 0.5);
    expect(geoTriangles(crackShell(0xff, 0.003))).toEqual(threeTriangles(box));
    box.dispose();
  });

  it('every mask: exactly the outer quarter faces (filled octant, its neighbour across the face not in the mask), facing out, tile coordinates from the position', () => {
    for (let fill = 0; fill < 256; fill++) {
      const g = crackShell(fill, 0);
      // Expected quarter faces: (octant, dir).
      let quarters = 0;
      for (let o = 0; o < 8; o++) {
        if (((fill >> o) & 1) === 0) continue;
        for (let d = 0; d < 6; d++) {
          const a = d >> 1;
          const c = [o & 1, (o >> 1) & 1, (o >> 2) & 1];
          c[a] += (d & 1) === 0 ? 1 : -1;
          if (!filled(fill, c[0]!, c[1]!, c[2]!)) quarters++;
        }
      }
      // Area: each quad's area, summed, equals the number of quarter faces times 1/4.
      let area = 0;
      for (let t = 0; t < g.indices.length; t += 3) {
        const v = [0, 1, 2].map((k) => g.indices[t + k]!);
        const p = v.map((i) => new THREE.Vector3(g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!));
        const cross = p[1]!.clone().sub(p[0]!).cross(p[2]!.clone().sub(p[0]!));
        area += cross.length() / 2;
        const n = new THREE.Vector3(g.normals[v[0]! * 3]!, g.normals[v[0]! * 3 + 1]!, g.normals[v[0]! * 3 + 2]!);
        // Counter-clockwise seen from outside, along the stored normal.
        expect(cross.dot(n), `fill ${fill.toString(16)}`).toBeGreaterThan(0);
        // In front of the face: a filled octant behind it, an unfilled one (or the outside) in front.
        const centre = p[0]!.clone().add(p[1]!).add(p[2]!).divideScalar(3);
        const behind = centre.clone().addScaledVector(n, -0.25).multiplyScalar(2);
        const ahead = centre.clone().addScaledVector(n, 0.25).multiplyScalar(2);
        expect(filled(fill, Math.floor(behind.x), Math.floor(behind.y), Math.floor(behind.z))).toBe(true);
        expect(filled(fill, Math.floor(ahead.x), Math.floor(ahead.y), Math.floor(ahead.z))).toBe(false);
        const d = NORMALS.findIndex((m) => m[0] === n.x && m[1] === n.y && m[2] === n.z);
        for (const i of v) {
          const [tu, tv] = tileUV(d, [g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!]);
          expect(g.uvs[i * 2]).toBeCloseTo(tu, 6);
          expect(g.uvs[i * 2 + 1]).toBeCloseTo(tv, 6);
        }
      }
      expect(area, `fill ${fill.toString(16)}`).toBeCloseTo(quarters * 0.25, 6);
    }
  });

  it('a single octant (the chisel\'s timed progress, mining.sub bit 3): its six faces, pushed out by the offset', () => {
    for (let o = 0; o < 8; o++) {
      const g = crackShell(1 << o, 0.003);
      expect(g.indices.length).toBe(6 * 6);
      const lo = [(o & 1) * 0.5 - 0.003, ((o >> 1) & 1) * 0.5 - 0.003, ((o >> 2) & 1) * 0.5 - 0.003];
      for (let i = 0; i < g.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const x = g.positions[i + k]!;
          expect(Math.abs(x - lo[k]!) < 1e-6 || Math.abs(x - (lo[k]! + 0.506)) < 1e-6).toBe(true);
        }
      }
    }
  });
});

describe('glue faces over quadrants (docs/SHAPES.md 2.3, 8.6)', () => {
  it("local squares: quadrant q of face d lies where its octant's face is, in the overlay's frame (FACE_ROT[d])", () => {
    for (let d = 0 as Dir; d < 6; d = (d + 1) as Dir) {
      const r = FACE_ROT[d]!;
      for (let q = 0; q < 4; q++) {
        const local = localQuadrants(d, 1 << q);
        expect([1, 2, 4, 8]).toContain(local);
        const s = Math.log2(local);
        // The square's centre in the overlay frame, turned into the cell: the octant's face centre.
        const lx = (s & 1) === 1 ? 0.25 : -0.25;
        const ly = (s & 2) === 2 ? 0.25 : -0.25;
        const w = [r[0]! * lx + r[3]! * ly, r[1]! * lx + r[4]! * ly, r[2]! * lx + r[5]! * ly];
        const o = quadrantOctant(d, q);
        const a = d >> 1;
        for (let k = 0; k < 3; k++) {
          if (k === a) continue;
          expect(w[k]).toBeCloseTo(((o >> k) & 1) === 1 ? 0.25 : -0.25, 9);
        }
      }
      expect(localQuadrants(d, 15)).toBe(15);
      expect(localQuadrants(d, 0)).toBe(0);
    }
  });

  it('decal / ghost: the whole face is the 1 x 1 quad it always was (PlaneGeometry(1, 1)); a mask is its squares, each showing its part of the tile', () => {
    const plane = new THREE.PlaneGeometry(1, 1);
    expect(geoTriangles(faceQuads(15))).toEqual(threeTriangles(plane));
    plane.dispose();
    for (let m = 1; m < 15; m++) {
      const g = faceQuads(m);
      const n = [0, 1, 2, 3].filter((s) => (m >> s) & 1).length;
      expect(g.indices.length).toBe(n * 6);
      for (let i = 0; i < g.positions.length; i += 3) {
        expect(g.positions[i + 2]).toBe(0);
        const k = i / 3;
        expect(g.uvs[k * 2]).toBeCloseTo(g.positions[i]! + 0.5, 9);
        expect(g.uvs[k * 2 + 1]).toBeCloseTo(g.positions[i + 1]! + 0.5, 9);
      }
      // Each quad is one of the mask's squares: [i/2 - 1/2, i/2] x [j/2 - 1/2, j/2] with bit (i | j << 1) set.
      const seen = new Set<number>();
      for (let t = 0; t < g.indices.length; t += 6) {
        const xs = [0, 1, 2, 5].map((k) => g.positions[g.indices[t + k]! * 3]!);
        const ys = [0, 1, 2, 5].map((k) => g.positions[g.indices[t + k]! * 3 + 1]!);
        const i = Math.round((Math.min(...xs) + 0.5) * 2);
        const j = Math.round((Math.min(...ys) + 0.5) * 2);
        expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.5, 9);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.5, 9);
        seen.add(i | (j << 1));
      }
      expect([...seen].reduce((acc, s) => acc | (1 << s), 0)).toBe(m);
    }
  });

  it('bead: the whole face gives the four sides of the old bead box; a mask gives bands along the outline of its squares, facing out', () => {
    const w = 0.26;
    const lift = 0.006;
    const h = 0.5 + lift;
    // The bead geometry before shapes existed: four sides of [-h, h]^2 x [-w/2, w/2].
    const sides = [
      { n: [1, 0, 0], a: [h, -h], b: [h, h] },
      { n: [0, 1, 0], a: [h, h], b: [-h, h] },
      { n: [-1, 0, 0], a: [-h, h], b: [-h, -h] },
      { n: [0, -1, 0], a: [-h, -h], b: [h, -h] },
    ];
    const pos: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    sides.forEach((s, i) => {
      pos.push(s.a[0]!, s.a[1]!, -w / 2, s.b[0]!, s.b[1]!, -w / 2, s.b[0]!, s.b[1]!, w / 2, s.a[0]!, s.a[1]!, w / 2);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    expect(geoTriangles(beadStrips(15, w, lift))).toEqual(triangleSet(pos, uvs, idx));

    for (let m = 1; m < 16; m++) {
      const g = beadStrips(m, w, lift);
      const set = (i: number, j: number): boolean => i >= 0 && i <= 1 && j >= 0 && j <= 1 && ((m >> (i | (j << 1))) & 1) === 1;
      // Outline length in half edges: square sides between a set square and an unset one.
      let halfEdges = 0;
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if (set(i, j)) for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!set(i + di!, j + dj!)) halfEdges++;
      let length = 0;
      for (let t = 0; t < g.indices.length; t += 6) {
        const a = g.indices[t]!;
        const b = g.indices[t + 1]!;
        const ax = g.positions[a * 3]!;
        const ay = g.positions[a * 3 + 1]!;
        const bx = g.positions[b * 3]!;
        const by = g.positions[b * 3 + 1]!;
        length += Math.hypot(bx - ax, by - ay);
        // The band faces away from the set squares: a step back along its normal is over a set
        // square, a step forward over an unset one (or off the face).
        const nx = g.normals[a * 3]!;
        const ny = g.normals[a * 3 + 1]!;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const sq = (x: number, y: number): boolean => set(Math.floor((x + 0.5) * 2), Math.floor((y + 0.5) * 2));
        expect(sq(mx - nx * 0.1, my - ny * 0.1), `mask ${m}`).toBe(true);
        expect(sq(mx + nx * 0.1, my + ny * 0.1), `mask ${m}`).toBe(false);
        // Across the seam: from -w/2 to w/2.
        expect(g.positions[a * 3 + 2]).toBeCloseTo(-w / 2, 6);
        expect(g.positions[g.indices[t + 2]! * 3 + 2]).toBeCloseTo(w / 2, 6);
      }
      // Each half edge once, plus at most the lift at each end of every band.
      expect(length, `mask ${m}`).toBeGreaterThanOrEqual(halfEdges * 0.5 - 4 * lift * (g.indices.length / 6) - 1e-9);
      expect(length, `mask ${m}`).toBeLessThanOrEqual(halfEdges * 0.5 + 2 * lift * (g.indices.length / 6) + 1e-9);
    }
  });
});
