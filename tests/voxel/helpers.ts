/** Shared fixtures and independent reference implementations for the voxel tests. */
import { qfromAxisAngle, quat, vcopy, vec3, type AABB, type Quat, type Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { isSolidCell } from '../../src/blocks/registry';
import { Chunk } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';

export const STONE = makeCell(B.STONE);
export const PLANKS = makeCell(B.PLANKS_OAK);

/** A world with empty (all-air) chunks loaded for chunk coords c0..c1 on both axes. */
export function emptyWorld(c0 = -2, c1 = 1): World {
  const w = new World(1234);
  for (let cx = c0; cx <= c1; cx++) for (let cz = c0; cz <= c1; cz++) w.addChunk(new Chunk(cx, cz));
  w.takeDirtySections();
  return w;
}

/** Fill the half-open cell box [x0,x1) x [y0,y1) x [z0,z1). */
export function fill(
  g: VoxelGrid,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  cell: number = STONE,
): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) g.setCell(x, y, z, cell);
}

/** Uniformly distributed random unit quaternion (Shoemake). */
export function randomQuat(rng: Rng): Quat {
  const u1 = rng.next();
  const u2 = rng.next() * Math.PI * 2;
  const u3 = rng.next() * Math.PI * 2;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return quat(a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3));
}

export function axisAngle(x: number, y: number, z: number, angle: number): Quat {
  const l = Math.hypot(x, y, z);
  return qfromAxisAngle(vec3(x / l, y / l, z / l), angle);
}

/** A top-level structure (parent = world) with the given pose. */
export function structure(world: VoxelGrid, id: number, position: Vec3, rotation: Quat, pivot?: Vec3): StructureGrid {
  const s = new StructureGrid(id, world);
  if (pivot) vcopy(s.pivot, pivot);
  s.setPoseImmediate(position, rotation);
  return s;
}

export function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AABB {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** World AABB of half extents (hx,hy,hz) centred at c. */
export function boxAround(c: Vec3, hx: number, hy: number, hz: number): AABB {
  return box(c.x - hx, c.y - hy, c.z - hz, c.x + hx, c.y + hy, c.z + hz);
}

// ------------------------------------------------------------------ reference: OBB vs cell

/**
 * Exact overlap margin of a WORLD AABB and the unit cell (x,y,z) of `grid`, computed
 * independently of shape.ts as a linear program solved by vertex enumeration:
 *
 *   maximise t  subject to  n_k . p + t <= b_k  for the 12 face planes of both boxes
 *
 * (unit normals, expressed in the grid's local space). t* > 0 means the boxes overlap with
 * every face at least t* away from a common point; t* < 0 means they are disjoint; 0 touch.
 */
export function overlapMargin(grid: VoxelGrid, worldBox: AABB, x: number, y: number, z: number): number {
  return overlapMarginBox(grid, worldBox, x, y, z, x + 1, y + 1, z + 1);
}

/**
 * overlapMargin for any axis-aligned box of the grid's LOCAL space, [x0,x1] x [y0,y1] x [z0,z1]
 * (an octant, a half slab, a cell): the same linear program with that box's six planes.
 */
export function overlapMarginBox(grid: VoxelGrid, worldBox: AABB, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const n: number[][] = [];
  const b: number[] = [];
  // local box planes
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let j = 0; j < 3; j++) {
    const e = [0, 0, 0];
    e[j] = 1;
    n.push(e);
    b.push(hi[j]!);
    n.push([-e[0]!, -e[1]!, -e[2]!]);
    b.push(-lo[j]!);
  }
  // box planes: world axes in local space, centre in local space
  const centre = grid.toLocal(
    vec3((worldBox.minX + worldBox.maxX) / 2, (worldBox.minY + worldBox.maxY) / 2, (worldBox.minZ + worldBox.maxZ) / 2),
  );
  const h = [
    (worldBox.maxX - worldBox.minX) / 2,
    (worldBox.maxY - worldBox.minY) / 2,
    (worldBox.maxZ - worldBox.minZ) / 2,
  ];
  for (let i = 0; i < 3; i++) {
    const w = vec3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
    const a = grid.dirToLocal(w);
    const ac = a.x * centre.x + a.y * centre.y + a.z * centre.z;
    n.push([a.x, a.y, a.z]);
    b.push(h[i]! + ac);
    n.push([-a.x, -a.y, -a.z]);
    b.push(h[i]! - ac);
  }
  let best = -Infinity;
  const m = n.length;
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i0 = 0; i0 < m; i0++)
    for (let i1 = i0 + 1; i1 < m; i1++)
      for (let i2 = i1 + 1; i2 < m; i2++)
        for (let i3 = i2 + 1; i3 < m; i3++) {
          const rows = [i0, i1, i2, i3];
          for (let r = 0; r < 4; r++) {
            const k = rows[r]!;
            M[r * 5] = n[k]![0]!;
            M[r * 5 + 1] = n[k]![1]!;
            M[r * 5 + 2] = n[k]![2]!;
            M[r * 5 + 3] = 1;
            M[r * 5 + 4] = b[k]!;
          }
          const sol = solve4(M);
          if (sol === null) continue;
          const [px, py, pz, t] = sol;
          let ok = true;
          for (let k = 0; k < m; k++) {
            if (n[k]![0]! * px + n[k]![1]! * py + n[k]![2]! * pz + t > b[k]! + 1e-9) {
              ok = false;
              break;
            }
          }
          if (ok && t > best) best = t;
        }
  return best;
}

/** Gaussian elimination with partial pivoting on a 4x5 augmented matrix (destroys M). */
function solve4(M: number[]): [number, number, number, number] | null {
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(M[r * 5 + col]!) > Math.abs(M[piv * 5 + col]!)) piv = r;
    if (Math.abs(M[piv * 5 + col]!) < 1e-10) return null;
    if (piv !== col) {
      for (let k = 0; k < 5; k++) {
        const t = M[col * 5 + k]!;
        M[col * 5 + k] = M[piv * 5 + k]!;
        M[piv * 5 + k] = t;
      }
    }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = M[r * 5 + col]! / M[col * 5 + col]!;
      if (f === 0) continue;
      for (let k = col; k < 5; k++) M[r * 5 + k] = M[r * 5 + k]! - f * M[col * 5 + k]!;
    }
  }
  return [M[4]! / M[0]!, M[9]! / M[6]!, M[14]! / M[12]!, M[19]! / M[18]!];
}

// ------------------------------------------------------------------ reference: ray vs cells

export interface RefHit {
  x: number;
  y: number;
  z: number;
  t: number;
}

/**
 * Brute-force ray cast: intersect the local ray with every listed cell's unit cube (slab
 * method) and keep the earliest entry. Independent of raycast.ts's DDA, but with the same
 * documented convention: a cell is on the ray only if the ray runs a POSITIVE length through
 * it (touching an edge or a corner is not a hit), cells are half-open along axes the ray does
 * not move on, and a cell entered at exactly maxDist counts.
 */
export function referenceRay(
  grid: VoxelGrid,
  cells: ReadonlyArray<readonly [number, number, number]>,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): RefHit | null {
  const o = grid.toLocal(origin);
  const d = grid.dirToLocal(dir);
  let best: RefHit | null = null;
  for (const [x, y, z] of cells) {
    let t0 = 0;
    let t1 = Infinity;
    let ok = true;
    const lo = [x, y, z];
    const oo = [o.x, o.y, o.z];
    const dd = [d.x, d.y, d.z];
    for (let a = 0; a < 3 && ok; a++) {
      if (Math.abs(dd[a]!) < 1e-14) {
        if (oo[a]! < lo[a]! || oo[a]! >= lo[a]! + 1) ok = false;
        continue;
      }
      let tn = (lo[a]! - oo[a]!) / dd[a]!;
      let tf = (lo[a]! + 1 - oo[a]!) / dd[a]!;
      if (tn > tf) [tn, tf] = [tf, tn];
      if (tn > t0) t0 = tn;
      if (tf < t1) t1 = tf;
    }
    if (ok && t0 < t1 && t0 <= maxDist && (best === null || t0 < best.t)) best = { x, y, z, t: t0 };
  }
  return best;
}

/** All solid cells of a structure as a list (for the reference ray). */
export function solidCells(g: StructureGrid): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  g.forEachCell((x, y, z, c) => {
    if (isSolidCell(c)) out.push([x, y, z]);
  });
  return out;
}

export function unit(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z);
  return vec3(x / l, y / l, z / l);
}
