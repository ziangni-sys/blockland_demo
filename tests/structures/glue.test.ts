import { describe, expect, it } from 'vitest';
import { ALL_DIRS, DIR_X, DIR_Y, DIR_Z, NX, NY, NZ, PX, PY, PZ, opposite, type Axis, type Dir } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { GLUE_MAX_XZ, GLUE_MAX_Y, GLUE_MIN_XZ, GLUE_MIN_Y, GlueStore, type GlueFace } from '../../src/structures/glue';

type P = { x: number; y: number; z: number };

/** Independent reference model: canonical "x,y,z,axis" strings. */
function canonKey(x: number, y: number, z: number, dir: Dir): string {
  const axis = dir >> 1;
  if (dir & 1) {
    x -= DIR_X[dir] === -1 ? 1 : 0;
    y -= DIR_Y[dir] === -1 ? 1 : 0;
    z -= DIR_Z[dir] === -1 ? 1 : 0;
  }
  return `${x},${y},${z},${axis}`;
}

function facesOf(s: GlueStore): string[] {
  const out: string[] = [];
  s.forEach((x, y, z, axis) => out.push(`${x},${y},${z},${axis}`));
  return out.sort();
}

/** Direction from cell a to adjacent cell b. */
function dirBetween(a: P, b: P): Dir {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  expect(Math.abs(dx) + Math.abs(dy) + Math.abs(dz)).toBe(1);
  return (dx === 1 ? PX : dx === -1 ? NX : dy === 1 ? PY : dy === -1 ? NY : dz === 1 ? PZ : NZ) as Dir;
}

describe('GlueStore: single faces', () => {
  it('a face is the same from both of its cells', () => {
    const s = new GlueStore();
    expect(s.add(0, 0, 0, PX)).toBe(true);
    expect(s.has(0, 0, 0, PX)).toBe(true);
    expect(s.has(1, 0, 0, NX)).toBe(true);
    expect(s.add(1, 0, 0, NX)).toBe(false); // same face
    expect(s.size).toBe(1);
    expect(s.has(0, 0, 0, NX)).toBe(false);
    expect(s.has(0, 0, 0, PY)).toBe(false);
    expect(s.has(1, 0, 0, PX)).toBe(false);
    expect(s.remove(1, 0, 0, NX)).toBe(true);
    expect(s.remove(0, 0, 0, PX)).toBe(false);
    expect(s.size).toBe(0);
  });

  it('canonical key is the smaller end plus the axis, also for negative coordinates', () => {
    const s = new GlueStore();
    s.add(-1, -1, -1, NX);
    s.add(-1, -1, -1, NY);
    s.add(-1, -1, -1, NZ);
    s.add(-16, 0, -17, PZ);
    expect(facesOf(s)).toEqual(['-1,-1,-2,2', '-1,-2,-1,1', '-16,0,-17,2', '-2,-1,-1,0'].sort());
    expect(s.has(-2, -1, -1, PX)).toBe(true);
    expect(s.has(-1, -2, -1, PY)).toBe(true);
    expect(s.has(-1, -1, -2, PZ)).toBe(true);
    expect(s.has(-16, 0, -16, NZ)).toBe(true);
  });

  it('every face of a cube spanning bucket and sign borders is distinct', () => {
    // -18..17 crosses the bucket borders at -16, 0 and 16 on every axis.
    const s = new GlueStore();
    const lo = -18;
    const hi = 17;
    let n = 0;
    for (let x = lo; x <= hi; x++) {
      for (let y = lo; y <= hi; y++) {
        for (let z = lo; z <= hi; z++) {
          // Only every other face, so that "absent" faces are checked too.
          for (const d of [PX, PY, PZ] as Dir[]) {
            if (((x + y * 3 + z * 5 + d) & 1) === 0) {
              expect(s.add(x, y, z, d)).toBe(true);
              n++;
            }
          }
        }
      }
    }
    expect(s.size).toBe(n);
    for (let x = lo; x <= hi; x++) {
      for (let y = lo; y <= hi; y++) {
        for (let z = lo; z <= hi; z++) {
          for (const d of [PX, PY, PZ] as Dir[]) {
            const want = ((x + y * 3 + z * 5 + d) & 1) === 0;
            if (s.has(x, y, z, d) !== want) throw new Error(`face ${x},${y},${z} dir ${d}`);
            const o = d + 1;
            if (s.has(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!, o as Dir) !== want) throw new Error(`back face ${x},${y},${z}`);
          }
        }
      }
    }
  });

  it('supports the documented coordinate range exactly', () => {
    expect(GLUE_MIN_XZ).toBeLessThanOrEqual(-4_000_000);
    expect(GLUE_MAX_XZ).toBeGreaterThanOrEqual(4_000_000);
    expect(GLUE_MIN_Y).toBeLessThanOrEqual(-100_000);
    expect(GLUE_MAX_Y).toBeGreaterThanOrEqual(100_000);
    const s = new GlueStore();
    const corners: Array<[number, number, number]> = [];
    for (const x of [GLUE_MIN_XZ, GLUE_MAX_XZ - 1, -1, 0]) {
      for (const y of [GLUE_MIN_Y, GLUE_MAX_Y - 1, -1, 0]) {
        for (const z of [GLUE_MIN_XZ, GLUE_MAX_XZ - 1, -1, 0]) corners.push([x, y, z]);
      }
    }
    for (const [x, y, z] of corners) for (const d of [PX, PY, PZ] as Dir[]) expect(s.add(x, y, z, d)).toBe(true);
    expect(s.size).toBe(corners.length * 3);
    for (const [x, y, z] of corners) {
      for (const d of [PX, PY, PZ] as Dir[]) {
        expect(s.has(x, y, z, d)).toBe(true);
        expect(s.has(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!, opposite(d))).toBe(true);
      }
    }
    // The upper-most canonical cells work too (their other end is one beyond).
    expect(s.add(GLUE_MAX_XZ, GLUE_MAX_Y, GLUE_MAX_XZ, PX)).toBe(true);
    expect(s.has(GLUE_MAX_XZ + 1, GLUE_MAX_Y, GLUE_MAX_XZ, NX)).toBe(true);
    const arr = s.toArray();
    expect(GlueStore.fromArray(arr).toArray()).toEqual(arr);
  });

  it('rejects faces outside the range or with bad input', () => {
    const s = new GlueStore();
    expect(() => s.add(GLUE_MAX_XZ + 1, 0, 0, PX)).toThrow(RangeError);
    expect(() => s.add(GLUE_MIN_XZ, 0, 0, NX)).toThrow(RangeError); // canonical end is MIN-1
    expect(() => s.add(0, GLUE_MAX_Y + 1, 0, PY)).toThrow(RangeError);
    expect(() => s.add(0, GLUE_MIN_Y, 0, NY)).toThrow(RangeError);
    expect(() => s.add(0, 0, GLUE_MIN_XZ - 5, PZ)).toThrow(RangeError);
    expect(() => s.add(0.5, 0, 0, PX)).toThrow(RangeError);
    expect(() => s.add(Number.NaN, 0, 0, PX)).toThrow(RangeError);
    expect(() => s.add(0, 0, 0, 6 as Dir)).toThrow(RangeError);
    expect(s.size).toBe(0);
    s.add(1, 0, 0, PX);
    expect(s.has(1.5, 0, 0, PX)).toBe(false);
    expect(s.has(GLUE_MAX_XZ + 17, 0, 0, PX)).toBe(false);
    expect(s.remove(Number.NaN, 0, 0, PX)).toBe(false);
    expect(s.dirMaskAt(1e12, 0, 0)).toBe(0);
    expect(s.size).toBe(1);
  });

  it('matches a reference model under random operations', () => {
    const rng = new Rng(1234);
    const s = new GlueStore();
    const ref = new Set<string>();
    const coord = (wide: boolean, lo: number, hi: number): number => (wide ? rng.int(lo + 1, hi - 1) : rng.int(-20, 20));
    for (let i = 0; i < 20000; i++) {
      const wide = rng.chance(0.2);
      const x = coord(wide, GLUE_MIN_XZ, GLUE_MAX_XZ);
      const y = coord(wide, GLUE_MIN_Y, GLUE_MAX_Y);
      const z = coord(wide, GLUE_MIN_XZ, GLUE_MAX_XZ);
      const d = rng.int(0, 5) as Dir;
      const k = canonKey(x, y, z, d);
      const op = rng.int(0, 3);
      if (op === 0 || op === 1) {
        expect(s.add(x, y, z, d)).toBe(!ref.has(k));
        ref.add(k);
      } else if (op === 2) {
        expect(s.remove(x, y, z, d)).toBe(ref.has(k));
        ref.delete(k);
      } else {
        expect(s.has(x, y, z, d)).toBe(ref.has(k));
      }
    }
    expect(s.size).toBe(ref.size);
    expect(facesOf(s)).toEqual([...ref].sort());
  });
});

describe('GlueStore: dirMaskAt', () => {
  it('reports exactly the six faces touching a cell', () => {
    const s = new GlueStore();
    for (const d of ALL_DIRS) s.add(-3, 7, -1, d);
    // Unrelated faces: neighbours' other faces and a face two cells away.
    s.add(-2, 7, -1, PX);
    s.add(-4, 7, -1, PY);
    s.add(-3, 9, -1, NY);
    s.add(-3, 8, -1, PZ);
    expect(s.size).toBe(10);
    expect(s.dirMaskAt(-3, 7, -1)).toBe(0b111111);
    s.remove(-3, 7, -1, NX);
    s.remove(-3, 7, -1, PY);
    expect(s.dirMaskAt(-3, 7, -1)).toBe(0b111111 & ~(1 << NX) & ~(1 << PY));
    expect(s.dirMaskAt(-3, 9, -1)).toBe(1 << NY);
  });
  it('dirMaskAt reports each direction bit', () => {
    const s = new GlueStore();
    for (const d of ALL_DIRS) {
      s.clear();
      s.add(5, -5, 16, d);
      expect(s.dirMaskAt(5, -5, 16)).toBe(1 << d);
      expect(s.dirMaskAt(5 + DIR_X[d]!, -5 + DIR_Y[d]!, 16 + DIR_Z[d]!)).toBe(1 << opposite(d));
    }
  });
});

describe('GlueStore: iteration and box queries', () => {
  it('forEach yields canonical cell + axis, once per face', () => {
    const s = new GlueStore();
    s.add(3, 3, 3, NX);
    s.add(3, 3, 3, NY);
    s.add(3, 3, 3, PZ);
    const seen: string[] = [];
    s.forEach((x, y, z, axis) => seen.push(`${x},${y},${z},${axis}`));
    expect(seen.sort()).toEqual(['2,3,3,0', '3,2,3,1', '3,3,3,2']);
  });

  // Dense stores take the "walk the buckets of the box" path, sparse ones the "walk the
  // stored buckets" path; both must give the brute-force answer.
  for (const faces of [3000, 25]) it(`facesInBox returns every face with at least one end in the inclusive box (${faces} faces)`, () => {
    const rng = new Rng(99 + faces);
    const s = new GlueStore();
    for (let i = 0; i < faces; i++) s.add(rng.int(-40, 40), rng.int(-40, 40), rng.int(-40, 40), rng.int(0, 5) as Dir);
    const all: GlueFace[] = [];
    s.forEach((x, y, z, axis) => all.push({ x, y, z, axis }));
    const inBox = (x: number, y: number, z: number, b: number[]): boolean =>
      x >= b[0]! && x <= b[3]! && y >= b[1]! && y <= b[4]! && z >= b[2]! && z <= b[5]!;
    for (let q = 0; q < 200; q++) {
      const x0 = rng.int(-45, 45);
      const y0 = rng.int(-45, 45);
      const z0 = rng.int(-45, 45);
      const b = q % 3 === 0
        ? [x0, y0, z0, x0 + rng.int(0, 3), y0 + rng.int(0, 3), z0 + rng.int(0, 3)]
        : [x0, y0, z0, x0 + rng.int(0, 60), y0 + rng.int(0, 60), z0 + rng.int(0, 60)];
      const want = all
        .filter((f) => inBox(f.x, f.y, f.z, b) || inBox(f.x + (f.axis === 0 ? 1 : 0), f.y + (f.axis === 1 ? 1 : 0), f.z + (f.axis === 2 ? 1 : 0), b))
        .map((f) => `${f.x},${f.y},${f.z},${f.axis}`)
        .sort();
      const got = s.facesInBox(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!).map((f) => `${f.x},${f.y},${f.z},${f.axis}`);
      expect(new Set(got).size).toBe(got.length); // no duplicates
      expect(got.sort()).toEqual(want);
    }
  });

  it('facesInBox: boundary faces, fractional and empty or unbounded boxes', () => {
    const s = new GlueStore();
    s.add(10, 0, 0, PX); // joins 10 and 11
    s.add(-1, 0, 0, PX); // joins -1 and 0
    expect(s.facesInBox(11, 0, 0, 20, 0, 0)).toEqual([{ x: 10, y: 0, z: 0, axis: 0 }]);
    expect(s.facesInBox(0, 0, 0, 9, 0, 0)).toEqual([{ x: -1, y: 0, z: 0, axis: 0 }]);
    expect(s.facesInBox(1, 0, 0, 9, 0, 0)).toEqual([]);
    expect(s.facesInBox(10.6, 0.2, 0.9, 10.9, 0.5, 0.95)).toEqual([{ x: 10, y: 0, z: 0, axis: 0 }]);
    expect(s.facesInBox(5, 0, 0, 4, 0, 0)).toEqual([]);
    expect(s.facesInBox(Number.NaN, 0, 0, 4, 0, 0)).toEqual([]);
    expect(s.facesInBox(-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity).length).toBe(2);
  });

  // Regression (review): the bounds used to be clamped to [MIN - 1, MAX + 1] before the test,
  // which squashed a box lying wholly beyond MAX + 1 onto the plane MAX + 1, the far end of
  // faces keyed on MAX, and reported those faces.
  it('box queries at the edges of the key range return exactly the faces with an end inside', () => {
    const s = new GlueStore();
    s.add(GLUE_MAX_XZ, 0, 0, PX); // x = MAX .. MAX+1
    s.add(0, 0, GLUE_MAX_XZ, PZ); // z = MAX .. MAX+1
    s.add(0, GLUE_MAX_Y, 0, PY); // y = MAX_Y .. MAX_Y+1
    s.add(GLUE_MIN_XZ, 5, 5, PX); // x = MIN .. MIN+1
    s.add(5, GLUE_MIN_Y, 5, PY); // y = MIN_Y .. MIN_Y+1
    s.add(GLUE_MAX_XZ, 7, -3, PX);
    const keys = (fs: GlueFace[]): string[] => fs.map((f) => `${f.x},${f.y},${f.z},${f.axis}`).sort();
    const count = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
      let n = 0;
      s.forEachInBox(x0, y0, z0, x1, y1, z1, () => n++);
      return n;
    };
    // Boxes wholly beyond the upper end of the range, on each axis.
    expect(s.facesInBox(GLUE_MAX_XZ + 5, 0, 0, GLUE_MAX_XZ + 10, 0, 0)).toEqual([]);
    expect(s.facesInBox(-1, -1, GLUE_MAX_XZ + 2, 1, 1, GLUE_MAX_XZ + 5)).toEqual([]);
    expect(s.facesInBox(0, GLUE_MAX_Y + 5, 0, 0, GLUE_MAX_Y + 10, 0)).toEqual([]);
    expect(s.facesInBox(-1, GLUE_MAX_Y + 3, -1, 1, GLUE_MAX_Y + 9, 1)).toEqual([]);
    expect(count(GLUE_MAX_XZ + 2, 7, -3, GLUE_MAX_XZ + 1000, 7, -3)).toBe(0);
    expect(count(GLUE_MAX_XZ + 10, -1, -1, GLUE_MAX_XZ + 20, 1, 1)).toBe(0);
    expect(count(GLUE_MAX_XZ + 2, -Infinity, -Infinity, Infinity, Infinity, Infinity)).toBe(0);
    // ... and wholly below the lower end.
    expect(s.facesInBox(GLUE_MIN_XZ - 10, 5, 5, GLUE_MIN_XZ - 1, 5, 5)).toEqual([]);
    expect(s.facesInBox(5, GLUE_MIN_Y - 10, 5, 5, GLUE_MIN_Y - 1, 5)).toEqual([]);
    expect(count(-Infinity, -Infinity, -Infinity, GLUE_MIN_XZ - 1, Infinity, Infinity)).toBe(0);
    // A box that just reaches the far end MAX + 1 (or the near end MIN) still finds the face.
    expect(keys(s.facesInBox(GLUE_MAX_XZ + 1, 0, 0, GLUE_MAX_XZ + 50, 0, 0))).toEqual([`${GLUE_MAX_XZ},0,0,0`]);
    expect(keys(s.facesInBox(GLUE_MAX_XZ + 1, -Infinity, -Infinity, Infinity, Infinity, Infinity))).toEqual(
      [`${GLUE_MAX_XZ},0,0,0`, `${GLUE_MAX_XZ},7,-3,0`].sort(),
    );
    expect(keys(s.facesInBox(0, GLUE_MAX_Y + 1, 0, 0, GLUE_MAX_Y + 1, 0))).toEqual([`0,${GLUE_MAX_Y},0,1`]);
    expect(keys(s.facesInBox(-1, -1, GLUE_MAX_XZ + 1, 1, 1, Infinity))).toEqual([`0,0,${GLUE_MAX_XZ},2`]);
    expect(keys(s.facesInBox(-Infinity, 5, 5, GLUE_MIN_XZ, 5, 5))).toEqual([`${GLUE_MIN_XZ},5,5,0`]);
    expect(keys(s.facesInBox(5, -Infinity, 5, 5, GLUE_MIN_Y, 5))).toEqual([`5,${GLUE_MIN_Y},5,1`]);
    expect(count(-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity)).toBe(6);
  });

  it('facesInBox does not scan a large store', () => {
    const s = new GlueStore();
    // ~200k faces spread over many buckets, plus a few near the query point.
    for (let x = 0; x < 400; x++) for (let z = 0; z < 500; z++) s.add(1000 + x * 3, (x * 7 + z) & 63, 1000 + z * 3, ((x + z) % 3) * 2 as Dir);
    s.add(0, 64, 0, PX);
    s.add(2, 65, 1, PY);
    expect(s.size).toBe(200002);
    const t0 = performance.now();
    let found = 0;
    for (let i = 0; i < 2000; i++) found += s.facesInBox(-8, 56, -8, 8, 72, 8).length;
    const ms = performance.now() - t0;
    expect(found).toBe(4000);
    // A scan would visit 2000 * 200k = 4e8 faces (seconds); bucketed queries take ~ms.
    expect(ms).toBeLessThan(200);
  });
});

describe('GlueStore: persistence', () => {
  it('toArray / fromArray round trip, canonical regardless of insertion order', () => {
    const rng = new Rng(5);
    const faces: Array<[number, number, number, Dir]> = [];
    for (let i = 0; i < 500; i++) faces.push([rng.int(-300, 300), rng.int(-300, 300), rng.int(-300, 300), rng.int(0, 5) as Dir]);
    const a = new GlueStore();
    for (const f of faces) a.add(...f);
    const b = new GlueStore();
    for (const f of [...faces].reverse()) b.add(f[0] + DIR_X[f[3]]!, f[1] + DIR_Y[f[3]]!, f[2] + DIR_Z[f[3]]!, opposite(f[3]));
    const arr = a.toArray();
    expect(arr).toBeInstanceOf(Int32Array);
    expect(arr.length).toBe(a.size * 4);
    expect(b.toArray()).toEqual(arr);
    const c = GlueStore.fromArray(arr);
    expect(c.size).toBe(a.size);
    expect(facesOf(c)).toEqual(facesOf(a));
    for (const f of faces) expect(c.has(...f)).toBe(true);
    expect(GlueStore.fromArray(new Int32Array(0)).size).toBe(0);
  });
  it('fromArray rejects malformed data', () => {
    expect(() => GlueStore.fromArray(new Int32Array(5))).toThrow(RangeError);
    expect(() => GlueStore.fromArray(Int32Array.of(0, 0, 0, 3))).toThrow(RangeError);
    expect(() => GlueStore.fromArray(Int32Array.of(GLUE_MAX_XZ + 1, 0, 0, 0))).toThrow(RangeError);
  });
  it('clear empties the store', () => {
    const s = new GlueStore();
    s.add(1, 2, 3, PX);
    s.add(-1, 2, 3, NZ);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.has(1, 2, 3, PX)).toBe(false);
    expect(s.toArray().length).toBe(0);
    expect(s.facesInBox(-10, -10, -10, 10, 10, 10)).toEqual([]);
  });
});

// ------------------------------------------------------------ moveTo

type Map3 = (x: number, y: number, z: number) => P;
const rotX = (p: P): P => ({ x: p.x, y: -p.z, z: p.y }); // +90 deg about +X
const rotY = (p: P): P => ({ x: p.z, y: p.y, z: -p.x }); // +90 deg about +Y
const rotZ = (p: P): P => ({ x: -p.y, y: p.x, z: p.z }); // +90 deg about +Z
function times(f: (p: P) => P, n: number): (p: P) => P {
  return (p) => {
    let q = p;
    for (let i = 0; i < n; i++) q = f(q);
    return q;
  };
}
function transform(r: (p: P) => P, tx: number, ty: number, tz: number): Map3 {
  return (x, y, z) => {
    const q = r({ x, y, z });
    return { x: q.x + tx, y: q.y + ty, z: q.z + tz };
  };
}

interface Cluster {
  s: GlueStore;
  inSet: (x: number, y: number, z: number) => boolean;
  /** moveTo's `stays`: true for the outside end of `oneEndStays` only. */
  stays: (x: number, y: number, z: number) => boolean;
  /** Faces with both ends in the set (they move). */
  inner: Array<[P, P]>;
  /** A face with one end in the set whose outside end stays behind: kept in the source. [in, out] */
  oneEndStays: [P, P];
  /** A face with one end in the set whose outside end does not stay: it moves. [in, out] */
  oneEndMoves: [P, P];
  /** A face with no end in the set (it stays in the source store, untouched). */
  outside: [P, P];
  /** toArray() of a store holding only the faces that move, at their original positions. */
  movedArray: Int32Array;
}

/**
 * A 4x2x2 cell set with glued faces on all three axes (inner), two faces leaving the set —
 * one whose canonical (smaller) end is inside and whose outer end stays behind, one whose far
 * end is inside and whose outer end does not stay — and one face entirely outside it.
 */
function cluster(): Cluster {
  const cells = new Set<string>();
  for (let x = -2; x <= 1; x++) for (let y = 3; y <= 4; y++) for (let z = -1; z <= 0; z++) cells.add(`${x},${y},${z}`);
  const inSet = (x: number, y: number, z: number): boolean => cells.has(`${x},${y},${z}`);
  const stays = (x: number, y: number, z: number): boolean => x === 2 && y === 3 && z === 0;
  const s = new GlueStore();
  const movedOnly = new GlueStore();
  const glue = (a: P, d: Dir): [P, P] => {
    s.add(a.x, a.y, a.z, d);
    return [a, { x: a.x + DIR_X[d]!, y: a.y + DIR_Y[d]!, z: a.z + DIR_Z[d]! }];
  };
  const inner: Array<[P, P]> = [
    glue({ x: -2, y: 3, z: -1 }, PX),
    glue({ x: 1, y: 4, z: 0 }, NX),
    glue({ x: 0, y: 3, z: -1 }, PY),
    glue({ x: -1, y: 4, z: 0 }, NZ),
    glue({ x: 1, y: 3, z: -1 }, PZ),
  ];
  const oneEndStays = glue({ x: 1, y: 3, z: 0 }, PX); // (2,3,0) outside and staying; canonical end inside
  const oneEndMoves = glue({ x: -2, y: 3, z: -1 }, NY); // (-2,2,-1) outside and canonical, not staying
  for (const [a, b] of [...inner, oneEndMoves]) movedOnly.add(a.x, a.y, a.z, dirBetween(a, b));
  const outside = glue({ x: 10, y: 10, z: 10 }, PY);
  for (const [a, b] of [oneEndStays, oneEndMoves, outside]) {
    expect(inSet(a.x, a.y, a.z) && inSet(b.x, b.y, b.z)).toBe(false); // the helper's own sanity
  }
  return { s, inSet, stays, inner, oneEndStays, oneEndMoves, outside, movedArray: movedOnly.toArray() };
}

function hasFace(s: GlueStore, [a, b]: [P, P]): boolean {
  return s.has(a.x, a.y, a.z, dirBetween(a, b));
}

/** Does `s` hold exactly the untouched face and the staying one-end face (nothing that moved)? */
function expectSourceAfterMove(s: GlueStore, c: Cluster): void {
  expect(hasFace(s, c.outside)).toBe(true);
  expect(hasFace(s, c.oneEndStays)).toBe(true);
  expect(hasFace(s, c.oneEndMoves)).toBe(false);
  for (const f of c.inner) expect(hasFace(s, f)).toBe(false);
  expect(s.size).toBe(2);
}

function mapped(map: Map3, [a, b]: [P, P]): [P, P] {
  const ma = map(a.x, a.y, a.z);
  const mb = map(b.x, b.y, b.z);
  return [{ ...ma }, { ...mb }];
}

describe('GlueStore: moveTo', () => {
  it('translation: both-end faces move; a one-end face stays when its outside end stays, else moves; others stay', () => {
    const cl = cluster();
    const { s, inSet, stays, inner } = cl;
    const t = new GlueStore();
    t.add(50, 50, 50, PZ); // pre-existing target glue is kept
    const map = transform((p) => p, 100, -200, 300);
    const n = s.moveTo(t, inSet, map, stays);
    expect(n).toBe(inner.length + 1);
    expectSourceAfterMove(s, cl);
    expect(t.size).toBe(inner.length + 2);
    expect(t.has(50, 50, 50, PZ)).toBe(true);
    for (const f of [...inner, cl.oneEndMoves]) expect(hasFace(t, mapped(map, f))).toBe(true);
    // The staying face is not duplicated into the target.
    expect(hasFace(t, mapped(map, cl.oneEndStays))).toBe(false);
  });

  it('with nothing staying every face touching the set moves; with everything staying only both-end faces do', () => {
    const a = cluster();
    expect(a.s.moveTo(new GlueStore(), a.inSet, (x, y, z) => ({ x, y, z }), () => false)).toBe(a.inner.length + 2);
    expect(a.s.size).toBe(1);
    const b = cluster();
    expect(b.s.moveTo(new GlueStore(), b.inSet, (x, y, z) => ({ x, y, z }), () => true)).toBe(b.inner.length);
    expect(b.s.size).toBe(3);
  });

  it('a moved face landing on a face the target already holds merges with it', () => {
    const s = new GlueStore();
    s.add(0, 0, 0, PX);
    s.add(0, 0, 0, PY);
    const t = new GlueStore();
    t.add(5, 0, 0, PX);
    expect(s.moveTo(t, () => true, (x, y, z) => ({ x: x + 5, y, z }), () => false)).toBe(2);
    expect(t.size).toBe(2);
    expect(t.has(5, 0, 0, PX)).toBe(true);
    expect(t.has(5, 0, 0, PY)).toBe(true);
    expect(s.size).toBe(0);
  });

  for (const [name, rot] of [['X', rotX], ['Y', rotY], ['Z', rotZ]] as const) {
    for (const k of [1, 2, 3]) {
      it(`rotation by ${k * 90} degrees about ${name} re-keys from the mapped ends`, () => {
        const cl = cluster();
        const { s, inSet, stays, inner } = cl;
        const r = times(rot, k);
        const t = new GlueStore();
        const map = transform(r, -7, 5, -3);
        expect(s.moveTo(t, inSet, map, stays)).toBe(inner.length + 1);
        expectSourceAfterMove(s, cl);
        expect(t.size).toBe(inner.length + 1);
        for (const f of [...inner, cl.oneEndMoves]) {
          const [ma, mb] = mapped(map, f);
          expect(t.has(ma.x, ma.y, ma.z, dirBetween(ma, mb))).toBe(true);
          expect(t.has(mb.x, mb.y, mb.z, dirBetween(mb, ma))).toBe(true);
        }
        // Neither the mapped nor the unmapped position of the staying face appears in the target.
        expect(hasFace(t, mapped(map, cl.oneEndStays))).toBe(false);
        expect(hasFace(t, cl.oneEndStays)).toBe(false);
      });
    }
  }

  it('the face axis changes and the canonical end swaps (worked example)', () => {
    const s = new GlueStore();
    s.add(0, 0, 0, PX); // (0,0,0)-(1,0,0)
    const all = (): boolean => true;
    const none = (): boolean => false;
    const t = new GlueStore();
    s.moveTo(t, all, transform(rotY, 0, 0, 0), none); // (1,0,0) -> (0,0,-1)
    const got: string[] = [];
    t.forEach((x, y, z, axis: Axis) => got.push(`${x},${y},${z},${axis}`));
    expect(got).toEqual(['0,0,-1,2']);
    const u = new GlueStore();
    t.moveTo(u, all, transform(rotZ, 0, 0, 0), none); // z axis stays z
    expect(facesOf(u)).toEqual(['0,0,-1,2']);
    const v = new GlueStore();
    u.moveTo(v, all, transform(rotX, 0, 0, 0), none); // (0,0,-1)-(0,0,0) -> (0,1,0)-(0,0,0)
    expect(facesOf(v)).toEqual(['0,0,0,1']);
  });

  it('in place (target === this) and with a map that reuses its result object', () => {
    const cl = cluster();
    const { s, inSet, stays, inner } = cl;
    const out: P = { x: 0, y: 0, z: 0 };
    const reuse: Map3 = (x, y, z) => {
      const q = rotY({ x, y, z });
      out.x = q.x + 1;
      out.y = q.y;
      out.z = q.z;
      return out;
    };
    const fresh = transform(rotY, 1, 0, 0);
    expect(s.moveTo(s, inSet, reuse, stays)).toBe(inner.length + 1);
    expect(s.size).toBe(inner.length + 1 + 2); // + the untouched outside face and the staying face
    expect(hasFace(s, cl.outside)).toBe(true);
    expect(hasFace(s, cl.oneEndStays)).toBe(true);
    for (const f of [...inner, cl.oneEndMoves]) expect(hasFace(s, mapped(fresh, f))).toBe(true);
  });

  it('round trip through four quarter turns restores the moved faces', () => {
    const { s, inSet, stays, movedArray } = cluster();
    let cur = s;
    let set = inSet;
    let st = stays;
    for (let i = 0; i < 4; i++) {
      const next = new GlueStore();
      cur.moveTo(next, set, transform(rotY, 0, 0, 0), st);
      const prevSet = set;
      set = (x, y, z) => {
        const p = times(rotY, 3)({ x, y, z }); // inverse of rotY
        return prevSet(p.x, p.y, p.z);
      };
      st = () => false;
      cur = next;
    }
    // The first move left the staying face and the outside face behind.
    expect(cur.toArray()).toEqual(movedArray);
  });

  it('is atomic when the map breaks adjacency or leaves the range', () => {
    const { s, inSet, stays } = cluster();
    const before = s.toArray();
    const t = new GlueStore();
    expect(() => s.moveTo(t, inSet, (x, y, z) => ({ x: x * 2, y, z }), stays)).toThrow();
    expect(s.toArray()).toEqual(before);
    expect(t.size).toBe(0);
    expect(() => s.moveTo(t, inSet, (x, y, z) => ({ x: x + GLUE_MAX_XZ, y, z }), stays)).toThrow(RangeError);
    expect(s.toArray()).toEqual(before);
    expect(t.size).toBe(0);
  });

  it('an empty set moves nothing and deletes nothing', () => {
    const { s } = cluster();
    const n0 = s.size;
    expect(s.moveTo(new GlueStore(), () => false, (x, y, z) => ({ x, y, z }), () => false)).toBe(0);
    expect(s.size).toBe(n0);
  });
});

describe('GlueStore: version', () => {
  it('increases on every effective change and only then', () => {
    const s = new GlueStore();
    const v0 = s.version;
    s.has(0, 0, 0, PX);
    s.remove(0, 0, 0, PX);
    s.clear();
    expect(s.version).toBe(v0);
    s.add(0, 0, 0, PX);
    const v1 = s.version;
    expect(v1).toBeGreaterThan(v0);
    s.add(1, 0, 0, NX); // duplicate
    expect(s.version).toBe(v1);
    s.add(0, 0, 0, PY);
    expect(s.version).toBeGreaterThan(v1);
    const v2 = s.version;
    const t = new GlueStore();
    const tv = t.version;
    s.moveTo(t, () => true, (x, y, z) => ({ x: x + 1, y, z }), () => false);
    expect(s.version).toBeGreaterThan(v2);
    expect(t.version).toBeGreaterThan(tv);
    const v3 = t.version;
    t.clear();
    expect(t.version).toBeGreaterThan(v3);
    expect(t.size).toBe(0);
  });
});

describe('GlueStore: change events', () => {
  /** A store kept ONLY from `src`'s events. */
  function mirrorOf(src: GlueStore): { mirror: GlueStore; off: () => void } {
    const mirror = new GlueStore();
    const off = src.onChange((added, x, y, z, axis) => {
      const d = (axis * 2) as Dir;
      if (added) expect(mirror.add(x, y, z, d)).toBe(true);
      else expect(mirror.remove(x, y, z, d)).toBe(true);
    });
    return { mirror, off };
  }

  it('a mirror fed only by the events stays identical through a long random sequence (bulk operations included)', () => {
    const rng = new Rng(77);
    const s = new GlueStore();
    const other = new GlueStore();
    const { mirror } = mirrorOf(s);
    const c = (): number => rng.int(-12, 12);
    for (let i = 0; i < 6000; i++) {
      const op = rng.int(0, 9);
      if (op <= 3) {
        s.add(c(), c(), c(), rng.int(0, 5) as Dir);
      } else if (op <= 5) {
        s.remove(c(), c(), c(), rng.int(0, 5) as Dir);
      } else if (op === 6) {
        // In-place move of a random box, with a random rotation and offset (faces may merge).
        const x0 = c();
        const inSet = (x: number, y: number, z: number): boolean => x >= x0 && x < x0 + 6 && Math.abs(y) < 8 && Math.abs(z) < 8;
        const map = transform(times(rotY, rng.int(0, 3)), rng.int(-3, 3), rng.int(-3, 3), rng.int(-3, 3));
        const stayBit = rng.int(0, 1);
        s.moveTo(s, inSet, map, (x) => (x & 1) === stayBit);
      } else if (op === 7) {
        // Out to another store and (part of it) back in.
        const y0 = c();
        s.moveTo(other, (_x, y) => y >= y0, (x, y, z) => ({ x, y, z }), () => rng.chance(0.5));
        const x1 = c();
        other.moveTo(s, (x) => x < x1, (x, y, z) => ({ x: z, y, z: -x }), () => false);
      } else if (op === 8) {
        if (rng.chance(0.05)) s.clear();
      } else {
        for (let k = 0; k < 4; k++) other.add(c(), c(), c(), rng.int(0, 5) as Dir);
      }
      if (i % 500 === 0) expect(mirror.toArray()).toEqual(s.toArray());
    }
    expect(s.size).toBeGreaterThan(0);
    expect(mirror.toArray()).toEqual(s.toArray());
    expect(mirror.size).toBe(s.size);
  });

  it('reports each face once per change, with the canonical cell and axis; no-ops report nothing', () => {
    const s = new GlueStore();
    const log: string[] = [];
    s.onChange((added, x, y, z, axis) => log.push(`${added ? '+' : '-'}${x},${y},${z},${axis}`));
    s.add(1, 0, 0, NX); // canonical (0,0,0) axis 0
    s.add(0, 0, 0, PX); // duplicate
    s.remove(5, 5, 5, PY); // absent
    s.add(0, 0, 0, PY);
    s.remove(0, 1, 0, NY);
    s.add(3, 3, 3, PZ);
    s.clear();
    s.clear(); // empty
    expect(log).toEqual(['+0,0,0,0', '+0,0,0,1', '-0,0,0,1', '+3,3,3,2', '-0,0,0,0', '-3,3,3,2']);
  });

  it('unsubscribing during dispatch does not skip the next listener (copy-on-write); unsubscribe is idempotent', () => {
    const s = new GlueStore();
    const calls: string[] = [];
    let offA: () => void = () => undefined;
    offA = s.onChange(() => {
      calls.push('a');
      offA();
    });
    const offB = s.onChange(() => calls.push('b'));
    s.add(0, 0, 0, PX);
    s.add(0, 0, 0, PY);
    expect(calls).toEqual(['a', 'b', 'b']);
    offA();
    offB();
    offB();
    s.add(0, 0, 0, PZ);
    expect(calls).toEqual(['a', 'b', 'b']);
  });
});
