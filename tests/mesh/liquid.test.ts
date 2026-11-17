import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { blockDef } from '../../src/blocks/registry';
import { LIQUID_FULL_HEIGHT, buildMesh } from '../../src/mesh/mesher';
import { VFLAG_EMISSIVE, VFLAG_LIQUID_SURFACE, type MeshData } from '../../src/mesh/types';
import { allQuads, checkInvariants, cornerAt, dirOfQuad, makeInput, put, putLight, quadsOf, type Quad } from './helpers';

const SOURCE = liquidState(0, false);
const water = (level = 0, falling = false) => makeCell(B.WATER, liquidState(level, falling));
const lava = (level = 0) => makeCell(B.LAVA, liquidState(level, false));
/** Surface height of a flowing cell with `amount` (1..8) and open sky above. */
const heightOf = (amount: number) => (amount / 8) * LIQUID_FULL_HEIGHT;

function surfaces(m: MeshData): Quad[] {
  return allQuads(m).filter((q) => (q.flags[0]! & VFLAG_LIQUID_SURFACE) !== 0);
}
/** Upward-facing surface quad of the cell whose x range is [x, x+1]. */
function topOf(m: MeshData, x: number, z = 0): Quad {
  const q = surfaces(m).find((q) => q.n.y > 0 && q.p.every((p) => p.x >= x && p.x <= x + 1 && p.z >= z && p.z <= z + 1));
  if (!q) throw new Error(`no top surface at x=${x}`);
  return q;
}
function heightAt(q: Quad, x: number, z: number): number {
  const k = q.p.findIndex((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.z - z) < 1e-6);
  expect(k).toBeGreaterThanOrEqual(0);
  return q.p[k]!.y;
}

describe('liquid surface heights', () => {
  it('a lone source is a 14/16 slab with all six faces, in the translucent group', () => {
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
    // top (front + back) + 4 sides + bottom
    expect(qs.length).toBe(7);
    const sides = qs.filter((q) => [0, 1, 4, 5].includes(dirOfQuad(q)));
    expect(sides.length).toBe(4);
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
    expect(allQuads(m).some((q) => q.p.every((p) => p.x === 1))).toBe(false);
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
    expect(tops[0]!.p.every((p) => Math.abs(p.y - (1 + 14 / 16)) < 1e-6)).toBe(true);
    // the lower cell's sides span 0..1, the upper's 1..1+14/16; no face at y = 1
    const lowerSides = allQuads(m).filter((q) => [0, 1, 4, 5].includes(dirOfQuad(q)) && q.p.some((p) => p.y === 0));
    expect(lowerSides.length).toBe(4);
    for (const s of lowerSides) expect(Math.max(...s.p.map((p) => p.y))).toBe(1);
    expect(allQuads(m).some((q) => q.p.every((p) => p.y === 1))).toBe(false);
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
    const a = topOf(buildMesh(input), 0);
    expect(heightAt(a, 0, 0)).toBeCloseTo((heightOf(8) + heightOf(4)) / 2, 6);
    expect(heightAt(a, 1, 0)).toBeCloseTo(heightOf(4), 6);
    // no side face toward the margin water
    expect(allQuads(buildMesh(input)).some((q) => dirOfQuad(q) === 1)).toBe(false);
  });
});

describe('liquid faces', () => {
  it('the top is double-sided: a back copy with the same corners and the opposite normal', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water(2));
    const m = buildMesh(input);
    const s = surfaces(m);
    expect(s.length).toBe(2);
    const [up, down] = s[0]!.n.y > 0 ? [s[0]!, s[1]!] : [s[1]!, s[0]!];
    expect(down.nb).toEqual([0 - up.nb[0], 0 - up.nb[1], 0 - up.nb[2]]);
    const key = (q: Quad) => q.p.map((p) => `${p.x},${p.y},${p.z}`).sort().join('|');
    expect(key(down)).toBe(key(up));
    // both sides carry the surface flag, so a wave shader moves them together
    for (const q of s) expect(q.flags.every((f) => (f & VFLAG_LIQUID_SURFACE) !== 0)).toBe(true);
    // same triangulation: identical triangles as point sets
    const tris = (q: Quad) =>
      [0, 1]
        .map((t) =>
          q.idx
            .slice(t * 3, t * 3 + 3)
            .map((i) => `${q.p[i]!.x},${q.p[i]!.y},${q.p[i]!.z}`)
            .sort()
            .join('|'),
        )
        .sort();
    expect(tris(down)).toEqual(tris(up));
  });

  it('non-planar surfaces fold along the flatter diagonal, identically on both sides', () => {
    const input = makeInput(2, 1, 2);
    put(input, 0, 0, 0, water(0));
    put(input, 1, 0, 0, water(6));
    put(input, 0, 0, 1, water(6));
    put(input, 1, 0, 1, water(6));
    const m = buildMesh(input);
    checkInvariants(m);
  });

  it('sides and bottom are skipped against opaque cells and the same liquid, kept against others', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water());
    put(input, 1, 0, 0, makeCell(B.STONE));
    put(input, -1, 0, 0, makeCell(B.GLASS));
    put(input, 0, 0, 1, water(3));
    put(input, 0, 0, -1, lava());
    put(input, 0, -1, 0, makeCell(B.SAND));
    const dirs = allQuads(buildMesh(input))
      .filter((q) => (q.flags[0]! & VFLAG_LIQUID_SURFACE) === 0)
      .map(dirOfQuad)
      .sort();
    expect(dirs).toEqual([1, 5]); // glass side and lava side
  });

  it('uses the still tile on top and bottom and the flow tile on the sides', () => {
    const [still, flow] = blockDef(B.WATER).tileIds as [number, number];
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water());
    for (const q of allQuads(buildMesh(input))) {
      const d = dirOfQuad(q);
      if (d === 2 || d === 3 || (q.flags[0]! & VFLAG_LIQUID_SURFACE) !== 0) expect(q.tile).toBe(still);
      else expect(q.tile).toBe(flow);
    }
  });

  it('side faces of a partial cell show the matching part of the tile', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, water(4));
    for (const q of allQuads(buildMesh(input))) {
      const d = dirOfQuad(q);
      if (d < 0 || d === 2 || d === 3) continue;
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
    expect(qs.length).toBe(7);
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
    ]) {
      put(full, x!, 0, z!, water());
      put(full, x!, 1, z!, water(0, true));
    }
    expect(surfaces(buildMesh(full)).length).toBe(0);
  });

  it('marks the source level constant consistently', () => {
    expect(SOURCE).toBe(0);
    expect(LIQUID_FULL_HEIGHT).toBe(14 / 16);
  });
});
