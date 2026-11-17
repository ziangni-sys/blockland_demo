/**
 * Player interaction: turns each player's input (look direction, button presses, held item,
 * off-hand swaps) into world changes, and publishes that player's InteractionView (target, mining
 * progress, assembly preview, docking conflicts, glue progress, context hint).
 *
 * PER PLAYER. Everything the hands are doing (ray hits, mining progress and cooldowns, the
 * assembly preview, docking conflicts, the timed glue operation, the last slot) lives in one
 * Hands object per joined player. Interaction runs them in tick step 1 (docs/ARCHITECTURE.md),
 * before block ticks, structures and entities move, so a click acts on exactly what the player
 * saw at the end of the previous tick. Players act one after another in ascending entity id
 * order: two players clicking in the same tick never act on the same snapshot — the second sees
 * the world the first left behind (a block the first mined is gone, a helm the first assembled is
 * a ship). Any world change marks EVERY player's preview stale.
 * The edge counters input.attackPresses / usePresses / swapPresses are consumed here; held
 * buttons are read from input.attack / input.use. A dead player does nothing.
 *
 * GLUE (DESIGN 强力胶). Glue belongs to a face. With glue in the main hand, a right-click on a
 * glueable block glues the face the use ray hit (between the block and its neighbour along the
 * hit normal): at once in creative, in survival after holding the button on that same face for
 * the block's mining time (looking away, letting go, changing the slot or swapping hands
 * cancels; 1 glue is used on completion). Sneak + right-click removes the glue of the hit face
 * at once. With glue in the OFF-HAND, a block the main hand places against a face gets that
 * face glued (offhandGlue).
 *
 * RIGHT-CLICK PRIORITY
 *   steering        sneak = dock the steered ship, otherwise let go of the wheel
 *   glue in hand    apply / remove the glue of the hit face (DESIGN 强力胶)
 *   bucket in hand  scoop / pour (world only)
 *   helm            world: preview -> assemble; ship: steer, sneak = dock
 *   bearing         running rotor: stop; else preview -> start
 *   blast crate     light it (unless holding a block item)
 *   block item      place
 * Sneaking with a block item in hand places it against ANY helm (world or ship) or bearing:
 * building while sneaking along a deck must never dock the whole ship by accident. Docking
 * from the helm therefore takes sneak + right-click with an EMPTY hand (glue and buckets are handled before the helm);
 * from the wheel (steering) sneak + right-click docks whatever is in hand.
 *
 * TWO RAYS. The use ray (outline, right-click, glue) depends on the held item (useRayOf). It is
 * the bucket ray while a bucket is held: it stops at liquid sources, except world liquid
 * displaced by a ship's hull (the water the renderer cuts out of a floating hold) — DESIGN
 * 结构体里没有液体: a bucket never reaches world water inside or behind a structure. It is the
 * glue ray while glue is held: it passes through soft blocks (torches, plants, snow cover), which
 * can carry no glue, and stops at the first HARD block, so every glued face the client draws as
 * exposed (DESIGN 强力胶: 露出的胶面) can be clicked from its open side. The mining ray is always the
 * plain ray: a left-click with a bucket in hand digs the block under the water, one with glue in
 * hand breaks the torch in front of the block like any other.
 *
 * STALE HITS. Both rays are cast before the right-click runs. The right-click may remove what
 * they hit (docking turns the ship into world blocks, a crate is lit), so they are checked again
 * before the left-click and the glue operation use them: a hit on a structure that is gone, or
 * on a cell that is no longer targetable, is dropped for this tick.
 *
 * All state is on the instances; nothing here is saved (a timed glue operation, previews and
 * mining progress do not survive a reload or a rejoin by design).
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
import { I, isBlockItem, type ItemStack } from '../blocks/items';
import { BLOCKS, LIQUID, REPLACEABLE, SOLID, type BlockDef } from '../blocks/registry';
import { TICK_DT, WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, NX, NY, NZ, PX, PY, PZ, dirAxis, nearestDir, type Dir } from '../core/dirs';
import { aabb, clamp, vec3, type AABB, type Quat, type Vec3 } from '../core/math';
import { Player } from '../entities/entity';
import type { EntityEvent } from '../entities/host';
import { maxStackOf } from '../entities/inventory';
import { axisValue, finiteAngle } from '../entities/input';
import { boxCellsWith } from '../structures/collect';
import { analyzeHull, isDryCell, type HullInfo } from '../structures/hull';
import { canGlue, canJoinStructure, sticksWithoutGlue } from '../structures/stick';
import { Ship, type Structure } from '../structures/structure';
import type { CellBounds, VoxelGrid } from '../voxel/grid';
import {
  placementCell,
  raycastGrid,
  raycastGrids,
  targetable,
  targetableOrLiquidSource,
  type CellPredicate,
  type GridHit,
} from '../voxel/raycast';
import { CONTACT_EPS, boxOverlapsSolid } from '../voxel/shape';
import type { StructureGrid } from '../voxel/sgrid';
import { spawnBlockDrop } from './drops';
import { failMessage, msg, type MessageKey } from './messages';
import type { Simulation } from './simulation';
import { emptyView, type InteractionView, type Message, type PlayerKey } from './view';

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
 * Spacing (blocks) of the points at which the bucket ray tests whether the world liquid it
 * crosses is displaced by a hull. Hull cells are a block wide, so a sliver of visible water
 * thinner than this is the most that can be missed.
 */
const HULL_SAMPLE = 1 / 16;
/** Hidden liquid cells the bucket ray may skip; a REACH-long ray crosses far fewer cells. */
const MAX_HIDDEN_SKIPS = 32;
/** The bucket ray resumes this far past the exit of a hidden liquid cell. */
const SKIP_EPS = 1e-7;

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

/** A timed survival glue operation in progress (use held on one face of one block). */
interface GlueOp {
  readonly grid: VoxelGrid;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The glued face: towards the neighbour the ray came from. */
  readonly face: Dir;
  /** The block's cell value when the operation started: any change cancels it (like mining). */
  readonly cell: number;
  /** Seconds needed: the block's survival mining time. */
  readonly total: number;
  progress: number;
}

function isBucket(item: number): boolean {
  return item === I.BUCKET || item === I.BUCKET_WATER || item === I.BUCKET_LAVA;
}

/** Which use ray the held item casts (see TWO RAYS in the header). */
type UseRay = 'plain' | 'bucket' | 'glue';

function useRayOf(item: number): UseRay {
  return isBucket(item) ? 'bucket' : item === I.GLUE ? 'glue' : 'plain';
}

/** The glue ray's cells: targetable and HARD (soft blocks carry no glue and are passed through). */
const glueTargetable: CellPredicate = (cell) => targetable(cell) && SOLID[cell & ID_MASK] === 1;

/** What a hit of the use ray `ray` must still be after the right-click (STALE HITS). */
function usePredicate(ray: UseRay): CellPredicate {
  return ray === 'bucket' ? targetableOrLiquidSource : ray === 'glue' ? glueTargetable : targetable;
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

/** One player's hands: what that player is doing with them, and what it looks like (the view). */
export class Hands {
  /** What the hands look like after the last tick (overlays, hint). Rebuilt every tick. */
  view: InteractionView = emptyView();
  /** What the use ray (outline, right-click, glue) hit during this tick's actions. */
  private hit: GridHit | null = null;
  /** What the mining ray hit during this tick's actions (the same object while the use ray is the plain ray). */
  private mineHit: GridHit | null = null;
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
  private glueOp: GlueOp | null = null;

  // ---- scratch (instance-owned)
  private readonly probe = new CellProbe();
  private readonly box: AABB = aabb();
  private readonly box2: AABB = aabb();
  private readonly eye: Vec3 = vec3();
  private readonly dir: Vec3 = vec3();
  private readonly tmp: Vec3 = vec3();
  // bucket ray scratch
  private readonly rayFrom: Vec3 = vec3();
  private readonly sample: Vec3 = vec3();
  private readonly sampleLocal: Vec3 = vec3();
  private exitT = 0;
  private exitFace: Dir = PX;

  constructor(
    private readonly sim: Simulation,
    private readonly system: Interaction,
    /** The player these hands belong to (the entity of one join). */
    readonly player: Player,
    readonly key: PlayerKey,
  ) {}

  // ================================================================== hooks

  /**
   * World change hook (through Interaction). Marks the preview stale when the change can
   * matter: any block change, or liquid moving inside the preview's region. Liquid spreading
   * elsewhere cannot change what a helm or a bearing takes along.
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
    this.mineHit = null;
    this.resetMining();
    this.breakCooldown = 0;
    this.preview = null;
    this.conflicts = [];
    this.conflictsUntil = -1;
    this.glueOp = null;
  }

  // ================================================================== queries

  /**
   * The cell the player is looking at right now (reach REACH) with the use ray of the held
   * item — what a right-click would act on and what the outline shows.
   */
  raycast(): GridHit | null {
    const p = this.player;
    return this.castRay(p, useRayOf(this.heldItem(p)));
  }

  /** The cell a left-click would mine right now (never a liquid, whatever is held). */
  raycastMining(): GridHit | null {
    return this.castRay(this.player, 'plain');
  }

  // ================================================================== pick block

  /**
   * Pick block (middle click): put the block the player looks at in hand. The target is the use
   * ray's cell (what the outline shows), on the world or a structure; air, liquids and the
   * unloaded sentinel pick nothing. The item is the block itself (block id == item id), never
   * its mining drop.
   *
   *  - Already in the hotbar: that slot is selected (the selected slot first, if it holds it).
   *  - Creative, not in the hotbar: a full stack goes into the selected slot when it is empty,
   *    else into the first empty hotbar slot (selected), else it replaces the selected slot.
   *  - Survival, only in the backpack: that stack swaps places with the selected hotbar slot.
   *    No items are ever created; with none at all nothing happens (false).
   *
   * The selection is written to input.slot too, which the next tick applies (applyLook): the
   * caller that drives input.slot (the client) must adopt inventory.selected afterwards.
   * Runs between ticks with the look of the last tick, so it acts on what the outline shows.
   * Returns true when the block is in hand afterwards.
   */
  pickBlock(): boolean {
    const p = this.player;
    if (p.dead || p.removed) return false;
    const h = this.castRay(p, useRayOf(this.heldItem(p)));
    if (h === null) return false;
    const id = h.cell & ID_MASK;
    if (id === AIR || id === B.UNLOADED || LIQUID[id] !== 0 || !isBlockItem(id)) return false;
    const inv = p.inventory;
    const holds = (s: ItemStack | null | undefined): boolean => s != null && s.count > 0 && s.item === id;
    const empty = (s: ItemStack | null | undefined): boolean => s == null || s.count <= 0;
    let slot = holds(inv.hotbar[inv.selected]) ? inv.selected : inv.hotbar.findIndex(holds);
    if (slot < 0) {
      if (p.mode === 'creative') {
        slot = empty(inv.hotbar[inv.selected]) ? inv.selected : inv.hotbar.findIndex(empty);
        if (slot < 0) slot = inv.selected;
        inv.hotbar[slot] = { item: id, count: maxStackOf(id) };
      } else {
        const j = inv.main.findIndex(holds);
        if (j < 0) return false;
        slot = inv.selected;
        const cur = inv.hotbar[slot] ?? null;
        inv.hotbar[slot] = inv.main[j]!;
        inv.main[j] = empty(cur) ? null : cur;
      }
    }
    inv.selected = slot;
    p.input.slot = slot;
    return true;
  }

  // ================================================================== tick

  tick(): void {
    const p = this.player;
    const input = p.input;
    this.applyLook(p);
    const attackPressed = input.attackPresses > 0;
    const usePressed = input.usePresses > 0;
    const swaps = input.swapPresses;
    input.attackPresses = 0;
    input.usePresses = 0;
    input.swapPresses = 0;
    if (p.dead || p.removed) {
      this.reset();
      return;
    }

    const selected = p.inventory.selected;
    if (selected !== this.lastSlot) {
      // Switching the held slot drops what the hands were preparing.
      if (this.lastSlot !== -1) this.dropPrepared();
      this.lastSlot = selected;
    }
    if (swaps > 0) {
      // DESIGN 副手: swap the selected hotbar stack with the off-hand stack (two presses in one
      // tick swap back). Like changing the slot, it drops what the hands were preparing.
      if ((swaps & 1) === 1) p.inventory.swapOffhand();
      this.dropPrepared();
    }
    const held = this.heldItem(p);
    if (held !== I.GLUE) this.glueOp = null;
    this.validate();
    this.steer(p);
    const ray = useRayOf(held);
    this.hit = this.castRay(p, ray);
    this.mineHit = ray !== 'plain' ? this.castRay(p, 'plain') : this.hit;
    this.previewLifetime();
    if (usePressed) {
      this.onUse(p, held);
      // See STALE HITS in the header.
      this.hit = this.recheck(this.hit, usePredicate(ray));
      this.mineHit = ray !== 'plain' ? this.recheck(this.mineHit, targetable) : this.hit;
    }
    this.updateGlueOp(p);
    this.updateMining(p, attackPressed);
  }

  /** What the hands were preparing (an assembly preview, a timed glue operation) is dropped. */
  private dropPrepared(): void {
    this.preview = null;
    this.glueOp = null;
  }

  buildView(): InteractionView {
    const sim = this.sim;
    const v = emptyView();
    const p = this.player;
    if (p.dead || p.removed) return v;
    const held = this.heldItem(p);
    const ray = useRayOf(held);
    // Cast again: structures and the player moved since the actions ran, and the outline and
    // hint must match what is on screen now.
    const h = this.castRay(p, ray);
    this.validate();
    // The outline shows what a right-click would act on — except while the player digs with a
    // bucket or glue in hand, when it follows the block being dug (under the water, the torch in
    // front of a block) so the cracks show.
    let shown = h;
    if (ray !== 'plain' && this.mineGrid !== null) {
      const m = this.castRay(p, 'plain');
      if (m !== null && this.isMineCell(m)) shown = m;
    }
    if (shown !== null) {
      v.target = { gridId: shown.grid.gridId, x: shown.x, y: shown.y, z: shown.z, face: shown.face };
      if (this.isMineCell(shown)) v.breakProgress = clamp(this.mineProgress, 0, 1);
    }
    const pv = this.preview;
    if (pv !== null) v.preview = { gridId: pv.grid.gridId, kind: pv.kind, cells: pv.cells };
    if (sim.world.time < this.conflictsUntil) v.conflicts = this.conflicts;
    v.glueProgress = this.glueProgress();
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

  private castRay(p: Player, ray: UseRay): GridHit | null {
    const eye = p.eyePos(this.eye);
    const cp = Math.cos(p.pitch);
    const d = this.dir;
    d.x = -Math.sin(p.yaw) * cp;
    d.y = Math.sin(p.pitch);
    d.z = -Math.cos(p.yaw) * cp;
    if (ray === 'bucket') return this.bucketRay(eye, d);
    return raycastGrids(this.sim.grids(), eye, d, REACH, ray === 'glue' ? glueTargetable : targetable);
  }

  /**
   * The bucket's ray: the nearest structure block, world block or world liquid SOURCE within
   * REACH — where world liquid displaced by a ship's hull (inside one of its HARD cells or its
   * dry hold; LESSONS 船舱里冒出水面: that water is never deleted, only hidden) does not count:
   * the ray goes on through it, to the hull or to whatever lies beyond. Where a structure block
   * and world liquid start at the same distance, the structure wins. World blocks keep the tie
   * rule of raycastGrids (the world first).
   */
  private bucketRay(eye: Vec3, dir: Vec3): GridHit | null {
    const sim = this.sim;
    // Structures hold no liquid: for them the bucket ray is the plain ray.
    let best: GridHit | null = null;
    let limit = REACH;
    const structures = sim.structures.all();
    for (let i = 0; i < structures.length; i++) {
      const h = raycastGrid(structures[i]!.grid, eye, dir, limit, targetable);
      if (h !== null && (best === null || h.dist < best.dist)) {
        best = h;
        limit = h.dist;
      }
    }
    const world = sim.world;
    const o = this.rayFrom;
    let from = 0;
    for (let skips = 0; skips <= MAX_HIDDEN_SKIPS; skips++) {
      o.x = eye.x + dir.x * from;
      o.y = eye.y + dir.y * from;
      o.z = eye.z + dir.z * from;
      const w = raycastGrid(world, o, dir, limit - from, targetableOrLiquidSource);
      if (w === null) return best;
      if (from > 0) {
        if (w.dist === 0) {
          // Resumed inside this cell right behind the skipped one: it was entered through the
          // face the ray left the skipped cell by (raycastGrid cannot know that from inside).
          w.face = this.exitFace;
          w.dist = this.exitT;
        } else {
          w.dist += from;
        }
        w.point.x = eye.x + dir.x * w.dist;
        w.point.y = eye.y + dir.y * w.dist;
        w.point.z = eye.z + dir.z * w.dist;
      }
      if (LIQUID[w.cell & ID_MASK] === 0) return w;
      this.cellExit(eye, dir, w.x, w.y, w.z, w.dist);
      const exit = this.exitT;
      const end = best !== null && best.dist < exit ? best.dist : exit;
      if (this.liquidVisible(eye, dir, w.dist, end)) return w;
      if (exit >= limit) return best;
      from = exit + SKIP_EPS;
    }
    return best;
  }

  /** exitT / exitFace = where the ray leaves world cell (x,y,z) (entered at `entry`), and the next cell's entry face. */
  private cellExit(eye: Vec3, dir: Vec3, x: number, y: number, z: number, entry: number): void {
    let t = Infinity;
    let face: Dir = PX;
    let slope = -1;
    // On an exact edge or corner exit, the steepest of the tied axes names the face (as raycastGrid does).
    if (dir.x !== 0) {
      const tx = ((dir.x > 0 ? x + 1 : x) - eye.x) / dir.x;
      if (tx < t || (tx === t && Math.abs(dir.x) > slope)) {
        t = tx;
        face = dir.x > 0 ? NX : PX;
        slope = Math.abs(dir.x);
      }
    }
    if (dir.y !== 0) {
      const ty = ((dir.y > 0 ? y + 1 : y) - eye.y) / dir.y;
      if (ty < t || (ty === t && Math.abs(dir.y) > slope)) {
        t = ty;
        face = dir.y > 0 ? NY : PY;
        slope = Math.abs(dir.y);
      }
    }
    if (dir.z !== 0) {
      const tz = ((dir.z > 0 ? z + 1 : z) - eye.z) / dir.z;
      if (tz < t || (tz === t && Math.abs(dir.z) > slope)) {
        t = tz;
        face = dir.z > 0 ? NZ : PZ;
      }
    }
    this.exitT = t > entry ? t : entry;
    this.exitFace = face;
  }

  /** Is the world liquid on the ray between t0 and t1 visible somewhere, i.e. not all displaced by hulls? */
  private liquidVisible(eye: Vec3, dir: Vec3, t0: number, t1: number): boolean {
    if (!(t1 > t0)) return false; // a structure starts where the liquid does
    const ships = this.sim.structures.ships();
    if (ships.length === 0) return true;
    const n = Math.max(1, Math.ceil((t1 - t0) / HULL_SAMPLE));
    const step = (t1 - t0) / n;
    const p = this.sample;
    for (let i = 0; i < n; i++) {
      const t = t0 + (i + 0.5) * step;
      p.x = eye.x + dir.x * t;
      p.y = eye.y + dir.y * t;
      p.z = eye.z + dir.z * t;
      if (!this.displacedByHull(p)) return true;
    }
    return false;
  }

  /**
   * Is the world point inside a HARD cell or a dry cell of a ship (where the hull keeps world
   * liquid out)? The same rule as for bodies (entities/fluids) and blast rays (explosion).
   */
  private displacedByHull(p: Vec3): boolean {
    const ships = this.sim.structures.ships();
    const l = this.sampleLocal;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i]!;
      const g = ship.grid;
      const b = g.cellBounds();
      if (b === null) continue;
      g.toLocal(p, l);
      const x = Math.floor(l.x);
      const y = Math.floor(l.y);
      const z = Math.floor(l.z);
      // Dry cells lie inside the hull's box, so nothing outside it is displaced.
      if (x < b.minX || y < b.minY || z < b.minZ || x >= b.maxX || y >= b.maxY || z >= b.maxZ) continue;
      if (SOLID[g.getCell(x, y, z) & ID_MASK] === 1) return true;
      const hull = this.system.hullOf(ship);
      if (hull !== null && isDryCell(hull, x, y, z)) return true;
    }
    return false;
  }

  /** The world, or the grid of a structure that is still live. */
  private isLive(grid: VoxelGrid): boolean {
    return grid.isWorld || this.sim.structures.structureOf(grid) !== null;
  }

  /** A hit taken before the right-click, if it still stands: its grid is live, its cell still matches `pred`. */
  private recheck(h: GridHit | null, pred: CellPredicate): GridHit | null {
    if (h === null || !this.isLive(h.grid)) return null;
    const cell = h.grid.getCell(h.x, h.y, h.z);
    if (cell === h.cell) return h;
    if (!pred(cell)) return null;
    h.cell = cell;
    return h;
  }

  /** Is `h` the cell being mined? */
  private isMineCell(h: GridHit): boolean {
    return this.mineGrid === h.grid && this.mineX === h.x && this.mineY === h.y && this.mineZ === h.z;
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
    if (id === B.HELM && !forcePlace) {
      if (hit.grid.isWorld) this.worldHelmClick(p, hit);
      else this.shipHelmClick(p, hit);
      return;
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
    this.sim.events.emit({ type: 'toast', player: this.key, message, kind });
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
        this.toast(failMessage('ship', res.reason, this.shipFailParams(res.reason)), 'warn');
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
      this.toast(failMessage('ship', res.reason, this.shipFailParams(res.reason)), 'warn');
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
        this.toast(failMessage('rotor', res.reason, this.rotorFailParams(res.reason, 0)), 'warn');
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
    this.toast(failMessage('rotor', res.reason, this.rotorFailParams(res.reason, res.sails)), 'warn');
    if (res.reason === 'not_enough_sails' && res.count > 0) {
      // Show what would turn, so the player sees where sails are missing; a second click re-checks.
      this.setPreview('rotor', hit.grid, hit.x, hit.y, hit.z, res.cells, res.count, res.sails, res.bounds, false);
    } else {
      this.preview = null;
    }
  }

  /** Parameters of a refused ship's message; the box limit only for 'too_spread'. */
  private shipFailParams(reason: string): Record<string, number> {
    const p: Record<string, number> = { max: this.sim.shipMaxCells };
    if (reason === 'too_spread') p.box = this.sim.structureMaxBoxCells;
    return p;
  }

  /** Parameters of a refused rotor's message; the box limit only for 'too_spread'. */
  private rotorFailParams(reason: string, sails: number): Record<string, number> {
    const p: Record<string, number> = { max: this.sim.rotorMaxCells, min: this.sim.rotorMinSails, sails };
    if (reason === 'too_spread') p.box = this.sim.structureMaxBoxCells;
    return p;
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
    const replacesClicked = REPLACEABLE[hitId] === 1 && LIQUID[hitId] === 0;
    if (replacesClicked) {
      // Clicking soft cover (a grass tuft, snow) puts the block in its place — in the world and
      // on structures alike (snow cover stacks on a deck too).
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
    const curId = cur & ID_MASK;
    // Structures never hold liquid, so "replaceable" means air or soft cover there.
    if (REPLACEABLE[curId] !== 1) return;
    let cell: number;
    if (item === B.SNOW_LAYER && curId === B.SNOW_LAYER) {
      // Snow cover stacks; eight layers make a packed snow block.
      const layers = stateLayers(cellState(cur)) + 1;
      cell = layers >= 8 ? makeCell(B.SNOW_BLOCK) : makeCell(B.SNOW_LAYER, layersState(layers));
    } else {
      // A torch or a flower put into water would be washed away on the spot.
      if (!def.solid && LIQUID[curId] !== 0) return;
      cell = makeCell(item, this.placementState(def, hit, p));
    }
    if (curId === AIR && !grid.isWorld && this.structureFull(grid, x, y, z)) return;
    // A block that can never be part of a structure (unbreakable ones such as deeprock —
    // DESIGN "挖不动的方块不能被连进结构体") cannot be put onto one either: it could not be
    // mined off again and would break the dock / re-assemble round trip.
    if (!grid.isWorld && !canJoinStructure(cell)) {
      this.toastKey('toast.place.notOnStructure', 'warn');
      return;
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
    // A block that replaced the clicked one (snow, a grass tuft) was not put against a face.
    if (!replacesClicked) this.offhandGlue(p, grid, hit, grid.getCell(x, y, z));
    sim.events.emit({ type: 'blockPlaced', gridId: grid.gridId, x, y, z, cell });
  }

  /**
   * Would a block put into the empty cell (x,y,z) of `grid` take the structure owning it past an
   * assembly limit (DESIGN: ship 4000, rotor 400 cells; a tight box of at most
   * STRUCTURE_MAX_BOX_CELLS cells)? Shows the limit and refuses: a ship built past it could never
   * be assembled again after docking, and could not be saved or sent. The box test reads the
   * grid's cached tight bounds (recomputed only when the grid changed) and a few comparisons.
   */
  private structureFull(grid: VoxelGrid, x: number, y: number, z: number): boolean {
    const sim = this.sim;
    const s = sim.structures.structureOf(grid);
    if (s === null) return false;
    const ship = s instanceof Ship;
    const kind = ship ? 'ship' : 'rotor';
    const max = ship ? sim.shipMaxCells : sim.rotorMaxCells;
    if (s.grid.count >= max) {
      this.toast(failMessage(kind, 'too_big', { max }), 'warn');
      return true;
    }
    if (boxCellsWith(s.grid.cellBounds(), x, y, z) > sim.structureMaxBoxCells) {
      this.toast(failMessage(kind, 'too_spread', { box: sim.structureMaxBoxCells }), 'warn');
      return true;
    }
    return false;
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
    // Nor is liquid poured into a hull: a world source where a ship's hard cells or dry hold are
    // would be hidden inside it now and left floating on the sea once it sails away.
    const c = this.tmp;
    c.x = x + 0.5;
    c.y = y + 0.5;
    c.z = z + 0.5;
    if (this.displacedByHull(c)) {
      this.toastKey('toast.bucket.structure', 'warn');
      return;
    }
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

  /** Glue progress of the running survival operation, 0..1 (0 = none). */
  private glueProgress(): number {
    const op = this.glueOp;
    if (op === null) return 0;
    return op.total > 0 ? clamp(op.progress / op.total, 0, 1) : 1;
  }

  /**
   * Right-click with glue in the main hand on the face the use ray hit. Sneak removes that
   * face's glue at once (both modes, nothing refunded). Otherwise, on a glueable block whose hit
   * face is not glued yet: creative glues at once for free; survival starts the timed operation
   * (updateGlueOp), which needs at least one glue.
   */
  private glueClick(p: Player, hit: GridHit | null): void {
    this.glueOp = null;
    if (hit === null) return;
    if (this.locked(hit.grid) !== null) {
      this.toastKey('toast.glue.spinning', 'warn');
      return;
    }
    const glue = this.sim.structures.glueFor(hit.grid);
    const glued = glue.has(hit.x, hit.y, hit.z, hit.face);
    if (p.input.sneak) {
      if (!glued) {
        this.toastKey('toast.glue.notGlued', 'warn');
        return;
      }
      glue.remove(hit.x, hit.y, hit.z, hit.face);
      this.toastKey('toast.glue.removed');
      this.glueSound(hit.grid, hit.x, hit.y, hit.z, hit.face, 'unglue');
      return;
    }
    if (!canGlue(hit.cell)) {
      // Soft blocks, liquids, unbreakable blocks.
      this.toastKey('toast.glue.cannot', 'warn');
      return;
    }
    if (glued) {
      this.toastKey('toast.glue.already', 'warn');
      return;
    }
    if (p.mode === 'creative') {
      this.applyGlue(p, hit.grid, hit.x, hit.y, hit.z, hit.face);
      return;
    }
    if (p.inventory.count(I.GLUE) < 1) {
      this.toastKey('toast.glue.none', 'warn');
      return;
    }
    const total = Math.max(0, BLOCKS[hit.cell & ID_MASK]?.hardness ?? 0);
    this.glueOp = { grid: hit.grid, x: hit.x, y: hit.y, z: hit.z, face: hit.face, cell: hit.cell, total, progress: 0 };
  }

  /**
   * Survival glue operation: progresses while use stays held on the same face of the same cell;
   * anything else (looking away, letting go, the block or the grid changing) cancels it. The
   * block changing includes one glueable block turning straight into another: its time is the
   * block's own, so the operation does not carry over.
   * Changing the slot and swapping hands cancel it in tick().
   */
  private updateGlueOp(p: Player): void {
    const op = this.glueOp;
    if (op === null) return;
    const h = this.hit;
    if (
      !p.input.use ||
      h === null ||
      h.grid !== op.grid ||
      h.x !== op.x ||
      h.y !== op.y ||
      h.z !== op.z ||
      h.face !== op.face ||
      !this.isLive(op.grid) ||
      this.locked(op.grid) !== null ||
      h.cell !== op.cell
    ) {
      this.glueOp = null;
      return;
    }
    op.progress += TICK_DT;
    if (op.progress < op.total - 1e-9) return;
    this.glueOp = null;
    this.applyGlue(p, op.grid, op.x, op.y, op.z, op.face);
  }

  /** Glue one face (main hand): survival uses 1 glue. */
  private applyGlue(p: Player, grid: VoxelGrid, x: number, y: number, z: number, face: Dir): void {
    const glue = this.sim.structures.glueFor(grid);
    if (glue.has(x, y, z, face)) return; // glued meanwhile by some other way: nothing to pay for
    if (p.mode !== 'creative' && !p.inventory.consume(I.GLUE, 1)) {
      this.toastKey('toast.glue.none', 'warn');
      return;
    }
    glue.add(x, y, z, face);
    this.toastKey('toast.glue.added');
    this.glueSound(grid, x, y, z, face, 'glue');
  }

  /**
   * DESIGN 副手: the main hand just placed `placed` at (x,y,z) of `grid` against face `face` of
   * the clicked block (hit.x, hit.y, hit.z), whose neighbour it is. With glue in the off-hand
   * that face gets glued, when both blocks are glueable, the face is not glued yet and the two
   * do not already stick together without glue. Survival uses 1 glue from the off-hand; with
   * none left nothing happens.
   */
  private offhandGlue(p: Player, grid: VoxelGrid, hit: GridHit, placed: number): void {
    const off = p.inventory.offhand;
    if (off === null || off.item !== I.GLUE) return;
    const clicked = grid.getCell(hit.x, hit.y, hit.z);
    if (!canGlue(clicked) || !canGlue(placed)) return;
    // Spares survival glue: blocks that connect anyway (auto-stick, mounting) are not glued.
    const alreadySticks = sticksWithoutGlue(clicked, placed, hit.face);
    if (alreadySticks) return;
    const glue = this.sim.structures.glueFor(grid);
    if (glue.has(hit.x, hit.y, hit.z, hit.face)) return;
    if (p.mode !== 'creative' && !p.inventory.consumeOffhand(1)) return;
    glue.add(hit.x, hit.y, hit.z, hit.face);
    this.glueSound(grid, hit.x, hit.y, hit.z, hit.face, 'glue');
  }

  private glueSound(grid: VoxelGrid, x: number, y: number, z: number, face: Dir, name: 'glue' | 'unglue'): void {
    const c = this.tmp;
    c.x = x + 0.5 + DIR_X[face]! * 0.5;
    c.y = y + 0.5 + DIR_Y[face]! * 0.5;
    c.z = z + 0.5 + DIR_Z[face]! * 0.5;
    grid.toWorld(c, c);
    this.sim.events.emit({ type: 'sound', name, x: c.x, y: c.y, z: c.z });
  }

  // ================================================================== left click

  private resetMining(): void {
    this.mineGrid = null;
    this.mineProgress = 0;
    this.mineCell = AIR;
  }

  private updateMining(p: Player, pressed: boolean): void {
    const input = p.input;
    const hit = this.mineHit;
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

  /** Remove the hit cell from its grid; drop its item for a survival player (world position of the cell). */
  private breakBlock(hit: GridHit): void {
    const sim = this.sim;
    const grid = hit.grid;
    // A grid whose structure is gone is detached: its cells are already back in the world.
    if (!this.isLive(grid)) return;
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
    // The mining player's mode decides (sim/rules.ts): a creative player's blocks never drop.
    if (this.player.mode !== 'creative') spawnBlockDrop(sim, grid, x, y, z, cell, this.tmp);
    sim.events.emit({ type: 'blockBroken', gridId: grid.gridId, x, y, z, cell });
  }

  // ================================================================== hints

  private hintFor(p: Player, h: GridHit | null, held: number): Message | null {
    const sim = this.sim;
    if (p.steeringShipId !== 0) return msg('hint.steering');
    if (this.glueOp !== null) return msg('hint.glue.working', { pct: Math.floor(this.glueProgress() * 100) });
    if (h === null) return null;
    if (this.locked(h.grid) !== null) return msg('hint.rotor.spinning');
    if (held === I.GLUE) return this.glueHint(p, h);
    if (isBucket(held) && !h.grid.isWorld) return msg('hint.bucket.structure');
    const id = h.cell & ID_MASK;
    const holdingBlock = held >= 0 && isBlockItem(held);
    const forcePlace = p.input.sneak && holdingBlock;
    const pv = this.preview;
    const isPreviewed = pv !== null && pv.grid === h.grid && pv.x === h.x && pv.y === h.y && pv.z === h.z;
    if (id === B.HELM && !forcePlace && !isBucket(held)) {
      if (!h.grid.isWorld) return msg(holdingBlock ? 'hint.helm.steerPlace' : 'hint.helm.steer');
      return isPreviewed && pv.kind === 'ship' ? msg('hint.helm.assemble', { count: pv.count }) : msg('hint.helm.preview');
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

  /** What a right-click with glue in the main hand would do on the hit face. */
  private glueHint(p: Player, h: GridHit): Message {
    const glued = this.sim.structures.glueFor(h.grid).has(h.x, h.y, h.z, h.face);
    if (p.input.sneak) return msg(glued ? 'hint.glue.remove' : 'hint.glue.notGlued');
    if (!canGlue(h.cell)) return msg('hint.glue.cannot');
    return msg(glued ? 'hint.glue.already' : 'hint.glue.apply');
  }
}

/**
 * The interaction system: the Hands of every joined player (owned by their PlayerControl, see
 * sim/players.ts), run in ascending entity id order, plus what they share.
 */
export class Interaction {
  /**
   * Hull analyses of ships whose own ship.hull is missing or older than their cells (ships
   * without dynamics, or edited this tick), keyed by object; recomputed when grid.version moves.
   * Shared by all hands: the hull is the same for everyone.
   */
  private readonly hulls = new WeakMap<Ship, HullInfo | null>();

  constructor(private readonly sim: Simulation) {}

  /** Tick step 1: every joined player acts, in ascending entity id order. */
  tick(): void {
    const online = this.sim.players.online();
    for (let i = 0; i < online.length; i++) online[i]!.hands.tick();
  }

  /** Tick step 7: every joined player's view is rebuilt. */
  buildViews(): void {
    const online = this.sim.players.online();
    for (let i = 0; i < online.length; i++) {
      const h = online[i]!.hands;
      h.view = h.buildView();
    }
  }

  /** The simulation's world hook: a change can make any player's preview stale. */
  onWorldChange(x: number, y: number, z: number, oldCell: number, newCell: number, flags: number): void {
    const online = this.sim.players.online();
    for (let i = 0; i < online.length; i++) online[i]!.hands.onWorldChange(x, y, z, oldCell, newCell, flags);
  }

  /** Death drops everything that player's hands were doing (the wheel is released by the entities module). */
  onEntityEvent(ev: EntityEvent): void {
    if (ev.type !== 'death' || !(ev.entity instanceof Player)) return;
    this.sim.players.controlOf(ev.entity)?.hands.reset();
  }

  /** Forget every pending action of every player (loading a save). */
  reset(): void {
    const online = this.sim.players.online();
    for (let i = 0; i < online.length; i++) {
      const h = online[i]!.hands;
      h.reset();
      h.view = emptyView();
    }
  }

  /** The ship's hull analysis for its current cells. */
  hullOf(ship: Ship): HullInfo | null {
    const own = ship.hull;
    if (own !== null && own.version === ship.grid.version) return own;
    const cached = this.hulls.get(ship);
    if (cached !== undefined && (cached === null ? ship.grid.count === 0 : cached.version === ship.grid.version)) return cached;
    const h = analyzeHull(ship.grid);
    this.hulls.set(ship, h);
    return h;
  }
}
