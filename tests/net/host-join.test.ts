/**
 * Package 8: joining (NETCODE section 3 "加入顺序", section 17 item 5): the join sequence and
 * Welcome, the 'drive' correction, the simulation radius, the starter items for a new identity
 * only, `ready`, a second client joining in the very tick a ship assembles (digests compared after
 * every tick, planks conserved in every batch), and a hidden page.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PZ } from '../../src/core/dirs';
import { SIM_RADIUS_CAP } from '../../src/net/protocol';
import { STARTER_ITEMS } from '../../src/sim/starter';
import type { Simulation } from '../../src/sim/simulation';
import { Ship } from '../../src/structures/structure';
import type { GeneratorSpec } from '../../src/worldgen/generator';
import type { TickBatchMsg } from '../../src/net/protocol';
import { FLAT, NetHarness, testMeta, type HeadlessClient } from './harness';
import { countReplica, countServer, type Box } from './rig';

const SEA_TOP = 30;
const DECK = SEA_TOP - 1;
const SEA: GeneratorSpec = {
  kind: 'flat',
  seed: 3,
  layers: [
    { cell: B.DEEPROCK, thickness: 1 },
    { cell: B.STONE, thickness: 19 },
    { cell: B.WATER, thickness: 10 },
  ],
};

function fill(sim: Simulation, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  const c = makeCell(id);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) sim.world.setCell(x, y, z, c);
}


describe('joining (package 8)', () => {
  it('the join sequence: Welcome before the first batch, the drive correction, radius, starter items, ready', async () => {
    const h = new NetHarness();
    await h.create(testMeta('w', 'survival'), { generator: FLAT, exampleShip: false });
    const a = h.addClient('alice', {}, { local: true, name: 'Alice', viewRadius: 17 });
    h.track(a);
    h.run(200);
    const ctrl = h.sim.players.get('alice')!;
    expect(a.statuses).toEqual(['connecting', 'joining', 'ready']);
    const w = a.welcome!;
    expect(w.entityId).toBe(ctrl.entityId);
    expect(w.generator).toEqual(FLAT);
    expect(w.rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    expect(w.isHost).toBe(true);
    expect(w.roomOpen).toBe(false);
    expect(w.players).toEqual([{ entityId: ctrl.entityId, name: 'Alice', host: true }]);
    expect(w.worldTime + 1).toBe(a.applied[0]); // Welcome before tick T, then the batch of T
    expect(ctrl.drive).toBe('client');
    expect(ctrl.viewRadius).toBe(SIM_RADIUS_CAP);
    expect(a.state!.private.correction).toMatchObject({ cause: 'drive', epoch: 1 });
    expect(a.state!.private.correctionTick).toBe(a.applied[0]); // in the first batch
    for (const [item, count] of STARTER_ITEMS) expect(ctrl.player.inventory.count(item), `item ${item}`).toBe(count);
    expect(a.state!.private.inventory!.hotbar.some((s) => s?.item === B.PLANKS_OAK)).toBe(true);
    expect(a.readyTick).not.toBeNull();
    // The ready zone (radius 17: all 7 x 7) is in the replica.
    const cx = Math.floor(ctrl.player.pos.x) >> 4;
    const cz = Math.floor(ctrl.player.pos.z) >> 4;
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) expect(a.state!.world.getChunk(cx + dx, cz + dz), `${dx},${dz}`).toBeDefined();
    expect(a.mismatches).toEqual([]);
  });

  it('starter items only for an identity the world has never seen (also after a save and load)', async () => {
    const h = new NetHarness();
    await h.create();
    const a = h.addClient('a', {}, { local: true });
    h.run(100);
    const inv = h.sim.players.get('a')!.player.inventory;
    inv.clear();
    inv.add(B.STONE, 3);
    a.leave();
    h.run(100);
    expect(h.sim.players.get('a')).toBeUndefined();
    const a2 = h.addClient('a', {}, { local: true });
    h.run(100);
    const again = h.sim.players.get('a')!.player.inventory;
    expect(again.count(B.PLANKS_OAK)).toBe(0);
    expect(again.count(B.STONE)).toBe(3);
    expect(await h.host.save()).toBe(true);
    a2.leave();
    h.run(100);
    expect(await h.host.shutdown(false)).toBe(true);
    const h2 = new NetHarness({ storage: h.storage });
    await h2.load('w1');
    h2.addClient('a', {}, { local: true });
    h2.addClient('b', {}, { local: true });
    h2.run(100);
    expect(h2.sim.players.get('a')!.player.inventory.count(B.PLANKS_OAK)).toBe(0);
    expect(h2.sim.players.get('b')!.player.inventory.count(B.PLANKS_OAK)).toBe(64);
  });

  it('a second client joins in the tick a raft assembles: its first batch has the ship, digests agree every tick, planks are conserved', async () => {
    const h = new NetHarness();
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const a = h.addClient('a', {}, { local: true, viewRadius: 3 });
    h.track(a);
    h.run(200);
    const sim = h.sim;
    const ctrl = sim.players.get('a')!;
    ctrl.teleport(2.5, SEA_TOP, 7.5);
    fill(sim, 0, 20, 6, 4, DECK, 8, B.COBBLE); // pier
    fill(sim, 0, DECK, 0, 4, DECK, 5, B.PLANKS_OAK);
    sim.world.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    h.run(500);
    a.emptyHand();
    expect(a.useOn(2, SEA_TOP, 4, PZ)).toBe(true); // preview
    expect(ctrl.view.preview?.kind).toBe('ship');
    await h.host.control({ type: 'openRoom' });
    const box: Box = [-40, 0, -40, 40, 60, 40];
    const planks = countServer(sim, B.PLANKS_OAK, box);
    const b = h.addClient('b', {}, { viewRadius: 2 });
    h.track(b);
    let conserved = 0;
    let firstB: TickBatchMsg | null = null;
    const watch = (c: HeadlessClient): void => {
      c.onBatch = (batch) => {
        if (c === b) firstB ??= batch;
        if (!c.state!.ready) return;
        expect(countReplica(c.state!, B.PLANKS_OAK, box), `${c.key} at tick ${batch.tick}`).toBe(planks);
        conserved++;
      };
    };
    watch(a);
    watch(b);
    h.run(1); // b's Hello arrives (accepted, joins at the next tick)
    expect(h.host.netServer.connections().find((c) => c.key === 'b')?.state).toBe('accepted');
    expect(a.aimAt(2, SEA_TOP, 4, PZ)).toBe(true);
    a.use();
    h.ticks(); // b joins, the raft assembles (the click arrives at once on the instant link)
    const ship = sim.structures.ships()[0];
    expect(ship).toBeInstanceOf(Ship);
    const tick = sim.ticks;
    h.run(30);
    expect(firstB!.tick).toBe(tick);
    expect(firstB!.structureSpawns.map((s) => s.id)).toEqual([ship!.id]);
    a.input.forward = 1; // the helmsman's client holds the key (its reports carry the stick)
    h.run(2000);
    a.input.forward = 0;
    h.run(1000);
    expect(a.mismatches).toEqual([]);
    expect(b.mismatches).toEqual([]);
    expect(b.checked).toBeGreaterThan(55);
    expect(ship!.grid.position.z).toBeLessThan(0); // it sailed
    expect(conserved).toBeGreaterThan(80);
    h.quiesce();
    expect(h.compareNow(a)).toEqual([]);
    expect(h.compareNow(b)).toEqual([]);
  });

  it('a hidden page: the local client gets no frames for 100 s; NetClient applies every batch as it arrives, the server never times it out', async () => {
    const h = new NetHarness();
    await h.create();
    const a = h.addClient('a', {}, { local: true });
    h.track(a);
    h.run(200);
    a.hidden = true;
    const t0 = h.sim.ticks;
    const frames = a.frames;
    let worstLag = 0;
    a.onBatch = () => (worstLag = Math.max(worstLag, h.sim.ticks - a.state!.tick));
    h.run(100_000);
    expect(h.sim.ticks - t0).toBeGreaterThanOrEqual(1990);
    expect(a.frames).toBe(frames);
    expect(a.net.waiting).toBe(0);
    expect(worstLag).toBe(0);
    expect(a.kick).toBeNull();
    expect(h.sim.players.get('a')).toBeDefined();
    a.hidden = false;
    h.sim.world.setCell(1, 4, 1, makeCell(B.GLASS));
    h.run(100);
    expect(a.applied.at(-1)).toBeGreaterThanOrEqual(h.sim.ticks - 1);
    for (let i = 1; i < a.applied.length; i++) expect(a.applied[i]).toBe(a.applied[i - 1]! + 1);
    expect(a.checked).toBeGreaterThan(1990);
    expect(a.mismatches).toEqual([]);
  });

  it('quiesce() on delayed, lossy links: runs until no client message is in flight plus 10 ticks, then every replica is at the server\'s last tick and equal to it', async () => {
    const h = new NetHarness();
    await h.create();
    const slow = { latencyMs: 150, jitterMs: 20, loss: 0.05, seed: 5 };
    const a = h.addClient('a', { up: { ...slow, seed: 1 }, down: { ...slow, seed: 2 } }, { local: true, viewRadius: 3 });
    await h.host.control({ type: 'openRoom' });
    const b = h.addClient('b', { up: { ...slow, latencyMs: 60, seed: 3 }, down: { ...slow, latencyMs: 60, seed: 4 } }, { viewRadius: 3 });
    h.track(a);
    h.track(b);
    h.runUntil(() => a.ready && b.ready, 10_000);
    for (let i = 0; i < 60; i++) {
      h.sim.world.setCell(20 + (i % 8), 5, 20 + ((i * 3) % 8), makeCell(i % 2 === 0 ? B.PLANKS_OAK : B.COBBLE));
      h.run(50);
    }
    a.net.send({ type: 'selectSlot', seq: 1, slot: 0 }); // still in flight when quiesce() starts
    const t0 = h.sim.ticks;
    h.quiesce();
    expect(h.sim.ticks).toBeGreaterThanOrEqual(t0 + 10);
    expect(a.applied.at(-1)).toBe(h.sim.ticks);
    expect(b.applied.at(-1)).toBe(h.sim.ticks);
    expect(h.compareNow(a)).toEqual([]);
    expect(h.compareNow(b)).toEqual([]);
    expect(a.mismatches).toEqual([]);
    expect(b.mismatches).toEqual([]);
    const held = h.sim.ticks;
    h.run(500); // the next run lets the server go on
    expect(h.sim.ticks).toBeGreaterThan(held + 5);
  });
});
