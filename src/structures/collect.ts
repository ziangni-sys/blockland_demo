/**
 * Assembly queries: which cells a helm or a bearing would take with it
 * (docs/DESIGN.md "组装与方块化"; acceptance 6). Pure — they read the grid and the glue and
 * modify nothing, so the client can re-run them for the preview whenever the world changes.
 *
 * Both are breadth-first flood fills across connected() faces with a fixed neighbour order
 * (Dir 0..5), so the result (including the order of `cells`) is deterministic. The queue is
 * a typed array that doubles as the result list; the visited set is an open-addressing hash
 * of int32 triples (CellSet), so negative structure-local coordinates work everywhere.
 *
 * Unloaded chunks read as CELL_UNLOADED, which can never join a structure, so a fill cannot
 * cross into them. Instead of silently returning the loaded part as if it were complete, a
 * fill that had to look at an unloaded cell reports 'unloaded' (ok = false): assembling it
 * would leave the rest of the structure behind and delete the glue across the chunk border.
 */
import { CELL_MULTI_BIT, cellState, ID_MASK, PACK_SCALE, stateFacing } from '../blocks/cell';
import { CELL_UNLOADED } from '../blocks/defs';
import { ROTOR_MAX_CELLS, ROTOR_MIN_SAILS, SHIP_MAX_CELLS, STRUCTURE_MAX_BOX_CELLS } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, dirSign, type Dir } from '../core/dirs';
import type { CellBounds, VoxelGrid } from '../voxel/grid';
import type { GlueStore } from './glue';
import { canJoinStructure, cellFunc, connectedCells, isFunctionalCell, isSailCell } from './stick';

// ------------------------------------------------------------ CellSet

/** murmur3 fmix32 over a combination of the three coordinates. */
function hashCell(x: number, y: number, z: number): number {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

function capacityFor(n: number): number {
  let cap = 16;
  while (cap < n * 2) cap *= 2; // load factor <= 0.5 keeps linear probes short
  return cap;
}

/**
 * Set of integer cell coordinates (any int32 values, negatives included). Open addressing with
 * linear probing over typed arrays: no per-entry allocation, exact (stores the coordinates,
 * so there are no key collisions). Useful as the `inSet` predicate for GlueStore.moveTo:
 * `const set = CellSet.fromCells(result.cells)`.
 */
export class CellSet {
  private xs: Int32Array;
  private ys: Int32Array;
  private zs: Int32Array;
  private used: Uint8Array;
  private mask: number;
  private n = 0;

  constructor(expectedSize = 16) {
    const cap = capacityFor(Math.max(1, expectedSize));
    this.xs = new Int32Array(cap);
    this.ys = new Int32Array(cap);
    this.zs = new Int32Array(cap);
    this.used = new Uint8Array(cap);
    this.mask = cap - 1;
  }

  /** Build from x,y,z triples (e.g. CollectResult.cells). `count` = number of triples to read. */
  static fromCells(cells: ArrayLike<number>, count: number = Math.floor(cells.length / 3)): CellSet {
    const s = new CellSet(count);
    for (let i = 0; i < count; i++) s.add(cells[i * 3]!, cells[i * 3 + 1]!, cells[i * 3 + 2]!);
    return s;
  }

  get size(): number {
    return this.n;
  }

  has(x: number, y: number, z: number): boolean {
    const { xs, ys, zs, used, mask } = this;
    let i = hashCell(x, y, z) & mask;
    while (used[i] !== 0) {
      if (xs[i] === x && ys[i] === y && zs[i] === z) return true;
      i = (i + 1) & mask;
    }
    return false;
  }

  /** Insert; false when already present. Coordinates must be int32 integers. */
  add(x: number, y: number, z: number): boolean {
    if ((this.n + 1) * 2 > this.used.length) this.rehash(this.used.length * 2);
    const { xs, ys, zs, used, mask } = this;
    let i = hashCell(x, y, z) & mask;
    while (used[i] !== 0) {
      if (xs[i] === x && ys[i] === y && zs[i] === z) return false;
      i = (i + 1) & mask;
    }
    used[i] = 1;
    xs[i] = x;
    ys[i] = y;
    zs[i] = z;
    this.n++;
    return true;
  }

  clear(): void {
    this.used.fill(0);
    this.n = 0;
  }

  private rehash(cap: number): void {
    const { xs, ys, zs, used } = this;
    this.xs = new Int32Array(cap);
    this.ys = new Int32Array(cap);
    this.zs = new Int32Array(cap);
    this.used = new Uint8Array(cap);
    this.mask = cap - 1;
    this.n = 0;
    for (let i = 0; i < used.length; i++) {
      if (used[i] !== 0) this.add(xs[i]!, ys[i]!, zs[i]!);
    }
  }
}

// ------------------------------------------------------------ boxes

/** Is cell (x,y,z) inside the half-open bounds `b`? */
export function inBounds(b: CellBounds, x: number, y: number, z: number): boolean {
  return x >= b.minX && x < b.maxX && y >= b.minY && y < b.maxY && z >= b.minZ && z < b.maxZ;
}

/**
 * Cells in the smallest box holding the half-open bounds `b` (null = no cells) and cell
 * (x,y,z): the tight box of a structure after a block is added at (x,y,z). Compared with
 * STRUCTURE_MAX_BOX_CELLS; exact below 2^53, far beyond any limit above that.
 */
export function boxCellsWith(b: CellBounds | null, x: number, y: number, z: number): number {
  if (b === null) return 1;
  const sx = Math.max(b.maxX, x + 1) - Math.min(b.minX, x);
  const sy = Math.max(b.maxY, y + 1) - Math.min(b.minY, y);
  const sz = Math.max(b.maxZ, z + 1) - Math.min(b.minZ, z);
  return sx * sy * sz;
}

// ------------------------------------------------------------ results

/**
 * Why a collect failed. 'unloaded' (an extension of the contract list): the structure touches
 * a cell of an unloaded chunk, so it may continue there; `cells` holds the loaded part only.
 * 'too_spread': the tight box of the cells found so far holds more than maxBoxCells cells
 * (DESIGN 组装与方块化: the structure is spread over too large an area).
 * 'too_big' and 'too_spread' stop the fill, so they exclude each other: the reason is the limit
 * the fill broke first. Either beats 'unloaded', which beats 'not_enough_sails'.
 */
export type CollectReason =
  | 'ok'
  | 'not_a_helm'
  | 'not_a_bearing'
  | 'no_hub'
  | 'too_big'
  | 'too_spread'
  | 'not_enough_sails'
  | 'unloaded';

export interface CollectResult {
  ok: boolean;
  reason: CollectReason;
  /**
   * x,y,z triples in BFS order, start cell first; exactly `count` triples. When too_big, the
   * fill stopped as soon as it found cell number maxCells + 1, so it holds maxCells + 1 cells;
   * when too_spread, it stopped at the first cell that took the box past maxBoxCells (included).
   * When unloaded, it holds every connected cell that is loaded.
   */
  cells: Int32Array;
  count: number;
  /** Cells whose BlockDef.sail is true (among `cells`). */
  sails: number;
  /** Half-open bounds of `cells` (grid-local), null when `cells` is empty. */
  bounds: CellBounds | null;
}

function failure(reason: CollectReason): CollectResult {
  return { ok: false, reason, cells: new Int32Array(0), count: 0, sails: 0, bounds: null };
}

/**
 * Validates a limit: Infinity is allowed (no limit); NaN and negatives throw a RangeError.
 * The limits are compared exactly as the contract words them — 'too_big' when count >
 * maxCells, 'not_enough_sails' when sails < minSails — so with integer counts a fractional
 * maxCells behaves like its floor and a fractional minSails like its ceiling (3 sails ARE
 * fewer than 3.5). Returns floor(v): for maxCells that gives the same verdict (count > v
 * exactly when count > floor(v)) and is what the queue is sized from; minSails is used as given.
 */
function checkLimit(name: string, v: number): number {
  if (!(v >= 0)) throw new RangeError(`${name} must be >= 0, got ${v}`);
  return Math.floor(v);
}

const UNLOADED_ID = CELL_UNLOADED & ID_MASK;

// ------------------------------------------------------------ flood fill

interface Fill {
  cells: Int32Array;
  count: number;
  sails: number;
  bounds: CellBounds;
  tooBig: boolean;
  /** The tight box of the cells found grew past maxBoxCells (the fill stopped there). */
  tooSpread: boolean;
  /** A neighbour the fill had to examine lies in an unloaded chunk. */
  unloaded: boolean;
}

const INITIAL_CAPACITY = 256;

/**
 * Growable FIFO of cells that doubles as the result list: entries are never removed, the
 * fill just advances a read index over them. Holds at most `limit` cells.
 */
class FillQueue {
  xyz: Int32Array;
  /** Packed cells (blocks/cell.ts: both parts). */
  values: Float64Array;
  n = 0;
  private cap: number;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
    // Start small so tiny structures stay cheap; grows by doubling up to the limit.
    this.cap = Math.min(limit, INITIAL_CAPACITY);
    this.xyz = new Int32Array(this.cap * 3);
    this.values = new Float64Array(this.cap);
  }

  push(x: number, y: number, z: number, cell: number): void {
    if (this.n === this.cap) this.grow();
    const i = this.n * 3;
    this.xyz[i] = x;
    this.xyz[i + 1] = y;
    this.xyz[i + 2] = z;
    this.values[this.n++] = cell;
  }

  private grow(): void {
    this.cap = Math.min(this.limit, this.cap * 2);
    const q = new Int32Array(this.cap * 3);
    q.set(this.xyz);
    this.xyz = q;
    const v = new Float64Array(this.cap);
    v.set(this.values);
    this.values = v;
  }
}

/**
 * BFS from (sx,sy,sz) (cell value `start`, already validated) across connected faces.
 * halfAxis >= 0 restricts the fill to cells whose coordinate along that axis is strictly
 * beyond `plane` in direction `sign` (the rotor half-space). excludeFunc rejects functional
 * blocks (rotors). Stops as soon as more than maxCells cells were found, or as soon as the
 * tight box of the cells found holds more than maxBoxCells cells. The box is kept as cells are
 * pushed, so the box test costs a few comparisons per collected cell and a multiplication only
 * when the box grows; a thin frame spanning millions of cells is refused after visiting at most
 * as many cells as its arms have, before anything proportional to its box is allocated.
 *
 * `unloaded` is set when any neighbour the fill examines (inside the half-space) reads as
 * CELL_UNLOADED. Its content is unknown, so it may well belong to the structure (it could be
 * glued to, stick to or be mounted on the collected cell next to it); the flag does not try to
 * rule that out. Conversely, when it stays false and the fill was not cut short, every
 * neighbour of every collected cell was read, so the result is the complete structure.
 */
function flood(
  grid: VoxelGrid,
  glue: GlueStore,
  sx: number,
  sy: number,
  sz: number,
  start: number,
  maxCells: number,
  maxBoxCells: number,
  halfAxis: number,
  plane: number,
  sign: number,
  excludeFunc: boolean,
): Fill {
  const q = new FillQueue(maxCells + 1);
  const visited = new CellSet(Math.min(maxCells + 1, INITIAL_CAPACITY));
  q.push(sx, sy, sz, start < CELL_MULTI_BIT ? start : start + grid.getPart2(sx, sy, sz) * PACK_SCALE);
  visited.add(sx, sy, sz);
  let tooBig = maxCells < 1;
  let tooSpread = maxBoxCells < 1;
  let unloaded = false;
  let sails = 0;
  let minX = sx;
  let minY = sy;
  let minZ = sz;
  let maxX = sx;
  let maxY = sy;
  let maxZ = sz;

  let head = 0;
  fill: while (head < q.n && !tooBig && !tooSpread) {
    const xyz = q.xyz;
    const x = xyz[head * 3]!;
    const y = xyz[head * 3 + 1]!;
    const z = xyz[head * 3 + 2]!;
    const cell = q.values[head]!;
    head++;
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR_X[d]!;
      const ny = y + DIR_Y[d]!;
      const nz = z + DIR_Z[d]!;
      if (halfAxis >= 0) {
        const v = halfAxis === 0 ? nx : halfAxis === 1 ? ny : nz;
        if ((v - plane) * sign <= 0) continue;
      }
      const nc = grid.getCell(nx, ny, nz);
      // Cheap rejections first: most neighbours are air or already collected.
      if (!canJoinStructure(nc)) {
        if ((nc & ID_MASK) === UNLOADED_ID) unloaded = true;
        continue;
      }
      if (excludeFunc && isFunctionalCell(nc)) continue;
      if (visited.has(nx, ny, nz)) continue;
      // The queue keeps packed cells (both parts); a two-part cell's second part is read only here.
      const np = nc < CELL_MULTI_BIT ? nc : nc + grid.getPart2(nx, ny, nz) * PACK_SCALE;
      if (!connectedCells(cell, np, d as Dir, glue, x, y, z)) continue;
      q.push(nx, ny, nz, np);
      visited.add(nx, ny, nz);
      // A neighbour differs from its cell in one coordinate by one, so it grows the box by at
      // most one layer; only then can the volume have changed.
      let grew = true;
      if (nx < minX) minX = nx;
      else if (nx > maxX) maxX = nx;
      else if (ny < minY) minY = ny;
      else if (ny > maxY) maxY = ny;
      else if (nz < minZ) minZ = nz;
      else if (nz > maxZ) maxZ = nz;
      else grew = false;
      // Keep the first cell over a limit so callers can tell "exactly at" from "over". The
      // count is tested first, so a cell that breaks both limits is 'too_big'.
      if (q.n > maxCells) {
        tooBig = true;
        break fill;
      }
      // Exact below 2^53; above that it is far beyond any limit anyway.
      if (grew && (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1) > maxBoxCells) {
        tooSpread = true;
        break fill;
      }
    }
  }

  const n = q.n;
  const xyz = q.xyz;
  const values = q.values;
  for (let i = 0; i < n; i++) if (isSailCell(values[i]!)) sails++;

  return {
    cells: xyz.length === n * 3 ? xyz : xyz.slice(0, n * 3),
    count: n,
    sails,
    bounds: { minX, minY, minZ, maxX: maxX + 1, maxY: maxY + 1, maxZ: maxZ + 1 },
    tooBig,
    tooSpread,
    unloaded,
  };
}

// ------------------------------------------------------------ public queries

/**
 * Cells a helm at (hx,hy,hz) would assemble into a ship: BFS from the helm across connected()
 * faces. Functional blocks reached through their mounting faces (other helms, bearings,
 * propellers, torches) are part of the ship. Blocks in front of a bearing (a stopped windmill)
 * come along only when the rules reach them, e.g. through glue between the bearing and its hub.
 *
 * Reasons: 'not_a_helm' (start cell is not a helm), 'too_big' (more than maxCells cells),
 * 'too_spread' (a tight box of more than maxBoxCells cells), 'unloaded' (the ship touches an
 * unloaded chunk; `cells` is its loaded part).
 */
export function collectShip(
  grid: VoxelGrid,
  glue: GlueStore,
  hx: number,
  hy: number,
  hz: number,
  maxCells: number = SHIP_MAX_CELLS,
  maxBoxCells: number = STRUCTURE_MAX_BOX_CELLS,
): CollectResult {
  maxCells = checkLimit('maxCells', maxCells);
  maxBoxCells = checkLimit('maxBoxCells', maxBoxCells);
  const start = grid.getCell(hx, hy, hz);
  if (cellFunc(start) !== 'helm') return failure('not_a_helm');
  const f = flood(grid, glue, hx, hy, hz, start, maxCells, maxBoxCells, -1, 0, 0, false);
  const reason: CollectReason = f.tooBig ? 'too_big' : f.tooSpread ? 'too_spread' : f.unloaded ? 'unloaded' : 'ok';
  return {
    ok: reason === 'ok',
    reason,
    cells: f.cells,
    count: f.count,
    sails: f.sails,
    bounds: f.bounds,
  };
}

/**
 * Cells a bearing at (bx,by,bz) would spin as a rotor. The hub is the cell directly in front
 * of the bearing (its facing); the BFS starts there and is restricted to cells strictly in
 * front of the bearing's plane (转子范围：只收轴承所在平面前方的格子). The bearing itself and
 * every functional block (helm, bearing, propeller) are never included and stop the fill.
 *
 * Reasons: 'not_a_bearing'; 'no_hub' (the hub cannot join a structure, or is functional);
 * 'too_big' (more than maxCells cells); 'too_spread' (a tight box of more than maxBoxCells
 * cells); 'unloaded' (the hub, or a cell the rotor touches,
 * lies in an unloaded chunk; checked before the sails, which may be in the missing part);
 * 'not_enough_sails' (fewer than minSails sail cells, compared as given: 3 < 3.5).
 * For 'not_enough_sails' `cells` holds the complete rotor, so the preview can still show it.
 */
export function collectRotor(
  grid: VoxelGrid,
  glue: GlueStore,
  bx: number,
  by: number,
  bz: number,
  maxCells: number = ROTOR_MAX_CELLS,
  minSails: number = ROTOR_MIN_SAILS,
  maxBoxCells: number = STRUCTURE_MAX_BOX_CELLS,
): CollectResult {
  maxCells = checkLimit('maxCells', maxCells);
  maxBoxCells = checkLimit('maxBoxCells', maxBoxCells);
  checkLimit('minSails', minSails); // validated only: compared as given (see checkLimit)
  const bearing = grid.getCell(bx, by, bz);
  if (cellFunc(bearing) !== 'bearing') return failure('not_a_bearing');
  const facing = stateFacing(cellState(bearing));
  const hx = bx + DIR_X[facing]!;
  const hy = by + DIR_Y[facing]!;
  const hz = bz + DIR_Z[facing]!;
  const hub = grid.getCell(hx, hy, hz);
  if ((hub & ID_MASK) === UNLOADED_ID) return failure('unloaded'); // a hub may well be there
  if (!canJoinStructure(hub) || isFunctionalCell(hub)) return failure('no_hub');
  const axis = facing >> 1;
  const plane = axis === 0 ? bx : axis === 1 ? by : bz;
  const f = flood(grid, glue, hx, hy, hz, hub, maxCells, maxBoxCells, axis, plane, dirSign(facing), true);
  const reason: CollectReason = f.tooBig
    ? 'too_big'
    : f.tooSpread
      ? 'too_spread'
      : f.unloaded
        ? 'unloaded'
        : f.sails < minSails
          ? 'not_enough_sails'
          : 'ok';
  return {
    ok: reason === 'ok',
    reason,
    cells: f.cells,
    count: f.count,
    sails: f.sails,
    bounds: f.bounds,
  };
}
