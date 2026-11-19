/**
 * Acceptance scenario 43, the floating and draught part (docs/ACCEPTANCE.md "形状与凿子"; docs/SHAPES.md
 * 12.5, 16.4: package P9), headless, whole simulation, in both modes: a ship built of slabs and
 * stairs floats upright at the draught its volume predicts, sails, and settles again at that draught.
 * The assembly, docking and turning part of the scenario belongs to package P7 (g8-shapes-stick);
 * this file asserts only what the ship physics is responsible for.
 *
 * The scene is written on the server (w.sim): the tools that make partial blocks come in M2.4. The
 * player assembles the raft at its helm (two right-clicks), sails it with W, and lets go.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS } from '../../src/blocks/registry';
import { NX, PX, PZ } from '../../src/core/dirs';
import { HULL_MIXED, hullKindAt } from '../../src/structures/hull';
import type { Ship } from '../../src/structures/structure';
import { LOWER, slab, stairFill } from '../shapes';
import { HELM_N, onlyShip, SEA_TOP, seaWorld, SURFACE, tiltDeg } from './g2-assemble-dock-helpers';
import type { TestWorld } from './world';

/** The raft lies in the top layer of the sea. */
const DECK = SEA_TOP - 1;

/**
 * A 5 x 6 raft (x 0..4, z 0..5) at y = DECK: lower planks slabs, stairs of planks rising outward
 * along both long sides, full planks on the bow and stern rows (z = 0 and 5; the player stands on
 * the stern) and under the helm, which faces north at (2, SEA_TOP, 4). Every cell has its lower
 * half full, so up to half a cell of draught the waterplane is the whole 30-cell footprint.
 */
function slabRaft(): TestWorld {
  const w = seaWorld({ spawn: { x: 2.5, y: SEA_TOP, z: 5.5 } });
  const { sim, me } = w;
  for (let z = 0; z <= 5; z++) {
    for (let x = 0; x <= 4; x++) {
      let c = slab(B.PLANKS_OAK, LOWER);
      if (z === 0 || z === 5 || (x === 2 && z === 4)) c = makeCell(B.PLANKS_OAK);
      else if (x === 0 || x === 4) c = slab(B.PLANKS_OAK, stairFill(x === 0 ? NX : PX));
      sim.world.setCell(x, DECK, z, c);
    }
  }
  sim.world.setCell(2, SEA_TOP, 4, HELM_N);
  w.tick(10); // chunks around the scene load
  me.emptyHand();
  return w;
}

/** Volume (cells) of the raft's planks: 11 full blocks, 8 stairs (6/8), 11 lower slabs (4/8). */
const PLANKS_VOLUME = 11 + 8 * 0.75 + 11 * 0.5;
const MASS = PLANKS_VOLUME * BLOCKS[B.PLANKS_OAK]!.density + BLOCKS[B.HELM]!.density;
/** Archimedes with the whole footprint as waterplane (the draught stays below half a cell). */
const DRAUGHT = MASS / 30;

/** The player assembles the raft at its helm: preview, then assemble (takes the wheel). */
function assemble(w: TestWorld): Ship {
  expect(w.me.useOn(2, SEA_TOP, 4, PZ)).toBe(true);
  expect(w.me.useOn(2, SEA_TOP, 4, PZ)).toBe(true);
  return onlyShip(w.sim);
}

/** Draught at the middle of the footprint: the water surface minus the world y of the raft's bottom there. */
function draughtOf(ship: Ship): number {
  return SURFACE - ship.grid.toWorld({ x: 2.5, y: DECK, z: 3 }).y;
}

describe('43. 用半砖和楼梯造的船能漂浮，吃水符合体积（船体物理部分）。', () => {
  it('the slab-and-stair raft the player assembled is analysed by volume: half cells of planks, mixed cells', () => {
    const w = slabRaft();
    const ship = assemble(w);
    expect(ship.grid.count).toBe(31);
    const h = ship.hull!;
    expect(h).not.toBeNull();
    expect(ship.mass).toBeCloseTo(MASS, 9);
    // the planks' volume plus the helm (a hard model block: a full cell)
    expect(h.solidVolume).toBe(PLANKS_VOLUME + 1);
    expect(hullKindAt(h, 1, DECK, 1)).toBe(HULL_MIXED);
    expect(h.floats).toBe(true);
  });

  it('漂浮，吃水符合体积: it floats upright at the draught of its volume (within 3 %), steady for hundreds of ticks', () => {
    const w = slabRaft();
    const ship = assemble(w);
    w.me.use(); // let go of the wheel
    w.tick(80); // settle
    let minD = Infinity;
    let maxD = -Infinity;
    let maxTilt = 0;
    for (let t = 0; t < 200; t++) {
      w.tick();
      const d = draughtOf(ship);
      minD = Math.min(minD, d);
      maxD = Math.max(maxD, d);
      maxTilt = Math.max(maxTilt, tiltDeg(ship));
    }
    expect(DRAUGHT).toBeLessThan(0.5);
    expect(Math.abs((minD + maxD) / 2 - DRAUGHT) / DRAUGHT).toBeLessThan(0.03);
    expect(maxD - minD).toBeLessThan(0.02);
    expect(maxTilt).toBeLessThan(2);
    expect(ship.removed).toBe(false);
  });

  it('it sails: W at the wheel drives it north, and after the player lets go it settles at the same draught', () => {
    const w = slabRaft();
    const ship = assemble(w);
    w.tick(40);
    const z0 = ship.grid.position.z;
    w.me.input.forward = 1;
    w.tick(160);
    w.me.input.forward = 0;
    expect(z0 - ship.grid.position.z).toBeGreaterThan(4);
    expect(tiltDeg(ship)).toBeLessThan(5);
    w.me.use(); // let go of the wheel
    w.tick(200);
    expect(Math.abs(draughtOf(ship) - DRAUGHT) / DRAUGHT).toBeLessThan(0.03);
    expect(tiltDeg(ship)).toBeLessThan(2);
  });
});
