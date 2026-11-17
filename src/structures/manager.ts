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
 *  - glue: a cell removed or replaced by another block id loses its glue (任一侧方块被移除或替换，
 *    胶就消失) — except bulk moves flagged SET_STRUCTURE_MOVE, which transfer glue themselves;
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
import { TICK_DT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z } from '../core/dirs';
import { aabb, qidentity, qtoMat3, vec3, vset, type AABB } from '../core/math';
import type { ByteReader, ByteWriter } from '../save/bytes';
import { SET_STRUCTURE_MOVE, type VoxelGrid } from '../voxel/grid';
import type { World } from '../voxel/world';
import {
  blockifyGrid,
  commitDock,
  emptyReport,
  hullCavityCells,
  identityMap,
  planDock,
  refillWater,
  remountRotor,
  restoreHubGlue,
  rotorSnap,
  transferCells,
  type BlockifyReport,
  type DockPlan,
} from './assembly';
import { CellSet, collectRotor, collectShip, type CollectReason, type CollectResult } from './collect';
import type { GlueStore } from './glue';
import { analyzeHull, type HullInfo } from './hull';
import { advanceRotor, applyRotorPose, holdRotor } from './rotor';
import { readStructures, writeStructures } from './serialize';
import { isSailCell } from './stick';
import { Rotor, Ship, type ShipDynamics, type Structure, type StructureHost } from './structure';

export type { BlockifyReport } from './assembly';

/**
 * Why an assembly was refused: a CollectResult reason, or
 *  - 'not_world'    the grid is neither this manager's world nor one of its live ships;
 *  - 'nested_rotor' the bearing is inside a rotor (rotors never carry rotors);
 *  - 'has_rotor'    a rotor already runs on that bearing;
 *  - 'unloaded'     the structure touches a chunk that is not loaded, so part of it might be
 *                   missing (collect never crosses into unloaded chunks).
 */
export type AssembleFailure = CollectReason | 'not_world' | 'has_rotor' | 'nested_rotor' | 'unloaded';

export type AssembleResult<T> = { ok: true; structure: T } | { ok: false; reason: AssembleFailure };

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
  /** World-space box: ships' hull box, refreshed every step (wake / freeze tests). */
  readonly box: AABB;
}
type ShipEntry = Entry & { readonly s: Ship };

function noop(): void {}

function fail<T>(reason: AssembleFailure): AssembleResult<T> {
  return { ok: false, reason };
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
  // Scratch for the per-tick box maths only (never used across a call that can re-enter).
  private readonly mat = new Float64Array(9);
  private readonly tmp = vec3();
  private readonly tmpBox = aabb();

  constructor(host: StructureHost, dynamics: ShipDynamics | null = null) {
    this.host = host;
    this.world = host.world;
    this.dynamics = dynamics;
    this.unsubWorld = host.world.onCellChange(this.onWorldCell);
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
  /** What a bearing at (x,y,z) of `grid` (the world or a ship) would spin. Changes nothing. */
  previewRotor(grid: VoxelGrid, x: number, y: number, z: number): CollectResult {
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
    const res = collectShip(world, host.worldGlue, x, y, z);
    if (!res.ok) return fail(res.reason);
    if (!this.collectedLoaded(res)) return fail('unloaded');

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
    transferCells(world, ship.grid, res.cells, res.count, res.bounds);
    host.worldGlue.moveTo(ship.glue, (gx, gy, gz) => inSet.has(gx, gy, gz), identityMap());
    this.register(ship);

    const dyn = this.dynamics;
    if (dyn !== null) {
      dyn.refresh(ship);
    } else {
      const h = analyzeHull(ship.grid);
      if (h !== null) {
        ship.grid.pivot.x = h.com.x;
        ship.grid.pivot.y = h.com.y;
        ship.grid.pivot.z = h.com.z;
      }
      ship.grid.setPoseImmediate(ship.grid.pivot, qidentity());
    }

    // DESIGN 水的处理: the vacated footprint and the hull's cavities refill from the sea.
    const hull = this.currentHull(ship);
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
    let ship: Ship | null = null;
    if (grid !== this.world) {
      const s = this.structureOf(grid);
      if (s instanceof Rotor) return fail('nested_rotor');
      if (!(s instanceof Ship)) return fail('not_world');
      ship = s;
    }
    if (this.rotorAtBearing(grid, x, y, z) !== null) return fail('has_rotor');
    const glue = this.glueFor(grid);
    const res = collectRotor(grid, glue, x, y, z);
    if (!res.ok) return fail(res.reason);
    if (ship === null && !this.collectedLoaded(res)) return fail('unloaded');

    const facing = stateFacing(cellState(grid.getCell(x, y, z)));
    const rotor = new Rotor(this.nextId++, grid);
    rotor.parent = ship;
    rotor.bearingX = x;
    rotor.bearingY = y;
    rotor.bearingZ = z;
    rotor.axis = facing;
    rotor.sails = res.sails;
    // LESSONS 风车停下后轴心和轴承之间的胶没了: remember it, it comes back on stop.
    rotor.hubGlue = glue.remove(x, y, z, facing);
    const g = rotor.grid;
    vset(g.pivot, x + DIR_X[facing]! + 0.5, y + DIR_Y[facing]! + 0.5, z + DIR_Z[facing]! + 0.5);
    g.setPoseImmediate(g.pivot, qidentity());

    const inSet = CellSet.fromCells(res.cells, res.count);
    transferCells(grid, g, res.cells, res.count, res.bounds);
    glue.moveTo(rotor.glue, (gx, gy, gz) => inSet.has(gx, gy, gz), identityMap());
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
    // Unregister first: the writes below run the parent grid's hooks (and any listener the
    // host attached), which must no longer see this rotor as running.
    this.detachRotor(rotor);
    this.unregister(rotor);
    const out = blockifyGrid(this.host, rotor.grid, rotor.glue, dst, dstGlue, t, ship !== null);
    if (rotor.hubGlue) restoreHubGlue(dst, dstGlue, rotor, t, out.placedSrc);
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
    for (let i = 0; i < children.length; i++) {
      const r = children[i]!;
      if (!this.isLive(r)) continue;
      remountRotor(r, plan.t, this.world);
      r.parent = null;
      this.worldRotors.push(r);
    }
    this.blockUpdateAll(out.touched, out.touched.length / 3);
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
    } else {
      this.removeDestroyed();
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
    for (const e of this.entries.values()) {
      e.unsub();
      e.unsub = noop;
    }
  }

  // ------------------------------------------------------------ hooks

  private readonly onWorldCell = (x: number, y: number, z: number, oldCell: number, newCell: number, flags: number): void => {
    const oldId = oldCell & ID_MASK;
    if ((flags & SET_STRUCTURE_MOVE) === 0 && oldId !== (newCell & ID_MASK)) {
      const glue = this.host.worldGlue;
      if (glue.size > 0) glue.removeAllAt(x, y, z);
    }
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

  private watchShip(ship: Ship): () => void {
    return ship.grid.onCellChange((x, y, z, oldCell, newCell, flags) => {
      const oldId = oldCell & ID_MASK;
      if ((flags & SET_STRUCTURE_MOVE) === 0 && oldId !== (newCell & ID_MASK) && ship.glue.size > 0) {
        ship.glue.removeAllAt(x, y, z);
      }
      if (oldId === BEARING_ID && ship.children.length > 0) this.bearingChanged(ship.children, x, y, z, oldCell, newCell);
    });
  }

  private watchRotor(rotor: Rotor): () => void {
    return rotor.grid.onCellChange((x, y, z, oldCell, newCell, flags) => {
      if ((flags & SET_STRUCTURE_MOVE) === 0 && (oldCell & ID_MASK) !== (newCell & ID_MASK) && rotor.glue.size > 0) {
        rotor.glue.removeAllAt(x, y, z);
      }
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
      if (this.batchDepth > 0) {
        if (!this.pending.includes(r)) this.pending.push(r);
      } else {
        this.stopRotor(r);
      }
      return; // one rotor per bearing; `list` may have changed under us
    }
  }

  // ------------------------------------------------------------ registry

  private register(s: Structure): void {
    const unsub = s instanceof Ship ? this.watchShip(s) : this.watchRotor(s as Rotor);
    const e: Entry = { s, unsub, box: aabb() };
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

  /** Are all chunks around a world collect result loaded (so nothing was cut off)? */
  private collectedLoaded(res: CollectResult): boolean {
    const b = res.bounds;
    return b === null || this.world.isAreaLoaded(b.minX - 1, b.minZ - 1, b.maxX, b.maxZ);
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
        r.frozen = !this.boxLoaded(world, this.rotorBox(r, this.tmpBox));
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

  /** World box of everything a world rotor can sweep: a sphere about its pivot. */
  private rotorBox(r: Rotor, out: AABB): AABB {
    const g = r.grid;
    const p = g.pivot;
    const b = g.cellBounds();
    let radius = 0.87;
    if (b !== null) {
      const dx = Math.max(Math.abs(b.minX - p.x), Math.abs(b.maxX - p.x));
      const dy = Math.max(Math.abs(b.minY - p.y), Math.abs(b.maxY - p.y));
      const dz = Math.max(Math.abs(b.minZ - p.z), Math.abs(b.maxZ - p.z));
      radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const c = g.toWorld(vset(this.tmp, p.x, p.y, p.z), this.tmp);
    out.minX = c.x - radius;
    out.minY = c.y - radius;
    out.minZ = c.z - radius;
    out.maxX = c.x + radius;
    out.maxY = c.y + radius;
    out.maxZ = c.z + radius;
    return out;
  }
}
