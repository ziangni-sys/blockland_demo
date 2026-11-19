/**
 * Block updates: what happens to blocks when their surroundings change, and the scheduled
 * ticks of non-liquid blocks (docs/DESIGN.md "组装和方块化之后要触发方块更新").
 *
 *  - Gravity blocks (BlockDef.gravity: sand, gravel) with a non-HARD cell below get a short
 *    scheduled tick; when it fires and they are still unsupported they leave the world as a
 *    falling-block entity (which lands as a block, or as an item on a structure — LESSONS
 *    沙子落到船上悬浮).
 *  - Blocks with a support rule (BlockDef.support: torch, plants, snow cover, cactus) whose
 *    support is gone pop off as their drop (sim/support.ts: a torch needs the top face of the
 *    cell below fully covered by hard material). Chains (a cactus column) pop one after another.
 *    Blocks with a support rule are whole-cell models that cannot be cut, so popping one turns
 *    the whole cell into air and drops one item.
 *  - Partial cells (docs/SHAPES.md section 9.3): a cell with any part has a hard first part
 *    (invariant I7), so "the cell below is hard" (gravity) is true over a lower slab, an upper
 *    slab or a single octant alike: sand rests on any hard part.
 *  - A soft non-liquid block overwritten by a liquid is washed away and drops its item.
 *  - Structure grids follow the same support rule in their own local frame (a torch on a deck
 *    pops when the plank under it is mined or blown up). Gravity does not apply inside
 *    structures: their cells are held by the structure.
 *
 * WHEN. Changes are only QUEUED from the change hooks (which run inside World.setCell, while
 * other listeners may still be waiting for the same change); the queue is drained by flush(),
 * which the Simulation calls after each phase of a tick and the explosion code calls after a
 * blast. Re-evaluation is idempotent, so a cell queued twice costs a lookup, nothing more.
 *
 * Bulk moves (SET_NO_NEIGHBOR_UPDATE: assembling, blockifying, docking):
 *  - WORLD writes are skipped here; the structures module calls updateAround() for every
 *    touched world cell once the move is complete (StructureHost.blockUpdate).
 *  - STRUCTURE writes are queued like any other: nobody else re-checks them, and a rotor that
 *    blockifies into a ship (or starts from one) can leave a torch or a flower without the
 *    block under it. Since evaluation waits for flush(), it sees the move complete.
 *
 * Drops follow the world rules (sim/rules.ts): popped-off and washed-away blocks drop only when
 * the world's dropsEnabled is on, whoever caused the change.
 */
import { AIR, ID_MASK } from '../blocks/cell';
import { BLOCKS, GRAVITY_BLOCK, LIQUID, SOLID } from '../blocks/registry';
import { WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z } from '../core/dirs';
import { vec3 } from '../core/math';
import { SET_NO_NEIGHBOR_UPDATE, type VoxelGrid } from '../voxel/grid';
import { spawnBlockDrop } from './drops';
import type { Simulation } from './simulation';
import { supportOkAt } from './support';

/** Ticks between a gravity block losing its support and it starting to fall. */
export const FALL_DELAY = 2;
/**
 * Re-evaluations per flush() call. Support chains are short, so this is only a guard against
 * a pathological cascade stalling one tick; whatever is left stays queued for the next flush.
 */
const MAX_FLUSH_STEPS = 1 << 16;

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
    if (washedAway(oldCell, newCell) && this.sim.rules.dropsEnabled) spawnBlockDrop(this.sim, this.sim.world, x, y, z, oldCell, this.tmp);
    this.enqueueAround(x, y, z);
  }

  /**
   * Change hook of a structure grid, bulk moves included (see WHEN). Support rules look straight
   * down (local -Y), so only the cell above can be affected — and the changed cell itself when
   * something was put there. Any change of the content counts, not only a change of id: carving
   * the plank under a torch keeps the plank's id and can uncover the torch's support.
   */
  onStructureChange(grid: VoxelGrid, x: number, y: number, z: number, oldCell: number, newCell: number, _flags: number): void {
    if (oldCell === newCell) return;
    this.gridQueue.push(grid, grid);
    this.gridCoords.push(x, y + 1, z, x, y, z);
  }

  /** A scheduled tick of a non-liquid block fired (the dispatcher checked the id still matches). */
  scheduledTick(x: number, y: number, z: number, blockId: number): void {
    if (GRAVITY_BLOCK[blockId & ID_MASK] !== 1) return;
    const world = this.sim.world;
    const cell = world.getCell(x, y, z);
    if ((cell & ID_MASK) !== blockId) return;
    if (SOLID[world.getCell(x, y - 1, z) & ID_MASK] === 1) return; // supported again meanwhile (any part counts, I7)
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
    if (def.gravity) {
      // Any part makes the cell below hard (I7): sand rests on slabs and single octants.
      if (SOLID[world.getCell(x, y - 1, z) & ID_MASK] !== 1) world.scheduleTick(x, y, z, id, FALL_DELAY);
      return;
    }
    if (supportOkAt(def, world, x, y, z)) return;
    if (!world.setCell(x, y, z, AIR)) return;
    if (this.sim.rules.dropsEnabled) spawnBlockDrop(this.sim, world, x, y, z, cell, this.tmp);
  }

  private evaluateStructure(grid: VoxelGrid, x: number, y: number, z: number): void {
    // The structure may have been blockified or destroyed since the change was queued.
    if (this.sim.structures.structureOf(grid) === null) return;
    const cell = grid.getCell(x, y, z);
    const id = cell & ID_MASK;
    if (id === AIR) return;
    const def = BLOCKS[id];
    if (def === undefined || def.support === 'none') return;
    if (supportOkAt(def, grid, x, y, z)) return;
    if (!grid.setCell(x, y, z, AIR)) return;
    if (this.sim.rules.dropsEnabled) spawnBlockDrop(this.sim, grid, x, y, z, cell, this.tmp);
  }
}
