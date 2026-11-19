/**
 * Cell-level operations of the structure life cycle (docs/DESIGN.md "组装与方块化",
 * docs/LESSONS.md "组装、方块化与胶水"):
 *
 *  - moving collected cells out of a grid into a new structure (copy all, then clear all),
 *  - refilling water where a hull left the sea (DESIGN "水的处理"),
 *  - snapping a structure back onto a grid with one of the 24 grid rotations (blockify),
 *    including the hard / soft destination rules and drops,
 *  - docking a ship into the world and re-mounting its rotors.
 *
 * These functions know nothing about the StructureManager's registry, indexes or hooks; the
 * manager calls them in the order that keeps its bookkeeping consistent (re-parent before
 * clearing, unregister before blockifying, ...). Every bulk write uses MOVE_FLAGS: neighbours
 * are re-evaluated afterwards through StructureHost.blockUpdate. The grids' glue hooks apply
 * the lifetime rule to these writes too, so glue moves in the order GlueStore.moveTo describes:
 * destination cells, moveTo, source cells cleared, the destination's glue rules.
 *
 * STRUCTURE MOVES NEVER CREATE GLUE JOINTS. Glue joins two blocks only when a player places a
 * block against a glued face, or when both blocks travel together. Blockify and dock write
 * structure cells into a grid that already holds blocks, so afterwards every face between a
 * written cell and a neighbour the move did not write loses its glue when that neighbour could
 * hold glue (settlePlacedGlue), whether the glue came with the structure or was already there.
 * The one exception is the glue already on the face between a stopping rotor's bearing and the
 * cell in front of it (the hub's place), so the hub and the bearing stay glued across a start
 * and a stop.
 */
import { AIR, cellState, ID_MASK, isLiquidSource, liquidState, makeCell } from '../blocks/cell';
import { B } from '../blocks/defs';
import { BLOCKS, isLiquidCell, isSolidCell, type DropSpec } from '../blocks/registry';
import { STRUCTURE_MAX_BOX_CELLS, WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, NX, NZ, PX, PY, PZ, type Dir } from '../core/dirs';
import { qmul, vclone, vec3, vset, type Quat, type Vec3 } from '../core/math';
import { SET_NO_NEIGHBOR_UPDATE, SET_STRUCTURE_MOVE, type CellBounds, type VoxelGrid } from '../voxel/grid';
import type { StructureGrid } from '../voxel/sgrid';
import type { World } from '../voxel/world';
import { boxCellsWith, CellSet, inBounds } from './collect';
import type { GlueStore } from './glue';
import { HULL_BILGE, HULL_SEALED, isDryCell, type HullInfo } from './hull';
import { nearestRot, rotCell, rotCellPos, rotToQuat, rotVec, type GridRot } from './orient';
import { applyRotorPose } from './rotor';
import { holdsGlue, pruneGlueAt } from './stick';
import type { Rotor, Ship, StructureHost } from './structure';

/** Flags of every bulk write made while assembling, blockifying or docking. */
export const MOVE_FLAGS = SET_STRUCTURE_MOVE | SET_NO_NEIGHBOR_UPDATE;

const WATER_ID = B.WATER;
const WATER_SOURCE = makeCell(B.WATER, liquidState(0, false));

/** Outcome counters of a blockify / dock. */
export interface BlockifyReport {
  /** Structure cells written into the destination grid. */
  placed: number;
  /** Structure cells that hit a hard block and became drops (or vanished when drops are off). */
  dropped: number;
  /** Soft destination blocks (plants, torches, snow cover, liquids) replaced. */
  overwritten: number;
}

export function emptyReport(): BlockifyReport {
  return { placed: 0, dropped: 0, overwritten: 0 };
}

/** What a displaced cell yields (BlockDef.drop; undefined = the block itself). null = nothing. */
export function dropOf(cell: number): DropSpec | null {
  const def = BLOCKS[cell & ID_MASK];
  if (!def || def.drop === null) return null;
  return def.drop ?? { item: def.id, count: 1 };
}

/** Spawn the drop of `cell` centred on cell (x,y,z) of `grid`. Nothing when the world's drops are off. */
function spawnCellDrop(host: StructureHost, grid: VoxelGrid, x: number, y: number, z: number, cell: number, tmp: Vec3): void {
  if (!host.dropsEnabled) return;
  const d = dropOf(cell);
  if (!d || d.count <= 0) return;
  grid.toWorld(vset(tmp, x + 0.5, y + 0.5, z + 0.5), tmp);
  host.spawnDrop(tmp.x, tmp.y, tmp.z, d.item, d.count);
}

/**
 * Can nothing of a structure be placed at this cell of `grid`? HARD blocks (the 'unloaded'
 * sentinel and the deeprock below y = 0 included) and, for the world, cells above the build
 * height, where World.setCell cannot write.
 */
export function isHardDestination(grid: VoxelGrid, x: number, y: number, z: number): boolean {
  if (grid.isWorld && y >= WORLD_HEIGHT) return true;
  return isSolidCell(grid.getCell(x, y, z));
}

// ------------------------------------------------------------ moving cells out

/**
 * Move collected cells (x,y,z triples, as in CollectResult) from `src` into the structure
 * grid `dst`, keeping their coordinates, and their glue from `srcGlue` into `dstGlue`. Every
 * cell is copied first and only then are all of them cleared from `src`: a torch must not see
 * its base leave before it left itself. A glued face between a moved cell and a glueable block
 * that stays behind stays in `srcGlue` (DESIGN 强力胶; e.g. the hub of a rotor and its bearing).
 */
export function transferCells(
  src: VoxelGrid,
  srcGlue: GlueStore,
  dst: StructureGrid,
  dstGlue: GlueStore,
  cells: Int32Array,
  count: number,
  bounds: CellBounds | null,
): void {
  if (bounds && dst.count === 0) {
    // One allocation instead of repeated growth while copying.
    dst.resize(bounds.minX, bounds.minY, bounds.minZ, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  }
  for (let i = 0; i < count; i++) {
    const x = cells[i * 3]!;
    const y = cells[i * 3 + 1]!;
    const z = cells[i * 3 + 2]!;
    dst.setCell(x, y, z, src.getCell(x, y, z), SET_STRUCTURE_MOVE);
  }
  if (srcGlue.size > 0) {
    const inSet = CellSet.fromCells(cells, count);
    srcGlue.moveTo(dstGlue, (x, y, z) => inSet.has(x, y, z), identityMap(), (x, y, z) => holdsGlue(src.getCell(x, y, z)));
  }
  for (let i = 0; i < count; i++) src.setCell(cells[i * 3]!, cells[i * 3 + 1]!, cells[i * 3 + 2]!, AIR, MOVE_FLAGS);
  pruneGlueAround(dst, dstGlue, cells, count);
}

/** `{x,y,z} -> same {x,y,z}` mapping for GlueStore.moveTo (returns one reused object). */
export function identityMap(): (x: number, y: number, z: number) => Vec3 {
  const out = vec3();
  return (x, y, z) => vset(out, x, y, z);
}

/** The glue lifetime rule (pruneGlueAt) on every cell of a list (x,y,z triples) of `grid`. */
function pruneGlueAround(grid: VoxelGrid, glue: GlueStore, cells: Int32Array, count: number): void {
  for (let i = 0; i < count && glue.size > 0; i++) {
    const x = cells[i * 3]!;
    const y = cells[i * 3 + 1]!;
    const z = cells[i * 3 + 2]!;
    pruneGlueAt(grid, glue, x, y, z, grid.getCell(x, y, z));
  }
}

/** moveTo's `stays` for a source grid that is going away: no end cell stays behind. */
function nothingStays(): boolean {
  return false;
}

/** One face of a grid: the cell (x,y,z) and the direction towards the other end. */
export interface GridFace {
  x: number;
  y: number;
  z: number;
  dir: Dir;
}

/**
 * The glue rules on the destination of a blockify or dock, after the structure's cells were
 * written there (`placed`, x,y,z triples; `written` holds the same cells) and its glue was moved
 * there. For every glued face of a written cell P, with Q the cell across it:
 *  - Q written by the move too: the face travelled with both blocks; the lifetime rule applies
 *    (removed when neither side holdsGlue);
 *  - Q not written and holdsGlue(Q) (a glueable block, or an unloaded cell that may be one):
 *    removed, wherever the glue came from — a move never joins a structure block to a block it
 *    did not bring along (DESIGN 强力胶: 结构体移动不会产生新的胶连接) — unless the face is `keep`;
 *  - Q not written and not holdsGlue(Q): the lifetime rule (an exposed face on P stays when P
 *    holds glue).
 * `keep` is the bearing face of a stopping rotor when the destination store held its glue
 * before the move (see blockifyGrid), else null.
 */
function settlePlacedGlue(
  grid: VoxelGrid,
  glue: GlueStore,
  placed: Int32Array,
  count: number,
  written: CellSet,
  keep: GridFace | null,
): void {
  for (let i = 0; i < count && glue.size > 0; i++) {
    const x = placed[i * 3]!;
    const y = placed[i * 3 + 1]!;
    const z = placed[i * 3 + 2]!;
    const mask = glue.dirMaskAt(x, y, z);
    if (mask === 0) continue;
    const holdsP = holdsGlue(grid.getCell(x, y, z));
    for (let d = 0; d < 6; d++) {
      if ((mask & (1 << d)) === 0) continue;
      const qx = x + DIR_X[d]!;
      const qy = y + DIR_Y[d]!;
      const qz = z + DIR_Z[d]!;
      const holdsQ = holdsGlue(grid.getCell(qx, qy, qz));
      let remove: boolean;
      if (written.has(qx, qy, qz)) remove = !holdsP && !holdsQ;
      else if (holdsQ) remove = keep === null || !isFace(keep, x, y, z, d);
      else remove = !holdsP;
      if (remove) glue.remove(x, y, z, d as Dir);
    }
  }
}

/** Is the face of cell (x,y,z) towards `d` the face `f` (seen from either end)? */
function isFace(f: GridFace, x: number, y: number, z: number, d: number): boolean {
  if (f.x === x && f.y === y && f.z === z) return f.dir === d;
  return f.dir === (d ^ 1) && f.x === x + DIR_X[d]! && f.y === y + DIR_Y[d]! && f.z === z + DIR_Z[d]!;
}

// ------------------------------------------------------------ water

function isWaterSource(cell: number): boolean {
  return (cell & ID_MASK) === WATER_ID && isLiquidSource(cellState(cell));
}

/**
 * The game's own infinite-source condition (DESIGN 世界 "无限水源", liquid/fluids.ts): at
 * least two horizontally adjacent water sources, and a hard block or a water source below.
 */
function becomesSource(world: World, x: number, y: number, z: number): boolean {
  const below = world.getCell(x, y - 1, z);
  if (!isSolidCell(below) && !isWaterSource(below)) return false;
  let n = 0;
  if (isWaterSource(world.getCell(x + 1, y, z))) n++;
  if (isWaterSource(world.getCell(x - 1, y, z))) n++;
  if (n < 2 && isWaterSource(world.getCell(x, y, z + 1))) n++;
  if (n < 2 && isWaterSource(world.getCell(x, y, z - 1))) n++;
  return n >= 2;
}

/** Neighbours whose condition a new source can complete: the four horizontal ones and the cell above. */
const FEED_DIRS: readonly Dir[] = [PX, NX, PZ, NZ, PY];

/**
 * DESIGN "水的处理": after a structure left the world, the candidate cells (vacated cells,
 * plus the hull's bilge and sealed cells for a ship) close up again where they lie in a body
 * of water. A candidate that is AIR becomes a water source when it meets the infinite-source
 * condition (two horizontal sources, hard block or source below), counting sources created
 * here, repeated to a fixpoint. So the sea closes over the whole footprint and the flooded
 * cavities of a hull built at sea — a footprint surrounded by sources fills from its edges
 * inwards and from the bottom up to the sea level — while a dry dock stays dry, a puddle on a
 * deck is not multiplied into a sheet of sources, and no source is left hanging in the air
 * (the puddle simply flows down after the block updates). The result does not depend on the
 * order of the candidates. Returns the number of cells filled.
 */
export function refillWater(world: World, candidates: Int32Array, count: number): number {
  const set = new CellSet(count);
  const stack: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = candidates[i * 3]!;
    const y = candidates[i * 3 + 1]!;
    const z = candidates[i * 3 + 2]!;
    if (set.add(x, y, z)) stack.push(x, y, z);
  }
  let filled = 0;
  while (stack.length > 0) {
    const z = stack.pop()!;
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (world.getCell(x, y, z) !== AIR || !becomesSource(world, x, y, z)) continue;
    if (!world.setCell(x, y, z, WATER_SOURCE, MOVE_FLAGS)) continue;
    filled++;
    for (let k = 0; k < FEED_DIRS.length; k++) {
      const d = FEED_DIRS[k]!;
      const nx = x + DIR_X[d]!;
      const ny = y + DIR_Y[d]!;
      const nz = z + DIR_Z[d]!;
      if (set.has(nx, ny, nz) && world.getCell(nx, ny, nz) === AIR) stack.push(nx, ny, nz);
    }
  }
  return filled;
}

/** Bilge and sealed cells of a hull (x,y,z triples, local coordinates). */
export function hullCavityCells(hull: HullInfo): Int32Array {
  const n = hull.bilgeCount + hull.sealedCount;
  const out = new Int32Array(n * 3);
  const { sx, sz, kind } = hull;
  const layer = sx * sz;
  let o = 0;
  for (let i = 0; i < kind.length && o < out.length; i++) {
    const k = kind[i]!;
    if (k !== HULL_BILGE && k !== HULL_SEALED) continue;
    const y = Math.floor(i / layer);
    const rem = i - y * layer;
    const z = Math.floor(rem / sx);
    out[o++] = hull.ox + rem - z * sx;
    out[o++] = hull.oy + y;
    out[o++] = hull.oz + z;
  }
  return out;
}

// ------------------------------------------------------------ snapping

/**
 * Maps a structure's local cells onto a destination grid: rotate by `r` about `pivot`
 * (structure-local), then put the pivot at `target` (destination-grid local).
 */
export interface SnapTransform {
  readonly r: GridRot;
  readonly pivot: Vec3;
  readonly target: Vec3;
}

/** Destination cell of local cell (x,y,z). */
export function snapCell(t: SnapTransform, x: number, y: number, z: number, out: Vec3 = vec3()): Vec3 {
  return rotCellPos(t.r, x, y, z, t.pivot, t.target, out);
}

/** Destination-grid point of a structure-local point. `out` may alias `p`. */
export function snapPoint(t: SnapTransform, p: Vec3, out: Vec3 = vec3()): Vec3 {
  rotVec(t.r, p.x - t.pivot.x, p.y - t.pivot.y, p.z - t.pivot.z, out);
  out.x += t.target.x;
  out.y += t.target.y;
  out.z += t.target.z;
  return out;
}

/**
 * Snap of a rotor onto its parent grid: the nearest grid rotation, pivot kept where it is.
 * The pivot is the hub centre and sits on a cell centre of the parent, so cell centres land
 * on cell centres.
 */
export function rotorSnap(grid: StructureGrid): SnapTransform {
  return { r: nearestRot(grid.rotation), pivot: vclone(grid.pivot), target: vclone(grid.position) };
}

/**
 * Snap of a ship onto the world (DESIGN "主动停靠"): the nearest grid rotation, and the
 * translation closest to the current one that puts every cell centre on a world cell centre.
 *
 * Under a grid rotation r, centre(c) = rotVec(r, c) + rotVec(r, 0.5 - pivot) + T where the
 * first term is an integer vector, so all cells share the fractional offset of
 * u = rotVec(r, 0.5 - pivot) + T - 0.5; shifting T by -(u - round(u)) makes it integral.
 */
export function dockSnap(grid: StructureGrid): SnapTransform {
  const r = nearestRot(grid.rotation);
  const p = grid.pivot;
  const P = grid.position;
  const off = rotVec(r, 0.5 - p.x, 0.5 - p.y, 0.5 - p.z);
  const ux = off.x + P.x - 0.5;
  const uy = off.y + P.y - 0.5;
  const uz = off.z + P.z - 0.5;
  const target = vec3(P.x - (ux - Math.round(ux)), P.y - (uy - Math.round(uy)), P.z - (uz - Math.round(uz)));
  return { r, pivot: vclone(p), target };
}

/** Maximum deviation of a docking ship's local +Y from world +Y (DESIGN: 倾斜超过 45° 拒绝). */
export const DOCK_MAX_TILT = Math.PI / 4;
const DOCK_MIN_UP = Math.cos(DOCK_MAX_TILT) - 1e-9;

/** True when local +Y rotated by `q` deviates more than DOCK_MAX_TILT from +Y. */
export function dockTilted(q: Quat): boolean {
  // y component of q * (0,1,0) = R[1][1]
  return 1 - 2 * (q.x * q.x + q.z * q.z) < DOCK_MIN_UP;
}

// ------------------------------------------------------------ blockify (rotor stop)

export interface BlockifyOutcome {
  report: BlockifyReport;
  /** Destination cells written, x,y,z triples in destination-grid coordinates (`report.placed` of them). */
  placed: Int32Array;
  /** The source cells that were placed (source-local coordinates). */
  placedSrc: CellSet;
}

/** Snapshot of a grid's non-air cells: coordinates and values. */
function gridCells(grid: StructureGrid): { xyz: Int32Array; cells: Uint16Array; n: number } {
  const n = grid.count;
  const xyz = new Int32Array(n * 3);
  const cells = new Uint16Array(n);
  let i = 0;
  grid.forEachCell((x, y, z, cell) => {
    xyz[i * 3] = x;
    xyz[i * 3 + 1] = y;
    xyz[i * 3 + 2] = z;
    cells[i] = cell;
    i++;
  });
  return { xyz, cells, n: i };
}

/**
 * Blockify `src` in place onto `dst` (DESIGN "方块化"): every cell goes to snapCell(t, ...)
 * with its block state rotated by t.r.
 *  - destination HARD: the cell is not placed; it becomes a drop there (if the world drops);
 *  - destination soft: overwritten; a replaced non-liquid, non-air block drops (if the world drops);
 *  - `inShip`: `dst` is a ship's grid, and a destination whose centre lies inside a HARD block
 *    of the WORLD is a hard conflict too (DESIGN "船上的转子"), so nothing ends up in rock and
 *    the ship is never pushed out of it;
 *  - `inShip`, box limit (DESIGN 组装与方块化: a structure's tight box holds at most
 *    STRUCTURE_MAX_BOX_CELLS cells): when the cells that would be placed would spread the ship's
 *    tight box past the limit, every one of them that lands outside the ship's current tight box
 *    is a hard conflict too (it drops). The ship's box then stays as it is. Which cells drop does
 *    not depend on their order, and nothing changes while the limit is not reached.
 * Every glued face with a placed end moves along (re-keyed by the rotation), then the glue rules
 * of settlePlacedGlue apply at the destination: no face joins a placed cell to a block that was
 * not placed with it, apart from `bearingFace` (the face between the rotor's bearing and the
 * cell in front of it, destination-grid coordinates), which keeps the glue `dstGlue` already
 * holds on it. Faces with no placed end stay in `srcGlue` (discarded with the structure). `src`
 * and `srcGlue` are read only, apart from the glue that moves.
 */
export function blockifyGrid(
  host: StructureHost,
  src: StructureGrid,
  srcGlue: GlueStore,
  dst: VoxelGrid,
  dstGlue: GlueStore,
  t: SnapTransform,
  inShip: boolean,
  bearingFace: GridFace | null,
): BlockifyOutcome {
  const report = emptyReport();
  const { xyz, cells, n } = gridCells(src);
  const placed = new Int32Array(n * 3);
  const placedSrc = new CellSet(n);
  const d = vec3();
  const tmp = vec3();
  const world = host.world;
  // Destinations and hard conflicts first: the box limit below depends on all of them. The
  // destinations are distinct, so a write never changes whether another destination is hard.
  const dest = new Int32Array(n * 3);
  const hardAt = new Uint8Array(n);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    snapCell(t, xyz[i * 3]!, xyz[i * 3 + 1]!, xyz[i * 3 + 2]!, d);
    dest[i * 3] = d.x;
    dest[i * 3 + 1] = d.y;
    dest[i * 3 + 2] = d.z;
    let hard = isHardDestination(dst, d.x, d.y, d.z);
    if (!hard && inShip) {
      // The cell is written into the ship, so only a HARD world block at its centre matters
      // (above the build height the world is air; unloaded chunks count as hard: unknown
      // terrain might be rock, and a frozen ship must not wake up inside it).
      dst.toWorld(vset(tmp, d.x + 0.5, d.y + 0.5, d.z + 0.5), tmp);
      hard = isSolidCell(world.getCell(Math.floor(tmp.x), Math.floor(tmp.y), Math.floor(tmp.z)));
    }
    if (hard) {
      hardAt[i] = 1;
      continue;
    }
    minX = Math.min(minX, d.x);
    minY = Math.min(minY, d.y);
    minZ = Math.min(minZ, d.z);
    maxX = Math.max(maxX, d.x);
    maxY = Math.max(maxY, d.y);
    maxZ = Math.max(maxZ, d.z);
  }
  if (inShip && minX <= maxX) {
    const shipBox = dst.cellBounds();
    if (boxCellsWith(grownBounds(shipBox, minX, minY, minZ), maxX, maxY, maxZ) > STRUCTURE_MAX_BOX_CELLS) {
      for (let i = 0; i < n; i++) {
        if (shipBox === null || !inBounds(shipBox, dest[i * 3]!, dest[i * 3 + 1]!, dest[i * 3 + 2]!)) hardAt[i] = 1;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3]!;
    const y = xyz[i * 3 + 1]!;
    const z = xyz[i * 3 + 2]!;
    const cell = cells[i]!;
    vset(d, dest[i * 3]!, dest[i * 3 + 1]!, dest[i * 3 + 2]!);
    if (hardAt[i] === 1) {
      report.dropped++;
      spawnCellDrop(host, dst, d.x, d.y, d.z, cell, tmp);
      continue;
    }
    const prev = dst.getCell(d.x, d.y, d.z);
    if (prev !== AIR) {
      report.overwritten++;
      if (!isLiquidCell(prev)) spawnCellDrop(host, dst, d.x, d.y, d.z, prev, tmp);
    }
    dst.setCell(d.x, d.y, d.z, rotCell(t.r, cell), MOVE_FLAGS);
    const o = report.placed * 3;
    placed[o] = d.x;
    placed[o + 1] = d.y;
    placed[o + 2] = d.z;
    report.placed++;
    placedSrc.add(x, y, z);
  }
  // Decided before the move: glue arriving with the rotor's cells on that face is not exempt.
  const keep = bearingFace !== null && dstGlue.has(bearingFace.x, bearingFace.y, bearingFace.z, bearingFace.dir) ? bearingFace : null;
  const map = (x: number, y: number, z: number): Vec3 => snapCell(t, x, y, z, d);
  srcGlue.moveTo(dstGlue, (x, y, z) => placedSrc.has(x, y, z), map, nothingStays);
  settlePlacedGlue(dst, dstGlue, placed, report.placed, CellSet.fromCells(placed, report.placed), keep);
  return { report, placed: report.placed * 3 === placed.length ? placed : placed.slice(0, report.placed * 3), placedSrc };
}

/** `b` (null = empty) grown to contain cell (x,y,z). */
function grownBounds(b: CellBounds | null, x: number, y: number, z: number): CellBounds {
  if (b === null) return { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 };
  return {
    minX: Math.min(b.minX, x),
    minY: Math.min(b.minY, y),
    minZ: Math.min(b.minZ, z),
    maxX: Math.max(b.maxX, x + 1),
    maxY: Math.max(b.maxY, y + 1),
    maxZ: Math.max(b.maxZ, z + 1),
  };
}

// ------------------------------------------------------------ docking

export interface DockPlan {
  /** Rejected because the ship leans more than DOCK_MAX_TILT (nothing else was evaluated). */
  readonly tilted: boolean;
  readonly t: SnapTransform;
  /** WORLD cells holding a hard block where a ship cell would land (empty when tilted). */
  readonly conflicts: Array<{ x: number; y: number; z: number }>;
  /** Ship cells that would be placed. */
  readonly placed: number;
  /** Soft world blocks that would be overwritten. */
  readonly overwritten: number;
}

/** Evaluate docking `grid` (a ship's) into `world` without changing anything. */
export function planDock(world: World, grid: StructureGrid): DockPlan {
  const t = dockSnap(grid);
  const conflicts: Array<{ x: number; y: number; z: number }> = [];
  if (dockTilted(grid.rotation)) return { tilted: true, t, conflicts, placed: 0, overwritten: 0 };
  let placed = 0;
  let overwritten = 0;
  const d = vec3();
  grid.forEachCell((x, y, z) => {
    snapCell(t, x, y, z, d);
    if (isHardDestination(world, d.x, d.y, d.z)) {
      conflicts.push({ x: d.x, y: d.y, z: d.z });
      return;
    }
    placed++;
    if (world.getCell(d.x, d.y, d.z) !== AIR) overwritten++;
  });
  return { tilted: false, t, conflicts, placed, overwritten };
}

export interface DockOutcome {
  report: BlockifyReport;
  /** World cells written (ship cells) and cleared (liquid in dry hull cells), x,y,z triples. */
  touched: Int32Array;
}

/**
 * Write a ship's cells into the world with transform `t` (the caller has checked that no
 * destination is hard; should one have become hard since, that cell drops like a rotor cell
 * would). Overwritten soft non-liquid blocks drop (if the world drops); liquids at the
 * destinations of the hull's dry cells are removed (DESIGN: 方块化时，清掉密封舱位置里的液体);
 * the ship's glue moves to the world like a rotor's on blockify: every face with a placed end,
 * re-keyed by the rotation, then the glue rules of settlePlacedGlue where it landed (no face
 * joins a ship cell to a world block the ship did not bring); faces with no placed end stay in
 * the ship's store. The ship's own grid and pose are left untouched, apart from the
 * glue that moves.
 */
export function commitDock(host: StructureHost, ship: Ship, t: SnapTransform, hull: HullInfo | null): DockOutcome {
  const world = host.world;
  const worldGlue = host.worldGlue;
  const grid = ship.grid;
  const report = emptyReport();
  const { xyz, cells, n } = gridCells(grid);
  const touched: number[] = [];
  const placed = new Int32Array(n * 3);
  const written = new CellSet(n);
  const placedSrc = new CellSet(n);
  const d = vec3();
  const tmp = vec3();
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3]!;
    const y = xyz[i * 3 + 1]!;
    const z = xyz[i * 3 + 2]!;
    snapCell(t, x, y, z, d);
    const cell = cells[i]!;
    if (isHardDestination(world, d.x, d.y, d.z)) {
      report.dropped++;
      spawnCellDrop(host, world, d.x, d.y, d.z, cell, tmp);
      continue;
    }
    const prev = world.getCell(d.x, d.y, d.z);
    if (prev !== AIR) {
      report.overwritten++;
      if (!isLiquidCell(prev)) spawnCellDrop(host, world, d.x, d.y, d.z, prev, tmp);
    }
    world.setCell(d.x, d.y, d.z, rotCell(t.r, cell), MOVE_FLAGS);
    placed[report.placed * 3] = d.x;
    placed[report.placed * 3 + 1] = d.y;
    placed[report.placed * 3 + 2] = d.z;
    report.placed++;
    touched.push(d.x, d.y, d.z);
    written.add(d.x, d.y, d.z);
    placedSrc.add(x, y, z);
  }
  if (hull) {
    const { ox, oy, oz, sx, sy, sz } = hull;
    for (let y = oy; y < oy + sy; y++) {
      for (let z = oz; z < oz + sz; z++) {
        for (let x = ox; x < ox + sx; x++) {
          if (!isDryCell(hull, x, y, z) || grid.getCell(x, y, z) !== AIR) continue;
          snapCell(t, x, y, z, d);
          if (!isLiquidCell(world.getCell(d.x, d.y, d.z))) continue;
          if (world.setCell(d.x, d.y, d.z, AIR, MOVE_FLAGS)) touched.push(d.x, d.y, d.z);
        }
      }
    }
  }
  ship.glue.moveTo(worldGlue, (x, y, z) => placedSrc.has(x, y, z), (x, y, z) => snapCell(t, x, y, z, d), nothingStays);
  settlePlacedGlue(world, worldGlue, placed, report.placed, written, null);
  return { report, touched: Int32Array.from(touched) };
}

/**
 * Re-mount a running rotor whose parent grid is being re-gridded by `t` (its ship docked):
 * the rotor keeps spinning, now hanging on `parent` (DESIGN / ACCEPTANCE 8: 船上的风车改挂到世界).
 * The bearing cell and the pivot position are mapped, the base orientation is pre-rotated,
 * and the pose is made immediate (no interpolation streak across the re-gridding).
 */
export function remountRotor(rotor: Rotor, t: SnapTransform, parent: VoxelGrid): void {
  const g = rotor.grid;
  const b = snapCell(t, rotor.bearingX, rotor.bearingY, rotor.bearingZ);
  rotor.bearingX = b.x;
  rotor.bearingY = b.y;
  rotor.bearingZ = b.z;
  const pos = snapPoint(t, g.position);
  qmul(rotToQuat(t.r), rotor.baseRotation, rotor.baseRotation);
  g.parent = parent;
  applyRotorPose(rotor, !rotor.frozen);
  g.setPoseImmediate(pos, g.rotation);
}
