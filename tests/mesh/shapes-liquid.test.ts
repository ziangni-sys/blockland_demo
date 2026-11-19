/**
 * Liquids next to, on and under partial cells (docs/SHAPES.md 8.4): the two copies of every liquid
 * face are cut per quadrant (outward copy by the neighbour's opaque cover, inside copy by its seal
 * cover), side faces are clipped at the midpoint and at y = 0.5 without moving any existing vertex.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { LIQUID_FULL_HEIGHT, buildMesh } from '../../src/mesh/mesher';
import { VFLAG_LIQUID_SURFACE, type MeshData, type MeshInput } from '../../src/mesh/types';
import { LOWER, UPPER, WEST, slab } from '../shapes';
import { allQuads, checkInvariants, cornerAt, dirOfQuad, makeInput, put, putLight, type Quad, type V3 } from './helpers';
import { putParts, quadArea } from './shape-helpers';

const water = (level = 0, falling = false) => makeCell(B.WATER, liquidState(level, falling));
const EAST = 0xaa;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Liquid quads (translucent group) whose corners all lie on the plane axis = c, facing Dir d. */
function liquidOn(m: MeshData, axis: 'x' | 'y' | 'z', c: number, d: number): Quad[] {
  return allQuads(m).filter((q) => q.group === 'translucent' && dirOfQuad(q) === d && q.p.every((p) => near(p[axis], c)));
}
const area = (qs: Quad[]) => qs.reduce((s, q) => s + quadArea(q), 0);

/** Water source at (0,0,0) in a 2x1x1 box, the cell (1,0,0) made of the given parts. */
function besideSide(a: number, b = 0, waterCell = water()): MeshData {
  const input = makeInput(2, 1, 1, true);
  put(input, 0, 0, 0, waterCell);
  putParts(input, 1, 0, 0, a, b);
  const m = buildMesh(input);
  checkInvariants(m, { paddedTriangles: true });
  return m;
}

describe('liquid side faces beside partial cells', () => {
  const H = LIQUID_FULL_HEIGHT;

  it('a glass lower slab: the outward copy is whole, the inside copy only above the slab', () => {
    const m = besideSide(slab(B.GLASS, LOWER));
    expect(area(liquidOn(m, 'x', 1, 0))).toBeCloseTo(H, 9);
    expect(area(liquidOn(m, 'x', 1, 1))).toBeCloseTo(H - 0.5, 9);
  });

  it('a stone lower slab: both copies only above it; a stone west slab (whole face covered): no face at all', () => {
    const m = besideSide(slab(B.STONE, LOWER));
    expect(area(liquidOn(m, 'x', 1, 0))).toBeCloseTo(H - 0.5, 9);
    expect(area(liquidOn(m, 'x', 1, 1))).toBeCloseTo(H - 0.5, 9);
    const w = besideSide(slab(B.STONE, WEST));
    expect(liquidOn(w, 'x', 1, 0).length + liquidOn(w, 'x', 1, 1).length).toBe(0);
  });

  it('a slab on the far side of the cell leaves the face as it is without the slab, byte for byte', () => {
    const withSlab = besideSide(slab(B.STONE, EAST));
    const input = makeInput(2, 1, 1, true);
    put(input, 0, 0, 0, water());
    const without = buildMesh(input);
    const liquid = (m: MeshData) => allQuads(m).filter((q) => q.group === 'translucent');
    expect(liquid(withSlab)).toEqual(liquid(without));
  });

  it('a sloped surface crossing y = 0.5 is clipped exactly: areas, pieces, no moved vertex', () => {
    // Column x = 1: amounts 1, 4, 8 along z. The +X face of (1,0,1) has top corners at the averages of
    // neighbouring heights: z = 1 -> (h1 + h4) / 2, z = 2 -> (h4 + h8) / 2; it crosses 0.5 near z = 2.
    const h = (amount: number) => (amount / 8) * LIQUID_FULL_HEIGHT;
    const build = (neighbour: 'stone' | 'glass' | 'air', fill = LOWER): { m: MeshData; input: MeshInput } => {
      const input = makeInput(3, 1, 3, true);
      put(input, 1, 0, 0, water(7));
      put(input, 1, 0, 1, water(4));
      put(input, 1, 0, 2, water(0));
      for (let y = 0; y < 1; y++) for (let z = -1; z <= 3; z++) putLight(input, 2, y, z, 6 + z, z + 2);
      if (neighbour !== 'air') putParts(input, 2, 0, 1, slab(neighbour === 'stone' ? B.STONE : B.GLASS, fill));
      const m = buildMesh(input);
      checkInvariants(m, { paddedTriangles: true });
      return { m, input };
    };
    const z1 = (h(1) + h(4)) / 2;
    const z2 = (h(4) + h(8)) / 2;
    // Exact area of the part of the trapezoid above y = 0.5: integrate max(0, H(z) - 0.5) over z in [1, 2].
    const steps = 200000;
    let above = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      above += Math.max(0, z1 + (z2 - z1) * t - 0.5) / steps;
    }
    const total = (z1 + z2) / 2;
    const face = (m: MeshData, d: number) => liquidOn(m, 'x', 2, d).filter((q) => q.p.every((p) => p.z >= 1 - 1e-9 && p.z <= 2 + 1e-9));
    const stone = build('stone').m;
    expect(area(face(stone, 0))).toBeCloseTo(above, 5);
    expect(area(face(stone, 1))).toBeCloseTo(above, 5);
    const glass = build('glass').m;
    expect(area(face(glass, 0))).toBeCloseTo(total, 9);
    expect(area(face(glass, 1))).toBeCloseTo(above, 5);
    // An upper stone slab leaves the lower quadrants of both halves: the face is clipped once (not
    // split at z = 1.5), and since its top line crosses y = 0.5 the part below is a pentagon (a quad and
    // a padded triangle).
    const upper = build('stone', UPPER).m;
    expect(area(face(upper, 0))).toBeCloseTo(total - above, 5);
    expect(area(face(upper, 1))).toBeCloseTo(total - above, 5);
    expect(face(upper, 0).length).toBe(2);
    expect(face(stone, 0).length).toBe(1);

    // The whole face of the M1 path (neighbour = air) gives the original corners.
    const whole = face(build('air').m, 0);
    expect(whole.length).toBe(1);
    const w = whole[0]!;
    for (const pieces of [face(stone, 0), face(stone, 1), face(glass, 1), face(upper, 0), face(upper, 1)]) {
      for (const q of pieces) {
        for (let k = 0; k < 4; k++) {
          const p = q.p[k]!;
          // Every neighbour here keeps the same quadrants in both halves of the face, so new vertices
          // lie only on y = 0.5 (none on the midpoint line z = 1.5).
          const original = w.p.findIndex((o) => near(o.x, p.x) && near(o.y, p.y) && near(o.z, p.z));
          if (original < 0) expect(near(p.y, 0.5)).toBe(true);
          else {
            // An original corner keeps its light and wave flag.
            expect([q.sky[k], q.block[k], q.flags[k]]).toEqual([w.sky[original], w.block[original], w.flags[original]]);
          }
          // Every vertex lies inside the original face: under the line through the two top corners.
          const top = z1 + (z2 - z1) * (p.z - 1);
          expect(p.y).toBeLessThanOrEqual(top + 1e-6); // positions are 32-bit floats
        }
      }
    }
    // The glass outward copy is still the whole face in one quad, the same bytes as without the slab.
    expect(face(glass, 0)).toEqual(whole);
  });

  it('smooth light of a side face takes the light of a partial neighbour cell (it is not a whole-cell occluder)', () => {
    const input = makeInput(2, 1, 1, true);
    for (let i = 0; i < input.light!.length; i++) input.light![i] = 0;
    put(input, 0, 0, 0, water());
    putParts(input, 1, 0, 0, slab(B.STONE, LOWER));
    putLight(input, 1, 0, 0, 12);
    const m = buildMesh(input);
    const pieces = liquidOn(m, 'x', 1, 0);
    expect(pieces.length).toBeGreaterThan(0);
    // Every corner of the outward copy averages cells around it, the slab's cell among them (light 12).
    for (const q of pieces) for (const s of q.sky) expect(s).toBeGreaterThan(0);
  });

  it('a new vertex on the top edge follows the wave exactly when both top corners do', () => {
    // Heights below 1 on both corners: the midpoint top vertex of a clipped piece carries the flag.
    const m = besideSide(slab(B.STONE, makeQuarter()), 0);
    const pieces = liquidOn(m, 'x', 1, 0);
    let seen = 0;
    for (const q of pieces) {
      for (let k = 0; k < 4; k++) {
        if (near(q.p[k]!.z, 0.5) && near(q.p[k]!.y, LIQUID_FULL_HEIGHT)) {
          expect(q.flags[k]! & VFLAG_LIQUID_SURFACE).toBe(VFLAG_LIQUID_SURFACE);
          seen++;
        }
        if (q.p[k]!.y < LIQUID_FULL_HEIGHT - 1e-9) expect(q.flags[k]! & VFLAG_LIQUID_SURFACE).toBe(0);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

/** Octant 0 only (the lower, low-z quadrant of the -X face). */
function makeQuarter(): number {
  return 0x01;
}

describe('liquid on and under partial cells', () => {
  /** Water source at (0,1,0), the cell (0,0,0) below made of the given parts. */
  function onTop(a: number, b = 0): MeshData {
    const input = makeInput(1, 2, 1, true);
    put(input, 0, 1, 0, water());
    putParts(input, 0, 0, 0, a, b);
    const m = buildMesh(input);
    checkInvariants(m, { paddedTriangles: true });
    return m;
  }

  it('water over a lower slab: the bottom is open (both copies); over an upper stone slab: none; over an upper glass slab: outward only', () => {
    const low = onTop(slab(B.STONE, LOWER));
    expect(area(liquidOn(low, 'y', 1, 3))).toBeCloseTo(1, 9);
    expect(area(liquidOn(low, 'y', 1, 2))).toBeCloseTo(1, 9);
    const up = onTop(slab(B.STONE, UPPER));
    expect(liquidOn(up, 'y', 1, 3).length + liquidOn(up, 'y', 1, 2).length).toBe(0);
    const glass = onTop(slab(B.GLASS, UPPER));
    expect(area(liquidOn(glass, 'y', 1, 3))).toBeCloseTo(1, 9);
    expect(liquidOn(glass, 'y', 1, 2).length).toBe(0);
  });

  it('water over a west stone slab of the top half: the bottom is cut to the east quadrants', () => {
    const m = onTop(slab(B.STONE, UPPER & WEST));
    const out = liquidOn(m, 'y', 1, 3);
    const inside = liquidOn(m, 'y', 1, 2);
    expect(area(out)).toBeCloseTo(0.5, 9);
    expect(area(inside)).toBeCloseTo(0.5, 9);
    for (const q of [...out, ...inside]) for (const p of q.p) expect(p.x).toBeGreaterThanOrEqual(0.5);
  });

  /** A full-height water cell (all four corners forced to 1 by fed columns around it) under the given parts. */
  function under(a: number, b = 0): MeshData {
    const input = makeInput(3, 2, 3, true);
    for (let x = 0; x < 3; x++) {
      for (let z = 0; z < 3; z++) {
        put(input, x, 0, z, water());
        if (x !== 1) put(input, x, 1, z, water(0, true));
      }
    }
    putParts(input, 1, 1, 1, a, b);
    // Fill the rest of the layer above so the only plane in question is the cell (1,1,1)'s bottom.
    put(input, 1, 1, 0, makeCell(B.STONE));
    put(input, 1, 1, 2, makeCell(B.STONE));
    const m = buildMesh(input);
    checkInvariants(m, { paddedTriangles: true });
    return m;
  }
  const topOfMiddle = (m: MeshData, d: number) => liquidOn(m, 'y', 1, d).filter((q) => q.p.every((p) => p.x >= 1 && p.x <= 2 && p.z >= 1 && p.z <= 2));

  it('a full-height surface under a glass slab: outward only; under a west stone slab: the east half, both copies; no wave flags', () => {
    const glass = under(slab(B.GLASS, LOWER));
    expect(area(topOfMiddle(glass, 2))).toBeCloseTo(1, 9);
    expect(topOfMiddle(glass, 3).length).toBe(0);
    const west = under(slab(B.STONE, WEST));
    expect(area(topOfMiddle(west, 2))).toBeCloseTo(0.5, 9);
    expect(area(topOfMiddle(west, 3))).toBeCloseTo(0.5, 9);
    for (const q of [...topOfMiddle(west, 2), ...topOfMiddle(west, 3)]) {
      for (const p of q.p) expect(p.x).toBeGreaterThanOrEqual(1.5);
      expect(q.flags.every((f) => (f & VFLAG_LIQUID_SURFACE) === 0)).toBe(true);
    }
    const stone = under(slab(B.STONE, LOWER));
    expect(topOfMiddle(stone, 2).length + topOfMiddle(stone, 3).length).toBe(0);
  });

  it('the top surface light rises from the open half of a stone slab cell in the layer above (not an occluder)', () => {
    const input = makeInput(2, 2, 2, true);
    for (let i = 0; i < input.light!.length; i++) input.light![i] = 0;
    put(input, 0, 0, 0, water());
    putParts(input, 1, 1, 1, slab(B.STONE, UPPER));
    putLight(input, 1, 1, 1, 15);
    const top = allQuads(buildMesh(input)).find((q) => q.group === 'translucent' && q.nb[1] > 0)!;
    const k = top.p.findIndex((p) => near(p.x, 1) && near(p.z, 1));
    // The layer above around corner (1, 1): three dark air cells and the slab cell (light 15).
    expect(top.sky[k]).toBe(Math.round((15 * 17) / 4));
  });
});

describe('no two coplanar faces in any quadrant (8.4: all three cases)', () => {
  /**
   * For each quadrant centre of the plane axis = c inside [0,1]^2, the faces covering it by Dir.
   * Returns per quadrant a sorted list of "group:dir" of the quads lying on the plane over it.
   */
  function facesPerQuadrant(m: MeshData, axis: 'x' | 'y', c: number): string[][] {
    const others = axis === 'x' ? (['y', 'z'] as const) : (['x', 'z'] as const);
    const out: string[][] = [];
    for (const [a, b] of [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ] as const) {
      const here: string[] = [];
      for (const q of allQuads(m)) {
        if (!q.p.every((p) => near(p[axis], c))) continue;
        const us = q.p.map((p) => p[others[0]]);
        const vs = q.p.map((p) => p[others[1]]);
        if (Math.min(...us) <= a && Math.max(...us) >= a && Math.min(...vs) <= b && Math.max(...vs) >= b) here.push(`${q.group}:${dirOfQuad(q)}`);
      }
      out.push(here.sort());
    }
    return out;
  }

  for (const id of [B.GLASS, B.ICE]) {
    const g = id === B.GLASS ? 'cutout' : 'translucent';
    it(`water beside a cell of ${id === B.GLASS ? 'glass' : 'ice'} (octant 0) and stone (octant 4), octants 2 and 6 empty`, () => {
      // The neighbour's -X face toward the water: octant 0 -> its lower low-z quadrant, 4 -> lower high-z.
      const m = besideSide(slab(id, 0x01), slab(B.STONE, 0x10));
      const q = facesPerQuadrant(m, 'x', 1);
      // (y 0.25, z 0.25): the glass/ice part: water outward only, plus the part's own face toward the water.
      expect(q[0]).toEqual([`${g}:1`, 'translucent:0'].sort());
      // (y 0.25, z 0.75): the stone part: no water face, the stone face toward the water.
      expect(q[2]).toEqual(['opaque:1']);
      // Upper quadrants: empty in the neighbour: both water copies.
      expect(q[1]).toEqual(['translucent:0', 'translucent:1']);
      expect(q[3]).toEqual(['translucent:0', 'translucent:1']);
    });

    it(`water over a cell with ${id === B.GLASS ? 'glass' : 'ice'} in octant 2 and stone in octant 6, octants 3 and 7 empty`, () => {
      const input = makeInput(1, 2, 1, true);
      put(input, 0, 1, 0, water());
      putParts(input, 0, 0, 0, slab(id, 0x04), slab(B.STONE, 0x40));
      const m = buildMesh(input);
      checkInvariants(m, { paddedTriangles: true });
      const q = facesPerQuadrant(m, 'y', 1);
      // Quadrants of the plane y = 1 at (x, z): octant 2 -> (0.25, 0.25), 3 -> (0.75, 0.25), 6 -> (0.25, 0.75), 7 -> (0.75, 0.75).
      expect(q[0]).toEqual([`${g}:2`, 'translucent:3'].sort());
      expect(q[2]).toEqual(['opaque:2']);
      expect(q[1]).toEqual(['translucent:2', 'translucent:3']);
      expect(q[3]).toEqual(['translucent:2', 'translucent:3']);
    });
  }
});

describe('attributes of clipped liquid pieces (docs/SHAPES.md 19.6)', () => {
  /** Every padded cell gets a different-looking light byte, so the corners of a face all differ. */
  function patternLight(input: MeshInput): void {
    for (let i = 0; i < input.light!.length; i++) input.light![i] = ((i * 7) % 16 << 4) | ((i * 11 + 3) % 16);
  }

  /**
   * The value an attribute of the whole face `w` (four corners) takes at a point, bilinear in the
   * face's own frame: `s` along the horizontal axis `h` (0..1 inside the cell) and, for a side
   * face, along the vertical line at s from the bottom edge (t = 0) to the top edge (t = 1).
   */
  function sideValue(w: Quad, h: 'x' | 'z', y0: number, h0: number, p: V3, get: (k: number) => number): number {
    const s = p[h] - h0;
    const at = (top: boolean, side: number): number => w.p.findIndex((q) => near(q[h] - h0, side) && (top ? q.y > y0 + 1e-6 : near(q.y, y0)));
    const lerp = (a: number, b: number) => a + (b - a) * s;
    const bottom = lerp(get(at(false, 0)), get(at(false, 1)));
    const top = lerp(get(at(true, 0)), get(at(true, 1)));
    const height = lerp(w.p[at(true, 0)]!.y, w.p[at(true, 1)]!.y) - y0;
    return bottom + (top - bottom) * ((p.y - y0) / height);
  }

  /** Water cells with sloped amounts along z in column x = 1 (y = 0), the given parts at (2, 0, 1) or air. */
  function sloped(a: number, b = 0): MeshData {
    const input = makeInput(3, 1, 3, true);
    put(input, 1, 0, 0, water(7));
    put(input, 1, 0, 1, water(4));
    put(input, 1, 0, 2, water(0));
    patternLight(input);
    if (a !== 0) putParts(input, 2, 0, 1, a, b);
    const m = buildMesh(input);
    checkInvariants(m, { paddedTriangles: true });
    return m;
  }

  it('side pieces: u from the horizontal position, v equal to the height, light linear in the whole face', () => {
    const inCell = (qs: Quad[]) => qs.filter((q) => q.p.every((p) => p.z >= 1 - 1e-9 && p.z <= 2 + 1e-9));
    const whole = inCell(liquidOn(sloped(0), 'x', 2, 0));
    expect(whole.length).toBe(1);
    const w = whole[0]!;
    let checked = 0;
    let newVertices = 0;
    // Lower and upper slabs (the face clipped once), a quarter and a three-quarter cover (split halves).
    for (const [a, b] of [
      [slab(B.STONE, LOWER), 0],
      [slab(B.STONE, UPPER), 0],
      [slab(B.GLASS, LOWER), 0],
      [slab(B.STONE, 0x01), slab(B.GLASS, 0x10)],
      [slab(B.STONE, 0x15), 0],
    ] as const) {
      const m = sloped(a, b);
      for (const d of [0, 1]) {
        for (const q of inCell(liquidOn(m, 'x', 2, d))) {
          for (let k = 0; k < 4; k++) {
            const p = q.p[k]!;
            expect(q.uv[k]![0]).toBeCloseTo(sideValue(w, 'z', 0, 1, p, (j) => w.uv[j]![0]), 6);
            expect(q.uv[k]![1]).toBeCloseTo(p.y, 6);
            expect(Math.abs(q.sky[k]! - sideValue(w, 'z', 0, 1, p, (j) => w.sky[j]!))).toBeLessThanOrEqual(0.5 + 1e-3);
            expect(Math.abs(q.block[k]! - sideValue(w, 'z', 0, 1, p, (j) => w.block[j]!))).toBeLessThanOrEqual(0.5 + 1e-3);
            expect(q.ao[k]).toBe(255);
            checked++;
            if (cornerAt(w, p.x, p.y, p.z) < 0) newVertices++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(newVertices).toBeGreaterThan(20);
  });

  /**
   * The middle water cell (1, 0, 1) of a 3x2x3 box: full height (falling water above the columns x = 0
   * and x = 2 forces every corner to 1), with the given parts above it at (1, 1, 1), or air; a patterned
   * light field. `below` puts the parts under a water cell instead: the water at (1, 1, 1), the parts at
   * (1, 0, 1).
   */
  function flatScene(a: number, below: boolean): MeshData {
    const input = makeInput(3, 2, 3, true);
    if (below) put(input, 1, 1, 1, water());
    else {
      for (let x = 0; x < 3; x++) {
        for (let z = 0; z < 3; z++) {
          put(input, x, 0, z, water());
          if (x !== 1) put(input, x, 1, z, water(0, true));
        }
      }
      put(input, 1, 1, 0, makeCell(B.STONE));
      put(input, 1, 1, 2, makeCell(B.STONE));
    }
    patternLight(input);
    if (a !== 0) putParts(input, 1, below ? 0 : 1, 1, a);
    const m = buildMesh(input);
    checkInvariants(m);
    return m;
  }

  /** Bilinear value of a flat whole face's corner attribute at (x, z) inside the cell [1, 2]^2. */
  function flatValue(w: Quad, p: V3, get: (k: number) => number): number {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = w.p[k]!;
      v += (near(c.x, 2) ? p.x - 1 : 2 - p.x) * (near(c.z, 2) ? p.z - 1 : 2 - p.z) * get(k);
    }
    return v;
  }

  for (const below of [false, true]) {
    it(`${below ? 'a bottom over a partial cell' : 'a full-height top under a partial cell'}: each quadrant shows its part of the tile and the interpolated light`, () => {
      // Quadrants on the plane y = 1: the top of the lower water cell, or the bottom of the upper one.
      const plane = (m: MeshData, d: number) => liquidOn(m, 'y', 1, d).filter((q) => q.p.every((p) => p.x >= 1 && p.x <= 2 && p.z >= 1 && p.z <= 2));
      const front = below ? 3 : 2;
      const whole = plane(flatScene(0, below), front);
      expect(whole.length).toBe(1);
      const w = whole[0]!;
      // Four different corner lights, so that a quadrant cannot pass with the whole face's corner values.
      expect(new Set(w.sky.map((s, k) => s * 256 + w.block[k]!)).size).toBe(4);
      let quadrants = 0;
      // A stone octant over (under) one quadrant leaves three quadrants of both copies; a glass one the
      // whole outward copy (drawn as the whole face) and three inside quadrants; a west slab two of each.
      const one = below ? 0x04 : 0x01;
      const west = below ? 0x44 : 0x11;
      for (const [fill, id] of [
        [one, B.STONE],
        [one, B.GLASS],
        [west, B.STONE],
      ] as const) {
        const m = flatScene(slab(id, fill), below);
        for (const d of [front, front ^ 1]) {
          for (const q of plane(m, d)) {
            const a = quadArea(q);
            expect(near(a, 0.25) || near(a, 1)).toBe(true);
            quadrants += Math.round(a / 0.25);
            for (let k = 0; k < 4; k++) {
              const p = q.p[k]!;
              expect(q.uv[k]![0]).toBeCloseTo(flatValue(w, p, (j) => w.uv[j]![0]), 6);
              expect(q.uv[k]![1]).toBeCloseTo(flatValue(w, p, (j) => w.uv[j]![1]), 6);
              expect(q.sky[k]).toBe(Math.round(flatValue(w, p, (j) => w.sky[j]!)));
              expect(q.block[k]).toBe(Math.round(flatValue(w, p, (j) => w.block[j]!)));
              expect(q.flags[k]! & VFLAG_LIQUID_SURFACE).toBe(0);
            }
          }
        }
      }
      expect(quadrants).toBe(3 + 3 + 4 + 3 + 2 + 2);
    });
  }

  /**
   * Water at (1, 0, 1) and (1, 0, 0), a falling column above (1, 0, 0): the +X face of (1, 0, 1) has
   * its top corner at z = 1 pinned at full height (no wave flag) and the one at z = 2 free (flagged).
   * The cell east of it, (2, 0, 1), holds the given parts or air.
   */
  function pinnedScene(a: number): Quad[] {
    const input = makeInput(3, 2, 3, true);
    put(input, 1, 0, 1, water());
    put(input, 1, 0, 0, water());
    put(input, 1, 1, 0, water(0, true));
    if (a !== 0) putParts(input, 2, 0, 1, a);
    const m = buildMesh(input);
    checkInvariants(m, { paddedTriangles: true });
    return [0, 1].flatMap((d) => liquidOn(m, 'x', 2, d).filter((q) => q.p.every((p) => p.z >= 1 && p.z <= 2)));
  }
  const waves = (q: Quad, k: number) => (q.flags[k]! & VFLAG_LIQUID_SURFACE) !== 0;

  it('a new top-edge vertex between a pinned and a free corner carries no wave flag; the corners keep theirs', () => {
    const [w] = pinnedScene(0);
    const pinned = w!.p.findIndex((p) => near(p.z, 1) && near(p.y, 1));
    const free = w!.p.findIndex((p) => near(p.z, 2) && near(p.y, LIQUID_FULL_HEIGHT));
    expect(waves(w!, pinned)).toBe(false);
    expect(waves(w!, free)).toBe(true);
    // A stone octant in the lower low-z quadrant of the neighbour's face: the halves differ, the face is
    // split at z = 1.5 and gets a vertex on its top edge there.
    let mid = 0;
    for (const q of pinnedScene(slab(B.STONE, 0x01))) {
      for (let k = 0; k < 4; k++) {
        const p = q.p[k]!;
        if (near(p.z, 1.5) && p.y > 0.5 + 1e-6) {
          expect(p.y).toBeCloseTo((1 + LIQUID_FULL_HEIGHT) / 2, 6);
          expect(waves(q, k)).toBe(false);
          mid++;
        }
        if (near(p.z, 1) && near(p.y, 1)) expect(waves(q, k)).toBe(false);
        if (near(p.z, 2) && near(p.y, LIQUID_FULL_HEIGHT)) expect(waves(q, k)).toBe(true);
      }
    }
    // Front and back copy of the upper piece of the low-z half, and of the high-z half: 2 + 2.
    expect(mid).toBe(4);
  });

  it('a lower or upper slab beside the liquid clips the face once: its top edge keeps only its two original corners', () => {
    const [w] = pinnedScene(0);
    for (const fill of [LOWER, UPPER]) {
      const pieces = pinnedScene(slab(B.STONE, fill));
      // Lower slab: one quad above y = 0.5 per copy; upper slab: one quad below it per copy.
      expect(pieces.length).toBe(2);
      for (const q of pieces) {
        for (let k = 0; k < 4; k++) {
          const p = q.p[k]!;
          if (p.y > 0.5 + 1e-6) {
            // A vertex above the clip line is one of the whole face's top corners, with its flag.
            const o = cornerAt(w!, p.x, p.y, p.z);
            expect(o).toBeGreaterThanOrEqual(0);
            expect(waves(q, k)).toBe(waves(w!, o));
          } else expect(near(p.y, 0.5) || near(p.y, 0)).toBe(true);
          expect(near(p.z, 1) || near(p.z, 2)).toBe(true);
        }
      }
    }
  });
});
