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
 * TWO RAYS (sim/rays.ts). The use ray (outline, right-click, glue) depends on the held item
 * (rayKindOf): the bucket ray while a bucket is held (liquid sources count, except world liquid a
 * hull displaces), the glue ray while glue is held (through soft blocks to the first HARD block),
 * else the plain ray. The mining ray is always the plain ray: a left-click with a bucket in hand
 * digs the block under the water, one with glue in hand breaks the torch in front of the block
 * like any other.
 *
 * CLAIMED AIM (docs/NETCODE.md section 10). A server-driven player's hands cast both rays from its
 * eyes. A client-driven player's client chooses its targets itself and claims them
 * (PlayerControl.claimAim, from net/server/intents.ts, which checks them first: the cell the client
 * saw, the reach); its hands use the claimed use and mining targets instead of casting rays — for
 * the actions, the view and pick block. A claimed target stands while its grid exists and its cell
 * still has the id the client saw; otherwise it is no target. So two players acting on the same
 * cell in one tick never act on what the first left behind as if they had seen it: the second
 * player's block for the face the first just built on is refused (the cell is taken), its click on
 * a block the first just mined finds nothing.
 *
 * STALE HITS. Both targets are read before the right-click runs. The right-click may remove what
 * they hit (docking turns the ship into world blocks, a crate is lit), so they are checked again
 * before the left-click and the glue operation use them: a hit on a structure that is gone, or
 * on a cell that is no longer targetable (claimed: no longer the id the client saw), is dropped
 * for this tick.
 *
 * All state is on the instances; nothing here is saved (a timed glue operation, previews and
 * mining progress do not survive a reload or a rejoin by design).
 */
import { AIR, CELL_MULTI_BIT, FULL_LIMIT, HOLES_SHIFT, ID_MASK, PACK_SCALE, PART_MASK, axisState, cellState, facingState, isLiquidSource, layersState, liquidState, makeCell } from '../blocks/cell';
import { B } from '../blocks/defs';
import { I, isBlockItem } from '../blocks/items';
import { BLOCKS, LIQUID, REPLACEABLE, type BlockDef } from '../blocks/registry';
import { BOXES, BOX_COUNT, cellsTouch, faceCover, isCellFace, partAt, solidFill, topCovered } from '../blocks/shapes';
import { TICK_DT, WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, dirAxis, nearestDir, type Dir } from '../core/dirs';
import { aabb, clamp, vec3, type AABB, type Quat, type Vec3 } from '../core/math';
import { Player } from '../entities/entity';
import type { EntityEvent } from '../entities/host';
import { pickBlockInto, pickBlockItem } from '../entities/inventory';
import { axisValue, finiteAngle } from '../entities/input';
import { boxCellsWith } from '../structures/collect';
import { analyzeHull, type HullInfo } from '../structures/hull';
import { canGlue, canJoinStructure, holdsGlue, sticksWithoutGlue } from '../structures/stick';
import { Ship, type Structure } from '../structures/structure';
import type { CellBounds, VoxelGrid } from '../voxel/grid';
import { getPacked, removePartAt, solidFillAt } from '../voxel/parts';
import { targetable, type CellPredicate, type GridHit } from '../voxel/raycast';
import { CONTACT_EPS, boxOverlapsSolid } from '../voxel/shape';
import type { StructureGrid } from '../voxel/sgrid';
import { spawnBlockDrop } from './drops';
import { failMessage, msg, type MessageKey } from './messages';
import { REFUSAL_TOAST, placementTarget, planPlacement } from './placement';
import { castRay, isBucket, lookDir, partlyDisplaced, rayKindOf, rayPredicate, type RayKind, type RayScene, type RayShip } from './rays';
import type { Simulation } from './simulation';
import { supportOk } from './support';
import { emptyView, type AimTarget, type InteractionView, type Message, type PlayerKey } from './view';

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

/**
 * A VoxelGrid view of ONE cell of another grid holding only the part about to be placed there:
 * same transform, nothing else in it. Lets the exact, shape-aware OBB-vs-cell queries of
 * voxel/shape answer "does this box overlap the material that would be placed in that (possibly
 * rotated) cell" without a separate code path (docs/SHAPES.md 6.2: the placed block's shape
 * against bodies).
 */
class CellProbe implements VoxelGrid {
  gridId = 0;
  parent: VoxelGrid | null = null;
  readonly isWorld = false;
  private target: VoxelGrid | null = null;
  private x = 0;
  private y = 0;
  private z = 0;
  /** The part value being placed (one part: a value below 2^24). */
  private part = AIR;
  private readonly bounds: CellBounds = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };

  set(target: VoxelGrid, x: number, y: number, z: number, part: number): this {
    this.target = target;
    this.gridId = target.gridId;
    this.parent = target.parent;
    this.x = x;
    this.y = y;
    this.z = z;
    this.part = part;
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
    return x === this.x && y === this.y && z === this.z ? this.part : AIR;
  }
  /** The probe holds the one part being placed, never a second one (docs/SHAPES.md 4.4). */
  getPart2(): number {
    return 0;
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
  /** The cell's whole packed content when the operation started: any change of the cell cancels it (docs/SHAPES.md 6.2). */
  readonly cell: number;
  /** Seconds needed: the survival mining time of the part clicked. */
  readonly total: number;
  progress: number;
}

function copyTarget(t: AimTarget | null): AimTarget | null {
  return t === null ? null : { gridId: t.gridId, x: t.x, y: t.y, z: t.z, face: t.face, sub: t.sub, cell: t.cell };
}

function targetOf(h: GridHit | null): AimTarget | null {
  return h === null ? null : { gridId: h.grid.gridId, x: h.x, y: h.y, z: h.z, face: h.face, sub: h.octant, cell: h.cell };
}

/**
 * Do cell (x,y,z) of `grid` and the cell across face `f` already touch, the cell across holding
 * glue (holdsGlue: glueable, or the unloaded sentinel) and the hard covers of the shared face
 * overlapping (blocks/shapes.ts cellsTouch)? Such a face refuses glue (toast.glue.touching,
 * docs/SHAPES.md 10.3). Read from the layers (solidFillAt), never forming a packed value: the
 * crosshair hint asks it every tick (4.4).
 */
function touchesAcross(grid: VoxelGrid, x: number, y: number, z: number, f: Dir): boolean {
  const ax = x + DIR_X[f]!;
  const ay = y + DIR_Y[f]!;
  const az = z + DIR_Z[f]!;
  if (!holdsGlue(grid.getCell(ax, ay, az))) return false;
  return (faceCover(solidFillAt(grid, x, y, z), f) & faceCover(solidFillAt(grid, ax, ay, az), (f ^ 1) as Dir)) !== 0;
}

function isAirOrLiquid(cell: number): boolean {
  const id = cell & ID_MASK;
  return id === AIR || LIQUID[id] !== 0;
}

/**
 * The part of cell (x,y,z) of `grid` that contains `octant` (blocks/shapes.ts partAt), 0 when the
 * octant is empty. Read from the layers (getCell, and getPart2 only for a two-part cell): it never
 * forms the packed value of a two-part cell (docs/SHAPES.md 4.4), so the per-tick checks of a
 * claimed aim (Hands.resolve, net/server/intents.ts) use it.
 */
export function partAtCell(grid: VoxelGrid, x: number, y: number, z: number, octant: number): number {
  return partOfCell(grid, x, y, z, grid.getCell(x, y, z), octant);
}

/** partAtCell when the cell value `c` (getCell) has been read already; getPart2 is read only for a two-part cell. */
function partOfCell(grid: VoxelGrid, x: number, y: number, z: number, c: number, octant: number): number {
  if (c < FULL_LIMIT) return (c & ID_MASK) === AIR ? 0 : c;
  const bit = 1 << octant;
  if ((c & ID_MASK) !== AIR && ((c >>> HOLES_SHIFT) & bit) === 0) return c & PART_MASK;
  if ((c & CELL_MULTI_BIT) === 0) return 0;
  const p2 = grid.getPart2(x, y, z);
  return p2 !== 0 && ((p2 >>> HOLES_SHIFT) & bit) === 0 ? p2 : 0;
}

/**
 * The part a target claims to aim at: partAt(t.cell, t.sub), the part of the cell the client saw
 * that contains the octant it hit (docs/SHAPES.md 6.2 "目标是否有效"). Takes the target, not its
 * cell: t.cell may be the packed value of a two-part cell (a heap number), which per-tick code
 * never passes on (4.4). Any value is read bit by bit and nothing throws.
 */
export function claimedPart(t: Readonly<{ sub: number; cell: number }>): number {
  const cell = t.cell;
  if (cell < FULL_LIMIT) return (cell & ID_MASK) === AIR ? 0 : cell;
  const first = cell % PACK_SCALE;
  const bit = 1 << t.sub;
  if ((first & ID_MASK) !== AIR && ((first >>> HOLES_SHIFT) & bit) === 0) return first & PART_MASK;
  const second = (cell - first) / PACK_SCALE;
  return second !== 0 && ((second >>> HOLES_SHIFT) & bit) === 0 ? second & PART_MASK : 0;
}

/** `out` = box `o` of the BOXES table (half-cell units) in cell (x,y,z), shrunk by `inset` on every side. */
function insetBox(out: AABB, x: number, y: number, z: number, o: number, inset: number): void {
  out.minX = x + BOXES[o]! / 2 + inset;
  out.minY = y + BOXES[o + 1]! / 2 + inset;
  out.minZ = z + BOXES[o + 2]! / 2 + inset;
  out.maxX = x + BOXES[o + 3]! / 2 - inset;
  out.maxY = y + BOXES[o + 4]! / 2 - inset;
  out.maxZ = z + BOXES[o + 5]! / 2 - inset;
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

  // ---- the claimed aim of a client-driven player (CLAIMED AIM in the header)
  private claimUse: AimTarget | null = null;
  private claimMine: AimTarget | null = null;

  // ---- mining: the identity of what is being mined is grid + cell + part value (docs/SHAPES.md 6.2)
  private mineGrid: VoxelGrid | null = null;
  private mineX = 0;
  private mineY = 0;
  private mineZ = 0;
  private minePart = AIR;
  /** The octant of the mined part the ray hit when this mining started (the view's mining.sub). */
  private mineOctant = 0;
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
   * The cell the player is looking at right now (within sim/rays.ts REACH) with the use ray of the held
   * item — what a right-click would act on and what the outline shows (a client-driven player:
   * its claimed use target).
   */
  raycast(): GridHit | null {
    const p = this.player;
    return this.claimed(p) ? this.resolve(this.claimUse) : this.castRay(p, rayKindOf(this.heldItem(p)));
  }

  /** The cell a left-click would mine right now (never a liquid, whatever is held; a client-driven player: its claimed mining target). */
  raycastMining(): GridHit | null {
    const p = this.player;
    return this.claimed(p) ? this.resolve(this.claimMine) : this.castRay(p, 'plain');
  }

  // ================================================================== claimed aim

  /**
   * The targets a client-driven player's client claims (CLAIMED AIM in the header): its use ray's
   * and its mining ray's, already checked by the caller (net/server/intents.ts). Copied; they stand
   * until the next claim. Ignored by a server-driven player's hands, which cast their own rays.
   */
  claimAim(use: AimTarget | null, mine: AimTarget | null): void {
    this.claimUse = copyTarget(use);
    this.claimMine = copyTarget(mine);
  }

  /** Claim the use target alone (a right-click carries its own: it holds from its tick on). */
  claimUseTarget(t: AimTarget | null): void {
    this.claimUse = copyTarget(t);
  }

  /** Claim the mining target alone (a left-click carries its own). */
  claimMineTarget(t: AimTarget | null): void {
    this.claimMine = copyTarget(t);
  }

  /**
   * Scripted control of a client-driven player (PlayerControl.lookAt): claim what its client would
   * claim looking where the player looks now — both rays cast from its eyes.
   */
  claimLook(): void {
    const p = this.player;
    this.claimUse = targetOf(this.castRay(p, rayKindOf(this.heldItem(p))));
    this.claimMine = targetOf(this.castRay(p, 'plain'));
  }

  // ================================================================== pick block

  /**
   * Pick block (middle click; DESIGN 选取方块, entities/inventory.ts pickBlockInto): put the block
   * the player looks at in hand. The target is `target` when given (a client's PickBlock intent),
   * else the use ray's hit (what the outline shows; a client-driven player: its claimed use
   * target), on the world or a structure; air, liquids and the unloaded sentinel pick nothing. The
   * item is the material of the part aimed at (block id == item id; docs/SHAPES.md 6.2), never its
   * mining drop.
   *
   * The selection is written to input.slot too, which the next tick applies (applyLook): a caller
   * that drives input.slot itself must adopt inventory.selected afterwards. Runs between ticks
   * with the look of the last tick, so it acts on what the outline shows. Returns true when the
   * block is in hand afterwards.
   */
  pickBlock(target?: AimTarget): boolean {
    const p = this.player;
    if (p.dead || p.removed) return false;
    const h = target !== undefined ? this.resolve(target) : this.raycast();
    if (h === null) return false;
    const item = pickBlockItem(h.part);
    if (item < 0 || !pickBlockInto(p.inventory, item, p.mode === 'creative')) return false;
    p.input.slot = p.inventory.selected;
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
    const ray = rayKindOf(held);
    const claimed = this.claimed(p);
    if (claimed) {
      this.hit = this.resolve(this.claimUse);
      this.mineHit = this.resolve(this.claimMine);
    } else {
      this.hit = this.castRay(p, ray);
      this.mineHit = ray !== 'plain' ? this.castRay(p, 'plain') : this.hit;
    }
    this.previewLifetime();
    if (usePressed) {
      this.onUse(p, held);
      // See STALE HITS in the header.
      if (claimed) {
        this.hit = this.resolve(this.claimUse);
        this.mineHit = this.resolve(this.claimMine);
      } else {
        this.hit = this.recheck(this.hit, rayPredicate(ray));
        this.mineHit = ray !== 'plain' ? this.recheck(this.mineHit, targetable) : this.hit;
      }
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
    const ray = rayKindOf(held);
    // Again: structures and the player moved since the actions ran, and the outline and hint
    // must match what is on screen now.
    const h = this.raycast();
    this.validate();
    // The outline shows what a right-click would act on — except while the player digs with a
    // bucket or glue in hand, when it follows the block being dug (under the water, the torch in
    // front of a block) so the cracks show.
    let shown = h;
    if (ray !== 'plain' && this.mineGrid !== null) {
      const m = this.raycastMining();
      if (m !== null && this.isMineCell(m)) shown = m;
    }
    if (shown !== null) v.target = { gridId: shown.grid.gridId, x: shown.x, y: shown.y, z: shown.z, face: shown.face };
    const mg = this.mineGrid;
    if (mg !== null && this.mineProgress > 0 && this.isLive(mg)) {
      // sub: the octant first hit (bits 0..2); bit 3, "this one octant only", is M2.4's chisel (docs/SHAPES.md 6.3).
      v.mining = { gridId: mg.gridId, x: this.mineX, y: this.mineY, z: this.mineZ, sub: this.mineOctant, progress: clamp(this.mineProgress, 0, 1) };
    }
    const pv = this.preview;
    if (pv !== null) v.preview = { gridId: pv.grid.gridId, kind: pv.kind, cells: pv.cells };
    if (sim.world.time < this.conflictsUntil) v.conflicts = this.conflicts;
    const op = this.glueOp;
    if (op !== null) v.gluing = { gridId: op.grid.gridId, x: op.x, y: op.y, z: op.z, face: op.face, sub: 0, progress: this.glueProgress() };
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

  /** Does this player's client claim its aim (client-driven: CLAIMED AIM in the header)? */
  private claimed(p: Player): boolean {
    return this.sim.entities.driveOf(p) === 'client';
  }

  /**
   * A claimed target as a hit (docs/SHAPES.md 6.3): while its grid exists and the part of its cell
   * that contains the claimed octant has the id of the part the client saw there (any state, any
   * shape: the action reads the part as it is now; a change of the other part of the cell, or of
   * other octants of this one, does not matter); else no target. The hit's octant is the claimed
   * one, its cell the cell's whole packed content now, its part the part at that octant, its point
   * the centre of the octant. Runs every tick for a client-driven player: the part is read from
   * the layers, and the packed value is formed only for the hit itself (as the ray does).
   */
  private resolve(t: AimTarget | null): GridHit | null {
    if (t === null) return null;
    const grid = this.sim.structures.gridById(t.gridId);
    if (grid === undefined) return null;
    const { x, y, z, sub } = t;
    // An octant outside 0..7 (a script's claim; the codec refuses one from the network) is no
    // target, like every other claim that does not stand: partOfCell would read the cell's other
    // bits as holes, and removePartAt refuses it.
    if ((sub & 7) !== sub) return null;
    const c = grid.getCell(x, y, z);
    let part: number;
    let cell: number;
    if (c < FULL_LIMIT && t.cell < FULL_LIMIT) {
      // A full block (or air) on both sides, every cell of a world without parts: the part is the
      // cell, compared by id directly (what partOfCell and claimedPart answer, without the calls).
      const id = c & ID_MASK;
      if (id === AIR || id === B.UNLOADED || id !== (t.cell & ID_MASK)) return null;
      part = cell = c;
    } else {
      part = partOfCell(grid, x, y, z, c, sub);
      const id = part & ID_MASK;
      if (part === 0 || id === B.UNLOADED || id !== (claimedPart(t) & ID_MASK)) return null;
      cell = c < CELL_MULTI_BIT ? c : c + grid.getPart2(x, y, z) * PACK_SCALE;
    }
    const point = vec3(x + 0.25 + 0.5 * (sub & 1), y + 0.25 + 0.5 * ((sub >> 1) & 1), z + 0.25 + 0.5 * ((sub >> 2) & 1));
    grid.toWorld(point, point);
    return { grid, x, y, z, face: t.face, octant: sub, cell, part, dist: 0, point };
  }

  private castRay(p: Player, ray: RayKind): GridHit | null {
    return castRay(this.system.rayScene(), p.eyePos(this.eye), lookDir(p.yaw, p.pitch, this.dir), ray);
  }

  /** The world, or the grid of a structure that is still live. */
  private isLive(grid: VoxelGrid): boolean {
    return grid.isWorld || this.sim.structures.structureOf(grid) !== null;
  }

  /**
   * A hit taken before the right-click, if it still stands: its grid is live and the part now at
   * its octant still matches `pred` (the hit then carries the cell and the part as they are now).
   */
  private recheck(h: GridHit | null, pred: CellPredicate): GridHit | null {
    if (h === null || !this.isLive(h.grid)) return null;
    const cell = getPacked(h.grid, h.x, h.y, h.z);
    if (cell === h.cell) return h;
    const part = partAt(cell, h.octant);
    if (part === 0 || !pred(part)) return null;
    h.cell = cell;
    h.part = part;
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
    // Helm, bearing, blast crate: none can be cut or share a cell, so the part hit is the whole cell.
    const id = hit.part & ID_MASK;
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
        // A cell whose parts do not overlap but would make three is empty space to the player:
        // say why it is refused (docs/SHAPES.md 11.3, question 10).
        const twoParts = res.conflicts.some((c) => c.limit);
        this.toastKey(twoParts ? 'toast.dock.twoParts' : 'toast.dock.blocked', 'warn', { count: res.conflicts.length });
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

  /**
   * Put the held block against the hit (DESIGN 放置与挖掘; docs/SHAPES.md 6.2): sim/placement.ts
   * planPlacement decides the target cell and what it holds afterwards (a whole block goes into the
   * cell across the face the ray entered the hit octant by, or replaces the soft cover clicked; it
   * never goes into a cell that has parts); here what only the server decides: the world's bounds
   * and loaded columns, a soft block into liquid, the structure limits and membership, the support
   * below (sim/support.ts; a helm also needs the top face below fully covered, docs/SHAPES.md 9.2),
   * the overlap of the placed material with bodies and other grids, and the item used up.
   */
  private place(p: Player, hit: GridHit, item: number): void {
    const sim = this.sim;
    const def = BLOCKS[item];
    if (def === undefined || def.liquid !== 0) return; // liquids are never placed as blocks
    const grid = hit.grid;
    if (this.locked(grid) !== null) {
      this.toastKey('toast.place.spinning', 'warn');
      return;
    }
    if (grid.isWorld) {
      // Outside the world, or in a column that is not loaded: nothing, silently.
      const t = placementTarget(hit, -1);
      if (t.y < 0 || t.y >= WORLD_HEIGHT || !sim.world.isLoaded(t.x, t.z)) return;
    }
    // A cell that is taken (also: another player built there in this tick, CLAIMED AIM) refuses the block.
    const plan = planPlacement(grid, hit, item, this.placementState(def, hit, p), -1);
    if (typeof plan === 'string') {
      this.toastKey(REFUSAL_TOAST[plan], 'warn');
      return;
    }
    const { x, y, z } = plan;
    const curId = grid.getCell(x, y, z) & ID_MASK;
    // A torch or a flower put into water would be washed away on the spot.
    if (!def.solid && LIQUID[curId] !== 0) return;
    if (curId === AIR && !grid.isWorld && this.structureFull(grid, x, y, z)) return;
    // A block that can never be part of a structure (unbreakable ones such as deeprock —
    // DESIGN "挖不动的方块不能被连进结构体") cannot be put onto one either: it could not be
    // mined off again and would break the dock / re-assemble round trip.
    if (!grid.isWorld && !canJoinStructure(plan.part)) {
      this.toastKey('toast.place.notOnStructure', 'warn');
      return;
    }
    const below = getPacked(grid, x, y - 1, z);
    if (!supportOk(def, below) || (def.func === 'helm' && !topCovered(below))) {
      this.toastKey('toast.place.support', 'warn');
      return;
    }
    if (solidFill(plan.part) !== 0 && this.placementBlocked(grid, x, y, z, plan.part)) {
      this.toastKey('toast.place.occupied', 'warn');
      return;
    }
    if (!grid.setCell(x, y, z, plan.cell)) return;
    if (p.mode !== 'creative') p.inventory.consumeSelected(1);
    // A block that replaced the clicked one (snow, a grass tuft) was not put against a face.
    if (!plan.replaces) this.offhandGlue(p, grid, hit, getPacked(grid, x, y, z));
    sim.events.emit({ type: 'blockPlaced', gridId: grid.gridId, x, y, z, cell: plan.part });
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
   * Would the hard material of `part`, placed at local cell (x,y,z) of `grid`, overlap something?
   * Shape-aware on both sides (docs/SHAPES.md 6.2): the octants the part fills (its boxes,
   * blocks/shapes.ts BOXES) against any entity body but item drops (they are nudged out), tested
   * exactly — for a rotated grid the body is an OBB in its frame (CellProbe) — and against the hard
   * octants of the other grids beyond GRID_OVERLAP_TOLERANCE. So a block goes in beside a slab a
   * body stands next to, and is refused only when what it would fill is taken. A whole block is
   * one box, the unit cell: the M1 tests, number for number.
   */
  private placementBlocked(grid: VoxelGrid, x: number, y: number, z: number, part: number): boolean {
    const sim = this.sim;
    const fill = solidFill(part);
    const boxes = BOX_COUNT[fill]!;
    const at = fill * 24;
    const probe = this.probe.set(grid, x, y, z, part);
    for (const e of sim.entities.all()) {
      if (e.removed || e.kind === 'item') continue;
      if (e instanceof Player && e.dead) continue;
      const b = e.box(this.box);
      if (grid.isWorld) {
        for (let k = 0; k < boxes; k++) {
          const o = at + k * 6;
          if (
            b.minX < x + BOXES[o + 3]! / 2 - CONTACT_EPS &&
            b.maxX > x + BOXES[o]! / 2 + CONTACT_EPS &&
            b.minY < y + BOXES[o + 4]! / 2 - CONTACT_EPS &&
            b.maxY > y + BOXES[o + 1]! / 2 + CONTACT_EPS &&
            b.minZ < z + BOXES[o + 5]! / 2 - CONTACT_EPS &&
            b.maxZ > z + BOXES[o + 2]! / 2 + CONTACT_EPS
          ) {
            return true;
          }
        }
      } else if (boxOverlapsSolid(probe, b)) {
        return true;
      }
    }
    const tol = GRID_OVERLAP_TOLERANCE;
    const cb = this.box2;
    if (grid.isWorld) {
      for (let k = 0; k < boxes; k++) {
        insetBox(cb, x, y, z, at + k * 6, tol);
        for (const s of sim.structures.all()) if (boxOverlapsSolid(s.grid, cb)) return true;
      }
      return false;
    }
    // A structure cell against the world's hard octants around its world position.
    const c = this.tmp;
    c.x = x + 0.5;
    c.y = y + 0.5;
    c.z = z + 0.5;
    grid.toWorld(c, c);
    const world = sim.world;
    for (let wy = Math.floor(c.y - 0.87); wy <= Math.floor(c.y + 0.87); wy++) {
      for (let wz = Math.floor(c.z - 0.87); wz <= Math.floor(c.z + 0.87); wz++) {
        for (let wx = Math.floor(c.x - 0.87); wx <= Math.floor(c.x + 0.87); wx++) {
          const f = solidFillAt(world, wx, wy, wz);
          if (f === 0) continue;
          for (let k = 0, n = BOX_COUNT[f]!; k < n; k++) {
            insetBox(cb, wx, wy, wz, f * 24 + k * 6, tol);
            if (boxOverlapsSolid(probe, cb)) return true;
          }
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
      const id = hit.part & ID_MASK;
      if (LIQUID[id] === 0 || !isLiquidSource(cellState(hit.part))) return;
      if (!world.setCell(hit.x, hit.y, hit.z, AIR)) return;
      if (p.mode !== 'creative') this.swapHeld(p, id === B.WATER ? I.BUCKET_WATER : I.BUCKET_LAVA);
      sim.events.emit({ type: 'sound', name: 'bucket_fill', x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });
      return;
    }
    // The target cell as for placing a whole block (docs/SHAPES.md 6.2): the soft cover clicked,
    // else the cell across the entered face. A cell that has parts is hard, not REPLACEABLE: liquid
    // is never poured into it (9.1).
    const { x, y, z } = placementTarget(hit, -1);
    if (y < 0 || y >= WORLD_HEIGHT || !world.isLoaded(x, z)) return;
    const cur = world.getCell(x, y, z);
    if (REPLACEABLE[cur & ID_MASK] !== 1) return;
    // Nor is liquid poured into a hull: a world source where a ship's hard cells or dry hold are
    // would be hidden inside it now and left floating on the sea once it sails away.
    // Asked per octant: a hull cell holds as little as one hard octant (SHAPES 9.1).
    if (partlyDisplaced(this.system.rayScene().ships, x, y, z)) {
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
   * Right-click with glue in the main hand on the face the use ray hit. Glue belongs to a CELL face
   * (docs/SHAPES.md 6.2, 10.3): an inner face (the top of a lower slab, at y + 0.5) refuses
   * (toast.glue.inner), applying and removing alike. Sneak removes that face's glue at once (both
   * modes, nothing refunded). Otherwise, on a glueable part whose cell face is not glued yet and
   * whose cell does not already touch the cell across the face (two glueable cells whose hard
   * covers of the face overlap: toast.glue.touching; DESIGN "已经挨着的两块不能直接粘", which a
   * face half covered by a slab would otherwise allow): creative glues at once for free; survival
   * starts the timed operation (updateGlueOp, the part's hardness), which needs at least one glue.
   * A cell across that has material only away from the face does not touch it: that face is open.
   */
  private glueClick(p: Player, hit: GridHit | null): void {
    this.glueOp = null;
    if (hit === null) return;
    if (this.locked(hit.grid) !== null) {
      this.toastKey('toast.glue.spinning', 'warn');
      return;
    }
    if (!isCellFace(hit.octant, hit.face)) {
      this.toastKey('toast.glue.inner', 'warn');
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
    if (!canGlue(hit.part)) {
      // Soft blocks, liquids, unbreakable blocks.
      this.toastKey('toast.glue.cannot', 'warn');
      return;
    }
    if (glued) {
      this.toastKey('toast.glue.already', 'warn');
      return;
    }
    if (touchesAcross(hit.grid, hit.x, hit.y, hit.z, hit.face)) {
      this.toastKey('toast.glue.touching', 'warn');
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
    const total = Math.max(0, BLOCKS[hit.part & ID_MASK]?.hardness ?? 0);
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
   * DESIGN 副手: the main hand just placed `placed` (the packed content of the cell it went into)
   * against face hit.face of the clicked cell (hit.x, hit.y, hit.z), whose neighbour it is. With
   * glue in the off-hand that face gets glued, when both cells are glueable, they touch on that
   * face (blocks/shapes.ts cellsTouch: a block put against the top of a lower slab, an inner face,
   * lies half a block above it and is neither glued nor charged; docs/SHAPES.md 10.3), the face is
   * not glued yet and the two do not already stick together without glue. Survival uses 1 glue
   * from the off-hand; with none left nothing happens.
   */
  private offhandGlue(p: Player, grid: VoxelGrid, hit: GridHit, placed: number): void {
    const off = p.inventory.offhand;
    if (off === null || off.item !== I.GLUE) return;
    const clicked = getPacked(grid, hit.x, hit.y, hit.z);
    if (!canGlue(clicked) || !canGlue(placed)) return;
    if (!cellsTouch(clicked, placed, hit.face)) return;
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
    this.minePart = AIR;
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
    // The part aimed at is mined: its material's hardness, however much of it is left (docs/SHAPES.md 6.2, question 5).
    const def = BLOCKS[hit.part & ID_MASK];
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
    // The same mining while the crosshair stays on the same part (another of its octants) and the
    // part keeps its value; a change of the other part of the cell does not reset the progress.
    if (this.mineGrid !== hit.grid || this.mineX !== hit.x || this.mineY !== hit.y || this.mineZ !== hit.z || this.minePart !== hit.part) {
      this.mineGrid = hit.grid;
      this.mineX = hit.x;
      this.mineY = hit.y;
      this.mineZ = hit.z;
      this.minePart = hit.part;
      this.mineOctant = hit.octant;
      this.mineProgress = 0;
    }
    if (this.breakCooldown > 0) return;
    this.mineProgress += def.hardness > 0 ? TICK_DT / def.hardness : 1;
    if (this.mineProgress < 1 - 1e-9) return;
    this.resetMining();
    this.breakBlock(hit);
    this.breakCooldown = BREAK_COOLDOWN;
  }

  /**
   * Remove the part hit (the one containing hit.octant) from its cell; the other part of the cell
   * stays (docs/SHAPES.md 6.2). A survival player gets its drop: one of the part's material, however
   * much of it was left, at the part's DROP_POINT (sim/drops.ts). blockBroken carries the removed part.
   */
  private breakBlock(hit: GridHit): void {
    const sim = this.sim;
    const grid = hit.grid;
    // A grid whose structure is gone is detached: its cells are already back in the world.
    if (!this.isLive(grid)) return;
    const { x, y, z, octant } = hit;
    const part = partAt(getPacked(grid, x, y, z), octant);
    if (part === AIR) return;
    // The wheel of a helm that is being broken lets go first.
    if ((part & ID_MASK) === B.HELM && !grid.isWorld) {
      const ship = sim.structures.structureOf(grid);
      if (ship instanceof Ship && ship.helmsmanId !== 0 && ship.helmX === x && ship.helmY === y && ship.helmZ === z) {
        const helmsman = sim.entities.get(ship.helmsmanId);
        if (helmsman instanceof Player) sim.entities.stopSteering(helmsman);
      }
    }
    const removed = removePartAt(grid, x, y, z, octant);
    if (removed === AIR) return;
    // The mining player's mode decides (sim/rules.ts): a creative player's blocks never drop.
    if (this.player.mode !== 'creative') spawnBlockDrop(sim, grid, x, y, z, removed, this.tmp);
    sim.events.emit({ type: 'blockBroken', gridId: grid.gridId, x, y, z, cell: removed });
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
    const id = h.part & ID_MASK;
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

  /**
   * What a right-click with glue in the main hand would do on the hit face, in glueClick's order
   * (the spinning rotor is hintFor's). No hint where the click refuses with a toast that has no
   * hint of its own (an inner face: toast.glue.inner; cells that already touch:
   * toast.glue.touching): the hint never promises what the click refuses.
   */
  private glueHint(p: Player, h: GridHit): Message | null {
    if (!isCellFace(h.octant, h.face)) return null;
    const glued = this.sim.structures.glueFor(h.grid).has(h.x, h.y, h.z, h.face);
    if (p.input.sneak) return msg(glued ? 'hint.glue.remove' : 'hint.glue.notGlued');
    if (!canGlue(h.part)) return msg('hint.glue.cannot');
    if (glued) return msg('hint.glue.already');
    return touchesAcross(h.grid, h.x, h.y, h.z, h.face) ? null : msg('hint.glue.apply');
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
  /** The ships of the rays (RayShip, the hull read when a ray needs it), for the ship list they were made from. */
  private rayShips: readonly RayShip[] = [];
  private rayShipsOf: readonly Ship[] | null = null;

  constructor(private readonly sim: Simulation) {}

  /** What the rays look at now (sim/rays.ts): every grid, and every ship with its hull analysis (read lazily). */
  rayScene(): RayScene {
    const ships = this.sim.structures.ships();
    if (ships !== this.rayShipsOf) {
      this.rayShipsOf = ships;
      this.rayShips = ships.map((s) => {
        const system = this;
        return {
          grid: s.grid,
          get hull(): HullInfo | null {
            return system.hullOf(s);
          },
        };
      });
    }
    return { grids: this.sim.grids(), ships: this.rayShips };
  }

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

  /**
   * Death drops everything that player's hands were doing (the wheel is released by the entities
   * module) and lets go of both buttons: a client's release may come only after the respawn, and a
   * held button must not go on mining then (NETCODE section 10).
   */
  onEntityEvent(ev: EntityEvent): void {
    if (ev.type !== 'death' || !(ev.entity instanceof Player)) return;
    const c = this.sim.players.controlOf(ev.entity);
    if (c === undefined) return;
    c.hands.reset();
    c.releaseButtons();
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
