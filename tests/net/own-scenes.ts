/**
 * Scenes for the end-to-end tests of the client's own player (package 6, NETCODE section 9): a real
 * HeadlessClient predicting its player (OwnPlayer) against a real ServerHost through the harness,
 * on the links of e2e-scenes.ts. The scene is built on the server's Simulation; the player is
 * moved only by its client's held input, scripted per client tick (HeadlessClient.onStep).
 *
 * Worlds: LAND (flat turf, first air y = LAND_TOP) and OWN_SEA (stone up to SEA_FLOOR - 1, water up
 * to OWN_SEA_TOP - 1), with a cobble block at the spawn (0.5, top, 0.5) so a joining player stands.
 */
import { appendFileSync } from 'node:fs';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NY, NZ, PY, type Dir } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import type { GameMode } from '../../src/entities/entity';
import type { PlayerControl } from '../../src/sim/players';
import type { Simulation } from '../../src/sim/simulation';
import type { Rotor, Ship } from '../../src/structures/structure';
import type { GeneratorSpec } from '../../src/worldgen/generator';
import { fill, loadArea } from './e2e-scenes';
import { NetHarness, testMeta, type ClientLink, type HeadlessClient } from './harness';

export const LAND_TOP = 35;
export const LAND: GeneratorSpec = {
  kind: 'flat',
  seed: 11,
  layers: [
    { cell: B.DEEPROCK, thickness: 1 },
    { cell: B.STONE, thickness: 30 },
    { cell: B.DIRT, thickness: 3 },
    { cell: B.TURF, thickness: 1 },
  ],
};

export const SEA_FLOOR = 20;
/** First air cell above the sea. */
export const OWN_SEA_TOP = 30;
export const OWN_SEA: GeneratorSpec = {
  kind: 'flat',
  seed: 12,
  layers: [
    { cell: B.DEEPROCK, thickness: 1 },
    { cell: B.STONE, thickness: SEA_FLOOR - 1 },
    { cell: B.WATER, thickness: OWN_SEA_TOP - SEA_FLOOR },
  ],
};

/** One player's end-to-end run: the harness, its client, the server's control of the player, and what happened since mark(). */
export class OwnRun {
  /** Hurt events of the player since mark(). */
  readonly hurts: Array<{ amount: number; cause: string; tick: number }> = [];
  /** Client ticks (report seqs) since mark(). */
  steps = 0;
  private markTick = -1;
  private markSeq = 0;
  private markRejected = 0;
  private script: ((k: number) => void) | null = null;

  private readonly tickFns: Array<() => void> = [];

  constructor(
    readonly h: NetHarness,
    readonly c: HeadlessClient,
  ) {
    h.onTick = () => {
      for (const f of this.tickFns) f();
    };
    h.sim.events.on((e) => {
      if (e.type === 'playerHurt' && e.player === c.key && this.markTick >= 0) this.hurts.push({ amount: e.amount, cause: e.cause, tick: h.sim.ticks });
    });
    c.onStep = (seq) => {
      if (this.markTick < 0) return;
      this.steps = seq - this.markSeq;
      this.script?.(this.steps);
    };
  }

  get sim(): Simulation {
    return this.h.sim;
  }
  get ctrl(): PlayerControl {
    return this.h.sim.players.get(this.c.key)!;
  }

  /** From now on: corrections, hurts, rejected reports and client ticks are counted; `script(k)` sets the held input at client tick k (1, 2, ...). */
  mark(script: ((k: number) => void) | null = null): void {
    this.h.run(1);
    this.markTick = this.sim.ticks;
    this.markSeq = this.c.own!.lastSeq;
    this.markRejected = this.ctrl.player.remote!.rejected;
    this.steps = 0;
    this.hurts.length = 0;
    this.script = script;
  }

  /** Call `f` after every server tick. */
  onTick(f: () => void): void {
    this.tickFns.push(f);
  }

  /** Run until `k` client ticks have passed since mark(), then `extraMs`. */
  runSteps(k: number, extraMs = 0): void {
    this.h.runUntil(() => this.steps >= k, Math.max(20_000, k * 400), 1);
    if (extraMs > 0) this.h.run(extraMs);
  }

  /** Causes of the corrections the client applied since mark(). */
  causes(): string[] {
    return this.c.correctionsSince(this.markTick);
  }

  /** Reports the server refused since mark(). */
  rejected(): number {
    return this.ctrl.player.remote!.rejected - this.markRejected;
  }

  /** Damage taken since mark(). */
  damage(): number {
    return this.hurts.reduce((a, x) => a + x.amount, 0);
  }

  /** Teleport the player on the server and wait until its client adopted the correction and stands (or floats) again. */
  teleport(x: number, y: number, z: number, settleMs = 600): void {
    this.ctrl.teleport(x, y, z);
    this.h.run(settleMs);
  }

  /** Drop the script and let go of every held key. */
  idle(): void {
    this.script = null;
    this.c.stopInput();
  }
}

/** A world of `spec` in `mode`, built by `build` before anyone joins; one local client on `link` (generating pristine columns `genDelayMs` late), ready. */
export async function ownWorld(spec: GeneratorSpec, mode: GameMode, link: ClientLink, build?: (sim: Simulation) => void, viewRadius = 3, genDelayMs = 0): Promise<OwnRun> {
  const h = new NetHarness({ history: true });
  await h.create(testMeta('own', mode), { generator: spec, exampleShip: false });
  const sim = h.sim;
  const top = spec === LAND ? LAND_TOP : OWN_SEA_TOP;
  loadArea(sim, -24, -24, 24, 24);
  if (spec !== LAND) fill(sim, 0, SEA_FLOOR, 0, 0, top - 1, 0, B.COBBLE);
  build?.(sim);
  const c = h.addClient('p', link, { local: true, viewRadius, genDelayMs });
  h.runUntil(() => c.ready && c.own !== null, 60_000);
  h.run(300);
  return new OwnRun(h, c);
}

// ------------------------------------------------------------------ building (the drive scenes of package 2)

export interface RaftSpec {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Deck layer y. */
  y: number;
  helm: { x: number; z: number; facing?: Dir };
  gunwale?: boolean;
  extra?: Array<[number, number, number]>;
}

/** Plank deck (and gunwale, extras) with a helm on it; returns the helm cell. */
export function buildRaft(sim: Simulation, s: RaftSpec): Vec3 {
  fill(sim, s.x0, s.y, s.z0, s.x1, s.y, s.z1, B.PLANKS_OAK);
  if (s.gunwale) {
    fill(sim, s.x0, s.y + 1, s.z0, s.x1, s.y + 1, s.z0, B.PLANKS_OAK);
    fill(sim, s.x0, s.y + 1, s.z0, s.x0, s.y + 1, s.z1, B.PLANKS_OAK);
    fill(sim, s.x1, s.y + 1, s.z0, s.x1, s.y + 1, s.z1, B.PLANKS_OAK);
  }
  for (const [x, y, z] of s.extra ?? []) sim.world.setCell(x, y, z, makeCell(B.PLANKS_OAK));
  sim.world.setCell(s.helm.x, s.y + 1, s.helm.z, makeCell(B.HELM, facingState(s.helm.facing ?? NZ)));
  return vec3(s.helm.x, s.y + 1, s.helm.z);
}

/** Assemble the ship at a world helm (nobody takes the wheel). */
export function assemble(sim: Simulation, helm: Vec3): Ship {
  const res = sim.structures.assembleShip(helm.x, helm.y, helm.z);
  if (!res.ok) throw new Error(`assembleShip failed: ${res.reason}`);
  return res.structure;
}

/** Start the rotor on the bearing at a world cell (scene building). */
export function startRotor(sim: Simulation, x: number, y: number, z: number): Rotor {
  const r = sim.structures.startRotor(sim.world, x, y, z);
  if (!r.ok) throw new Error(`startRotor failed: ${r.reason}`);
  return r.structure;
}

/** A vertical-axis paddle on land: bearing (0, T+2, 0) facing down, a blade two high along x 0..6 at z 0. */
export function landPaddle(sim: Simulation, t = LAND_TOP): void {
  sim.world.setCell(0, t + 2, 0, makeCell(B.BEARING, facingState(NY)));
  sim.world.setCell(0, t + 1, 0, makeCell(B.CANVAS));
  sim.world.setCell(0, t, 0, makeCell(B.CANVAS));
  for (let x = 1; x <= 6; x++) {
    sim.world.setCell(x, t, 0, makeCell(B.CANVAS));
    sim.world.setCell(x, t + 1, 0, makeCell(B.CANVAS));
  }
}

/** A 5x5 felt turntable on a bearing facing up at (x0, T, 0) on land, the felt x0..x0+4 (not started). */
export function landTurntable(sim: Simulation, t = LAND_TOP, x0 = 0): void {
  sim.world.setCell(x0, t, 0, makeCell(B.BEARING, facingState(PY)));
  fill(sim, x0, t + 1, -2, x0 + 4, t + 1, 2, B.WOOL_WHITE);
}

/** A measured number for the report: one line appended to OWN_STATS_OUT, when set. */
export function stat(line: string): void {
  const out = process.env.OWN_STATS_OUT;
  if (out) appendFileSync(out, `${line}\n`);
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
