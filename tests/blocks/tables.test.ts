/**
 * The geometry tables of docs/SHAPES.md section 2. Each table is recomputed here from the
 * specification's TEXT (written independently of src/blocks/shapes.ts: geometry by half-cell
 * coordinates instead of bit tricks) and compared entry by entry, plus the FNV-1a checksums
 * and worked examples the specification gives.
 */
import { describe, expect, it } from 'vitest';
import { ALL_DIRS, DIR_X, DIR_Y, DIR_Z, type Dir } from '../../src/core/dirs';
import {
  BOXES,
  BOX_COUNT,
  CENTROID,
  DROP_POINT,
  FACE_COVER,
  FILL_VOLUME,
  HALF_FILL,
  ROT_FILL,
  faceCover,
  isCellFace,
  quadrantOctant,
  rotIndex,
  rotateFill,
} from '../../src/blocks/shapes';
import { rotCompose, rotDir, rotInverse, rotVec, type GridRot } from '../../src/structures/orient';

/** FNV-1a, 32 bits, over bytes (section 2). */
function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h >>> 0;
}
const bytesOf = (a: Uint8Array | Uint32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Octant at integer offsets (bx, by, bz) in {0, 1}. */
const octant = (bx: number, by: number, bz: number): number => bx + 2 * by + 4 * bz;
/** Centre of octant o, cell-local. */
function centre(o: number): [number, number, number] {
  return [(o % 2) * 0.5 + 0.25, (Math.floor(o / 2) % 2) * 0.5 + 0.25, Math.floor(o / 4) * 0.5 + 0.25];
}
const occupied = (fill: number): number[] => [0, 1, 2, 3, 4, 5, 6, 7].filter((o) => (fill & (1 << o)) !== 0);

describe('2.1 volume, centroid, drop point', () => {
  it('match the definitions for every fill', () => {
    for (let f = 0; f < 256; f++) {
      const os = occupied(f);
      expect(FILL_VOLUME[f]).toBe(os.length);
      for (let axis = 0; axis < 3; axis++) {
        const mean = os.length === 0 ? 0.5 : os.reduce((s, o) => s + centre(o)[axis]!, 0) / os.length;
        expect(CENTROID[f * 3 + axis]).toBeCloseTo(mean, 12);
        // DROP_POINT: cell centre for 0xff and 0, else the centre of the lowest occupied octant.
        const drop = f === 0 || f === 0xff ? 0.5 : centre(os[0]!)[axis]!;
        expect(DROP_POINT[f * 3 + axis]).toBe(drop);
      }
    }
  });

  it('examples of the specification', () => {
    const c = (f: number): number[] => [CENTROID[f * 3]!, CENTROID[f * 3 + 1]!, CENTROID[f * 3 + 2]!];
    const d = (f: number): number[] => [DROP_POINT[f * 3]!, DROP_POINT[f * 3 + 1]!, DROP_POINT[f * 3 + 2]!];
    expect(FILL_VOLUME[0x33]).toBe(4);
    expect(c(0x33)).toEqual([0.5, 0.25, 0.5]);
    expect(FILL_VOLUME[0x3f]).toBe(6);
    c(0x3f).forEach((v, i) => expect(v).toBeCloseTo([0.5, 5 / 12, 5 / 12][i]!, 12));
    expect(FILL_VOLUME[0xfe]).toBe(7);
    c(0xfe).forEach((v) => expect(v).toBeCloseTo(15 / 28, 12));
    expect(d(0xff)).toEqual([0.5, 0.5, 0.5]);
    expect(d(0)).toEqual([0.5, 0.5, 0.5]);
    expect(d(0x33)).toEqual([0.25, 0.25, 0.25]);
    expect(d(0xcc)).toEqual([0.25, 0.75, 0.25]);
    expect(d(0x80)).toEqual([0.75, 0.75, 0.75]);
  });

  it('a drop point of a non-full part lies in an octant the part occupied', () => {
    for (let f = 1; f < 255; f++) {
      const o = octant(DROP_POINT[f * 3]! > 0.5 ? 1 : 0, DROP_POINT[f * 3 + 1]! > 0.5 ? 1 : 0, DROP_POINT[f * 3 + 2]! > 0.5 ? 1 : 0);
      expect(f & (1 << o)).not.toBe(0);
    }
  });

  it('HALF_FILL is the four octants on each side', () => {
    expect([...HALF_FILL]).toEqual([0xaa, 0x55, 0xcc, 0x33, 0xf0, 0x0f]);
    for (const d of ALL_DIRS) {
      const want = occupied(0xff).filter((o) => {
        const p = centre(o);
        const axis = d >> 1;
        return (d & 1) === 0 ? p[axis]! > 0.5 : p[axis]! < 0.5;
      });
      expect(HALF_FILL[d]).toBe(want.reduce((m, o) => m | (1 << o), 0));
    }
  });
});

// ---------------------------------------------------------------------------- 2.2 boxes

interface Box {
  lo: [number, number, number];
  hi: [number, number, number];
}
/** The 27 candidates of 2.2, coded rx + 3*ry + 9*rz with r 0 = [0,1), 1 = [1,2), 2 = [0,2). */
function candidates(): Box[] {
  const span = (r: number): [number, number] => (r === 0 ? [0, 1] : r === 1 ? [1, 2] : [0, 2]);
  const list: Array<{ code: number; box: Box; volume: number }> = [];
  for (let rz = 0; rz < 3; rz++) {
    for (let ry = 0; ry < 3; ry++) {
      for (let rx = 0; rx < 3; rx++) {
        const [x0, x1] = span(rx);
        const [y0, y1] = span(ry);
        const [z0, z1] = span(rz);
        list.push({ code: rx + 3 * ry + 9 * rz, box: { lo: [x0, y0, z0], hi: [x1, y1, z1] }, volume: (x1 - x0) * (y1 - y0) * (z1 - z0) });
      }
    }
  }
  list.sort((a, b) => (a.volume !== b.volume ? b.volume - a.volume : a.code - b.code));
  return list.map((e) => e.box);
}
function boxOctants(b: Box): number {
  let m = 0;
  for (let z = b.lo[2]; z < b.hi[2]; z++) for (let y = b.lo[1]; y < b.hi[1]; y++) for (let x = b.lo[0]; x < b.hi[0]; x++) m |= 1 << octant(x, y, z);
  return m;
}
/** The decomposition defined by 2.2: try k = 1..4, depth first, always covering the lowest remaining octant. */
function decompose(fill: number): Box[] {
  const cands = candidates();
  const tryWith = (left: number, k: number, acc: Box[]): Box[] | null => {
    if (left === 0) return acc;
    if (k === 0) return null;
    const lowest = occupied(left)[0]!;
    for (const b of cands) {
      const m = boxOctants(b);
      if ((m & (1 << lowest)) === 0) continue;
      if ((m & left) !== m) continue;
      const r = tryWith(left & ~m, k - 1, [...acc, b]);
      if (r !== null) return r;
    }
    return null;
  };
  for (let k = 1; k <= 4; k++) {
    const r = tryWith(fill, k, []);
    if (r !== null) return r;
  }
  throw new Error(`no decomposition for ${fill}`);
}
function tableBoxes(f: number): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < BOX_COUNT[f]!; k++) out.push([...BOXES.subarray(f * 24 + k * 6, f * 24 + k * 6 + 6)]);
  return out;
}

describe('2.2 box decomposition', () => {
  it('equals the defined search for every fill; unused entries are 0', () => {
    expect(BOX_COUNT[0]).toBe(0);
    for (let f = 1; f < 256; f++) {
      const want = decompose(f).map((b) => [...b.lo, ...b.hi]);
      expect(tableBoxes(f), `fill ${f.toString(16)}`).toEqual(want);
    }
    for (let f = 0; f < 256; f++) for (let i = BOX_COUNT[f]! * 6; i < 24; i++) expect(BOXES[f * 24 + i]).toBe(0);
  });

  it('boxes are disjoint, cover the fill exactly, and the counts are 1, 27, 130, 88, 10', () => {
    const histogram = [0, 0, 0, 0, 0];
    let total = 0;
    for (let f = 0; f < 256; f++) {
      let union = 0;
      for (const [x0, y0, z0, x1, y1, z1] of tableBoxes(f)) {
        const m = boxOctants({ lo: [x0!, y0!, z0!], hi: [x1!, y1!, z1!] });
        expect(union & m).toBe(0);
        union |= m;
      }
      expect(union).toBe(f);
      histogram[BOX_COUNT[f]!]!++;
      total += BOX_COUNT[f]!;
    }
    expect(histogram).toEqual([1, 27, 130, 88, 10]);
    expect(total).toBe(591);
    const four = [...Array(256).keys()].filter((f) => BOX_COUNT[f] === 4);
    expect(four).toEqual([0x69, 0x6b, 0x6d, 0x79, 0x96, 0x97, 0x9e, 0xb6, 0xd6, 0xe9]);
  });

  it('examples and checksums', () => {
    expect(tableBoxes(0x33)).toEqual([[0, 0, 0, 2, 1, 2]]);
    expect(tableBoxes(0x3f)).toEqual([[0, 0, 0, 2, 2, 1], [0, 0, 1, 2, 1, 2]]);
    expect(tableBoxes(0x17)).toEqual([[0, 0, 0, 2, 1, 1], [0, 1, 0, 1, 2, 1], [0, 0, 1, 1, 1, 2]]);
    expect(tableBoxes(0x69)).toEqual([[0, 0, 0, 1, 1, 1], [1, 1, 0, 2, 2, 1], [1, 0, 1, 2, 1, 2], [0, 1, 1, 1, 2, 2]]);
    expect(fnv1a(BOX_COUNT)).toBe(0xff6a7052);
    expect(fnv1a(BOXES)).toBe(0xb0400b5f);
  });
});

// ---------------------------------------------------------------------------- 2.3 face cover

describe('2.3 face quadrant cover', () => {
  it('quadrantOctant follows the listed octants', () => {
    const listed: Record<number, number[]> = { 0: [1, 3, 5, 7], 1: [0, 2, 4, 6], 2: [2, 3, 6, 7], 3: [0, 1, 4, 5], 4: [4, 5, 6, 7], 5: [0, 1, 2, 3] };
    for (const d of ALL_DIRS) expect([0, 1, 2, 3].map((q) => quadrantOctant(d, q))).toEqual(listed[d]);
  });

  it('FACE_COVER matches the definition for every fill', () => {
    for (let f = 0; f < 256; f++) {
      let want = 0;
      for (const d of ALL_DIRS) {
        const a = d >> 1;
        const [u, v] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
        for (let q = 0; q < 4; q++) {
          const bits = [0, 0, 0];
          bits[a] = (d & 1) === 0 ? 1 : 0;
          bits[u!] = q % 2;
          bits[v!] = Math.floor(q / 2);
          if (f & (1 << octant(bits[0]!, bits[1]!, bits[2]!))) want |= 1 << (d * 4 + q);
        }
        expect(faceCover(f, d)).toBe((want >>> (d * 4)) & 15);
      }
      expect(FACE_COVER[f]).toBe(want >>> 0);
    }
  });

  it('a quadrant number names the same square on both sides of a face', () => {
    // Quadrant q of face d of cell A (at the origin) and quadrant q of face d ^ 1 of its neighbour B
    // have the same square centre in world space.
    for (const d of ALL_DIRS) {
      for (let q = 0; q < 4; q++) {
        const sq = (cellOffset: number[], face: Dir): number[] => {
          const c = centre(quadrantOctant(face, q));
          const a = face >> 1;
          const p = [c[0] + cellOffset[0]!, c[1] + cellOffset[1]!, c[2] + cellOffset[2]!];
          p[a] = cellOffset[a]! + ((face & 1) === 0 ? 1 : 0);
          return p;
        };
        expect(sq([DIR_X[d]!, DIR_Y[d]!, DIR_Z[d]!], (d ^ 1) as Dir)).toEqual(sq([0, 0, 0], d));
      }
    }
  });

  it('isCellFace: the octant face lies on the cell boundary', () => {
    for (let o = 0; o < 8; o++) {
      for (const f of ALL_DIRS) {
        const c = centre(o)[f >> 1]!;
        const faceAt = (f & 1) === 0 ? c + 0.25 : c - 0.25;
        expect(isCellFace(o, f)).toBe(faceAt === 0 || faceAt === 1);
      }
    }
  });

  it('examples and checksum', () => {
    expect(FACE_COVER[0x33]).toBe(0x33f055);
    expect(FACE_COVER[0xcc]).toBe(0xcc0faa);
    expect(FACE_COVER[0x01]).toBe(0x101010);
    expect(FACE_COVER[0xff]).toBe(0xffffff);
    expect(fnv1a(bytesOf(FACE_COVER))).toBe(0x8c5fbde5);
  });
});

// ---------------------------------------------------------------------------- 2.4 rotations

const ORDER: Array<[Dir, Dir, Dir]> = [
  [0, 2, 4], [0, 3, 5], [0, 4, 3], [0, 5, 2], [1, 2, 5], [1, 3, 4], [1, 4, 2], [1, 5, 3],
  [2, 0, 5], [2, 1, 4], [2, 4, 0], [2, 5, 1], [3, 0, 4], [3, 1, 5], [3, 4, 1], [3, 5, 0],
  [4, 0, 2], [4, 1, 3], [4, 2, 1], [4, 3, 0], [5, 0, 3], [5, 1, 2], [5, 2, 0], [5, 3, 1],
];
const ROTS: GridRot[] = ORDER.map(([ax, ay, az]) => ({ ax, ay, az }));
/** Octant image by rotVec of the octant centre offset (2.4), read back by signs. */
function octantImage(r: GridRot, o: number): number {
  const c = centre(o);
  const v = rotVec(r, c[0] - 0.5, c[1] - 0.5, c[2] - 0.5);
  return octant(v.x > 0 ? 1 : 0, v.y > 0 ? 1 : 0, v.z > 0 ? 1 : 0);
}
function rotFillRef(r: GridRot, f: number): number {
  return occupied(f).reduce((m, o) => m | (1 << octantImage(r, o)), 0);
}

describe('2.4 the 24 rotations', () => {
  it('rotIndex numbers the rotations in the listed order', () => {
    ROTS.forEach((r, i) => expect(rotIndex(r.ax, r.ay)).toBe(i));
    expect(() => rotIndex(0, 1)).toThrow(RangeError);
    expect(() => rotIndex(2, 2)).toThrow(RangeError);
  });

  it('ROT_FILL rotates the octant centres with rotVec', () => {
    ROTS.forEach((r, i) => {
      for (let f = 0; f < 256; f++) {
        expect(ROT_FILL[i * 256 + f]).toBe(rotFillRef(r, f));
        expect(rotateFill(f, r.ax, r.ay)).toBe(ROT_FILL[i * 256 + f]);
      }
    });
  });

  it('each rotation is a distinct permutation; composition and inverse agree with orient.ts', () => {
    const perms = new Set<string>();
    for (const r of ROTS) {
      const img = [0, 1, 2, 3, 4, 5, 6, 7].map((o) => rotateFill(1 << o, r.ax, r.ay));
      expect(new Set(img).size).toBe(8);
      img.forEach((m) => expect(FILL_VOLUME[m]).toBe(1));
      perms.add(img.join(','));
    }
    expect(perms.size).toBe(24);
    for (const a of ROTS) {
      const inv = rotInverse(a);
      for (const b of ROTS) {
        const ab = rotCompose(a, b);
        for (let f = 0; f < 256; f += 7) expect(rotateFill(f, ab.ax, ab.ay)).toBe(rotateFill(rotateFill(f, b.ax, b.ay), a.ax, a.ay));
      }
      for (let f = 0; f < 256; f++) expect(rotateFill(rotateFill(f, a.ax, a.ay), inv.ax, inv.ay)).toBe(f);
    }
  });

  it('face covers follow rotDir', () => {
    for (const r of ROTS) {
      for (let f = 0; f < 256; f++) {
        const g = rotateFill(f, r.ax, r.ay);
        for (const d of ALL_DIRS) {
          // The cover of face d before rotation is the cover of face rotDir(d) after, quadrant
          // by quadrant mapped through the octant permutation.
          const before = [0, 1, 2, 3].filter((q) => (faceCover(f, d) >> q) & 1).map((q) => octantImage(r, quadrantOctant(d, q)));
          const e = rotDir(r, d);
          const after = [0, 1, 2, 3].filter((q) => (faceCover(g, e) >> q) & 1).map((q) => quadrantOctant(e, q));
          expect(after.sort()).toEqual(before.sort());
        }
      }
    }
  });

  it('examples, 23 shapes under rotation, checksum', () => {
    const left = ROTS[22]!; // about +Y a quarter turn left: +X -> -Z
    expect(left).toEqual({ ax: 5, ay: 2, az: 0 });
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((o) => Math.log2(rotateFill(1 << o, left.ax, left.ay)))).toEqual([4, 0, 6, 2, 5, 1, 7, 3]);
    expect(rotateFill(0x55, left.ax, left.ay)).toBe(0xf0);
    expect(rotateFill(0x33, left.ax, left.ay)).toBe(0x33);
    expect(rotateFill(0x01, left.ax, left.ay)).toBe(0x10);
    const tip = ROTS[2]!; // about +X, +Y -> +Z
    expect(rotateFill(0x33, tip.ax, tip.ay)).toBe(0x0f);
    const classes = new Set<number>();
    for (let f = 0; f < 256; f++) classes.add(Math.min(...ROTS.map((r) => rotateFill(f, r.ax, r.ay))));
    expect(classes.size).toBe(23);
    expect(fnv1a(ROT_FILL)).toBe(0x70650245);
  });
});
