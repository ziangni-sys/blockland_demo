/**
 * The claimed aim of client-driven players (sim/interact.ts CLAIMED AIM; NETCODE section 10): their
 * hands act on the targets their client claims, never on rays of their own; a claimed cell that
 * changed is no target; two players on the same face in one tick: the second block is refused.
 * Plus the commands package 7 added to PlayerControl (closeInventory, the buttons let go at death
 * and respawn) and the view's mining / gluing.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { quadrantOctant } from '../../src/blocks/shapes';
import { NX, NZ, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import type { PlayerControl } from '../../src/sim/players';
import type { Simulation } from '../../src/sim/simulation';
import type { AimTarget } from '../../src/sim/view';
import { EventLog, FLAT_TOP, flatSim, idAt, items } from './helpers';

const T = FLAT_TOP;

/** What a client claims for face `face` of a cell: the octant hit is one behind that face (as a ray entering through it reports). */
function aim(sim: Simulation, x: number, y: number, z: number, face: Dir, gridId = 0): AimTarget {
  return { gridId, x, y, z, face, sub: quadrantOctant(face, 0), cell: sim.structures.gridById(gridId)!.getCell(x, y, z) };
}

/** A client-driven player (its client would move it; here it just stands) looking at the sky. */
function clientDriven(c: PlayerControl): PlayerControl {
  c.setDrive('client');
  c.player.input.pitch = 1.4;
  c.player.pitch = 1.4;
  return c;
}

describe('the claimed aim (client-driven players)', () => {
  it('right- and left-clicks act on the claimed targets, wherever the player looks', () => {
    const sim = flatSim({ mode: 'creative' });
    const me = clientDriven(sim.soloPlayer);
    sim.tick();
    sim.world.setCell(2, T, 0, makeCell(B.STONE));
    sim.world.setCell(-2, T, 0, makeCell(B.DIRT));
    // Looking at the sky: no ray would hit anything.
    me.claimAim(aim(sim, 2, T, 0, PY), aim(sim, -2, T, 0, PY));
    expect(me.targetCell()).toEqual({ gridId: 0, x: 2, y: T, z: 0, face: PY, octant: quadrantOctant(PY, 0) });
    expect(me.mineTargetCell()).toEqual({ gridId: 0, x: -2, y: T, z: 0, face: PY, octant: quadrantOctant(PY, 0) });
    me.hold(B.PLANKS_OAK);
    me.use();
    sim.tick();
    expect(idAt(sim.world, 2, T + 1, 0)).toBe(B.PLANKS_OAK);
    expect(me.view.target).toMatchObject({ gridId: 0, x: 2, y: T, z: 0, face: PY });
    me.attack();
    sim.tick();
    expect(idAt(sim.world, -2, T, 0)).toBe(B.AIR);
    // The mining target is gone now: no target (the next claim says what is there).
    expect(me.mineTargetCell()).toBeNull();
    // A scripted look claims what its client would claim (the rays from its eyes).
    me.lookAtCell(2, T + 1, 0, NX);
    expect(me.targetCell()).toEqual({ gridId: 0, x: 2, y: T + 1, z: 0, face: NX, octant: expect.any(Number) });
    expect(me.targetCell()!.octant & 1, 'entered through -X: a -X octant').toBe(0);
  });

  it('a claimed cell whose id changed is no target: a helm replaced by cobble is not clicked, nothing is placed against it', () => {
    const sim = flatSim({ mode: 'creative' });
    const me = clientDriven(sim.soloPlayer);
    sim.tick();
    sim.world.setCell(2, T, 0, makeCell(B.HELM, facingState(NZ)));
    me.claimAim(aim(sim, 2, T, 0, PX), null);
    sim.world.setCell(2, T, 0, makeCell(B.COBBLE));
    expect(me.targetCell()).toBeNull();
    me.hold(B.PLANKS_OAK);
    me.use();
    sim.tick();
    expect(idAt(sim.world, 3, T, 0)).toBe(B.AIR);
    expect(me.view.preview).toBeNull();
    // A state change keeps the target (the id is what the client saw).
    sim.world.setCell(2, T, 0, makeCell(B.HELM, facingState(PZ)));
    expect(me.targetCell()).toMatchObject({ x: 2 });
  });

  it('two players on the same face in one tick: the first block stands, the second is refused (位置被占) with a toast', () => {
    const sim = flatSim({ mode: 'creative' });
    const a = clientDriven(sim.soloPlayer);
    const b = clientDriven(sim.join('b'));
    sim.tick();
    sim.world.setCell(2, T, 0, makeCell(B.STONE));
    const log = new EventLog(sim);
    a.hold(B.PLANKS_OAK);
    b.hold(B.GLASS);
    a.claimAim(aim(sim, 2, T, 0, PY), null);
    b.claimAim(aim(sim, 2, T, 0, PY), null);
    a.use();
    b.use();
    sim.tick();
    expect(idAt(sim.world, 2, T + 1, 0)).toBe(B.PLANKS_OAK);
    expect(idAt(sim.world, 2, T + 2, 0)).toBe(B.AIR); // not on top of the first (server-driven rays would put it there)
    expect(log.of('toast').map((t) => [t.player, t.message.key])).toEqual([['b', 'toast.place.occupied']]);
    expect(log.of('blockPlaced').length).toBe(1);
  });

  it('two players mining the same block in one tick: it breaks once, the second click finds no target (not the block behind)', () => {
    const sim = flatSim({ mode: 'creative' });
    const a = clientDriven(sim.soloPlayer);
    const b = clientDriven(sim.join('b'));
    sim.tick();
    sim.world.setCell(2, T, 0, makeCell(B.STONE));
    a.claimAim(null, aim(sim, 2, T, 0, PY));
    b.claimAim(null, aim(sim, 2, T, 0, PY));
    a.attack();
    b.attack();
    sim.tick();
    expect(idAt(sim.world, 2, T, 0)).toBe(B.AIR);
    expect(idAt(sim.world, 2, T - 1, 0)).toBe(B.TURF);
  });

  it('pick block: the claimed use target, or the PickBlock intent\'s own target', () => {
    const sim = flatSim({ mode: 'creative' });
    const me = clientDriven(sim.soloPlayer);
    sim.tick();
    sim.world.setCell(2, T, 0, makeCell(B.BRICKS));
    sim.world.setCell(-2, T, 0, makeCell(B.GLASS));
    me.claimAim(aim(sim, 2, T, 0, PY), null);
    const inv = me.player.inventory;
    expect(me.pickBlock()).toBe(true);
    expect(inv.selectedStack()?.item).toBe(B.BRICKS);
    expect(me.pickBlock(aim(sim, -2, T, 0, PY))).toBe(true);
    expect(inv.selectedStack()?.item).toBe(B.GLASS);
    expect(me.player.input.slot).toBe(inv.selected);
    // A target whose cell changed picks nothing.
    const stale = aim(sim, 2, T, 0, PY);
    sim.world.setCell(2, T, 0, makeCell(B.STONE));
    expect(me.pickBlock(stale)).toBe(false);
  });

  it('the view publishes the cell being mined and the timed glue operation (NETCODE section 9)', () => {
    const sim = flatSim({ mode: 'survival' });
    const me = clientDriven(sim.soloPlayer);
    sim.tick();
    sim.world.setCell(2, T, 0, makeCell(B.STONE));
    me.claimAim(aim(sim, 2, T, 0, PY), aim(sim, 2, T, 0, PY));
    me.player.input.attack = true;
    me.attack();
    sim.advance(10);
    expect(me.view.mining).toEqual({ gridId: 0, x: 2, y: T, z: 0, sub: quadrantOctant(PY, 0), progress: expect.closeTo(10 / 30, 5) });
    // Claimed elsewhere: the mining stops.
    me.claimAim(null, null);
    sim.tick();
    expect(me.view.mining).toBeNull();
    me.player.input.attack = false;
    me.giveItem(I.GLUE, 2);
    me.hold(I.GLUE);
    me.claimAim(aim(sim, 2, T, 0, PY), null);
    me.player.input.use = true;
    me.use();
    sim.advance(5);
    expect(me.view.gluing).toEqual({ gridId: 0, x: 2, y: T, z: 0, face: PY, sub: 0, progress: expect.closeTo(5 / 30, 5) });
    sim.advance(25);
    expect(me.view.gluing).toBeNull();
    expect(sim.worldGlue.has(2, T, 0, PY)).toBe(true);
  });
});

describe('PlayerControl commands of package 7', () => {
  it('closeInventory: the cursor stack goes back into the inventory; what does not fit is thrown into the world', () => {
    const sim = flatSim({ mode: 'survival' });
    const me = sim.soloPlayer;
    const inv = me.player.inventory;
    inv.cursor = { item: B.GLASS, count: 10 };
    me.closeInventory();
    expect(inv.cursor).toBeNull();
    expect(inv.count(B.GLASS)).toBe(10);
    for (let i = 0; i < inv.hotbar.length; i++) inv.hotbar[i] = { item: B.STONE, count: 64 };
    for (let i = 0; i < inv.main.length; i++) inv.main[i] = { item: B.STONE, count: 64 };
    inv.cursor = { item: B.GLASS, count: 5 };
    me.closeInventory();
    expect(inv.cursor).toBeNull();
    expect(inv.count(B.GLASS)).toBe(0); // no room at all
    expect(items(sim, B.GLASS)).toEqual({ entities: 1, count: 5 });
  });
});
