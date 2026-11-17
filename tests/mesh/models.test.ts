import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { facingState, layersState, makeCell } from '../../src/blocks/cell';
import { blockDef } from '../../src/blocks/registry';
import type { Dir } from '../../src/core/dirs';
import { buildMesh } from '../../src/mesh/mesher';
import { VFLAG_EMISSIVE, VFLAG_PLANT, type MeshData } from '../../src/mesh/types';
import { allQuads, bounds, checkInvariants, dirOfQuad, makeInput, put, quadsOf, uvFrame, cross, dot, type Quad } from './helpers';

const DIR_VEC: ReadonlyArray<[number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Mesh a single cell with an optional cell below it (in the margin). */
function single(cell: number, below = 0, light = false): MeshData {
  const input = makeInput(1, 1, 1, light);
  put(input, 0, 0, 0, cell);
  put(input, 0, -1, 0, below);
  const m = buildMesh(input);
  checkInvariants(m);
  return m;
}

function expectInsideCell(m: MeshData): void {
  const b = bounds(m);
  for (const c of [b.min.x, b.min.y, b.min.z]) expect(c).toBeGreaterThanOrEqual(0);
  for (const c of [b.max.x, b.max.y, b.max.z]) expect(c).toBeLessThanOrEqual(1);
}

/** Each quad has a back twin: same corner set, opposite normal. */
function expectDoubleSided(quads: Quad[]): void {
  const key = (q: Quad) => q.p.map((p) => `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`).sort().join('|');
  for (const q of quads) {
    const twin = quads.find((o) => o !== q && key(o) === key(q) && o.nb[0] === 0 - q.nb[0] && o.nb[1] === 0 - q.nb[1] && o.nb[2] === 0 - q.nb[2]);
    expect(twin).toBeDefined();
  }
}

describe('cross plants', () => {
  for (const id of [B.TALL_GRASS, B.FLOWER_RED, B.FLOWER_YELLOW]) {
    it(`block ${id}: two double-sided diagonal planes in the cutout group, flagged plant`, () => {
      const m = single(makeCell(id), makeCell(B.TURF));
      expect(m.opaque).toBeNull();
      const qs = quadsOf(m.cutout, 'cutout');
      expect(qs.length).toBe(4);
      expectInsideCell(m);
      expectDoubleSided(qs);
      for (const q of qs) {
        expect(q.tile).toBe(blockDef(id).tileIds[0]);
        expect(q.flags.every((f) => (f & VFLAG_PLANT) !== 0)).toBe(true);
        expect(Math.abs(q.n.x)).toBeCloseTo(Math.SQRT1_2, 2);
        expect(q.n.y).toBe(0);
        // diagonal: corners at the cell corners
        for (const p of q.p) expect([0, 1]).toContain(p.x);
        // v = 0 at the roots, 1 at the tips
        for (let k = 0; k < 4; k++) expect(q.uv[k]![1]).toBe(q.p[k]!.y);
        expect(q.ao).toEqual([255, 255, 255, 255]);
      }
    });
  }

  it('is lit flat with its own cell light', () => {
    const input = makeInput(1, 1, 1, 0);
    put(input, 0, 0, 0, makeCell(B.TALL_GRASS));
    input.light![1 + 3 + 9] = (11 << 4) | 2;
    for (const q of allQuads(buildMesh(input))) {
      expect(q.sky).toEqual([187, 187, 187, 187]);
      expect(q.block).toEqual([34, 34, 34, 34]);
    }
  });
});

describe('torch', () => {
  it('is a thin emissive post standing in the middle of the floor', () => {
    const m = single(makeCell(B.TORCH), makeCell(B.STONE));
    expectInsideCell(m);
    const b = bounds(m);
    expect(b.min).toEqual({ x: 7 / 16, y: 0, z: 7 / 16 });
    expect(b.max).toEqual({ x: 9 / 16, y: 10 / 16, z: 9 / 16 });
    const qs = allQuads(m);
    expect(qs.every((q) => q.group === 'cutout')).toBe(true);
    // 4 sides + top; the bottom rests on stone and is culled
    expect(qs.map(dirOfQuad).sort()).toEqual([0, 1, 2, 4, 5]);
    for (const q of qs) expect(q.flags.every((f) => (f & VFLAG_EMISSIVE) !== 0)).toBe(true);
  });

  it('samples the matching pixels of the tile', () => {
    const qs = allQuads(single(makeCell(B.TORCH), makeCell(B.STONE)));
    for (const q of qs) {
      for (const [u, v] of q.uv) {
        expect(u).toBeGreaterThanOrEqual(7 / 16 - 1e-6);
        expect(u).toBeLessThanOrEqual(9 / 16 + 1e-6);
        expect(v).toBeLessThanOrEqual(10 / 16 + 1e-6);
      }
      const d = dirOfQuad(q);
      if (d !== 2) for (let k = 0; k < 4; k++) expect(q.uv[k]![1]).toBeCloseTo(q.p[k]!.y, 6); // sides: v = height
      else for (const [, v] of q.uv) expect(v).toBeGreaterThanOrEqual(8 / 16 - 1e-6); // cap = top of the post
      const { du, dv } = uvFrame(q);
      expect(dot(cross(du, dv), q.n)).toBeGreaterThan(0);
    }
  });

  it('keeps its bottom when nothing covers it', () => {
    expect(allQuads(single(makeCell(B.TORCH), 0)).length).toBe(6);
  });
});

describe('layers (snow cover)', () => {
  it('has height layers / 8 for every state', () => {
    for (let n = 1; n <= 8; n++) {
      const m = single(makeCell(B.SNOW_LAYER, layersState(n)), makeCell(B.STONE));
      expectInsideCell(m);
      expect(bounds(m).max.y).toBeCloseTo(n / 8, 6);
      const top = allQuads(m).find((q) => dirOfQuad(q) === 2)!;
      expect(top.p.every((p) => Math.abs(p.y - n / 8) < 1e-6)).toBe(true);
      // bottom culled against stone: 4 sides + top
      expect(allQuads(m).length).toBe(5);
      expect(m.opaque).not.toBeNull();
    }
  });

  it('hides a side against an equal or higher stack of the same kind, keeps it against a lower one', () => {
    const mk = (a: number, b: number) => {
      const input = makeInput(2, 1, 1);
      put(input, 0, 0, 0, makeCell(B.SNOW_LAYER, layersState(a)));
      put(input, 1, 0, 0, makeCell(B.SNOW_LAYER, layersState(b)));
      return allQuads(buildMesh(input));
    };
    const plane = (qs: Quad[], dir: number) => qs.filter((q) => dirOfQuad(q) === dir && q.p.every((p) => p.x === 1));
    const eq = mk(3, 3);
    expect(plane(eq, 0).length + plane(eq, 1).length).toBe(0);
    const step = mk(2, 5);
    expect(plane(step, 0).length).toBe(0); // the low one's side is hidden by the high one
    expect(plane(step, 1).length).toBe(1); // the high one's side shows above the low one
  });

  it('a full stack under an opaque block loses its top face', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, makeCell(B.SNOW_LAYER, layersState(8)));
    put(input, 0, 1, 0, makeCell(B.STONE));
    expect(allQuads(buildMesh(input)).some((q) => dirOfQuad(q) === 2)).toBe(false);
  });

  it('gets AO from walls rising above it', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, makeCell(B.SNOW_LAYER, layersState(1)));
    put(input, -1, 0, 0, makeCell(B.STONE));
    const top = allQuads(buildMesh(input)).find((q) => dirOfQuad(q) === 2)!;
    for (let k = 0; k < 4; k++) expect(top.ao[k]).toBe(top.p[k]!.x === 0 ? 204 : 255);
  });
});

describe('cactus', () => {
  it('insets its four sides by 1/16 and keeps top and bottom at the cell faces', () => {
    const m = single(makeCell(B.CACTUS), makeCell(B.SAND));
    expectInsideCell(m);
    const qs = allQuads(m);
    const tiles = blockDef(B.CACTUS).tileIds;
    // bottom culled on sand
    expect(qs.map(dirOfQuad).sort()).toEqual([0, 1, 2, 4, 5]);
    for (const q of qs) {
      const d = dirOfQuad(q);
      if (d === 2) {
        expect(q.tile).toBe(tiles[1]);
        expect(q.p.every((p) => p.y === 1)).toBe(true);
      } else {
        expect(q.tile).toBe(tiles[0]);
        const axis = d >> 1 === 0 ? 'x' : 'z';
        const plane = d & 1 ? 1 / 16 : 15 / 16;
        expect(q.p.every((p) => Math.abs(p[axis] - plane) < 1e-6)).toBe(true);
        // full width along the other horizontal axis
        const other = axis === 'x' ? 'z' : 'x';
        expect(Math.min(...q.p.map((p) => p[other]))).toBe(0);
        expect(Math.max(...q.p.map((p) => p[other]))).toBe(1);
      }
    }
  });

  it('stacked cactus has no faces between the cells', () => {
    const input = makeInput(1, 2, 1);
    put(input, 0, 0, 0, makeCell(B.CACTUS));
    put(input, 0, 1, 0, makeCell(B.CACTUS));
    const qs = allQuads(buildMesh(input));
    expect(qs.some((q) => q.p.every((p) => p.y === 1))).toBe(false);
    expect(qs.length).toBe(4 * 2 + 2);
  });
});

describe('helm', () => {
  const [baseTile, wheelTile] = blockDef(B.HELM).tileIds as [number, number];

  for (const f of [0, 1, 4, 5] as Dir[]) {
    it(`facing ${f}: pedestal plus a wheel on the helmsman's side, perpendicular to facing`, () => {
      const m = single(makeCell(B.HELM, facingState(f)), makeCell(B.PLANKS_OAK));
      expectInsideCell(m);
      const qs = allQuads(m);
      const pedestal = qs.filter((q) => q.tile === baseTile);
      const wheel = qs.filter((q) => q.tile === wheelTile);
      expect(pedestal.length).toBe(5); // bottom culled on planks
      for (const q of pedestal) {
        for (const p of q.p) {
          expect(p.x).toBeGreaterThanOrEqual(4 / 16 - 1e-6);
          expect(p.x).toBeLessThanOrEqual(12 / 16 + 1e-6);
          expect(p.z).toBeGreaterThanOrEqual(4 / 16 - 1e-6);
          expect(p.z).toBeLessThanOrEqual(12 / 16 + 1e-6);
          expect(p.y).toBeLessThanOrEqual(10 / 16 + 1e-6);
        }
      }
      expect(wheel.length).toBe(2);
      expectDoubleSided(wheel);
      // the wheel decal needs alpha testing even though the helm is an 'opaque' block
      expect(wheel.every((q) => q.group === 'cutout')).toBe(true);
      const [fx, , fz] = DIR_VEC[f]!;
      const axis = fx !== 0 ? 'x' : 'z';
      const sign = fx !== 0 ? fx : fz;
      // plane perpendicular to facing, 3/16 behind the pedestal (opposite to facing)
      const plane = sign > 0 ? 1 / 16 : 15 / 16;
      for (const q of wheel) expect(q.p.every((p) => Math.abs(p[axis] - plane) < 1e-6)).toBe(true);
      // 14/16 across
      const other = axis === 'x' ? 'z' : 'x';
      const w = wheel[0]!;
      expect(Math.max(...w.p.map((p) => p[other])) - Math.min(...w.p.map((p) => p[other]))).toBeCloseTo(14 / 16, 6);
      expect(Math.max(...w.p.map((p) => p.y)) - Math.min(...w.p.map((p) => p.y))).toBeCloseTo(14 / 16, 6);
      // the front side faces the helmsman (normal = -facing), tile upright and unmirrored
      const front = wheel.find((q) => q.nb[0] === -fx * 127 && q.nb[2] === -fz * 127)!;
      expect(front).toBeDefined();
      const { du, dv } = uvFrame(front);
      expect(dv.y).toBeGreaterThan(0);
      expect(dot(cross(du, dv), front.n)).toBeGreaterThan(0);
    });
  }
});

describe('propeller', () => {
  const [hubTile, bladeTile, backTile] = blockDef(B.PROPELLER).tileIds as [number, number, number];

  for (const f of [0, 1, 2, 3, 4, 5] as Dir[]) {
    it(`facing ${f}: hub, back plate on the mounting face and four blades on the facing side`, () => {
      const input = makeInput(1, 1, 1);
      put(input, 0, 0, 0, makeCell(B.PROPELLER, facingState(f)));
      const [fx, fy, fz] = DIR_VEC[f]!;
      put(input, -fx, -fy, -fz, makeCell(B.PLANKS_PINE)); // the hull it is mounted on
      const m = buildMesh(input);
      checkInvariants(m);
      expectInsideCell(m);
      const qs = allQuads(m);
      expect(qs.every((q) => q.group === 'cutout')).toBe(true);
      const blades = qs.filter((q) => q.tile === bladeTile);
      expect(blades.length).toBe(8);
      expectDoubleSided(blades);
      // s = position along the facing axis measured from the mounting face
      const s = (p: { x: number; y: number; z: number }) => {
        const c = fx !== 0 ? p.x : fy !== 0 ? p.y : p.z;
        return fx + fy + fz > 0 ? c : 1 - c;
      };
      for (const q of blades) for (const p of q.p) expect(s(p)).toBeGreaterThan(0.5); // facing side
      // blades reach the cell edge (but bounds already proved: not beyond)
      const lateral = (p: { x: number; y: number; z: number }) =>
        [p.x, p.y, p.z].filter((_, i) => i !== (fx !== 0 ? 0 : fy !== 0 ? 1 : 2));
      expect(blades.some((q) => q.p.some((p) => lateral(p).some((c) => Math.abs(c) < 1e-6 || Math.abs(c - 1) < 1e-6)))).toBe(true);
      // back plate: present, but its mounting face is culled against the hull
      const plate = qs.filter((q) => q.tile === backTile);
      expect(plate.length).toBe(5);
      for (const q of plate) for (const p of q.p) expect(s(p)).toBeLessThanOrEqual(2 / 16 + 1e-6);
      expect(qs.filter((q) => q.tile === hubTile).length).toBe(5);
    });
  }

  it('shows the back plate face when nothing is behind it', () => {
    const m = single(makeCell(B.PROPELLER, facingState(2)), 0);
    expect(allQuads(m).filter((q) => q.tile === backTile).length).toBe(6);
  });
});
