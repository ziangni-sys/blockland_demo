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
    expect(s.removeAllAt(1e12, 0, 0)).toBe(0);
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

describe('GlueStore: removeAllAt and dirMaskAt', () => {
  it('drops exactly the six faces touching a cell', () => {
    const s = new GlueStore();
    for (const d of ALL_DIRS) s.add(-3, 7, -1, d);
    // Unrelated faces: neighbours' other faces and a face two cells away.
    s.add(-2, 7, -1, PX);
    s.add(-4, 7, -1, PY);
    s.add(-3, 9, -1, NY);
    s.add(-3, 8, -1, PZ);
    expect(s.size).toBe(10);
    expect(s.dirMaskAt(-3, 7, -1)).toBe(0b111111);
    expect(s.removeAllAt(-3, 7, -1)).toBe(6);
    expect(s.size).toBe(4);
    expect(s.dirMaskAt(-3, 7, -1)).toBe(0);
    for (const d of ALL_DIRS) expect(s.has(-3, 7, -1, d)).toBe(false);
    expect(s.has(-2, 7, -1, PX)).toBe(true);
    expect(s.has(-4, 7, -1, PY)).toBe(true);
    expect(s.has(-3, 9, -1, NY)).toBe(true);
    expect(s.has(-3, 8, -1, PZ)).toBe(true);
    expect(s.removeAllAt(-3, 7, -1)).toBe(0);
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

  it('facesInBox returns every face with at least one end in the inclusive box', () => {
    const rng = new Rng(99);
    const s = new GlueStore();
    for (let i = 0; i < 3000; i++) s.add(rng.int(-40, 40), rng.int(-40, 40), rng.int(-40, 40), rng.int(0, 5) as Dir);
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

/** A small cluster with glued faces on all three axes, one face leaving the set, one outside. */
function cluster(): { s: GlueStore; inSet: (x: number, y: number, z: number) => boolean; inner: Array<[P, P]> } {
  const cells = new Set<string>();
  for (let x = -2; x <= 1; x++) for (let y = 3; y <= 4; y++) for (let z = -1; z <= 0; z++) cells.add(`${x},${y},${z}`);
  const inSet = (x: number, y: number, z: number): boolean => cells.has(`${x},${y},${z}`);
  const s = new GlueStore();
  const inner: Array<[P, P]> = [];
  const glue = (a: P, d: Dir): void => {
    s.add(a.x, a.y, a.z, d);
    inner.push([a, { x: a.x + DIR_X[d]!, y: a.y + DIR_Y[d]!, z: a.z + DIR_Z[d]! }]);
  };
  glue({ x: -2, y: 3, z: -1 }, PX);
  glue({ x: 1, y: 4, z: 0 }, NX);
  glue({ x: 0, y: 3, z: -1 }, PY);
  glue({ x: -1, y: 4, z: 0 }, NZ);
  glue({ x: 1, y: 3, z: -1 }, PZ);
  return { s, inSet, inner };
}

describe('GlueStore: moveTo', () => {
  it('translation: both-end faces move, one-end faces are deleted, others stay', () => {
    const { s, inSet, inner } = cluster();
    s.add(1, 3, 0, PX); // (2,3,0) is outside the set: deleted
    s.add(-2, 3, -1, NY); // (-2,2,-1) outside: deleted
    s.add(10, 10, 10, PY); // far outside: kept
    const t = new GlueStore();
    t.add(50, 50, 50, PZ); // pre-existing target glue is kept
    const n = s.moveTo(t, inSet, transform((p) => p, 100, -200, 300));
    expect(n).toBe(inner.length);
    expect(s.size).toBe(1);
    expect(s.has(10, 10, 10, PY)).toBe(true);
    expect(t.size).toBe(inner.length + 1);
    for (const [a, b] of inner) expect(t.has(a.x + 100, a.y - 200, a.z + 300, dirBetween(a, b))).toBe(true);
    expect(t.has(2 + 100, 3 - 200, 0 + 300, NX)).toBe(false);
  });

  for (const [name, rot] of [['X', rotX], ['Y', rotY], ['Z', rotZ]] as const) {
    for (const k of [1, 2, 3]) {
      it(`rotation by ${k * 90} degrees about ${name} re-keys from the mapped ends`, () => {
        const { s, inSet, inner } = cluster();
        const r = times(rot, k);
        const t = new GlueStore();
        const map = transform(r, -7, 5, -3);
        expect(s.moveTo(t, inSet, map)).toBe(inner.length);
        expect(s.size).toBe(0);
        expect(t.size).toBe(inner.length);
        for (const [a, b] of inner) {
          const ma = map(a.x, a.y, a.z);
          const mb = map(b.x, b.y, b.z);
          expect(t.has(ma.x, ma.y, ma.z, dirBetween(ma, mb))).toBe(true);
          expect(t.has(mb.x, mb.y, mb.z, dirBetween(mb, ma))).toBe(true);
        }
      });
    }
  }

  it('the face axis changes and the canonical end swaps (worked example)', () => {
    const s = new GlueStore();
    s.add(0, 0, 0, PX); // (0,0,0)-(1,0,0)
    const all = (): boolean => true;
    const t = new GlueStore();
    s.moveTo(t, all, transform(rotY, 0, 0, 0)); // (1,0,0) -> (0,0,-1)
    const got: string[] = [];
    t.forEach((x, y, z, axis: Axis) => got.push(`${x},${y},${z},${axis}`));
    expect(got).toEqual(['0,0,-1,2']);
    const u = new GlueStore();
    t.moveTo(u, all, transform(rotZ, 0, 0, 0)); // z axis stays z
    expect(facesOf(u)).toEqual(['0,0,-1,2']);
    const v = new GlueStore();
    u.moveTo(v, all, transform(rotX, 0, 0, 0)); // (0,0,-1)-(0,0,0) -> (0,1,0)-(0,0,0)
    expect(facesOf(v)).toEqual(['0,0,0,1']);
  });

  it('in place (target === this) and with a map that reuses its result object', () => {
    const { s, inSet, inner } = cluster();
    const out: P = { x: 0, y: 0, z: 0 };
    const reuse: Map3 = (x, y, z) => {
      const q = rotY({ x, y, z });
      out.x = q.x + 1;
      out.y = q.y;
      out.z = q.z;
      return out;
    };
    const fresh = transform(rotY, 1, 0, 0);
    expect(s.moveTo(s, inSet, reuse)).toBe(inner.length);
    expect(s.size).toBe(inner.length);
    for (const [a, b] of inner) {
      const ma = fresh(a.x, a.y, a.z);
      const mb = fresh(b.x, b.y, b.z);
      expect(s.has(ma.x, ma.y, ma.z, dirBetween(ma, mb))).toBe(true);
    }
  });

  it('round trip through four quarter turns restores the store', () => {
    const { s, inSet } = cluster();
    const before = s.toArray();
    let cur = s;
    let set = inSet;
    for (let i = 0; i < 4; i++) {
      const next = new GlueStore();
      cur.moveTo(next, set, transform(rotY, 0, 0, 0));
      const prevSet = set;
      set = (x, y, z) => {
        const p = times(rotY, 3)({ x, y, z }); // inverse of rotY
        return prevSet(p.x, p.y, p.z);
      };
      cur = next;
    }
    expect(cur.toArray()).toEqual(before);
  });

  it('is atomic when the map breaks adjacency or leaves the range', () => {
    const { s, inSet } = cluster();
    const before = s.toArray();
    const t = new GlueStore();
    expect(() => s.moveTo(t, inSet, (x, y, z) => ({ x: x * 2, y, z }))).toThrow();
    expect(s.toArray()).toEqual(before);
    expect(t.size).toBe(0);
    expect(() => s.moveTo(t, inSet, (x, y, z) => ({ x: x + GLUE_MAX_XZ, y, z }))).toThrow(RangeError);
    expect(s.toArray()).toEqual(before);
    expect(t.size).toBe(0);
  });

  it('an empty set moves nothing and deletes nothing', () => {
    const { s } = cluster();
    const n0 = s.size;
    expect(s.moveTo(new GlueStore(), () => false, (x, y, z) => ({ x, y, z }))).toBe(0);
    expect(s.size).toBe(n0);
  });
});
