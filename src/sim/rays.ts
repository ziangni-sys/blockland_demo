/**
 * The player's three rays (docs/NETCODE.md section 10), as pure functions over grids: the server
 * (sim/interact.ts, for server-driven players; net/server/intents.ts, the cell predicates of its
 * checks) and the client (net/client/intents.ts, on its replica) use this one copy.
 *
 * WHICH RAY. The use ray (outline, right-click, glue) follows the held item (rayKindOf); the mining
 * ray is always the plain ray.
 *  - plain: the nearest targetable cell of any grid (voxel/raycast.ts `targetable`: every non-air,
 *    non-liquid cell, soft blocks included);
 *  - glue (glue in the main hand): passes through soft blocks (torches, plants, snow cover), which
 *    can carry no glue, and stops at the first octant of a HARD targetable part, so every glued
 *    face shown as exposed (DESIGN 强力胶: 露出的胶面) can be clicked from its open side, including
 *    a face seen through the empty octants of a partial cell in front of it;
 *  - bucket (a bucket in the main hand): stops at liquid SOURCES too, except world liquid displaced
 *    by a ship's hull (inside one of its HARD octants or its dry hold; LESSONS 船舱里冒出水面: that
 *    water is never deleted, only hidden) — DESIGN 结构体里没有液体: a bucket never reaches world
 *    water inside or behind a structure. Structures hold no liquid: for them it is the plain ray.
 *    Where a structure block and world liquid start at the same distance, the structure wins;
 *    world blocks keep the tie rule of raycastGrids (the world first).
 *
 * All three hit OCTANTS (voxel/raycast.ts, docs/SHAPES.md 6.1): they pass through the empty octants
 * of partial cells, and their predicates are applied to the part an octant belongs to.
 *
 * Every function here only reads the grids it is given; scratch vectors are allocated per call
 * (ARCHITECTURE rule 5: no shared temporaries).
 */
import { ID_MASK } from '../blocks/cell';
import { I } from '../blocks/items';
import { LIQUID, SOLID } from '../blocks/registry';
import { NX, NY, NZ, PX, PY, PZ, type Dir } from '../core/dirs';
import { vec3, type Vec3 } from '../core/math';
import { isDryHalf, type HullInfo } from '../structures/hull';
import type { VoxelGrid } from '../voxel/grid';
import { solidAtHalf } from '../voxel/parts';
import { raycastGrid, raycastGrids, targetable, targetableOrLiquidSource, type CellPredicate, type GridHit } from '../voxel/raycast';

/** Reach of the player's hands, in blocks from the eye. */
export const REACH = 5;

/** Which ray: see the file comment. */
export type RayKind = 'plain' | 'glue' | 'bucket';

/**
 * Spacing (blocks) of the points at which the bucket ray tests whether the world liquid it
 * crosses is displaced by a hull. What displaces water is decided per octant (half a block
 * wide), so a sliver of visible water thinner than this is the most that can be missed.
 */
const HULL_SAMPLE = 1 / 16;
/** Hidden liquid cells the bucket ray may skip; a REACH-long ray crosses far fewer cells. */
const MAX_HIDDEN_SKIPS = 32;
/** The bucket ray resumes this far past the exit of a hidden liquid cell. */
const SKIP_EPS = 1e-7;

/** A ship as the bucket ray needs it: its grid and its hull analysis (dry cells), null when unknown. */
export interface RayShip {
  readonly grid: VoxelGrid;
  readonly hull: HullInfo | null;
}

/** What the rays look at: every grid (the world among them, isWorld), and the ships with their hulls. */
export interface RayScene {
  readonly grids: readonly VoxelGrid[];
  readonly ships: readonly RayShip[];
}

/** Is `item` (-1 = empty hand) a bucket, empty or full? */
export function isBucket(item: number): boolean {
  return item === I.BUCKET || item === I.BUCKET_WATER || item === I.BUCKET_LAVA;
}

/** The use ray of the held item (-1 = empty hand). */
export function rayKindOf(item: number): RayKind {
  return isBucket(item) ? 'bucket' : item === I.GLUE ? 'glue' : 'plain';
}

/** The glue ray's parts: targetable and HARD (soft blocks carry no glue and are passed through). */
export const glueTargetable: CellPredicate = (part) => targetable(part) && SOLID[part & ID_MASK] === 1;

/** The parts ray `kind` stops at (the bucket ray's hull rule aside: see displacedByHull). */
export function rayPredicate(kind: RayKind): CellPredicate {
  return kind === 'bucket' ? targetableOrLiquidSource : kind === 'glue' ? glueTargetable : targetable;
}

/** The look direction of yaw / pitch (ARCHITECTURE 朝向), unit length. */
export function lookDir(yaw: number, pitch: number, out: Vec3 = vec3()): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/**
 * The nearest octant ray `kind` stops at, from `origin` along the unit vector `dir`, within
 * `reach` (default REACH), or null.
 */
export function castRay(scene: RayScene, origin: Vec3, dir: Vec3, kind: RayKind, reach: number = REACH): GridHit | null {
  if (kind === 'bucket') return bucketRay(scene, origin, dir, reach);
  return raycastGrids(scene.grids, origin, dir, reach, kind === 'glue' ? glueTargetable : targetable);
}

/**
 * Is the world point inside a HARD octant or a dry octant of a ship (where the hull keeps world
 * liquid out)? Decided by the octant the point is in (docs/SHAPES.md 4.4: the point's local
 * coordinates times 2, floored, are its half-grid coordinates), so the empty half above a slab
 * of the hull is not displaced. The same rule as for bodies (entities/fluids) and blast rays
 * (explosion).
 */
export function displacedByHull(ships: readonly RayShip[], p: Vec3): boolean {
  const l = vec3();
  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i]!;
    const g = ship.grid;
    const b = g.cellBounds();
    if (b === null) continue;
    g.toLocal(p, l);
    const hx = Math.floor(l.x * 2);
    const hy = Math.floor(l.y * 2);
    const hz = Math.floor(l.z * 2);
    const x = hx >> 1;
    const y = hy >> 1;
    const z = hz >> 1;
    // Dry cells lie inside the hull's box, so nothing outside it is displaced.
    if (x < b.minX || y < b.minY || z < b.minZ || x >= b.maxX || y >= b.maxY || z >= b.maxZ) continue;
    if (solidAtHalf(g, hx, hy, hz)) return true;
    const hull = ship.hull;
    if (hull !== null && isDryHalf(hull, hx, hy, hz)) return true;
  }
  return false;
}

/** Inset of the sample points of cellDisplaced from the cell's corners. */
const CELL_SAMPLE_INSET = 0.1;

/**
 * Is ALL of world cell (x, y, z) displaced by hulls (its centre and its eight corners, inset by
 * CELL_SAMPLE_INSET)? The bucket ray may stop at a liquid cell a hull covers only in part; this is
 * true only when no part a ray could stop at is left. displacedByHull decides by octant; when a
 * hull's grid is aligned with the world's, the eight inset corners lie in eight different octants,
 * so the answer is exact. For an offset or rotated hull the nine points can miss a strip of the
 * cell that is not displaced (thinner than the inset for hulls of full blocks, up to about a
 * quarter of the cell next to partial hull cells); the server's check of a claimed bucket target
 * (net/server/intents.ts) then refuses water the client's bucket ray reached. That is accepted:
 * it needs a ray through that strip, and the refusal is a no-op, not a wrong result.
 */
export function cellDisplaced(ships: readonly RayShip[], x: number, y: number, z: number): boolean {
  if (ships.length === 0) return false;
  const p = vec3(x + 0.5, y + 0.5, z + 0.5);
  if (!displacedByHull(ships, p)) return false;
  for (let i = 0; i < 8; i++) {
    p.x = x + ((i & 1) !== 0 ? 1 - CELL_SAMPLE_INSET : CELL_SAMPLE_INSET);
    p.y = y + ((i & 2) !== 0 ? 1 - CELL_SAMPLE_INSET : CELL_SAMPLE_INSET);
    p.z = z + ((i & 4) !== 0 ? 1 - CELL_SAMPLE_INSET : CELL_SAMPLE_INSET);
    if (!displacedByHull(ships, p)) return false;
  }
  return true;
}

/**
 * Is ANY part of world cell (x, y, z) displaced by hulls, sampled at the centres of its eight
 * octants? The counterpart of cellDisplaced for pouring: a liquid source placed there would be
 * partly hidden inside a hull now and left behind when the ship moves away. With partial hull
 * cells the cell centre alone is not enough: for a hull aligned with the world it lies on three
 * mid-planes, so displacedByHull at the centre answers for octant 7 only (a lower slab of the hull
 * would let water in, a single upper octant would refuse it). Exact for hulls aligned with the
 * world; for offset or rotated hulls a displaced corner smaller than an octant can be missed.
 */
export function partlyDisplaced(ships: readonly RayShip[], x: number, y: number, z: number): boolean {
  if (ships.length === 0) return false;
  const p = vec3();
  for (let i = 0; i < 8; i++) {
    p.x = x + ((i & 1) !== 0 ? 0.75 : 0.25);
    p.y = y + ((i & 2) !== 0 ? 0.75 : 0.25);
    p.z = z + ((i & 4) !== 0 ? 0.75 : 0.25);
    if (displacedByHull(ships, p)) return true;
  }
  return false;
}

// ====================================================================== the bucket ray

function bucketRay(scene: RayScene, eye: Vec3, dir: Vec3, reach: number): GridHit | null {
  let world: VoxelGrid | null = null;
  let best: GridHit | null = null;
  let limit = reach;
  const grids = scene.grids;
  for (let i = 0; i < grids.length; i++) {
    const g = grids[i]!;
    if (g.isWorld) {
      world = g;
      continue;
    }
    // Structures hold no liquid: for them the bucket ray is the plain ray.
    const h = raycastGrid(g, eye, dir, limit, targetable);
    if (h !== null && (best === null || h.dist < best.dist)) {
      best = h;
      limit = h.dist;
    }
  }
  if (world === null) return best;
  const o = vec3();
  const exit: Exit = { t: 0, face: PX };
  let from = 0;
  for (let skips = 0; skips <= MAX_HIDDEN_SKIPS; skips++) {
    o.x = eye.x + dir.x * from;
    o.y = eye.y + dir.y * from;
    o.z = eye.z + dir.z * from;
    const w = raycastGrid(world, o, dir, limit - from, targetableOrLiquidSource);
    if (w === null) return best;
    if (from > 0) {
      if (w.dist === 0) {
        // Resumed inside this cell right behind the skipped one: it was entered through the
        // face the ray left the skipped cell by (raycastGrid cannot know that from inside).
        w.face = exit.face;
        w.dist = exit.t;
      } else {
        w.dist += from;
      }
      w.point.x = eye.x + dir.x * w.dist;
      w.point.y = eye.y + dir.y * w.dist;
      w.point.z = eye.z + dir.z * w.dist;
    }
    if (LIQUID[w.part & ID_MASK] === 0) return w;
    cellExit(eye, dir, w.x, w.y, w.z, w.dist, exit);
    const end = best !== null && best.dist < exit.t ? best.dist : exit.t;
    if (liquidVisible(scene.ships, eye, dir, w.dist, end)) return w;
    if (exit.t >= limit) return best;
    from = exit.t + SKIP_EPS;
  }
  return best;
}

interface Exit {
  t: number;
  face: Dir;
}

/** out = where the ray leaves world cell (x,y,z) (entered at `entry`), and the next cell's entry face. */
function cellExit(eye: Vec3, dir: Vec3, x: number, y: number, z: number, entry: number, out: Exit): void {
  let t = Infinity;
  let face: Dir = PX;
  let slope = -1;
  // On an exact edge or corner exit, the steepest of the tied axes names the face (as raycastGrid does).
  if (dir.x !== 0) {
    const tx = ((dir.x > 0 ? x + 1 : x) - eye.x) / dir.x;
    if (tx < t || (tx === t && Math.abs(dir.x) > slope)) {
      t = tx;
      face = dir.x > 0 ? NX : PX;
      slope = Math.abs(dir.x);
    }
  }
  if (dir.y !== 0) {
    const ty = ((dir.y > 0 ? y + 1 : y) - eye.y) / dir.y;
    if (ty < t || (ty === t && Math.abs(dir.y) > slope)) {
      t = ty;
      face = dir.y > 0 ? NY : PY;
      slope = Math.abs(dir.y);
    }
  }
  if (dir.z !== 0) {
    const tz = ((dir.z > 0 ? z + 1 : z) - eye.z) / dir.z;
    if (tz < t || (tz === t && Math.abs(dir.z) > slope)) {
      t = tz;
      face = dir.z > 0 ? NZ : PZ;
    }
  }
  out.t = t > entry ? t : entry;
  out.face = face;
}

/** Is the world liquid on the ray between t0 and t1 visible somewhere, i.e. not all displaced by hulls? */
function liquidVisible(ships: readonly RayShip[], eye: Vec3, dir: Vec3, t0: number, t1: number): boolean {
  if (!(t1 > t0)) return false; // a structure starts where the liquid does
  if (ships.length === 0) return true;
  const n = Math.max(1, Math.ceil((t1 - t0) / HULL_SAMPLE));
  const step = (t1 - t0) / n;
  const p = vec3();
  for (let i = 0; i < n; i++) {
    const t = t0 + (i + 0.5) * step;
    p.x = eye.x + dir.x * t;
    p.y = eye.y + dir.y * t;
    p.z = eye.z + dir.z * t;
    if (!displacedByHull(ships, p)) return true;
  }
  return false;
}
