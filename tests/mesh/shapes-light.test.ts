/**
 * Ambient occlusion and smooth light on the octant path (docs/SHAPES.md 8.3): an independent
 * reference of the octant formula O(V) and of the "which value at which vertex" rule, compared
 * vertex by vertex on random scenes, plus the named cases of the package description.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { BLOCKS, OPAQUE } from '../../src/blocks/registry';
import { opaqueFill } from '../../src/blocks/shapes';
import { PY } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { buildMesh } from '../../src/mesh/mesher';
import type { MeshInput } from '../../src/mesh/types';
import { LOWER, UPPER, slab } from '../shapes';
import { allQuads, cornerAt, diagonalOf, dirOfQuad, idx, makeInput, put, putLight, type Quad } from './helpers';
import { isPartial, ownerCell, packedAt, putParts, quadArea, randomPartialCell } from './shape-helpers';

const AO = [0, 85, 170, 255];
const avgByte = (sum: number, n: number): number => Math.min(255, Math.round((sum * 17) / n));

/** Reference of 8.3 on the half-cell grid of a mesh input (half coordinates h = 2 * cell + bit). */
class Ref {
  constructor(private readonly input: MeshInput) {}

  private cellOf(h: readonly number[]): [number, number, number] {
    return [Math.floor(h[0]! / 2), Math.floor(h[1]! / 2), Math.floor(h[2]! / 2)];
  }
  private opaque(h: readonly number[]): boolean {
    const [x, y, z] = this.cellOf(h);
    const o = (h[0]! & 1) | ((h[1]! & 1) << 1) | ((h[2]! & 1) << 2);
    return ((opaqueFill(packedAt(this.input, x, y, z)) >> o) & 1) === 1;
  }
  partialAt(h: readonly number[]): boolean {
    const [x, y, z] = this.cellOf(h);
    return isPartial(packedAt(this.input, x, y, z));
  }
  private light(h: readonly number[]): number {
    const [x, y, z] = this.cellOf(h);
    return this.input.light![idx(this.input, x, y, z)]!;
  }

  /** The four octants O(V) samples: F, side1 = F + su, side2 = F + sv, corner. */
  octants(f: readonly number[], ua: number, su: number, va: number, sv: number): number[][] {
    const s1 = [...f];
    s1[ua]! += su;
    const s2 = [...f];
    s2[va]! += sv;
    const c = [...s1];
    c[va]! += sv;
    return [[...f], s1, s2, c];
  }

  /** O(V): [ao byte, sky byte, block byte]. */
  O(f: readonly number[], ua: number, su: number, va: number, sv: number): [number, number, number] {
    const [F, s1, s2, c] = this.octants(f, ua, su, va, sv);
    const o1 = this.opaque(s1!);
    const o2 = this.opaque(s2!);
    const oc = this.opaque(c!);
    const ao = AO[o1 && o2 ? 0 : 3 - (+o1 + +o2 + +oc)]!;
    if (this.input.light === null) return [ao, 255, 0];
    const take: number[][] = [];
    if (!this.opaque(F!)) take.push(F!);
    if (!o1) take.push(s1!);
    if (!o2) take.push(s2!);
    if (!oc && !(o1 && o2)) take.push(c!);
    if (take.length === 0) take.push(F!);
    let sky = 0;
    let blk = 0;
    for (const h of take) {
      sky += this.light(h) >> 4;
      blk += this.light(h) & 15;
    }
    return [ao, avgByte(sky, take.length), avgByte(blk, take.length)];
  }

  /**
   * The expected [ao, sky, block] of the vertex at box-space position v of the quarter face of the
   * octant at half coordinates hq toward Dir d (8.3 "每个顶点用哪个值").
   */
  vertex(hq: readonly number[], d: number, v: readonly number[]): [number, number, number] {
    const a = d >> 1;
    const pos = (d & 1) === 0;
    const [ua, va] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
    const f = [...hq];
    f[a]! += pos ? 1 : -1;
    const centre = [hq[0]! / 2 + 0.25, hq[1]! / 2 + 0.25, hq[2]! / 2 + 0.25];
    const su = v[ua]! > centre[ua]! ? 1 : -1;
    const sv = v[va]! > centre[va]! ? 1 : -1;
    const own = this.O(f, ua, su, va, sv);
    const onCellFace = (hq[a]! & 1) === (pos ? 1 : 0);
    const uInt = Number.isInteger(v[ua]!);
    const vInt = Number.isInteger(v[va]!);
    if (!onCellFace || (uInt && vInt)) return own;
    if (this.octants(f, ua, su, va, sv).some((h) => this.partialAt(h))) return own;
    // Cell corners of this cell face: (cu, cv) in {0,1}^2 relative to the cell.
    const cell = [Math.floor(hq[0]! / 2), Math.floor(hq[1]! / 2), Math.floor(hq[2]! / 2)];
    const corner = (cu: number, cv: number): [number, number, number] => {
      const h = [cell[0]! * 2, cell[1]! * 2, cell[2]! * 2];
      h[a]! += pos ? 1 : 0;
      h[ua]! += cu;
      h[va]! += cv;
      const fc = [...h];
      fc[a]! += pos ? 1 : -1;
      return this.O(fc, ua, cu === 1 ? 1 : -1, va, cv === 1 ? 1 : -1);
    };
    const lu = v[ua]! - cell[ua]!;
    const lv = v[va]! - cell[va]!;
    let picks: Array<[number, number, number]>;
    if (uInt) picks = [corner(lu, 0), corner(lu, 1)];
    else if (vInt) picks = [corner(0, lv), corner(1, lv)];
    else picks = [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)];
    const out: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const s = picks.reduce((acc, p) => acc + p[k]!, 0);
      out[k] = picks.length === 2 ? (s + 1) >> 1 : (s + 2) >> 2;
    }
    return out;
  }
}

/** Octant-path quads (quarter faces) of cube cells: [quad, half coordinates of its octant, Dir]. */
function quarterFaces(input: MeshInput): Array<[Quad, number[], number]> {
  const out: Array<[Quad, number[], number]> = [];
  for (const q of allQuads(buildMesh(input))) {
    const d = dirOfQuad(q);
    if (d < 0 || Math.abs(quadArea(q) - 0.25) > 1e-9) continue;
    const [x, y, z] = ownerCell(q);
    const def = BLOCKS[packedAt(input, x, y, z) & ID_MASK];
    if (!def || (def.shape !== 'cube' && def.shape !== 'bearing')) continue;
    const n = [q.nb[0] / 127, q.nb[1] / 127, q.nb[2] / 127];
    const c = [0, 1, 2].map((k) => q.p.reduce((s, p) => s + [p.x, p.y, p.z][k]!, 0) / 4 - n[k]! * 0.25);
    out.push([q, c.map((v) => Math.floor(v * 2)), d]);
  }
  return out;
}

function randomScene(rng: Rng, light: boolean): MeshInput {
  const input = makeInput(rng.int(2, 6), rng.int(2, 6), rng.int(2, 6), light ? 0 : false);
  const cubes = [B.STONE, B.GLASS, B.LEAVES_OAK, B.PLANKS_OAK, B.ICE];
  const air = 0.3 + rng.next() * 0.4;
  for (let y = -1; y <= input.sy; y++) {
    for (let z = -1; z <= input.sz; z++) {
      for (let x = -1; x <= input.sx; x++) {
        if (light) input.light![idx(input, x, y, z)] = rng.int(0, 255);
        if (rng.next() < air) continue;
        if (rng.chance(0.35)) put(input, x, y, z, randomPartialCell(rng));
        else put(input, x, y, z, makeCell(cubes[rng.int(0, cubes.length - 1)]!));
      }
    }
  }
  return input;
}

describe('octant AO and smooth light: reference comparison, vertex by vertex (8.3)', () => {
  it('every vertex of every quarter face on 40 random scenes, with light and without (structures)', () => {
    const rng = new Rng(2024);
    let corners = 0;
    let averaged = 0;
    for (let t = 0; t < 40; t++) {
      const input = randomScene(rng, t % 4 !== 3);
      const ref = new Ref(input);
      for (const [q, hq, d] of quarterFaces(input)) {
        for (let k = 0; k < 4; k++) {
          const v = [q.p[k]!.x, q.p[k]!.y, q.p[k]!.z];
          expect([q.ao[k], q.sky[k], q.block[k]], `scene ${t} quad ${hq} dir ${d} vertex ${v}`).toEqual(ref.vertex(hq, d, v));
          const a = d >> 1;
          const ints = [0, 1, 2].filter((i) => i !== a && Number.isInteger(v[i]!)).length;
          if (ints === 2) corners++;
          else averaged++;
        }
      }
    }
    expect(corners).toBeGreaterThan(1000);
    expect(averaged).toBeGreaterThan(1000);
  });
});

describe('vertex values on named cases (8.3)', () => {
  /** Floor of stone at y = 0 over a (sx x sz) box; light byte `light` everywhere above it. */
  function floor(sx: number, sz: number, light: number | false = 0xf0): MeshInput {
    const input = makeInput(sx, 3, sz, light);
    for (let x = -1; x <= sx; x++) for (let z = -1; z <= sz; z++) put(input, x, 0, z, makeCell(B.STONE));
    if (light !== false) for (let x = -1; x <= sx; x++) for (let z = -1; z <= sz; z++) putLight(input, x, 0, z, 0);
    return input;
  }
  /** Top-face quads of the floor cell (x, 0, z). */
  function floorTop(input: MeshInput, x: number, z: number): Quad[] {
    return allQuads(buildMesh(input)).filter((q) => dirOfQuad(q) === PY && q.p.every((p) => p.y === 1) && ownerCell(q).join() === `${x},0,${z}`);
  }
  /** [ao, sky, block] of the vertex at (x, 1, z) among quads (first one found). */
  function at(qs: Quad[], x: number, z: number): number[] {
    for (const q of qs) {
      const k = cornerAt(q, x, 1, z);
      if (k >= 0) return [q.ao[k]!, q.sky[k]!, q.block[k]!];
    }
    throw new Error(`no vertex at ${x},1,${z}`);
  }

  it('cell corners take M1 values; edge midpoints and centres away from partial cells take the corner averages', () => {
    // The slab at (0,1,0) puts floor cell (1,0,1) on the octant path (diagonal of its window); a
    // wall cube at (2,1,1) darkens its +X edge. Its centre and +X edge midpoint see no partial cell.
    const input = floor(4, 4, 0);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) putLight(input, x, 1, z, 9 + x, z);
    putParts(input, 0, 1, 0, slab(B.STONE, LOWER));
    put(input, 2, 1, 1, makeCell(B.STONE));
    const split = floorTop(input, 1, 1);
    expect(split.length).toBe(4);
    // M1's values at the three corners whose four cells hold no partial cell: the same scene without
    // the slab is meshed by M1's code, and the slab's cell is sampled only by corner (1, 1).
    const m1 = makeInput(4, 3, 4, 0);
    m1.cells.set(input.cells);
    m1.light!.set(input.light!);
    m1.cells[idx(m1, 0, 1, 0)] = 0;
    const whole = floorTop(m1, 1, 1)[0]!;
    for (const [x, z] of [
      [2, 1],
      [2, 2],
      [1, 2],
    ]) {
      const k = cornerAt(whole, x!, 1, z!);
      expect(at(split, x!, z!)).toEqual([whole.ao[k]!, whole.sky[k]!, whole.block[k]!]);
    }
    // +X edge midpoint (2, 1.5) and the centre (1.5, 1.5): averages, rounded as 8.3 says.
    const c = (x: number, z: number) => at(split, x, z);
    const mid = c(2, 1.5);
    for (let i = 0; i < 3; i++) expect(mid[i]).toBe((c(2, 1)[i]! + c(2, 2)[i]! + 1) >> 1);
    const centre = c(1.5, 1.5);
    for (let i = 0; i < 3; i++) expect(centre[i]).toBe((c(1, 1)[i]! + c(2, 1)[i]! + c(1, 2)[i]! + c(2, 2)[i]! + 2) >> 2);
    expect(mid[0]).toBe((AO[2]! + AO[2]! + 1) >> 1);
  });

  it('a split face and its unsplit coplanar neighbour agree at the three points of their shared edge (within 1)', () => {
    // Slab at (-1, 1, 1) (margin column): only floor cell (0,0,*)'s window holds it; (1,0,1) stays M1.
    const input = floor(3, 3, 0);
    for (let x = -1; x <= 3; x++) for (let z = -1; z <= 3; z++) putLight(input, x, 1, z, (5 + x * 3 + z * 2) & 15, (x + z) & 15);
    putParts(input, -1, 1, 1, slab(B.STONE, LOWER));
    put(input, 1, 1, 0, makeCell(B.STONE));
    const split = floorTop(input, 0, 1);
    const unsplit = floorTop(input, 1, 1);
    expect(split.length).toBe(4);
    expect(unsplit.length).toBe(1);
    const u = unsplit[0]!;
    const ends = [cornerAt(u, 1, 1, 1), cornerAt(u, 1, 1, 2)];
    for (const [k, z] of [
      [ends[0]!, 1],
      [ends[1]!, 2],
    ]) {
      expect(at(split, 1, z!)).toEqual([u.ao[k!]!, u.sky[k!]!, u.block[k!]!]);
    }
    // The unsplit face shows the linear interpolation of its two corners at the edge midpoint.
    const m = at(split, 1, 1.5);
    const lerp = [0, 1, 2].map((i) => ([u.ao, u.sky, u.block][i]![ends[0]!]! + [u.ao, u.sky, u.block][i]![ends[1]!]!) / 2);
    for (let i = 0; i < 3; i++) expect(Math.abs(m[i]! - lerp[i]!)).toBeLessThanOrEqual(1);
  });

  it('a half slab on a floor casts a contact shadow on the floor along its foot, and its own sides darken at the bottom', () => {
    const input = floor(3, 3, false);
    putParts(input, 1, 1, 1, slab(B.STONE, LOWER));
    // Floor (1,0,0) top: its +Z edge runs along the slab's foot; corners and midpoint are darkened.
    const front = floorTop(input, 1, 0);
    expect(front.length).toBe(4);
    for (const x of [1, 1.5, 2]) expect(at(front, x, 1)[0]).toBeLessThan(255);
    // The far edge (z = 0) is open.
    for (const x of [1, 1.5, 2]) expect(at(front, x, 0)[0]).toBe(255);
    // The slab's -Z side: the bottom vertices are darker than the top ones.
    const side = allQuads(buildMesh(input)).filter((q) => dirOfQuad(q) === 5 && ownerCell(q).join() === '1,1,1');
    expect(side.length).toBe(2);
    for (const q of side) {
      for (let k = 0; k < 4; k++) {
        if (q.p[k]!.y === 1) expect(q.ao[k]).toBeLessThan(255);
        else expect(q.p[k]!.y).toBe(1.5);
      }
    }
  });

  it('a partial cell is not a whole-cell occluder: an upper slab beside the cell above a floor leaves the floor corner open', () => {
    const withSlab = floor(3, 3, false);
    putParts(withSlab, 0, 1, 1, slab(B.STONE, UPPER));
    const withCube = floor(3, 3, false);
    put(withCube, 0, 1, 1, makeCell(B.STONE));
    // Floor (1,0,1): its -X edge borders the cell (0,1,1). A whole cube there darkens both corners;
    // an upper slab leaves the half layer just above the floor empty.
    expect(at(floorTop(withCube, 1, 1), 1, 1)[0]).toBe(170);
    expect(at(floorTop(withSlab, 1, 1), 1, 1)[0]).toBe(255);
    expect(at(floorTop(withSlab, 1, 1), 1, 1.5)[0]).toBe(255);
    // A lower slab there is an occluder of that half layer.
    const lower = floor(3, 3, false);
    putParts(lower, 0, 1, 1, slab(B.STONE, LOWER));
    expect(at(floorTop(lower, 1, 1), 1, 1.5)[0]).toBe(85);
  });

  it('smooth light skips opaque octants, not cells with an opaque id: the open half of a stone slab cell lights the floor', () => {
    const input = floor(3, 3, 0);
    for (let x = -1; x <= 3; x++) for (let z = -1; z <= 3; z++) putLight(input, x, 1, z, 3);
    putParts(input, 0, 1, 1, slab(B.STONE, UPPER));
    putLight(input, 0, 1, 1, 15);
    // Vertex (1, 1, 1.5) of floor (1,0,1): F in (1,1,1), side -X in the slab cell's lower half (open,
    // light 15), side +-Z in (1,1,1) itself, corner in the slab cell again: (3 + 15 + 3 + 15) / 4.
    expect(at(floorTop(input, 1, 1), 1, 1.5)[1]).toBe(avgByte(3 + 15 + 3 + 15, 4));
  });

  it('structures (no voxel light) get full sky and no block light on the octant path', () => {
    const input = floor(3, 3, false);
    putParts(input, 1, 1, 1, slab(B.STONE, LOWER));
    for (const q of allQuads(buildMesh(input))) {
      expect(q.sky).toEqual([255, 255, 255, 255]);
      expect(q.block).toEqual([0, 0, 0, 0]);
    }
  });

  it('each quarter face picks its own diagonal, by AO first', () => {
    const input = floor(3, 3, false);
    putParts(input, 1, 1, 1, slab(B.STONE, LOWER));
    for (const q of allQuads(buildMesh(input))) {
      const a02 = q.ao[0]! + q.ao[2]!;
      const a13 = q.ao[1]! + q.ao[3]!;
      if (a02 !== a13) expect(diagonalOf(q)).toBe(a02 > a13 ? '02' : '13');
    }
  });

  it('opaque ids and the OPAQUE table agree with opaqueFill for whole cells (the reference relies on it)', () => {
    for (const d of BLOCKS) if (d) expect(opaqueFill(makeCell(d.id))).toBe(OPAQUE[d.id] ? 0xff : 0);
  });
});
