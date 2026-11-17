/**
 * StructureManager: registry and life cycle of every structure of one world
 * (docs/DESIGN.md "对象模型", "组装与方块化"; docs/LESSONS.md "组装、方块化与胶水").
 *
 *   assemble   world cells -> Ship              (assembleShip; helm in the world)
 *              world / ship cells -> Rotor      (startRotor; bearing in the world or a ship)
 *   tick       rotors spin, ships run on the injected ShipDynamics           (step)
 *   blockify   Rotor -> cells of its parent grid, in place                   (stopRotor)
 *              Ship  -> world cells, snapped to the grid                     (dockShip)
 *   persist    serialize / deserialize
 *
 * HOOKS. Every cell change of every grid goes through one listener per grid:
 *  - glue: when a cell changes block id, by whatever path (bulk structure moves included), the
 *    glue lifetime rule runs on its faces (pruneGlueAt: a glued face stays while one side is a
 *    glueable block); when a chunk is added to the world, it runs on the world's faces in and on
 *    the border of that chunk (pruneGlueInBox), whose cells were unknown until then;
 *  - bearings: when the bearing of a running rotor is removed or replaced, by whatever path
 *    (mining, explosion, physics damage ...), the rotor blockifies in place — immediately, or at
 *    endBatch() inside a batch (LESSONS: 先等冲击波处理完所有结构体，再把转子方块化，最后统一重算);
 *  - world changes near a ship wake it in the dynamics;
 *  - rotor cells keep the rotor's sail count truthful (LESSONS 船上风车坏了…帆数不变).
 *
 * The lists returned by all() / ships() / rotors() are immutable snapshots: the manager
 * replaces them when the set of structures changes, so it is safe to iterate one while
 * stopping or docking structures.
 *
 * No module-level state: two managers on two worlds never share anything.
 */
import { cellState, ID_MASK, stateFacing } from '../blocks/cell';
import { B } from '../blocks/defs';
import { CHUNK_SIZE, TICK_DT, WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z } from '../core/dirs';
import { aabb, qidentity, qrotate, qtoMat3, vec3, vset, type AABB } from '../core/math';
import type { ByteReader, ByteWriter } from '../save/bytes';
import type { VoxelGrid } from '../voxel/grid';
import type { Chunk } from '../voxel/chunk';
import type { World } from '../voxel/world';
import {
  blockifyGrid,
  commitDock,
  emptyReport,
  hullCavityCells,
  planDock,
  refillWater,
  remountRotor,
  rotorSnap,
  transferCells,
  type BlockifyReport,
  type DockPlan,
  type GridFace,
} from './assembly';
import { CellSet, collectRotor, collectShip, type CollectReason, type CollectResult } from './collect';
import type { GlueStore } from './glue';
import { analyzeHull, type HullInfo } from './hull';
import { advanceRotor, applyRotorPose, holdRotor } from './rotor';
import { readStructures, writeStructures } from './serialize';
import { cellFunc, isSailCell, pruneGlueAt, pruneGlueInBox } from './stick';
import { Rotor, Ship, type ShipDynamics, type Structure, type StructureHost } from './structure';

export type { BlockifyReport } from './assembly';

/**
 * Why startRotor / previewRotor refuse a bearing before looking at any cell:
 *  - 'not_world'    the grid is neither this manager's world nor one of its live ships;
 *  - 'nested_rotor' the bearing is inside a rotor (rotors never carry rotors);
 *  - 'has_rotor'    a rotor already runs on that bearing.
 */
export type RotorRefusal = 'not_world' | 'nested_rotor' | 'has_rotor';

/**
 * Why an assembly was refused: a CollectResult reason ('unloaded' included: the structure
 * touches a chunk that is not loaded, so part of it might be missing) or a RotorRefusal.
 */
export type AssembleFailure = CollectReason | RotorRefusal;

export type AssembleResult<T> = { ok: true; structure: T } | { ok: false; reason: AssembleFailure };

/**
 * What previewRotor returns: a CollectResult whose reason may also be a RotorRefusal (then
 * `cells` is empty). previewShip / previewRotor always agree with assembleShip / startRotor
 * on ok and reason as long as nothing changes in between.
 */
export interface AssemblyPreview extends Omit<CollectResult, 'reason'> {
  reason: CollectReason | RotorRefusal;
}

/** A world cell that blocks docking (painted red by the client). */
export interface DockConflict {
  x: number;
  y: number;
  z: number;
}

export type DockResult =
  | { ok: true; report: BlockifyReport }
  | { ok: false; reason: 'tilted' | 'blocked'; conflicts: DockConflict[] };

/** Chunks this far around a structure's world box must be loaded or it freezes (LESSONS 船被弹飞). */
const FREEZE_MARGIN = 2;
/** World changes this close to a ship's world box wake it. */
const WAKE_MARGIN = 1;

const BEARING_ID = B.BEARING;

interface Entry {
  readonly s: Structure;
  /** Unsubscribes the structure's grid listener. */
  unsub: () => void;
  /**
   * World-space box. Ships: the world AABB of the oriented cell box, refreshed every step
   * (wake / freeze tests). World rotors: the box of everything they sweep (freeze test).
   */
  readonly box: AABB;
  /**
   * Rotors only: the cylinder swept by the cells about the spin axis, in rotor-local terms —
   * extent along the axis's positive direction relative to the pivot [sweepA0, sweepA1] and
   * radius about the axis line. Valid while grid.version === sweepVersion.
   */
  sweepVersion: number;
  sweepA0: number;
  sweepA1: number;
  sweepRadius: number;
}
type ShipEntry = Entry & { readonly s: Ship };

function noop(): void {}

function fail<T>(reason: AssembleFailure): AssembleResult<T> {
  return { ok: false, reason };
}

function refusedPreview(reason: RotorRefusal): AssemblyPreview {
  return { ok: false, reason, cells: new Int32Array(0), count: 0, sails: 0, bounds: null };
}

/** The DockResult a plan stands for (a successful plan reports what docking would do). */
function planVerdict(plan: DockPlan): DockResult {
  if (plan.tilted) return { ok: false, reason: 'tilted', conflicts: [] };
  if (plan.conflicts.length > 0) return { ok: false, reason: 'blocked', conflicts: plan.conflicts };
  return { ok: true, report: { placed: plan.placed, dropped: 0, overwritten: plan.overwritten } };
}

export class StructureManager {
  readonly host: StructureHost;
  /** Ship rigid-body dynamics; null = ships stay where they are (tests, tools). */
  dynamics: ShipDynamics | null;

  private readonly world: World;
  /** Next structure id. Ids are never reused within a world (saved with it). */
  private nextId = 1;
  // Copy-on-write snapshots in creation (= id) order.
  private list: readonly Structure[] = [];
  private shipList: readonly Ship[] = [];
  private rotorList: readonly Rotor[] = [];
  private shipEntries: readonly ShipEntry[] = [];
  private readonly entries = new Map<number, Entry>();
  /** Every grid this manager ever created -> its structure (glueFor of a just-removed one). */
  private readonly owners = new WeakMap<VoxelGrid, Structure>();
  /** Live rotors mounted on the world (ship rotors are in their ship's `children`). */
  private readonly worldRotors: Rotor[] = [];
  private batchDepth = 0;
  /** Rotors that lost their bearing inside a batch, in the order it happened. */
  private readonly pending: Rotor[] = [];
  private unsubWorld: (() => void) | null = null;
  private unsubChunks: (() => void) | null = null;
  // Scratch for the per-tick box maths only (never used across a call that can re-enter).
  private readonly mat = new Float64Array(9);
  private readonly tmp = vec3();

  constructor(host: StructureHost, dynamics: ShipDynamics | null = null) {
    this.host = host;
    this.world = host.world;
    this.dynamics = dynamics;
    this.unsubWorld = host.world.onCellChange(this.onWorldCell);
    this.unsubChunks = host.world.onChunkAdd(this.onWorldChunk);
  }

  // ------------------------------------------------------------ queries

  /** Every live structure in creation order (immutable snapshot). */
  all(): readonly Structure[] {
    return this.list;
  }
  ships(): readonly Ship[] {
    return this.shipList;
  }
  rotors(): readonly Rotor[] {
    return this.rotorList;
  }
  get(id: number): Structure | undefined {
    return this.entries.get(id)?.s;
  }
  /** 0 -> the world; a live structure's grid; undefined otherwise. */
  gridById(id: number): VoxelGrid | undefined {
    return id === 0 ? this.world : this.entries.get(id)?.s.grid;
  }
  /** The live structure owning `grid`; null for the world and for removed structures. */
  structureOf(grid: VoxelGrid): Structure | null {
    if (grid.isWorld) return null;
    const e = this.entries.get(grid.gridId);
    return e !== undefined && e.s.grid === grid ? e.s : null;
  }
  /**
   * Glue store of a grid: the host's world glue, or the structure's own. A structure removed
   * a moment ago still answers (with its now detached store) so stale UI code cannot crash;
   * a grid this manager never created throws.
   */
  glueFor(grid: VoxelGrid): GlueStore {
    if (grid === this.world) return this.host.worldGlue;
    const s = grid.isWorld ? undefined : this.owners.get(grid);
    if (s === undefined) throw new Error(`StructureManager.glueFor: grid ${grid.gridId} does not belong to this manager`);
    return s.glue;
  }
  /** The running rotor driven by the bearing at (x,y,z) of `grid`, if any. */
  rotorAtBearing(grid: VoxelGrid, x: number, y: number, z: number): Rotor | null {
    const list = this.rotorsOn(grid);
    if (list === null) return null;
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (r.bearingX === x && r.bearingY === y && r.bearingZ === z) return r;
    }
    return null;
  }

  // ------------------------------------------------------------ previews (pure)

  /** What a helm at world cell (x,y,z) would assemble. Changes nothing. */
  previewShip(x: number, y: number, z: number): CollectResult {
    return collectShip(this.world, this.host.worldGlue, x, y, z);
  }
  /**
   * What a bearing at (x,y,z) of `grid` (the world or a live ship) would spin. Changes
   * nothing and never throws: a grid startRotor would refuse gets the same refusal here.
   */
  previewRotor(grid: VoxelGrid, x: number, y: number, z: number): AssemblyPreview {
    const refusal = this.rotorRefusal(grid, x, y, z);
    if (refusal !== null) return refusedPreview(refusal);
    return collectRotor(grid, this.glueFor(grid), x, y, z);
  }

  // ------------------------------------------------------------ assembly

  /**
   * Assemble the ship steered by the helm at WORLD cell (x,y,z). Ships cannot be built on
   * structures. The cells keep their coordinates (ship-local == world at this moment, pose
   * identity); running rotors whose bearing comes along are re-parented onto the ship.
   */
  assembleShip(x: number, y: number, z: number): AssembleResult<Ship> {
    const world = this.world;
    const host = this.host;
    // collectShip is the whole verdict (previewShip must agree): its 'unloaded' is exact, it is
    // reported whenever a face neighbour of a collected cell lies in an unloaded chunk.
    const res = collectShip(world, host.worldGlue, x, y, z);
    if (!res.ok) return fail(res.reason);

    const ship = new Ship(this.nextId++, world);
    ship.helmX = x;
    ship.helmY = y;
    ship.helmZ = z;
    ship.forward = stateFacing(cellState(world.getCell(x, y, z)));
    const inSet = CellSet.fromCells(res.cells, res.count);

    // Re-parent before the cells leave the world: the world's bearing hook must not mistake
    // the move of a running rotor's bearing for its loss. Numbers stay valid because
    // ship-local coordinates equal world coordinates right now.
    const rotors = this.rotorList;
    for (let i = 0; i < rotors.length; i++) {
      const r = rotors[i]!;
      if (r.parent === null && inSet.has(r.bearingX, r.bearingY, r.bearingZ)) this.reparentToShip(r, ship);
    }
    transferCells(world, host.worldGlue, ship.grid, ship.glue, res.cells, res.count, res.bounds);
    this.register(ship);

    const dyn = this.dynamics;
    let hull: HullInfo | null;
    if (dyn !== null) {
      dyn.refresh(ship);
      hull = this.currentHull(ship);
    } else {
      // Analysed once here and reused for the cavities below: on a ship with a large box the
      // analysis is the most expensive part of assembling. ship.hull stays null so a dynamics
      // injected later still sees the ship as never refreshed.
      hull = analyzeHull(ship.grid);
      if (hull !== null) vset(ship.grid.pivot, hull.com.x, hull.com.y, hull.com.z);
      ship.grid.setPoseImmediate(ship.grid.pivot, qidentity());
    }

    // DESIGN 水的处理: the vacated footprint and the hull's cavities refill from the sea.
    const cavities = hull !== null ? hullCavityCells(hull) : new Int32Array(0);
    const candidates = new Int32Array(res.count * 3 + cavities.length);
    candidates.set(res.cells.subarray(0, res.count * 3));
    candidates.set(cavities, res.count * 3);
    refillWater(world, candidates, candidates.length / 3);
    this.blockUpdateAll(res.cells, res.count);
    this.computeShipBox(this.entries.get(ship.id) as ShipEntry);
    return { ok: true, structure: ship };
  }

  /**
   * Start the rotor in front of the bearing at (x,y,z) of `grid` (the world or a live ship).
   * The rotor starts at angle 0 with pose identity and spins up on the following ticks.
   */
  startRotor(grid: VoxelGrid, x: number, y: number, z: number): AssembleResult<Rotor> {
    // Same checks in the same order as previewRotor, so the two always agree.
    const refusal = this.rotorRefusal(grid, x, y, z);
    if (refusal !== null) return fail(refusal);
    const ship = grid === this.world ? null : (this.structureOf(grid) as Ship);
    const glue = this.glueFor(grid);
    const res = collectRotor(grid, glue, x, y, z);
    if (!res.ok) return fail(res.reason);

    const facing = stateFacing(cellState(grid.getCell(x, y, z)));
    const rotor = new Rotor(this.nextId++, grid);
    rotor.parent = ship;
    rotor.bearingX = x;
    rotor.bearingY = y;
    rotor.bearingZ = z;
    rotor.axis = facing;
    rotor.sails = res.sails;
    const g = rotor.grid;
    vset(g.pivot, x + DIR_X[facing]! + 0.5, y + DIR_Y[facing]! + 0.5, z + DIR_Z[facing]! + 0.5);
    g.setPoseImmediate(g.pivot, qidentity());

    // The glue between the hub and the bearing stays on the bearing (DESIGN 强力胶: the bearing is
    // a glueable block that stays behind), so it is there again when the rotor stops.
    transferCells(grid, glue, g, rotor.glue, res.cells, res.count, res.bounds);
    if (ship !== null) ship.children.push(rotor);
    else this.worldRotors.push(rotor);
    applyRotorPose(rotor);
    this.register(rotor);

    if (ship !== null) {
      this.dynamics?.wake(ship);
    } else {
      refillWater(this.world, res.cells, res.count);
      this.blockUpdateAll(res.cells, res.count);
    }
    return { ok: true, structure: rotor };
  }

  // ------------------------------------------------------------ blockify

  /**
   * Blockify a rotor in place into its parent grid (DESIGN 方块化). Always succeeds: cells
   * that land in hard blocks drop. No-op (empty report) for a rotor that is not live.
   */
  stopRotor(rotor: Rotor): BlockifyReport {
    if (!this.isLive(rotor)) return emptyReport();
    this.host.releaseRiders(rotor);
    if (!this.isLive(rotor)) return emptyReport(); // stopped re-entrantly by the host
    const ship = rotor.parent instanceof Ship ? rotor.parent : null;
    const dst: VoxelGrid = ship !== null ? ship.grid : this.world;
    const dstGlue = ship !== null ? ship.glue : this.host.worldGlue;
    const t = rotorSnap(rotor.grid);
    // The face between the bearing and the hub's place keeps the glue the parent already holds
    // on it (it stayed on the bearing when the rotor started: ACCEPTANCE 14). Read before the
    // writes: a bearing that is gone, or replaced, has no such face.
    const bearing = dst.getCell(rotor.bearingX, rotor.bearingY, rotor.bearingZ);
    const bearingFace: GridFace | null =
      (bearing & ID_MASK) === BEARING_ID
        ? { x: rotor.bearingX, y: rotor.bearingY, z: rotor.bearingZ, dir: stateFacing(cellState(bearing)) }
        : null;
    // Unregister first: the writes below run the parent grid's hooks (and any listener the
    // host attached), which must no longer see this rotor as running.
    this.detachRotor(rotor);
    this.unregister(rotor);
    const out = blockifyGrid(this.host, rotor.grid, rotor.glue, dst, dstGlue, t, ship !== null, bearingFace);
    if (ship !== null) {
      if (this.isLive(ship)) this.dynamics?.wake(ship);
    } else {
      this.blockUpdateAll(out.placed, out.report.placed);
    }
    return out.report;
  }

  /** dockShip()'s verdict without changing anything. */
  dockConflicts(ship: Ship): DockResult {
    if (!this.isLive(ship)) return { ok: false, reason: 'blocked', conflicts: [] };
    return planVerdict(planDock(this.world, ship.grid));
  }

  /**
   * Active docking (DESIGN 主动停靠): snap the ship to the world grid and turn it back into
   * blocks. Refused when it leans more than 45 degrees ('tilted') or when any cell would land
   * in a hard world block ('blocked', with those world cells). Running rotors on the ship keep
   * running, re-mounted on the world. A ship that is not live is reported 'blocked' with no
   * conflicts.
   */
  dockShip(ship: Ship): DockResult {
    if (!this.isLive(ship)) return { ok: false, reason: 'blocked', conflicts: [] };
    const plan = planDock(this.world, ship.grid);
    const verdict = planVerdict(plan);
    if (!verdict.ok) return verdict;
    const host = this.host;
    host.releaseRiders(ship);
    const children = ship.children.slice();
    for (let i = 0; i < children.length; i++) host.releaseRiders(children[i]!);
    if (!this.isLive(ship)) return { ok: false, reason: 'blocked', conflicts: [] };
    const hull = this.currentHull(ship);
    this.unregister(ship);
    const out = commitDock(host, ship, plan.t, hull);
    ship.children.length = 0;
    const orphans: Rotor[] = [];
    for (let i = 0; i < children.length; i++) {
      const r = children[i]!;
      if (!this.isLive(r)) continue;
      remountRotor(r, plan.t, this.world);
      r.parent = null;
      this.worldRotors.push(r);
      // The bearing was written like every other cell; should it have dropped after all
      // (commitDock's defensive path) the rotor lost its bearing and must stop like any other.
      if (cellFunc(this.world.getCell(r.bearingX, r.bearingY, r.bearingZ)) !== 'bearing') orphans.push(r);
    }
    this.blockUpdateAll(out.touched, out.touched.length / 3);
    for (let i = 0; i < orphans.length; i++) this.loseBearing(orphans[i]!);
    return { ok: true, report: out.report };
  }

  // ------------------------------------------------------------ tick

  /**
   * One simulation tick of every structure: snapshot poses, update frozen flags, spin rotors,
   * sum ships' sails, run the ship dynamics, then blockify rotors whose bearing broke during
   * the dynamics step and remove destroyed ships.
   */
  step(): void {
    const all = this.list;
    for (let i = 0; i < all.length; i++) all[i]!.grid.snapshotPose();
    this.updateFrozen();
    const rotors = this.rotorList;
    for (let i = 0; i < rotors.length; i++) {
      const r = rotors[i]!;
      if (r.frozen) holdRotor(r);
      else advanceRotor(r, TICK_DT);
    }
    const ships = this.shipList;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i]!;
      let sails = 0;
      for (let k = 0; k < s.children.length; k++) sails += s.children[k]!.sails;
      s.sails = sails;
    }
    const dyn = this.dynamics;
    if (dyn !== null) {
      // The dynamics may break ship cells (rotor wedging a ship against terrain); bearings lost
      // that way blockify after the step, not in the middle of it.
      this.beginBatch();
      try {
        const list = this.shipList;
        for (let i = 0; i < list.length; i++) dyn.refresh(list[i]!);
        dyn.step(this.shipList, this.rotorList);
      } finally {
        this.endBatch();
      }
    } else if (this.batchDepth === 0) {
      this.removeDestroyed(); // inside a caller's batch, its endBatch() does this
    }
    const ents = this.shipEntries;
    for (let i = 0; i < ents.length; i++) this.computeShipBox(ents[i]!);
  }

  /**
   * Defer the blockifying of rotors that lose their bearing until the matching endBatch(),
   * e.g. while an explosion removes cells from every structure it reaches. Nestable.
   */
  beginBatch(): void {
    this.batchDepth++;
  }

  /**
   * Close a batch. At the outermost level: blockify the rotors that lost their bearing (in
   * that order), then remove structures left empty — an emptied ship that still carried
   * rotors receives their remains first and so survives (ACCEPTANCE 13).
   */
  endBatch(): void {
    if (this.batchDepth === 0) throw new Error('StructureManager.endBatch without beginBatch');
    if (--this.batchDepth > 0) return;
    while (this.pending.length > 0) {
      const r = this.pending.shift()!;
      this.stopRotor(r);
    }
    this.removeDestroyed();
  }

  // ------------------------------------------------------------ persistence

  /** Write every structure (ids, nesting, cells, poses, glue, rotor and ship state). */
  serialize(w: ByteWriter): void {
    writeStructures(w, this.nextId, this.list);
  }

  /**
   * Replace every structure with the ones read from `r`. On malformed data a SaveFormatError
   * is thrown and the current structures are kept. Ships' derived data (hull, mass ...) is
   * rebuilt by the dynamics on the next step.
   */
  deserialize(r: ByteReader): void {
    const data = readStructures(r, this.world);
    this.clear();
    this.nextId = data.nextId;
    for (const s of data.structures) {
      if (s instanceof Rotor && s.parent === null) this.worldRotors.push(s);
      this.register(s);
    }
    const ents = this.shipEntries;
    for (let i = 0; i < ents.length; i++) this.computeShipBox(ents[i]!);
  }

  /** Forget every structure (no blockify, no drops) and reset the id counter. */
  clear(): void {
    for (const e of this.entries.values()) {
      e.unsub();
      e.s.removed = true;
    }
    this.entries.clear();
    this.list = [];
    this.shipList = [];
    this.rotorList = [];
    this.shipEntries = [];
    this.worldRotors.length = 0;
    this.pending.length = 0;
    this.batchDepth = 0;
    this.nextId = 1;
  }

  /** Unsubscribe every hook. The manager must not be used afterwards. */
  dispose(): void {
    if (this.unsubWorld !== null) {
      this.unsubWorld();
      this.unsubWorld = null;
    }
    if (this.unsubChunks !== null) {
      this.unsubChunks();
      this.unsubChunks = null;
    }
    for (const e of this.entries.values()) {
      e.unsub();
      e.unsub = noop;
    }
  }

  // ------------------------------------------------------------ hooks

  private readonly onWorldCell = (x: number, y: number, z: number, oldCell: number, newCell: number): void => {
    const oldId = oldCell & ID_MASK;
    if (oldId !== (newCell & ID_MASK)) pruneGlueAt(this.world, this.host.worldGlue, x, y, z, newCell);
    if (oldId === BEARING_ID && this.worldRotors.length > 0) this.bearingChanged(this.worldRotors, x, y, z, oldCell, newCell);
    const dyn = this.dynamics;
    if (dyn !== null) {
      const ents = this.shipEntries;
      for (let i = 0; i < ents.length; i++) {
        const b = ents[i]!.box;
        if (
          x + 1 > b.minX - WAKE_MARGIN &&
          x < b.maxX + WAKE_MARGIN &&
          y + 1 > b.minY - WAKE_MARGIN &&
          y < b.maxY + WAKE_MARGIN &&
          z + 1 > b.minZ - WAKE_MARGIN &&
          z < b.maxZ + WAKE_MARGIN
        ) {
          dyn.wake(ents[i]!.s);
        }
      }
    }
  };

  /**
   * A chunk arrived (generated or restored): glue kept on its border while it was unloaded, or
   * restored with a save before its cells, now meets the real cells. Nothing to do on an empty
   * store; otherwise one box query over the chunk's columns.
   */
  private readonly onWorldChunk = (chunk: Chunk): void => {
    const glue = this.host.worldGlue;
    if (glue.size === 0) return;
    const x0 = chunk.cx * CHUNK_SIZE;
    const z0 = chunk.cz * CHUNK_SIZE;
    pruneGlueInBox(this.world, glue, x0, 0, z0, x0 + CHUNK_SIZE - 1, WORLD_HEIGHT - 1, z0 + CHUNK_SIZE - 1);
  };

  private watchShip(ship: Ship): () => void {
    return ship.grid.onCellChange((x, y, z, oldCell, newCell) => {
      const oldId = oldCell & ID_MASK;
      if (oldId !== (newCell & ID_MASK)) pruneGlueAt(ship.grid, ship.glue, x, y, z, newCell);
      if (oldId === BEARING_ID && ship.children.length > 0) this.bearingChanged(ship.children, x, y, z, oldCell, newCell);
    });
  }

  private watchRotor(rotor: Rotor): () => void {
    return rotor.grid.onCellChange((x, y, z, oldCell, newCell) => {
      if ((oldCell & ID_MASK) !== (newCell & ID_MASK)) pruneGlueAt(rotor.grid, rotor.glue, x, y, z, newCell);
      const was = isSailCell(oldCell);
      if (was !== isSailCell(newCell)) rotor.sails += was ? -1 : 1;
    });
  }

  /** A bearing cell of some grid changed: if it drove a rotor that is now lost, blockify it. */
  private bearingChanged(list: readonly Rotor[], x: number, y: number, z: number, oldCell: number, newCell: number): void {
    // Same bearing, same facing (only unrelated state bits changed): still driving its rotor.
    if ((newCell & ID_MASK) === BEARING_ID && stateFacing(cellState(newCell)) === stateFacing(cellState(oldCell))) return;
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (r.bearingX !== x || r.bearingY !== y || r.bearingZ !== z) continue;
      this.loseBearing(r);
      return; // one rotor per bearing; `list` may have changed under us
    }
  }

  /** A rotor's bearing is gone: blockify it now, or at the outermost endBatch() in a batch. */
  private loseBearing(r: Rotor): void {
    if (this.batchDepth > 0) {
      if (!this.pending.includes(r)) this.pending.push(r);
    } else {
      this.stopRotor(r);
    }
  }

  /** Why a rotor cannot be started on the bearing at (x,y,z) of `grid`; null when it may. */
  private rotorRefusal(grid: VoxelGrid, x: number, y: number, z: number): RotorRefusal | null {
    if (grid !== this.world) {
      const s = this.structureOf(grid);
      if (s instanceof Rotor) return 'nested_rotor';
      if (!(s instanceof Ship)) return 'not_world';
    }
    return this.rotorAtBearing(grid, x, y, z) !== null ? 'has_rotor' : null;
  }

  // ------------------------------------------------------------ registry

  private register(s: Structure): void {
    const unsub = s instanceof Ship ? this.watchShip(s) : this.watchRotor(s as Rotor);
    const e: Entry = { s, unsub, box: aabb(), sweepVersion: -1, sweepA0: 0, sweepA1: 0, sweepRadius: 0 };
    this.entries.set(s.id, e);
    this.owners.set(s.grid, s);
    this.list = this.list.concat(s);
    if (s instanceof Ship) {
      this.shipList = this.shipList.concat(s);
      this.shipEntries = this.shipEntries.concat(e as ShipEntry);
    } else {
      this.rotorList = this.rotorList.concat(s as Rotor);
    }
  }

  private unregister(s: Structure): void {
    const e = this.entries.get(s.id);
    if (e === undefined || e.s !== s) return;
    e.unsub();
    this.entries.delete(s.id);
    s.removed = true;
    this.list = this.list.filter((x) => x !== s);
    if (s instanceof Ship) {
      this.shipList = this.shipList.filter((x) => x !== s);
      this.shipEntries = this.shipEntries.filter((x) => x.s !== s);
    } else {
      this.rotorList = this.rotorList.filter((x) => x !== s);
    }
  }

  private isLive(s: Structure): boolean {
    return !s.removed && this.entries.get(s.id)?.s === s;
  }

  private rotorsOn(grid: VoxelGrid): readonly Rotor[] | null {
    if (grid === this.world) return this.worldRotors;
    const s = this.structureOf(grid);
    return s instanceof Ship ? s.children : null;
  }

  private reparentToShip(rotor: Rotor, ship: Ship): void {
    const i = this.worldRotors.indexOf(rotor);
    if (i >= 0) this.worldRotors.splice(i, 1);
    rotor.parent = ship;
    rotor.grid.parent = ship.grid;
    ship.children.push(rotor);
  }

  /** Remove a rotor from its parent's mount list and from the pending stops. */
  private detachRotor(rotor: Rotor): void {
    const list = rotor.parent !== null ? rotor.parent.children : this.worldRotors;
    const i = list.indexOf(rotor);
    if (i >= 0) list.splice(i, 1);
    const j = this.pending.indexOf(rotor);
    if (j >= 0) this.pending.splice(j, 1);
  }

  /**
   * Rotors whose cells were all destroyed are removed (their bearing becomes free); ships
   * left without cells and without rotors are destroyed (releaseRiders first).
   */
  private removeDestroyed(): void {
    const rotors = this.rotorList;
    for (let i = 0; i < rotors.length; i++) {
      const r = rotors[i]!;
      if (r.grid.count === 0) this.stopRotor(r);
    }
    const ships = this.shipList;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i]!;
      if (s.grid.count !== 0 || s.children.length !== 0 || !this.isLive(s)) continue;
      this.host.releaseRiders(s);
      this.unregister(s);
    }
  }

  // ------------------------------------------------------------ helpers

  /** Hull analysis of the ship's current cells (the dynamics' cached one when still valid). */
  private currentHull(ship: Ship): HullInfo | null {
    const h = ship.hull;
    return h !== null && h.version === ship.grid.version ? h : analyzeHull(ship.grid);
  }

  private blockUpdateAll(cells: Int32Array, count: number): void {
    const host = this.host;
    for (let i = 0; i < count; i++) host.blockUpdate(cells[i * 3]!, cells[i * 3 + 1]!, cells[i * 3 + 2]!);
  }

  private updateFrozen(): void {
    const world = this.world;
    const ents = this.shipEntries;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      this.computeShipBox(e);
      e.s.frozen = !this.boxLoaded(world, e.box);
    }
    const rotors = this.rotorList;
    for (let i = 0; i < rotors.length; i++) {
      const r = rotors[i]!;
      if (r.parent !== null) {
        r.frozen = r.parent.frozen; // a ship rotor moves with (and stops with) its ship
      } else {
        const e = this.entries.get(r.id)!;
        r.frozen = !this.boxLoaded(world, this.computeRotorBox(e, r));
      }
    }
  }

  private boxLoaded(world: World, b: AABB): boolean {
    return world.isAreaLoaded(b.minX - FREEZE_MARGIN, b.minZ - FREEZE_MARGIN, b.maxX + FREEZE_MARGIN, b.maxZ + FREEZE_MARGIN);
  }

  /** World AABB of a ship's cell box (an OBB): centre +- |R| * half extents. */
  private computeShipBox(e: ShipEntry): void {
    const g = e.s.grid;
    const box = e.box;
    const t = this.tmp;
    const b = g.cellBounds();
    let hx = 0.5;
    let hy = 0.5;
    let hz = 0.5;
    if (b === null) {
      vset(t, g.pivot.x, g.pivot.y, g.pivot.z);
    } else {
      hx = (b.maxX - b.minX) * 0.5;
      hy = (b.maxY - b.minY) * 0.5;
      hz = (b.maxZ - b.minZ) * 0.5;
      vset(t, b.minX + hx, b.minY + hy, b.minZ + hz);
    }
    g.toWorld(t, t);
    const m = qtoMat3(g.rotation, this.mat);
    const ex = Math.abs(m[0]!) * hx + Math.abs(m[1]!) * hy + Math.abs(m[2]!) * hz;
    const ey = Math.abs(m[3]!) * hx + Math.abs(m[4]!) * hy + Math.abs(m[5]!) * hz;
    const ez = Math.abs(m[6]!) * hx + Math.abs(m[7]!) * hy + Math.abs(m[8]!) * hz;
    box.minX = t.x - ex;
    box.minY = t.y - ey;
    box.minZ = t.z - ez;
    box.maxX = t.x + ex;
    box.maxY = t.y + ey;
    box.maxZ = t.z + ez;
  }

  /**
   * World box of a WORLD rotor for the freeze test: the AABB of the cylinder its cells sweep
   * about the spin axis — exactly the union of the rotor's world cell box over a full turn,
   * so it does not change with the angle (no frozen flicker) and a running rotor never turns
   * a blade into an unloaded chunk. A windmill with a horizontal axis needs a thin strip of
   * columns, not the square of a bounding sphere.
   */
  private computeRotorBox(e: Entry, r: Rotor): AABB {
    const g = r.grid;
    if (e.sweepVersion !== g.version) this.measureSweep(e, r);
    // Spin axis (positive direction) in the parent (= world) frame. Taken from baseRotation,
    // not grid.rotation, so the box is bit-identical at every angle.
    const k = r.axis >> 1;
    const a = qrotate(r.baseRotation, vset(this.tmp, k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0), this.tmp);
    const mid = (e.sweepA0 + e.sweepA1) * 0.5;
    const half = (e.sweepA1 - e.sweepA0) * 0.5;
    const rad = e.sweepRadius;
    const p = g.position; // the pivot, in the parent frame
    // AABB of a cylinder: per axis i, half-height * |a_i| + radius * sqrt(1 - a_i^2).
    const ex = half * Math.abs(a.x) + rad * Math.sqrt(Math.max(0, 1 - a.x * a.x));
    const ey = half * Math.abs(a.y) + rad * Math.sqrt(Math.max(0, 1 - a.y * a.y));
    const ez = half * Math.abs(a.z) + rad * Math.sqrt(Math.max(0, 1 - a.z * a.z));
    const box = e.box;
    box.minX = p.x + a.x * mid - ex;
    box.maxX = p.x + a.x * mid + ex;
    box.minY = p.y + a.y * mid - ey;
    box.maxY = p.y + a.y * mid + ey;
    box.minZ = p.z + a.z * mid - ez;
    box.maxZ = p.z + a.z * mid + ez;
    return box;
  }

  /** Rotor-local swept cylinder of the cells (see Entry); recomputed when the cells change. */
  private measureSweep(e: Entry, r: Rotor): void {
    const g = r.grid;
    const k = r.axis >> 1;
    const px = g.pivot.x;
    const py = g.pivot.y;
    const pz = g.pivot.z;
    let a0 = 0;
    let a1 = 0;
    let r2 = 0;
    let first = true;
    // Per cell, the corner farthest from the axis line; per axis, the farther of the two
    // faces. Exact for the cells themselves, unlike the corner of their bounding box.
    g.forEachCell((x, y, z) => {
      const lo = k === 0 ? x - px : k === 1 ? y - py : z - pz;
      if (first || lo < a0) a0 = lo;
      if (first || lo + 1 > a1) a1 = lo + 1;
      first = false;
      const fx = k === 0 ? 0 : Math.max(Math.abs(x - px), Math.abs(x + 1 - px));
      const fy = k === 1 ? 0 : Math.max(Math.abs(y - py), Math.abs(y + 1 - py));
      const fz = k === 2 ? 0 : Math.max(Math.abs(z - pz), Math.abs(z + 1 - pz));
      const d2 = fx * fx + fy * fy + fz * fz;
      if (d2 > r2) r2 = d2;
    });
    e.sweepA0 = a0;
    e.sweepA1 = a1;
    e.sweepRadius = Math.sqrt(r2);
    e.sweepVersion = g.version;
  }
}
