import { describe, expect, it } from 'vitest';
import type { DryVolume, StructurePose } from '../../src/render/backend';
import { dryVolumeCenter, dryVolumeMatrix, dryVolumeRadius, poseToMatrix } from '../../src/render/three/pose';

/** Applies a column-major matrix to a point (x, y, z, 1). */
function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  out.x = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out.y = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out.z = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  return out;
}
import { qfromAxisAngle, qrotate, vec3, vnormalize } from '../../src/core/math';
import { Rng } from '../../src/core/rng';

function pose(p: [number, number, number], q: { x: number; y: number; z: number; w: number }, pivot: [number, number, number]): StructurePose {
  return { px: p[0], py: p[1], pz: p[2], qx: q.x, qy: q.y, qz: q.z, qw: q.w, pivotX: pivot[0], pivotY: pivot[1], pivotZ: pivot[2], sky: 15, block: 0 };
}

/** Reference: world = p + q * (local - pivot), using the simulation's own quaternion math. */
function refWorld(ps: StructurePose, x: number, y: number, z: number) {
  const r = qrotate({ x: ps.qx, y: ps.qy, z: ps.qz, w: ps.qw }, vec3(x - ps.pivotX, y - ps.pivotY, z - ps.pivotZ));
  return vec3(r.x + ps.px, r.y + ps.py, r.z + ps.pz);
}

describe('structure pose matrix', () => {
  it('identity pose with pivot translates by p - pivot', () => {
    const m = new Float64Array(16);
    poseToMatrix(pose([10, 20, 30], { x: 0, y: 0, z: 0, w: 1 }, [1, 2, 3]), m);
    const o = transformPoint(m, 1, 2, 3, vec3());
    expect(o).toEqual({ x: 10, y: 20, z: 30 });
    expect(m[15]).toBe(1);
    expect(m[3]).toBe(0);
  });

  it('matches the simulation quaternion rotation for random poses', () => {
    const rng = new Rng(1234);
    const m = new Float64Array(16);
    const o = vec3();
    for (let i = 0; i < 200; i++) {
      const axis = vnormalize(vec3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
      const q = qfromAxisAngle(axis, rng.range(-Math.PI, Math.PI));
      const ps = pose([rng.range(-500, 500), rng.range(0, 128), rng.range(-500, 500)], q, [rng.range(-5, 5), rng.range(-5, 5), rng.range(-5, 5)]);
      poseToMatrix(ps, m);
      const lx = rng.range(-10, 10);
      const ly = rng.range(-10, 10);
      const lz = rng.range(-10, 10);
      transformPoint(m, lx, ly, lz, o);
      const r = refWorld(ps, lx, ly, lz);
      expect(o.x).toBeCloseTo(r.x, 9);
      expect(o.y).toBeCloseTo(r.y, 9);
      expect(o.z).toBeCloseTo(r.z, 9);
    }
  });

  it('a slightly non-unit quaternion does not scale the structure', () => {
    const m = new Float64Array(16);
    const q = qfromAxisAngle(vec3(0, 1, 0), 0.7);
    poseToMatrix(pose([0, 0, 0], { x: q.x * 1.01, y: q.y * 1.01, z: q.z * 1.01, w: q.w * 1.01 }, [0, 0, 0]), m);
    const o = transformPoint(m, 3, 0, 4, vec3());
    expect(Math.hypot(o.x, o.y, o.z)).toBeCloseTo(5, 9);
  });

  it('writes into a plain array as well (three Matrix4.elements layout)', () => {
    const arr = new Array<number>(16).fill(0);
    poseToMatrix(pose([1, 2, 3], { x: 0, y: 0, z: 0, w: 1 }, [0, 0, 0]), arr);
    expect(arr.slice(12, 16)).toEqual([1, 2, 3, 1]);
  });
});

describe('dry volume matrix', () => {
  const dry: DryVolume = { ox: -2, oy: 1, oz: -3, sx: 5, sy: 3, sz: 7, scale: 1, mask: new Uint8Array(5 * 3 * 7) };

  it('maps world points of local cells to the mask texel (x -> u, z -> v, y -> w)', () => {
    const rng = new Rng(99);
    const m = new Float64Array(16);
    const o = vec3();
    for (let i = 0; i < 100; i++) {
      const axis = vnormalize(vec3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
      const q = qfromAxisAngle(axis, rng.range(-Math.PI, Math.PI));
      const ps = pose([rng.range(-100, 100), rng.range(30, 60), rng.range(-100, 100)], q, [0.5, 1.5, -0.25]);
      dryVolumeMatrix(ps, dry, m);
      const cx = dry.ox + rng.int(0, dry.sx - 1);
      const cy = dry.oy + rng.int(0, dry.sy - 1);
      const cz = dry.oz + rng.int(0, dry.sz - 1);
      const w = refWorld(ps, cx + 0.5, cy + 0.5, cz + 0.5);
      transformPoint(m, w.x, w.y, w.z, o);
      expect(o.x).toBeCloseTo((cx - dry.ox + 0.5) / dry.sx, 9);
      expect(o.y).toBeCloseTo((cz - dry.oz + 0.5) / dry.sz, 9);
      expect(o.z).toBeCloseTo((cy - dry.oy + 0.5) / dry.sy, 9);
    }
  });

  it('points outside the box fall outside [0,1)', () => {
    const m = new Float64Array(16);
    const ps = pose([0, 50, 0], { x: 0, y: 0, z: 0, w: 1 }, [0, 0, 0]);
    dryVolumeMatrix(ps, dry, m);
    const o = transformPoint(m, dry.ox - 0.5, 50 + dry.oy + 0.5, dry.oz + 0.5, vec3());
    expect(o.x).toBeLessThan(0);
    transformPoint(m, dry.ox + dry.sx + 0.1, 50 + dry.oy + 0.5, dry.oz + 0.5, o);
    expect(o.x).toBeGreaterThan(1);
  });

  it('box centre and bounding radius', () => {
    const q = qfromAxisAngle(vec3(0, 1, 0), Math.PI / 2);
    const ps = pose([10, 50, 10], q, [0, 0, 0]);
    const c = dryVolumeCenter(ps, dry, vec3());
    const r = refWorld(ps, dry.ox + dry.sx / 2, dry.oy + dry.sy / 2, dry.oz + dry.sz / 2);
    expect(c.x).toBeCloseTo(r.x, 9);
    expect(c.y).toBeCloseTo(r.y, 9);
    expect(c.z).toBeCloseTo(r.z, 9);
    expect(dryVolumeRadius(dry)).toBeCloseTo(0.5 * Math.hypot(5, 3, 7), 12);
  });
});

describe('camera-relative transforms', () => {
  // Review finding (float32 far from the origin): the dry-volume matrix takes camera-relative
  // positions, so its translation stays small and its float32 copy is exact enough.
  it('dry volume matrix with an origin maps (world - origin) like the plain matrix maps world', () => {
    const dry: DryVolume = { ox: -1, oy: -1, oz: -1, sx: 9, sy: 5, sz: 7, scale: 1, mask: new Uint8Array(9 * 5 * 7) };
    const q = qfromAxisAngle(vnormalize(vec3(0.2, 1, 0.1)), 0.8);
    const ps = pose([1048576.3, 47.6, -2097152.8], q, [3.5, 1, 2.5]);
    const plain = new Float64Array(16);
    const rel = new Float64Array(16);
    const cam = [1048570.25, 52.5, -2097160.5] as const;
    dryVolumeMatrix(ps, dry, plain);
    dryVolumeMatrix(ps, dry, rel, cam[0], cam[1], cam[2]);
    const wpt = refWorld(ps, 2.3, 1.4, 3.9);
    const a = transformPoint(plain, wpt.x, wpt.y, wpt.z, vec3());
    const b = transformPoint(rel, wpt.x - cam[0], wpt.y - cam[1], wpt.z - cam[2], vec3());
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
    expect(b.x).toBeCloseTo((2.3 - dry.ox) / dry.sx, 6);
    // The camera-relative translation is small (no catastrophic cancellation in float32).
    for (const k of [12, 13, 14]) expect(Math.abs(rel[k]!)).toBeLessThan(10);
    expect(Math.fround(rel[12]!)).toBeCloseTo(rel[12]!, 6);
  });
});
