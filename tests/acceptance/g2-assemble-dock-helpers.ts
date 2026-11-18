/**
 * Scene builders and observers for the acceptance scenarios 6-9 (组装与停靠).
 *
 * Scenes are built on the server's Simulation with world.setCell (and worldGlue.add for glue the
 * scene starts with); the player then acts through the test world's player (tests/acceptance/
 * world.ts: look, right-click, left-click, sneak, held item, movement keys). Internals are only
 * read here, to observe results.
 */
import { ID_MASK, cellState, facingState, makeCell, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { NZ, type Dir } from '../../src/core/dirs';
import { qrotate, vec3, type Vec3 } from '../../src/core/math';
import { Simulation, type GameMode } from '../../src/sim/simulation';
import type { Message, SimEvent } from '../../src/sim/view';
import type { Ship } from '../../src/structures/structure';
import { FlatGenerator } from '../../src/worldgen/generator';
import { testWorld, type TestWorld } from './world';

/** Sea: deeprock y=0, stone y=1..19, water sources y=20..29; the first air cell is y = SEA_TOP. */
export const SEA_TOP = 30;
/** Sea floor: the top face of the stone (first water cell). */
export const SEA_FLOOR = 20;
/** Water surface height (top of the highest water cell minus 2/16, as the fluids render it). */
export const SURFACE = SEA_TOP - 2 / 16;

export interface SeaOpts {
  mode?: GameMode;
  spawn: { x: number; y: number; z: number };
  seed?: number;
}

/** A real sea, ten water sources deep over stone, with a generous loaded area. */
export function seaWorld(o: SeaOpts): TestWorld {
  return testWorld({
    seed: o.seed ?? 62,
    mode: o.mode ?? 'creative',
    generator: new FlatGenerator([
      { id: B.DEEPROCK, thickness: 1 },
      { id: B.STONE, thickness: SEA_FLOOR - 1 },
      { id: B.WATER, thickness: SEA_TOP - SEA_FLOOR },
    ]),
    syncChunks: true,
    rabbits: false,
    loadRadius: 3,
    spawn: o.spawn,
  });
}

/** Fill an inclusive box of world cells. */
export function fill(sim: Simulation, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cell: number): void {
  const c = cell > ID_MASK ? cell : makeCell(cell);
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) sim.world.setCell(x, y, z, c);
    }
  }
}

export function idAt(sim: Simulation, x: number, y: number, z: number): number {
  return sim.world.getCell(x, y, z) & ID_MASK;
}

/** Number of world cells holding block `id` in an inclusive box. */
export function countWorld(sim: Simulation, id: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (idAt(sim, x, y, z) === id) n++;
  return n;
}

/** World cells holding block `id` in an inclusive box, as "x,y,z" keys. */
export function findWorld(sim: Simulation, id: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string[] {
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (idAt(sim, x, y, z) === id) out.push(key(x, y, z));
  return out;
}

export function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/** x,y,z triples -> sorted "x,y,z" keys. */
export function tripleKeys(cells: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 < cells.length; i += 3) out.push(key(cells[i]!, cells[i + 1]!, cells[i + 2]!));
  return out.sort();
}

/** Every SimEvent of a simulation, from now on. */
export class EventLog {
  readonly list: SimEvent[] = [];
  constructor(sim: Simulation) {
    sim.events.on((e) => this.list.push(e));
  }
  of<T extends SimEvent['type']>(type: T): Array<Extract<SimEvent, { type: T }>> {
    return this.list.filter((e) => e.type === type) as Array<Extract<SimEvent, { type: T }>>;
  }
  toasts(): Message[] {
    return this.of('toast').map((t) => t.message);
  }
  toastKeys(): string[] {
    return this.toasts().map((m) => m.key);
  }
  clear(): void {
    this.list.length = 0;
  }
}

/** Live item entities holding `item`: how many entities, total count, and the entities. */
export function itemDrops(sim: Simulation, item: number): { entities: number; count: number; list: Array<{ pos: Vec3; carrierId: number }> } {
  let entities = 0;
  let count = 0;
  const list: Array<{ pos: Vec3; carrierId: number }> = [];
  for (const e of sim.entities.all()) {
    if (e.removed || e.kind !== 'item') continue;
    const st = (e as unknown as { stack: { item: number; count: number } }).stack;
    if (st.item !== item) continue;
    entities++;
    count += st.count;
    list.push({ pos: e.pos, carrierId: e.carrierId });
  }
  return { entities, count, list };
}

/** Live falling-block entities. */
export function fallingBlocks(sim: Simulation): number {
  return sim.entities.all().filter((e) => !e.removed && e.kind === 'falling').length;
}

/** The one ship of the simulation (throws when there is not exactly one). */
export function onlyShip(sim: Simulation): Ship {
  const ships = sim.structures.ships();
  if (ships.length !== 1) throw new Error(`expected exactly one ship, found ${ships.length}`);
  return ships[0]!;
}

/** Heading of the ship's bow (local -Z), degrees: 0 = north (-Z), grows turning left (CCW from above). */
export function headingDeg(ship: Ship): number {
  const f = qrotate(ship.grid.rotation, vec3(0, 0, -1));
  return (Math.atan2(-f.x, -f.z) * 180) / Math.PI;
}

/** Angle between the ship's local +Y and world +Y, degrees. */
export function tiltDeg(ship: Ship): number {
  const up = qrotate(ship.grid.rotation, vec3(0, 1, 0));
  return (Math.acos(Math.max(-1, Math.min(1, up.y))) * 180) / Math.PI;
}

export interface ShipCell {
  /** Ship-local cell. */
  x: number;
  y: number;
  z: number;
  /** Full cell value. */
  cell: number;
}

export function shipCells(ship: Ship): ShipCell[] {
  const out: ShipCell[] = [];
  ship.grid.forEachCell((x, y, z, cell) => out.push({ x, y, z, cell }));
  return out;
}

/** World position of the centre of a ship-local cell. */
export function worldCentre(ship: Ship, x: number, y: number, z: number): Vec3 {
  return ship.grid.toWorld(vec3(x + 0.5, y + 0.5, z + 0.5));
}

/** Smallest world z over the centres of every cell of the ship. */
export function minCentreZ(ship: Ship, cells: readonly ShipCell[]): number {
  let m = Infinity;
  const p = vec3();
  for (const c of cells) {
    ship.grid.toWorld(vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5), p);
    if (p.z < m) m = p.z;
  }
  return m;
}

/** Is any HARD ship cell overlapping the world cell (x,y,z)? (sampled on a 5x5x5 lattice, borders excluded) */
export function hullOverlapsWorldCell(ship: Ship, x: number, y: number, z: number): boolean {
  const l = vec3();
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      for (let k = 0; k <= 4; k++) {
        const p = vec3(x + 0.02 + (i / 4) * 0.96, y + 0.02 + (j / 4) * 0.96, z + 0.02 + (k / 4) * 0.96);
        ship.grid.toLocal(p, l);
        if (SOLID[ship.grid.getCell(Math.floor(l.x), Math.floor(l.y), Math.floor(l.z)) & ID_MASK] === 1) return true;
      }
    }
  }
  return false;
}

/**
 * A rotation of the lattice about +Y by k quarter turns (k = 1: 90 degrees counter-clockwise from
 * above, the way yaw grows): (x, z) -> (x cos + z sin, -x sin + z cos).
 */
export function rotY(k: number, x: number, z: number): { x: number; z: number } {
  const kk = ((k % 4) + 4) % 4;
  if (kk === 0) return { x, z };
  if (kk === 1) return { x: z, z: -x };
  if (kk === 2) return { x: -x, z: -z };
  return { x: -z, z: x };
}

/** A horizontal direction turned by k quarter turns (same sense as rotY). */
export function rotDirY(k: number, d: Dir): Dir {
  const v = [
    [1, 0],
    [-1, 0],
    [0, 0],
    [0, 0],
    [0, 1],
    [0, -1],
  ][d]!;
  if (d === 2 || d === 3) return d;
  const r = rotY(k, v[0]!, v[1]!);
  if (r.x === 1) return 0;
  if (r.x === -1) return 1;
  if (r.z === 1) return 4;
  return 5;
}

/**
 * Where docking must put each ship cell: the nearest axis-aligned pose. The yaw is rounded to a
 * quarter turn (k); every cell keeps its place in the hull (rotated by k), and the whole hull is
 * shifted by one integer offset chosen so that the cells move as little as possible from where
 * they are now. Computed from the current pose only (the ship must be upright).
 */
export function expectedDock(ship: Ship): { k: number; dest: Map<ShipCell, { x: number; y: number; z: number }>; maxMove: number } {
  const k = (((Math.round(headingDeg(ship) / 90) % 4) + 4) % 4) as number;
  const cells = shipCells(ship);
  // Mean of (world centre - 0.5 - rotated local) over all cells = the common real offset.
  let sx = 0;
  let sy = 0;
  let sz = 0;
  const centres = cells.map((c) => worldCentre(ship, c.x, c.y, c.z));
  cells.forEach((c, i) => {
    const r = rotY(k, c.x, c.z);
    const w = centres[i]!;
    sx += w.x - 0.5 - r.x;
    sy += w.y - 0.5 - c.y;
    sz += w.z - 0.5 - r.z;
  });
  const n = cells.length;
  const tx = Math.round(sx / n);
  const ty = Math.round(sy / n);
  const tz = Math.round(sz / n);
  const dest = new Map<ShipCell, { x: number; y: number; z: number }>();
  let maxMove = 0;
  cells.forEach((c, i) => {
    const r = rotY(k, c.x, c.z);
    const d = { x: r.x + tx, y: c.y + ty, z: r.z + tz };
    dest.set(c, d);
    const w = centres[i]!;
    maxMove = Math.max(maxMove, Math.hypot(d.x + 0.5 - w.x, d.y + 0.5 - w.y, d.z + 0.5 - w.z));
  });
  return { k, dest, maxMove };
}

/** Facing of a world cell holding a facing block. */
export function facingAt(sim: Simulation, x: number, y: number, z: number): Dir {
  return stateFacing(cellState(sim.world.getCell(x, y, z))) as Dir;
}

/** Helm facing north. */
export const HELM_N = makeCell(B.HELM, facingState(NZ));
