/**
 * Shared fixtures for the structcore tests: hand-built worlds (new Chunk + setCell, never
 * worldgen), a recording StructureHost, a minimal ShipDynamics and a few scene builders.
 */
import { axisState, facingState, liquidState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { CHUNK_SHIFT } from '../../src/core/constants';
import type { Axis, Dir } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { analyzeHull } from '../../src/structures/hull';
import { GlueStore } from '../../src/structures/glue';
import { StructureManager } from '../../src/structures/manager';
import type { Rotor, Ship, ShipDynamics, Structure, StructureHost } from '../../src/structures/structure';
import { Chunk } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { World } from '../../src/voxel/world';

export const c = (id: number, state = 0): number => makeCell(id, state);
export const log = (axis: Axis, id: number = B.LOG_OAK): number => makeCell(id, axisState(axis));
export const facing = (id: number, d: Dir): number => makeCell(id, facingState(d));
export const WATER = makeCell(B.WATER, liquidState(0, false));
export const WATER_FLOWING = makeCell(B.WATER, liquidState(3, false));

export interface Drop {
  x: number;
  y: number;
  z: number;
  item: number;
  count: number;
}

/** StructureHost that records everything the manager asks of it. */
export class FakeHost implements StructureHost {
  readonly world: World;
  readonly worldGlue = new GlueStore();
  readonly rng = new Rng(7);
  dropsEnabled = true;
  readonly drops: Drop[] = [];
  readonly updates: Array<[number, number, number]> = [];
  readonly released: Structure[] = [];

  constructor(world: World) {
    this.world = world;
  }
  spawnDrop(x: number, y: number, z: number, item: number, count: number): void {
    this.drops.push({ x, y, z, item, count });
  }
  blockUpdate(x: number, y: number, z: number): void {
    this.updates.push([x, y, z]);
  }
  releaseRiders(structure: Structure): void {
    this.released.push(structure);
  }
  updateKeys(): Set<string> {
    return new Set(this.updates.map(([x, y, z]) => `${x},${y},${z}`));
  }
}

/** Minimal dynamics: refresh moves the pivot to the centre of mass like the real one; records calls. */
export class FakeDynamics implements ShipDynamics {
  readonly refreshed: Ship[] = [];
  readonly woken: Ship[] = [];
  steps = 0;
  lastShips: readonly Ship[] = [];
  lastRotors: readonly Rotor[] = [];
  onStep: ((ships: readonly Ship[], rotors: readonly Rotor[]) => void) | null = null;

  refresh(ship: Ship): void {
    this.refreshed.push(ship);
    if (ship.hull !== null && ship.hull.version === ship.grid.version) return;
    const h = analyzeHull(ship.grid);
    ship.hull = h;
    ship.mass = h ? h.mass : 0;
    if (h) ship.grid.setPivotKeepingPose(h.com);
  }
  step(ships: readonly Ship[], rotors: readonly Rotor[]): void {
    this.steps++;
    this.lastShips = ships;
    this.lastRotors = rotors;
    this.onStep?.(ships, rotors);
  }
  applyImpulse(): void {}
  wake(ship: Ship): void {
    this.woken.push(ship);
  }
}

/** Load (empty) chunks covering world columns x0..x1, z0..z1 (inclusive). */
export function loadArea(world: World, x0: number, z0: number, x1: number, z1: number): void {
  for (let cx = x0 >> CHUNK_SHIFT; cx <= x1 >> CHUNK_SHIFT; cx++) {
    for (let cz = z0 >> CHUNK_SHIFT; cz <= z1 >> CHUNK_SHIFT; cz++) {
      if (!world.getChunk(cx, cz)) world.addChunk(new Chunk(cx, cz));
    }
  }
}

export interface Scene {
  world: World;
  host: FakeHost;
  mgr: StructureManager;
  dyn: FakeDynamics | null;
}

/** A world with chunks covering x,z in [-32, 31], a recording host and a manager. */
export function scene(opts: { dynamics?: boolean; seed?: number } = {}): Scene {
  const world = new World(opts.seed ?? 1);
  loadArea(world, -32, -32, 31, 31);
  const host = new FakeHost(world);
  const dyn = opts.dynamics ? new FakeDynamics() : null;
  const mgr = new StructureManager(host, dyn);
  return { world, host, mgr, dyn };
}

export function fill(g: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cell: number): void {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) g.setCell(x, y, z, cell);
}

/** Map "x,y,z" -> cell of every non-air cell of a structure grid or of a world box. */
export function cellMap(g: VoxelGrid, box?: [number, number, number, number, number, number]): Map<string, number> {
  const m = new Map<string, number>();
  if (box) {
    const [x0, y0, z0, x1, y1, z1] = box;
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const cell = g.getCell(x, y, z);
      if (cell !== 0) m.set(`${x},${y},${z}`, cell);
    }
    return m;
  }
  const sg = g as unknown as { forEachCell(fn: (x: number, y: number, z: number, cell: number) => void): void };
  sg.forEachCell((x, y, z, cell) => m.set(`${x},${y},${z}`, cell));
  return m;
}

/** World centre of a local cell of a grid. */
export function worldCentre(g: VoxelGrid, x: number, y: number, z: number): Vec3 {
  return g.toWorld(vec3(x + 0.5, y + 0.5, z + 0.5));
}

/** Snapshot of a world box (every cell, air included) for "nothing changed" checks. */
export function snapshotBox(g: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push(g.getCell(x, y, z));
  return out;
}

/**
 * Windmill on a bearing at (bx,by,bz) facing +Z (south) in grid `g`: a planks support behind
 * the bearing, a canvas hub in front of it and four felt arms of `arm` cells each in the
 * plane z = bz + 1. Returns the hub cell. Sails = 1 + 4 * arm.
 */
export function windmill(g: VoxelGrid, bx: number, by: number, bz: number, arm = 3): [number, number, number] {
  g.setCell(bx, by, bz - 1, c(B.PLANKS_OAK));
  g.setCell(bx, by, bz, facing(B.BEARING, 4 /* +Z */));
  const hz = bz + 1;
  g.setCell(bx, by, hz, c(B.CANVAS));
  for (let i = 1; i <= arm; i++) {
    g.setCell(bx + i, by, hz, c(B.WOOL_RED));
    g.setCell(bx - i, by, hz, c(B.WOOL_BLUE));
    g.setCell(bx, by + i, hz, c(B.WOOL_WHITE));
    g.setCell(bx, by - i, hz, c(B.WOOL_YELLOW));
  }
  return [bx, by, hz];
}

/** Rotate integer offset (dx,dy) about +Z by k quarter turns (right-handed: +X -> +Y). */
export function rotZ(dx: number, dy: number, k: number): [number, number] {
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return [dx, dy];
  if (q === 1) return [-dy, dx];
  if (q === 2) return [-dx, -dy];
  return [dy, -dx];
}

/** Rotate an integer offset about +Y by k quarter turns (right-handed / CCW from above: +X -> -Z). */
export function rotY(dx: number, dz: number, k: number): [number, number] {
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return [dx, dz];
  if (q === 1) return [dz, -dx];
  if (q === 2) return [-dx, -dz];
  return [-dz, dx];
}

/** Every world-glue face as "x,y,z,axis" (canonical form). */
export function glueKeys(g: GlueStore): string[] {
  const out: string[] = [];
  g.forEach((x, y, z, axis) => out.push(`${x},${y},${z},${axis}`));
  return out.sort();
}

/** Bearing of the millShip windmill (facing +Z, mounted on the mast top behind it). */
export const MILL_BEARING: readonly [number, number, number] = [0, 65, -2];
/** Helm of the millShip (facing north). */
export const SHIP_HELM: readonly [number, number, number] = [0, 61, 2];
/** Cells of the millShip hull without the windmill: 49 deck + 5 mast + bearing + helm + 2 logs. */
export const SHIP_CELLS = 58;
/** Cells of the millShip windmill: canvas hub + 4 arms of 2 felt. */
export const MILL_CELLS = 9;

/**
 * A raft of planks (7 x 7 at y = 60, x,z in [-3, 3]) with a helm facing north at (0,61,2), a
 * planks mast at (0, 61..65, -3), two X-axis logs at (2..3, 61, 0) glued to the deck, one
 * redundant glued deck face, and a windmill (arm 2) on a bearing at (0,65,-2) facing +Z.
 * With `hubGlue` the hub is glued to the bearing, so a stopped windmill assembles with the ship.
 */
export function millShip(g: VoxelGrid, glue: GlueStore, hubGlue = false): void {
  fill(g, -3, 60, -3, 3, 60, 3, c(B.PLANKS_OAK));
  fill(g, 0, 61, -3, 0, 65, -3, c(B.PLANKS_PINE));
  g.setCell(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2], facing(B.HELM, 5 /* north */));
  g.setCell(2, 61, 0, log(0));
  g.setCell(3, 61, 0, log(0));
  glue.add(2, 61, 0, 3 /* down */);
  glue.add(-3, 60, -3, 4 /* +Z */);
  windmill(g, MILL_BEARING[0], MILL_BEARING[1], MILL_BEARING[2], 2);
  if (hubGlue) glue.add(MILL_BEARING[0], MILL_BEARING[1], MILL_BEARING[2], 4 /* +Z */);
}
