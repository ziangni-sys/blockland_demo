/**
 * Package 7 end to end, every row of section 10's intent table on the 150 ms link (20 ms jitter, 5%
 * loss): what the client shows at once (the outline, the predicted inventory) and what only the
 * server's answer shows (the world, corrections, the drop of a thrown stack, the subscription,
 * host commands).
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PY } from '../../src/core/dirs';
import { CHUNK_SHIFT, DAY_TICKS } from '../../src/core/constants';
import { mod } from '../../src/core/math';
import { ItemEntity } from '../../src/entities/entity';
import type { Inventory } from '../../src/entities/inventory';
import type { NetInventory } from '../../src/net/protocol';
import { LINKS } from './e2e-scenes';
import type { HeadlessClient } from './harness';
import { inventoryOf } from './intent-scenes';
import { buildRaft, LAND, LAND_TOP, OWN_SEA, OWN_SEA_TOP, ownWorld, type OwnRun } from './own-scenes';

const T = LAND_TOP;
const LINK = LINKS[1]!;

function shown(c: HeadlessClient): NetInventory {
  const inv: Inventory = c.inventory;
  const copy = (s: { item: number; count: number } | null): { item: number; count: number } | null => (s === null ? null : { item: s.item, count: s.count });
  return { selected: inv.selected, hotbar: inv.hotbar.map(copy), main: inv.main.map(copy), offhand: copy(inv.offhand), cursor: copy(inv.cursor) };
}

function server(r: OwnRun): NetInventory {
  return inventoryOf(r.ctrl);
}

/** Do `act` on the client: it shows `expect` at once (before the server can know), and the server ends with the same. */
function predicted(r: OwnRun, act: () => void, check: (inv: NetInventory) => void): void {
  const before = server(r);
  act();
  const at = shown(r.c);
  check(at);
  expect(server(r)).toEqual(before); // nothing reached the server yet
  r.c.waitAck();
  expect(server(r)).toEqual(at);
  expect(shown(r.c)).toEqual(at);
}

describe('package 7: every intent of the table, before and after the server\'s answer (150 ms)', () => {
  it('Aim, Use, UseRelease, Attack, AttackRelease: the outline at once; the world only with the server\'s batch', async () => {
    const r = await ownWorld(LAND, 'creative', LINK.make(1));
    const { c, sim, ctrl, h } = r;
    sim.world.setCell(2, T, 0, makeCell(B.BRICKS));
    h.run(500);
    // Aim: the client's target is there at once; the server claims it a link later.
    expect(c.aimAt(2, T - 1, 1, PY)).toBe(true);
    expect(c.target).toMatchObject({ gridId: 0, x: 2, y: T - 1, z: 1, face: PY, cell: sim.world.getCell(2, T - 1, 1) });
    expect(ctrl.targetCell()).not.toMatchObject({ x: 2, z: 1 });
    h.runUntil(() => ctrl.targetCell()?.z === 1, 2000, 1);
    expect(ctrl.targetCell()).toMatchObject({ gridId: 0, x: 2, y: T - 1, z: 1, face: PY });
    // Use (press) and UseRelease: the block appears on the client only when the batch does.
    c.hold(B.COBBLE);
    c.waitLook();
    c.pressUse();
    expect(c.replica!.world.getCell(2, T, 1) & ID_MASK).toBe(B.AIR);
    h.runUntil(() => (sim.world.getCell(2, T, 1) & ID_MASK) === B.COBBLE, 2000, 1);
    expect(ctrl.player.input.use).toBe(true);
    expect(c.replica!.world.getCell(2, T, 1) & ID_MASK).toBe(B.AIR); // the batch is on its way
    c.waitAck();
    expect(c.replica!.world.getCell(2, T, 1) & ID_MASK).toBe(B.COBBLE);
    c.releaseUse();
    c.waitAck();
    expect(ctrl.player.input.use).toBe(false);
    // Attack (press) and AttackRelease: the bricks go on the client only with the batch.
    expect(c.aimAt(2, T, 0, PY, 0, true)).toBe(true);
    c.pressAttack();
    expect(c.replica!.world.getCell(2, T, 0) & ID_MASK).toBe(B.BRICKS);
    h.runUntil(() => (sim.world.getCell(2, T, 0) & ID_MASK) === B.AIR, 2000, 1);
    expect(ctrl.player.input.attack).toBe(true);
    c.waitAck();
    expect(c.replica!.world.getCell(2, T, 0) & ID_MASK).toBe(B.AIR);
    c.releaseAttack();
    c.waitAck();
    expect(ctrl.player.input.attack).toBe(false);
  }, 60_000);

  it('SwapHands, SelectSlot, PickBlock, InvClick, CreativePick, CloseInventory, DropCursor: shown at once, the server\'s result after the ack', async () => {
    const r = await ownWorld(LAND, 'creative', LINK.make(2));
    const { c, sim, h } = r;
    sim.world.setCell(2, T, 0, makeCell(B.LAMP));
    r.ctrl.giveItem(B.PLANKS_OAK, 64);
    r.ctrl.giveItem(I.GLUE, 4);
    h.run(500);
    const glue = c.inventory.hotbar.findIndex((s) => s?.item === I.GLUE);
    const glueStack = { ...c.inventory.hotbar[glue]! };
    predicted(r, () => c.selectSlot(glue), (inv) => expect(inv.selected).toBe(glue));
    predicted(r, () => c.swapHands(), (inv) => expect(inv.offhand).toEqual(glueStack));
    expect(c.aimAt(2, T, 0, PY)).toBe(true);
    predicted(r, () => expect(c.pickBlock()).toBe(true), (inv) => expect(inv.hotbar[inv.selected]).toEqual({ item: B.LAMP, count: 64 }));
    predicted(r, () => c.invClick('hotbar', 0, 2, false), (inv) => expect(inv.cursor).toEqual({ item: B.PLANKS_OAK, count: 32 }));
    predicted(r, () => c.closeInventory(), (inv) => expect(inv.cursor).toBeNull());
    predicted(r, () => c.creativePick(B.BRICKS, false), (inv) => expect(inv.cursor).toEqual({ item: B.BRICKS, count: 64 }));
    // DropCursor: the cursor empties at once; the thrown stack appears with the server's batch.
    const drops = (): number => [...c.replica!.state.entities.values()].filter((e) => e.kind === 'item' && e.item === B.BRICKS).length;
    predicted(r, () => c.dropCursor(), (inv) => expect(inv.cursor).toBeNull());
    expect(sim.entities.all().some((e) => e instanceof ItemEntity && e.stack.item === B.BRICKS && !e.removed)).toBe(true);
    h.runUntil(() => drops() === 1, 2000, 1);
  }, 60_000);

  it('ReleaseHelm and Respawn: not predicted, the server\'s correction moves the player', async () => {
    const r = await ownWorld(OWN_SEA, 'survival', LINK.make(3));
    const { c, sim, h, ctrl } = r;
    const S = OWN_SEA_TOP;
    const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 14, z1: 4, y: S - 1, helm: { x: 12, z: 1, facing: NZ } });
    ctrl.teleport(12.5, S, 3.5);
    h.run(1000);
    c.emptyHand();
    expect(c.useOn(helm.x, helm.y, helm.z)).toBe(true);
    expect(c.useOn(helm.x, helm.y, helm.z)).toBe(true);
    const ship = sim.structures.ships()[0]!;
    h.runUntil(() => c.own!.player.steeringShipId === ship.id, 2000, 1);
    // ReleaseHelm (the inventory screen opens while steering): the seat is the server's to give up.
    c.releaseHelm();
    expect(c.own!.player.steeringShipId).toBe(ship.id);
    c.waitAck();
    expect(ctrl.player.steeringShipId).toBe(0);
    h.runUntil(() => c.own!.player.steeringShipId === 0, 2000, 1);
    expect(c.correctionsSince(0).at(-1)).toBe('unseat:stopped');
    // Respawn: only the server moves the player to its spawn point.
    sim.entities.damage(ctrl.player, 1000, 'test');
    h.runUntil(() => c.own!.player.dead, 2000, 1);
    c.respawn();
    expect(c.own!.player.dead).toBe(true);
    c.waitAck();
    h.runUntil(() => !c.own!.player.dead && c.correctionsSince(0).at(-1) === 'respawn', 3000, 1);
    expect(ctrl.player.dead).toBe(false);
  }, 60_000);

  it('SetViewRadius: the subscription and the simulation radius follow; HostCommand: every kind from the host', async () => {
    const r = await ownWorld(LAND, 'creative', LINK.make(4), undefined, 2);
    const { c, sim, h, ctrl } = r;
    const far = (): boolean => {
      const p = ctrl.player.pos;
      return c.replica!.chunks.has((Math.floor(p.x) >> CHUNK_SHIFT) + 4, Math.floor(p.z) >> CHUNK_SHIFT);
    };
    expect(far()).toBe(false);
    c.setViewRadius(5);
    c.waitAck();
    expect(ctrl.viewRadius).toBe(5);
    h.runUntil(far, 5000, 5);
    // Host commands.
    c.hostCommand({ kind: 'setRules', rules: { defaultMode: 'survival', dropsEnabled: true } });
    c.hostCommand({ kind: 'setDayTime', t: 0.5 });
    c.waitAck();
    expect(sim.rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    expect(c.state!.rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    expect(c.state!.dayOffset).toBe(sim.dayOffset);
    // LESSONS 天空的昼夜和游戏时间不一致: the client's time of day is the server's at its renderTick, which is
    // D ticks behind its arrival time (itself a one-way delay, under 2 ticks here, behind the server).
    h.run(200);
    const behind = mod(sim.dayTime - c.replica!.dayTime, 1) * DAY_TICKS;
    expect(behind).toBeLessThanOrEqual(c.net.clock!.D + 3);
    expect(c.replica!.dayTime).toBeCloseTo(mod(c.net.clock!.renderTick + sim.dayOffset, DAY_TICKS) / DAY_TICKS, 9);
    c.setMode('survival');
    expect(ctrl.player.mode).toBe('survival');
    h.runUntil(() => c.mode === 'survival', 1000, 1);
    c.give(B.SANDSTONE, 7);
    expect(ctrl.player.inventory.count(B.SANDSTONE)).toBe(7);
    expect(c.inventory.count(B.SANDSTONE)).toBe(7);
    c.teleport(20.5, T, 20.5);
    expect(ctrl.player.pos).toMatchObject({ x: 20.5, z: 20.5 });
    expect(c.own!.player.pos.x).toBeCloseTo(20.5, 6);
    c.hostCommand({ kind: 'kick', entityId: ctrl.entityId }); // package 11: nothing yet
    c.waitAck();
    expect(c.ready).toBe(true);
  }, 60_000);

  it('a guest\'s host commands are refused with a toast; the world does not change', async () => {
    const r = await ownWorld(LAND, 'creative', LINK.make(5));
    await r.h.host.control({ type: 'openRoom' });
    const g = r.h.addClient('g', LINK.make(6), { viewRadius: 2 });
    r.h.runUntil(() => g.ready && g.intents !== null, 30_000);
    const toasts: string[] = [];
    g.onBatch = (b) => {
      for (const e of b.private?.events ?? []) if (e.type === 'toast') toasts.push(e.message.key);
    };
    g.hostCommand({ kind: 'setPlayerMode', entityId: 0, mode: 'survival' });
    g.hostCommand({ kind: 'teleport', x: 30.5, y: T, z: 30.5 });
    g.hostCommand({ kind: 'give', item: B.LAMP, count: 3 });
    g.waitAck();
    expect(toasts).toEqual(['toast.host.only', 'toast.host.only', 'toast.host.only']);
    const gc = r.sim.players.get('g')!;
    expect(gc.player.mode).toBe('creative');
    expect(gc.player.inventory.count(B.LAMP)).toBe(0);
    expect(gc.player.pos.x).not.toBe(30.5);
    expect(r.h.intentStats('g')!.hostRefused).toBe(3);
  }, 60_000);
});
