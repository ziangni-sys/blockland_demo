/**
 * Headless helpers for the simulation tests: small flat worlds, block filling, event capture.
 * Everything goes through the public Simulation surface (input, inventory, helper methods).
 */
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { type GameMode, type SimOptions, type Simulation } from '../../src/sim/simulation';
import type { Message, SimEvent } from '../../src/sim/view';
import { FlatGenerator, VoidGenerator } from '../../src/worldgen/generator';
import type { VoxelGrid } from '../../src/voxel/grid';
import { soloSim } from '../solo';

export interface WorldOpts {
  mode?: GameMode;
  spawn?: { x: number; y: number; z: number };
  rabbits?: boolean;
  loadRadius?: number;
  seed?: number;
}

/** Default flat world: deeprock y=0, stone 1..30, dirt 31..33, turf 34; first air at y = 35. */
export const FLAT_TOP = 35;

/** Options of the default flat world (flatSim without a joined player: for loading a save into). */
export function flatOpts(o: WorldOpts = {}): SimOptions {
  return {
    seed: o.seed ?? 1,
    mode: o.mode ?? 'creative',
    generator: new FlatGenerator(),
    syncChunks: true,
    loadRadius: o.loadRadius ?? 2,
    rabbits: o.rabbits ?? false,
    spawn: o.spawn ?? { x: 0.5, y: FLAT_TOP, z: 0.5 },
  };
}

/** A flat world with one joined player (SOLO_KEY). */
export function flatSim(o: WorldOpts = {}): Simulation {
  return soloSim(flatOpts(o));
}

/** Sea world: deeprock y=0, stone 1..19, water 20..29 (surface cells at y = 29); first air y = 30. */
export const SEA_TOP = 30;

export function seaGenerator(): FlatGenerator {
  return new FlatGenerator([
    { id: B.DEEPROCK, thickness: 1 },
    { id: B.STONE, thickness: 19 },
    { id: B.WATER, thickness: 10 },
  ]);
}

/** Options of the sea world (seaSim without a joined player). */
export function seaOpts(o: WorldOpts = {}): SimOptions {
  return {
    seed: o.seed ?? 2,
    mode: o.mode ?? 'creative',
    generator: seaGenerator(),
    syncChunks: true,
    loadRadius: o.loadRadius ?? 2,
    rabbits: o.rabbits ?? false,
    spawn: o.spawn ?? { x: 0.5, y: SEA_TOP, z: 0.5 },
  };
}

/** A sea world with one joined player (SOLO_KEY). */
export function seaSim(o: WorldOpts = {}): Simulation {
  return soloSim(seaOpts(o));
}

/** A void world with one joined player (SOLO_KEY). */
export function voidSim(o: WorldOpts = {}): Simulation {
  return soloSim({
    seed: o.seed ?? 3,
    mode: o.mode ?? 'creative',
    generator: new VoidGenerator(),
    syncChunks: true,
    loadRadius: o.loadRadius ?? 2,
    rabbits: o.rabbits ?? false,
    spawn: o.spawn ?? { x: 0.5, y: 64, z: 0.5 },
  });
}

/** Fill an inclusive box of cells of a grid (world by default) with a block id or full cell. */
export function fill(grid: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cell: number): void {
  const c = cell > ID_MASK ? cell : makeCell(cell);
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) grid.setCell(x, y, z, c);
    }
  }
}

/** Number of cells with block `id` in an inclusive box. */
export function countId(grid: VoxelGrid, id: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if ((grid.getCell(x, y, z) & ID_MASK) === id) n++;
  return n;
}

export function idAt(grid: VoxelGrid, x: number, y: number, z: number): number {
  return grid.getCell(x, y, z) & ID_MASK;
}

/** Records every SimEvent. */
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

/** Number of live item entities holding `item`, and their total count. */
export function items(sim: Simulation, item?: number): { entities: number; count: number } {
  let entities = 0;
  let count = 0;
  for (const e of sim.entities.all()) {
    if (e.removed || e.kind !== 'item') continue;
    const st = (e as unknown as { stack: { item: number; count: number } }).stack;
    if (item !== undefined && st.item !== item) continue;
    entities++;
    count += st.count;
  }
  return { entities, count };
}

/** Right-click once with the one joined player (queues a press) and run one tick. */
export function click(sim: Simulation): void {
  sim.soloPlayer.use();
  sim.tick();
}

/** Left-click once with the one joined player and run one tick. */
export function hit(sim: Simulation): void {
  sim.soloPlayer.attack();
  sim.tick();
}
