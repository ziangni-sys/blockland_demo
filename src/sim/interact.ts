/**
 * Player interaction: turns the player's input (look direction, button presses, held item)
 * into world changes, and publishes the InteractionView (target, mining progress, assembly
 * preview, docking conflicts, glue state, context hint).
 *
 * Runs in tick step 1 (docs/ARCHITECTURE.md), before block ticks, structures and entities
 * move, so a click acts on exactly what the player saw at the end of the previous tick.
 * The edge counters input.attackPresses / usePresses are consumed here; held buttons are
 * read from input.attack / input.use. A dead player does nothing.
 *
 * RIGHT-CLICK PRIORITY
 *   steering        sneak = dock the steered ship, otherwise let go of the wheel
 *   glue in hand    glue steps (DESIGN 强力胶)
 *   bucket in hand  scoop / pour (world only)
 *   helm            world: preview -> assemble; ship: steer, sneak = dock
 *   bearing         running rotor: stop; else preview -> start
 *   blast crate     light it (unless holding a block item)
 *   block item      place
 * Sneaking with a block item in hand places it even against a world helm or a bearing.
 *
 * All state is on the instance; nothing here is saved (pending glue, previews and mining
 * progress do not survive a reload by design).
 */
import {
  AIR,
  ID_MASK,
  axisState,
  cellState,
  facingState,
  isLiquidSource,
  layersState,
  liquidState,
  makeCell,
  stateLayers,
} from '../blocks/cell';
import { B } from '../blocks/defs';
import { I, isBlockItem } from '../blocks/items';
import { BLOCKS, LIQUID, REPLACEABLE, SOLID, type BlockDef } from '../blocks/registry';
import { TICK_DT, WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, dirAxis, nearestDir, type Dir } from '../core/dirs';
import { aabb, clamp, quat, vec3, type AABB, type Quat, type Vec3 } from '../core/math';
import { Player } from '../entities/entity';
import type { EntityEvent } from '../entities/host';
import { axisValue, finiteAngle } from '../entities/input';
import { canGlue } from '../structures/stick';
import { Ship, type Structure } from '../structures/structure';
import type { CellBounds, VoxelGrid } from '../voxel/grid';
import { placementCell, raycastGrids, targetable, targetableOrLiquidSource, type GridHit } from '../voxel/raycast';
import { CONTACT_EPS, boxOverlapsSolid } from '../voxel/shape';
import type { StructureGrid } from '../voxel/sgrid';
import { spawnBlockDrop } from './drops';
import { failMessage, msg, type MessageKey } from './messages';
import type { Simulation } from './simulation';
import { emptyView, type GridCell, type InteractionView, type Message } from './view';

/** Reach of the player's hands, in blocks from the eye. */
export const REACH = 5;
/** Creative mode: while the attack button stays held, one more block breaks every this many ticks. */
export const CREATIVE_BREAK_INTERVAL = 5;
/** Survival mode: pause after a block broke while the button stays held. */
export const BREAK_COOLDOWN = 5;
/** An assembly preview is dropped after the player looked elsewhere for this many ticks (~1.5 s). */
export const PREVIEW_AWAY_TICKS = 30;
/** Docking conflicts stay highlighted this many ticks (~3 s). */
export const CONFLICT_TICKS = 60;
/**
 * A new block may not sink deeper than this into a hard cell of another grid (a world block
 * into a hull, a hull cell into terrain). Touching, or the slight overlap of a floating hull
 * that has not settled exactly on the lattice, is fine.
 */
export const GRID_OVERLAP_TOLERANCE = 0.1;

/** Cell value the overlap probe reports for its one cell (any HARD block). */
const PROBE_CELL = makeCell(B.STONE);

/**
 * A VoxelGrid view of ONE hard cell of another grid: same transform, nothing else in it.
 * Lets the exact OBB-vs-cell queries of voxel/shape answer "does this box overlap that one
 * (possibly rotated) cell" without a separate code path.
 */
class CellProbe implements VoxelGrid {
  gridId = 0;
  parent: VoxelGrid | null = null;
  readonly isWorld = false;
  private target: VoxelGrid | null = null;
  private x = 0;
  private y = 0;
  private z = 0;
  private readonly bounds: CellBounds = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };

  set(target: VoxelGrid, x: number, y: number, z: number): this {
    this.target = target;
    this.gridId = target.gridId;
    this.parent = target.parent;
    this.x = x;
    this.y = y;
    this.z = z;
    const b = this.bounds;
    b.minX = x;
    b.minY = y;
    b.minZ = z;
    b.maxX = x + 1;
    b.maxY = y + 1;
    b.maxZ = z + 1;
    return this;
  }
  private get t(): VoxelGrid {
    if (this.target === null) throw new Error('CellProbe used before set()');
    return this.target;
  }
  getCell(x: number, y: number, z: number): number {
    return x === this.x && y === this.y && z === this.z ? PROBE_CELL : AIR;
  }
  setCell(): boolean {
    return false;
  }
  toWorld(p: Vec3, out?: Vec3): Vec3 {
    return this.t.toWorld(p, out);
  }
  toLocal(p: Vec3, out?: Vec3): Vec3 {
    return this.t.toLocal(p, out);
  }
  dirToWorld(d: Vec3, out?: Vec3): Vec3 {
    return this.t.dirToWorld(d, out);
  }
  dirToLocal(d: Vec3, out?: Vec3): Vec3 {
    return this.t.dirToLocal(d, out);
  }
  velocityAt(p: Vec3, out?: Vec3): Vec3 {
    return this.t.velocityAt(p, out);
  }
  worldRotation(out?: Quat): Quat {
    return this.t.worldRotation(out);
  }
  cellBounds(): CellBounds {
    return this.bounds;
  }
}

/** A pending assembly (first right-click on a helm or a bearing). */
interface Preview {
  readonly kind: 'ship' | 'rotor';
  /** Grid of the control block (the world for ships; the world or a ship for rotors). */
  readonly grid: VoxelGrid;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Cells that would be taken, x,y,z triples (exactly count of them). */
  readonly cells: Int32Array;
  readonly count: number;
  readonly sails: number;
  /** False when the preview only shows what is there (a rotor with too few sails). */
  readonly startable: boolean;
  /** World cells whose change can alter the result: the collected box grown by one. */
  readonly region: CellBounds | null;
  /** Glue version of the grid, and the grid's cell version (structures), at preview time. */
  readonly glueVersion: number;
  readonly gridVersion: number;
  /** A relevant world cell changed since the preview was made. */
  dirty: boolean;
  /** Consecutive ticks the player looked at something else. */
  awayTicks: number;
}

/** A timed survival glue step in progress (second click held on block B). */
interface GlueOp {
  readonly grid: VoxelGrid;
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  /** Direction from A to B. */
  readonly dir: Dir;
  readonly remove: boolean;
  /** Seconds needed: the slower of the two blocks' mining times. */
  readonly total: number;
  progress: number;
}

interface CellRef {
  readonly grid: VoxelGrid;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function isBucket(item: number): boolean {
  return item === I.BUCKET || item === I.BUCKET_WATER || item === I.BUCKET_LAVA;
}

function isAirOrLiquid(cell: number): boolean {
  const id = cell & ID_MASK;
  return id === AIR || LIQUID[id] !== 0;
}

function supportOk(def: BlockDef, below: number): boolean {
  if (def.support === 'none') return true;
  const id = below & ID_MASK;
  if (def.support === 'solid') return SOLID[id] === 1;
  return id === B.SAND || id === B.CACTUS;
}

function inRegion(r: CellBounds | null, x: number, y: number, z: number): boolean {
  return r !== null && x >= r.minX && x < r.maxX && y >= r.minY && y < r.maxY && z >= r.minZ && z < r.maxZ;
}

function glueVersionOf(sim: Simulation, grid: VoxelGrid): number {
  return sim.structures.glueFor(grid).version;
}

function gridVersionOf(grid: VoxelGrid): number {
  return grid.isWorld ? -1 : (grid as StructureGrid).version;
}

export class Interaction {
  /** What the player pointed at during this tick's actions. */
  private hit: GridHit | null = null;
  /** Hit used for the published view (re-cast after everything moved this tick). */
  private viewHit: GridHit | null = null;
  private lastSlot = -1;

  // ---- mining
  private mineGrid: VoxelGrid | null = null;
  private mineX = 0;
  private mineY = 0;
  private mineZ = 0;
  private mineCell = AIR;
  private mineProgress = 0;
  private breakCooldown = 0;
  private attackingUnbreakable = false;

  // ---- assembly, docking
  private preview: Preview | null = null;
  private conflicts: Array<{ x: number; y: number; z: number }> = [];
  private conflictsUntil = -1;

  // ---- glue
  private glueAnchor: CellRef | null = null;
  private glueOp: GlueOp | null = null;

  // ---- scratch (instance-owned)
  private readonly probe = new CellProbe();
  private readonly box: AABB = aabb();
  private readonly box2: AABB = aabb();
  private readonly eye: Vec3 = vec3();
  private readonly dir: Vec3 = vec3();
  private readonly tmp: Vec3 = vec3();
  private readonly tmpQ: Quat = quat();

  constructor(private readonly sim: Simulation) {}

  // ================================================================== hooks

  onEntityEvent(ev: EntityEvent): void {
    // Death drops everything the hands were doing (the wheel is released by the entities module).
    if (ev.type === 'death' && ev.entity instanceof Player && ev.entity === this.sim.entities.player) this.reset();
  }

  /**
   * World change hook (the simulation's single world listener). Marks the preview stale when
   * the change can matter: any block change, or liquid moving inside the preview's region.
   * Liquid spreading elsewhere cannot change what a helm or a bearing takes along.
   */
  onWorldChange(x: number, y: number, z: number, oldCell: number, newCell: number, _flags: number): void {
    const pv = this.preview;
    if (pv === null || pv.dirty || !pv.grid.isWorld) return;
    if (isAirOrLiquid(oldCell) && isAirOrLiquid(newCell) && !inRegion(pv.region, x, y, z)) return;
    pv.dirty = true;
  }

  /** Forget every pending action (death, loading a save). */
  reset(): void {
    this.hit = null;
    this.viewHit = null;
    this.resetMining();
    this.breakCooldown = 0;
    this.preview = null;
    this.conflicts = [];
    this.conflictsUntil = -1;
    this.glueAnchor = null;
    this.glueOp = null;
  }

  // ================================================================== queries

  /** The cell the player is looking at right now (reach REACH), with the predicate for the held item. */
  raycast(): GridHit | null {
    const p = this.sim.player;
    return this.castRay(p, isBucket(this.heldItem(p)));
  }

  // ================================================================== tick

  tick(): void {
    const sim = this.sim;
    const p = sim.player;
    const input = p.input;
    this.applyLook(p);
    const attackPressed = input.attackPresses > 0;
    const usePressed = input.usePresses > 0;
    input.attackPresses = 0;
    input.usePresses = 0;
    if (p.dead || p.removed) {
      this.reset();
      return;
    }

    const selected = p.inventory.selected;
    if (selected !== this.lastSlot) {
      // Switching the held slot drops what the hands were preparing.
      if (this.lastSlot !== -1) {
        this.preview = null;
        this.glueOp = null;
      }
      this.lastSlot = selected;
    }
    const held = this.heldItem(p);
    if (held !== I.GLUE) {
      this.glueAnchor = null;
      this.glueOp = null;
    }
    this.validate();
    this.steer(p);
    this.hit = this.castRay(p, isBucket(held));
    this.previewLifetime();
    if (usePressed) this.onUse(p, held);
    this.updateGlueOp(p);
    this.updateMining(p, attackPressed);
  }

  buildView(): InteractionView {
    const sim = this.sim;
    const v = emptyView();
    const p = sim.entities.player;
    if (p === null || p.dead || p.removed) {
      this.viewHit = null;
      return v;
    }
    const held = this.heldItem(p);
    const h = this.castRay(p, isBucket(held));
    this.viewHit = h;
    this.validate();
    if (h !== null) {
      v.target = { gridId: h.grid.gridId, x: h.x, y: h.y, z: h.z, face: h.face };
      if (this.mineGrid === h.grid && this.mineX === h.x && this.mineY === h.y && this.mineZ === h.z) {
        v.breakProgress = clamp(this.mineProgress, 0, 1);
      }
    }
    const pv = this.preview;
    if (pv !== null) v.preview = { gridId: pv.grid.gridId, kind: pv.kind, cells: pv.cells };
    if (sim.world.time < this.conflictsUntil) v.conflicts = this.conflicts;
    const a = this.glueAnchor;
    if (a !== null) v.glueAnchor = { gridId: a.grid.gridId, x: a.x, y: a.y, z: a.z };
    const op = this.glueOp;
    if (op !== null) v.glueProgress = op.total > 0 ? clamp(op.progress / op.total, 0, 1) : 1;
    v.hint = this.hintFor(p, h, held);
    return v;
  }

  // ================================================================== per-tick helpers

  /** Look angles and the selected slot come from the input, exactly as the entities module applies them. */
  private applyLook(p: Player): void {
    const input = p.input;
    input.yaw = finiteAngle(input.yaw, p.yaw);
    input.pitch = finiteAngle(input.pitch, p.pitch);
    p.yaw = input.yaw;
    p.pitch = clamp(input.pitch, -Math.PI / 2, Math.PI / 2);
    const slot = Math.floor(input.slot);
    if (slot >= 0 && slot < p.inventory.hotbar.length) p.inventory.selected = slot;
  }

  private heldItem(p: Player): number {
    const s = p.inventory.selectedStack();
    return s !== null && s.count > 0 ? s.item : -1;
  }

  private castRay(p: Player, bucket: boolean): GridHit | null {
    const eye = p.eyePos(this.eye);
    const cp = Math.cos(p.pitch);
    const d = this.dir;
    d.x = -Math.sin(p.yaw) * cp;
    d.y = Math.sin(p.pitch);
    d.z = -Math.cos(p.yaw) * cp;
    return raycastGrids(this.sim.grids(), eye, d, REACH, bucket ? targetableOrLiquidSource : targetable);
  }

  /** Drop state that no longer refers to anything valid. */
  private validate(): void {
    const sim = this.sim;
    const pv = this.preview;
    if (pv !== null) {
      const gone = !pv.grid.isWorld && sim.structures.structureOf(pv.grid) === null;
      if (gone || pv.dirty || glueVersionOf(sim, pv.grid) !== pv.glueVersion || gridVersionOf(pv.grid) !== pv.gridVersion) {
        this.preview = null;
      }
    }
    const a = this.glueAnchor;
    if (a !== null) {
      const gone = !a.grid.isWorld && sim.structures.structureOf(a.grid) === null;
      if (gone || !canGlue(a.grid.getCell(a.x, a.y, a.z))) {
        this.glueAnchor = null;
        this.glueOp = null;
      }
    }
    if (this.conflictsUntil >= 0 && sim.world.time >= this.conflictsUntil) {
      this.conflicts = [];
      this.conflictsUntil = -1;
    }
  }

  /** The helmsman's input drives the ship; a helm that disappeared lets go of the wheel. */
  private steer(p: Player): void {
    const id = p.steeringShipId;
    if (id === 0) return;
    const s = this.sim.structures.get(id);
    if (!(s instanceof Ship) || s.removed) return; // the entities module releases it in syncSeat
    if ((s.grid.getCell(s.helmX, s.helmY, s.helmZ) & ID_MASK) !== B.HELM) {
      this.sim.entities.stopSteering(p);
      return;
    }
    const throttle = axisValue(p.input.forward);
    const rudder = axisValue(p.input.strafe);
    if (throttle !== s.throttle || rudder !== s.rudder) {
      s.throttle = throttle;
      s.rudder = rudder;
      this.sim.dynamics.wake(s);
    }
  }

  private previewLifetime(): void {
    const pv = this.preview;
    if (pv === null) return;
    const h = this.hit;
    if (h !== null && h.grid === pv.grid && h.x === pv.x && h.y === pv.y && h.z === pv.z) {
      pv.awayTicks = 0;
    } else if (++pv.awayTicks > PREVIEW_AWAY_TICKS) {
      this.preview = null;
    }
  }

  // ================================================================== right click

  private onUse(p: Player, held: number): void {
    const sim = this.sim;
    const input = p.input;
    if (p.steeringShipId !== 0) {
      const ship = sim.structures.get(p.steeringShipId);
      if (input.sneak && ship instanceof Ship) this.dock(ship);
      else sim.entities.stopSteering(p);
      return;
    }
    const hit = this.hit;
    if (held === I.GLUE) {
      this.glueClick(p, hit);
      return;
    }
    if (isBucket(held)) {
      this.bucketClick(p, hit, held);
      return;
    }
    if (hit === null) return;
    const id = hit.cell & ID_MASK;
    const holdingBlock = held >= 0 && isBlockItem(held);
    const forcePlace = input.sneak && holdingBlock;
    if (id === B.HELM) {
      if (!hit.grid.isWorld) {
        this.shipHelmClick(p, hit);
        return;
      }
      if (!forcePlace) {
        this.worldHelmClick(p, hit);
        return;
      }
    }
    if (id === B.BEARING && !forcePlace) {
      this.bearingClick(hit);
      return;
    }
    if (id === B.TNT && !holdingBlock) {
      this.ignite(hit);
      return;
    }
    if (holdingBlock) this.place(p, hit, held);
  }

  private toast(message: Message, kind: 'info' | 'warn' | 'error' = 'info'): void {
    this.sim.events.emit({ type: 'toast', message, kind });
  }

  private toastKey(key: MessageKey, kind: 'info' | 'warn' | 'error' = 'info', params?: Record<string, number | string>): void {
    this.toast(msg(key, params), kind);
  }

  /** The structure owning `grid` when it may not be edited right now (a spinning rotor). */
  private locked(grid: VoxelGrid): Structure | null {
    const s = this.sim.structures.structureOf(grid);
    return s !== null && !s.editable ? s : null;
  }

  // ------------------------------------------------------------------ helm

  private worldHelmClick(p: Player, hit: GridHit): void {
    const sim = this.sim;
    const pv = this.preview;
    if (pv !== null && pv.kind === 'ship' && pv.grid === hit.grid && pv.x === hit.x && pv.y === hit.y && pv.z === hit.z) {
      // Second click, nothing relevant changed since the preview (validate() dropped it otherwise).
      this.preview = null;
      const res = sim.structures.assembleShip(hit.x, hit.y, hit.z);
      if (!res.ok) {
        this.toast(failMessage('ship', res.reason, { max: sim.shipMaxCells }), 'warn');
        return;
      }
      const ship = res.structure;
      this.toastKey('toast.ship.assembled', 'info', { count: ship.grid.count });
      // Ship-local coordinates equal world coordinates right after assembly.
      sim.entities.startSteering(p, ship, hit.x, hit.y, hit.z);
      return;
    }
    const res = sim.structures.previewShip(hit.x, hit.y, hit.z);
    if (!res.ok) {
      this.preview = null;
      this.toast(failMessage('ship', res.reason, { max: sim.shipMaxCells }), 'warn');
      return;
    }
    this.setPreview('ship', hit.grid, hit.x, hit.y, hit.z, res.cells, res.count, res.sails, res.bounds, true);
  }

  private shipHelmClick(p: Player, hit: GridHit): void {
    const sim = this.sim;
    const ship = sim.structures.structureOf(hit.grid);
    if (!(ship instanceof Ship)) return;
    if (p.input.sneak) {
      this.dock(ship);
      return;
    }
    if (!sim.entities.startSteering(p, ship, hit.x, hit.y, hit.z)) this.toastKey('toast.helm.taken', 'warn');
  }

  private dock(ship: Ship): void {
    const sim = this.sim;
    const res = sim.structures.dockShip(ship);
    if (!res.ok) {
      if (res.reason === 'tilted') {
        this.toastKey('toast.dock.tilted', 'warn');
      } else {
        this.conflicts = res.conflicts.map((c) => ({ x: c.x, y: c.y, z: c.z }));
        this.conflictsUntil = sim.world.time + CONFLICT_TICKS;
        this.toastKey('toast.dock.blocked', 'warn', { count: res.conflicts.length });
      }
      return;
    }
    this.conflicts = [];
    this.conflictsUntil = -1;
    this.preview = null;
    this.toastKey('toast.dock.done', 'info', { count: res.report.placed });
  }

  // ------------------------------------------------------------------ bearing

  private bearingClick(hit: GridHit): void {
    const sim = this.sim;
    if (this.locked(hit.grid) !== null) {
      this.toastKey('toast.place.spinning', 'warn');
      return;
    }
    const running = sim.structures.rotorAtBearing(hit.grid, hit.x, hit.y, hit.z);
    if (running !== null) {
      sim.structures.stopRotor(running);
      this.preview = null;
      this.toastKey('toast.rotor.stopped');
      return;
    }
    const pv = this.preview;
    if (
      pv !== null &&
      pv.kind === 'rotor' &&
      pv.startable &&
      pv.grid === hit.grid &&
      pv.x === hit.x &&
      pv.y === hit.y &&
      pv.z === hit.z
    ) {
      this.preview = null;
      const res = sim.structures.startRotor(hit.grid, hit.x, hit.y, hit.z);
      if (!res.ok) {
        this.toast(failMessage('rotor', res.reason, this.rotorFailParams(0)), 'warn');
        return;
      }
      this.toastKey('toast.rotor.started', 'info', { count: res.structure.grid.count, sails: res.structure.sails });
      return;
    }
    const res = sim.structures.previewRotor(hit.grid, hit.x, hit.y, hit.z);
    if (res.ok) {
      this.setPreview('rotor', hit.grid, hit.x, hit.y, hit.z, res.cells, res.count, res.sails, res.bounds, true);
      return;
    }
    this.toast(failMessage('rotor', res.reason, this.rotorFailParams(res.sails)), 'warn');
    if (res.reason === 'not_enough_sails' && res.count > 0) {
      // Show what would turn, so the player sees where sails are missing; a second click re-checks.
      this.setPreview('rotor', hit.grid, hit.x, hit.y, hit.z, res.cells, res.count, res.sails, res.bounds, false);
    } else {
      this.preview = null;
    }
  }

  private rotorFailParams(sails: number): Record<string, number> {
    return { max: this.sim.rotorMaxCells, min: this.sim.rotorMinSails, sails };
  }

  private setPreview(
    kind: 'ship' | 'rotor',
    grid: VoxelGrid,
    x: number,
    y: number,
    z: number,
    cells: Int32Array,
    count: number,
    sails: number,
    bounds: CellBounds | null,
    startable: boolean,
  ): void {
    const n = count * 3;
    const own = cells.length === n ? cells.slice() : cells.slice(0, n);
    const region =
      bounds === null
        ? null
        : { minX: bounds.minX - 1, minY: bounds.minY - 1, minZ: bounds.minZ - 1, maxX: bounds.maxX + 1, maxY: bounds.maxY + 1, maxZ: bounds.maxZ + 1 };
    this.preview = {
      kind,
      grid,
      x,
      y,
      z,
      cells: own,
      count,
      sails,
      startable,
      region,
      glueVersion: glueVersionOf(this.sim, grid),
      gridVersion: gridVersionOf(grid),
      dirty: false,
      awayTicks: 0,
    };
  }

  // ------------------------------------------------------------------ blast crate

  private ignite(hit: GridHit): void {
    const sim = this.sim;
    if (this.locked(hit.grid) !== null) {
      this.toastKey('toast.place.spinning', 'warn');
      return;
    }
    const grid = hit.grid;
    if (!grid.setCell(hit.x, hit.y, hit.z, AIR)) return;
    const c = this.tmp;
    c.x = hit.x + 0.5;
    c.y = hit.y + 0.5;
    c.z = hit.z + 0.5;
    grid.toWorld(c, c);
    const tnt = sim.entities.spawnTnt(c.x, c.y, c.z);
    // spawnTnt snaps to the world cell; a crate on a moving or rotated hull starts exactly where it was.
    tnt.setPosition(c.x, c.y - tnt.height * 0.5, c.z);
    sim.events.emit({ type: 'sound', name: 'fuse', x: c.x, y: c.y, z: c.z });
  }

  // ------------------------------------------------------------------ placing

  private place(p: Player, hit: GridHit, item: number): void {
    const sim = this.sim;
    const def = BLOCKS[item];
    if (def === undefined || def.liquid !== 0) return; // liquids are never placed as blocks
    const grid = hit.grid;
    if (this.locked(grid) !== null) {
      this.toastKey('toast.place.spinning', 'warn');
      return;
    }
    const hitId = hit.cell & ID_MASK;
    let x: number;
    let y: number;
    let z: number;
    if (grid.isWorld && REPLACEABLE[hitId] === 1 && LIQUID[hitId] === 0) {
      // Clicking soft cover (a grass tuft, snow) puts the block in its place.
      x = hit.x;
      y = hit.y;
      z = hit.z;
    } else {
      const c = placementCell(hit);
      x = c.x;
      y = c.y;
      z = c.z;
    }
    if (grid.isWorld && (y < 0 || y >= WORLD_HEIGHT || !sim.world.isLoaded(x, z))) return;
    const cur = grid.getCell(x, y, z);
    let cell: number;
    if (item === B.SNOW_LAYER && (cur & ID_MASK) === B.SNOW_LAYER) {
      // Snow cover stacks; eight layers make a packed snow block.
      const layers = stateLayers(cellState(cur)) + 1;
      cell = layers >= 8 ? makeCell(B.SNOW_BLOCK) : makeCell(B.SNOW_LAYER, layersState(layers));
    } else {
      if (grid.isWorld ? REPLACEABLE[cur & ID_MASK] !== 1 : cur !== AIR) return;
      cell = makeCell(item, this.placementState(def, hit, p));
    }
    if (!supportOk(def, grid.getCell(x, y - 1, z))) {
      this.toastKey('toast.place.support', 'warn');
      return;
    }
    if (SOLID[cell & ID_MASK] === 1 && this.placementBlocked(grid, x, y, z)) {
      this.toastKey('toast.place.occupied', 'warn');
      return;
    }
    if (!grid.setCell(x, y, z, cell)) return;
    if (p.mode !== 'creative') p.inventory.consumeSelected(1);
    sim.events.emit({ type: 'blockPlaced', gridId: grid.gridId, x, y, z, cell });
  }

  /** State bits of a newly placed block, in the target grid's local frame. */
  private placementState(def: BlockDef, hit: GridHit, p: Player): number {
    switch (def.stateKind) {
      case 'axis':
        // A log runs along the axis of the face it was put against (side face -> lying log).
        return axisState(dirAxis(hit.face));
      case 'facing': {
        if (def.func === 'helm') {
          // The helm faces where the helmsman will look: the player's horizontal heading,
          // expressed in the grid's frame (a hull may be yawed or slightly tilted).
          const d = this.tmp;
          d.x = -Math.sin(p.yaw);
          d.y = 0;
          d.z = -Math.cos(p.yaw);
          hit.grid.dirToLocal(d, d);
          return facingState(nearestDir(d.x, 0, d.z));
        }
        // Bearings and propellers face away from the clicked block, so their back (the mounting
        // face) sits on it.
        return facingState(hit.face);
      }
      case 'layers':
        return layersState(1);
      default:
        return 0;
    }
  }

  /**
   * Would a HARD block at local cell (x,y,z) of `grid` overlap something? Any entity body but
   * item drops (they are nudged out), tested exactly — for a rotated grid the body is an OBB in
   * its frame — and the hard cells of the other grids beyond GRID_OVERLAP_TOLERANCE.
   */
  private placementBlocked(grid: VoxelGrid, x: number, y: number, z: number): boolean {
    const sim = this.sim;
    const probe = this.probe.set(grid, x, y, z);
    for (const e of sim.entities.all()) {
      if (e.removed || e.kind === 'item') continue;
      if (e instanceof Player && e.dead) continue;
      const b = e.box(this.box);
      if (grid.isWorld) {
        if (
          b.minX < x + 1 - CONTACT_EPS &&
          b.maxX > x + CONTACT_EPS &&
          b.minY < y + 1 - CONTACT_EPS &&
          b.maxY > y + CONTACT_EPS &&
          b.minZ < z + 1 - CONTACT_EPS &&
          b.maxZ > z + CONTACT_EPS
        ) {
          return true;
        }
      } else if (boxOverlapsSolid(probe, b)) {
        return true;
      }
    }
    const tol = GRID_OVERLAP_TOLERANCE;
    if (grid.isWorld) {
      const cb = this.box2;
      cb.minX = x + tol;
      cb.minY = y + tol;
      cb.minZ = z + tol;
      cb.maxX = x + 1 - tol;
      cb.maxY = y + 1 - tol;
      cb.maxZ = z + 1 - tol;
      for (const s of sim.structures.all()) if (boxOverlapsSolid(s.grid, cb)) return true;
      return false;
    }
    // A structure cell against the world's hard cells around its world position.
    const c = this.tmp;
    c.x = x + 0.5;
    c.y = y + 0.5;
    c.z = z + 0.5;
    grid.toWorld(c, c);
    const world = sim.world;
    const cb = this.box2;
    for (let wy = Math.floor(c.y - 0.87); wy <= Math.floor(c.y + 0.87); wy++) {
      for (let wz = Math.floor(c.z - 0.87); wz <= Math.floor(c.z + 0.87); wz++) {
        for (let wx = Math.floor(c.x - 0.87); wx <= Math.floor(c.x + 0.87); wx++) {
          if (SOLID[world.getCell(wx, wy, wz) & ID_MASK] !== 1) continue;
          cb.minX = wx + tol;
          cb.minY = wy + tol;
          cb.minZ = wz + tol;
          cb.maxX = wx + 1 - tol;
          cb.maxY = wy + 1 - tol;
          cb.maxZ = wz + 1 - tol;
          if (boxOverlapsSolid(probe, cb)) return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ buckets

  private bucketClick(p: Player, hit: GridHit | null, held: number): void {
    const sim = this.sim;
    if (hit === null) return;
    // DESIGN 结构体里没有液体: a structure in the way is never looked through.
    if (!hit.grid.isWorld) {
      this.toastKey('toast.bucket.structure', 'warn');
      return;
    }
    const world = sim.world;
    if (held === I.BUCKET) {
      const id = hit.cell & ID_MASK;
      if (LIQUID[id] === 0 || !isLiquidSource(cellState(hit.cell))) return;
      if (!world.setCell(hit.x, hit.y, hit.z, AIR)) return;
      if (p.mode !== 'creative') this.swapHeld(p, id === B.WATER ? I.BUCKET_WATER : I.BUCKET_LAVA);
      sim.events.emit({ type: 'sound', name: 'bucket_fill', x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });
      return;
    }
    const hitId = hit.cell & ID_MASK;
    let x: number;
    let y: number;
    let z: number;
    if (REPLACEABLE[hitId] === 1 && LIQUID[hitId] === 0) {
      x = hit.x;
      y = hit.y;
      z = hit.z;
    } else {
      const c = placementCell(hit);
      x = c.x;
      y = c.y;
      z = c.z;
    }
    if (y < 0 || y >= WORLD_HEIGHT || !world.isLoaded(x, z)) return;
    const cur = world.getCell(x, y, z);
    if (REPLACEABLE[cur & ID_MASK] !== 1) return;
    const source = makeCell(held === I.BUCKET_WATER ? B.WATER : B.LAVA, liquidState(0, false));
    if (!world.setCell(x, y, z, source)) return;
    if (p.mode !== 'creative') this.swapHeld(p, I.BUCKET);
    sim.events.emit({ type: 'sound', name: 'bucket_empty', x: x + 0.5, y: y + 0.5, z: z + 0.5 });
  }

  /** One of the held stack turns into `item` (bucket filled / emptied). */
  private swapHeld(p: Player, item: number): void {
    const inv = p.inventory;
    const s = inv.selectedStack();
    if (s === null) return;
    if (s.count <= 1) {
      inv.hotbar[inv.selected] = { item, count: 1 };
      return;
    }
    inv.consumeSelected(1);
    const left = inv.add(item, 1);
    if (left > 0) this.sim.entities.dropFromPlayer(p, item, left);
  }

  // ------------------------------------------------------------------ glue

  private glueClick(p: Player, hit: GridHit | null): void {
    const sim = this.sim;
    if (hit === null) {
      this.glueAnchor = null;
      this.glueOp = null;
      return;
    }
    if (this.locked(hit.grid) !== null) {
      this.toastKey('toast.glue.spinning', 'warn');
      return;
    }
    if (!canGlue(hit.cell)) {
      // Liquids, soft blocks, unbreakable blocks: anything else clears the selection.
      this.glueAnchor = null;
      this.glueOp = null;
      this.toastKey('toast.glue.cannot', 'warn');
      return;
    }
    const a = this.glueAnchor;
    if (a !== null && a.grid === hit.grid) {
      const dx = hit.x - a.x;
      const dy = hit.y - a.y;
      const dz = hit.z - a.z;
      if (dx === 0 && dy === 0 && dz === 0) {
        // The anchor again: deselect.
        this.glueAnchor = null;
        this.glueOp = null;
        return;
      }
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1) {
        const dir = nearestDir(dx, dy, dz);
        const remove = p.input.sneak;
        const glue = sim.structures.glueFor(hit.grid);
        const glued = glue.has(a.x, a.y, a.z, dir);
        if (remove && !glued) {
          this.toastKey('toast.glue.notGlued', 'warn');
          return;
        }
        if (!remove && glued) {
          this.toastKey('toast.glue.already', 'warn');
          return;
        }
        if (p.mode === 'creative') {
          this.applyGlue(p, hit.grid, a.x, a.y, a.z, dir, remove);
          return;
        }
        if (!remove && p.inventory.count(I.GLUE) < 1) {
          this.toastKey('toast.glue.none', 'warn');
          return;
        }
        const ha = BLOCKS[a.grid.getCell(a.x, a.y, a.z) & ID_MASK]?.hardness ?? 0;
        const hb = BLOCKS[hit.cell & ID_MASK]?.hardness ?? 0;
        this.glueOp = {
          grid: hit.grid,
          ax: a.x,
          ay: a.y,
          az: a.z,
          bx: hit.x,
          by: hit.y,
          bz: hit.z,
          dir,
          remove,
          total: Math.max(ha, hb, 0),
          progress: 0,
        };
        return;
      }
    }
    // First click, or a block that is not next to the anchor: (re)pick the anchor.
    this.glueAnchor = { grid: hit.grid, x: hit.x, y: hit.y, z: hit.z };
    this.glueOp = null;
  }

  /** Survival glue step: progresses while use stays held on block B; looking away or letting go cancels. */
  private updateGlueOp(p: Player): void {
    const op = this.glueOp;
    if (op === null) return;
    const h = this.hit;
    if (
      !p.input.use ||
      h === null ||
      h.grid !== op.grid ||
      h.x !== op.bx ||
      h.y !== op.by ||
      h.z !== op.bz ||
      this.locked(op.grid) !== null ||
      !canGlue(h.cell)
    ) {
      this.glueOp = null; // cancelled; the anchor stays picked
      return;
    }
    op.progress += TICK_DT;
    if (op.progress < op.total - 1e-9) return;
    this.glueOp = null;
    this.applyGlue(p, op.grid, op.ax, op.ay, op.az, op.dir, op.remove);
  }

  private applyGlue(p: Player, grid: VoxelGrid, x: number, y: number, z: number, dir: Dir, remove: boolean): void {
    const sim = this.sim;
    const glue = sim.structures.glueFor(grid);
    if (remove) {
      if (glue.remove(x, y, z, dir)) this.toastKey('toast.glue.removed');
    } else {
      if (p.mode !== 'creative' && !p.inventory.consume(I.GLUE, 1)) {
        this.toastKey('toast.glue.none', 'warn');
        return;
      }
      if (glue.add(x, y, z, dir)) this.toastKey('toast.glue.added');
    }
    this.glueAnchor = null;
    const c = this.tmp;
    c.x = x + 0.5 + DIR_X[dir]! * 0.5;
    c.y = y + 0.5 + DIR_Y[dir]! * 0.5;
    c.z = z + 0.5 + DIR_Z[dir]! * 0.5;
    grid.toWorld(c, c);
    sim.events.emit({ type: 'sound', name: remove ? 'unglue' : 'glue', x: c.x, y: c.y, z: c.z });
  }

  // ================================================================== left click

  private resetMining(): void {
    this.mineGrid = null;
    this.mineProgress = 0;
    this.mineCell = AIR;
  }

  private updateMining(p: Player, pressed: boolean): void {
    const input = p.input;
    const hit = this.hit;
    if (this.breakCooldown > 0) this.breakCooldown--;
    this.attackingUnbreakable = false;
    if (!(input.attack || pressed) || hit === null) {
      this.resetMining();
      return;
    }
    if (this.locked(hit.grid) !== null) {
      this.resetMining();
      return;
    }
    const def = BLOCKS[hit.cell & ID_MASK];
    if (def === undefined || def.unbreakable || !(def.hardness < Infinity)) {
      this.resetMining();
      this.attackingUnbreakable = true;
      return;
    }
    if (p.mode === 'creative') {
      // Instant on the press, then one block every CREATIVE_BREAK_INTERVAL ticks while held.
      this.resetMining();
      if (pressed || this.breakCooldown === 0) {
        this.breakBlock(hit);
        this.breakCooldown = CREATIVE_BREAK_INTERVAL;
      }
      return;
    }
    if (pressed) this.breakCooldown = 0;
    if (this.mineGrid !== hit.grid || this.mineX !== hit.x || this.mineY !== hit.y || this.mineZ !== hit.z || this.mineCell !== hit.cell) {
      this.mineGrid = hit.grid;
      this.mineX = hit.x;
      this.mineY = hit.y;
      this.mineZ = hit.z;
      this.mineCell = hit.cell;
      this.mineProgress = 0;
    }
    if (this.breakCooldown > 0) return;
    this.mineProgress += def.hardness > 0 ? TICK_DT / def.hardness : 1;
    if (this.mineProgress < 1 - 1e-9) return;
    this.resetMining();
    this.breakBlock(hit);
    this.breakCooldown = BREAK_COOLDOWN;
  }

  /** Remove the hit cell from its grid; drop its item in survival (world position of the cell). */
  private breakBlock(hit: GridHit): void {
    const sim = this.sim;
    const grid = hit.grid;
    const { x, y, z } = hit;
    const cell = grid.getCell(x, y, z);
    if (cell === AIR) return;
    // The wheel of a helm that is being broken lets go first.
    if ((cell & ID_MASK) === B.HELM && !grid.isWorld) {
      const ship = sim.structures.structureOf(grid);
      if (ship instanceof Ship && ship.helmsmanId !== 0 && ship.helmX === x && ship.helmY === y && ship.helmZ === z) {
        const helmsman = sim.entities.get(ship.helmsmanId);
        if (helmsman instanceof Player) sim.entities.stopSteering(helmsman);
      }
    }
    if (!grid.setCell(x, y, z, AIR)) return;
    spawnBlockDrop(sim, grid, x, y, z, cell, this.tmp);
    sim.events.emit({ type: 'blockBroken', gridId: grid.gridId, x, y, z, cell });
  }

  // ================================================================== hints

  private hintFor(p: Player, h: GridHit | null, held: number): Message | null {
    const sim = this.sim;
    if (p.steeringShipId !== 0) return msg('hint.steering');
    const op = this.glueOp;
    if (op !== null) return msg(op.remove ? 'hint.glue.unglueWorking' : 'hint.glue.working');
    if (h === null) return null;
    if (this.locked(h.grid) !== null) return msg('hint.rotor.spinning');
    if (held === I.GLUE) return this.glueHint(p, h);
    if (isBucket(held) && !h.grid.isWorld) return msg('hint.bucket.structure');
    const id = h.cell & ID_MASK;
    const holdingBlock = held >= 0 && isBlockItem(held);
    const forcePlace = p.input.sneak && holdingBlock;
    const pv = this.preview;
    const isPreviewed = pv !== null && pv.grid === h.grid && pv.x === h.x && pv.y === h.y && pv.z === h.z;
    if (id === B.HELM && !isBucket(held)) {
      if (!h.grid.isWorld) return msg('hint.helm.steer');
      if (!forcePlace) return isPreviewed && pv.kind === 'ship' ? msg('hint.helm.assemble', { count: pv.count }) : msg('hint.helm.preview');
    }
    if (id === B.BEARING && !forcePlace && !isBucket(held)) {
      if (sim.structures.rotorAtBearing(h.grid, h.x, h.y, h.z) !== null) return msg('hint.bearing.stop');
      if (isPreviewed && pv.kind === 'rotor' && pv.startable) return msg('hint.bearing.start', { count: pv.count, sails: pv.sails });
      return msg('hint.bearing.preview');
    }
    if (id === B.TNT && !holdingBlock && !isBucket(held)) return msg('hint.tnt.ignite');
    if (this.attackingUnbreakable) return msg('hint.unbreakable');
    return null;
  }

  private glueHint(p: Player, h: GridHit): Message {
    if (!canGlue(h.cell)) return msg('hint.glue.cannot');
    const a = this.glueAnchor;
    if (a === null) return msg('hint.glue.first');
    if (a.grid === h.grid) {
      const dx = h.x - a.x;
      const dy = h.y - a.y;
      const dz = h.z - a.z;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1) {
        const glued = this.sim.structures.glueFor(h.grid).has(a.x, a.y, a.z, nearestDir(dx, dy, dz));
        if (p.input.sneak) return msg(glued ? 'hint.glue.remove' : 'hint.glue.notGlued');
        return msg(glued ? 'hint.glue.already' : 'hint.glue.apply');
      }
      if (dx === 0 && dy === 0 && dz === 0) return msg('hint.glue.first');
    }
    return msg('hint.glue.move');
  }
}

/** A GridCell of the current target (exported for tests and tools). */
export function gridCellOf(hit: GridHit): GridCell {
  return { gridId: hit.grid.gridId, x: hit.x, y: hit.y, z: hit.z };
}
