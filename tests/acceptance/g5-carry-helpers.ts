/**
 * Scene builders and probes for the 携带 acceptance scenarios (19–22), headless.
 *
 * Scenes are built with world.setCell (blocks, the sea comes from the generator); the player
 * then acts through the paths the real game uses: look + right-click (useOn / use), held
 * movement input (forward / strafe / jump / sneak), the held item. Internals are only touched to
 * build a scene (a ship sailing on under a remembered throttle while nobody is at the wheel) and
 * to observe results.
 */
import { expect } from 'vitest';
import { ID_MASK, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PX, PY, PZ, NX, type Dir } from '../../src/core/dirs';
import { qyaw, vec3, type Vec3 } from '../../src/core/math';
import { Simulation, type GameMode } from '../../src/sim/simulation';
import type { SimEvent } from '../../src/sim/view';
import { Rotor, Ship } from '../../src/structures/structure';
import type { VoxelGrid } from '../../src/voxel/grid';
import { FlatGenerator } from '../../src/worldgen/generator';

/** Sea world: deeprock y=0, stone 1..19, water 20..29; the first air cell is y = SEA_TOP. */
export const SEA_TOP = 30;
/** Top face of the sea floor. */
export const SEA_FLOOR = 20;
/** Height of the sea surface: a still source cell is 8/9 full. */
export const WATER_SURFACE = SEA_TOP - 1 + 8 / 9;
/** Default flat world: deeprock, stone, dirt, turf; the first air cell is y = FLAT_TOP. */
export const FLAT_TOP = 35;

export function seaSim(mode: GameMode, spawn: Vec3, seed = 1901): Simulation {
  return new Simulation({
    seed,
    mode,
    generator: new FlatGenerator([
      { id: B.DEEPROCK, thickness: 1 },
      { id: B.STONE, thickness: SEA_FLOOR - 1 },
      { id: B.WATER, thickness: SEA_TOP - SEA_FLOOR },
    ]),
    syncChunks: true,
    loadRadius: 3,
    rabbits: false,
    spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
  });
}

export function flatSim(mode: GameMode, spawn: Vec3, seed = 2001): Simulation {
  return new Simulation({
    seed,
    mode,
    generator: new FlatGenerator(),
    syncChunks: true,
    loadRadius: 2,
    rabbits: false,
    spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
  });
}

/** Fill an inclusive box of a grid with a block id (or full cell value). */
export function fillBox(g: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cell: number): void {
  const c = cell > ID_MASK ? cell : makeCell(cell);
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) g.setCell(x, y, z, c);
}

export type Side = 'N' | 'S' | 'E' | 'W';

export interface HullSpec {
  /** Inclusive footprint. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Layer of the floor / deck. */
  y: number;
  /** Floor and gunwale block. */
  block: number;
  /** Sides that get a gunwale (default none). */
  gunwale?: Side[];
  /** Gunwale height in cells (default 1). */
  gunwaleHeight?: number;
  /** Helm cell (on the floor, y + 1) and its facing = the bow (default north). */
  helm: { x: number; z: number; facing?: Dir };
}

/** Write a raft / hull into the WORLD (assemble it with assembleAtHelm). Returns the helm cell. */
export function buildHull(sim: Simulation, s: HullSpec): Vec3 {
  const w = sim.world;
  fillBox(w, s.x0, s.y, s.z0, s.x1, s.y, s.z1, s.block);
  const h = s.gunwaleHeight ?? 1;
  for (const side of s.gunwale ?? []) {
    if (side === 'N') fillBox(w, s.x0, s.y + 1, s.z0, s.x1, s.y + h, s.z0, s.block);
    if (side === 'S') fillBox(w, s.x0, s.y + 1, s.z1, s.x1, s.y + h, s.z1, s.block);
    if (side === 'W') fillBox(w, s.x0, s.y + 1, s.z0, s.x0, s.y + h, s.z1, s.block);
    if (side === 'E') fillBox(w, s.x1, s.y + 1, s.z0, s.x1, s.y + h, s.z1, s.block);
  }
  w.setCell(s.helm.x, s.y + 1, s.helm.z, makeCell(B.HELM, facingState(s.helm.facing ?? NZ)));
  return vec3(s.helm.x, s.y + 1, s.helm.z);
}

/** The face of a cell that looks toward the player's eyes (horizontal). */
export function faceToward(sim: Simulation, x: number, z: number): Dir {
  const e = sim.player.eyePos();
  const dx = e.x - (x + 0.5);
  const dz = e.z - (z + 0.5);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? PX : NX;
  return dz > 0 ? PZ : NZ;
}

/**
 * The player assembles the ship at a world helm the way the game does it: aim, right-click
 * (preview), right-click again (assemble + take the wheel). Returns the new ship.
 */
export function assembleAtHelm(sim: Simulation, helm: Vec3): Ship {
  const face = faceToward(sim, helm.x, helm.z);
  expect(sim.useOn(helm.x, helm.y, helm.z, face), 'the helm can be aimed at').toBe(true);
  expect(sim.view.preview?.kind).toBe('ship');
  expect(sim.useOn(helm.x, helm.y, helm.z, face), 'the helm can be aimed at again').toBe(true);
  const ships = sim.structures.ships();
  expect(ships.length).toBe(1);
  const ship = ships[0]!;
  expect(sim.player.steeringShipId).toBe(ship.id);
  return ship;
}

/** A plain right-click while steering lets go of the wheel (the player stays aboard). */
export function releaseWheelByClick(sim: Simulation): void {
  expect(sim.player.steeringShipId).not.toBe(0);
  sim.use();
  sim.tick();
  expect(sim.player.steeringShipId).toBe(0);
}

/** Heading of a structure (radians, CCW from above, 0 = bow toward -Z). */
export function yawOf(grid: { rotation: { x: number; y: number; z: number; w: number } }): number {
  return qyaw(grid.rotation);
}

/** Wrap to (-PI, PI]. */
export function wrap(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/**
 * The helmsman turns the ship to a heading with A / D (analog strafe input), then lets the
 * stick go. Returns the number of ticks it took. The rudder commands a yaw rate (max 0.25 rad/s
 * at rest; +1 = clockwise), so the stick is set proportionally to the remaining error.
 */
export function steerToYaw(sim: Simulation, ship: Ship, target: number, maxTicks = 900): number {
  const p = sim.player;
  expect(p.steeringShipId).toBe(ship.id);
  let calm = 0;
  for (let t = 0; t < maxTicks; t++) {
    const err = wrap(target - yawOf(ship.grid));
    const wantRate = Math.max(-0.25, Math.min(0.25, 1.2 * err));
    p.input.strafe = Math.max(-1, Math.min(1, -wantRate / 0.25));
    sim.tick();
    if (Math.abs(err) < 0.004 && Math.abs(ship.grid.angularVelocity.y) < 0.003) {
      if (++calm >= 10) {
        p.input.strafe = 0;
        return t;
      }
    } else calm = 0;
  }
  p.input.strafe = 0;
  return maxTicks;
}

/** Deck-local position of a world point. */
export function local(s: Ship | Rotor, p: Vec3): Vec3 {
  return s.grid.toLocal(p, vec3());
}

/** Horizontal distance between two points. */
export function hdist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function copy(v: Vec3): Vec3 {
  return vec3(v.x, v.y, v.z);
}

/** Records SimEvents of the given types. */
export class Events {
  readonly list: SimEvent[] = [];
  constructor(sim: Simulation) {
    sim.events.on((e) => this.list.push(e));
  }
  of<T extends SimEvent['type']>(type: T): Array<Extract<SimEvent, { type: T }>> {
    return this.list.filter((e) => e.type === type) as Array<Extract<SimEvent, { type: T }>>;
  }
}

/** Idle the held input. */
export function stopInput(sim: Simulation): void {
  const i = sim.player.input;
  i.forward = 0;
  i.strafe = 0;
  i.jump = false;
  i.sneak = false;
  i.sprint = false;
}

export { B, PY, makeCell, facingState };
