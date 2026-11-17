/**
 * Connectivity rules: which two ADJACENT cells belong to the same structure
 * (docs/DESIGN.md "连接：组装时哪些方块算一体"; acceptance 1–3).
 *
 * Two neighbouring cells are connected when both may join a structure and at least one of
 *  - they auto-stick (same stick group, see BlockDef.stick),
 *  - one is a functional block standing on / backed by the other (its mounting face),
 *  - the face between them is glued
 * holds. The flood fills in collect.ts walk exactly this relation.
 *
 * Hot paths (a 4000-cell flood fill tests ~24k faces) read flat per-id tables built once
 * from the block registry when this module is evaluated. defs.ts is the only module that
 * registers blocks and it is imported first, so the tables cover the whole block table.
 * The tables are never written after that (immutable lookup data, not module state).
 */
import '../blocks/defs';
import { cellState, ID_MASK, MAX_BLOCK_ID, stateAxis, stateFacing } from '../blocks/cell';
import { BLOCKS, type FuncKind } from '../blocks/registry';
import { DIR_X, DIR_Y, DIR_Z, NY, type Dir } from '../core/dirs';
import type { VoxelGrid } from '../voxel/grid';
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

// ------------------------------------------------------------ per-cell predicates

/**
 * May this cell be part of a structure at all? False for air, liquids and unbreakable blocks
 * (deeprock, the 'unloaded' sentinel). Plants and torches CAN join (a torch joins through its
 * mounting face; a plant has no way to connect, so in practice it stays in the world).
 */
export function canJoinStructure(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_JOIN) !== 0;
}

/**
 * May glue be applied to this cell? False for air, liquids, unbreakable blocks and every
 * non-HARD block (torch, plants, snow cover).
 */
export function canGlue(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_GLUE) !== 0;
}

/** Functional block (helm, bearing, propeller). These never become part of a rotor. */
export function isFunctionalCell(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_FUNC) !== 0;
}

/** Counts towards a windmill's sail total (every felt colour and canvas). */
export function isSailCell(cell: number): boolean {
  return (FLAGS[cell & ID_MASK]! & F_SAIL) !== 0;
}

/** Functional kind of a cell ('none' for ordinary blocks and unknown ids). */
export function cellFunc(cell: number): FuncKind {
  return BLOCKS[cell & ID_MASK]?.func ?? 'none';
}

// ------------------------------------------------------------ pair rules

/**
 * Auto-stick rule between two ADJACENT cells (full cell values including state); symmetric:
 * autoSticks(a, b, d) === autoSticks(b, a, opposite(d)).
 *  - cloth  (every felt colour + canvas) sticks to any cloth;
 *  - planks sticks to any planks;
 *  - self   sticks only to the same block id;
 *  - log    sticks only to the same log id with the same axis, and only when the two cells
 *           are neighbours ALONG that axis (one trunk: 原木只粘同一根);
 *  - none   never (terrain list, liquids, air, plants, functional blocks).
 * Cells that cannot join a structure never auto-stick.
 */
export function autoSticks(a: number, b: number, dirAtoB: Dir): boolean {
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

/**
 * Functional mounting (NOT symmetric — callers test both orders): true when `a` is a block
 * with mount 'below' (helm, torch) and `b` is the HARD block directly under it, or `a` has
 * mount 'back' (bearing, propeller) and `b` is the HARD block behind it (`dirAtoB` opposite
 * to a's facing). `b` may be any hard breakable block, terrain-list blocks included
 * (地形名单不自动粘，功能方块的安装面除外). The FRONT of a bearing never sticks by itself.
 */
export function mountSticks(a: number, b: number, dirAtoB: Dir): boolean {
  const m = MOUNT[a & ID_MASK]!;
  if (m === M_NONE || (FLAGS[b & ID_MASK]! & F_MOUNT_FACE) === 0) return false;
  if (m === M_BELOW) return dirAtoB === NY;
  // Back face = opposite of the facing: facing ^ 1.
  return dirAtoB === (stateFacing(cellState(a)) ^ 1);
}

/**
 * Connection test for two adjacent cells whose values the caller already holds: `a` at
 * (x,y,z) and `b` at its neighbour in `dirAtoB`. Same result as connected(); the flood fills
 * use this form to avoid reading each cell twice.
 *
 * Glue only counts when both cells may carry glue. The store is kept consistent by
 * removeAllAt() on every cell change, so this matters only if a caller forgot to clear a
 * face; it guarantees that e.g. a torch that replaced a glued block is never glued in.
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
  const fa = FLAGS[a & ID_MASK]!;
  const fb = FLAGS[b & ID_MASK]!;
  if ((fa & fb & F_JOIN) === 0) return false;
  if (autoSticks(a, b, dirAtoB) || mountSticks(a, b, dirAtoB) || mountSticks(b, a, (dirAtoB ^ 1) as Dir)) {
    return true;
  }
  return (fa & fb & F_GLUE) !== 0 && glue.has(x, y, z, dirAtoB);
}

/**
 * Are the cell (x,y,z) and its neighbour in `dir` connected? Both must canJoinStructure, and
 * they must auto-stick, or one must be mounted on the other, or the face must be glued.
 * Symmetric: connected(p, d) === connected(p + d, opposite(d)).
 */
export function connected(grid: VoxelGrid, glue: GlueStore, x: number, y: number, z: number, dir: Dir): boolean {
  const a = grid.getCell(x, y, z);
  const b = grid.getCell(x + DIR_X[dir]!, y + DIR_Y[dir]!, z + DIR_Z[dir]!);
  return connectedCells(a, b, dir, glue, x, y, z);
}
