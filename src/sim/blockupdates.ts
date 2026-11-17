/**
 * Block updates: what happens to blocks when their surroundings change, and the scheduled
 * ticks of non-liquid blocks (docs/DESIGN.md "组装和方块化之后要触发方块更新").
 *
 *  - Gravity blocks (BlockDef.gravity: sand, gravel) with a non-HARD cell below get a short
 *    scheduled tick; when it fires and they are still unsupported they leave the world as a
 *    falling-block entity (which lands as a block, or as an item on a structure — LESSONS
 *    沙子落到船上悬浮).
 *  - Blocks with a support rule (BlockDef.support: torch, plants, snow cover, cactus) whose
 *    support is gone pop off as their drop. Chains (a cactus column) pop one after another.
 *  - A soft non-liquid block overwritten by a liquid is washed away and drops its item.
 *  - Structure grids follow the same support rule in their own local frame (a torch on a deck
 *    pops when the plank under it is mined or blown up). Gravity does not apply inside
 *    structures: their cells are held by the structure.
 *
 * WHEN. Changes are only QUEUED from the change hooks (which run inside World.setCell, while
 * other listeners may still be waiting for the same change); the queue is drained by flush(),
 * which the Simulation calls after each phase of a tick and the explosion code calls after a
 * blast. Re-evaluation is idempotent, so a cell queued twice costs a lookup, nothing more.
 * Writes flagged SET_NO_NEIGHBOR_UPDATE (bulk structure moves) are skipped here: the
 * structures module calls updateAround() for every touched cell once the move is complete.
 *
 * Drops follow the rule used everywhere in the simulation: nothing drops in creative mode.
 */
import { AIR, ID_MASK } from '../blocks/cell';
import { B } from '../blocks/defs';
import { BLOCKS, GRAVITY_BLOCK, LIQUID, SOLID } from '../blocks/registry';
import { WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z } from '../core/dirs';
import { vec3 } from '../core/math';
import { SET_NO_NEIGHBOR_UPDATE, type VoxelGrid } from '../voxel/grid';
import { spawnBlockDrop } from './drops';
import type { Simulation } from './simulation';

/** Ticks between a gravity block losing its support and it starting to fall. */
export const FALL_DELAY = 2;
/**
 * Re-evaluations per flush() call. Support chains are short, so this is only a guard against
 * a pathological cascade stalling one tick; whatever is left stays queued for the next flush.
 */
const MAX_FLUSH_STEPS = 1 << 16;

const SAND = B.SAND;
const CACTUS = B.CACTUS;

/** Is the support rule of `def` met by the cell `below`? */
function supportedBy(support: 'none' | 'solid' | 'sandOrSelf', below: number): boolean {
  if (support === 'none') return true;
  const id = below & ID_MASK;
  if (support === 'solid') return SOLID[id] === 1;
  return id === SAND || id === CACTUS;
}

/** A soft, non-liquid, non-air block replaced by a liquid. */
function washedAway(oldCell: number, newCell: number): boolean {
  const o = oldCell & ID_MASK;
  return o !== AIR && LIQUID[o] === 0 && SOLID[o] === 0 && LIQUID[newCell & ID_MASK] !== 0;
}

export class BlockUpdates {
  /** World cells waiting for re-evaluation: x,y,z triples. */
  private readonly worldQueue: number[] = [];
  /** Structure cells waiting for re-evaluation: grid + x,y,z triple (parallel arrays). */
  private readonly gridQueue: VoxelGrid[] = [];
  private readonly gridCoords: number[] = [];
  private flushing = false;
  private readonly tmp = vec3();

  constructor(protected readonly sim: Simulation) {}

  /** Number of queued re-evaluations (world + structures). */
  get pending(): number {
    return this.worldQueue.length / 3 + this.gridQueue.length;
  }

  /**
   * Re-evaluate a world cell and its 6 neighbours after a bulk change made with
   * SET_NO_NEIGHBOR_UPDATE (StructureHost.blockUpdate): gravity blocks fall, unsupported
   * blocks pop off, liquids are woken. Queued; runs at the next flush().
   */
  updateAround(x: number, y: number, z: number): void {
    this.enqueueAround(x, y, z);
    this.sim.fluids.wakeAround(x, y, z);
  }

  /** The simulation's world change hook. */
  onWorldChange(x: number, y: number, z: number, oldCell: number, newCell: number, flags: number): void {
    if ((flags & SET_NO_NEIGHBOR_UPDATE) !== 0) return;
    if (washedAway(oldCell, newCell)) spawnBlockDrop(this.sim, this.sim.world, x, y, z, oldCell, this.tmp);
    this.enqueueAround(x, y, z);
  }

  /**
   * Change hook of a structure grid. Support rules look straight down (local -Y), so only the
   * cell above can be affected — and the changed cell itself when something was placed there.
   */
  onStructureChange(grid: VoxelGrid, x: number, y: number, z: number, oldCell: number, newCell: number, flags: number): void {
    if ((flags & SET_NO_NEIGHBOR_UPDATE) !== 0) return;
    if ((oldCell & ID_MASK) === (newCell & ID_MASK)) return;
    this.gridQueue.push(grid, grid);
    this.gridCoords.push(x, y + 1, z, x, y, z);
  }

  /** A scheduled tick of a non-liquid block fired (the dispatcher checked the id still matches). */
  scheduledTick(x: number, y: number, z: number, blockId: number): void {
    if (GRAVITY_BLOCK[blockId & ID_MASK] !== 1) return;
    const world = this.sim.world;
    const cell = world.getCell(x, y, z);
    if ((cell & ID_MASK) !== blockId) return;
    if (SOLID[world.getCell(x, y - 1, z) & ID_MASK] === 1) return; // supported again meanwhile
    if (!world.setCell(x, y, z, AIR)) return;
    this.sim.entities.spawnFalling(x, y, z, cell);
  }

  /** Drain the queue. Re-entrant calls (from a change made while draining) return at once. */
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      let steps = 0;
      const wq = this.worldQueue;
      const gq = this.gridQueue;
      const gc = this.gridCoords;
      while ((wq.length > 0 || gq.length > 0) && steps < MAX_FLUSH_STEPS) {
        // Process in rounds: everything queued so far, then whatever those changes queued.
        let i = 0;
        for (; i < wq.length && steps < MAX_FLUSH_STEPS; i += 3, steps++) this.evaluateWorld(wq[i]!, wq[i + 1]!, wq[i + 2]!);
        wq.splice(0, i);
        let k = 0;
        for (; k < gq.length && steps < MAX_FLUSH_STEPS; k++, steps++) {
          this.evaluateStructure(gq[k]!, gc[k * 3]!, gc[k * 3 + 1]!, gc[k * 3 + 2]!);
        }
        gq.splice(0, k);
        gc.splice(0, k * 3);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Forget everything queued (loading a save). */
  clear(): void {
    this.worldQueue.length = 0;
    this.gridQueue.length = 0;
    this.gridCoords.length = 0;
  }

  // ------------------------------------------------------------ internals

  private enqueueAround(x: number, y: number, z: number): void {
    const q = this.worldQueue;
    q.push(x, y, z);
    for (let d = 0; d < 6; d++) q.push(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!);
  }

  private evaluateWorld(x: number, y: number, z: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const world = this.sim.world;
    if (!world.isLoaded(x, z)) return;
    const cell = world.getCell(x, y, z);
    const id = cell & ID_MASK;
    if (id === AIR || LIQUID[id] !== 0) return;
    const def = BLOCKS[id];
    if (def === undefined) return;
    // Below an unloaded chunk border or the world floor, getCell answers a HARD sentinel, so
    // nothing ever falls or pops into the unknown.
    const below = world.getCell(x, y - 1, z);
    if (def.gravity) {
      if (SOLID[below & ID_MASK] !== 1) world.scheduleTick(x, y, z, id, FALL_DELAY);
      return;
    }
    if (supportedBy(def.support, below)) return;
    if (!world.setCell(x, y, z, AIR)) return;
    spawnBlockDrop(this.sim, world, x, y, z, cell, this.tmp);
  }

  private evaluateStructure(grid: VoxelGrid, x: number, y: number, z: number): void {
    // The structure may have been blockified or destroyed since the change was queued.
    if (this.sim.structures.structureOf(grid) === null) return;
    const cell = grid.getCell(x, y, z);
    const id = cell & ID_MASK;
    if (id === AIR) return;
    const def = BLOCKS[id];
    if (def === undefined || def.support === 'none') return;
    if (supportedBy(def.support, grid.getCell(x, y - 1, z))) return;
    if (!grid.setCell(x, y, z, AIR)) return;
    spawnBlockDrop(this.sim, grid, x, y, z, cell, this.tmp);
  }
}
