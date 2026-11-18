/**
 * Helpers for the acceptance scenarios 10–14 (docs/ACCEPTANCE.md "风车与方块化").
 *
 * Self-contained on purpose: everything the player does goes through the test world's player
 * (tests/acceptance/world.ts: held keys, look, clicks, held items); structures, world and entities
 * of the server's Simulation are read only to build scenes and to observe results.
 */
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import type { Dir } from '../../src/core/dirs';
import { ItemEntity, TntEntity } from '../../src/entities/entity';
import { Simulation, type GameMode } from '../../src/sim/simulation';
import type { SimEvent } from '../../src/sim/view';
import type { Rotor, Ship } from '../../src/structures/structure';
import type { VoxelGrid } from '../../src/voxel/grid';
import { FlatGenerator } from '../../src/worldgen/generator';
import { testWorld, type TestWorld } from './world';

/** Default flat world: deeprock y=0, stone 1..30, dirt 31..33, turf 34; first air at y = 35. */
export const T = 35;
/** Sea world: deeprock y=0, stone 1..19, water 20..29; first air at y = 30. */
export const SEA = 30;

export function flatWorld(mode: GameMode, spawn: { x: number; y: number; z: number }, seed = 1): TestWorld {
  return testWorld({ seed, mode, generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 2, spawn });
}

export function seaWorld(mode: GameMode, spawn: { x: number; y: number; z: number }, seed = 2): TestWorld {
  const generator = new FlatGenerator([
    { id: B.DEEPROCK, thickness: 1 },
    { id: B.STONE, thickness: 19 },
    { id: B.WATER, thickness: 10 },
  ]);
  return testWorld({ seed, mode, generator, syncChunks: true, rabbits: false, loadRadius: 3, spawn });
}

export function set(grid: VoxelGrid, x: number, y: number, z: number, id: number, state = 0): void {
  grid.setCell(x, y, z, makeCell(id, state));
}

export function fill(grid: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  const c = makeCell(id);
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) grid.setCell(x, y, z, c);
    }
  }
}

export function idAt(grid: VoxelGrid, x: number, y: number, z: number): number {
  return grid.getCell(x, y, z) & ID_MASK;
}

/** Every cell of `grid` in an inclusive box whose id is in `ids`, as sorted "x,y,z:id" strings. */
export function cellsIn(
  grid: VoxelGrid,
  ids: readonly number[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): string[] {
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const id = idAt(grid, x, y, z);
        if (ids.includes(id)) out.push(`${x},${y},${z}:${id}`);
      }
    }
  }
  return out.sort();
}

/** Every non-air cell of a structure grid whose id is in `ids` (all ids when omitted), sorted. */
export function gridCells(grid: { forEachCell(fn: (x: number, y: number, z: number, cell: number) => void): void }, ids?: readonly number[]): string[] {
  const out: string[] = [];
  grid.forEachCell((x, y, z, cell) => {
    const id = cell & ID_MASK;
    if (ids === undefined || ids.includes(id)) out.push(`${x},${y},${z}:${id}`);
  });
  return out.sort();
}

export function key(x: number, y: number, z: number, id: number): string {
  return `${x},${y},${z}:${id}`;
}

/** Live item drops: total count per item id (all ids when omitted). */
export function dropped(sim: Simulation, item?: number): number {
  let n = 0;
  for (const e of sim.entities.all()) {
    if (e.removed || !(e instanceof ItemEntity)) continue;
    if (item !== undefined && e.stack.item !== item) continue;
    n += e.stack.count;
  }
  return n;
}

export function primedCrates(sim: Simulation): TntEntity[] {
  return sim.entities.all().filter((e): e is TntEntity => !e.removed && e instanceof TntEntity);
}

/** Records every SimEvent. */
export class Events {
  readonly list: SimEvent[] = [];
  constructor(sim: Simulation) {
    sim.events.on((e) => this.list.push(e));
  }
  of<K extends SimEvent['type']>(type: K): Array<Extract<SimEvent, { type: K }>> {
    return this.list.filter((e) => e.type === type) as Array<Extract<SimEvent, { type: K }>>;
  }
  toastKeys(): string[] {
    return this.of('toast').map((t) => t.message.key);
  }
}

/** Quarter turns (0..3) of the grid rotation nearest to a spin angle (radians). */
export function quarterOf(angle: number): number {
  return (((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4) as number;
}

/**
 * Offset (a, b) in the plane perpendicular to a spin axis, turned by k positive quarter turns
 * (right-handed about the axis). For axis +X the plane coordinates are (y, z): +y goes to +z.
 * For axis +Y they are (z, x): +z goes to +x. Exact integer maths.
 */
export function quarterTurn(k: number, a: number, b: number): [number, number] {
  let p = a;
  let q = b;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) {
    const np = -q;
    q = p;
    p = np;
  }
  return [p, q];
}

/** Where a cell of a +X-axis rotor (hub at hx,hy,hz) lands after k quarter turns. */
export function turnedAboutX(k: number, _hx: number, hy: number, hz: number, x: number, y: number, z: number): [number, number, number] {
  const [dy, dz] = quarterTurn(k, y - hy, z - hz);
  return [x, hy + dy, hz + dz];
}

/** Where a cell of a +Y-axis rotor (hub at hx,hy,hz) lands after k quarter turns. */
export function turnedAboutY(k: number, hx: number, _hy: number, hz: number, x: number, y: number, z: number): [number, number, number] {
  const [dz, dx] = quarterTurn(k, z - hz, x - hx);
  return [hx + dx, y, hz + dz];
}

/** Right-click the bearing twice like a player (preview, then start). Returns the new rotor. */
export function startByPlayer(w: TestWorld, x: number, y: number, z: number, face: Dir | undefined, gridId = 0): Rotor {
  const { sim, me } = w;
  const before = new Set(sim.structures.rotors());
  if (!me.useOn(x, y, z, face, gridId)) throw new Error('cannot aim at the bearing (first click)');
  if (me.view.preview?.kind !== 'rotor') throw new Error('no rotor preview after the first click');
  if (!me.useOn(x, y, z, face, gridId)) throw new Error('cannot aim at the bearing (second click)');
  const fresh = sim.structures.rotors().filter((r) => !before.has(r));
  if (fresh.length !== 1) throw new Error(`expected one new rotor, got ${fresh.length}`);
  return fresh[0]!;
}

/** Tick until the rotor's angle (relative to its parent) lies in [lo, hi). Throws after maxTicks. */
export function spinUntil(w: TestWorld, rotor: Rotor, lo: number, hi: number, maxTicks = 2000): number {
  for (let i = 0; i < maxTicks; i++) {
    if (rotor.angle >= lo && rotor.angle < hi) return i;
    w.tickWhile();
  }
  throw new Error(`rotor angle never reached [${lo}, ${hi}) (now ${rotor.angle})`);
}

/** Tick until an explosion event; returns it (throws after maxTicks). */
export function tickUntilExplosion(w: TestWorld, log: Events, maxTicks = 200): Extract<SimEvent, { type: 'explosion' }> {
  const n0 = log.of('explosion').length;
  for (let i = 0; i < maxTicks; i++) {
    w.tickWhile();
    const ex = log.of('explosion');
    if (ex.length > n0) return ex[n0]!;
  }
  throw new Error('no explosion');
}

/** Largest linear and angular speed of a ship over the next `ticks` ticks (and its largest displacement). */
export function watchShip(tw: TestWorld, ship: Ship, ticks: number): { maxSpeed: number; maxSpin: number; maxMove: number } {
  const p0 = { x: ship.grid.position.x, y: ship.grid.position.y, z: ship.grid.position.z };
  let maxSpeed = 0;
  let maxSpin = 0;
  let maxMove = 0;
  for (let i = 0; i < ticks; i++) {
    tw.tick();
    const v = ship.grid.linearVelocity;
    const w = ship.grid.angularVelocity;
    const p = ship.grid.position;
    maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
    maxSpin = Math.max(maxSpin, Math.hypot(w.x, w.y, w.z));
    maxMove = Math.max(maxMove, Math.hypot(p.x - p0.x, p.y - p0.y, p.z - p0.z));
  }
  return { maxSpeed, maxSpin, maxMove };
}
