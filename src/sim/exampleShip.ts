/**
 * The example windmill boat that new worlds start with, moored on open water near the spawn.
 *
 * It is stamped into the world as ordinary BLOCKS (plus two glued faces), not as a ready-made
 * structure: the player walks up, right-clicks the bearing twice to start the windmill and the
 * helm twice to assemble the boat and sail. So it is also a building example that follows the
 * game's own connection rules (docs/DESIGN.md 连接 / 组装与方块化, src/structures/stick.ts):
 *
 *  - hull: a 5 x 9 plank floor in the top water layer (y = SEA_LEVEL - 1) with a one-high plank
 *    gunwale around it, open on top. Planks stick to planks.
 *  - helm: on the floor one cell in from the stern, facing the bow (a helm mounts on the block
 *    below it; its facing is the direction the helmsman looks, which becomes the ship's bow).
 *  - mast: vertical logs standing on the floor. Logs only stick along their own trunk, so the
 *    foot is glued to the floor plank.
 *  - bearing: on the bow side of the mast top, facing the bow; its BACK face mounts on the top
 *    log of the mast.
 *  - windmill: a hub in front of the bearing with four pinwheel arms, all felt (every felt colour
 *    and canvas stick to each other): 13 sail blocks. The arms turn in the plane in front of the
 *    bearing, high enough that their sweep clears the gunwale, the deck crew and the mast. The
 *    hub is glued to the bearing (DESIGN 轴心和轴承之间涂胶) so a stopped windmill comes along
 *    when the helm assembles the boat.
 *
 * The site is found by a deterministic search outward from the player's spawn: a rectangle of
 * open water (every column water at least two deep with air above) as big as the boat plus a
 * margin, with the whole boat between MIN_DISTANCE and MAX_DISTANCE blocks from the spawn. The
 * bow points along the longest run of open water from the boat's centre. Missing chunks are
 * generated synchronously, at most SEARCH_CHUNK_RADIUS chunks around the spawn.
 *
 * Simulation layer: no DOM, no clocks, no randomness; all state is in the Simulation.
 */
import { AIR, axisState, cellState, facingState, ID_MASK, isLiquidSource, makeCell } from '../blocks/cell';
import { B } from '../blocks/defs';
import { LIQUID, LIQUID_WATER } from '../blocks/registry';
import { CHUNK_SHIFT, SEA_LEVEL } from '../core/constants';
import { DIR_X, DIR_Z, NX, NY, NZ, PX, PZ, type Dir } from '../core/dirs';
import type { Simulation } from './simulation';

/** Boat size: across (odd, centred on the keel line) and along (stern v = 0 .. bow v = LENGTH - 1). */
export const SHIP_WIDTH = 5;
export const SHIP_LENGTH = 9;
/** Open water required around the boat on every side (blocks). */
export const SHIP_MARGIN = 2;
/** The whole boat lies between these horizontal distances from the spawn (blocks). */
export const MIN_DISTANCE = 6;
export const MAX_DISTANCE = 40;
/** Chunks around the spawn's chunk the search may generate. */
export const SEARCH_CHUNK_RADIUS = 3;
/** Required water depth below the surface (cells, the surface cell included). */
export const MIN_DEPTH = 2;

/** World y of the floor (the top water layer) and of the deck the crew stands on. */
export const FLOOR_Y = SEA_LEVEL - 1;
export const DECK_Y = SEA_LEVEL;
/** Along-ship positions (v: 0 = stern row, LENGTH - 1 = bow row). */
export const HELM_V = 1;
export const MAST_V = 5;
export const BEARING_V = 6;
export const HUB_V = 7;
/** Top log of the mast; the bearing and the hub sit at this height. Reachable from the deck. */
export const MAST_TOP_Y = DECK_Y + 5;
/** Highest cell of the windmill (up arm and its pinwheel blade). */
export const WINDMILL_TOP_Y = MAST_TOP_Y + 2;

const HALF = (SHIP_WIDTH - 1) / 2;
/** How far the open-water run toward each candidate bow direction is measured. */
const RUN_LIMIT = 48;
const HORIZONTAL: readonly Dir[] = [PX, NX, PZ, NZ];

const PLANKS = makeCell(B.PLANKS_OAK);
const LOG_UP = makeCell(B.LOG_OAK, axisState(1));
const HUB = makeCell(B.WOOL_YELLOW);
const ARM = makeCell(B.WOOL_WHITE);

/** Unit vectors of a horizontal direction and of the direction to its right. */
interface Frame {
  bow: Dir;
  fx: number;
  fz: number;
  rx: number;
  rz: number;
}

function frameOf(bow: Dir): Frame {
  const fx = DIR_X[bow]!;
  const fz = DIR_Z[bow]!;
  // Looking along (fx, fz) from above (+X east, +Z south), the right hand is (-fz, fx).
  return { bow, fx, fz, rx: -fz, rz: fx };
}

/** One block of the boat in ship coordinates (u across, + = starboard; v along; world y). */
interface Part {
  u: number;
  v: number;
  y: number;
  cell: number;
}

/**
 * Every block of the boat (ship coordinates). Facing-dependent cells (helm, bearing) are given
 * as their block id; place() orients them along the bow.
 */
export function exampleShipParts(): Part[] {
  const parts: Part[] = [];
  for (let v = 0; v < SHIP_LENGTH; v++) {
    for (let u = -HALF; u <= HALF; u++) {
      parts.push({ u, v, y: FLOOR_Y, cell: PLANKS });
      if (Math.abs(u) === HALF || v === 0 || v === SHIP_LENGTH - 1) parts.push({ u, v, y: DECK_Y, cell: PLANKS });
    }
  }
  parts.push({ u: 0, v: HELM_V, y: DECK_Y, cell: B.HELM });
  for (let y = DECK_Y; y <= MAST_TOP_Y; y++) parts.push({ u: 0, v: MAST_V, y, cell: LOG_UP });
  parts.push({ u: 0, v: BEARING_V, y: MAST_TOP_Y, cell: B.BEARING });
  // Windmill in the plane v = HUB_V: hub, four two-block arms, a pinwheel blade at each tip.
  parts.push({ u: 0, v: HUB_V, y: MAST_TOP_Y, cell: HUB });
  // Arm directions in (u, y), turning one way; each blade sits to the arm's clockwise side.
  const arms: Array<[number, number, number]> = [
    [0, 1, B.WOOL_RED],
    [1, 0, B.WOOL_BLUE],
    [0, -1, B.WOOL_RED],
    [-1, 0, B.WOOL_BLUE],
  ];
  for (const [du, dy, tip] of arms) {
    parts.push({ u: du, v: HUB_V, y: MAST_TOP_Y + dy, cell: ARM });
    parts.push({ u: 2 * du, v: HUB_V, y: MAST_TOP_Y + 2 * dy, cell: makeCell(tip) });
    // Blade: the tip's neighbour a quarter turn on, (du, dy) -> (dy, -du).
    parts.push({ u: 2 * du + dy, v: HUB_V, y: MAST_TOP_Y + 2 * dy - du, cell: makeCell(tip) });
  }
  return parts;
}

/** Search state: the simulation, the spawn and its chunk. */
interface Search {
  readonly sim: Simulation;
  readonly sx: number;
  readonly sz: number;
  readonly scx: number;
  readonly scz: number;
}

/** Make sure the column's chunk is loaded (inside the search radius). False when it cannot be. */
function ensureColumn(s: Search, x: number, z: number): boolean {
  const cx = x >> CHUNK_SHIFT;
  const cz = z >> CHUNK_SHIFT;
  if (Math.abs(cx - s.scx) > SEARCH_CHUNK_RADIUS || Math.abs(cz - s.scz) > SEARCH_CHUNK_RADIUS) return false;
  const world = s.sim.world;
  if (world.getChunk(cx, cz) === undefined) s.sim.chunks.loadAround(s.sim.generator, x, z, 0);
  return world.getChunk(cx, cz) !== undefined;
}

function isWaterSource(cell: number): boolean {
  return LIQUID[cell & ID_MASK] === LIQUID_WATER && isLiquidSource(cellState(cell));
}

/** Open water: still water at least MIN_DEPTH deep below the sea surface, air above it. */
function openWater(s: Search, x: number, z: number): boolean {
  if (!ensureColumn(s, x, z)) return false;
  const w = s.sim.world;
  if (w.getCell(x, SEA_LEVEL, z) !== AIR) return false;
  for (let i = 1; i <= MIN_DEPTH; i++) if (!isWaterSource(w.getCell(x, SEA_LEVEL - i, z))) return false;
  return true;
}

/** Number of open-water columns in a row from (x, z) (exclusive) toward `d`, up to RUN_LIMIT. */
function waterRun(s: Search, x: number, z: number, d: Dir): number {
  let n = 0;
  while (n < RUN_LIMIT && openWater(s, x + DIR_X[d]! * (n + 1), z + DIR_Z[d]! * (n + 1))) n++;
  return n;
}

/** World column of ship coordinates (u, v) for a boat whose stern centre is (ox, oz). */
function colX(f: Frame, ox: number, u: number, v: number): number {
  return ox + u * f.rx + v * f.fx;
}
function colZ(f: Frame, oz: number, u: number, v: number): number {
  return oz + u * f.rz + v * f.fz;
}

/** Does a boat with stern centre (ox, oz) and this frame fit here? */
function fits(s: Search, f: Frame, ox: number, oz: number): boolean {
  const w = s.sim.world;
  // The boat itself: within the distance band, open water, and nothing above it up to the masthead.
  for (let v = 0; v < SHIP_LENGTH; v++) {
    for (let u = -HALF; u <= HALF; u++) {
      const x = colX(f, ox, u, v);
      const z = colZ(f, oz, u, v);
      const dist = Math.hypot(x + 0.5 - s.sx, z + 0.5 - s.sz);
      if (dist < MIN_DISTANCE || dist > MAX_DISTANCE) return false;
      if (!openWater(s, x, z)) return false;
      for (let y = DECK_Y + 1; y <= WINDMILL_TOP_Y; y++) if (w.getCell(x, y, z) !== AIR) return false;
    }
  }
  // The margin around it: open water.
  for (let v = -SHIP_MARGIN; v < SHIP_LENGTH + SHIP_MARGIN; v++) {
    for (let u = -HALF - SHIP_MARGIN; u <= HALF + SHIP_MARGIN; u++) {
      if (v >= 0 && v < SHIP_LENGTH && Math.abs(u) <= HALF) continue;
      if (!openWater(s, colX(f, ox, u, v), colZ(f, oz, u, v))) return false;
    }
  }
  return true;
}

/**
 * World cell of ship coordinates (u across, + = starboard; v along, 0 = stern row; world y) of
 * a placed example boat, given its helm cell and bow direction (the helm's facing). For tests
 * and tools that need to find the bearing, the mast or the deck.
 */
export function exampleShipCell(helm: { x: number; z: number }, bow: Dir, u: number, v: number, y: number): { x: number; y: number; z: number } {
  const f = frameOf(bow);
  const ox = helm.x - f.fx * HELM_V;
  const oz = helm.z - f.fz * HELM_V;
  return { x: colX(f, ox, u, v), y, z: colZ(f, oz, u, v) };
}

interface Site {
  frame: Frame;
  ox: number;
  oz: number;
}

/**
 * Nearest site on square rings around the spawn column. At each candidate centre the bow
 * directions are tried longest open-water run first (ties in Dir order); the first one that
 * fits wins. Deterministic: depends only on the world and the spawn.
 */
function findSite(s: Search): Site | null {
  const cx0 = Math.floor(s.sx);
  const cz0 = Math.floor(s.sz);
  const order: Array<{ d: Dir; run: number }> = [];
  for (let r = 0; r <= MAX_DISTANCE; r++) {
    for (let dz = -r; dz <= r; dz++) {
      const edge = dz === -r || dz === r;
      // The ring's top and bottom rows in full, the rows between only at both ends.
      for (let dx = -r; dx <= r; dx += edge || r === 0 ? 1 : 2 * r) {
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        // Cheap first tests: the boat's centre is never closer than MIN_DISTANCE, and it is water.
        if (Math.hypot(dx, dz) < MIN_DISTANCE || !openWater(s, cx, cz)) continue;
        order.length = 0;
        for (const d of HORIZONTAL) order.push({ d, run: waterRun(s, cx, cz, d) });
        order.sort((a, b) => b.run - a.run || a.d - b.d);
        for (const { d } of order) {
          const f = frameOf(d);
          // Stern centre: half a boat behind the centre cell.
          const back = (SHIP_LENGTH - 1) / 2;
          const ox = cx - f.fx * back;
          const oz = cz - f.fz * back;
          if (fits(s, f, ox, oz)) return { frame: f, ox, oz };
        }
      }
    }
  }
  return null;
}

/** Write the boat. Returns the helm's world cell. */
function build(sim: Simulation, site: Site): { x: number; y: number; z: number } {
  const { frame: f, ox, oz } = site;
  const w = sim.world;
  for (const p of exampleShipParts()) {
    let cell = p.cell;
    if (cell === B.HELM || cell === B.BEARING) cell = makeCell(cell, facingState(f.bow));
    w.setCell(colX(f, ox, p.u, p.v), p.y, colZ(f, oz, p.u, p.v), cell);
  }
  // Glue after the blocks: writing a cell removes the glue on its faces.
  const mx = colX(f, ox, 0, MAST_V);
  const mz = colZ(f, oz, 0, MAST_V);
  sim.worldGlue.add(mx, DECK_Y, mz, NY); // mast foot <-> floor plank
  const bx = colX(f, ox, 0, BEARING_V);
  const bz = colZ(f, oz, 0, BEARING_V);
  sim.worldGlue.add(bx, MAST_TOP_Y, bz, f.bow); // bearing <-> hub
  return { x: colX(f, ox, 0, HELM_V), y: DECK_Y, z: colZ(f, oz, 0, HELM_V) };
}

/**
 * Stamp the example windmill boat into a NEW world near the player's spawn. Returns the helm's
 * world cell, or null when no suitable open water was found (then nothing is written). Never
 * throws: a failure must not stop the world from being created.
 */
export function placeExampleShip(sim: Simulation): { x: number; y: number; z: number } | null {
  try {
    const spawn = sim.player.spawn;
    const sx = spawn.x;
    const sz = spawn.z;
    if (!Number.isFinite(sx) || !Number.isFinite(sz)) return null;
    const s: Search = { sim, sx, sz, scx: Math.floor(sx) >> CHUNK_SHIFT, scz: Math.floor(sz) >> CHUNK_SHIFT };
    const site = findSite(s);
    return site === null ? null : build(sim, site);
  } catch {
    return null;
  }
}
