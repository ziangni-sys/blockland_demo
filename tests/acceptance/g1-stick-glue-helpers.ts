/**
 * Helpers for the acceptance scenarios 1–5 (连接与胶水). Everything the player does goes
 * through the Simulation's scripted controls (look, right/left click, held item, sneak), i.e.
 * the same input path the client writes; internals are only touched to build scenes and to
 * observe results.
 */
import { expect } from 'vitest';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import '../../src/blocks/defs';
import { BLOCKS } from '../../src/blocks/registry';
import { TICK_DT } from '../../src/core/constants';
import { PZ, type Dir } from '../../src/core/dirs';
import { Simulation, type GameMode } from '../../src/sim/simulation';
import type { Message } from '../../src/sim/view';
import type { Rotor, Ship } from '../../src/structures/structure';
import type { StructureGrid } from '../../src/voxel/sgrid';
import type { VoxelGrid } from '../../src/voxel/grid';
import { FlatGenerator } from '../../src/worldgen/generator';

/** Default flat world: deeprock y=0, stone 1..30, dirt 31..33, turf 34 — the first air row is T. */
export const T = new FlatGenerator().top;

/** A fresh flat world (no rabbits), the player standing at `spawn` (default just south of the scene rows). */
export function makeSim(mode: GameMode = 'creative', spawn = { x: 0.5, y: T, z: 0.5 }): Simulation {
  const sim = new Simulation({
    seed: 0x5eed01,
    mode,
    generator: new FlatGenerator(),
    syncChunks: true,
    loadRadius: 2,
    rabbits: false,
    spawn,
  });
  sim.advance(6); // the remaining chunks of the load radius arrive (4 columns per tick)
  return sim;
}

export function put(sim: Simulation, x: number, y: number, z: number, id: number, state = 0): void {
  sim.world.setCell(x, y, z, makeCell(id, state));
}

export function idAt(grid: VoxelGrid, x: number, y: number, z: number): number {
  return grid.getCell(x, y, z) & ID_MASK;
}

export function blockName(id: number): string {
  return BLOCKS[id]?.key ?? `#${id}`;
}

/** "x,y,z:block" labels, sorted: compact and readable in assertion diffs. */
export function label(x: number, y: number, z: number, id: number): string {
  return `${x},${y},${z}:${blockName(id)}`;
}

export type CellSpec = readonly [number, number, number, number]; // x, y, z, block id

export function labels(cells: readonly CellSpec[]): string[] {
  return cells.map(([x, y, z, id]) => label(x, y, z, id)).sort();
}

/** Every non-air cell of a structure grid (local coordinates == the world cells it was taken from). */
export function structureLabels(grid: StructureGrid): string[] {
  const out: string[] = [];
  grid.forEachCell((x, y, z, cell) => out.push(label(x, y, z, cell & ID_MASK)));
  return out.sort();
}

/** The highlighted preview cells (view.preview), labelled with the WORLD block they show. */
export function previewLabels(sim: Simulation): string[] {
  const pv = sim.view.preview;
  if (pv === null) return [];
  const g = sim.structures.gridById(pv.gridId)!;
  const out: string[] = [];
  for (let i = 0; i < pv.cells.length; i += 3) {
    const x = pv.cells[i]!;
    const y = pv.cells[i + 1]!;
    const z = pv.cells[i + 2]!;
    out.push(label(x, y, z, idAt(g, x, y, z)));
  }
  return out.sort();
}

export interface Assembled<S> {
  /** What the first right-click highlighted. */
  preview: string[];
  structure: S;
  /** The cells the structure holds after the second right-click. */
  cells: string[];
}

/**
 * The player right-clicks the world helm at (x,y,z) twice (empty hand): the first click
 * previews, the second assembles. Fails loudly when the helm cannot be aimed at.
 */
export function assembleShipByHand(sim: Simulation, x: number, y: number, z: number, face: Dir = PZ): Assembled<Ship> {
  sim.emptyHand();
  expect(sim.useOn(x, y, z, face), 'aim at the helm').toBe(true);
  expect(sim.view.preview?.kind, 'first right-click previews a ship').toBe('ship');
  expect(sim.structures.ships().length, 'first right-click does not assemble').toBe(0);
  const preview = previewLabels(sim);
  expect(sim.useOn(x, y, z, face), 'aim at the helm again').toBe(true);
  const ships = sim.structures.ships();
  expect(ships.length, 'second right-click assembles one ship').toBe(1);
  const ship = ships[0]!;
  return { preview, structure: ship, cells: structureLabels(ship.grid) };
}

/** The player right-clicks the world bearing at (x,y,z) twice (empty hand): preview, then start. */
export function startRotorByHand(sim: Simulation, x: number, y: number, z: number, face: Dir = PZ): Assembled<Rotor> {
  sim.emptyHand();
  expect(sim.useOn(x, y, z, face), 'aim at the bearing').toBe(true);
  expect(sim.view.preview?.kind, 'first right-click previews a rotor').toBe('rotor');
  expect(sim.structures.rotors().length, 'first right-click does not start the rotor').toBe(0);
  const preview = previewLabels(sim);
  expect(sim.useOn(x, y, z, face), 'aim at the bearing again').toBe(true);
  const rotors = sim.structures.rotors();
  expect(rotors.length, 'second right-click starts one rotor').toBe(1);
  const rotor = rotors[0]!;
  return { preview, structure: rotor, cells: structureLabels(rotor.grid) };
}

/** Records the toasts the simulation emits. */
export class Toasts {
  readonly list: Message[] = [];
  constructor(sim: Simulation) {
    sim.events.on((e) => {
      if (e.type === 'toast') this.list.push(e.message);
    });
  }
  keys(): string[] {
    return this.list.map((m) => m.key);
  }
  clear(): void {
    this.list.length = 0;
  }
}

/** Survival mining time of a block, in ticks, according to its BlockDef (hardness seconds). */
export function hardnessTicks(id: number): number {
  return Math.round(BLOCKS[id]!.hardness / TICK_DT);
}

/**
 * Ticks the player needs to mine the world block at (x,y,z) by holding the attack button
 * (sim.mine), counted on the world clock. -1 when it did not break.
 */
export function measureMiningTicks(sim: Simulation, x: number, y: number, z: number, face?: Dir): number {
  const t0 = sim.ticks;
  const ok = sim.mine(x, y, z, face);
  return ok ? sim.ticks - t0 : -1;
}
