/**
 * End to end (NETCODE section 3): four clients at once with different view radii, through the
 * real stack, while the world changes around them (blocks every tick, rabbits, a server-driven
 * bot walking in circles, a spinning windmill). One joins late, one leaves with Bye, one drops
 * without Bye (its page dies), one's link fails and it reconnects, one is replaced by a second
 * connection with the same identity. Every live client's digest equals the server's at every
 * applied tick, the player tables agree with the server, the records of those who left stay, and
 * after quiesce() every replica equals the server.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { MAX_PLAYERS } from '../../src/net/protocol';
import { link, NetHarness, testMeta, type HeadlessClient } from './harness';
import { island, SEA, SEA_TOP, spinningWindmill } from './e2e-scenes';

/** Names of the online players as the client's table has them, sorted. */
function table(c: HeadlessClient): string[] {
  return [...c.state!.players.values()].map((p) => p.name).sort();
}

describe('four clients end to end', () => {
  it('different radii; late join, Bye, a dead page, a failed link that reconnects, a replaced connection', async () => {
    const h = new NetHarness({ rabbits: true });
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    island(sim, -24, -24, 24, 24);
    const bot = sim.join('bot');
    bot.player.input.forward = 1;
    let k = 0;
    h.onTick = () => {
      bot.player.input.yaw += 0.03;
      sim.world.setCell(((k * 7) % 40) - 20, SEA_TOP + 1 + (k % 3), ((k * 11) % 40) - 20, makeCell(k % 2 === 0 ? B.COBBLE : B.AIR));
      k++;
    };
    const host = h.addClient('host', {}, { local: true, name: 'Host', viewRadius: 6 });
    h.runUntil(() => host.ready);
    spinningWindmill(sim, 10, -10);
    await h.host.control({ type: 'openRoom' });
    const a = h.addClient('a', { up: link(75, 20, 0.05, 1), down: link(75, 20, 0.05, 2) }, { name: 'Ann', viewRadius: 2 });
    const b = h.addClient('b', { up: link(30, 5, 0, 3), down: link(30, 5, 0, 4) }, { name: 'Bo', viewRadius: 4 });
    for (const c of [host, a, b]) h.track(c);
    h.runUntil(() => a.ready && b.ready, 20_000);
    h.run(2000);
    expect(table(host)).toEqual(['Ann', 'Bo', 'Host']);
    expect(table(a)).toEqual(['Ann', 'Bo', 'Host']);
    // The bot is not a client: no row in the tables, but an entity everyone near sees.
    expect(host.state!.entities.has(bot.entityId)).toBe(true);

    // c joins late on a bad link with the largest radius.
    const c = h.addClient('c', { up: link(200, 20, 0.2, 5), down: link(200, 20, 0.2, 6) }, { name: 'Cy', viewRadius: 9 });
    h.track(c);
    h.runUntil(() => c.ready, 30_000);
    expect(h.host.netServer.playerCount).toBe(MAX_PLAYERS);
    h.run(2000);
    expect(table(b)).toEqual(['Ann', 'Bo', 'Cy', 'Host']);

    // b leaves with Bye: gone from every table and entity stream; its record stays.
    const idB = sim.players.get('b')!.entityId;
    sim.players.get('b')!.teleport(3.5, SEA_TOP, 3.5);
    h.run(500);
    b.leave();
    h.run(1500);
    expect(sim.players.get('b')).toBeUndefined();
    expect(sim.players.keys()).toContain('b');
    for (const x of [host, a, c]) {
      expect(table(x), x.key).toEqual(['Ann', 'Cy', 'Host']);
      expect(x.state!.entities.has(idB), x.key).toBe(false);
    }

    // d takes the free place and its page dies (no Bye): a leave at the next tick.
    const d = h.addClient('d', { up: link(20), down: link(20) }, { name: 'Di', viewRadius: 3 });
    h.track(d);
    h.runUntil(() => d.ready, 10_000);
    expect(table(host)).toEqual(['Ann', 'Cy', 'Di', 'Host']);
    h.crash(d);
    h.run(200);
    expect(sim.players.get('d')).toBeUndefined();
    expect(table(host)).toEqual(['Ann', 'Cy', 'Host']);

    // a's link fails on both ends: it reconnects and joins again from scratch with the same identity.
    const idA = sim.players.get('a')!.entityId;
    sim.players.get('a')!.teleport(-6.5, SEA_TOP, 5.5);
    h.run(500);
    h.sever(a);
    expect(a.status).toBe('reconnecting');
    h.runUntil(() => a.ready, 20_000);
    expect(a.net.connectionCount).toBe(2);
    expect(sim.players.get('a')!.entityId).toBe(idA);
    expect(sim.players.get('a')!.player.pos.x).toBeCloseTo(-6.5, 6); // from its record
    expect(table(a)).toEqual(['Ann', 'Cy', 'Host']);

    // c opens a second page with the same identity: the first is kicked (replaced) and stays down.
    const c2 = h.addClient('c', { up: link(40, 5, 0, 7), down: link(40, 5, 0, 8) }, { name: 'Cy', viewRadius: 5 });
    h.track(c2);
    h.runUntil(() => c2.ready, 20_000);
    h.run(3000);
    expect(c.status).toBe('kicked');
    expect(c.kick?.reason).toBe('replaced');
    expect(c.net.connectionCount).toBe(1);
    expect(table(host)).toEqual(['Ann', 'Cy', 'Host']);
    expect(h.host.netServer.playerCount).toBe(3);

    h.run(3000);
    for (const x of [host, a, c2]) {
      expect(x.mismatches.slice(0, 5), x.key).toEqual([]);
      expect(x.checked, x.key).toBeGreaterThan(100);
    }
    for (const x of [b, c, d]) expect(x.mismatches.slice(0, 5), x.key).toEqual([]);
    h.onTick = null;
    bot.player.input.forward = 0;
    h.removeClient(b);
    h.removeClient(c);
    h.quiesce();
    for (const x of [host, a, c2]) expect(h.compareNow(x), x.key).toEqual([]);
    // Different radii, different column sets.
    const cols = (x: HeadlessClient): number => x.state!.world.chunks.size;
    expect(cols(a)).toBeLessThan(cols(c2));
    expect(cols(c2)).toBeLessThan(cols(host));
  }, 180_000);
});
