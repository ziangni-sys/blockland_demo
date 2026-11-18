/**
 * End to end (NETCODE section 12, scenario 36): a world with glue, a ship carrying a windmill, a
 * spinning world windmill, edited blocks and a guest with a record; the host saves and shuts down
 * (every client gets Kick(shutdown) and stays down); a new ServerHost loads the same storage; the
 * host's client and the guest join again. The loaded world equals the saved one (cells, glue,
 * structures with their fields, rotor angles, ship poses), the guest's record (position,
 * inventory) is back, and every replica equals the new server.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NY, PX } from '../../src/core/dirs';
import { chunkKey } from '../../src/voxel/chunk';
import { compareReplica, DigestContext, serverDigest, type Digest } from './digest';
import { link, NetHarness, testMeta, type HeadlessClient } from './harness';
import { exampleBoat, island, launchBoat, SEA, SEA_TOP, spinningWindmill } from './e2e-scenes';

/** The server's state over a fixed area and every structure (entities: the players come back by themselves). */
function worldDigest(h: NetHarness): Digest {
  const cols: number[] = [];
  for (let cx = -4; cx <= 3; cx++) for (let cz = -4; cz <= 3; cz++) cols.push(chunkKey(cx, cz));
  return serverDigest(new DigestContext(h.sim.generator), h.sim, { columns: cols, structures: h.sim.structures.all().map((s) => s.id), entities: [] });
}

describe('save, shut down, load, join end to end', () => {
  it('the world, glue, structures and the guest\'s record are back; the replicas equal the new server', async () => {
    const h = new NetHarness();
    await h.create(testMeta('saved'), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    const boat = exampleBoat(sim);
    const ix = boat.helm.x < 0 ? 20 : -40;
    island(sim, ix, -12, ix + 20, 12);
    const bot = sim.join('bot');
    const host = h.addClient('host', {}, { local: true, viewRadius: 4 });
    h.runUntil(() => host.ready);
    // Blocks with glue between them on the island, a spinning windmill, the boat sailing then stopped.
    for (let i = 0; i < 6; i++) sim.world.setCell(ix + 3 + i, SEA_TOP, 6, makeCell(B.COBBLE));
    for (let i = 0; i < 5; i++) sim.worldGlue.add(ix + 3 + i, SEA_TOP, 6, PX);
    sim.worldGlue.add(ix + 3, SEA_TOP, 6, NY);
    const windmill = spinningWindmill(sim, ix + 14, 0);
    const { ship, rotor } = launchBoat(h, boat, bot);
    bot.player.input.forward = 1;
    h.ticks(60);
    bot.player.input.forward = 0;
    h.ticks(100);
    sim.leave('bot'); // lets go of the wheel (a loaded world has nobody at it until they join)
    await h.host.control({ type: 'openRoom' });
    const guestLink = { up: link(75, 20, 0.05, 51), down: link(75, 20, 0.05, 52) };
    const g = h.addClient('guest', guestLink, { name: 'Guest', viewRadius: 4 });
    h.runUntil(() => g.ready, 20_000);
    const gc = sim.players.get('guest')!;
    gc.teleport(ix + 6.5, SEA_TOP + 1, 3.5);
    gc.giveItem(B.GLASS, 9);
    h.run(1000);
    const record = { pos: { ...gc.player.pos }, glass: gc.player.inventory.count(B.GLASS), helm: gc.player.inventory.count(B.HELM) };

    // Save and shut down: the save holds this tick's state.
    const saved = worldDigest(h);
    const savedTicks = sim.ticks;
    expect(saved.structures.size).toBe(3);
    expect(await h.host.shutdown(true)).toBe(true);
    h.run(1000);
    for (const c of [host, g]) {
      expect(c.status, c.key).toBe('kicked');
      expect(c.kick?.reason, c.key).toBe('shutdown');
    }
    h.run(5000);
    expect(host.net.connectionCount + g.net.connectionCount).toBe(2); // no reconnection after a Kick

    // A new host on the same storage.
    const h2 = new NetHarness({ storage: h.storage });
    await h2.load('saved');
    expect(h2.sim.ticks).toBe(savedTicks);
    expect(compareReplica(saved, worldDigest(h2))).toEqual([]);
    const sim2 = h2.sim;
    expect(sim2.worldGlue.has(ix + 3, SEA_TOP, 6, NY)).toBe(true);
    expect(sim2.structures.get(ship.id)?.kind).toBe('ship');
    expect(sim2.structures.get(rotor.id)?.parent?.id).toBe(ship.id);
    expect(sim2.structures.get(windmill.id)?.kind).toBe('rotor');
    const host2 = h2.addClient('host', {}, { local: true, viewRadius: 4 });
    h2.track(host2);
    h2.runUntil(() => host2.ready);
    await h2.host.control({ type: 'openRoom' });
    const g2 = h2.addClient('guest', guestLink, { name: 'Guest', viewRadius: 4 });
    h2.track(g2);
    h2.runUntil(() => g2.ready, 20_000);
    const gc2 = sim2.players.get('guest')!;
    expect(gc2.player.pos.x).toBeCloseTo(record.pos.x, 6);
    expect(gc2.player.pos.y).toBeCloseTo(record.pos.y, 6);
    expect(gc2.player.pos.z).toBeCloseTo(record.pos.z, 6);
    expect(gc2.player.inventory.count(B.GLASS)).toBe(record.glass);
    expect(gc2.player.inventory.count(B.HELM)).toBe(record.helm); // no second starter kit
    // The guest's own replica holds its record too (private inventory).
    expect(g2.state!.private.inventory!.hotbar.concat(g2.state!.private.inventory!.main).some((s) => s?.item === B.GLASS && s.count === 9)).toBe(true);
    h2.run(3000);
    for (const c of [host2, g2] as HeadlessClient[]) {
      expect(c.mismatches.slice(0, 5), c.key).toEqual([]);
      const glue = c.state!.worldGlue;
      expect(glue.has(ix + 3, SEA_TOP, 6, NY), c.key).toBe(true);
      expect(c.state!.structures.has(ship.id) && c.state!.structures.has(rotor.id) && c.state!.structures.has(windmill.id), c.key).toBe(true);
    }
    h2.quiesce();
    for (const c of [host2, g2]) expect(h2.compareNow(c), c.key).toEqual([]);
  }, 120_000);
});
