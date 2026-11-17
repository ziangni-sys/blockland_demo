/**
 * Flowing liquids — water and lava — in the WORLD grid. Structures never contain liquid
 * (docs/DESIGN.md "结构体里没有液体"), so this module only ever reads and writes the World.
 *
 * MODEL (the classic FlowingFluid cellular automaton, docs/DESIGN.md 液体)
 *  - Cell state (blocks/cell.ts): level 0 = source, 1..7 = flowing with amount 8 - level,
 *    LIQUID_FALLING = a full column fed from directly above (amount 8, never a source).
 *  - A liquid cell changes only inside its own scheduled tick. Ticks are scheduled by the
 *    world change hook (attach()); tick() never schedules anything itself: its own writes wake
 *    the neighbourhood through the same hook as every other edit (player, explosions,
 *    structures), so there is exactly one scheduling path.
 *  - One tick of a liquid cell:
 *      1. lava touching water hardens (source -> obsidian, flowing -> rubble); water stays;
 *      2. a non-source recomputes its state from its neighbours (infinite water source,
 *         falling column, or strongest horizontal neighbour minus the drop-off; <= 0 dries up);
 *      3. it spreads: down if the cell below accepts liquid (becomes a falling column);
 *         otherwise sideways — sources always, flowing cells only when not standing over a
 *         "hole" (any non-hard cell: flowing water neither fans out at every level of a
 *         waterfall nor creeps across the surface of a pool) — toward the horizontal
 *         directions with the shortest path to a hole (slope search), or all directions when
 *         no hole is within reach.
 *
 * WHAT WAKES A LIQUID CELL (so that an empty queue really means "settled": loading, or
 * rescheduling every chunk, changes nothing — LESSONS 读档后液体冻在半路 in reverse).
 * A tick reads the cell's 6 neighbours, and its slope search reads cells up to REACH columns
 * away on its own layer plus the layer below. So a cell change wakes
 *  - the cell itself when it is liquid, and every liquid among its 6 neighbours;
 *  - when the change alters what the slope search sees (hard <-> not hard, or a source of that
 *    liquid appearing / disappearing): the restless liquid cells of the affected kind within
 *    slope reach on the changed layer and the layer above.
 * Flow writes (air <-> flowing, level changes) never alter what a slope search sees, so the
 * wide wake costs nothing while liquid spreads. A write flagged SET_NO_NEIGHBOR_UPDATE wakes
 * only the written cell; whoever writes that way must call wakeAround() afterwards (bulk
 * structure moves do, through StructureHost.blockUpdate).
 *
 * UNLOADED CHUNKS. The automaton never takes a decision from data it does not have, and never
 * writes into an unloaded chunk. Every read that could hit one (horizontal neighbours, cells
 * of the slope search, water around a lava target) is checked; when the outcome of a tick
 * would depend on such a read, the tick is deferred whole. Decisions that do not depend on it
 * go ahead: a waterfall on the edge of the loaded area keeps falling. Deferred cells are
 * remembered and woken by rescheduleChunk() when a chunk within their reach loads. This keeps
 * the end state independent of chunk load order (and, for a single liquid, of load pace).
 * Consequence: liquid whose slope search could reach unloaded space (up to REACH = 5 cells
 * for water on open ground) waits for it — like the non-ticking border chunks of the classic
 * game.
 *
 * DEVIATIONS from the classic rules, on purpose:
 *  - spreading may also raise a same-liquid FLOWING cell that holds less than the incoming
 *    amount (classic code leaves that to the neighbour's own tick; the end state is the
 *    same, it just converges sooner);
 *  - lava-water contact converts only the lava, in all six directions (classic lava pouring
 *    DOWN onto water turns the water into stone); water is never consumed and never flows
 *    into lava (nor lava into water: lava arriving next to water is written as rubble);
 *  - no random lava slow-down: the simulation is deterministic.
 * Kept from the classic rules although a literal reading of the module brief differs:
 *  - flowing liquid over the same liquid (source or falling column) is over a hole and does
 *    not spread sideways — only sources do. Otherwise every waterfall into a lake leaves a
 *    113-cell film on its surface;
 *  - the slope search counts a cell over ANY non-hard cell as a hole (the same liquid in any
 *    state, the other liquid, air, soft blocks) and lets the search pass through every
 *    non-hard cell except a source of the searching liquid. Water is drawn to a lava pit and
 *    hardens it, as in the classic game;
 *  - slope reach is the first neighbour plus 4 (water) / 2 (lava) further steps.
 */
import { HORIZONTAL_DIRS, DIR_X, DIR_Z } from '../core/dirs';
import { CHUNK_MASK, CHUNK_SHIFT, CHUNK_SIZE, WORLD_HEIGHT } from '../core/constants';
import { AIR, ID_MASK, LIQUID_FALLING, STATE_SHIFT, liquidAmount, makeCell } from '../blocks/cell';
import { B, CELL_BELOW_WORLD, CELL_UNLOADED } from '../blocks/defs';
import { LIQUID, SOLID } from '../blocks/registry';
import type { Chunk } from '../voxel/chunk';
import { SET_NO_NEIGHBOR_UPDATE } from '../voxel/grid';
import { posKey, type World } from '../voxel/world';

// Imported values used on hot paths, bound once to module constants. Under the test runner
// (vite's SSR module transform) every use of an imported name is a property read on a module
// namespace object; with thousands of liquid ticks per world tick that made them 2-3x slower
// in headless runs. Bundled builds are unaffected either way.
const CELL_ID = ID_MASK;
const STATE_POS = STATE_SHIFT;
const IS_SOLID: Uint8Array = SOLID;
const LIQUID_KIND: Uint8Array = LIQUID;
const WATER_ID = B.WATER;
const LAVA_ID = B.LAVA;
const UNLOADED_ID = B.UNLOADED;
const LOCAL_MASK = CHUNK_MASK;
const LOCAL_SHIFT = CHUNK_SHIFT;
const NO_NEIGHBOR_UPDATE = SET_NO_NEIGHBOR_UPDATE;
const amountOf = liquidAmount;
const cellOf = makeCell;

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

const WATER_BIT = 1;
const LAVA_BIT = 2;
const BOTH_KINDS = WATER_BIT | LAVA_BIT;

/** Static behaviour of one liquid block type. */
interface LiquidProps {
  readonly id: number;
  /** WATER_BIT or LAVA_BIT. */
  readonly bit: number;
  readonly delay: number;
  readonly dropOff: number;
  readonly slopeDistance: number;
  /** Farthest Manhattan distance (columns) a slope search reads: first neighbour + slopeDistance. */
  readonly reach: number;
  /** Two horizontally adjacent sources over a hard block or a source create a new source. */
  readonly infinite: boolean;
  /** Turns into obsidian / rubble when touching water. */
  readonly hardens: boolean;
}

const WATER: LiquidProps = Object.freeze({
  id: WATER_ID,
  bit: WATER_BIT,
  delay: WATER_TICK_DELAY,
  dropOff: WATER_DROP_OFF,
  slopeDistance: WATER_SLOPE_DISTANCE,
  reach: WATER_SLOPE_DISTANCE + 1,
  infinite: true,
  hardens: false,
});
const LAVA: LiquidProps = Object.freeze({
  id: LAVA_ID,
  bit: LAVA_BIT,
  delay: LAVA_TICK_DELAY,
  dropOff: LAVA_DROP_OFF,
  slopeDistance: LAVA_SLOPE_DISTANCE,
  reach: LAVA_SLOPE_DISTANCE + 1,
  infinite: false,
  hardens: true,
});

function liquidProps(blockId: number): LiquidProps | null {
  return blockId === WATER_ID ? WATER : blockId === LAVA_ID ? LAVA : null;
}

// ------------------------------------------------------------------ cell helpers

const SOURCE = 0;
/** Falling column state: level 0 + falling bit (amount 8, not a source). */
const FALLING = LIQUID_FALLING;
/** nextState() result: the cell dries up. */
const DRY = -1;
/** nextState() result: the answer depends on a cell in an unloaded chunk. */
const UNDECIDED = -2;
/** Liquid state bits (level + falling); the two upper state bits are unused by liquids. */
const LIQUID_STATE_BITS = 15;

/** waterContact() results. */
const NO_CONTACT = 0;
const CONTACT = 1;
/** No loaded neighbour is water, but an unloaded one might be. */
const CONTACT_UNKNOWN = 2;

const CELL_OBSIDIAN = cellOf(B.OBSIDIAN);
const CELL_RUBBLE = cellOf(B.COBBLE);

/** Number of set bits of a 4-bit mask. */
const POP4: readonly number[] = Object.freeze([0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]);

function liquidStateOf(cell: number): number {
  return (cell >>> STATE_POS) & LIQUID_STATE_BITS;
}

function isUnloaded(cell: number): boolean {
  return (cell & CELL_ID) === UNLOADED_ID;
}

function isSourceOf(cell: number, id: number): boolean {
  return (cell & CELL_ID) === id && liquidStateOf(cell) === SOURCE;
}

/**
 * Can liquid `id` arriving with `amount` (1..8) be written into this cell?
 * Air and soft non-liquid blocks (plants, torch, snow cover) are washed away; a same-liquid
 * flowing cell is raised when it holds less. Never hard blocks (this includes unloaded space
 * and the deeprock below y = 0), never sources, never the other liquid.
 */
function canFlowInto(cell: number, id: number, amount: number): boolean {
  const cid = cell & CELL_ID;
  if (IS_SOLID[cid] === 1) return false;
  if (LIQUID_KIND[cid] === 0) return true;
  if (cid !== id) return false;
  const s = liquidStateOf(cell);
  return s !== SOURCE && amountOf(s) < amount;
}

/**
 * Slope search: can liquid `id` travel through this cell? Every non-hard cell except a source
 * of the same liquid (classic canPassThrough), independent of amounts.
 */
function isPassable(cell: number, id: number): boolean {
  const cid = cell & CELL_ID;
  return IS_SOLID[cid] === 0 && !(cid === id && liquidStateOf(cell) === SOURCE);
}

/**
 * Is a cell whose BELOW neighbour is `below` a hole, i.e. would liquid there go down rather
 * than sideways? True over every non-hard cell (classic isWaterHole): air and soft blocks,
 * the same liquid in any state (a falling column, or a pool: flowing liquid does not creep
 * across the surface of a pool or fan out at every level of a waterfall), and the other
 * liquid (contact turns it hard, which wakes everything that looked at it).
 */
function isHole(below: number): boolean {
  return IS_SOLID[below & CELL_ID] === 0;
}

/**
 * Which liquid kinds' slope searches see a difference between `oldCell` and `newCell`
 * (bitmask of WATER_BIT / LAVA_BIT). A search distinguishes three classes per liquid: hard
 * (neither passable nor a hole), a source of that liquid (a hole but not passable), and
 * everything else (passable hole).
 */
function slopeChange(oldCell: number, newCell: number): number {
  const o = oldCell & CELL_ID;
  const n = newCell & CELL_ID;
  if (IS_SOLID[o] !== IS_SOLID[n]) return BOTH_KINDS;
  if (IS_SOLID[o] === 1) return 0;
  let kinds = 0;
  if (isSourceOf(oldCell, WATER_ID) !== isSourceOf(newCell, WATER_ID)) kinds |= WATER_BIT;
  if (isSourceOf(oldCell, LAVA_ID) !== isSourceOf(newCell, LAVA_ID)) kinds |= LAVA_BIT;
  return kinds;
}

/** A neighbour that keeps `source` at rest: a hard block or the very same source cell. */
function holdsSource(neighbour: number, source: number): boolean {
  return neighbour === source || IS_SOLID[neighbour & CELL_ID] === 1;
}

// ------------------------------------------------------------------ direction tables

const HDX: readonly number[] = Object.freeze(HORIZONTAL_DIRS.map((d) => DIR_X[d]!));
const HDZ: readonly number[] = Object.freeze(HORIZONTAL_DIRS.map((d) => DIR_Z[d]!));

// Slope-search scratch grid: a square centred on the searching cell, big enough for the
// widest reach (water: first neighbour + 4 more steps = Manhattan radius 5).
const REACH = Math.max(WATER.reach, LAVA.reach);
const SIDE = REACH * 2 + 1;
const SLOPE_CELLS = SIDE * SIDE;
const CENTER = REACH * SIDE + REACH;
/** Grid index offset of each horizontal direction. */
const HOFF: readonly number[] = Object.freeze(HORIZONTAL_DIRS.map((d) => DIR_X[d]! + DIR_Z[d]! * SIDE));
/** Grid index -> offset from the centre (lookup tables, written once here). */
const GX: Int8Array = new Int8Array(SLOPE_CELLS);
const GZ: Int8Array = new Int8Array(SLOPE_CELLS);
for (let i = 0; i < SLOPE_CELLS; i++) {
  GX[i] = (i % SIDE) - REACH;
  GZ[i] = Math.floor(i / SIDE) - REACH;
}
const BLOCKED = -1;
/** slopeDirections() result when the answer depends on an unloaded chunk. */
const UNKNOWN = -1;
/** settleLevel() result: no answer at this level yet, search on. */
const SEARCH_ON = -2;

/** Size of the "verified at rest" memo (direct-mapped, power of two). */
const REST_MEMO_SIZE = 4096;

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

  // Horizontal-neighbour buffers. Two of them: isRestless() runs inside the change hook, i.e.
  // in the middle of a tick() that is still using its own. Neither function re-enters itself
  // (tick() is only called by the dispatcher, isRestless() never writes).
  private readonly tickNb = new Int32Array(4);
  private readonly restNb = new Int32Array(4);

  // Slope-search scratch (allocation-free BFS). `seen` holds the search stamp that last
  // touched an entry, so nothing has to be cleared between searches.
  private readonly seen = new Uint32Array(SLOPE_CELLS);
  private readonly level = new Int8Array(SLOPE_CELLS);
  private readonly dirMask = new Uint8Array(SLOPE_CELLS);
  private readonly hole = new Uint8Array(SLOPE_CELLS);
  private readonly frontA = new Uint8Array(SLOPE_CELLS);
  private readonly frontB = new Uint8Array(SLOPE_CELLS);
  private readonly unloadedFront = new Uint8Array(SLOPE_CELLS);
  private stamp = 0;

  // Cells wakeSlopeArea() has already handled (found at rest, or scheduled), valid while
  // `restGen` stays the same: any world write (seen by the change hook, hence only while
  // attached), chunk insert or world tick starts a new generation, and nothing else changes
  // the verdict. Bulk callers wake thousands of cells whose slope areas overlap almost
  // entirely (a hull assembled in a lake): without the memo every resting lake cell nearby is
  // re-checked once per call. Direct-mapped: a collision only costs a re-check.
  private readonly restKey = new Float64Array(REST_MEMO_SIZE);
  private readonly restStamp = new Float64Array(REST_MEMO_SIZE);
  private restGen = 1;
  private restTime = 0;

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Subscribe to world.onCellChange: any cell change schedules the liquid ticks it can affect
   * (the cell itself when it is liquid, and liquid neighbours, plus — when the change alters
   * what slope searches see — the restless liquid within slope reach). Returns the
   * unsubscribe function. Calling attach() again while attached returns the same function.
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
    return blockId === WATER_ID || blockId === LAVA_ID;
  }

  /** Number of cells waiting for an unloaded chunk (diagnostics and tests). */
  get deferredCount(): number {
    return this.deferred.size;
  }

  /**
   * Forget the cells waiting for unloaded chunks. Call it when the world's content is replaced
   * wholesale under this instance (a save imported into a running simulation), together with
   * world.ticks.clear(); then rescheduleChunk() every chunk as it is added. (Left alone, stale
   * entries would only cost an extra tick each.)
   */
  clear(): void {
    this.deferred.clear();
    this.restGen++;
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
    if ((cell & CELL_ID) !== L.id) return;
    if (this.deferred.size !== 0) this.deferred.delete(posKey(x, y, z));
    const nb = this.tickNb;
    let unknown = this.readNeighbours(x, y, z, nb);
    let below = world.getCell(x, y - 1, z);
    let state = liquidStateOf(cell);

    // 1. Lava touching water hardens; the water stays.
    if (L.hardens) {
      const contact = this.waterContact(x, y, z);
      if (contact === CONTACT_UNKNOWN) {
        this.defer(x, y, z);
        return;
      }
      if (contact === CONTACT) {
        world.setCell(x, y, z, state === SOURCE ? CELL_OBSIDIAN : CELL_RUBBLE);
        return;
      }
    }

    // 2. A flowing cell takes its state from its surroundings.
    if (state !== SOURCE) {
      const next = this.nextState(L, nb, unknown, world.getCell(x, y + 1, z), below);
      if (next === UNDECIDED) {
        this.defer(x, y, z);
        return;
      }
      if (next === DRY) {
        world.setCell(x, y, z, AIR);
        return;
      }
      if (next !== state) {
        const nextCell = cellOf(L.id, next);
        world.setCell(x, y, z, nextCell);
        // Another change listener may have replaced the cell, or its surroundings, synchronously.
        if (world.getCell(x, y, z) !== nextCell) return;
        state = next;
        unknown = this.readNeighbours(x, y, z, nb);
        below = world.getCell(x, y - 1, z);
      }
    }

    // 3. Spread.
    this.spread(x, y, z, L, state, nb, unknown, below);
  }

  /**
   * Wake the liquid that a change of the world cell (x,y,z) can affect, exactly as the change
   * hook does for an ordinary write: the cell itself when liquid, its liquid neighbours, and
   * the restless liquid within slope reach. Writes flagged SET_NO_NEIGHBOR_UPDATE (bulk
   * structure moves) skip all of that; call this for every such cell once the bulk change is
   * complete (BlockUpdates.updateAround / StructureHost.blockUpdate). Only schedules ticks.
   */
  wakeAround(x: number, y: number, z: number): void {
    const c = this.world.getCell(x, y, z);
    if (LIQUID_KIND[c & CELL_ID] !== 0) this.scheduleCell(x, y, z, c);
    this.wakeNeighbours(x, y, z);
    // The previous content is unknown here: assume both kinds of search saw a difference.
    this.wakeSlopeArea(x, y, z, BOTH_KINDS);
  }

  /**
   * After a chunk was generated or loaded from a save (and added to the world): schedule
   * ticks for every liquid cell in it that is not at rest, so nothing stays frozen mid-flow
   * (docs/LESSONS.md 读档后液体冻在半路). Also re-checks the liquid on the facing border of
   * each loaded neighbour (it may now have somewhere to go) and wakes deferred cells near
   * the chunk. Cheap for chunks full of resting ocean. Call it after world.addChunk(), also
   * when pending ticks were restored from a save (deferred cells are not part of the queue).
   * On a settled world it schedules nothing that would change a cell.
   */
  rescheduleChunk(chunk: Chunk): void {
    const world = this.world;
    if (world.getChunk(chunk.cx, chunk.cz) !== chunk) return; // not (or no longer) in the world
    this.restGen++; // cells next to the new chunk read different neighbours now
    this.scanColumns(chunk, 0, LOCAL_MASK, 0, LOCAL_MASK);
    // Border columns of loaded neighbours facing this chunk: until now they saw unloaded
    // (hard) space here, so their at-rest status may have changed.
    for (let d = 0; d < 4; d++) {
      const dx = HDX[d]!;
      const dz = HDZ[d]!;
      const n = world.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (!n) continue;
      // n lies in direction d, so the face touching `chunk` is n's border on the opposite side.
      if (dx !== 0) {
        const lx = dx === 1 ? 0 : LOCAL_MASK;
        this.scanColumns(n, lx, lx, 0, LOCAL_MASK);
      } else {
        const lz = dz === 1 ? 0 : LOCAL_MASK;
        this.scanColumns(n, 0, LOCAL_MASK, lz, lz);
      }
    }
    this.wakeDeferred(chunk.cx << LOCAL_SHIFT, chunk.cz << LOCAL_SHIFT);
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
    const x0 = chunk.cx << LOCAL_SHIFT;
    const z0 = chunk.cz << LOCAL_SHIFT;
    // Neighbour arrays for border reads; a missing neighbour reads as unloaded (hard).
    const east = world.getChunk(chunk.cx + 1, chunk.cz)?.cells ?? null;
    const west = world.getChunk(chunk.cx - 1, chunk.cz)?.cells ?? null;
    const south = world.getChunk(chunk.cx, chunk.cz + 1)?.cells ?? null;
    const north = world.getChunk(chunk.cx, chunk.cz - 1)?.cells ?? null;
    const ROW = CHUNK_SIZE;
    const FLIP_X = LOCAL_MASK; // index distance between lx = 15 and lx = 0 of the same row
    const FLIP_Z = LOCAL_MASK * ROW;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      const layer = y << 8;
      for (let lz = lz0; lz <= lz1; lz++) {
        for (let lx = lx0; lx <= lx1; lx++) {
          const i = layer | (lz << LOCAL_SHIFT) | lx;
          const c = cells[i]!;
          const id = c & CELL_ID;
          if (LIQUID_KIND[id] === 0) continue;
          if (id === WATER_ID && liquidStateOf(c) === SOURCE) {
            const below = y > 0 ? cells[i - 256]! : CELL_BELOW_WORLD;
            const e = lx < LOCAL_MASK ? cells[i + 1]! : east ? east[i - FLIP_X]! : CELL_UNLOADED;
            const w = lx > 0 ? cells[i - 1]! : west ? west[i + FLIP_X]! : CELL_UNLOADED;
            const s = lz < LOCAL_MASK ? cells[i + ROW]! : south ? south[i - FLIP_Z]! : CELL_UNLOADED;
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
    oldCell: number,
    newCell: number,
    flags: number,
  ): void => {
    this.restGen++;
    if (LIQUID_KIND[newCell & CELL_ID] !== 0) this.scheduleCell(x, y, z, newCell);
    if ((flags & NO_NEIGHBOR_UPDATE) !== 0) return;
    this.wakeNeighbours(x, y, z);
    const kinds = slopeChange(oldCell, newCell);
    if (kinds !== 0) this.wakeSlopeArea(x, y, z, kinds);
  };

  private wakeNeighbours(x: number, y: number, z: number): void {
    this.scheduleIfLiquid(x + 1, y, z);
    this.scheduleIfLiquid(x - 1, y, z);
    this.scheduleIfLiquid(x, y + 1, z);
    this.scheduleIfLiquid(x, y - 1, z);
    this.scheduleIfLiquid(x, y, z + 1);
    this.scheduleIfLiquid(x, y, z - 1);
  }

  /**
   * The cell (x,y,z) changed in a way the slope searches of liquid `kinds` can see. Wake every
   * restless liquid cell of those kinds whose search reads it: on layer y, cells within slope
   * reach (they test it for passability); on layer y + 1, cells within slope reach (they test
   * it as the floor under a search cell). The 6 direct neighbours are woken separately.
   * Restless cells only: a cell without a neighbour to spread into does not care where the
   * holes are, and one gains such a neighbour only through a neighbour change.
   */
  private wakeSlopeArea(x: number, y: number, z: number, kinds: number): void {
    const world = this.world;
    if (world.time !== this.restTime || this.detachFn === null) {
      this.restTime = world.time;
      this.restGen++;
    }
    const gen = this.restGen;
    const keys = this.restKey;
    const stamps = this.restStamp;
    const r = (kinds & WATER_BIT) !== 0 ? WATER.reach : LAVA.reach;
    const top = Math.min(y + 1, WORLD_HEIGHT - 1);
    for (let ly = y; ly <= top; ly++) {
      const nearest = ly === y ? 2 : 1; // closer cells on this layer are direct neighbours
      for (let dz = -r; dz <= r; dz++) {
        const adz = dz < 0 ? -dz : dz;
        const span = r - adz;
        for (let dx = -span; dx <= span; dx++) {
          const dist = adz + (dx < 0 ? -dx : dx);
          if (dist < nearest) continue;
          const c = world.getCell(x + dx, ly, z + dz);
          const L = liquidProps(c & CELL_ID);
          if (!L || (kinds & L.bit) === 0 || dist > L.reach) continue;
          const qx = x + dx;
          const qz = z + dz;
          const key = posKey(qx, ly, qz);
          const slot = (qx * 73 + qz * 179 + ly * 31) & (REST_MEMO_SIZE - 1);
          if (stamps[slot] === gen && keys[slot] === key) continue; // handled since the last change
          if (this.isRestless(qx, ly, qz, c, L)) this.scheduleCell(qx, ly, qz, c);
          keys[slot] = key;
          stamps[slot] = gen;
        }
      }
    }
  }

  private scheduleIfLiquid(x: number, y: number, z: number): void {
    const c = this.world.getCell(x, y, z);
    if (LIQUID_KIND[c & CELL_ID] !== 0) this.scheduleCell(x, y, z, c);
  }

  /** Schedule the tick of a liquid cell; lava already touching water reacts right away. */
  private scheduleCell(x: number, y: number, z: number, cell: number): void {
    const L = liquidProps(cell & CELL_ID);
    if (!L) return;
    const delay = L.hardens && this.waterContact(x, y, z) === CONTACT ? CONTACT_TICK_DELAY : L.delay;
    this.world.scheduleTick(x, y, z, L.id, delay);
  }

  private scheduleIfRestless(x: number, y: number, z: number, cell: number): void {
    const L = liquidProps(cell & CELL_ID);
    if (L && this.isRestless(x, y, z, cell, L)) this.scheduleCell(x, y, z, cell);
  }

  /**
   * Could a tick of this cell change anything? Mirrors tick() step by step, except that it
   * does not run the slope search: any neighbour able to receive liquid counts as restless,
   * and so does every decision that would need an unloaded chunk. So it may say "restless"
   * for a cell whose tick then does nothing (or defers), but never the reverse.
   */
  private isRestless(x: number, y: number, z: number, cell: number, L: LiquidProps): boolean {
    const world = this.world;
    const id = L.id;
    const state = liquidStateOf(cell);
    if (L.hardens && this.waterContact(x, y, z) !== NO_CONTACT) return true;
    const nb = this.restNb;
    const unknown = this.readNeighbours(x, y, z, nb);
    const below = world.getCell(x, y - 1, z);
    // UNDECIDED and DRY differ from every state, too.
    if (state !== SOURCE && this.nextState(L, nb, unknown, world.getCell(x, y + 1, z), below) !== state) return true;
    if (canFlowInto(below, id, 8)) return true;
    if (state !== SOURCE && isHole(below)) return false;
    const side = amountOf(state) - L.dropOff;
    if (side <= 0) return false;
    for (let d = 0; d < 4; d++) {
      if ((unknown & (1 << d)) === 0 && canFlowInto(nb[d]!, id, side)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- rules

  /**
   * New state of a non-source cell from its surroundings, DRY, or UNDECIDED when the answer
   * depends on a horizontal neighbour in an unloaded chunk (bit d of `unknown`).
   * Order matters (classic): infinite source first, then the falling column, then the
   * strongest horizontal neighbour minus the drop-off.
   */
  private nextState(L: LiquidProps, nb: Int32Array, unknown: number, above: number, below: number): number {
    const id = L.id;
    let best = 0;
    let sources = 0;
    for (let d = 0; d < 4; d++) {
      if ((unknown & (1 << d)) !== 0) continue;
      const c = nb[d]!;
      if ((c & CELL_ID) !== id) continue;
      const s = liquidStateOf(c);
      if (s === SOURCE) sources++;
      const a = amountOf(s);
      if (a > best) best = a;
    }
    const missing = POP4[unknown]!;
    if (L.infinite && (IS_SOLID[below & CELL_ID] === 1 || isSourceOf(below, id))) {
      if (sources >= 2) return SOURCE;
      if (sources + missing >= 2) return UNDECIDED;
    }
    if ((above & CELL_ID) === id) return FALLING;
    // A missing neighbour could only matter by being stronger than every known one.
    if (missing !== 0 && best < 8) return UNDECIDED;
    const amount = best - L.dropOff;
    return amount > 0 ? 8 - amount : DRY;
  }

  private spread(
    x: number,
    y: number,
    z: number,
    L: LiquidProps,
    state: number,
    nb: Int32Array,
    unknown: number,
    below: number,
  ): void {
    const world = this.world;
    const id = L.id;
    if (canFlowInto(below, id, 8)) {
      // Over a hole liquid only falls (classic rule).
      let target = cellOf(id, FALLING);
      if (L.hardens) {
        const contact = this.waterContact(x, y - 1, z);
        if (contact === CONTACT_UNKNOWN) {
          this.defer(x, y, z);
          return;
        }
        // Spreading never creates a source, so arriving lava always becomes rubble.
        if (contact === CONTACT) target = CELL_RUBBLE;
      }
      world.setCell(x, y - 1, z, target);
      return;
    }
    if (state !== SOURCE && isHole(below)) return;

    const side = amountOf(state) - L.dropOff;
    if (side <= 0) return;
    // Cheap exit before the slope search: most ticks of settled liquid end here. An unloaded
    // neighbour is never a receiver (nothing may be written there); when its chunk arrives,
    // rescheduleChunk() re-checks this cell's border column.
    let receivers = 0;
    for (let d = 0; d < 4; d++) {
      if ((unknown & (1 << d)) === 0 && canFlowInto(nb[d]!, id, side)) receivers |= 1 << d;
    }
    if (receivers === 0) return;

    const slope = this.slopeDirections(x, y, z, L, receivers);
    if (slope === UNKNOWN) {
      this.defer(x, y, z);
      return;
    }
    const dirs = slope & receivers;
    if (dirs === 0) return;
    if (L.hardens) {
      // Lava or rubble at a target depends on water around it: never decide that blind.
      for (let d = 0; d < 4; d++) {
        if ((dirs & (1 << d)) !== 0 && this.waterContact(x + HDX[d]!, y, z + HDZ[d]!) === CONTACT_UNKNOWN) {
          this.defer(x, y, z);
          return;
        }
      }
    }
    const flowing = cellOf(id, 8 - side);
    for (let d = 0; d < 4; d++) {
      if ((dirs & (1 << d)) === 0) continue;
      const nx = x + HDX[d]!;
      const nz = z + HDZ[d]!;
      // Re-read: an earlier write in this loop (or another listener) may have changed it.
      if (!canFlowInto(world.getCell(nx, y, nz), id, side)) continue;
      const cell = L.hardens && this.waterContact(nx, y, nz) === CONTACT ? CELL_RUBBLE : flowing;
      world.setCell(nx, y, nz, cell);
    }
  }

  /**
   * Slope search. Returns a bitmask (bit d = HORIZONTAL_DIRS[d]) of the directions whose
   * first cell lies on a shortest path to a hole, the mask of all passable directions when no
   * hole is within reach, or UNKNOWN when the answer — as far as it concerns the `receivers`
   * (the only directions the caller may write) — depends on an unloaded chunk.
   *
   * Level-synchronous BFS from the four neighbours at once. Each visited cell carries the set
   * of first directions that reach it at its (minimal) level, so the union over the holes of
   * the first level that has any is exactly the classic "directions with minimal slope
   * distance" (a path that runs through a cell another direction reached earlier can never be
   * minimal). The searching cell itself is a wall. Holes are looked for up to
   * `slopeDistance` steps beyond the first neighbour.
   *
   * Unloaded cells: every cell before the first level that meets one is known, so such a
   * cell's level and first-direction set are exact; only whether it is passable / a hole is
   * unknown. If that level has a known hole, the unloaded cells can only add their directions
   * to the answer: harmless when those are already in it or are not receivers. Otherwise any
   * answer from here on could change.
   */
  private slopeDirections(x: number, y: number, z: number, L: LiquidProps, receivers: number): number {
    const id = L.id;
    // Most of the search area lies in the searching cell's own chunk: read that one directly.
    const home = this.world.getChunk(x >> LOCAL_SHIFT, z >> LOCAL_SHIFT);
    if (!home) return UNKNOWN; // unreachable: the cell itself was just read from it
    const hc = home.cells;
    const hx = home.cx << LOCAL_SHIFT;
    const hz = home.cz << LOCAL_SHIFT;
    const seen = this.seen;
    const level = this.level;
    const mask = this.dirMask;
    const hole = this.hole;
    const unloaded = this.unloadedFront;
    const stamp = this.nextStamp();

    seen[CENTER] = stamp;
    level[CENTER] = BLOCKED;
    let cur = this.frontA;
    let next = this.frontB;
    let n = 0;
    let passable = 0;
    let holes = 0;
    let unknownDirs = 0;
    for (let d = 0; d < 4; d++) {
      const i = CENTER + HOFF[d]!;
      seen[i] = stamp;
      level[i] = BLOCKED;
      const qx = x + HDX[d]!;
      const qz = z + HDZ[d]!;
      const c = this.peek(hc, hx, hz, qx, y, qz);
      if (isUnloaded(c)) {
        unknownDirs |= 1 << d;
        continue;
      }
      if (!isPassable(c, id)) continue;
      level[i] = 0;
      mask[i] = 1 << d;
      passable |= 1 << d;
      if (isHole(this.peek(hc, hx, hz, qx, y - 1, qz))) holes |= 1 << d;
      cur[n++] = i;
    }
    let verdict = settleLevel(holes, unknownDirs, receivers);
    if (verdict !== SEARCH_ON) return verdict;

    for (let lv = 1; lv <= L.slopeDistance && n > 0; lv++) {
      let m = 0;
      let u = 0;
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
          if (isUnloaded(c)) {
            // Collects its first directions like any cell of this level, but is never expanded.
            level[q] = lv;
            mask[q] = pm;
            unloaded[u++] = q;
            continue;
          }
          if (!isPassable(c, id)) {
            level[q] = BLOCKED;
            continue;
          }
          level[q] = lv;
          mask[q] = pm;
          hole[q] = isHole(this.peek(hc, hx, hz, qx, y - 1, qz)) ? 1 : 0;
          next[m++] = q;
        }
      }
      holes = 0;
      for (let k = 0; k < m; k++) {
        const q = next[k]!;
        if (hole[q] === 1) holes |= mask[q]!;
      }
      unknownDirs = 0;
      for (let k = 0; k < u; k++) unknownDirs |= mask[unloaded[k]!]!;
      verdict = settleLevel(holes, unknownDirs, receivers);
      if (verdict !== SEARCH_ON) return verdict;
      const t = cur;
      cur = next;
      next = t;
      n = m;
    }
    return passable;
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Read the 4 horizontal neighbours of (x,y,z) into `out` (HORIZONTAL_DIRS order). Returns
   * the bitmask of those lying in unloaded chunks: the only reads around a cell that can hit
   * one, since the cell's own column is loaded.
   */
  private readNeighbours(x: number, y: number, z: number, out: Int32Array): number {
    const w = this.world;
    let unknown = 0;
    for (let d = 0; d < 4; d++) {
      const c = w.getCell(x + HDX[d]!, y, z + HDZ[d]!);
      out[d] = c;
      if (isUnloaded(c)) unknown |= 1 << d;
    }
    return unknown;
  }

  /**
   * Cell at (qx, qy, qz): straight from `cells` (the chunk whose origin is hx, hz) when the
   * position lies inside it, else through the world (unloaded / below-world rules apply).
   */
  private peek(cells: Uint16Array, hx: number, hz: number, qx: number, qy: number, qz: number): number {
    const lx = qx - hx;
    const lz = qz - hz;
    if (((lx | lz) & ~LOCAL_MASK) === 0 && qy >= 0) return cells[lx | (lz << LOCAL_SHIFT) | (qy << 8)]!;
    return this.world.getCell(qx, qy, qz);
  }

  /** Is water among the 6 neighbours of (x,y,z)? CONTACT, NO_CONTACT or CONTACT_UNKNOWN. */
  private waterContact(x: number, y: number, z: number): number {
    const w = this.world;
    if ((w.getCell(x, y + 1, z) & CELL_ID) === WATER_ID || (w.getCell(x, y - 1, z) & CELL_ID) === WATER_ID) {
      return CONTACT;
    }
    let unknown = false;
    for (let d = 0; d < 4; d++) {
      const id = w.getCell(x + HDX[d]!, y, z + HDZ[d]!) & CELL_ID;
      if (id === WATER_ID) return CONTACT;
      if (id === UNLOADED_ID) unknown = true;
    }
    return unknown ? CONTACT_UNKNOWN : NO_CONTACT;
  }

  private defer(x: number, y: number, z: number): void {
    const k = posKey(x, y, z);
    if (!this.deferred.has(k)) this.deferred.set(k, { x, y, z });
  }

  /**
   * Re-schedule deferred cells whose reach overlaps the chunk at (x0, z0) (it may be what
   * they were waiting for). Entries whose own chunk is gone are dropped: when it comes back,
   * rescheduleChunk() scans it anyway.
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
 * Verdict of the slope search after a BFS level: the hole directions when that level has a
 * hole and the unloaded cells of the level cannot add a receiver to them; UNKNOWN when they
 * could, or when there is no hole but unloaded cells (any of them could be a hole, or lead to
 * one); SEARCH_ON otherwise.
 */
function settleLevel(holes: number, unknownDirs: number, receivers: number): number {
  if (holes !== 0) return (unknownDirs & receivers & ~holes) === 0 ? holes : UNKNOWN;
  return unknownDirs !== 0 ? UNKNOWN : SEARCH_ON;
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
