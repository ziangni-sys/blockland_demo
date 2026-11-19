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
import { allQuads, checkInvariants, dirOfQuad, makeInput, put, putLight, type Quad } from './helpers';
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
  checkInvariants(m);
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
      checkInvariants(m);
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
    // An upper stone slab leaves the lower quadrants: the half that crosses y = 0.5 is a pentagon
    // (a quad and a triangle).
    const upper = build('stone', UPPER).m;
    expect(area(face(upper, 0))).toBeCloseTo(total - above, 5);
    expect(area(face(upper, 1))).toBeCloseTo(total - above, 5);
    expect(face(upper, 0).length).toBe(3);

    // The whole face of the M1 path (neighbour = air) gives the original corners.
    const whole = face(build('air').m, 0);
    expect(whole.length).toBe(1);
    const w = whole[0]!;
    for (const pieces of [face(stone, 0), face(stone, 1), face(glass, 1), face(upper, 0), face(upper, 1)]) {
      for (const q of pieces) {
        for (let k = 0; k < 4; k++) {
          const p = q.p[k]!;
          // New vertices only on the midpoint line z = 1.5 or on y = 0.5.
          const original = w.p.findIndex((o) => near(o.x, p.x) && near(o.y, p.y) && near(o.z, p.z));
          if (original < 0) expect(near(p.z, 1.5) || near(p.y, 0.5)).toBe(true);
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
    checkInvariants(m);
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
    checkInvariants(m);
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
      checkInvariants(m);
      const q = facesPerQuadrant(m, 'y', 1);
      // Quadrants of the plane y = 1 at (x, z): octant 2 -> (0.25, 0.25), 3 -> (0.75, 0.25), 6 -> (0.25, 0.75), 7 -> (0.75, 0.75).
      expect(q[0]).toEqual([`${g}:2`, 'translucent:3'].sort());
      expect(q[2]).toEqual(['opaque:2']);
      expect(q[1]).toEqual(['translucent:2', 'translucent:3']);
      expect(q[3]).toEqual(['translucent:2', 'translucent:3']);
    });
  }
});
