/**
 * Flowing liquids — water and lava — in the WORLD grid. Structures never contain liquid
 * (docs/DESIGN.md "结构体里没有液体"), so this module only ever reads and writes the World.
 *
 * MODEL (the classic flowing-fluid cellular automaton, docs/DESIGN.md 液体)
 *  - Cell state (blocks/cell.ts): level 0 = source, 1..7 = flowing with amount 8 - level,
 *    LIQUID_FALLING = a full column fed from directly above (amount 8, never a source).
 *  - A liquid cell changes only inside its own scheduled tick. Ticks are scheduled by the
 *    world change hook (attach()): whenever a cell changes, the cell itself (if liquid) and
 *    every liquid among its 6 neighbours is ticked `delay` ticks later (water 5, lava 30).
 *    tick() never schedules anything itself: its own writes wake the neighbourhood through
 *    the same hook as every other edit (player, explosions, structures), so there is exactly
 *    one scheduling path. A write flagged SET_NO_NEIGHBOR_UPDATE wakes only the written cell.
 *  - One tick of a liquid cell:
 *      1. lava touching water hardens (source -> obsidian, flowing -> rubble); water stays;
 *      2. a non-source recomputes its state from its neighbours (infinite water source,
 *         falling column, or strongest horizontal neighbour minus the drop-off; <= 0 dries up);
 *      3. it spreads: down if the cell below accepts liquid (becomes a falling column);
 *         otherwise sideways — sources always, flowing cells only when not standing over a
 *         "hole" (air, a soft block or the same liquid: flowing water neither fans out at
 *         every level of a waterfall nor creeps across the surface of a pool) — toward the
 *         horizontal directions with the shortest path to a hole (slope search), or all
 *         directions when no hole is within reach.
 *  - Chunks: call rescheduleChunk() after every World.addChunk() (generated or loaded).
 *
 * UNLOADED CHUNKS. The automaton never takes a decision from data it does not have:
 *  - a tick whose cell borders an unloaded chunk (horizontally) is deferred whole;
 *  - a slope search that meets an unloaded cell before it can prove the answer is deferred.
 * Deferred cells are remembered and re-woken by rescheduleChunk() when a chunk near them
 * loads. This keeps the end state independent of chunk load order and timing, and nothing is
 * ever written into an unloaded chunk. Consequence: liquid within slope-search reach (up to
 * 5 cells for water) of an unloaded chunk waits for it — exactly like the edge of the loaded
 * area in the classic game, which does not tick border chunks either.
 *
 * DEVIATIONS from the classic rules, on purpose:
 *  - spreading may also raise a same-liquid FLOWING cell that holds less than the incoming
 *    amount (classic code leaves that to the neighbour's own tick; the end state is the
 *    same, it just converges sooner);
 *  - lava-water contact converts only the lava, in all six directions (classic lava pouring
 *    DOWN onto water turns the water into stone); water is never consumed;
 *  - no random lava slow-down: the simulation is deterministic.
 */
import { HORIZONTAL_DIRS, DIR_X, DIR_Z } from '../core/dirs';
import { CHUNK_MASK, CHUNK_SHIFT, CHUNK_SIZE, WORLD_HEIGHT } from '../core/constants';
import { AIR, ID_MASK, LIQUID_FALLING, STATE_SHIFT, liquidAmount, makeCell } from '../blocks/cell';
import { B, CELL_BELOW_WORLD, CELL_UNLOADED } from '../blocks/defs';
import { LIQUID, SOLID } from '../blocks/registry';
import type { Chunk } from '../voxel/chunk';
import { SET_NO_NEIGHBOR_UPDATE } from '../voxel/grid';
import { posKey, type World } from '../voxel/world';

// ------------------------------------------------------------------ tuning (docs/DESIGN.md 液体)

/** Ticks between updates of a water cell. */
export const WATER_TICK_DELAY = 5;
/** Ticks between updates of a lava cell. */
export const LAVA_TICK_DELAY = 30;
/** Amount lost per horizontal step. */
export const WATER_DROP_OFF = 1;
export const LAVA_DROP_OFF = 2;
/** How far (in BFS steps beyond the first neighbour) the slope search looks for a hole. */
export const WATER_SLOPE_DISTANCE = 4;
export const LAVA_SLOPE_DISTANCE = 2;
/**
 * Delay of the tick that hardens lava after water appears next to it (or lava next to
 * water). Short so the reaction looks immediate, but never inside the change hook itself:
 * writing the world from inside a world listener would reorder events for later listeners.
 */
export const CONTACT_TICK_DELAY = 1;

/** Static behaviour of one liquid block type. */
interface LiquidProps {
  readonly id: number;
  readonly delay: number;
  readonly dropOff: number;
  readonly slopeDistance: number;
  /** Two horizontally adjacent sources over a hard block or a source create a new source. */
  readonly infinite: boolean;
  /** Turns into obsidian / rubble when touching water. */
  readonly hardens: boolean;
}

const WATER: LiquidProps = Object.freeze({
  id: B.WATER,
  delay: WATER_TICK_DELAY,
  dropOff: WATER_DROP_OFF,
  slopeDistance: WATER_SLOPE_DISTANCE,
  infinite: true,
  hardens: false,
});
const LAVA: LiquidProps = Object.freeze({
  id: B.LAVA,
  delay: LAVA_TICK_DELAY,
  dropOff: LAVA_DROP_OFF,
  slopeDistance: LAVA_SLOPE_DISTANCE,
  infinite: false,
  hardens: true,
});

function liquidProps(blockId: number): LiquidProps | null {
  return blockId === B.WATER ? WATER : blockId === B.LAVA ? LAVA : null;
}

// ------------------------------------------------------------------ cell helpers

const SOURCE = 0;
/** Falling column state: level 0 + falling bit (amount 8, not a source). */
const FALLING = LIQUID_FALLING;
/** nextState() result for "the cell dries up". */
const DRY = -1;
/** Liquid state bits (level + falling); the two upper state bits are unused by liquids. */
const LIQUID_STATE_BITS = 15;

const CELL_OBSIDIAN = makeCell(B.OBSIDIAN);
const CELL_RUBBLE = makeCell(B.COBBLE);

function liquidStateOf(cell: number): number {
  return (cell >>> STATE_SHIFT) & LIQUID_STATE_BITS;
}

/**
 * Can liquid `id` arriving with `amount` (1..8) be written into this cell?
 * Air and soft non-liquid blocks (plants, torch, snow cover) are washed away; a same-liquid
 * flowing cell is raised when it holds less. Never hard blocks (this includes unloaded space
 * and the deeprock below y = 0), never sources, never the other liquid.
 */
function canFlowInto(cell: number, id: number, amount: number): boolean {
  const cid = cell & ID_MASK;
  if (SOLID[cid] === 1) return false;
  if (LIQUID[cid] === 0) return true;
  if (cid !== id) return false;
  const s = liquidStateOf(cell);
  return s !== SOURCE && liquidAmount(s) < amount;
}

/** Slope search: can the liquid travel through this cell? (independent of amounts) */
function isPassable(cell: number, id: number): boolean {
  const cid = cell & ID_MASK;
  if (SOLID[cid] === 1) return false;
  if (LIQUID[cid] === 0) return true;
  return cid === id && liquidStateOf(cell) !== SOURCE;
}

/**
 * Is a cell whose BELOW neighbour is `below` a hole, i.e. would liquid there go down rather
 * than sideways? True over air / soft blocks and over the same liquid in any state (a falling
 * column, or a pool: classic rule — flowing liquid does not creep across the surface of a pool
 * or fan out at every level of a waterfall). The other liquid is not a hole: contact hardens
 * it into a solid block.
 */
function isHoleBelow(below: number, id: number): boolean {
  const bid = below & ID_MASK;
  return SOLID[bid] === 0 && (LIQUID[bid] === 0 || bid === id);
}

/** A neighbour that keeps `source` at rest: a hard block or the very same source cell. */
function holdsSource(neighbour: number, source: number): boolean {
  return neighbour === source || SOLID[neighbour & ID_MASK] === 1;
}

// ------------------------------------------------------------------ direction tables

const HDX: readonly number[] = Object.freeze(HORIZONTAL_DIRS.map((d) => DIR_X[d]!));
const HDZ: readonly number[] = Object.freeze(HORIZONTAL_DIRS.map((d) => DIR_Z[d]!));

// Slope-search scratch grid: a square centred on the searching cell, big enough for the
// widest reach (water: first neighbour + 4 more steps = Manhattan radius 5).
const REACH = Math.max(WATER_SLOPE_DISTANCE, LAVA_SLOPE_DISTANCE) + 1;
const SIDE = REACH * 2 + 1;
const SLOPE_CELLS = SIDE * SIDE;
const CENTER = REACH * SIDE + REACH;
/** Grid index offset of each horizontal direction. */
const HOFF: readonly number[] = Object.freeze(HORIZONTAL_DIRS.map((d) => DIR_X[d]! + DIR_Z[d]! * SIDE));
/** Grid index -> offset from the centre. */
const GX: Int8Array = new Int8Array(SLOPE_CELLS);
const GZ: Int8Array = new Int8Array(SLOPE_CELLS);
for (let i = 0; i < SLOPE_CELLS; i++) {
  GX[i] = (i % SIDE) - REACH;
  GZ[i] = Math.floor(i / SIDE) - REACH;
}
const BLOCKED = -1;
/** slopeDirections() result when the answer depends on an unloaded chunk. */
const UNKNOWN = -1;

interface DeferredCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// ------------------------------------------------------------------ Fluids

export class Fluids {
  private readonly world: World;
  private detachFn: (() => void) | null = null;

  /** Cells whose tick was postponed because it needed an unloaded chunk (key: posKey). */
  private readonly deferred = new Map<number, DeferredCell>();

  // Slope-search scratch (allocation-free BFS). `seen` holds the search stamp that last
  // touched an entry, so nothing has to be cleared between searches.
  private readonly seen = new Uint32Array(SLOPE_CELLS);
  private readonly level = new Int8Array(SLOPE_CELLS);
  private readonly dirMask = new Uint8Array(SLOPE_CELLS);
  private readonly hole = new Uint8Array(SLOPE_CELLS);
  private readonly frontA = new Uint8Array(SLOPE_CELLS);
  private readonly frontB = new Uint8Array(SLOPE_CELLS);
  private stamp = 0;

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Subscribe to world.onCellChange: any cell change schedules the liquid ticks it can affect
   * (the cell itself when it is liquid, and liquid neighbours). Returns the unsubscribe
   * function. Calling attach() again while attached returns the same function.
   */
  attach(): () => void {
    if (this.detachFn) return this.detachFn;
    const off = this.world.onCellChange(this.onCellChange);
    const detach = (): void => {
      if (this.detachFn !== detach) return;
      off();
      this.detachFn = null;
    };
    this.detachFn = detach;
    return detach;
  }

  /** True for block ids handled here (B.WATER, B.LAVA). */
  handles(blockId: number): boolean {
    return blockId === B.WATER || blockId === B.LAVA;
  }

  /** Number of cells waiting for an unloaded chunk (diagnostics and tests). */
  get deferredCount(): number {
    return this.deferred.size;
  }

  /**
   * Run one scheduled tick for the liquid at (x,y,z). The simulation's tick dispatcher calls
   * this for every due ScheduledTick whose id handles() accepts. A tick whose block id no
   * longer matches the cell is ignored.
   */
  tick(x: number, y: number, z: number, blockId: number): void {
    const L = liquidProps(blockId);
    if (!L) return;
    const world = this.world;
    const cell = world.getCell(x, y, z);
    if ((cell & ID_MASK) !== L.id) return;
    if (!this.neighboursLoaded(x, z)) {
      this.defer(x, y, z);
      return;
    }
    let state = liquidStateOf(cell);

    if (L.hardens && this.touchesWater(x, y, z)) {
      world.setCell(x, y, z, state === SOURCE ? CELL_OBSIDIAN : CELL_RUBBLE);
      return;
    }

    if (state !== SOURCE) {
      const next = this.nextState(x, y, z, L);
      if (next === DRY) {
        world.setCell(x, y, z, AIR);
        return;
      }
      if (next !== state) {
        const nextCell = makeCell(L.id, next);
        world.setCell(x, y, z, nextCell);
        // Another change listener may have replaced the cell synchronously.
        if (world.getCell(x, y, z) !== nextCell) return;
        state = next;
      }
    }
    this.spread(x, y, z, L, state);
  }

  /**
   * After a chunk was generated or loaded from a save (and added to the world): schedule
   * ticks for every liquid cell in it that is not at rest, so nothing stays frozen mid-flow
   * (docs/LESSONS.md 读档后液体冻在半路). Also re-checks the liquid on the facing border of
   * each loaded neighbour (it may now have somewhere to go) and wakes deferred cells near
   * the chunk. Cheap for chunks full of resting ocean. Call it after world.addChunk(), also
   * when pending ticks were restored from a save (deferred cells are not part of the queue).
   */
  rescheduleChunk(chunk: Chunk): void {
    const world = this.world;
    if (world.getChunk(chunk.cx, chunk.cz) !== chunk) return; // not (or no longer) in the world
    this.scanColumns(chunk, 0, CHUNK_MASK, 0, CHUNK_MASK);
    // Border columns of loaded neighbours facing this chunk: until now they saw unloaded
    // (solid) space here, so their at-rest status may have changed.
    for (let d = 0; d < 4; d++) {
      const dx = HDX[d]!;
      const dz = HDZ[d]!;
      const n = world.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (!n) continue;
      // n lies in direction d, so the face touching `chunk` is n's border on the opposite side.
      if (dx !== 0) {
        const lx = dx === 1 ? 0 : CHUNK_MASK;
        this.scanColumns(n, lx, lx, 0, CHUNK_MASK);
      } else {
        const lz = dz === 1 ? 0 : CHUNK_MASK;
        this.scanColumns(n, 0, CHUNK_MASK, lz, lz);
      }
    }
    this.wakeDeferred(chunk.cx << CHUNK_SHIFT, chunk.cz << CHUNK_SHIFT);
  }

  /**
   * Schedule every restless liquid cell of `chunk` in the column range [lx0..lx1] x [lz0..lz1].
   * Water sources boxed in below and on all four sides by hard blocks or identical sources —
   * the bulk of every ocean and lake — are recognised straight from the chunk arrays (the
   * same verdict isRestless() would give at ~6 world lookups per cell; the simulation rescans
   * a chunk's neighbours on every chunk load, so this path must stay cheap).
   */
  private scanColumns(chunk: Chunk, lx0: number, lx1: number, lz0: number, lz1: number): void {
    const world = this.world;
    const cells = chunk.cells;
    const x0 = chunk.cx << CHUNK_SHIFT;
    const z0 = chunk.cz << CHUNK_SHIFT;
    // Neighbour arrays for border reads; a missing neighbour reads as unloaded (hard).
    const east = world.getChunk(chunk.cx + 1, chunk.cz)?.cells ?? null;
    const west = world.getChunk(chunk.cx - 1, chunk.cz)?.cells ?? null;
    const south = world.getChunk(chunk.cx, chunk.cz + 1)?.cells ?? null;
    const north = world.getChunk(chunk.cx, chunk.cz - 1)?.cells ?? null;
    const ROW = CHUNK_SIZE;
    const FLIP_X = CHUNK_MASK; // index distance between lx = 15 and lx = 0 of the same row
    const FLIP_Z = CHUNK_MASK * ROW;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      const layer = y << 8;
      for (let lz = lz0; lz <= lz1; lz++) {
        for (let lx = lx0; lx <= lx1; lx++) {
          const i = layer | (lz << CHUNK_SHIFT) | lx;
          const c = cells[i]!;
          const id = c & ID_MASK;
          if (LIQUID[id] === 0) continue;
          if (id === B.WATER && liquidStateOf(c) === SOURCE) {
            const below = y > 0 ? cells[i - 256]! : CELL_BELOW_WORLD;
            const e = lx < CHUNK_MASK ? cells[i + 1]! : east ? east[i - FLIP_X]! : CELL_UNLOADED;
            const w = lx > 0 ? cells[i - 1]! : west ? west[i + FLIP_X]! : CELL_UNLOADED;
            const s = lz < CHUNK_MASK ? cells[i + ROW]! : south ? south[i - FLIP_Z]! : CELL_UNLOADED;
            const n = lz > 0 ? cells[i - ROW]! : north ? north[i + FLIP_Z]! : CELL_UNLOADED;
            if (
              holdsSource(below, c) &&
              holdsSource(e, c) &&
              holdsSource(w, c) &&
              holdsSource(s, c) &&
              holdsSource(n, c)
            ) {
              continue;
            }
          }
          this.scheduleIfRestless(x0 + lx, y, z0 + lz, c);
        }
      }
    }
  }

  // ---------------------------------------------------------------- change hook

  private readonly onCellChange = (
    x: number,
    y: number,
    z: number,
    _oldCell: number,
    newCell: number,
    flags: number,
  ): void => {
    if (LIQUID[newCell & ID_MASK] !== 0) this.scheduleCell(x, y, z, newCell);
    if ((flags & SET_NO_NEIGHBOR_UPDATE) !== 0) return;
    this.scheduleIfLiquid(x + 1, y, z);
    this.scheduleIfLiquid(x - 1, y, z);
    this.scheduleIfLiquid(x, y + 1, z);
    this.scheduleIfLiquid(x, y - 1, z);
    this.scheduleIfLiquid(x, y, z + 1);
    this.scheduleIfLiquid(x, y, z - 1);
  };

  private scheduleIfLiquid(x: number, y: number, z: number): void {
    const c = this.world.getCell(x, y, z);
    if (LIQUID[c & ID_MASK] !== 0) this.scheduleCell(x, y, z, c);
  }

  /** Schedule the tick of a liquid cell; lava already touching water reacts right away. */
  private scheduleCell(x: number, y: number, z: number, cell: number): void {
    const L = liquidProps(cell & ID_MASK);
    if (!L) return;
    const delay = L.hardens && this.touchesWater(x, y, z) ? CONTACT_TICK_DELAY : L.delay;
    this.world.scheduleTick(x, y, z, L.id, delay);
  }

  private scheduleIfRestless(x: number, y: number, z: number, cell: number): void {
    const L = liquidProps(cell & ID_MASK);
    if (L && this.isRestless(x, y, z, cell, L)) this.scheduleCell(x, y, z, cell);
  }

  /**
   * Would a tick of this cell change anything? Mirrors tick() step by step, except that it
   * does not run the slope search: any neighbour able to receive liquid counts as restless.
   * So it may say "restless" for a cell whose tick then does nothing, but never the reverse.
   */
  private isRestless(x: number, y: number, z: number, cell: number, L: LiquidProps): boolean {
    const world = this.world;
    const id = L.id;
    const state = liquidStateOf(cell);
    if (L.hardens && this.touchesWater(x, y, z)) return true;
    if (state !== SOURCE && this.nextState(x, y, z, L) !== state) return true;
    const below = world.getCell(x, y - 1, z);
    if (canFlowInto(below, id, 8)) return true;
    if (state !== SOURCE && isHoleBelow(below, id)) return false;
    const side = liquidAmount(state) - L.dropOff;
    if (side <= 0) return false;
    for (let d = 0; d < 4; d++) {
      if (canFlowInto(world.getCell(x + HDX[d]!, y, z + HDZ[d]!), id, side)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- rules

  /**
   * New state of a non-source cell from its surroundings, or DRY.
   * Order matters (classic): infinite source first, then the falling column, then the
   * strongest horizontal neighbour minus the drop-off.
   */
  private nextState(x: number, y: number, z: number, L: LiquidProps): number {
    const world = this.world;
    const id = L.id;
    let best = 0;
    let sources = 0;
    for (let d = 0; d < 4; d++) {
      const c = world.getCell(x + HDX[d]!, y, z + HDZ[d]!);
      if ((c & ID_MASK) !== id) continue;
      const s = liquidStateOf(c);
      if (s === SOURCE) sources++;
      const a = liquidAmount(s);
      if (a > best) best = a;
    }
    if (L.infinite && sources >= 2) {
      const below = world.getCell(x, y - 1, z);
      if (SOLID[below & ID_MASK] === 1 || ((below & ID_MASK) === id && liquidStateOf(below) === SOURCE)) {
        return SOURCE;
      }
    }
    if ((world.getCell(x, y + 1, z) & ID_MASK) === id) return FALLING;
    const amount = best - L.dropOff;
    return amount > 0 ? 8 - amount : DRY;
  }

  private spread(x: number, y: number, z: number, L: LiquidProps, state: number): void {
    const world = this.world;
    const id = L.id;
    const below = world.getCell(x, y - 1, z);
    if (canFlowInto(below, id, 8)) {
      this.flowTo(x, y - 1, z, L, FALLING);
      return; // over a hole liquid only falls
    }
    if (state !== SOURCE && isHoleBelow(below, id)) return;

    const side = liquidAmount(state) - L.dropOff;
    if (side <= 0) return;
    // Cheap exit before the slope search: most ticks of settled liquid end here.
    let receivers = 0;
    for (let d = 0; d < 4; d++) {
      if (canFlowInto(world.getCell(x + HDX[d]!, y, z + HDZ[d]!), id, side)) receivers |= 1 << d;
    }
    if (receivers === 0) return;

    const slope = this.slopeDirections(x, y, z, L);
    if (slope === UNKNOWN) {
      this.defer(x, y, z);
      return;
    }
    const dirs = slope & receivers;
    const level = 8 - side;
    for (let d = 0; d < 4; d++) {
      if ((dirs & (1 << d)) === 0) continue;
      const nx = x + HDX[d]!;
      const nz = z + HDZ[d]!;
      // Re-read: an earlier write in this loop (or another listener) may have changed it.
      if (canFlowInto(world.getCell(nx, y, nz), id, side)) this.flowTo(nx, y, nz, L, level);
    }
  }

  /** Write liquid into a cell; lava arriving next to water hardens on the spot. */
  private flowTo(x: number, y: number, z: number, L: LiquidProps, state: number): void {
    // Spreading never creates a source, so arriving lava always becomes rubble.
    const cell = L.hardens && this.touchesWater(x, y, z) ? CELL_RUBBLE : makeCell(L.id, state);
    this.world.setCell(x, y, z, cell);
  }

  /**
   * Slope search. Returns a bitmask (bit d = HORIZONTAL_DIRS[d]) of the directions whose
   * first cell lies on a shortest path to a hole, the mask of all passable directions when no
   * hole is within reach, or UNKNOWN when the answer depends on an unloaded chunk.
   *
   * Level-synchronous BFS from the four neighbours at once. Each visited cell carries the set
   * of first directions that reach it at its (minimal) level, so the union over the holes of
   * the first level that has any is exactly the classic "directions with minimal slope
   * distance" (a path that runs through a cell another direction reached earlier can never be
   * minimal). The searching cell itself is a wall. Holes are looked for up to
   * `slopeDistance` steps beyond the first neighbour.
   */
  private slopeDirections(x: number, y: number, z: number, L: LiquidProps): number {
    const id = L.id;
    // Most of the search area lies in the searching cell's own chunk: read that one directly.
    const home = this.world.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
    if (!home) return UNKNOWN; // unreachable: the cell itself was just read from it
    const hc = home.cells;
    const hx = home.cx << CHUNK_SHIFT;
    const hz = home.cz << CHUNK_SHIFT;
    const seen = this.seen;
    const level = this.level;
    const mask = this.dirMask;
    const hole = this.hole;
    const stamp = this.nextStamp();

    seen[CENTER] = stamp;
    level[CENTER] = BLOCKED;
    let cur = this.frontA;
    let next = this.frontB;
    let n = 0;
    let passable = 0;
    let holes = 0;
    for (let d = 0; d < 4; d++) {
      const i = CENTER + HOFF[d]!;
      seen[i] = stamp;
      const qx = x + HDX[d]!;
      const qz = z + HDZ[d]!;
      const c = this.peek(hc, hx, hz, qx, y, qz);
      if (c === CELL_UNLOADED) return UNKNOWN;
      if (!isPassable(c, id)) {
        level[i] = BLOCKED;
        continue;
      }
      level[i] = 0;
      mask[i] = 1 << d;
      passable |= 1 << d;
      if (isHoleBelow(this.peek(hc, hx, hz, qx, y - 1, qz), id)) holes |= 1 << d;
      cur[n++] = i;
    }
    if (holes !== 0) return holes;

    for (let lv = 1; lv <= L.slopeDistance && n > 0; lv++) {
      let unknown = false;
      let m = 0;
      for (let k = 0; k < n; k++) {
        const p = cur[k]!;
        const pm = mask[p]!;
        for (let d = 0; d < 4; d++) {
          // Cells of level lv lie at Manhattan distance lv + 1 <= REACH: always inside the grid.
          const q = p + HOFF[d]!;
          if (seen[q] === stamp) {
            if (level[q] === lv) mask[q] |= pm;
            continue;
          }
          seen[q] = stamp;
          const qx = x + GX[q]!;
          const qz = z + GZ[q]!;
          const c = this.peek(hc, hx, hz, qx, y, qz);
          if (c === CELL_UNLOADED) {
            level[q] = BLOCKED;
            unknown = true;
            continue;
          }
          if (!isPassable(c, id)) {
            level[q] = BLOCKED;
            continue;
          }
          level[q] = lv;
          mask[q] = pm;
          hole[q] = isHoleBelow(this.peek(hc, hx, hz, qx, y - 1, qz), id) ? 1 : 0;
          next[m++] = q;
        }
      }
      // An unloaded cell at this level could itself be a hole (or tie with one), or lead to
      // one further on: no answer from here can be trusted.
      if (unknown) return UNKNOWN;
      for (let k = 0; k < m; k++) {
        const q = next[k]!;
        if (hole[q] === 1) holes |= mask[q]!;
      }
      if (holes !== 0) return holes;
      const t = cur;
      cur = next;
      next = t;
      n = m;
    }
    return passable;
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Cell at (qx, qy, qz): straight from `cells` (the chunk whose origin is hx, hz) when the
   * position lies inside it, else through the world (unloaded / below-world rules apply).
   */
  private peek(cells: Uint16Array, hx: number, hz: number, qx: number, qy: number, qz: number): number {
    const lx = qx - hx;
    const lz = qz - hz;
    if (((lx | lz) & ~CHUNK_MASK) === 0 && qy >= 0) return cells[lx | (lz << CHUNK_SHIFT) | (qy << 8)]!;
    return this.world.getCell(qx, qy, qz);
  }

  private touchesWater(x: number, y: number, z: number): boolean {
    const w = this.world;
    const W = B.WATER;
    return (
      (w.getCell(x + 1, y, z) & ID_MASK) === W ||
      (w.getCell(x - 1, y, z) & ID_MASK) === W ||
      (w.getCell(x, y, z + 1) & ID_MASK) === W ||
      (w.getCell(x, y, z - 1) & ID_MASK) === W ||
      (w.getCell(x, y + 1, z) & ID_MASK) === W ||
      (w.getCell(x, y - 1, z) & ID_MASK) === W
    );
  }

  /** Are the chunks of the 4 horizontal neighbours loaded? (The cell's own chunk is.) */
  private neighboursLoaded(x: number, z: number): boolean {
    const lx = x & CHUNK_MASK;
    const lz = z & CHUNK_MASK;
    if (lx !== 0 && lx !== CHUNK_MASK && lz !== 0 && lz !== CHUNK_MASK) return true;
    const w = this.world;
    return w.isLoaded(x + 1, z) && w.isLoaded(x - 1, z) && w.isLoaded(x, z + 1) && w.isLoaded(x, z - 1);
  }

  private defer(x: number, y: number, z: number): void {
    const k = posKey(x, y, z);
    if (!this.deferred.has(k)) this.deferred.set(k, { x, y, z });
  }

  /**
   * Re-schedule deferred cells whose search area overlaps the chunk at (x0, z0) (it may be
   * what they were waiting for). Entries whose own chunk is gone are dropped: when it comes
   * back, rescheduleChunk() scans it anyway.
   */
  private wakeDeferred(x0: number, z0: number): void {
    if (this.deferred.size === 0) return;
    const world = this.world;
    // Deleting the current entry while iterating a Map is well defined.
    for (const [k, p] of this.deferred) {
      if (!world.isLoaded(p.x, p.z)) {
        this.deferred.delete(k);
        continue;
      }
      if (p.x + REACH < x0 || p.x - REACH >= x0 + CHUNK_SIZE) continue;
      if (p.z + REACH < z0 || p.z - REACH >= z0 + CHUNK_SIZE) continue;
      this.deferred.delete(k);
      this.scheduleIfLiquid(p.x, p.y, p.z);
    }
  }

  private nextStamp(): number {
    let s = (this.stamp + 1) >>> 0;
    if (s === 0) {
      // Wrapped after 2^32 searches: stale stamps could collide, start over.
      this.seen.fill(0);
      s = 1;
    }
    this.stamp = s;
    return s;
  }
}

/**
 * Helper for tests and tools: advance the world `ticks` ticks, running only liquid ticks.
 * n times { world.time++; for each tick of world.ticks.takeDue(world.time) call fluids.tick
 * if fluids.handles(tick.id) }.
 */
export function pumpTicks(world: World, fluids: Fluids, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    world.time++;
    const due = world.ticks.takeDue(world.time);
    for (let k = 0; k < due.length; k++) {
      const t = due[k]!;
      if (fluids.handles(t.id)) fluids.tick(t.x, t.y, t.z, t.id);
    }
  }
}
