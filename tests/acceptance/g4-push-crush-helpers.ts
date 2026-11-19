/**
 * Helpers for the "推与挤" acceptance scenarios (docs/ACCEPTANCE.md 15-18, group g4-push-crush).
 *
 * Scenes are built with world.setCell (walls, cages, the windmill's blocks, the boat's blocks)
 * and ships are assembled from their world helm (scene building). The PLAYER starts every
 * windmill the way the game does it: look at the bearing, right-click once (preview), right-click
 * again (start), each click checked to hit that bearing. Everything the scenarios are about —
 * blades sweeping, ships pushed or wedged, players and rabbits pushed or crushed — is the
 * simulation's own tick; the tests only observe it.
 */
import { vi } from 'vitest';
import { ID_MASK, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import type { Dir } from '../../src/core/dirs';
import { aabb, vec3, type Vec3 } from '../../src/core/math';
import { ItemEntity, type Entity } from '../../src/entities/entity';
import type { EntityEvent } from '../../src/entities/host';
import type { ShipDynamicsImpl, ShipPhysicsStats } from '../../src/structures/physics';
import type { Rotor, Ship } from '../../src/structures/structure';
import { Simulation, type GameMode } from '../../src/sim/simulation';
import type { SimEvent } from '../../src/sim/view';
import type { VoxelGrid } from '../../src/voxel/grid';
import { boxOverlapsSolid, deepestPenetration } from '../../src/voxel/shape';
import { FlatGenerator } from '../../src/worldgen/generator';
import { testWorld, type TestWorld } from './world';

// ------------------------------------------------------------------ worlds

/** Default flat world: deeprock y=0, stone 1..30, dirt 31..33, turf 34; first air at y = LAND_TOP. */
export const LAND_TOP = 35;
/** Sea world: deeprock y=0, stone 1..19, water 20..29 (surface cells y = 29); first air at y = SEA_TOP. */
export const SEA_TOP = 30;

export function landWorld(mode: GameMode, spawn: Vec3, seed = 41): TestWorld {
  return testWorld({
    seed,
    mode,
    generator: new FlatGenerator(),
    syncChunks: true,
    loadRadius: 2,
    rabbits: false,
    spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
  });
}

export function seaWorld(mode: GameMode, spawn: Vec3, seed = 42): TestWorld {
  return testWorld({
    seed,
    mode,
    generator: new FlatGenerator([
      { id: B.DEEPROCK, thickness: 1 },
      { id: B.STONE, thickness: 19 },
      { id: B.WATER, thickness: 10 },
    ]),
    syncChunks: true,
    loadRadius: 2,
    rabbits: false,
    spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
  });
}

/** Fill an inclusive box of world cells with a block id (0 = air). */
export function fill(sim: Simulation, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  const c = id === 0 ? 0 : makeCell(id);
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) sim.world.setCell(x, y, z, c);
    }
  }
}

export function idAt(grid: VoxelGrid, x: number, y: number, z: number): number {
  return grid.getCell(x, y, z) & ID_MASK;
}

// ------------------------------------------------------------------ windmills

export type Cell3 = [number, number, number];

/**
 * Put a windmill's blocks into the world: a bearing facing `facing` and canvas cells (the hub —
 * the cell in front of the bearing — must be among them). Returns the bearing cell.
 */
export function buildWindmill(sim: Simulation, bearing: Cell3, facing: Dir, canvas: readonly Cell3[]): Cell3 {
  sim.world.setCell(bearing[0], bearing[1], bearing[2], makeCell(B.BEARING, facingState(facing)));
  for (const [x, y, z] of canvas) sim.world.setCell(x, y, z, makeCell(B.CANVAS));
  return bearing;
}

/**
 * The player starts the windmill on the world bearing at `bearing` like a player does: look at
 * the bearing's `face`, right-click (preview), right-click again (start). Each click is checked
 * to hit that very bearing (useOn runs one tick per click). Returns the new rotor.
 */
export function startWindmillByClicks(w: TestWorld, bearing: Cell3, face: Dir): Rotor {
  const { sim, me } = w;
  const before = new Set(sim.structures.rotors());
  const [x, y, z] = bearing;
  if (!me.useOn(x, y, z, face)) throw new Error(`windmill: cannot aim at the bearing (${x},${y},${z}) face ${face}`);
  if (me.view.preview?.kind !== 'rotor') throw new Error('windmill: the first right-click did not preview a rotor');
  if (!me.useOn(x, y, z, face)) throw new Error(`windmill: cannot aim at the bearing (${x},${y},${z}) a second time`);
  const started = sim.structures.rotors().filter((r) => !before.has(r));
  if (started.length !== 1) throw new Error(`windmill: the second right-click started ${started.length} rotors`);
  return started[0]!;
}

/**
 * Lowest integer hub height (cell y) such that the circle swept by a straight arm of `len`
 * cells about a horizontal axis stays at least `clearance` above `floorY`.
 */
export function hubAbove(floorY: number, len: number, clearance: number): number {
  const reach = Math.hypot(len + 0.5, 0.5); // farthest corner of the tip cell from the pivot
  return Math.ceil(floorY + clearance + reach - 0.5);
}

// ------------------------------------------------------------------ ships

/**
 * A plank boat in the world: floor at y, a one-high rim at y+1 around it (open hold), a helm on
 * the floor at the centre facing `facing`. Inclusive x0..x1, z0..z1. Returns the helm cell.
 */
export function buildBoat(sim: Simulation, x0: number, z0: number, x1: number, z1: number, y: number, facing: Dir): Cell3 {
  fill(sim, x0, y, z0, x1, y, z1, B.PLANKS_OAK);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      if (x === x0 || x === x1 || z === z0 || z === z1) sim.world.setCell(x, y + 1, z, makeCell(B.PLANKS_OAK));
    }
  }
  const hx = (x0 + x1) >> 1;
  const hz = (z0 + z1) >> 1;
  sim.world.setCell(hx, y + 1, hz, makeCell(B.HELM, facingState(facing)));
  return [hx, y + 1, hz];
}

/** Assemble the ship steered by the world helm at `helm` (scene building). */
export function assemble(sim: Simulation, helm: Cell3): Ship {
  const res = sim.structures.assembleShip(helm[0], helm[1], helm[2]);
  if (!res.ok) throw new Error(`assembleShip failed: ${res.reason}`);
  return res.structure;
}

/** Physics read-out of a ship for the last tick (the dynamics' debug statistics). */
export function shipStats(sim: Simulation, ship: Ship): Readonly<ShipPhysicsStats> {
  const st = (sim.dynamics as ShipDynamicsImpl).getStats(ship);
  if (st === null) throw new Error('the dynamics never saw this ship');
  return st;
}

/** Block id of every cell of a grid, keyed by local cell. */
export function cellMap(grid: VoxelGrid & { forEachCell(f: (x: number, y: number, z: number, c: number) => void): void }): Map<string, number> {
  const out = new Map<string, number>();
  grid.forEachCell((x, y, z, c) => out.set(`${x},${y},${z}`, c & ID_MASK));
  return out;
}

/** World centres of every hard cell of a ship. */
export function hullCentres(ship: Ship): Vec3[] {
  const out: Vec3[] = [];
  ship.grid.forEachCell((x, y, z, c) => {
    if (SOLID[c & ID_MASK] !== 1) return;
    out.push(ship.grid.toWorld(vec3(x + 0.5, y + 0.5, z + 0.5)));
  });
  return out;
}

/** World points densely sampled on the hard hull cells: corners, edge midpoints, face centres. */
export function hullSamples(ship: Ship): Vec3[] {
  const out: Vec3[] = [];
  const seen = new Set<string>();
  ship.grid.forEachCell((x, y, z, c) => {
    if (SOLID[c & ID_MASK] !== 1) return;
    for (let i = 0; i <= 2; i++) {
      for (let j = 0; j <= 2; j++) {
        for (let k = 0; k <= 2; k++) {
          if (i === 1 && j === 1 && k === 1) continue;
          const key = `${2 * x + i},${2 * y + j},${2 * z + k}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(ship.grid.toWorld(vec3(x + i / 2, y + j / 2, z + k / 2)));
        }
      }
    }
  });
  return out;
}

export interface Box3 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** World AABB of the given points. */
export function extent(pts: readonly Vec3[]): Box3 {
  const e = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of pts) {
    e.minX = Math.min(e.minX, p.x);
    e.maxX = Math.max(e.maxX, p.x);
    e.minY = Math.min(e.minY, p.y);
    e.maxY = Math.max(e.maxY, p.y);
    e.minZ = Math.min(e.minZ, p.z);
    e.maxZ = Math.max(e.maxZ, p.z);
  }
  return e;
}

// ------------------------------------------------------------------ entities

/** Does the entity's body overlap a hard cell of `grid` (the same test the push and crush use)? */
export function bodyIn(grid: VoxelGrid, e: Entity): boolean {
  return boxOverlapsSolid(grid, e.box(aabb()));
}

/**
 * Depth that counts as touching, not inside (blocks). A world-axis box resting on a rocking deck
 * touches it by about 1e-5 when placed against the deck's previous pose (a client-driven body:
 * the client places it against the carrier as it shows it); 1e-4 leaves room for that and no more.
 */
export const TOUCH = 1e-4;

/** How deep the entity's body is inside the hard cells of `grid` (0 = not inside; the push's measure). */
export function depthIn(grid: VoxelGrid, e: Entity): number {
  const b = e.box(aabb());
  if (!boxOverlapsSolid(grid, b)) return 0;
  return deepestPenetration(grid, b)?.depth ?? Infinity;
}

/** Live item entities (and their total count), optionally of one item. */
export function drops(sim: Simulation, item?: number): { entities: number; count: number; items: Set<number> } {
  let entities = 0;
  let count = 0;
  const items = new Set<number>();
  for (const e of sim.entities.all()) {
    if (e.removed || !(e instanceof ItemEntity)) continue;
    const st = e.stack;
    if (item !== undefined && st.item !== item) continue;
    entities++;
    count += st.count;
    items.add(st.item);
  }
  return { entities, count, items };
}

export interface CrushRecord {
  tick: number;
  entityId: number;
  kind: string;
}

/**
 * Records the entities module's 'crush' events (squeezed by a structure and moved to a free
 * spot). The simulation publishes no SimEvent for a crush — only 'playerHurt' when a survival
 * player takes damage — so this listens where the simulation hands entity events to its
 * interaction layer. Observation only: every event still goes through.
 */
export function watchCrushes(sim: Simulation): CrushRecord[] {
  const list: CrushRecord[] = [];
  const it = sim.interaction;
  const orig = it.onEntityEvent.bind(it);
  vi.spyOn(it, 'onEntityEvent').mockImplementation((ev: EntityEvent) => {
    if (ev.type === 'crush') list.push({ tick: sim.ticks, entityId: ev.entity.id, kind: ev.entity.kind });
    orig(ev);
  });
  return list;
}

/** Records every SimEvent. */
export function watchEvents(sim: Simulation): SimEvent[] {
  const list: SimEvent[] = [];
  sim.events.on((e) => list.push(e));
  return list;
}

export function hurtEvents(events: readonly SimEvent[]): Array<Extract<SimEvent, { type: 'playerHurt' }>> {
  return events.filter((e): e is Extract<SimEvent, { type: 'playerHurt' }> => e.type === 'playerHurt');
}

export function copy(v: Vec3): Vec3 {
  return vec3(v.x, v.y, v.z);
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function hdist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
