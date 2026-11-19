/**
 * Connectivity rules: which two ADJACENT cells belong to the same structure
 * (docs/DESIGN.md "连接：组装时哪些方块算一体"; acceptance 1–3), and the lifetime of glue
 * (DESIGN 强力胶; docs/SHAPES.md section 10).
 *
 * Two neighbouring cells are connected when both may join a structure and at least one of
 *  - they auto-stick (same stick group, see BlockDef.stick),
 *  - one is a functional block standing on / backed by the other (its mounting face),
 *  - the face between them is glued
 * holds. The flood fills in collect.ts walk exactly this relation.
 *
 * SHAPES (docs/SHAPES.md 10.1, 10.2). A cell holds up to two parts (blocks/cell.ts); sticking and
 * glue work per CELL — the parts of one cell are always one unit — but two cells only connect
 * where they TOUCH: the hard material of both covers a common quadrant of the shared face
 * (blocks/shapes.ts cellsTouch, the same table face culling uses). Every pair predicate takes
 * PACKED cells (voxel/parts.ts getPacked, forEachCell, the fill queue); when both are full blocks
 * (value < FULL_LIMIT) it runs the M1 code unchanged, so full-block structures behave exactly as
 * before. The contact predicates throw a RangeError on the tripwire value (CELL_MULTI_BIT without
 * a second part: a getCell value passed where a packed cell belongs, SHAPES 1.2); the per-id
 * predicates (canJoinStructure, canGlue, holdsGlue, isFunctionalCell, isSailCell, cellFunc) read
 * the first part's id only and accept anything.
 *
 * Hot paths (a 4000-cell flood fill tests ~24k faces) read flat per-id tables built once
 * from the block registry when this module is evaluated. defs.ts is the only module that
 * registers blocks and it is imported first, so the tables cover the whole block table.
 * The tables are never written after that (immutable lookup data, not module state).
 */
import { CELL_LIMIT, CELL_MULTI_BIT, cellState, FULL_LIMIT, HOLES_SHIFT, ID_MASK, MAX_BLOCK_ID, PACK_SCALE, PART_MASK, stateAxis, stateFacing } from '../blocks/cell';
import { B } from '../blocks/defs';
import { BLOCKS, type FuncKind } from '../blocks/registry';
import { cellsTouch, faceCover, FILL_VOLUME, solidCover } from '../blocks/shapes';
import { DIR_X, DIR_Y, DIR_Z, NY, type Dir } from '../core/dirs';
import type { VoxelGrid } from '../voxel/grid';
import { getPacked } from '../voxel/parts';
import type { GlueStore } from './glue';

// ------------------------------------------------------------ lookup tables

// Auto-stick group codes. 0 is also used for blocks that cannot join a structure at all, so
// a single table read rejects air, liquids and unbreakable blocks.
const G_NONE = 0;
const G_CLOTH = 1;
const G_PLANKS = 2;
const G_SELF = 3;
const G_LOG = 4;

const M_NONE = 0;
const M_BELOW = 1;
const M_BACK = 2;

/** May be part of a structure (not air, not a liquid, breakable, registered). */
const F_JOIN = 1;
/** May carry glue: joinable and HARD. */
const F_GLUE = 2;
/** Valid mounting surface for a functional block: HARD and breakable (terrain included). */
const F_MOUNT_FACE = 4;
/** Counts as a sail (wool, canvas). */
const F_SAIL = 8;
/** Functional block (helm, bearing, propeller): never part of a rotor. */
const F_FUNC = 16;

const UNLOADED_ID = B.UNLOADED;
const TABLE_SIZE = MAX_BLOCK_ID + 1;
const STICK = new Uint8Array(TABLE_SIZE);
const MOUNT = new Uint8Array(TABLE_SIZE);
const FLAGS = new Uint8Array(TABLE_SIZE);

for (let id = 0; id < TABLE_SIZE; id++) {
  const def = BLOCKS[id];
  // Unregistered ids (corrupt data) behave like air: they never join anything.
  if (!def || id === 0 || def.liquid !== 0 || def.unbreakable) continue;
  let flags = F_JOIN;
  if (def.solid) flags |= F_GLUE | F_MOUNT_FACE;
  if (def.sail) flags |= F_SAIL;
  if (def.func !== 'none') flags |= F_FUNC;
  FLAGS[id] = flags;
  STICK[id] =
    def.stick === 'cloth'
      ? G_CLOTH
      : def.stick === 'planks'
        ? G_PLANKS
        : def.stick === 'self'
          ? G_SELF
          : def.stick === 'log'
            ? G_LOG
            : G_NONE;
  MOUNT[id] = def.mount === 'below' ? M_BELOW : def.mount === 'back' ? M_BACK : M_NONE;
}

// ------------------------------------------------------------ packed-cell helpers

/**
 * RangeError on the tripwire value: CELL_MULTI_BIT set and no second part (a value in
 * [2^24, 2^25)), i.e. a getCell value where a packed cell belongs (docs/SHAPES.md 1.2).
 */
function tripwire(c: number): void {
  if (c >= CELL_MULTI_BIT && c < CELL_LIMIT) {
    throw new RangeError(`cell ${c} has CELL_MULTI_BIT but no second part (pass packed cells: getPacked, not getCell)`);
  }
}

/** First part of a packed cell (0 for air). Bitwise ops read the low 32 bits, which hold it. */
function firstPart(c: number): number {
  return c & PART_MASK;
}

/** Second part of a packed cell (0 when there is none). */
function secondPart(c: number): number {
  return c < PACK_SCALE ? 0 : Math.floor(c / PACK_SCALE);
}

/** Octants a part value occupies (a full block: 0xff). */
function partFill(p: number): number {
  return ~(p >>> HOLES_SHIFT) & 0xff;
}

// ------------------------------------------------------------ per-cell predicates

/**
 * May this cell be part of a structure at all? False for air, liquids and unbreakable blocks
 * (deeprock, the 'unloaded' sentinel). Plants and torches CAN join (a torch joins through its
 * mounting face; a plant has no way to connect, so in practice it stays in the world). Reads the
 * first part's id: both parts of a two-part cell are cuttable materials, which always may join.
 */
export function canJoinStructure(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_JOIN) !== 0;
}

/**
 * May glue be applied to this cell? False for air, liquids, unbreakable blocks and every
 * non-HARD block (torch, plants, snow cover). By the first part's id (a cell with parts has
 * only cuttable, hence glueable, materials).
 */
export function canGlue(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_GLUE) !== 0;
}

/**
 * Is this a cell that keeps glue alive, whatever its shape: a glueable block, or the world's
 * 'unloaded' sentinel (terrain that is not loaded is unknown, and glue must not be lost at the
 * edge of the loaded area)? Reads the first part's id. Whether the cell is actually ON a given
 * face is glueSideAt.
 */
export function holdsGlue(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_GLUE) !== 0 || (cell & ID_MASK) === UNLOADED_ID;
}

/**
 * Is the (packed) cell "on" face `dir` for the glue there: holdsGlue(c) and its hard material
 * covers at least one quadrant of that face (docs/SHAPES.md 10.2)? A cell whose material lies
 * only away from the face (a slab on the far half) is like air for that face. The unloaded
 * sentinel counts as a full block (true); a full glueable block is on all six faces.
 */
export function glueSideAt(c: number, dir: Dir): boolean {
  if (c < FULL_LIMIT) return holdsGlue(c);
  tripwire(c);
  return holdsGlue(c) && solidCover(c, dir) !== 0;
}

/**
 * The glue on the face between `a` and its neighbour `b` in `dirAtoB` may stay (the "state" rule
 * of docs/SHAPES.md 10.2): at least one side is still on that face. With full blocks only this is
 * the M1 rule (a glued face stays while either side is a glueable block).
 */
export function glueFaceKept(a: number, b: number, dirAtoB: Dir): boolean {
  return glueSideAt(a, dirAtoB) || glueSideAt(b, (dirAtoB ^ 1) as Dir);
}

/**
 * The glue lifetime rules at the cell (x,y,z) of `grid`, whose content just changed from
 * `oldPacked` to what the grid now holds (read here, never trusted from the caller). For every
 * glued face of the cell, with N the neighbour across it, the face loses its glue when
 *  1. (state) glueFaceKept(cell, N) is false: neither side is on the face any more; or
 *  2. (lost contact) the cell still holdsGlue, its OLD content touched N on that face and its new
 *     content does not (cellsTouch): the material that touched was chiselled away or removed
 *     with its part while the cell itself stayed (ACCEPTANCE 42). A cell that became air is not
 *     this case: then rule 1 keeps the glue on N's face (ACCEPTANCE 27).
 * Returns the number of faces removed. The grids' change hooks call it on every change in which
 * the old or the new content holds glue (a change between two contents that hold none, such as a
 * liquid level, cannot remove a face), with the listener's oldCell; a stale oldPacked (another
 * listener changed the cell first) can at worst skip rule 2 once. Assembly calls it with the
 * current content (rule 1 only).
 * Cost: one size check on an empty store; six lookups when the cell carries no glue; nothing
 * more when the cell is a full glueable block (both rules keep every face then).
 */
export function pruneGlueAt(grid: VoxelGrid, glue: GlueStore, x: number, y: number, z: number, oldPacked: number): number {
  if (glue.size === 0) return 0;
  const mask = glue.dirMaskAt(x, y, z);
  if (mask === 0) return 0;
  const cell = getPacked(grid, x, y, z);
  // A full glueable block is on every face (rule 1 keeps) and touches every neighbour its old
  // content touched (its cover is the whole face), so rule 2 cannot fire either.
  if (cell < FULL_LIMIT && holdsGlue(cell)) return 0;
  const holds = holdsGlue(cell);
  let n = 0;
  for (let d = 0; d < 6; d++) {
    if ((mask & (1 << d)) === 0) continue;
    const dir = d as Dir;
    const nb = getPacked(grid, x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!);
    const remove = !glueFaceKept(cell, nb, dir) || (holds && cellsTouch(oldPacked, nb, dir) && !cellsTouch(cell, nb, dir));
    if (remove && glue.remove(x, y, z, dir)) n++;
  }
  return n;
}

/**
 * The state rule of the glue lifetime (glueFaceKept) on every glued face of `grid` with at least
 * one end cell inside the box [x0..x1] x [y0..y1] x [z0..z1] (cell coordinates, inclusive): a face
 * with no side on it is removed (through the store, so its listeners hear of it). The world runs
 * it on a chunk when the chunk is added: glue kept beside an unloaded column, now that the
 * column's cells are known, may turn out to have no side on it at all. A face whose other side is
 * still unloaded is kept (the sentinel counts as a full glueable block). Only the state rule: no
 * change happened here, so no contact was lost. Returns the number of faces removed.
 * Costs one size check on an empty store, otherwise one box query on the store.
 */
export function pruneGlueInBox(
  grid: VoxelGrid,
  glue: GlueStore,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  if (glue.size === 0) return 0;
  const dead: number[] = [];
  glue.forEachInBox(x0, y0, z0, x1, y1, z1, (x, y, z, axis) => {
    // Canonical cell + axis: the other end lies in the positive direction of the axis (Dir = axis * 2).
    const dir = (axis << 1) as Dir;
    const a = getPacked(grid, x, y, z);
    const b = getPacked(grid, axis === 0 ? x + 1 : x, axis === 1 ? y + 1 : y, axis === 2 ? z + 1 : z);
    if (!glueFaceKept(a, b, dir)) dead.push(x, y, z, axis);
  });
  for (let i = 0; i < dead.length; i += 4) glue.remove(dead[i]!, dead[i + 1]!, dead[i + 2]!, (dead[i + 3]! << 1) as Dir);
  return dead.length / 4;
}

/** Functional block (helm, bearing, propeller). These never become part of a rotor. */
export function isFunctionalCell(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_FUNC) !== 0;
}

/** Is the cell's (first part's) MATERIAL a sail (every felt colour and canvas)? How much of it: sailVolume8. */
export function isSailCell(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_SAIL) !== 0;
}

/**
 * Octants (0..8) of the packed cell filled by sail material, both parts counted (docs/SHAPES.md
 * 11.1: sails count by volume; a felt slab is half a sail). A full sail block is 8.
 */
export function sailVolume8(c: number): number {
  if (c < FULL_LIMIT) return isSailCell(c) ? 8 : 0;
  tripwire(c);
  const p1 = firstPart(c);
  let v = isSailCell(p1) ? FILL_VOLUME[partFill(p1)]! : 0;
  const p2 = secondPart(c);
  if (p2 !== 0 && isSailCell(p2)) v += FILL_VOLUME[partFill(p2)]!;
  return v;
}

/** Functional kind of a cell ('none' for ordinary blocks and unknown ids). */
export function cellFunc(cell: number): FuncKind {
  return BLOCKS[cell & ID_MASK]?.func ?? 'none';
}

// ------------------------------------------------------------ pair rules

/**
 * The M1 auto-stick rule between two MATERIALS (full cell or part values: id and state), for a
 * contact along `dirAtoB`; symmetric. See autoSticks.
 */
function materialsStick(a: number, b: number, dirAtoB: Dir): boolean {
  const ida = a & ID_MASK;
  const idb = b & ID_MASK;
  const g = STICK[ida]!;
  if (g === G_NONE || g !== STICK[idb]) return false;
  if (g === G_CLOTH || g === G_PLANKS) return true;
  if (ida !== idb) return false;
  if (g === G_SELF) return true;
  // G_LOG: same id here; same axis and the face must lie on that axis.
  const axis = stateAxis(cellState(a));
  return axis === stateAxis(cellState(b)) && axis === dirAtoB >> 1;
}

/** Does part `pa` (of the cell on the near side) touch part `pb` across face `d` and stick to it by material? */
function partsStick(pa: number, pb: number, d: Dir): boolean {
  return (faceCover(partFill(pa), d) & faceCover(partFill(pb), (d ^ 1) as Dir)) !== 0 && materialsStick(pa, pb, d);
}

/**
 * Auto-stick rule between two ADJACENT packed cells; symmetric:
 * autoSticks(a, b, d) === autoSticks(b, a, opposite(d)).
 *  - cloth  (every felt colour + canvas) sticks to any cloth;
 *  - planks sticks to any planks;
 *  - self   sticks only to the same block id;
 *  - log    sticks only to the same log id with the same axis, and only when the two cells
 *           are neighbours ALONG that axis (one trunk: 原木只粘同一根);
 *  - none   never (terrain list, liquids, air, plants, functional blocks).
 * Cells that cannot join a structure never auto-stick. With parts (docs/SHAPES.md 10.2): the
 * cells stick when SOME part of `a` and some part of `b` occupy a common quadrant of the shared
 * face and stick by the rule above: the material that really touches decides. Full blocks touch
 * over the whole face, so for them this is the M1 rule.
 */
export function autoSticks(a: number, b: number, dirAtoB: Dir): boolean {
  if (a < FULL_LIMIT && b < FULL_LIMIT) return materialsStick(a, b, dirAtoB);
  tripwire(a);
  tripwire(b);
  const a1 = firstPart(a);
  const b1 = firstPart(b);
  if ((a1 & ID_MASK) === 0 || (b1 & ID_MASK) === 0) return false; // air (I1: id 0 only for AIR)
  const a2 = secondPart(a);
  const b2 = secondPart(b);
  if (partsStick(a1, b1, dirAtoB)) return true;
  if (b2 !== 0 && partsStick(a1, b2, dirAtoB)) return true;
  if (a2 === 0) return false;
  return partsStick(a2, b1, dirAtoB) || (b2 !== 0 && partsStick(a2, b2, dirAtoB));
}

/**
 * Functional mounting (NOT symmetric — callers test both orders): true when `a` is a block
 * with mount 'below' (helm, torch) and `b` is the HARD block directly under it, or `a` has
 * mount 'back' (bearing, propeller) and `b` is the HARD block behind it (`dirAtoB` opposite
 * to a's facing). `b` may be any hard breakable block, terrain-list blocks included
 * (地形名单不自动粘，功能方块的安装面除外). The FRONT of a bearing never sticks by itself.
 * With parts (docs/SHAPES.md 10.2): the face of `b` towards `a` must be COMPLETELY covered by
 * hard material (solidCover === 15), the rule placing uses too; the parts of a partial cell are
 * cuttable materials, all hard and breakable. Packed cells.
 */
export function mountSticks(a: number, b: number, dirAtoB: Dir): boolean {
  if (a >= FULL_LIMIT || b >= FULL_LIMIT) {
    tripwire(a);
    tripwire(b);
  }
  const m = MOUNT[a & ID_MASK]!;
  if (m === M_NONE || (FLAGS[b & ID_MASK]! & F_MOUNT_FACE) === 0) return false;
  if (m === M_BELOW) {
    if (dirAtoB !== NY) return false;
  } else if (dirAtoB !== (stateFacing(cellState(a)) ^ 1)) {
    // Back face = opposite of the facing: facing ^ 1.
    return false;
  }
  return b < FULL_LIMIT || solidCover(b, (dirAtoB ^ 1) as Dir) === 15;
}

/**
 * Do two adjacent packed cells (`b` is a's neighbour in `dirAtoB`) connect WITHOUT glue: both may
 * join a structure and they auto-stick, or one is mounted on the other? Symmetric.
 */
export function sticksWithoutGlue(a: number, b: number, dirAtoB: Dir): boolean {
  if ((FLAGS[a & ID_MASK]! & FLAGS[b & ID_MASK]! & F_JOIN) === 0) {
    if (a >= FULL_LIMIT || b >= FULL_LIMIT) {
      tripwire(a);
      tripwire(b);
    }
    return false;
  }
  return autoSticks(a, b, dirAtoB) || mountSticks(a, b, dirAtoB) || mountSticks(b, a, (dirAtoB ^ 1) as Dir);
}

/**
 * Connection test for two adjacent packed cells whose values the caller already holds: `a` at
 * (x,y,z) and `b` at its neighbour in `dirAtoB`. Same result as connected(); the flood fills
 * use this form to avoid reading each cell twice.
 *
 * Glue only counts when both cells may carry glue and they touch on the glued face (cellsTouch:
 * their hard covers of it overlap; docs/SHAPES.md 10.1). A glued face outlives the block on one
 * side (DESIGN 强力胶), so this matters: a torch next to a glued stone face is not glued in, while
 * a block placed against that face is; a slab on the far half of the cell across a glued face is
 * not glued in either.
 */
export function connectedCells(
  a: number,
  b: number,
  dirAtoB: Dir,
  glue: GlueStore,
  x: number,
  y: number,
  z: number,
): boolean {
  if (a >= FULL_LIMIT || b >= FULL_LIMIT) return connectedParts(a, b, dirAtoB, glue, x, y, z);
  const fa = FLAGS[a & ID_MASK]!;
  const fb = FLAGS[b & ID_MASK]!;
  if ((fa & fb & F_JOIN) === 0) return false;
  if (materialsStick(a, b, dirAtoB) || mountSticks(a, b, dirAtoB) || mountSticks(b, a, (dirAtoB ^ 1) as Dir)) {
    return true;
  }
  return (fa & fb & F_GLUE) !== 0 && glue.has(x, y, z, dirAtoB);
}

/** connectedCells when at least one cell has holes or a second part. */
function connectedParts(a: number, b: number, dirAtoB: Dir, glue: GlueStore, x: number, y: number, z: number): boolean {
  tripwire(a);
  tripwire(b);
  const fa = FLAGS[a & ID_MASK]!;
  const fb = FLAGS[b & ID_MASK]!;
  if ((fa & fb & F_JOIN) === 0) return false;
  if (autoSticks(a, b, dirAtoB) || mountSticks(a, b, dirAtoB) || mountSticks(b, a, (dirAtoB ^ 1) as Dir)) return true;
  return (fa & fb & F_GLUE) !== 0 && glue.has(x, y, z, dirAtoB) && cellsTouch(a, b, dirAtoB);
}

/**
 * Are the cell (x,y,z) and its neighbour in `dir` connected? Both must canJoinStructure, and
 * they must auto-stick, or one must be mounted on the other, or the face must be glued and the
 * two cells touch there. Symmetric: connected(p, d) === connected(p + d, opposite(d)).
 * Reads packed cells (one-off work: assembly, tests); never per tick.
 */
export function connected(grid: VoxelGrid, glue: GlueStore, x: number, y: number, z: number, dir: Dir): boolean {
  const a = getPacked(grid, x, y, z);
  const b = getPacked(grid, x + DIR_X[dir]!, y + DIR_Y[dir]!, z + DIR_Z[dir]!);
  return connectedCells(a, b, dir, glue, x, y, z);
}
