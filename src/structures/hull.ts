/**
 * Hull analysis for physical structures (ships): which cells displace water, which air
 * cells are dry, and the mass properties.
 *
 * Water-tightness uses a priority flood in the structure's LOCAL frame with local +Y as
 * "up" (ships are assembled and docked upright). For every non-solid cell c we compute its
 * SPILL LEVEL L(c): the lowest waterline (integer local y) at which outside water can
 * reach c through non-solid cells, i.e. the minimax over paths from outside of the highest
 * cell on the path. Then:
 *
 *   L(c) == y(c)      -> OPEN: water reaches it as soon as the waterline is at its level
 *   y(c) < L(c) < inf -> BILGE: protected by walls up to a rim (an open boat's hold).
 *                        Dry while the ship floats.
 *   unreachable       -> SEALED: always dry.
 *
 * docs/LESSONS.md: "只有船还能浮起来（质量小于最大排水体积）时，船体范围内的水才算干；
 * 密封空腔永远是干的" — that is `floats` + isDry() below.
 */
import { vec3, type Vec3 } from '../core/math';
import { AIR, ID_MASK } from '../blocks/cell';
import { BLOCKS, SOLID } from '../blocks/registry';
import type { StructureGrid } from '../voxel/sgrid';

export const HULL_OPEN = 0;
export const HULL_SOLID = 1;
export const HULL_BILGE = 2;
export const HULL_SEALED = 3;

export interface HullInfo {
  /** grid.version this analysis was computed from. */
  version: number;
  /** Analysed box in local cell coordinates: tight cell bounds grown by 1 on every side. */
  ox: number;
  oy: number;
  oz: number;
  sx: number;
  sy: number;
  sz: number;
  /** HULL_* per cell of the box; index = (x-ox) + (z-oz)*sx + (y-oy)*sx*sz. */
  kind: Uint8Array;
  solidCount: number;
  bilgeCount: number;
  sealedCount: number;
  /** Total mass: sum of BlockDef.density over all non-air cells (one block of water = 1). */
  mass: number;
  /** Centre of mass in local space. */
  com: Vec3;
  /** Inertia tensor about the centre of mass in local axes, row-major 3x3. */
  inertia: Float64Array;
  /** Largest volume of water (in cells) the hull can displace: solid + bilge + sealed. */
  maxDisplacement: number;
  /** True when the ship can float: mass < maxDisplacement. */
  floats: boolean;
}

/** HULL_* kind of a local cell (HULL_OPEN outside the analysed box). */
export function hullKindAt(h: HullInfo, x: number, y: number, z: number): number {
  const lx = x - h.ox;
  const ly = y - h.oy;
  const lz = z - h.oz;
  if (lx < 0 || ly < 0 || lz < 0 || lx >= h.sx || ly >= h.sy || lz >= h.sz) return HULL_OPEN;
  return h.kind[lx + lz * h.sx + ly * h.sx * h.sz]!;
}

/**
 * Is this local cell a dry air pocket of the hull right now?
 * Sealed cavities always; bilge cells only while the ship can float.
 */
export function isDryCell(h: HullInfo, x: number, y: number, z: number): boolean {
  const k = hullKindAt(h, x, y, z);
  return k === HULL_SEALED || (k === HULL_BILGE && h.floats);
}

/**
 * Does this local cell displace water (contributes buoyancy when submerged)?
 * Solid hull cells always; cavities as in isDryCell.
 */
export function displacesWater(h: HullInfo, x: number, y: number, z: number): boolean {
  const k = hullKindAt(h, x, y, z);
  return k === HULL_SOLID || k === HULL_SEALED || (k === HULL_BILGE && h.floats);
}

/**
 * Mask of dry cells over the analysed box (1 = dry), in the layout the renderer's
 * DryVolume expects. Returns null when the hull has no dry cell.
 */
export function dryMask(h: HullInfo): Uint8Array | null {
  const n = h.kind.length;
  let any = false;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = h.kind[i]!;
    if (k === HULL_SEALED || (k === HULL_BILGE && h.floats)) {
      mask[i] = 1;
      any = true;
    }
  }
  return any ? mask : null;
}

/** Analyse a structure grid. Returns null for an empty grid. O(cells in the bounding box). */
export function analyzeHull(grid: StructureGrid): HullInfo | null {
  const b = grid.cellBounds();
  if (!b) return null;
  const ox = b.minX - 1;
  const oy = b.minY - 1;
  const oz = b.minZ - 1;
  const sx = b.maxX - b.minX + 2;
  const sy = b.maxY - b.minY + 2;
  const sz = b.maxZ - b.minZ + 2;
  const layer = sx * sz;
  const n = layer * sy;
  const kind = new Uint8Array(n);

  // ---- classify solid cells + accumulate mass
  let solidCount = 0;
  let mass = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  grid.forEachCell((x, y, z, cell) => {
    const id = cell & ID_MASK;
    const def = BLOCKS[id];
    const m = def ? def.density : 1;
    mass += m;
    mx += m * (x + 0.5);
    my += m * (y + 0.5);
    mz += m * (z + 0.5);
    if (SOLID[id] === 1) {
      kind[x - ox + (z - oz) * sx + (y - oy) * layer] = HULL_SOLID;
      solidCount++;
    }
  });
  const com = mass > 0 ? vec3(mx / mass, my / mass, mz / mass) : vec3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);

  // ---- inertia about the centre of mass (unit cubes: m/6 on the diagonal each)
  const inertia = new Float64Array(9);
  grid.forEachCell((x, y, z, cell) => {
    const def = BLOCKS[cell & ID_MASK];
    const m = def ? def.density : 1;
    const rx = x + 0.5 - com.x;
    const ry = y + 0.5 - com.y;
    const rz = z + 0.5 - com.z;
    const own = m / 6;
    inertia[0] += m * (ry * ry + rz * rz) + own;
    inertia[4] += m * (rx * rx + rz * rz) + own;
    inertia[8] += m * (rx * rx + ry * ry) + own;
    inertia[1] -= m * rx * ry;
    inertia[2] -= m * rx * rz;
    inertia[5] -= m * ry * rz;
  });
  inertia[3] = inertia[1]!;
  inertia[6] = inertia[2]!;
  inertia[7] = inertia[5]!;

  // ---- priority flood by integer level (bucket per y layer)
  // spill[i]: -1 = not reached yet, otherwise the spill level as a layer index (0..sy-1).
  const spill = new Int16Array(n).fill(-1);
  const buckets: number[][] = [];
  for (let y = 0; y < sy; y++) buckets.push([]);
  // Seed: every cell on the surface of the box (all non-solid by construction, since the
  // box is the tight bounds grown by one) at its own level.
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (x !== 0 && x !== sx - 1 && z !== 0 && z !== sz - 1 && y !== 0 && y !== sy - 1) continue;
        const i = x + z * sx + y * layer;
        if (kind[i] === HULL_SOLID) continue;
        spill[i] = y;
        buckets[y]!.push(i);
      }
    }
  }
  const queue: number[] = [];
  for (let level = 0; level < sy; level++) {
    const bucket = buckets[level]!;
    for (let k = 0; k < bucket.length; k++) queue.push(bucket[k]!);
    while (queue.length > 0) {
      const i = queue.pop()!;
      if (spill[i] !== level) continue; // stale entry (already settled at a lower level)
      const y = Math.floor(i / layer);
      const rem = i - y * layer;
      const z = Math.floor(rem / sx);
      const x = rem - z * sx;
      // 6 neighbours
      for (let d = 0; d < 6; d++) {
        const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        const nz = z + (d === 4 ? 1 : d === 5 ? -1 : 0);
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
        const j = nx + nz * sx + ny * layer;
        if (kind[j] === HULL_SOLID) continue;
        const l = ny > level ? ny : level;
        const cur = spill[j]!;
        if (cur !== -1 && cur <= l) continue;
        spill[j] = l;
        if (l === level) queue.push(j);
        else buckets[l]!.push(j);
      }
    }
  }

  let bilgeCount = 0;
  let sealedCount = 0;
  for (let i = 0; i < n; i++) {
    if (kind[i] === HULL_SOLID) continue;
    const s = spill[i]!;
    if (s === -1) {
      kind[i] = HULL_SEALED;
      sealedCount++;
    } else {
      const y = Math.floor(i / layer);
      if (s > y) {
        kind[i] = HULL_BILGE;
        bilgeCount++;
      }
    }
  }

  const maxDisplacement = solidCount + bilgeCount + sealedCount;
  return {
    version: grid.version,
    ox,
    oy,
    oz,
    sx,
    sy,
    sz,
    kind,
    solidCount,
    bilgeCount,
    sealedCount,
    mass,
    com,
    inertia,
    maxDisplacement,
    floats: mass < maxDisplacement,
  };
}

/** True for cells that count as "no block here" for the purposes of water (AIR or soft). */
export function isPassableForWater(cell: number): boolean {
  return cell === AIR || SOLID[cell & ID_MASK] === 0;
}
