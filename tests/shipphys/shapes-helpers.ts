/**
 * Helpers of the P9 tests on hulls with partial cells (docs/SHAPES.md section 12): random partial
 * cells, ships of slabs, and a dense reference for the hull flood (every octant a node; the real
 * analysis uses a mixed graph of whole cells and octants and must agree with it octant by octant).
 */
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, solidFill } from '../../src/blocks/shapes';
import { Rng } from '../../src/core/rng';
import { HULL_BILGE, HULL_OPEN, HULL_SEALED, HULL_SOLID } from '../../src/structures/hull';
import { Ship } from '../../src/structures/structure';
import type { StructureGrid } from '../../src/voxel/sgrid';
import { getPacked } from '../../src/voxel/parts';
import type { World } from '../../src/voxel/world';
import { slab } from '../shapes';

/**
 * A random cell content: air, a full block, a part with holes, or a two-part cell (stone and
 * planks; their union may fill the cell). Planks and stone are both cuttable and hard.
 */
export function randomCell(rng: Rng, pAir = 0.4, pFull = 0.25, pTwo = 0.12): number {
  const r = rng.next();
  if (r < pAir) return 0;
  if (r < pAir + pFull) return makeCell(rng.chance(0.5) ? B.PLANKS_OAK : B.STONE);
  if (r < pAir + pFull + pTwo) {
    // split a random fill (at least two octants) into two disjoint non-empty fills
    let f = rng.int(1, 255);
    while ((f & (f - 1)) === 0) f = rng.int(1, 255);
    let a = 0;
    for (let o = 0; o < 8; o++) if ((f >> o) & 1 && rng.chance(0.5)) a |= 1 << o;
    if (a === 0 || a === f) a = f & -f;
    return canonCell(slab(B.STONE, a), slab(B.PLANKS_OAK, f & ~a));
  }
  return slab(rng.chance(0.5) ? B.PLANKS_OAK : B.STONE, rng.int(1, 254));
}

/** Octant kinds of the dense reference flood over the hull's analysis box. */
export interface ReferenceKinds {
  ox: number;
  oy: number;
  oz: number;
  /** Box size in cells. */
  sx: number;
  sy: number;
  sz: number;
  /** HULL_OPEN / SOLID / BILGE / SEALED per octant; index hx + hz * 2sx + hy * 2sx * 2sz (box-relative half coordinates). */
  kinds: Uint8Array;
}

/**
 * The definition of docs/SHAPES.md 12.3 on a dense half-cell grid: every octant of the box that is
 * not hard is a node of height hy; edges join face-adjacent octants; the spill level of a node is
 * the minimum over paths from the box surface of the highest node on the path. Unreached ->
 * sealed; level above the octant's height -> bilge; else open.
 */
export function referenceKinds(grid: StructureGrid): ReferenceKinds {
  const b = grid.cellBounds()!;
  const ox = b.minX - 1;
  const oy = b.minY - 1;
  const oz = b.minZ - 1;
  const sx = b.maxX - b.minX + 2;
  const sy = b.maxY - b.minY + 2;
  const sz = b.maxZ - b.minZ + 2;
  const hx = sx * 2;
  const hy = sy * 2;
  const hz = sz * 2;
  const n = hx * hy * hz;
  const hard = new Uint8Array(n);
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const f = solidFill(getPacked(grid, x + ox, y + oy, z + oz));
        for (let o = 0; o < 8; o++) {
          if (((f >> o) & 1) === 0) continue;
          hard[x * 2 + (o & 1) + (z * 2 + (o >> 2)) * hx + (y * 2 + ((o >> 1) & 1)) * hx * hz] = 1;
        }
      }
    }
  }
  const level = new Int32Array(n).fill(-1);
  const buckets: number[][] = [];
  for (let l = 0; l < hy; l++) buckets.push([]);
  for (let y = 0; y < hy; y++) {
    for (let z = 0; z < hz; z++) {
      for (let x = 0; x < hx; x++) {
        if (x !== 0 && y !== 0 && z !== 0 && x !== hx - 1 && y !== hy - 1 && z !== hz - 1) continue;
        const i = x + z * hx + y * hx * hz;
        if (hard[i]) continue;
        level[i] = y;
        buckets[y]!.push(i);
      }
    }
  }
  for (let l = 0; l < hy; l++) {
    const q = buckets[l]!;
    while (q.length > 0) {
      const i = q.pop()!;
      if (level[i] !== l) continue;
      const y = Math.floor(i / (hx * hz));
      const z = Math.floor((i - y * hx * hz) / hx);
      const x = i - y * hx * hz - z * hx;
      const nb: Array<[number, number, number]> = [
        [x + 1, y, z],
        [x - 1, y, z],
        [x, y + 1, z],
        [x, y - 1, z],
        [x, y, z + 1],
        [x, y, z - 1],
      ];
      for (const [nx, ny, nz] of nb) {
        if (nx < 0 || ny < 0 || nz < 0 || nx >= hx || ny >= hy || nz >= hz) continue;
        const j = nx + nz * hx + ny * hx * hz;
        if (hard[j]) continue;
        const lv = Math.max(l, ny);
        if (level[j] !== -1 && level[j]! <= lv) continue;
        level[j] = lv;
        buckets[lv]!.push(j);
      }
    }
  }
  const kinds = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const y = Math.floor(i / (hx * hz));
    kinds[i] = hard[i] ? HULL_SOLID : level[i] === -1 ? HULL_SEALED : level[i]! > y ? HULL_BILGE : HULL_OPEN;
  }
  return { ox, oy, oz, sx, sy, sz, kinds };
}

/** Kind of octant o of cell (x, y, z) in a reference (local cell coordinates of the grid). */
export function referenceKind(r: ReferenceKinds, x: number, y: number, z: number, o: number): number {
  const hx = (x - r.ox) * 2 + (o & 1);
  const hy = (y - r.oy) * 2 + ((o >> 1) & 1);
  const hz = (z - r.oz) * 2 + (o >> 2);
  if (hx < 0 || hy < 0 || hz < 0 || hx >= r.sx * 2 || hy >= r.sy * 2 || hz >= r.sz * 2) return HULL_OPEN;
  return r.kinds[hx + hz * r.sx * 2 + hy * r.sx * 2 * r.sz * 2]!;
}

/** Write `cell` into every cell of the inclusive box [x0..x1] x [y0..y1] x [z0..z1] of a grid. */
export function fillGrid(grid: StructureGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cell: number): void {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) grid.setCell(x, y, z, cell);
}

/**
 * An open boat: a floor at y0 and walls up to y0 + h - 1 around a w x d footprint from (x0, z0),
 * every cell written as `cell` (the default is planks), the top course (the rim) as `rim` when given.
 */
export function boatOf(world: World, id: number, x0: number, y0: number, z0: number, w: number, d: number, h: number, cell: number, rim?: number): Ship {
  const s = new Ship(id, world);
  for (let y = y0; y < y0 + h; y++) {
    for (let z = z0; z < z0 + d; z++) {
      for (let x = x0; x < x0 + w; x++) {
        const wall = x === x0 || z === z0 || x === x0 + w - 1 || z === z0 + d - 1;
        if (y !== y0 && !wall) continue;
        s.grid.setCell(x, y, z, y === y0 + h - 1 && y !== y0 && rim !== undefined ? rim : cell);
      }
    }
  }
  return s;
}
