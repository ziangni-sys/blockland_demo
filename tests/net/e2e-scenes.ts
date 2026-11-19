/**
 * Scenes and checks shared by the end-to-end tests (tests/net/e2e-*.test.ts): real HeadlessClients
 * against a real ServerHost through tests/net/harness.ts, the scenes set up and driven on the
 * server's Simulation directly (server-driven bots stand in for players until packages 6 and 7
 * let a HeadlessClient move and act).
 *
 * The world is a flat sea (SEA): stone up to y 37, water y 38..47, air from y 48 = SEA_LEVEL, so
 * the example windmill boat (sim/exampleShip.ts) finds open water near the spawn (0.5, 48, 0.5).
 */
import { cellState, facingState, makeCell, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SEA_LEVEL } from '../../src/core/constants';
import { PZ, type Dir } from '../../src/core/dirs';
import { qslerp, quat, vec3, type Quat, type Vec3 } from '../../src/core/math';
import { BEARING_V, DECK_Y, exampleShipCell, MAST_TOP_Y, placeExampleShip } from '../../src/sim/exampleShip';
import type { PlayerControl } from '../../src/sim/players';
import type { Simulation } from '../../src/sim/simulation';
import { Rotor, Ship } from '../../src/structures/structure';
import type { GeneratorSpec } from '../../src/worldgen/generator';
import { link, type ClientLink, type HeadlessClient, type NetHarness } from './harness';
import { countReplica, countServer, type Box } from './rig';

/** First air above the sea; the top water layer is SEA_TOP - 1. */
export const SEA_TOP = SEA_LEVEL;

export const SEA: GeneratorSpec = {
  kind: 'flat',
  seed: 3,
  layers: [
    { cell: B.DEEPROCK, thickness: 1 },
    { cell: B.STONE, thickness: SEA_TOP - 11 },
    { cell: B.WATER, thickness: 10 },
  ],
};

/** The three links of the end-to-end tests, as a fresh pair of directions each time (seeded per client). */
export const LINKS: ReadonlyArray<{ name: string; make: (seed: number) => ClientLink }> = [
  { name: '0 ms', make: () => ({}) },
  { name: '150 ms round trip, 20 ms jitter, 5% loss', make: (seed) => ({ up: link(75, 20, 0.05, seed), down: link(75, 20, 0.05, seed + 1) }) },
  { name: '400 ms round trip, 20% loss', make: (seed) => ({ up: link(200, 20, 0.2, seed), down: link(200, 20, 0.2, seed + 1) }) },
];

/** The links' total loss, for tolerances. */
export function lossOf(l: ClientLink): number {
  return Math.max(l.up?.loss ?? 0, l.down?.loss ?? 0);
}

/** Load the columns of a box now (setup before the first tick, as sim/exampleShip.ts does); setCell does nothing on missing ones. */
export function loadArea(sim: Simulation, x0: number, z0: number, x1: number, z1: number): void {
  for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
    for (let cz = z0 >> 4; cz <= z1 >> 4; cz++) if (sim.world.getChunk(cx, cz) === undefined) sim.chunks.loadColumn(sim.generator, cx, cz);
  }
}

export function fill(sim: Simulation, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number, state = 0): void {
  const c = makeCell(id, state);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) sim.world.setCell(x, y, z, c);
}

/** A stone island whose top is the sea's surface layer (y SEA_TOP - 1), x0..x1 x z0..z1. */
export function island(sim: Simulation, x0: number, z0: number, x1: number, z1: number): void {
  loadArea(sim, x0 - 8, z0 - 8, x1 + 8, z1 + 8);
  fill(sim, x0, SEA_TOP - 10, z0, x1, SEA_TOP - 1, z1, B.STONE);
}

/**
 * A dam on an island: a glass basin of 6 x 6 water sources, 3 deep, on (x0..x0+7, z0..z0+7) whose
 * +X wall is stone. Returns the function that breaks it (the stone wall goes).
 */
export function dam(sim: Simulation, x0: number, z0: number): () => void {
  const y0 = SEA_TOP;
  for (let x = x0; x <= x0 + 7; x++) {
    for (let z = z0; z <= z0 + 7; z++) {
      for (let y = y0; y <= y0 + 2; y++) {
        const wall = x === x0 || x === x0 + 7 || z === z0 || z === z0 + 7;
        if (wall) sim.world.setCell(x, y, z, makeCell(x === x0 + 7 ? B.STONE : B.GLASS));
        else sim.world.setCell(x, y, z, makeCell(B.WATER));
      }
    }
  }
  return () => fill(sim, x0 + 7, y0, z0 + 1, x0 + 7, y0 + 2, z0 + 6, B.AIR);
}

/** A windmill on a stone pillar at (x, SEA_TOP.., z) on an island, bearing facing +Z, glued to its hub; started. */
export function spinningWindmill(sim: Simulation, x: number, z: number): Rotor {
  const by = SEA_TOP + 5;
  fill(sim, x, SEA_TOP, z, x, by - 1, z, B.STONE);
  sim.world.setCell(x, by, z, makeCell(B.BEARING, facingState(PZ)));
  sim.world.setCell(x, by, z + 1, makeCell(B.WOOL_YELLOW));
  for (const [du, dy] of [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ] as const) {
    sim.world.setCell(x + du, by + dy, z + 1, makeCell(B.WOOL_WHITE));
    sim.world.setCell(x + 2 * du, by + 2 * dy, z + 1, makeCell(B.WOOL_RED));
    sim.world.setCell(x + 2 * du + dy, by + 2 * dy - du, z + 1, makeCell(B.WOOL_RED));
  }
  sim.worldGlue.add(x, by, z, PZ);
  const r = sim.structures.startRotor(sim.world, x, by, z);
  if (!r.ok) throw new Error('the windmill did not start');
  return r.structure;
}

/** A server-driven bot aims at a cell and right-clicks it, then the server runs one tick. */
export function useOn(h: NetHarness, ctrl: PlayerControl, x: number, y: number, z: number, gridId = 0): void {
  if (ctrl.drive !== 'server') throw new Error(`${ctrl.key} is client-driven: its client clicks (clickOn)`);
  if (!ctrl.aimAt(x, y, z, undefined, gridId)) throw new Error(`${ctrl.key} cannot aim at ${x},${y},${z}`);
  ctrl.use();
  h.ticks(1);
}

/** A client aims at a cell and right-clicks it (intents), and waits for the server's answer. */
export function clickOn(c: HeadlessClient, x: number, y: number, z: number, gridId = 0): void {
  if (!c.useOn(x, y, z, undefined, gridId)) throw new Error(`${c.key} cannot aim at ${x},${y},${z}`);
}

export interface Boat {
  helm: { x: number; y: number; z: number };
  /** World cell of boat coordinates (u across, v along, y). */
  at: (u: number, v: number, y: number) => { x: number; y: number; z: number };
}

/** Stamp the example windmill boat near the spawn (call before the first tick, like a new world). */
export function exampleBoat(sim: Simulation): Boat {
  const helm = placeExampleShip(sim);
  if (helm === null) throw new Error('no site for the example boat');
  const bow = stateFacing(cellState(sim.world.getCell(helm.x, helm.y, helm.z))) as Dir;
  return { helm, at: (u, v, y) => exampleShipCell(helm, bow, u, v, y) };
}

/**
 * A server-driven bot starts the boat's windmill (a world rotor), then assembles the boat from its
 * helm (the windmill rides along) and holds the wheel. Needs a ticking server.
 */
export function launchBoat(h: NetHarness, b: Boat, bot: PlayerControl): { ship: Ship; rotor: Rotor } {
  const sim = h.sim;
  bot.emptyHand();
  const stand = b.at(1, BEARING_V, DECK_Y);
  bot.teleport(stand.x + 0.5, DECK_Y, stand.z + 0.5);
  h.ticks(2);
  const bearing = b.at(0, BEARING_V, MAST_TOP_Y);
  useOn(h, bot, bearing.x, bearing.y, bearing.z);
  useOn(h, bot, bearing.x, bearing.y, bearing.z);
  const rotor = sim.structures.rotors().find((r) => r.parent === null && r.bearingX === bearing.x && r.bearingZ === bearing.z);
  if (rotor === undefined) throw new Error('the boat windmill did not start');
  h.ticks(20);
  const front = b.at(0, 2, DECK_Y);
  bot.teleport(front.x + 0.5, DECK_Y, front.z + 0.5);
  h.ticks(2);
  useOn(h, bot, b.helm.x, b.helm.y, b.helm.z);
  useOn(h, bot, b.helm.x, b.helm.y, b.helm.z);
  const ship = rotor.parent;
  if (!(ship instanceof Ship)) throw new Error('the boat did not assemble with its windmill');
  return { ship, rotor };
}

/** The server's pose of ship `id` at a fractional tick (lerp / slerp of the harness history), with its pivot. */
export function serverShipPose(h: NetHarness, id: number, tick: number): { pos: Vec3; rot: Quat; pivot: Vec3 } | null {
  const a = h.history.get(Math.floor(tick))?.ships.get(id);
  const b = h.history.get(Math.floor(tick) + 1)?.ships.get(id);
  if (a === undefined) return null;
  const f = tick - Math.floor(tick);
  if (b === undefined || f === 0) return { pos: { ...a.pos }, rot: { ...a.rot }, pivot: a.pivot };
  if (b.pivot.x !== a.pivot.x || b.pivot.y !== a.pivot.y || b.pivot.z !== a.pivot.z) return null;
  return {
    pos: vec3(a.pos.x + (b.pos.x - a.pos.x) * f, a.pos.y + (b.pos.y - a.pos.y) * f, a.pos.z + (b.pos.z - a.pos.z) * f),
    rot: qslerp(a.rot, b.rot, f, quat()),
    pivot: a.pivot,
  };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function quatDiff(a: Quat, b: Quat): number {
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  return Math.max(Math.abs(a.x - s * b.x), Math.abs(a.y - s * b.y), Math.abs(a.z - s * b.z), Math.abs(a.w - s * b.w));
}

/** Quantisation of a pose on the wire (Pos32 1/512 block, Rot64), with room for the lerp. */
const POSE_POS_TOL = 2 / 512;
const POSE_ROT_TOL = 2e-4;

export interface PoseStats {
  /** Frames x ships compared. */
  frames: number;
  /** Of those, within POSE_POS_TOL / POSE_ROT_TOL. */
  exact: number;
  worstPos: number;
  worstRot: number;
  /** The largest distance the server moved a ship in one tick (the scale of a lost sample's error). */
  serverStep: number;
}

/**
 * From the client's ready on, at every frame: each ship the replica holds, at renderTick, against
 * the server's pose at renderTick (the history), where the server used the pivot the replica has.
 * Frames whose renderTick is before the tick the client got the ship's spawn (seen while watching)
 * are left out: the client cannot know the poses before it (it holds the spawn's pose, section 7).
 */
export function watchShipPoses(h: NetHarness, c: HeadlessClient): PoseStats {
  const st: PoseStats = { frames: 0, exact: 0, worstPos: 0, worstRot: 0, serverStep: 0 };
  const spawnedAt = new Map<number, number>();
  const prevBatch = c.onBatch;
  c.onBatch = (b) => {
    prevBatch?.(b);
    for (const rec of b.structureSpawns) if (!spawnedAt.has(rec.id)) spawnedAt.set(rec.id, b.tick);
  };
  const prev = c.onFrame;
  const p = vec3();
  const q = quat();
  c.onFrame = (now) => {
    prev?.(now);
    const r = c.replica;
    const clock = c.net.clock;
    if (!c.ready || r === null || clock === null || !clock.isSynced) return;
    const rt = clock.renderTick;
    for (const rs of r.state.structures.values()) {
      if (!(rs.structure instanceof Ship)) continue;
      const id = rs.structure.id;
      if (rt < (spawnedAt.get(id) ?? -Infinity)) continue;
      const server = serverShipPose(h, id, rt);
      if (server === null || dist(server.pivot, rs.structure.grid.pivot) !== 0) continue;
      if (!r.shipPoseAt(id, rt, p, q)) continue;
      const a = h.history.get(Math.floor(rt))?.ships.get(id);
      const b = h.history.get(Math.floor(rt) + 1)?.ships.get(id);
      if (a !== undefined && b !== undefined) st.serverStep = Math.max(st.serverStep, dist(a.pos, b.pos));
      const dp = dist(p, server.pos);
      const dq = quatDiff(q, server.rot);
      st.frames++;
      if (dp <= POSE_POS_TOL && dq <= POSE_ROT_TOL) st.exact++;
      st.worstPos = Math.max(st.worstPos, dp);
      st.worstRot = Math.max(st.worstRot, dq);
    }
  };
  return st;
}

/** Planks in a box of a client's replica (world cells + structures), or null while a column of the box is missing there. */
export function replicaPlanks(c: HeadlessClient, box: Box): number | null {
  const r = c.replica;
  if (r === null || !c.ready) return null;
  for (let cx = box[0] >> 4; cx <= box[3] >> 4; cx++) for (let cz = box[2] >> 4; cz <= box[5] >> 4; cz++) if (!r.chunks.present(cx, cz)) return null;
  return countReplica(r.state, B.PLANKS_OAK, box);
}

export function serverPlanks(sim: Simulation, box: Box): number {
  return countServer(sim, B.PLANKS_OAK, box);
}

export type { Box };

/**
 * Run until no ship moved in the last server tick (a ship that stops gets its final pose as a
 * rest in that tick's batch, reliably). Before a full comparison on a lossy link: the newest
 * sample of a ship still moving may have been lost, and the replica's pose is then older (section 7).
 */
export function untilShipsRest(h: NetHarness, maxMs = 60_000): void {
  const poses = (): string => JSON.stringify(h.sim.structures.ships().map((s) => [s.id, s.grid.position, s.grid.rotation]));
  let last = poses();
  let tick = h.sim.ticks;
  h.runUntil(() => {
    if (h.sim.ticks === tick) return false;
    tick = h.sim.ticks;
    const now = poses();
    const still = now === last;
    last = now;
    return still;
  }, maxMs, 1);
}
