/**
 * Trees: placement and shapes.
 *
 * SEAM-FREE BY CONSTRUCTION. Chunks are generated alone, so a tree must come out identical
 * whichever chunk is generated first. Tree roots sit on a global jittered grid (one
 * candidate per TREE_GRID x TREE_GRID cell, offset and acceptance from a hash of the grid
 * cell); whether a candidate becomes a tree depends only on column samples, which are pure
 * functions of (seed, x, z). Every chunk therefore sees the same tree list, and stamps the
 * parts of every tree within TREE_REACH of its border — including trees rooted in
 * neighbouring chunks.
 *
 * Every cell decision inside a tree (ragged leaf edges ...) hashes WORLD coordinates and
 * the tree's own hash, never chunk-local state.
 */
import { CHUNK_SIZE, SEA_LEVEL, WORLD_HEIGHT } from '../core/constants';
import { AXIS_X, AXIS_Y, AXIS_Z } from '../core/dirs';
import { hash32 } from '../core/rng';
import { axisState, makeCell } from '../blocks/cell';
import { B } from '../blocks/defs';
import { latticeHash3 } from './noise';
import { classifySurface, columnSlope, SURF_TURF, type SurfaceSeeds } from './surface';
import type { ColumnRegion } from './terrain';

/** Spacing of the tree candidate grid (one candidate per cell). */
export const TREE_GRID = 5;
/** Largest horizontal (per-axis) distance of any tree cell from its trunk column. */
export const TREE_REACH = 4;
/** Largest height of any tree cell above the ground cell it stands on. */
export const TREE_MAX_HEIGHT = 12;

export const TREE_BROADLEAF = 0;
export const TREE_CONIFER = 1;

export interface TreeSpec {
  /** Trunk column. */
  x: number;
  z: number;
  /** y of the ground cell the trunk stands on (the trunk starts at ground + 1). */
  ground: number;
  kind: 0 | 1;
  /** Number of log cells in the trunk. */
  trunk: number;
  /** Crown radius in blocks. */
  radius: number;
  /** Shape variant bits and per-tree hash for ragged leaves. */
  hash: number;
}

const OAK_LOG = makeCell(B.LOG_OAK, axisState(AXIS_Y));
const OAK_LOG_X = makeCell(B.LOG_OAK, axisState(AXIS_X));
const OAK_LOG_Z = makeCell(B.LOG_OAK, axisState(AXIS_Z));
const PINE_LOG = makeCell(B.LOG_PINE, axisState(AXIS_Y));
const OAK_LEAVES = makeCell(B.LEAVES_OAK);
const PINE_LEAVES = makeCell(B.LEAVES_PINE);
const DIRT = makeCell(B.DIRT);
const TURF = makeCell(B.TURF);

/** A reusable pool of TreeSpec objects (the per-chunk tree list allocates nothing). */
export class TreeList {
  readonly items: TreeSpec[] = [];
  count = 0;

  clear(): void {
    this.count = 0;
  }
  push(): TreeSpec {
    let t = this.items[this.count];
    if (!t) {
      t = { x: 0, z: 0, ground: 0, kind: TREE_BROADLEAF, trunk: 0, radius: 0, hash: 0 };
      this.items.push(t);
    }
    this.count++;
    return t;
  }
}

/**
 * Collect every tree whose trunk column lies in [minX, maxX] x [minZ, maxZ] (inclusive)
 * into `out`, ordered by grid row then column (a deterministic world order).
 * The region must cover the rectangle plus one column on each side (slope test).
 */
export function findTrees(
  r: ColumnRegion,
  treeSeed: number,
  ss: SurfaceSeeds,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: TreeList,
): void {
  out.clear();
  const g0x = Math.floor(minX / TREE_GRID);
  const g1x = Math.floor(maxX / TREE_GRID);
  const g0z = Math.floor(minZ / TREE_GRID);
  const g1z = Math.floor(maxZ / TREE_GRID);
  for (let gz = g0z; gz <= g1z; gz++) {
    for (let gx = g0x; gx <= g1x; gx++) {
      const h = hash32(Math.imul(gx, 0x2c1b3c6d) ^ Math.imul(gz, 0x297a2d39) ^ treeSeed);
      // Offsets 0..3 inside a 5-wide cell keep neighbouring trunks at least 2 apart.
      const x = gx * TREE_GRID + (h & 3);
      const z = gz * TREE_GRID + ((h >>> 2) & 3);
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const i = r.index(x, z);
      const p = ((h >>> 4) & 0xffff) / 65536;
      if (p >= r.forest[i]!) continue;
      const ground = r.height[i]!;
      if (ground < SEA_LEVEL || ground + TREE_MAX_HEIGHT >= WORLD_HEIGHT) continue;
      if (columnSlope(r, i) > 2) continue;
      if (classifySurface(r, i, x, z, ss) !== SURF_TURF) continue;

      const v = hash32(h ^ 0x5f356495);
      // Species follows the cold field, dithered so mixed forests form along the border.
      const conifer = r.cold[i]! + (((v & 0xff) / 255) - 0.5) * 0.4 > 0.5;
      const t = out.push();
      t.x = x;
      t.z = z;
      t.ground = ground;
      t.hash = v;
      if (conifer) {
        t.kind = TREE_CONIFER;
        t.trunk = 6 + ((v >>> 8) % 5); // 6..10
        t.radius = 2 + ((v >>> 12) & 7) * 0.16; // 2.0 .. 3.12
      } else {
        t.kind = TREE_BROADLEAF;
        const size = (v >>> 8) & 3; // 0 small, 1-2 medium, 3 large
        t.trunk = 4 + size + ((v >>> 10) & 1); // 4..7 (large: 7 or 8 capped below)
        if (t.trunk > 7) t.trunk = 7;
        t.radius = 2 + size * 0.38 + ((v >>> 12) & 3) * 0.08; // 2.0 .. 3.38
      }
    }
  }
}

/** Is world cell (x, y, z) inside the chunk whose corner column is (x0, z0)? Returns index or -1. */
function chunkIndex(x0: number, z0: number, x: number, y: number, z: number): number {
  const lx = x - x0;
  const lz = z - z0;
  if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return -1;
  return lx | (lz << 4) | (y << 8);
}

/** Leaves only grow into air: never into terrain, logs, or another tree's leaves. */
function putLeaf(cells: Uint16Array, x0: number, z0: number, x: number, y: number, z: number, leaf: number): void {
  const i = chunkIndex(x0, z0, x, y, z);
  if (i >= 0 && cells[i] === 0) cells[i] = leaf;
}

/** Logs replace air and leaves (so overlapping crowns never cut a trunk), nothing else. */
function putLog(cells: Uint16Array, x0: number, z0: number, x: number, y: number, z: number, log: number): void {
  const i = chunkIndex(x0, z0, x, y, z);
  if (i < 0) return;
  const id = cells[i]! & 0x3ff;
  if (id === 0 || id === B.LEAVES_OAK || id === B.LEAVES_PINE) cells[i] = log;
}

/** Ragged crown edges: the outer shell of a crown keeps about half its cells. */
function keepEdge(t: TreeSpec, x: number, y: number, z: number, q: number): boolean {
  if (q <= 0.62) return true;
  return (latticeHash3(t.hash | 0, x, y, z) & 0xff) < 130;
}

function stampBroadleafLeaves(cells: Uint16Array, x0: number, z0: number, t: TreeSpec): void {
  const top = t.ground + t.trunk; // y of the highest log
  const R = t.radius;
  const Ry = R * 0.82;
  const cy = top + 0.35; // crown centre sits just above the top log so it is capped
  crown(cells, x0, z0, t, t.x, cy, t.z, R, Ry);
  // Large trees: two side lobes on short branches, which makes irregular, wider crowns.
  if (R >= LOBE_MIN_RADIUS) {
    for (let k = 0; k < 2; k++) {
      const d = lobeDir(t, k);
      crown(cells, x0, z0, t, t.x + LOBE_DX[d]! * 2, top - 1.2, t.z + LOBE_DZ[d]! * 2, 2.0, 1.6);
    }
  }
}

/** Broadleaf crowns at least this wide get two side lobes on short branches. */
const LOBE_MIN_RADIUS = 2.7;
const LOBE_DX: readonly number[] = [1, -1, 0, 0];
const LOBE_DZ: readonly number[] = [0, 0, 1, -1];

/** Direction (index into LOBE_DX/DZ) of side lobe k (0 or 1): the second is perpendicular or opposite. */
function lobeDir(t: TreeSpec, k: number): number {
  const d0 = (t.hash >>> 16) & 3;
  return k === 0 ? d0 : (d0 + 1 + ((t.hash >>> 18) & 1) * 2) & 3;
}

function crown(
  cells: Uint16Array,
  x0: number,
  z0: number,
  t: TreeSpec,
  cx: number,
  cy: number,
  cz: number,
  R: number,
  Ry: number,
): void {
  const ir = Math.floor(R);
  const y0 = Math.ceil(cy - Ry - 0.5);
  const y1 = Math.floor(cy + Ry - 0.5);
  const leaf = OAK_LEAVES;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / Ry;
    const dy2 = dy * dy;
    for (let dz = -ir; dz <= ir; dz++) {
      for (let dx = -ir; dx <= ir; dx++) {
        const q = (dx * dx + dz * dz) / (R * R) + dy2;
        if (q > 1) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (!keepEdge(t, x, y, z, q)) continue;
        putLeaf(cells, x0, z0, x, y, z, leaf);
      }
    }
  }
}

function stampConiferLeaves(cells: Uint16Array, x0: number, z0: number, t: TreeSpec): void {
  const topLog = t.ground + t.trunk;
  const tip = topLog + 1; // one leaf cell crowns the trunk
  const base = t.ground + 2 + (t.hash & 1) + (t.trunk >= 9 ? 1 : 0);
  const span = tip - base;
  const leaf = PINE_LEAVES;
  putLeaf(cells, x0, z0, t.x, tip, t.z, leaf);
  for (let y = base; y < tip; y++) {
    const f = (tip - y) / span; // 0 at the tip .. 1 at the base
    // Alternate wide and narrow tiers for the stacked-skirt silhouette of a conifer.
    const tier = (tip - y) & 1;
    let r = t.radius * f + 0.35;
    if (tier === 0) r *= 0.62;
    if (y === tip - 1) r = 1.0; // the plus-shaped cap just under the tip
    const ir = Math.floor(r);
    const r2 = r * r;
    for (let dz = -ir; dz <= ir; dz++) {
      for (let dx = -ir; dx <= ir; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        if (d2 > 0 && d2 > r2 * 0.6 && (latticeHash3(t.hash | 0, t.x + dx, y, t.z + dz) & 0xff) < 70) continue;
        putLeaf(cells, x0, z0, t.x + dx, y, t.z + dz, leaf);
      }
    }
  }
}

function stampTrunk(cells: Uint16Array, x0: number, z0: number, t: TreeSpec): void {
  const log = t.kind === TREE_CONIFER ? PINE_LOG : OAK_LOG;
  for (let k = 1; k <= t.trunk; k++) putLog(cells, x0, z0, t.x, t.ground + k, t.z, log);
  // The turf under a trunk would be smothered; make it dirt.
  const gi = chunkIndex(x0, z0, t.x, t.ground, t.z);
  if (gi >= 0 && cells[gi] === TURF) cells[gi] = DIRT;
}

/**
 * Branches feeding the two side lobes of a large broadleaf (see stampBroadleafLeaves).
 * Branches only reach 2 cells sideways, from top - 2 >= ground + 4 of a trunk of 6+ logs,
 * while the slope test keeps the 4 neighbouring columns within 2 of the ground: the first
 * branch cell is therefore always air or leaves, and the branch never floats.
 */
function stampBranches(cells: Uint16Array, x0: number, z0: number, t: TreeSpec): void {
  if (t.kind === TREE_CONIFER || t.radius < LOBE_MIN_RADIUS) return;
  const top = t.ground + t.trunk;
  for (let k = 0; k < 2; k++) {
    const d = lobeDir(t, k);
    const dx = LOBE_DX[d]!;
    const dz = LOBE_DZ[d]!;
    const branch = dx !== 0 ? OAK_LOG_X : OAK_LOG_Z;
    putLog(cells, x0, z0, t.x + dx, top - 2, t.z + dz, branch);
    putLog(cells, x0, z0, t.x + 2 * dx, top - 2, t.z + 2 * dz, branch);
  }
}

/**
 * Stamp the parts of all trees in `trees` that fall inside the chunk with corner column
 * (x0, z0), in three passes over ALL trees: leaves (into air only), trunks (over air and
 * leaves), branches (over air and leaves). Trunks can stand only 2 cells apart, exactly a
 * branch's reach, so the passes are what keeps a neighbour's branch out of a trunk and a
 * crown from interrupting one, whatever the tree order. (Two branches meeting in one cell
 * resolve by list order, which is a world order and the same for every chunk.)
 */
export function stampTrees(cells: Uint16Array, x0: number, z0: number, trees: TreeList): void {
  for (let k = 0; k < trees.count; k++) {
    const t = trees.items[k]!;
    if (t.kind === TREE_CONIFER) stampConiferLeaves(cells, x0, z0, t);
    else stampBroadleafLeaves(cells, x0, z0, t);
  }
  for (let k = 0; k < trees.count; k++) stampTrunk(cells, x0, z0, trees.items[k]!);
  for (let k = 0; k < trees.count; k++) stampBranches(cells, x0, z0, trees.items[k]!);
}
