/**
 * Fingerprint of explosions in worlds of full blocks: the cells, structure cells, items, ship
 * motion and the next random number after the blast. Run once on the M1 baseline (commit c20ea8e,
 * the code before Milestone 2.3) by copying this file there with a one-line test that prints the
 * result; tests/sim/explosion-fullblock.test.ts asserts the numbers it gave.
 */
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { explode } from '../../src/sim/explosion';
import type { Simulation } from '../../src/sim/simulation';
import { FLAT_TOP, SEA_TOP, fill, flatSim, seaSim } from './helpers';

function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function digest(sim: Simulation, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Record<string, number> {
  let cells = 0x811c9dc5;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells = fnv(`${x},${y},${z}:${sim.world.getCell(x, y, z)};`, cells);
  let ships = 0x811c9dc5;
  for (const s of sim.structures.all()) {
    ships = fnv(`#${s.id}:${s.removed}:${s.grid.position.x.toFixed(9)},${s.grid.position.y.toFixed(9)},${s.grid.position.z.toFixed(9)};`, ships);
    s.grid.forEachCell((x, y, z, c) => (ships = fnv(`${x},${y},${z}:${c};`, ships)));
  }
  const ents = sim.entities
    .all()
    .filter((e) => !e.removed)
    .map((e) => `${e.kind}:${e.pos.x.toFixed(9)},${e.pos.y.toFixed(9)},${e.pos.z.toFixed(9)}:${(e as unknown as { stack?: { item: number; count: number } }).stack?.item ?? ''}`)
    .sort();
  return { cells, ships, entities: fnv(ents.join('|')), entityCount: ents.length, rng: Math.floor(sim.rng.next() * 2 ** 32) };
}

export function fullBlockExplosions(): Record<string, Record<string, number>> {
  const T = FLAT_TOP;
  // A: crater in survival (drops on), with a blast crate (chain), torches and sand around.
  const a = flatSim({ seed: 77, mode: 'survival' });
  a.soloPlayer.teleport(30.5, T, 30.5);
  a.advance(3);
  a.world.setCell(3, T - 1, -5, makeCell(B.TNT));
  a.world.setCell(-2, T, -5, makeCell(B.TORCH));
  a.world.setCell(1, T, -7, makeCell(B.SAND));
  a.world.setCell(1, T + 1, -7, makeCell(B.SAND));
  fill(a.world, -4, T, -2, 4, T + 2, -2, B.OBSIDIAN);
  explode(a, 0.5, T - 2.5, -5.5, 4, null);
  const ra = digest(a, -10, T - 12, -16, 11, T + 3, 5);
  a.advance(60);
  const ra2 = digest(a, -10, T - 12, -16, 11, T + 3, 5);
  // B: a raft on the sea (planks, a torch, wool) blasted from beside, survival.
  const b = seaSim({ seed: 15, mode: 'survival', spawn: { x: 10.5, y: SEA_TOP + 20, z: 10.5 } });
  b.soloPlayer.player.flying = true;
  fill(b.world, 0, SEA_TOP - 1, 0, 3, SEA_TOP - 1, 3, B.PLANKS_OAK);
  b.world.setCell(1, SEA_TOP, 1, makeCell(B.HELM, facingState(NZ)));
  b.world.setCell(2, SEA_TOP, 2, makeCell(B.TORCH));
  b.world.setCell(3, SEA_TOP, 3, makeCell(B.WOOL_WHITE));
  const res = b.structures.assembleShip(1, SEA_TOP, 1);
  if (!res.ok) throw new Error('assembly failed');
  b.advance(20);
  explode(b, -0.5, SEA_TOP + 0.5, 1.5, 4, null);
  const rb = digest(b, -8, 18, -6, 10, SEA_TOP + 4, 10);
  b.advance(20);
  const rb2 = digest(b, -8, 18, -6, 10, SEA_TOP + 4, 10);
  return { craterNow: ra, craterLater: ra2, raftNow: rb, raftLater: rb2 };
}
