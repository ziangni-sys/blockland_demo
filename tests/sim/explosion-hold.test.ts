/**
 * World water in a ship's dry hold does not stop blast rays (docs/SHAPES.md 9.4, last bullet, and
 * 19.8). A sealed hold below the waterline: the cells the hull vacated in the world were refilled
 * with sea water at assembly, and one tick later the ship's hull analysis is current, so the hold
 * is known to be dry. A ray's point is "displaced" where it is in a hard octant of the ship or in
 * the dry hold at floor(2 * local), whatever else the ship's cell holds; there the world water
 * costs nothing.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { LIQUID } from '../../src/blocks/registry';
import { NZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import { explode } from '../../src/sim/explosion';
import type { Simulation } from '../../src/sim/simulation';
import { isDryHalf } from '../../src/structures/hull';
import type { Ship } from '../../src/structures/structure';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, slab } from '../shapes';
import { SEA_TOP, fill, seaSim } from './helpers';

/** Bottom of the hull: its floor, a one-high hold above it, the deck above that, all under water. */
const Y0 = SEA_TOP - 4;

/**
 * A 9 x 3 x 5 plank hull with a sealed 7 x 1 x 3 hold (x 1..7, y Y0 + 1, z 1..3); `inHold` puts
 * blocks into the hold before assembly. Returns the sim and the ship one tick after assembly.
 */
function holdShip(inHold: (sim: Simulation) => void): { sim: Simulation; ship: Ship } {
  const sim = seaSim({ seed: 11, mode: 'creative', spawn: { x: 10.5, y: SEA_TOP + 20, z: 10.5 } });
  sim.soloPlayer.player.flying = true;
  sim.advance(2);
  const w = sim.world;
  fill(w, 0, Y0, 0, 8, Y0 + 2, 4, B.PLANKS_OAK);
  fill(w, 1, Y0 + 1, 1, 7, Y0 + 1, 3, B.AIR);
  w.setCell(4, Y0 + 3, 2, makeCell(B.HELM, facingState(NZ)));
  inHold(sim);
  const res = sim.structures.assembleShip(4, Y0 + 3, 2);
  if (!res.ok) throw new Error(`assembly failed: ${JSON.stringify(res)}`);
  sim.advance(1);
  const ship = res.structure;
  expect(ship.hull !== null && ship.hull.version === ship.grid.version, 'the hull analysis is current').toBe(true);
  return { sim, ship };
}

/** World point of a ship-local point; checks that it is in world water and in the dry hold. */
function dryWaterPoint(sim: Simulation, ship: Ship, lx: number, ly: number, lz: number): Vec3 {
  const p = vec3();
  ship.grid.toWorld(vec3(lx, ly, lz), p);
  const wc = sim.world.getCell(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  expect(LIQUID[wc & ID_MASK], 'the world holds sea water at the point').toBe(1);
  const l = vec3();
  ship.grid.toLocal(p, l);
  expect(isDryHalf(ship.hull!, Math.floor(l.x * 2), Math.floor(l.y * 2), Math.floor(l.z * 2)), 'the point is in the dry hold').toBe(true);
  return p;
}

/** Ship cells (packed contents) by local position. */
function cells(ship: Ship): Map<string, number> {
  const out = new Map<string, number>();
  if (!ship.removed) ship.grid.forEachCell((x, y, z, c) => out.set(`${x},${y},${z}`, c));
  return out;
}

describe('a blast in the dry hold of a ship below the waterline', () => {
  it('reaches the hull: the world water refilled into the hold does not stop the rays', () => {
    const { sim, ship } = holdShip(() => {});
    const before = ship.grid.count;
    const p = dryWaterPoint(sim, ship, 2.5, Y0 + 1.5, 2.5);
    explode(sim, p.x, p.y, p.z, 2, null);
    expect(before - (ship.removed ? 0 : ship.grid.count), 'hull cells removed').toBeGreaterThan(8);
  });

  it('blows the torches standing in the hold (a whole-cell block with no hard octant: the dry hold is asked there too)', () => {
    const { sim, ship } = holdShip((s) => {
      for (let z = 1; z <= 3; z++) s.world.setCell(4, Y0 + 1, z, makeCell(B.TORCH));
    });
    for (let z = 1; z <= 3; z++) expect(ship.grid.getCell(4, Y0 + 1, z), 'the torches came along').toBe(makeCell(B.TORCH));
    const p = dryWaterPoint(sim, ship, 2.5, Y0 + 1.5, 2.5);
    explode(sim, p.x, p.y, p.z, 2, null);
    for (let z = 1; z <= 3; z++) expect(ship.grid.getCell(4, Y0 + 1, z), `torch at z ${z}`).toBe(0);
  });

  it('started in the dry upper half of a lower slab standing in the hold, does damage (the hold is asked at the point\'s octant)', () => {
    const { sim, ship } = holdShip((s) => s.world.setCell(6, Y0 + 1, 2, slab(B.PLANKS_OAK, LOWER)));
    expect(getPacked(ship.grid, 6, Y0 + 1, 2), 'the slab came along').toBe(slab(B.PLANKS_OAK, LOWER));
    const before = cells(ship);
    const p = dryWaterPoint(sim, ship, 6.5, Y0 + 1.75, 2.5);
    explode(sim, p.x, p.y, p.z, 1.5, null);
    const after = cells(ship);
    const changed = [...before].filter(([k, c]) => after.get(k) !== c).map(([k]) => k);
    expect(changed, 'the slab and the hull around it').toContain(`6,${Y0 + 1},2`);
    expect(changed.length).toBeGreaterThan(3);
  });
});
