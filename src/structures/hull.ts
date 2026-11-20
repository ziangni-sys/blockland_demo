/**
 * Hull analysis for physical structures (ships): which octants displace water, which empty
 * octants are dry, and the mass properties (docs/SHAPES.md 12.1 to 12.3).
 *
 * WATER-TIGHTNESS is a priority flood in the structure's LOCAL frame with local +Y as "up" (ships
 * are assembled and docked upright), on a MIXED graph, with levels counted in half layers:
 *
 *  - a cell without hard material (solidFill 0: air, a torch) is ONE node of height 2y;
 *  - every empty octant of a partial cell (some but not all octants hard) is a node of height
 *    2y + oy;
 *  - a cell whose 8 octants are all hard has no node.
 *
 * Edges join face-adjacent nodes: two whole-cell nodes; a whole-cell node and the empty octants of
 * a neighbouring partial cell that lie against the shared face; two empty octants that are
 * face-adjacent on the half grid (in one partial cell, or in two neighbouring partial cells).
 * Every node gets a SPILL LEVEL L: the lowest waterline (in half layers) at which outside water
 * reaches it, i.e. the minimum over paths from outside of the highest node on the path. The box is
 * the tight bounds grown by one, so its surface holds only empty whole-cell nodes; they are the
 * seeds, each at its own height. A half layer k of a node (k = 2y and 2y + 1 for a whole-cell
 * node, only its own for an octant node) is then
 *
 *   not reached -> SEALED: always dry;
 *   L > k       -> BILGE:  protected by walls up to a rim (an open boat's hold), dry while the
 *                          ship floats;
 *   otherwise   -> OPEN.
 *
 * A whole-cell node whose two half layers differ (the spill line runs through the middle of the
 * cell) and every partial cell are HULL_MIXED: their 8 octant kinds are stored sparsely
 * (mixedIndex / mixedKinds). The graph has O(box + 8 x partial cells) nodes; a dense half-cell
 * grid would be 8 x the box, up to 16 million nodes at the box limit (LESSONS 格子数有上限，内存却没有).
 * A hull of full blocks only has even heights and even levels: both halves of a whole-cell node
 * always agree, there is no mixed cell, and every result equals the cell flood of M1 bit for bit.
 *
 * MASS: every part of a cell adds density x FILL_VOLUME / 8 at the cell corner + CENTROID of its
 * fill; a full single-part block uses the M1 expressions (density at the cell centre, own inertia
 * m/6 on the diagonal), so a ship of full blocks keeps bit-identical mass data. Soft blocks
 * (torches) are full single parts and count as before.
 *
 * docs/LESSONS.md: "只有船还能浮起来（质量小于最大排水体积）时，船体范围内的水才算干；密封空腔永远是干的"
 * — that is `floats` and the dry queries below.
 */
import { vec3, type Vec3 } from '../core/math';
import { HOLES_SHIFT, ID_MASK } from '../blocks/cell';
import { BLOCKS, SOLID } from '../blocks/registry';
import { CENTROID, FILL_VOLUME } from '../blocks/shapes';
import type { StructureGrid } from '../voxel/sgrid';

export const HULL_OPEN = 0;
export const HULL_SOLID = 1;
export const HULL_BILGE = 2;
export const HULL_SEALED = 3;
/** The 8 octants of this cell are not all of one kind: read them with hullOctantKind. */
export const HULL_MIXED = 4;

/** dryMask falls back to one texel per cell when the octant mask (8 x the box) would be larger. */
export const DRY_MASK_MAX_TEXELS = 1 << 22;

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
  /** HULL_* per cell of the box; index = (x-ox) + (z-oz)*sx + (y-oy)*sx*sz. HULL_MIXED: see mixedKinds. */
  kind: Uint8Array;
  /** Box indices of the HULL_MIXED cells, ascending. */
  mixedIndex: Int32Array;
  /** One entry per mixedIndex entry: the kind (0..3) of octant o in the 2 bits from bit 2*o. */
  mixedKinds: Uint16Array;
  /** Cells that are entirely of this kind (a ship of full blocks: as in M1). */
  solidCount: number;
  bilgeCount: number;
  sealedCount: number;
  /** Volumes in cells, counting the octants of mixed cells (multiples of 1/8). */
  solidVolume: number;
  bilgeVolume: number;
  sealedVolume: number;
  /** Total mass: sum over parts of BlockDef.density x volume (one block of water = 1). */
  mass: number;
  /** Centre of mass in local space. */
  com: Vec3;
  /** Inertia tensor about the centre of mass in local axes, row-major 3x3. */
  inertia: Float64Array;
  /** Largest volume of water (in cells) the hull can displace: solidVolume + bilgeVolume + sealedVolume. */
  maxDisplacement: number;
  /** True when the ship can float: mass < maxDisplacement (refreshShip rewrites it with the rotors and the water density). */
  floats: boolean;
}

/** HULL_* kind of a local cell (HULL_OPEN outside the analysed box); HULL_MIXED for a mixed cell. */
export function hullKindAt(h: HullInfo, x: number, y: number, z: number): number {
  const lx = x - h.ox;
  const ly = y - h.oy;
  const lz = z - h.oz;
  if (lx < 0 || ly < 0 || lz < 0 || lx >= h.sx || ly >= h.sy || lz >= h.sz) return HULL_OPEN;
  return h.kind[lx + lz * h.sx + ly * h.sx * h.sz]!;
}

/** The 16-bit octant kinds of the mixed cell at box index i (binary search in mixedIndex; -1 when not mixed). */
function mixedEntry(h: HullInfo, i: number): number {
  const idx = h.mixedIndex;
  let lo = 0;
  let hi = idx.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = idx[mid]!;
    if (v === i) return h.mixedKinds[mid]!;
    if (v < i) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** All 8 octant kinds of a local cell, 2 bits each (a uniform cell repeats its kind). */
function octantKinds(h: HullInfo, x: number, y: number, z: number): number {
  const lx = x - h.ox;
  const ly = y - h.oy;
  const lz = z - h.oz;
  if (lx < 0 || ly < 0 || lz < 0 || lx >= h.sx || ly >= h.sy || lz >= h.sz) return 0; // HULL_OPEN = 0 in every octant
  const i = lx + lz * h.sx + ly * h.sx * h.sz;
  const k = h.kind[i]!;
  return k === HULL_MIXED ? mixedEntry(h, i) : k * 0x5555;
}

/** Kind (HULL_OPEN, HULL_SOLID, HULL_BILGE or HULL_SEALED) of one octant of a local cell. */
export function hullOctantKind(h: HullInfo, x: number, y: number, z: number, octant: number): number {
  const k = hullKindAt(h, x, y, z);
  if (k !== HULL_MIXED) return k;
  const lx = x - h.ox;
  const ly = y - h.oy;
  const lz = z - h.oz;
  return (mixedEntry(h, lx + lz * h.sx + ly * h.sx * h.sz) >> (octant * 2)) & 3;
}

/**
 * Is the octant at half-cell coordinates (hx, hy, hz) (integers: local coordinates times 2,
 * floored) a dry air pocket of the hull right now? Sealed always; bilge only while the ship can
 * float. Entities' liquid sampling, bucket rays, explosions and the camera use it. Integer
 * arguments only (docs/SHAPES.md 4.4, 12.1).
 */
export function isDryHalf(h: HullInfo, hx: number, hy: number, hz: number): boolean {
  const k = hullOctantKind(h, hx >> 1, hy >> 1, hz >> 1, (hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2));
  return k === HULL_SEALED || (k === HULL_BILGE && h.floats);
}

/** Bit 2*o set for every octant o of these kinds whose kind is dry (sealed; bilge while floating). */
function dryBits(kinds: number, floats: boolean): number {
  let m = 0;
  for (let o = 0; o < 8; o++) {
    const k = (kinds >> (o * 2)) & 3;
    if (k === HULL_SEALED || (k === HULL_BILGE && floats)) m |= 1 << o;
  }
  return m;
}

/** Are all 8 octants of this local cell dry air pockets? */
export function isDryCell(h: HullInfo, x: number, y: number, z: number): boolean {
  const k = hullKindAt(h, x, y, z);
  if (k !== HULL_MIXED) return k === HULL_SEALED || (k === HULL_BILGE && h.floats);
  return dryBits(octantKinds(h, x, y, z), h.floats) === 0xff;
}

/**
 * Does the ship cell (x,y,z) have at least one dry octant (sealed, or bilge while the hull floats)?
 * For a cell that is air in the ship this is the dry counterpart of hullCavityCells (no hard
 * octant, at least one cavity octant), so every cell that took water when the ship was assembled
 * is cleared again when it docks (assembly.ts commitDock; docs/SHAPES.md 11.3, 19.5). An air cell is dry only in part when
 * the spill line runs through its middle (lower half bilge, upper half open): its water level is
 * half a layer, which only a path through octants of cells with parts can give (docs/SHAPES.md
 * 12.3). Liquids never enter cells with parts, so once docked the sea cannot reach such a cell
 * from the side, and clearing it removes no water the sea could refill. isDryCell (all eight
 * octants dry) would leave that water inside the docked hull, to drain into the hold.
 */
export function hasDryOctant(h: HullInfo, x: number, y: number, z: number): boolean {
  for (let o = 0; o < 8; o++) {
    if (isDryHalf(h, 2 * x + (o & 1), 2 * y + ((o >> 1) & 1), 2 * z + (o >> 2))) return true;
  }
  return false;
}

/**
 * Do all 8 octants of this local cell displace water (hard, or a dry air pocket)? Solid cells
 * always; cavities as in isDryCell.
 */
export function displacesWater(h: HullInfo, x: number, y: number, z: number): boolean {
  const k = hullKindAt(h, x, y, z);
  if (k !== HULL_MIXED) return k === HULL_SOLID || k === HULL_SEALED || (k === HULL_BILGE && h.floats);
  const kinds = octantKinds(h, x, y, z);
  for (let o = 0; o < 8; o++) {
    const ko = (kinds >> (o * 2)) & 3;
    if (!(ko === HULL_SOLID || ko === HULL_SEALED || (ko === HULL_BILGE && h.floats))) return false;
  }
  return true;
}

/**
 * The cells to refill with water after assembly: cells with no hard octant and at least one
 * cavity octant (bilge or sealed, whether or not the ship floats), as x, y, z triples in local
 * coordinates, in box order. A ship of full blocks: its bilge and sealed cells.
 */
export function hullCavityCells(h: HullInfo): Int32Array {
  const out: number[] = [];
  const { sx, sz, kind } = h;
  const layer = sx * sz;
  let m = 0;
  for (let i = 0; i < kind.length; i++) {
    const k = kind[i]!;
    let cavity = k === HULL_BILGE || k === HULL_SEALED;
    if (k === HULL_MIXED) {
      const kinds = h.mixedKinds[m++]!;
      let hard = false;
      for (let o = 0; o < 8; o++) {
        const ko = (kinds >> (o * 2)) & 3;
        if (ko === HULL_SOLID) hard = true;
        else if (ko === HULL_BILGE || ko === HULL_SEALED) cavity = true;
      }
      if (hard) cavity = false;
    }
    if (!cavity) continue;
    const y = Math.floor(i / layer);
    const rem = i - y * layer;
    const z = Math.floor(rem / sx);
    out.push(h.ox + rem - z * sx, h.oy + y, h.oz + z);
  }
  return Int32Array.from(out);
}

/**
 * Mask of the dry space over the analysed box for the renderer's DryVolume, or null when nothing
 * is dry. Without mixed cells: one byte per cell (scale 1, 1 = dry), the box index layout. With
 * mixed cells: one byte per octant (scale 2) over a box twice as fine on every axis, index =
 * tx + tz * 2sx + ty * 2sx * 2sz for octant texel (tx, ty, tz); when that would exceed
 * DRY_MASK_MAX_TEXELS it falls back to scale 1, where a cell is dry when none of its octants is
 * open and at least one is dry.
 */
export function dryMask(h: HullInfo): { scale: 1 | 2; mask: Uint8Array } | null {
  const n = h.kind.length;
  const floats = h.floats;
  let any = false;
  if (h.mixedIndex.length === 0 || n * 8 > DRY_MASK_MAX_TEXELS) {
    const mask = new Uint8Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const k = h.kind[i]!;
      let dry = k === HULL_SEALED || (k === HULL_BILGE && floats);
      if (k === HULL_MIXED) {
        const kinds = h.mixedKinds[m++]!;
        let open = false;
        for (let o = 0; o < 8; o++) if (((kinds >> (o * 2)) & 3) === HULL_OPEN) open = true;
        dry = !open && dryBits(kinds, floats) !== 0;
      }
      if (dry) {
        mask[i] = 1;
        any = true;
      }
    }
    return any ? { scale: 1, mask } : null;
  }
  const { sx, sz } = h;
  const layer = sx * sz;
  const tsx = sx * 2;
  const tlayer = tsx * sz * 2;
  const mask = new Uint8Array(n * 8);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const k = h.kind[i]!;
    let bits: number;
    if (k === HULL_MIXED) bits = dryBits(h.mixedKinds[m++]!, floats);
    else bits = k === HULL_SEALED || (k === HULL_BILGE && floats) ? 0xff : 0;
    if (bits === 0) continue;
    any = true;
    const y = Math.floor(i / layer);
    const rem = i - y * layer;
    const z = Math.floor(rem / sx);
    const x = rem - z * sx;
    for (let o = 0; o < 8; o++) {
      if (((bits >> o) & 1) === 0) continue;
      mask[x * 2 + (o & 1) + (z * 2 + (o >> 2)) * tsx + (y * 2 + ((o >> 1) & 1)) * tlayer] = 1;
    }
  }
  return any ? { scale: 2, mask } : null;
}

/** Kind marks used while analysing (kind[] holds HULL_SOLID for full hard cells, PARTIAL for partial ones). */
const PARTIAL = 5;

/** Analyse a structure grid. Returns null for an empty grid. O(cells in the bounding box + 8 x partial cells). */
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

  // The three storage layers, read directly (no packed values; docs/SHAPES.md 4.4). Cells are
  // visited in storage order (y, z, x ascending), the order forEachCell used, so the floating-point
  // sums of a full-block ship are those of M1.
  const st = grid.storage();
  const base = st.layers.base;
  const holes = st.layers.holes;
  const part2 = st.layers.part2;
  const ssx = st.sx;
  const slayer = st.sx * st.sz;

  // ---- classify cells, accumulate mass and centre of mass
  let solidCount = 0;
  let partialCount = 0;
  let mass = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let y: number = b.minY; y < b.maxY; y++) {
    for (let z: number = b.minZ; z < b.maxZ; z++) {
      const row: number = (z - st.oz) * ssx + (y - st.oy) * slayer - st.ox;
      for (let x: number = b.minX; x < b.maxX; x++) {
        const si: number = row + x;
        const v: number = base[si]!;
        if (v === 0) continue;
        const h1: number = holes !== null ? holes[si]! : 0;
        const p2: number = part2 !== null ? part2[si]! : 0;
        const id = v & ID_MASK;
        const ki = x - ox + (z - oz) * sx + (y - oy) * layer;
        if (h1 === 0 && p2 === 0) {
          // a full single-part block: the M1 expressions
          const def = BLOCKS[id];
          const m = def ? def.density : 1;
          mass += m;
          mx += m * (x + 0.5);
          my += m * (y + 0.5);
          mz += m * (z + 0.5);
          if (SOLID[id] === 1) {
            kind[ki] = HULL_SOLID;
            solidCount++;
          }
          continue;
        }
        const f1 = ~h1 & 0xff;
        const def1 = BLOCKS[id];
        const m1 = ((def1 ? def1.density : 1) * FILL_VOLUME[f1]!) / 8;
        mass += m1;
        mx += m1 * (x + CENTROID[f1 * 3]!);
        my += m1 * (y + CENTROID[f1 * 3 + 1]!);
        mz += m1 * (z + CENTROID[f1 * 3 + 2]!);
        let hard = SOLID[id] === 1 ? f1 : 0;
        if (p2 !== 0) {
          const id2 = p2 & ID_MASK;
          const f2 = ~(p2 >>> HOLES_SHIFT) & 0xff;
          const def2 = BLOCKS[id2];
          const m2 = ((def2 ? def2.density : 1) * FILL_VOLUME[f2]!) / 8;
          mass += m2;
          mx += m2 * (x + CENTROID[f2 * 3]!);
          my += m2 * (y + CENTROID[f2 * 3 + 1]!);
          mz += m2 * (z + CENTROID[f2 * 3 + 2]!);
          if (SOLID[id2] === 1) hard |= f2;
        }
        if (hard === 0xff) {
          kind[ki] = HULL_SOLID;
          solidCount++;
        } else if (hard !== 0) {
          kind[ki] = PARTIAL;
          partialCount++;
        }
      }
    }
  }
  const com = mass > 0 ? vec3(mx / mass, my / mass, mz / mass) : vec3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);

  // ---- inertia about the centre of mass: full single-part blocks as unit cubes (m/6 own term);
  // every other part octant by octant (cubes of side 0.5 and mass density/8: own term m/24)
  const inertia = new Float64Array(9);
  // partial cells: box index and hard-octant mask, numbered in box order
  const pCell = new Int32Array(partialCount);
  const pHard = new Uint8Array(partialCount);
  let pn = 0;
  for (let y: number = b.minY; y < b.maxY; y++) {
    for (let z: number = b.minZ; z < b.maxZ; z++) {
      const row: number = (z - st.oz) * ssx + (y - st.oy) * slayer - st.ox;
      for (let x: number = b.minX; x < b.maxX; x++) {
        const si: number = row + x;
        const v: number = base[si]!;
        if (v === 0) continue;
        const h1: number = holes !== null ? holes[si]! : 0;
        const p2: number = part2 !== null ? part2[si]! : 0;
        if (h1 === 0 && p2 === 0) {
          const def = BLOCKS[v & ID_MASK];
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
          continue;
        }
        addPartInertia(inertia, v & ID_MASK, ~h1 & 0xff, x, y, z, com);
        if (p2 !== 0) addPartInertia(inertia, p2 & ID_MASK, ~(p2 >>> HOLES_SHIFT) & 0xff, x, y, z, com);
        const ki = x - ox + (z - oz) * sx + (y - oy) * layer;
        if (kind[ki] === PARTIAL) {
          pCell[pn] = ki;
          let hard = SOLID[v & ID_MASK] === 1 ? ~h1 & 0xff : 0;
          if (p2 !== 0 && SOLID[p2 & ID_MASK] === 1) hard |= ~(p2 >>> HOLES_SHIFT) & 0xff;
          pHard[pn] = hard;
          pn++;
        }
      }
    }
  }
  inertia[3] = inertia[1]!;
  inertia[6] = inertia[2]!;
  inertia[7] = inertia[5]!;

  // partial number of a box cell (only read where kind is PARTIAL); allocated only with partials
  let pIndex: Int32Array | null = null;
  if (partialCount > 0) {
    pIndex = new Int32Array(n);
    for (let p = 0; p < partialCount; p++) pIndex[pCell[p]!] = p;
  }

  // ---- priority flood by half layer (one bucket per half layer). Node ids: a whole-cell node is
  // its box index i (0..n-1); octant o of partial cell p is n + 8p + o.
  const levels = sy * 2;
  // spill: -1 = not reached, otherwise the spill level in half layers (0..2sy-1)
  const spill = new Int16Array(n).fill(-1);
  const octSpill = new Int16Array(partialCount * 8).fill(-1);
  const buckets: number[][] = [];
  for (let l = 0; l < levels; l++) buckets.push([]);
  // Seed: every cell on the surface of the box (all empty by construction) at its own height.
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (x !== 0 && x !== sx - 1 && z !== 0 && z !== sz - 1 && y !== 0 && y !== sy - 1) continue;
        const i = x + z * sx + y * layer;
        if (kind[i] !== 0) continue;
        spill[i] = y * 2;
        buckets[y * 2]!.push(i);
      }
    }
  }
  const queue: number[] = [];
  for (let level = 0; level < levels; level++) {
    const bucket = buckets[level]!;
    for (let k = 0; k < bucket.length; k++) queue.push(bucket[k]!);
    while (queue.length > 0) {
      const node = queue.pop()!;
      if (node < n) {
        const i = node;
        if (spill[i] !== level) continue; // stale entry (already settled at a lower level)
        const y = Math.floor(i / layer);
        const rem = i - y * layer;
        const z = Math.floor(rem / sx);
        const x = rem - z * sx;
        for (let d = 0; d < 6; d++) {
          const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
          const nz = z + (d === 4 ? 1 : d === 5 ? -1 : 0);
          if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
          const j = nx + nz * sx + ny * layer;
          const kj = kind[j]!;
          if (kj === HULL_SOLID) continue;
          if (kj === PARTIAL) {
            // the neighbour's empty octants against the shared face: those on its side d ^ 1,
            // i.e. with bit (d >> 1) equal to (d & 1)
            const p = pIndex![j]!;
            const hard = pHard[p]!;
            const a = d >> 1;
            const side = d & 1;
            for (let o = 0; o < 8; o++) {
              if (((o >> a) & 1) !== side || ((hard >> o) & 1) !== 0) continue;
              const hgt = ny * 2 + ((o >> 1) & 1);
              const l = hgt > level ? hgt : level;
              const s = p * 8 + o;
              const cur = octSpill[s]!;
              if (cur !== -1 && cur <= l) continue;
              octSpill[s] = l;
              if (l === level) queue.push(n + s);
              else buckets[l]!.push(n + s);
            }
            continue;
          }
          const hgt = ny * 2;
          const l = hgt > level ? hgt : level;
          const cur = spill[j]!;
          if (cur !== -1 && cur <= l) continue;
          spill[j] = l;
          if (l === level) queue.push(j);
          else buckets[l]!.push(j);
        }
      } else {
        const s = node - n;
        if (octSpill[s] !== level) continue;
        const p = s >> 3;
        const o = s & 7;
        const i = pCell[p]!;
        const y = Math.floor(i / layer);
        const rem = i - y * layer;
        const z = Math.floor(rem / sx);
        const x = rem - z * sx;
        const hard = pHard[p]!;
        for (let d = 0; d < 6; d++) {
          const a = d >> 1;
          const bit = 1 << a;
          const o2 = o ^ bit;
          // moving in +a from the low half (or in -a from the high half) stays in this cell
          const inside = ((o >> a) & 1) === (d & 1);
          if (inside) {
            if (((hard >> o2) & 1) !== 0) continue;
            const hgt = y * 2 + ((o2 >> 1) & 1);
            const l = hgt > level ? hgt : level;
            const s2 = p * 8 + o2;
            const cur = octSpill[s2]!;
            if (cur !== -1 && cur <= l) continue;
            octSpill[s2] = l;
            if (l === level) queue.push(n + s2);
            else buckets[l]!.push(n + s2);
            continue;
          }
          // across the cell face: a partial cell lies inside the tight bounds, so the neighbour is in the box
          const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
          const nz = z + (d === 4 ? 1 : d === 5 ? -1 : 0);
          const j = nx + nz * sx + ny * layer;
          const kj = kind[j]!;
          if (kj === HULL_SOLID) continue;
          if (kj === PARTIAL) {
            const p2 = pIndex![j]!;
            if (((pHard[p2]! >> o2) & 1) !== 0) continue;
            const hgt = ny * 2 + ((o2 >> 1) & 1);
            const l = hgt > level ? hgt : level;
            const s2 = p2 * 8 + o2;
            const cur = octSpill[s2]!;
            if (cur !== -1 && cur <= l) continue;
            octSpill[s2] = l;
            if (l === level) queue.push(n + s2);
            else buckets[l]!.push(n + s2);
            continue;
          }
          const hgt = ny * 2;
          const l = hgt > level ? hgt : level;
          const cur = spill[j]!;
          if (cur !== -1 && cur <= l) continue;
          spill[j] = l;
          if (l === level) queue.push(j);
          else buckets[l]!.push(j);
        }
      }
    }
  }

  // ---- classification
  let bilgeCount = 0;
  let sealedCount = 0;
  let solid8 = 0;
  let bilge8 = 0;
  let sealed8 = 0;
  const mixedIdx: number[] = [];
  const mixedK: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = kind[i]!;
    if (k === HULL_SOLID) continue;
    const y2 = Math.floor(i / layer) * 2;
    if (k === PARTIAL) {
      const p = pIndex![i]!;
      const hard = pHard[p]!;
      let kinds = 0;
      for (let o = 0; o < 8; o++) {
        let ko: number;
        if (((hard >> o) & 1) !== 0) {
          ko = HULL_SOLID;
          solid8++;
        } else {
          const s = octSpill[p * 8 + o]!;
          if (s === -1) {
            ko = HULL_SEALED;
            sealed8++;
          } else if (s > y2 + ((o >> 1) & 1)) {
            ko = HULL_BILGE;
            bilge8++;
          } else {
            ko = HULL_OPEN;
          }
        }
        kinds |= ko << (o * 2);
      }
      kind[i] = HULL_MIXED;
      mixedIdx.push(i);
      mixedK.push(kinds);
      continue;
    }
    const s = spill[i]!;
    if (s === -1) {
      kind[i] = HULL_SEALED;
      sealedCount++;
      continue;
    }
    const lower = s > y2 ? HULL_BILGE : HULL_OPEN;
    const upper = s > y2 + 1 ? HULL_BILGE : HULL_OPEN;
    if (lower === upper) {
      if (lower === HULL_BILGE) {
        kind[i] = HULL_BILGE;
        bilgeCount++;
      }
      continue;
    }
    // the spill line runs through the middle of this cell: lower octants (0, 1, 4, 5) one kind,
    // upper octants (2, 3, 6, 7) the other
    kind[i] = HULL_MIXED;
    mixedIdx.push(i);
    mixedK.push(lower * 0x0505 + upper * 0x5050);
    if (lower === HULL_BILGE) bilge8 += 4;
    if (upper === HULL_BILGE) bilge8 += 4;
  }

  const solidVolume = solidCount + solid8 / 8;
  const bilgeVolume = bilgeCount + bilge8 / 8;
  const sealedVolume = sealedCount + sealed8 / 8;
  const maxDisplacement = solidVolume + bilgeVolume + sealedVolume;
  return {
    version: grid.version,
    ox,
    oy,
    oz,
    sx,
    sy,
    sz,
    kind,
    mixedIndex: Int32Array.from(mixedIdx),
    mixedKinds: Uint16Array.from(mixedK),
    solidCount,
    bilgeCount,
    sealedCount,
    solidVolume,
    bilgeVolume,
    sealedVolume,
    mass,
    com,
    inertia,
    maxDisplacement,
    floats: mass < maxDisplacement,
  };
}

/** Add one part (material `id`, octant mask `fill`) of cell (x, y, z) to the inertia tensor, octant by octant. */
function addPartInertia(I: Float64Array, id: number, fill: number, x: number, y: number, z: number, com: Vec3): void {
  const def = BLOCKS[id];
  const m = (def ? def.density : 1) / 8;
  const own = m / 24;
  for (let o = 0; o < 8; o++) {
    if (((fill >> o) & 1) === 0) continue;
    const rx = x + 0.25 + 0.5 * (o & 1) - com.x;
    const ry = y + 0.25 + 0.5 * ((o >> 1) & 1) - com.y;
    const rz = z + 0.25 + 0.5 * ((o >> 2) & 1) - com.z;
    I[0] += m * (ry * ry + rz * rz) + own;
    I[4] += m * (rx * rx + rz * rz) + own;
    I[8] += m * (rx * rx + ry * ry) + own;
    I[1] -= m * rx * ry;
    I[2] -= m * rx * rz;
    I[5] -= m * ry * rz;
  }
}
