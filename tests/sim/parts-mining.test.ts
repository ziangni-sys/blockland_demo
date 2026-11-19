/**
 * Mining, pick block and the claimed aim on partial cells (docs/SHAPES.md 6.2, 6.3; P8b): the part
 * aimed at is the one containing the octant the ray hit. One part is mined at a time and drops one
 * item of its material; mining progress belongs to grid + cell + part value (the crosshair moving
 * over the part keeps it, the part changing resets it, the other part changing does not); pick
 * block takes the aimed part; blockBroken carries the removed part; a claimed target whose part
 * changed is no target. These replace the transition behaviour of 16.3 (the whole cell went, one
 * drop of the first part), which tests/sim/parts-transition.test.ts used to pin.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, withoutOctant } from '../../src/blocks/shapes';
import { PZ } from '../../src/core/dirs';
import { ItemEntity } from '../../src/entities/entity';
import { dropItemOf } from '../../src/sim/drops';
import type { Simulation } from '../../src/sim/simulation';
import type { AimTarget } from '../../src/sim/view';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, partsAt, slab, UPPER } from '../shapes';
import { EventLog, FLAT_TOP, flatSim, items } from './helpers';

const T = FLAT_TOP;
/** Planks below (the first part: it holds octant 0), stone above. */
const PLANKS_LOW = slab(B.PLANKS_OAK, LOWER);
const STONE_UP = slab(B.STONE, UPPER);
const TWO = canonCell(PLANKS_LOW, STONE_UP);
/** Octants of the cell (0, T, -2) seen from the spawn (0.5, T, 0.5) through its +Z face: 4 and 5 below, 6 and 7 above. */
const LOW_NEAR = 4;
const UP_NEAR = 6;
const UP_NEAR_EAST = 7;

function scene(mode: 'creative' | 'survival'): Simulation {
  const sim = flatSim({ mode });
  sim.world.setCell(0, T, -2, TWO);
  sim.soloPlayer.emptyHand();
  return sim;
}

describe('mining one part at a time', () => {
  it('survival: each part of a two-part cell is mined on its own, gives one item of its material, and blockBroken carries that part', () => {
    const sim = scene('survival');
    const me = sim.soloPlayer;
    const log = new EventLog(sim);
    // The first part (planks, below) first: the stone above stays and becomes the cell's only part.
    expect(me.mine(0, T, -2, undefined, 0, 400, LOW_NEAR)).toBe(true);
    expect(partsAt(sim.world, 0, T, -2)).toEqual([{ id: B.STONE, state: 0, fill: UPPER }]);
    expect(log.of('blockBroken').map((e) => e.cell)).toEqual([PLANKS_LOW]);
    // The drop starts at the removed part's DROP_POINT (the centre of its octant 0), not the cell centre
    // (one tick of its random toss, at most 1.2 blocks/s, has moved it since).
    const drop = sim.entities.all().find((e) => e instanceof ItemEntity && e.stack.item === B.PLANKS_OAK)!;
    expect(Math.abs(drop.pos.x - 0.25)).toBeLessThan(0.1);
    expect(Math.abs(drop.pos.z - -1.75)).toBeLessThan(0.1);
    expect(me.mine(0, T, -2, undefined, 0, 400, UP_NEAR)).toBe(true);
    expect(getPacked(sim.world, 0, T, -2)).toBe(0);
    expect(log.of('blockBroken').map((e) => e.cell)).toEqual([PLANKS_LOW, STONE_UP]);
    sim.advance(10);
    expect(items(sim, B.PLANKS_OAK).count).toBe(1);
    expect(items(sim, dropItemOf(STONE_UP)).count).toBe(1);
    expect(items(sim).count).toBe(2);
  });

  it('creative: a click removes only the part aimed at, and nothing drops', () => {
    const sim = scene('creative');
    const me = sim.soloPlayer;
    me.lookAtPart(0, T, -2, UP_NEAR);
    expect(me.mineTargetCell()).toMatchObject({ x: 0, y: T, z: -2, octant: UP_NEAR });
    me.attack();
    sim.tick();
    expect(getPacked(sim.world, 0, T, -2)).toBe(PLANKS_LOW);
    sim.advance(5);
    expect(items(sim).count).toBe(0);
  });

  it('survival progress: kept while the crosshair moves over the same part or the other part changes; reset when the part itself changes', () => {
    const sim = scene('survival');
    const me = sim.soloPlayer;
    const input = me.player.input;
    // Stone: hardness 1.5 s = 30 ticks.
    me.lookAtPart(0, T, -2, UP_NEAR);
    input.attack = true;
    me.attack();
    sim.advance(10);
    expect(me.view.mining).toEqual({ gridId: 0, x: 0, y: T, z: -2, sub: UP_NEAR, progress: expect.closeTo(10 / 30, 6) });
    // Another octant of the same part: the same mining (sub stays the octant first hit).
    me.lookAtPart(0, T, -2, UP_NEAR_EAST);
    expect(me.mineTargetCell()).toMatchObject({ octant: UP_NEAR_EAST });
    sim.advance(5);
    expect(me.view.mining).toEqual({ gridId: 0, x: 0, y: T, z: -2, sub: UP_NEAR, progress: expect.closeTo(15 / 30, 6) });
    // Someone chisels the OTHER part (the planks lose octant 0): the progress goes on.
    sim.world.setCell(0, T, -2, withoutOctant(getPacked(sim.world, 0, T, -2), 0));
    sim.advance(5);
    expect(me.view.mining!.progress).toBeCloseTo(20 / 30, 6);
    // Someone chisels THIS part (octant 6 of the stone): its value changed, the mining starts over.
    sim.world.setCell(0, T, -2, withoutOctant(getPacked(sim.world, 0, T, -2), UP_NEAR));
    sim.tick();
    expect(me.view.mining).toEqual({ gridId: 0, x: 0, y: T, z: -2, sub: UP_NEAR_EAST, progress: expect.closeTo(1 / 30, 6) });
    // The time is the material's hardness, however much of the part is left.
    sim.advance(28);
    expect(partsAt(sim.world, 0, T, -2).map((p) => p.id)).toEqual([B.PLANKS_OAK, B.STONE]);
    sim.tick();
    expect(partsAt(sim.world, 0, T, -2).map((p) => p.id)).toEqual([B.PLANKS_OAK]);
    input.attack = false;
  });

  it('survival: the time is the hardness of the part aimed at, not of the cell\'s first part', () => {
    const sim = flatSim({ mode: 'survival' });
    const me = sim.soloPlayer;
    // Planks below (1.5 s = 30 ticks: the first part), bricks above (2 s = 40 ticks).
    sim.world.setCell(0, T, -2, canonCell(PLANKS_LOW, slab(B.BRICKS, UPPER)));
    me.emptyHand();
    me.lookAtPart(0, T, -2, UP_NEAR);
    me.player.input.attack = true;
    me.attack();
    sim.advance(39);
    expect(partsAt(sim.world, 0, T, -2).map((p) => p.id)).toEqual([B.PLANKS_OAK, B.BRICKS]);
    sim.tick();
    expect(partsAt(sim.world, 0, T, -2).map((p) => p.id)).toEqual([B.PLANKS_OAK]);
    me.player.input.attack = false;
  });

  it('a full block mined in survival reports and drops exactly as before', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, T, -2, makeCell(B.PLANKS_OAK));
    const log = new EventLog(sim);
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.mine(0, T, -2, PZ)).toBe(true);
    expect(log.of('blockBroken').map((e) => e.cell)).toEqual([makeCell(B.PLANKS_OAK)]);
    sim.advance(5);
    expect(items(sim, B.PLANKS_OAK).count).toBe(1);
  });
});

describe('pick block takes the part aimed at', () => {
  it('the stone of the upper half, the planks of the lower half', () => {
    const sim = scene('creative');
    const me = sim.soloPlayer;
    me.lookAtPart(0, T, -2, UP_NEAR);
    expect(me.pickBlock()).toBe(true);
    expect(me.player.inventory.selectedStack()?.item).toBe(B.STONE);
    me.lookAtPart(0, T, -2, LOW_NEAR);
    expect(me.pickBlock()).toBe(true);
    expect(me.player.inventory.selectedStack()?.item).toBe(B.PLANKS_OAK);
  });
});

describe('the claimed aim of a partial cell (client-driven players)', () => {
  function clientDriven(sim: Simulation): void {
    const me = sim.soloPlayer;
    me.setDrive('client');
    me.player.input.pitch = 1.4; // looking at the sky: no ray of its own would hit anything
    me.player.pitch = 1.4;
    sim.tick();
  }
  const claim = (sub: number, cell = TWO): AimTarget => ({ gridId: 0, x: 0, y: T, z: -2, face: PZ, sub, cell });

  it('resolve: the claimed octant, the cell as it is now (packed), the part at that octant, the octant centre as the point', () => {
    const sim = scene('creative');
    clientDriven(sim);
    const me = sim.soloPlayer;
    me.claimAim(claim(UP_NEAR), claim(LOW_NEAR));
    const h = me.hands.raycast()!;
    expect({ ...h, grid: h.grid.gridId }).toEqual({
      grid: 0,
      x: 0,
      y: T,
      z: -2,
      face: PZ,
      octant: UP_NEAR,
      cell: TWO,
      part: STONE_UP,
      dist: 0,
      point: { x: 0.25, y: T + 0.75, z: -1.25 },
    });
    const m = me.hands.raycastMining()!;
    expect([m.octant, m.part, m.cell]).toEqual([LOW_NEAR, PLANKS_LOW, TWO]);
    expect(m.point).toEqual({ x: 0.25, y: T + 0.25, z: -1.25 });
  });

  it('a claimed part replaced meanwhile (or gone) is no target; a change of the other part, or of other octants of this part, is not', () => {
    const sim = scene('creative');
    clientDriven(sim);
    const me = sim.soloPlayer;
    me.claimAim(claim(UP_NEAR), claim(UP_NEAR));
    // The other part changed (planks chiselled): still the stone the client saw.
    sim.world.setCell(0, T, -2, withoutOctant(TWO, 0));
    expect(me.targetCell()).toMatchObject({ x: 0, y: T, z: -2, octant: UP_NEAR });
    // Another octant of the stone chiselled away: still stone at octant 6.
    sim.world.setCell(0, T, -2, withoutOctant(withoutOctant(TWO, 0), UP_NEAR_EAST));
    expect(me.targetCell()).toMatchObject({ octant: UP_NEAR });
    // The stone replaced by glass: no target, and a click mines nothing.
    sim.world.setCell(0, T, -2, canonCell(PLANKS_LOW, slab(B.GLASS, UPPER)));
    expect(me.targetCell()).toBeNull();
    expect(me.mineTargetCell()).toBeNull();
    me.attack();
    sim.tick();
    expect(getPacked(sim.world, 0, T, -2)).toBe(canonCell(PLANKS_LOW, slab(B.GLASS, UPPER)));
    // The upper half gone: the claimed octant is empty, no target.
    sim.world.setCell(0, T, -2, PLANKS_LOW);
    expect(me.mineTargetCell()).toBeNull();
    // The planks the client claims at octant 4 still stand: mined.
    me.claimAim(null, claim(LOW_NEAR));
    me.attack();
    sim.tick();
    expect(getPacked(sim.world, 0, T, -2)).toBe(0);
  });

  it('a claim with an octant outside 0..7 is no target: an Attack on a two-part cell mines nothing and the tick does not throw', () => {
    const sim = scene('creative');
    clientDriven(sim);
    const me = sim.soloPlayer;
    // Octant 8 would read bit 8 of the holes field, the cell's two-part flag (the codec refuses
    // it from the network; a script's claim reaches resolve directly).
    for (const sub of [8, -1, 2.5]) {
      me.claimAim(claim(sub), claim(sub));
      expect(me.targetCell()).toBeNull();
      expect(me.mineTargetCell()).toBeNull();
      me.attack();
      expect(() => sim.tick()).not.toThrow();
      expect(getPacked(sim.world, 0, T, -2)).toBe(TWO);
    }
  });
});
