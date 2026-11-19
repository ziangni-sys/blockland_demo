/**
 * Structure data model (contract). A structure = a StructureGrid (cells + pose) + its own
 * glue + kind-specific state. Two kinds share this base (docs/DESIGN.md "对象模型"):
 *
 *   Rotor — MECHANICAL: kinematic, moves only as its mechanism dictates (spins about a
 *           bearing). Pushes entities and ships; is never pushed. Passes through blocks.
 *   Ship  — PHYSICAL: a rigid body (buoyancy, gravity, thrust, contacts).
 *
 * Nesting: a rotor can be mounted on the world or on a ship (rotor.parent). Rotors never
 * contain bearings, so the depth is at most world -> ship -> rotor.
 *
 * LOCAL COORDINATES. When a structure is assembled, its cells keep the integer coordinates
 * they had in the grid they were taken from. So right after assembly the pose is
 * "identity": grid.position == grid.pivot and grid.rotation == identity.
 *
 * This file holds plain state only. Behaviour lives in:
 *   assembly.ts (assemble / blockify), rotor.ts (kinematics), physics/ (ship dynamics),
 *   manager.ts (registry, tick order, hooks).
 */
import type { Dir } from '../core/dirs';
import { quat, type Quat, type Vec3 } from '../core/math';
import type { Rng } from '../core/rng';
import type { VoxelGrid } from '../voxel/grid';
import { StructureGrid } from '../voxel/sgrid';
import type { World } from '../voxel/world';
import { GlueStore } from './glue';
import type { SnapTransform } from './assembly';
import type { HullInfo } from './hull';

export type StructureKind = 'ship' | 'rotor';

export abstract class Structure {
  abstract readonly kind: StructureKind;
  /** Unique positive id; equals grid.gridId. Never reused within a world. */
  readonly id: number;
  readonly grid: StructureGrid;
  /** Glue between cells of this structure, in its local cell coordinates. */
  readonly glue: GlueStore = new GlueStore();
  /** Structure this one is mounted on, or null when mounted on the world. Mirrors grid.parent. */
  parent: Structure | null = null;
  /** Rotors mounted on this structure. */
  readonly children: Rotor[] = [];
  /** True once removed from the manager (blockified or destroyed). Holders must drop it. */
  removed = false;
  /** Motion suspended because the chunks around it are not loaded (LESSONS "船被弹飞"). */
  frozen = false;

  constructor(id: number, parentGrid: VoxelGrid) {
    this.id = id;
    this.grid = new StructureGrid(id, parentGrid);
  }

  /** Can the player place / mine / glue on it right now? (DESIGN "编辑限制") */
  abstract get editable(): boolean;
}

export class Rotor extends Structure {
  readonly kind = 'rotor' as const;
  /** The bearing cell, in the PARENT grid's local coordinates (world coordinates if parent is null). */
  bearingX = 0;
  bearingY = 0;
  bearingZ = 0;
  /**
   * Rotation axis in the ROTOR's local frame: the bearing's facing at assembly time.
   * Fixed for the rotor's whole life. The pivot (grid.pivot) is the centre of the hub
   * cell, i.e. the cell in front of the bearing.
   */
  axis: Dir = 2;
  /**
   * Orientation of the rotor's local frame relative to its parent's frame at angle 0.
   * Identity after assembly; changes only when the parent is re-gridded (a ship carrying
   * the rotor docks rotated, or the rotor is re-parented).
   * Invariant: grid.rotation == baseRotation * axisAngle(axisVector, angle).
   */
  readonly baseRotation: Quat = quat();
  /** Spin angle in radians about `axis` (right-handed). */
  angle = 0;
  /** Signed angular speed in rad/s. 0 = stopped. */
  angularSpeed = 0;
  /**
   * Sail volume in sails: octants of sail material (wool / canvas) divided by 8, so a full block
   * is 1 and a slab 0.5 (docs/SHAPES.md 11.1). A multiple of 1/8; saved and sent as round(sails x 8).
   */
  sails = 0;

  /** Rotating mechanical structures cannot be edited. */
  get editable(): boolean {
    return this.angularSpeed === 0;
  }
}

export class Ship extends Structure {
  readonly kind = 'ship' as const;

  // Rigid-body state lives on the grid (parent is always the world for ships):
  //   grid.pivot           = centre of mass, local
  //   grid.position        = centre of mass, world
  //   grid.rotation        = orientation
  //   grid.linearVelocity  = velocity of the centre of mass, world, blocks/s
  //   grid.angularVelocity = angular velocity, world, rad/s

  /** Derived hull data; valid when hull.version === grid.version (see physics refresh). */
  hull: HullInfo | null = null;
  mass = 0;
  /** Inverse inertia tensor about the centre of mass in LOCAL axes (row-major 3x3). */
  readonly invInertiaLocal: Float64Array = new Float64Array(9);

  // ---- control (written by the simulation from the helmsman's input)
  /** -1 (full astern) .. 1 (full ahead). */
  throttle = 0;
  /** -1 (turn left / port) .. 1 (turn right / starboard). */
  rudder = 0;
  /** Entity id of the player holding the wheel, 0 when nobody steers. */
  helmsmanId = 0;
  /** Local cell of the helm in use (valid while helmsmanId != 0), and of the helm that defines "forward". */
  helmX = 0;
  helmY = 0;
  helmZ = 0;
  /**
   * Bow direction in the ship's local frame: the facing of its (first) helm.
   * Thrust pushes along it; the rudder yaws about local +Y.
   */
  forward: Dir = 5;

  // ---- derived every tick
  /** Sails (by volume, see Rotor.sails) of the running rotors mounted on this ship (sets the top speed). */
  sails = 0;
  /** Resting: skipped by the dynamics until something disturbs it. */
  asleep = false;
  /** Ticks spent (nearly) motionless, for the sleep heuristic. */
  restTicks = 0;

  /** Physical structures can always be edited. */
  get editable(): boolean {
    return true;
  }
}

/**
 * Rigid-body dynamics of ships. Implemented in src/structures/physics and injected into
 * the StructureManager, which calls it once per tick AFTER it has advanced every rotor
 * (so each rotor's grid.prevPosition/prevRotation -> position/rotation bracket the tick).
 */
export interface ShipDynamics {
  /**
   * Bring derived data up to date when ship.grid.version changed since the last call:
   * ship.hull (analyzeHull), ship.mass, ship.invInertiaLocal, the pivot (moved to the new
   * centre of mass with setPivotKeepingPose, velocities adjusted so the motion is
   * unchanged), ship.forward / helm cell, and wakes the ship. Cheap no-op otherwise.
   */
  refresh(ship: Ship): void;
  /**
   * Advance every ship by one tick (internally sub-stepped). `rotors` are all live
   * rotors; those not mounted on a given ship act on it as kinematic obstacles.
   * Frozen ships are skipped; sleeping ships are skipped until woken.
   */
  step(ships: readonly Ship[], rotors: readonly Rotor[]): void;
  /** Apply an impulse (mass units * blocks/s) at a world point, e.g. from an explosion. Wakes the ship. */
  applyImpulse(ship: Ship, worldPoint: Vec3, impulse: Vec3): void;
  /** Wake a sleeping ship (something near it changed). */
  wake(ship: Ship): void;
}

/**
 * Services the structures module needs from the simulation, so that it does not depend
 * on the entities or sim modules.
 */
export interface StructureHost {
  readonly world: World;
  /** Glue between world cells. */
  readonly worldGlue: GlueStore;
  readonly rng: Rng;
  /**
   * The world rule (sim/rules.ts): blocks displaced by a blockify or a dock, or destroyed by a
   * pinned ship, drop their item. False in a creative world.
   */
  readonly dropsEnabled: boolean;
  /** Spawn an item drop with its centre at a world position. */
  spawnDrop(x: number, y: number, z: number, item: number, count: number): void;
  /**
   * Re-evaluate a WORLD cell and its 6 neighbours after a bulk change made with
   * SET_NO_NEIGHBOR_UPDATE: gravity blocks fall, unsupported soft blocks pop off, liquids
   * get scheduled (DESIGN "组装和方块化之后要触发方块更新").
   */
  blockUpdate(x: number, y: number, z: number): void;
  /**
   * Called BEFORE a structure's cells leave it (blockify / dock / destroyed) or its frame
   * is re-gridded: every entity carried by it, and its helmsman, must let go now
   * (LESSONS "停靠时站在转盘上的人被瞬移"). A blockify or dock passes its snap (the structure's
   * local cells -> its parent grid's): the riders are moved by it too, so they stay on the cells
   * they stood on; null when the cells do not move (destroyed).
   */
  releaseRiders(structure: Structure, snap: SnapTransform | null): void;
}
