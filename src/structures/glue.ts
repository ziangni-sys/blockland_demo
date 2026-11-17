/**
 * Glue storage (docs/DESIGN.md "强力胶", docs/LESSONS.md "胶的存储").
 *
 * Glue lives on the FACE between two adjacent cells of ONE grid. The world owns one store in
 * world coordinates; every structure owns one in its local coordinates (which may be
 * negative). A face is stored once, under its canonical key: the end cell with the smaller
 * coordinate along the face axis, plus that axis. has/add/remove accept either end cell with
 * the direction towards the other end, so callers never canonicalise themselves.
 *
 * KEYS. A collision-free key for the required range needs 23 + 23 + 18 bits of coordinates
 * plus 2 bits of axis = 66 bits, more than a double holds exactly. So the store is two-level:
 * a Map keyed by the 16^3 bucket the canonical cell lies in (19 + 14 + 19 = 52 bits, exact as
 * a double), holding a Set of 14-bit in-bucket keys (4 + 4 + 4 bits of offset, 2 bits of
 * axis). Both levels are exact, so distinct faces never collide. The buckets double as the
 * spatial index facesInBox() needs to answer box queries without scanning the whole store.
 *
 * SUPPORTED RANGE (both end cells inside it is always enough):
 *   x, z in [GLUE_MIN_XZ, GLUE_MAX_XZ] = [-4,194,304, 4,194,303]
 *   y    in [GLUE_MIN_Y,  GLUE_MAX_Y ] = [-131,072, 131,071]
 * Integers only. add() throws a RangeError outside it; has()/remove() answer false.
 *
 * ORDER. forEach / facesInBox visit faces in an unspecified but deterministic order (the same
 * history of operations gives the same order). toArray() is canonical: two stores holding
 * the same faces serialise identically, whatever order the faces were added in.
 *
 * LIFETIME. The store does not know cells. The rule "a glued face stays while at least one
 * side is a glueable block" (DESIGN 强力胶) is applied by the grids' change hooks through
 * pruneGlueAt (stick.ts), on the world's faces around a chunk when it is added (pruneGlueInBox),
 * and by the structure moves (moveTo, then the destination's rules: assembly.ts, which also
 * removes every face a blockify or dock would turn into a joint no player made).
 *
 * EVENTS. onChange() reports every face that is added or removed, by any method (bulk ones
 * included: moveTo on both stores, clear, fromArray has no listeners yet), so a mirror kept
 * only from the events stays identical to the store.
 */
import type { Axis, Dir } from '../core/dirs';

export const GLUE_MIN_XZ = -4_194_304;
export const GLUE_MAX_XZ = 4_194_303;
export const GLUE_MIN_Y = -131_072;
export const GLUE_MAX_Y = 131_071;

/** A glued face: canonical (smaller) end cell plus the axis towards the other end. */
export interface GlueFace {
  x: number;
  y: number;
  z: number;
  axis: Axis;
}

const BUCKET_SHIFT = 4;
const LOCAL_MASK = 15;
const BXZ_BIAS = 1 << 18; // bucket x/z in [-2^18, 2^18)
const BXZ_SPAN = 1 << 19;
const BY_BIAS = 1 << 13; // bucket y in [-2^13, 2^13)
const BY_SPAN = 1 << 14;

function bucketKey(bx: number, by: number, bz: number): number {
  // < 2^52: exact in a double. Multiplication, not shifts: bit operators truncate to 32 bits.
  return ((bx + BXZ_BIAS) * BY_SPAN + (by + BY_BIAS)) * BXZ_SPAN + (bz + BXZ_BIAS);
}

/** In-bucket key: local offsets (two's complement & 15 is the floor-mod for negatives too). */
function localKey(x: number, y: number, z: number, axis: number): number {
  return (x & LOCAL_MASK) | ((y & LOCAL_MASK) << 4) | ((z & LOCAL_MASK) << 8) | (axis << 12);
}

function inRange(x: number, y: number, z: number): boolean {
  return (
    (x | 0) === x &&
    (y | 0) === y &&
    (z | 0) === z &&
    x >= GLUE_MIN_XZ &&
    x <= GLUE_MAX_XZ &&
    z >= GLUE_MIN_XZ &&
    z <= GLUE_MAX_XZ &&
    y >= GLUE_MIN_Y &&
    y <= GLUE_MAX_Y
  );
}

/** v clamped to [lo, hi]. Callers reject NaN first. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Change listener: `added` true when the face (canonical cell + axis) was glued, false when its
 * glue was removed. Called synchronously after the store changed; it must not modify the store.
 */
export type GlueListener = (added: boolean, x: number, y: number, z: number, axis: Axis) => void;

interface Bucket {
  /** World-space origin of the bucket (bucket coordinate * 16). */
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly faces: Set<number>;
}

export class GlueStore {
  private readonly buckets = new Map<number, Bucket>();
  private count = 0;
  private rev = 0;
  /** Copy-on-write (LESSONS: unsubscribing during dispatch must not skip the next listener). */
  private listeners: readonly GlueListener[] = [];

  /** Number of glued faces. */
  get size(): number {
    return this.count;
  }

  /**
   * Increases whenever a face is added or removed (by any method, moveTo included, on both
   * stores). Caches keyed on glue — an assembly preview that must be redone when anything
   * changed, drawn glue faces — compare it instead of diffing the faces.
   */
  get version(): number {
    return this.rev;
  }

  // ------------------------------------------------------------ events

  /** Subscribe to face changes (see GlueListener). Returns the unsubscribe function. */
  onChange(listener: GlueListener): () => void {
    this.listeners = this.listeners.concat(listener);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners = this.listeners.slice(0, i).concat(this.listeners.slice(i + 1));
    };
  }

  private emit(added: boolean, x: number, y: number, z: number, axis: number): void {
    const ls = this.listeners;
    for (let i = 0; i < ls.length; i++) ls[i]!(added, x, y, z, axis as Axis);
  }

  // ------------------------------------------------------------ single faces

  /** Is the face between (x,y,z) and its neighbour in `dir` glued? */
  has(x: number, y: number, z: number, dir: Dir): boolean {
    const axis = dir >> 1;
    if ((dir & 1) !== 0) {
      // Negative direction: the neighbour is the canonical (smaller) end.
      if (axis === 0) x--;
      else if (axis === 1) y--;
      else z--;
    }
    return this.hasCanonical(x, y, z, axis);
  }

  /** Glue the face between (x,y,z) and its neighbour in `dir`. False when already glued. */
  add(x: number, y: number, z: number, dir: Dir): boolean {
    if ((dir | 0) !== dir || dir < 0 || dir > 5) throw new RangeError(`GlueStore.add: bad direction ${dir}`);
    const axis = dir >> 1;
    if ((dir & 1) !== 0) {
      if (axis === 0) x--;
      else if (axis === 1) y--;
      else z--;
    }
    if (!inRange(x, y, z)) throw new RangeError(`GlueStore.add: face at (${x},${y},${z}) axis ${axis} is out of range`);
    return this.addCanonical(x, y, z, axis);
  }

  /** Remove the glue between (x,y,z) and its neighbour in `dir`. False when it was not glued. */
  remove(x: number, y: number, z: number, dir: Dir): boolean {
    const axis = dir >> 1;
    if ((dir & 1) !== 0) {
      if (axis === 0) x--;
      else if (axis === 1) y--;
      else z--;
    }
    return this.removeCanonical(x, y, z, axis);
  }

  /** Bit mask of the glued faces of one cell: bit `d` set when the face towards Dir d is glued. */
  dirMaskAt(x: number, y: number, z: number): number {
    let m = 0;
    if (this.hasCanonical(x, y, z, 0)) m |= 1;
    if (this.hasCanonical(x - 1, y, z, 0)) m |= 2;
    if (this.hasCanonical(x, y, z, 1)) m |= 4;
    if (this.hasCanonical(x, y - 1, z, 1)) m |= 8;
    if (this.hasCanonical(x, y, z, 2)) m |= 16;
    if (this.hasCanonical(x, y, z - 1, 2)) m |= 32;
    return m;
  }

  // ------------------------------------------------------------ iteration

  /** Visit every glued face as canonical cell + axis. Do not modify the store while iterating. */
  forEach(fn: (x: number, y: number, z: number, axis: Axis) => void): void {
    for (const b of this.buckets.values()) {
      const { x0, y0, z0 } = b;
      for (const k of b.faces) {
        fn(x0 + (k & LOCAL_MASK), y0 + ((k >> 4) & LOCAL_MASK), z0 + ((k >> 8) & LOCAL_MASK), (k >> 12) as Axis);
      }
    }
  }

  /**
   * Visit every glued face with at least one end cell inside the box [min, max] (cell
   * coordinates, BOTH bounds inclusive; fractional bounds are floored, so a float AABB selects
   * every cell it overlaps; +-Infinity is allowed, a NaN bound selects nothing). Each face is
   * visited once, as canonical cell + axis. Only the buckets overlapping the box are examined
   * (or, when the box spans more buckets than the store holds, only the stored buckets), so a
   * small query on a large store stays cheap. Do not modify the store from `fn`.
   */
  forEachInBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    fn: (x: number, y: number, z: number, axis: Axis) => void,
  ): void {
    if (this.count === 0) return;
    if (minX !== minX || minY !== minY || minZ !== minZ || maxX !== maxX || maxY !== maxY || maxZ !== maxZ) return; // NaN
    const fx0 = Math.floor(minX);
    const fy0 = Math.floor(minY);
    const fz0 = Math.floor(minZ);
    const fx1 = Math.floor(maxX);
    const fy1 = Math.floor(maxY);
    const fz1 = Math.floor(maxZ);
    // Every end cell of a storable face lies in [MIN, MAX + 1] on each axis (the canonical
    // cell is in [MIN, MAX], the far end one beyond). A box missing that span on any axis
    // selects nothing. This test must come BEFORE the clamp below: clamping a box that lies
    // wholly beyond MAX + 1 would squash it onto the plane MAX + 1, where faces keyed on MAX
    // have their far end, and report them although neither end is in the requested box.
    if (
      fx0 > GLUE_MAX_XZ + 1 ||
      fx1 < GLUE_MIN_XZ ||
      fy0 > GLUE_MAX_Y + 1 ||
      fy1 < GLUE_MIN_Y ||
      fz0 > GLUE_MAX_XZ + 1 ||
      fz1 < GLUE_MIN_XZ
    ) {
      return;
    }
    // The box now overlaps [MIN, MAX + 1] on every axis, so clamping it to [MIN - 1, MAX + 1]
    // changes neither which end cells it contains nor its emptiness; it keeps every shift
    // below in int32 and turns +-Infinity into finite bounds.
    const x0 = clamp(fx0, GLUE_MIN_XZ - 1, GLUE_MAX_XZ + 1);
    const y0 = clamp(fy0, GLUE_MIN_Y - 1, GLUE_MAX_Y + 1);
    const z0 = clamp(fz0, GLUE_MIN_XZ - 1, GLUE_MAX_XZ + 1);
    const x1 = clamp(fx1, GLUE_MIN_XZ - 1, GLUE_MAX_XZ + 1);
    const y1 = clamp(fy1, GLUE_MIN_Y - 1, GLUE_MAX_Y + 1);
    const z1 = clamp(fz1, GLUE_MIN_XZ - 1, GLUE_MAX_XZ + 1);
    if (x0 > x1 || y0 > y1 || z0 > z1) return;

    // A face keyed on c joins c and c + e_axis, so its canonical cell lies in [min - 1, max].
    // Bucket ranges are clamped to valid bucket coordinates: an out-of-range coordinate would
    // otherwise produce a key that aliases some unrelated bucket.
    const bx0 = Math.max((x0 - 1) >> BUCKET_SHIFT, -BXZ_BIAS);
    const by0 = Math.max((y0 - 1) >> BUCKET_SHIFT, -BY_BIAS);
    const bz0 = Math.max((z0 - 1) >> BUCKET_SHIFT, -BXZ_BIAS);
    const bx1 = Math.min(x1 >> BUCKET_SHIFT, BXZ_BIAS - 1);
    const by1 = Math.min(y1 >> BUCKET_SHIFT, BY_BIAS - 1);
    const bz1 = Math.min(z1 >> BUCKET_SHIFT, BXZ_BIAS - 1);
    if (bx0 > bx1 || by0 > by1 || bz0 > bz1) return;

    const visit = (b: Bucket): void => {
      const { x0: ox, y0: oy, z0: oz } = b;
      for (const k of b.faces) {
        const x = ox + (k & LOCAL_MASK);
        const y = oy + ((k >> 4) & LOCAL_MASK);
        const z = oz + ((k >> 8) & LOCAL_MASK);
        const axis = k >> 12;
        const inA = x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
        if (!inA) {
          const ex = axis === 0 ? x + 1 : x;
          const ey = axis === 1 ? y + 1 : y;
          const ez = axis === 2 ? z + 1 : z;
          if (ex < x0 || ex > x1 || ey < y0 || ey > y1 || ez < z0 || ez > z1) continue;
        }
        fn(x, y, z, axis as Axis);
      }
    };

    const span = (bx1 - bx0 + 1) * (by1 - by0 + 1) * (bz1 - bz0 + 1);
    if (span <= this.buckets.size) {
      for (let by = by0; by <= by1; by++) {
        for (let bz = bz0; bz <= bz1; bz++) {
          for (let bx = bx0; bx <= bx1; bx++) {
            const b = this.buckets.get(bucketKey(bx, by, bz));
            if (b) visit(b);
          }
        }
      }
    } else {
      for (const b of this.buckets.values()) {
        const bx = b.x0 >> BUCKET_SHIFT;
        const by = b.y0 >> BUCKET_SHIFT;
        const bz = b.z0 >> BUCKET_SHIFT;
        if (bx < bx0 || bx > bx1 || by < by0 || by > by1 || bz < bz0 || bz > bz1) continue;
        visit(b);
      }
    }
  }

  /** Array form of forEachInBox (for drawing nearby glue). Same box semantics. */
  facesInBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): GlueFace[] {
    const out: GlueFace[] = [];
    this.forEachInBox(minX, minY, minZ, maxX, maxY, maxZ, (x, y, z, axis) => {
      out.push({ x, y, z, axis });
    });
    return out;
  }

  // ------------------------------------------------------------ persistence

  /** x, y, z, axis quadruples of every face, in canonical order (for saves). */
  toArray(): Int32Array {
    const out = new Int32Array(this.count * 4);
    const keys = Float64Array.from(this.buckets.keys()).sort();
    let o = 0;
    for (let i = 0; i < keys.length; i++) {
      const b = this.buckets.get(keys[i]!)!;
      const local = Uint16Array.from(b.faces).sort();
      for (let j = 0; j < local.length; j++) {
        const k = local[j]!;
        out[o++] = b.x0 + (k & LOCAL_MASK);
        out[o++] = b.y0 + ((k >> 4) & LOCAL_MASK);
        out[o++] = b.z0 + ((k >> 8) & LOCAL_MASK);
        out[o++] = k >> 12;
      }
    }
    return out;
  }

  /** Inverse of toArray(). Throws a RangeError on malformed data (length, axis, range). */
  static fromArray(a: ArrayLike<number>): GlueStore {
    if (a.length % 4 !== 0) throw new RangeError(`GlueStore.fromArray: length ${a.length} is not a multiple of 4`);
    const s = new GlueStore();
    for (let i = 0; i < a.length; i += 4) {
      const x = a[i]!;
      const y = a[i + 1]!;
      const z = a[i + 2]!;
      const axis = a[i + 3]!;
      if ((axis !== 0 && axis !== 1 && axis !== 2) || !inRange(x, y, z)) {
        throw new RangeError(`GlueStore.fromArray: bad face (${x},${y},${z}) axis ${axis} at index ${i}`);
      }
      s.addCanonical(x, y, z, axis);
    }
    return s;
  }

  /** Remove every face (each one is reported to the listeners). */
  clear(): void {
    if (this.count === 0) return;
    if (this.listeners.length > 0) {
      const all = this.toArray();
      this.buckets.clear();
      this.count = 0;
      this.rev++;
      for (let i = 0; i < all.length; i += 4) this.emit(false, all[i]!, all[i + 1]!, all[i + 2]!, all[i + 3]!);
      return;
    }
    this.buckets.clear();
    this.count = 0;
    this.rev++;
  }

  // ------------------------------------------------------------ structure moves

  /**
   * Move glue along with cells that change grid (assembly, blockify, docking, rotor start / stop).
   *
   * A glued face with BOTH end cells in `inSet` leaves this store and is added to `target`,
   * keyed again from the two MAPPED end cells: `map` may translate and rotate by multiples of
   * 90 degrees, so the face axis can change and the canonical end can swap (LESSONS: 移动或旋转时，
   * 要按映射后的两个端点重新计算键). A face with exactly ONE end in the set stays here when
   * `stays(other end)` is true (the end left behind is a glueable block that remains in this
   * grid: the glue keeps holding on to it and is not duplicated), and otherwise moves like the
   * others (DESIGN 强力胶: glue lives on while one side is glueable). Faces with no end in the
   * set are untouched. A moved face landing on a face `target` already holds merges with it.
   *
   * `map` may return the same object on every call. `target` may be this store (in-place
   * remap). The operation is atomic: if `map` breaks adjacency or leaves the key range, an
   * Error is thrown before anything is modified. Returns the number of faces moved.
   *
   * ORDER RELATIVE TO THE CELL WRITES. The grids' change hooks apply the lifetime rule on every
   * write, bulk moves included, so a mover writes the destination cells, THEN calls moveTo,
   * THEN clears the source cells (clearing first would leave faces between two moved cells with
   * no glueable side, and the hook would delete them), and finally applies the destination's
   * glue rules to the destination cells (assembly.ts), since faces arrive there after the cells did.
   * `inSet` and `stays` read the source grid while its cells are still there.
   */
  moveTo(
    target: GlueStore,
    inSet: (x: number, y: number, z: number) => boolean,
    map: (x: number, y: number, z: number) => { x: number; y: number; z: number },
    stays: (x: number, y: number, z: number) => boolean,
  ): number {
    const drop: number[] = []; // canonical faces leaving this store: x, y, z, axis
    const put: number[] = []; // canonical mapped faces for the target
    this.forEach((x, y, z, axis) => {
      const x1 = axis === 0 ? x + 1 : x;
      const y1 = axis === 1 ? y + 1 : y;
      const z1 = axis === 2 ? z + 1 : z;
      const inA = inSet(x, y, z);
      const inB = inSet(x1, y1, z1);
      if (!inA && !inB) return;
      if (!inA && stays(x, y, z)) return;
      if (!inB && stays(x1, y1, z1)) return;
      drop.push(x, y, z, axis);
      const pa = map(x, y, z);
      const ax = pa.x; // copy before the second call: map may reuse its result object
      const ay = pa.y;
      const az = pa.z;
      const pb = map(x1, y1, z1);
      const dx = pb.x - ax;
      const dy = pb.y - ay;
      const dz = pb.z - az;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) !== 1) {
        throw new Error(`GlueStore.moveTo: map does not keep (${x},${y},${z}) and its +${'xyz'[axis]} neighbour adjacent`);
      }
      const naxis = dx !== 0 ? 0 : dy !== 0 ? 1 : 2;
      const positive = dx + dy + dz > 0;
      const cx = positive ? ax : pb.x;
      const cy = positive ? ay : pb.y;
      const cz = positive ? az : pb.z;
      if (!inRange(cx, cy, cz)) {
        throw new RangeError(`GlueStore.moveTo: mapped face (${cx},${cy},${cz}) is out of range`);
      }
      put.push(cx, cy, cz, naxis);
    });
    // Drop first, then add: correct even when target === this and a moved face lands on a
    // position another moved face just vacated.
    for (let i = 0; i < drop.length; i += 4) this.removeCanonical(drop[i]!, drop[i + 1]!, drop[i + 2]!, drop[i + 3]!);
    for (let i = 0; i < put.length; i += 4) target.addCanonical(put[i]!, put[i + 1]!, put[i + 2]!, put[i + 3]!);
    return put.length / 4;
  }

  // ------------------------------------------------------------ canonical-key primitives

  private hasCanonical(x: number, y: number, z: number, axis: number): boolean {
    // Most stores (structures, fresh worlds) are empty or tiny: skip the key work entirely.
    if (this.count === 0 || !inRange(x, y, z)) return false;
    const b = this.buckets.get(bucketKey(x >> BUCKET_SHIFT, y >> BUCKET_SHIFT, z >> BUCKET_SHIFT));
    return b !== undefined && b.faces.has(localKey(x, y, z, axis));
  }

  /** Caller guarantees inRange(x, y, z) and axis in 0..2. */
  private addCanonical(x: number, y: number, z: number, axis: number): boolean {
    const bx = x >> BUCKET_SHIFT;
    const by = y >> BUCKET_SHIFT;
    const bz = z >> BUCKET_SHIFT;
    const key = bucketKey(bx, by, bz);
    let b = this.buckets.get(key);
    if (!b) {
      b = { x0: bx << BUCKET_SHIFT, y0: by << BUCKET_SHIFT, z0: bz << BUCKET_SHIFT, faces: new Set<number>() };
      this.buckets.set(key, b);
    }
    const lk = localKey(x, y, z, axis);
    if (b.faces.has(lk)) return false;
    b.faces.add(lk);
    this.count++;
    this.rev++;
    if (this.listeners.length > 0) this.emit(true, x, y, z, axis);
    return true;
  }

  private removeCanonical(x: number, y: number, z: number, axis: number): boolean {
    if (this.count === 0 || !inRange(x, y, z)) return false;
    const key = bucketKey(x >> BUCKET_SHIFT, y >> BUCKET_SHIFT, z >> BUCKET_SHIFT);
    const b = this.buckets.get(key);
    if (!b || !b.faces.delete(localKey(x, y, z, axis))) return false;
    this.count--;
    this.rev++;
    // Empty buckets are dropped so iteration and box queries only see live data.
    if (b.faces.size === 0) this.buckets.delete(key);
    if (this.listeners.length > 0) this.emit(false, x, y, z, axis);
    return true;
  }
}
