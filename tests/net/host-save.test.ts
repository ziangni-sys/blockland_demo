/**
 * Package 8: saving on the host (NETCODE section 12, scenario 36's server side, LESSONS
 * "保存失败仍然退出"): players by key (online and offline), world rules, structures and the
 * generator survive a save and load; the host's client joins a loaded world before its first tick
 * and a guest after it; a failed save never stops the server, and shutdown { save: true } closes
 * only after a successful save; saves are serialized and coalesced; load errors are reported.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PZ } from '../../src/core/dirs';
import { GENERATOR_BLOB } from '../../src/net/host/host';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';
import { MemoryStorage, SaveStorageError } from '../../src/save/storage';
import { Ship } from '../../src/structures/structure';
import type { GeneratorSpec } from '../../src/worldgen/generator';
import { FLAT, NetHarness, testMeta } from './harness';

/** A MemoryStorage whose writes fail while `fail` is set; counts the writes. */
class FlakyStorage extends MemoryStorage {
  fail: SaveStorageError | null = null;
  writes = 0;
  override async putAll(...args: Parameters<MemoryStorage['putAll']>): Promise<void> {
    this.writes++;
    await new Promise((r) => setTimeout(r, 1));
    if (this.fail !== null) throw this.fail;
    return super.putAll(...args);
  }
}

const SPEC: GeneratorSpec = { kind: 'flat', seed: 11, layers: [{ cell: B.STONE, thickness: 5 }] };

/** A world with a raft: `a` holds its wheel, `b` left earlier, survival rules. */
async function savedWorld(): Promise<{ storage: MemoryStorage; shipId: number; aPos: { x: number; y: number; z: number } }> {
  const h = new NetHarness();
  await h.create(testMeta('w', 'creative'), { generator: SPEC, exampleShip: false });
  const a = h.addClient('a', {}, { local: true });
  h.run(200);
  h.host.setRoomOpen(true);
  const b = h.addClient('b');
  h.run(200);
  const sim = h.sim;
  sim.players.get('b')!.teleport(10.5, 5, 10.5);
  sim.players.get('b')!.giveItem(B.GLASS, 5);
  h.run(100);
  b.leave();
  h.run(100);
  sim.setRules({ defaultMode: 'survival', dropsEnabled: true });
  const ctrl = sim.players.get('a')!;
  ctrl.giveItem(B.GLASS, 7);
  for (let x = 0; x <= 2; x++) for (let z = 0; z <= 3; z++) sim.world.setCell(x, 5, z, makeCell(B.PLANKS_OAK));
  sim.world.setCell(1, 6, 1, makeCell(B.HELM, facingState(NZ)));
  ctrl.teleport(1.5, 6, 3.5);
  h.run(200);
  a.emptyHand();
  for (let i = 0; i < 2; i++) expect(a.useOn(1, 6, 1, PZ)).toBe(true);
  const ship = sim.structures.ships()[0] as Ship;
  expect(ship.helmsmanId).toBe(ctrl.entityId);
  h.run(200);
  const p = ctrl.player.pos;
  const aPos = { x: p.x, y: p.y, z: p.z };
  expect(await h.host.shutdown(true)).toBe(true);
  h.run(10);
  expect(a.kick?.reason).toBe('shutdown');
  expect(h.reports.at(-1)).toEqual({ type: 'closed' });
  return { storage: h.storage as MemoryStorage, shipId: ship.id, aPos };
}

describe('saving on the host (package 8)', () => {
  it('a save holds every player by key, the world rules, the structures and the generator; the host joins before the first tick and carries on at the wheel', async () => {
    const { storage, shipId, aPos } = await savedWorld();
    const meta = (await storage.getMeta('w'))!;
    expect(meta.mode).toBe('survival'); // WorldMeta.mode = the world's default mode
    expect(meta.version).toBe(SAVE_VERSION);
    expect(await storage.getBlob('w', GENERATOR_BLOB)).not.toBeNull();
    const h = new NetHarness({ storage });
    await h.load('w');
    expect(h.reports[0]).toMatchObject({ type: 'ready', meta: { id: 'w' }, persistent: true, reason: null });
    expect(h.sim.players.keys()).toEqual(['a', 'b']);
    expect(h.sim.rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    const t0 = h.sim.ticks;
    const a = h.addClient('a', {}, { local: true });
    h.run(1);
    expect(h.sim.ticks).toBe(t0 + 1); // the clock started with the Hello: a joined in the first tick
    expect(a.welcome!.generator).toEqual(SPEC);
    expect(a.welcome!.rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    const ctrl = h.sim.players.get('a')!;
    const ship = h.sim.structures.get(shipId);
    expect(ship).toBeInstanceOf(Ship);
    expect(ctrl.player.steeringShipId).toBe(shipId);
    expect((ship as Ship).helmsmanId).toBe(ctrl.entityId);
    expect(ctrl.player.pos.x).toBeCloseTo(aPos.x, 3);
    expect(ctrl.player.pos.z).toBeCloseTo(aPos.z, 3);
    expect(ctrl.player.inventory.count(B.GLASS)).toBe(7);
    expect(ctrl.player.inventory.count(B.HELM)).toBe(1); // the starter items came once
    // b, who had left before the save, joins later from its record.
    h.host.setRoomOpen(true);
    h.run(500);
    const b = h.addClient('b');
    h.run(200);
    const cb = h.sim.players.get('b')!;
    expect(cb.player.pos.x).toBeCloseTo(10.5, 6);
    expect(cb.player.inventory.count(B.GLASS)).toBe(5);
    expect(b.welcome).not.toBeNull();
  });

  it('a player who joins the loaded world after its first tick is restored, no longer at the wheel', async () => {
    const { storage, shipId, aPos } = await savedWorld();
    const h = new NetHarness({ storage });
    await h.load('w');
    h.addClient('host', {}, { local: true });
    h.run(500);
    h.host.setRoomOpen(true);
    h.addClient('a');
    h.run(200);
    const ctrl = h.sim.players.get('a')!;
    expect(ctrl.player.steeringShipId).toBe(0);
    expect((h.sim.structures.get(shipId) as Ship).helmsmanId).toBe(0);
    expect(ctrl.player.pos.x).toBeCloseTo(aPos.x, 3);
    expect(ctrl.player.pos.z).toBeCloseTo(aPos.z, 3);
    expect(ctrl.player.inventory.count(B.GLASS)).toBe(7);
    expect(ctrl.player.inventory.count(B.HELM)).toBe(1);
  });

  it('a failed save never stops the server; shutdown { save: true } closes only once a save succeeded', async () => {
    const storage = new FlakyStorage();
    const h = new NetHarness({ storage });
    await h.create();
    const a = h.addClient('a', {}, { local: true });
    h.run(200);
    await h.settle();
    storage.fail = new SaveStorageError('full', { code: 'quota' });
    expect(await h.host.save()).toBe(false);
    expect(h.reports.at(-1)).toEqual({ type: 'saved', ok: false, code: 'quota' });
    const t = h.sim.ticks;
    h.run(500);
    expect(h.sim.ticks).toBeGreaterThan(t);
    expect(await h.host.shutdown(true)).toBe(false);
    expect(h.host.state).toBe('running');
    expect(h.reports.slice(-2)).toEqual([
      { type: 'saved', ok: false, code: 'quota' },
      { type: 'error', what: 'shutdown', message: 'the save failed; the server keeps running' },
    ]);
    const t2 = h.sim.ticks;
    h.run(500);
    expect(h.sim.ticks).toBeGreaterThan(t2); // still ticking
    expect(a.kick).toBeNull();
    // New connections are accepted again.
    const a2 = h.addClient('a2', {}, { local: true });
    h.run(100);
    expect(a2.welcome).not.toBeNull();
    storage.fail = null;
    await h.host.control({ type: 'shutdown', save: true });
    expect(h.host.state).toBe('closed');
    h.run(10);
    expect(a.kick?.reason).toBe('shutdown');
    expect(h.reports.slice(-2)).toEqual([{ type: 'saved', ok: true, code: null }, { type: 'closed' }]);
    const t3 = h.sim.ticks;
    h.run(1000);
    expect(h.sim.ticks).toBe(t3);
  });

  it('saves are serialized: requests while one runs share one follow-up save of the newest state', async () => {
    const storage = new FlakyStorage();
    const h = new NetHarness({ storage });
    await h.create();
    await h.settle();
    expect(storage.writes).toBe(1);
    h.addClient('a', {}, { local: true });
    h.run(100);
    // Requested together: one save.
    const p1 = h.host.save();
    expect(h.host.save()).toBe(p1);
    expect(await p1).toBe(true);
    expect(storage.writes).toBe(2);
    // While one is being written: one follow-up for every later request.
    const q1 = h.host.save();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(storage.writes).toBe(3); // q1 is being written
    const q2 = h.host.save();
    const q3 = h.host.save();
    expect(q2).toBe(q3);
    expect(q2).not.toBe(q1);
    expect(await Promise.all([q1, q2, q3])).toEqual([true, true, true]);
    expect(storage.writes).toBe(4);
  });

  it('load: a missing or newer world is reported and the host stays idle; a world without a generator blob is terrain of its seed', async () => {
    const storage = new MemoryStorage();
    const h = new NetHarness({ storage });
    await h.load('nope');
    expect(h.reports.at(-1)).toMatchObject({ type: 'error', what: 'load' });
    expect(h.host.state).toBe('idle');
    const newer: WorldMeta = { ...testMeta('n'), version: SAVE_VERSION + 1 };
    await storage.putMeta(newer);
    await h.load('n');
    expect(h.reports.at(-1)).toMatchObject({ type: 'error', what: 'load', message: expect.stringContaining('newer') });
    await storage.putMeta(testMeta('t'));
    await h.load('t');
    expect(h.host.state).toBe('running');
    const a = h.addClient('a', {}, { local: true });
    h.run(50);
    expect(a.welcome!.generator).toEqual({ kind: 'terrain', seed: 7 });
  });

  it('create: the example ship is placed unless asked not to; the starter items go to the first player', async () => {
    const h = new NetHarness();
    await h.create(testMeta('t', 'creative'), {});
    expect(h.sim.generator.spec()).toEqual({ kind: 'terrain', seed: 7 });
    // A terrain world: the windmill boat is moored near the spawn when open water is found.
    const planks = [...h.sim.world.chunks.values()].some((c) => c.modified);
    expect(planks).toBe(true);
    const h2 = new NetHarness();
    await h2.create(testMeta(), { generator: FLAT, exampleShip: false });
    expect([...h2.sim.world.chunks.values()].some((c) => c.modified)).toBe(false);
  });
});
