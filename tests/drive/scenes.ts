/**
 * Scenes for the client-driven player tests: whole simulations (sea or flat land) whose one
 * player is either server-driven (lag = null, the reference) or client-driven, played by the
 * lagged client harness (client.ts) with `lag` ticks of pose lag.
 */
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NY, NZ, type Dir } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import type { GameMode } from '../../src/entities/entity';
import type { EntityEvent } from '../../src/entities/host';
import { Simulation } from '../../src/sim/simulation';
import type { SimEvent } from '../../src/sim/view';
import type { Rotor, Ship } from '../../src/structures/structure';
import type { VoxelGrid } from '../../src/voxel/grid';
import { FlatGenerator } from '../../src/worldgen/generator';
import { soloSim } from '../solo';
import { attachClient, type LaggedClient } from './client';

/** Sea world: deeprock y=0, stone 1..19, water 20..29; the first air cell is y = SEA_TOP. */
export const SEA_TOP = 30;
export const SEA_FLOOR = 20;
/** Flat land: the first air cell is y = LAND_TOP. */
export const LAND_TOP = 35;

/** The pose lags (ticks) every lag test runs at: 0, 150 and 300 ms. */
export const LAGS = [0, 3, 6] as const;

export interface Run {
  readonly sim: Simulation;
  /** null for the server-driven reference. */
  readonly client: LaggedClient | null;
  readonly lag: number | null;
  /** Every SimEvent since the run started. */
  readonly events: SimEvent[];
  /** Ticks (sim.ticks) at which the player was squeezed (entity 'crush' events). */
  readonly crushes: number[];
}

/** Extra uplink delay (ticks) of the report of a client tick: see LaggedClient. */
export type Uplink = ((clientTick: number) => number) | null;

function makeRun(sim: Simulation, lag: number | null, uplink: Uplink = null): Run {
  const events: SimEvent[] = [];
  sim.events.on((e) => events.push(e));
  const crushes: number[] = [];
  const it = sim.interaction;
  const orig = it.onEntityEvent.bind(it);
  it.onEntityEvent = (ev: EntityEvent) => {
    if (ev.type === 'crush' && ev.entity.kind === 'player') crushes.push(sim.ticks);
    orig(ev);
  };
  const client = lag === null ? null : attachClient(sim, lag, sim.soloPlayer, uplink);
  return { sim, client, lag, events, crushes };
}

export function seaRun(mode: GameMode, spawn: Vec3, lag: number | null, seed = 7001, uplink: Uplink = null): Run {
  const sim = soloSim({
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
  return makeRun(sim, lag, uplink);
}

export function landRun(mode: GameMode, spawn: Vec3, lag: number | null, seed = 7002, uplink: Uplink = null): Run {
  const sim = soloSim({ seed, mode, generator: new FlatGenerator(), syncChunks: true, loadRadius: 2, rabbits: false, spawn: { x: spawn.x, y: spawn.y, z: spawn.z } });
  return makeRun(sim, lag, uplink);
}

/**
 * A jittery uplink: 0..4 extra ticks per report in a fixed pseudo-random pattern; with in-order
 * delivery, reports often arrive in bunches of several per tick.
 */
export const JITTER: Uplink = (n) => (n * 104729) % 5;

/** Fill an inclusive box of a grid with a block id (0 = air). */
export function fill(g: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  const c = id === 0 ? 0 : makeCell(id);
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) g.setCell(x, y, z, c);
}

// ------------------------------------------------------------------ events

export function hurts(run: Run): Array<Extract<SimEvent, { type: 'playerHurt' }>> {
  return run.events.filter((e): e is Extract<SimEvent, { type: 'playerHurt' }> => e.type === 'playerHurt');
}

/** Corrections the client received (causes), or [] for the reference. */
export function corrections(run: Run): string[] {
  return run.client === null ? [] : run.client.causes();
}

/** Server statistics of the client-driven player (zeros for the reference). */
export interface DriveStats {
  accepted: number;
  dropped: number;
  rejected: number;
  /** Ticks the reported body overlapped a structure at the server's poses. */
  overlap: number;
  /** ... by more than SQUEEZE_DEPTH; and the longest run of those. */
  deep: number;
  deepRun: number;
  /** Longest run of ticks the usual push-out alone left it squeezed. */
  plainRun: number;
  /** Squeeze candidate ticks, and the longest run of them. */
  candidates: number;
  longestRun: number;
}

export function driveStats(run: Run): DriveStats {
  const d = run.sim.soloPlayer.player.remote;
  if (d === null) return { accepted: 0, dropped: 0, rejected: 0, overlap: 0, deep: 0, deepRun: 0, plainRun: 0, candidates: 0, longestRun: 0 };
  return {
    accepted: d.accepted,
    dropped: d.dropped,
    rejected: d.rejected,
    overlap: d.overlapTicks,
    deep: d.deepOverlapTicks,
    deepRun: d.longestDeepRun,
    plainRun: d.longestPlainStuckRun,
    candidates: d.squeezeCandidateTicks,
    longestRun: d.longestSqueezeRun,
  };
}

// ------------------------------------------------------------------ building

export interface RaftSpec {
  /** Inclusive deck footprint, deck layer y. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
  /** Helm cell (on the deck, y + 1) and its facing (the bow). */
  helm: { x: number; z: number; facing?: Dir };
  /** One-high gunwale along the deck edge, except the stern (z1). */
  gunwale?: boolean;
  /** Extra plank cells (world coordinates at assembly), e.g. a bowsprit. */
  extra?: Array<[number, number, number]>;
}

export function buildRaft(sim: Simulation, s: RaftSpec): Vec3 {
  const w = sim.world;
  fill(w, s.x0, s.y, s.z0, s.x1, s.y, s.z1, B.PLANKS_OAK);
  if (s.gunwale) {
    fill(w, s.x0, s.y + 1, s.z0, s.x1, s.y + 1, s.z0, B.PLANKS_OAK);
    fill(w, s.x0, s.y + 1, s.z0, s.x0, s.y + 1, s.z1, B.PLANKS_OAK);
    fill(w, s.x1, s.y + 1, s.z0, s.x1, s.y + 1, s.z1, B.PLANKS_OAK);
  }
  for (const [x, y, z] of s.extra ?? []) w.setCell(x, y, z, makeCell(B.PLANKS_OAK));
  w.setCell(s.helm.x, s.y + 1, s.helm.z, makeCell(B.HELM, facingState(s.helm.facing ?? NZ)));
  return vec3(s.helm.x, s.y + 1, s.helm.z);
}

/** Assemble the ship at a world helm (scene building; nobody takes the wheel). */
export function assemble(sim: Simulation, helm: Vec3): Ship {
  const res = sim.structures.assembleShip(helm.x, helm.y, helm.z);
  if (!res.ok) throw new Error(`assembleShip failed: ${res.reason}`);
  return res.structure;
}

/**
 * The player starts the windmill on the world bearing at (x, y, z) by clicking it twice, looking
 * at `face` (preview, start). Returns the rotor.
 */
export function startRotor(sim: Simulation, x: number, y: number, z: number, face: Dir): Rotor {
  const before = new Set(sim.structures.rotors());
  const c = sim.soloPlayer;
  if (!c.useOn(x, y, z, face)) throw new Error('cannot aim at the bearing');
  if (!c.useOn(x, y, z, face)) throw new Error('cannot aim at the bearing a second time');
  const started = sim.structures.rotors().filter((r) => !before.has(r));
  if (started.length !== 1) throw new Error(`started ${started.length} rotors`);
  return started[0]!;
}

/** A vertical-axis paddle: bearing at (x, y, z) facing down, canvas cells hanging below its hub. */
export function buildPaddle(sim: Simulation, bearing: [number, number, number], canvas: Array<[number, number, number]>): void {
  sim.world.setCell(bearing[0], bearing[1], bearing[2], makeCell(B.BEARING, facingState(NY)));
  for (const [x, y, z] of canvas) sim.world.setCell(x, y, z, makeCell(B.CANVAS));
}

export function copy(v: Vec3): Vec3 {
  return vec3(v.x, v.y, v.z);
}

export function hdist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export { B, makeCell, facingState };
