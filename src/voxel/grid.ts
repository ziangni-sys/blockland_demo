/**
 * The unified "transformed voxel grid" interface (docs/DESIGN.md):
 * the world, ships and rotors are all VoxelGrids, so reading/writing cells, raycasts,
 * collision and sampling are written ONCE against this interface.
 *
 * LOCAL space: integer cell (x,y,z) occupies the cube [x,x+1)^3 in the grid's own frame.
 * WORLD space: the single global frame. For the world grid local == world.
 * Structures may be nested (a rotor mounted on a ship): `parent` is the grid whose local
 * space this grid's pose is expressed in. toWorld/toLocal always go through every parent.
 */
import type { Quat, Vec3 } from '../core/math';

/** Flags for setCell. */
export const SET_DEFAULT = 0;
/** Do not notify neighbours (no liquid / gravity / support re-evaluation). */
export const SET_NO_NEIGHBOR_UPDATE = 1;
/** The change comes from an explosion (listeners may treat removal differently). */
export const SET_EXPLOSION = 2;
/** The change is part of assembling / blockifying a structure (bulk move, not a player edit). */
export const SET_STRUCTURE_MOVE = 4;

/** Half-open integer box of cells: min inclusive, max exclusive. */
export interface CellBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface VoxelGrid {
  /** 0 for the world; unique positive id for each structure. */
  readonly gridId: number;
  /** Grid whose local space this grid's pose lives in. null only for the world. */
  readonly parent: VoxelGrid | null;
  /** True only for the world grid (identity transform, unbounded). */
  readonly isWorld: boolean;

  /** Cell at integer local coordinates. Never throws; outside storage returns AIR (structures). */
  getCell(x: number, y: number, z: number): number;
  /** Write a cell. Returns false when the position cannot be written (e.g. unloaded chunk). */
  setCell(x: number, y: number, z: number, cell: number, flags?: number): boolean;

  /** Local point -> world point. `out` may alias `p`. */
  toWorld(p: Vec3, out?: Vec3): Vec3;
  /** World point -> local point. `out` may alias `p`. */
  toLocal(p: Vec3, out?: Vec3): Vec3;
  /** Rotate a local direction into world space (no translation). */
  dirToWorld(d: Vec3, out?: Vec3): Vec3;
  /** Rotate a world direction into local space (no translation). */
  dirToLocal(d: Vec3, out?: Vec3): Vec3;
  /** World-space velocity of this grid's material at a WORLD point (zero for the world). */
  velocityAt(worldPoint: Vec3, out?: Vec3): Vec3;
  /** Full local->world rotation. Identity for the world. */
  worldRotation(out?: Quat): Quat;

  /**
   * Tight integer bounds of all non-air cells in local space, or null when the grid is
   * empty or unbounded (the world returns null).
   */
  cellBounds(): CellBounds | null;
}
