/**
 * Package 7 end to end: intents of a dead player, respawning, a button held through death, opening
 * the inventory while steering (ReleaseHelm, scenario 21), and the host changing a guest's mode.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PY } from '../../src/core/dirs';
import { LINKS } from './e2e-scenes';
import { buildRaft, LAND, LAND_TOP, OWN_SEA, OWN_SEA_TOP, ownWorld } from './own-scenes';

const T = LAND_TOP;
const LINK = LINKS[1]!;

describe('package 7: dead players, respawn, the helm when the inventory opens, the host\'s mode change', () => {
  it('a dead player\'s presses are consumed; a button held through death does not mine after the respawn', async () => {
    const r = await ownWorld(LAND, 'survival', LINK.make(800));
    const { c, sim, h, ctrl } = r;
    sim.world.setCell(2, T, 0, makeCell(B.STONE));
    sim.world.setCell(-2, T, 0, makeCell(B.STONE));
    h.run(50);
    c.catchUp(sim.ticks);
    c.emptyHand();
    c.waitAck();
    // Mining, the button held...
    expect(c.aimAt(2, T, 0, PY, 0, true)).toBe(true);
    c.holdAim({ x: 2, y: T, z: 0, face: PY });
    c.pressAttack();
    h.runUntil(() => (ctrl.view.mining?.progress ?? 0) > 0.3, 3000, 1);
    // ... the player dies: no more mining, presses do nothing.
    sim.entities.damage(ctrl.player, 1000, 'test');
    expect(ctrl.player.input.attack).toBe(false);
    h.runUntil(() => c.own!.player.dead, 3000, 1);
    const offhand = ctrl.player.inventory.offhand;
    c.swapHands();
    c.waitAck();
    expect(ctrl.player.inventory.offhand).toEqual(offhand); // consumed, not carried out
    expect(c.inventory.offhand).toEqual(offhand); // the prediction snapped back at the ack
    // Respawn (same place: the spawn point is where it stands): the client never let go of the button.
    expect(c.intents!.attackHeld).toBe(true);
    c.respawn();
    c.waitAck();
    expect(ctrl.player.dead).toBe(false);
    h.run(3000);
    expect(sim.world.getCell(2, T, 0) & ID_MASK).toBe(B.STONE);
    expect(ctrl.player.input.attack).toBe(false);
    expect(h.intentStats('p')!.deadConsumed).toBe(1);
    // A new press mines again.
    c.releaseAttack();
    c.holdAim(null);
    expect(c.mine(2, T, 0, PY)).toBe(true);
  }, 60_000);

  it('the inventory opens while steering: ReleaseHelm lets go of the wheel (scenario 21), the ship stops being steered', async () => {
    const r = await ownWorld(OWN_SEA, 'survival', LINK.make(810));
    const { c, sim, h, ctrl } = r;
    const S = OWN_SEA_TOP;
    const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 14, z1: 4, y: S - 1, helm: { x: 12, z: 1, facing: NZ } });
    ctrl.teleport(12.5, S, 3.5);
    h.run(1000);
    c.emptyHand();
    expect(c.useOn(helm.x, helm.y, helm.z)).toBe(true);
    expect(c.useOn(helm.x, helm.y, helm.z)).toBe(true);
    const ship = sim.structures.ships()[0]!;
    c.input.forward = 1;
    h.run(1500);
    expect(ship.throttle).toBe(1);
    // The page opens the inventory screen: it sends ReleaseHelm (the keys stay held).
    c.releaseHelm();
    c.waitAck();
    expect(ship.helmsmanId).toBe(0);
    expect(ship.throttle).toBe(0);
    h.runUntil(() => c.own!.player.steeringShipId === 0, 2000, 1);
    c.input.forward = 0;
    expect(ctrl.player.steeringShipId).toBe(0);
  }, 60_000);

  it('the host changes a guest\'s mode: the guest\'s vitals follow, its creative palette stops working', async () => {
    const r = await ownWorld(LAND, 'creative', LINK.make(820));
    await r.h.host.control({ type: 'openRoom' });
    const g = r.h.addClient('g', LINK.make(821), { viewRadius: 2 });
    r.h.runUntil(() => g.ready && g.intents !== null, 30_000);
    const gc = r.sim.players.get('g')!;
    g.creativePick(B.LAMP, true);
    g.waitAck();
    expect(gc.player.inventory.count(B.LAMP)).toBe(64);
    r.c.hostCommand({ kind: 'setPlayerMode', entityId: gc.entityId, mode: 'survival' });
    r.c.waitAck();
    expect(gc.player.mode).toBe('survival');
    expect(r.ctrl.player.mode).toBe('creative');
    r.h.runUntil(() => g.mode === 'survival', 2000, 1);
    // The palette is creative only: neither shown nor done.
    g.creativePick(B.BRICKS, true);
    expect(g.inventory.count(B.BRICKS)).toBe(0);
    g.waitAck();
    expect(gc.player.inventory.count(B.BRICKS)).toBe(0);
  }, 60_000);
});
