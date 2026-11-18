/**
 * End to end (NETCODE section 4 "卡顿提示", scenario 37): the host's page in the background, its
 * Worker woken only once a second: the server catches up 5 ticks per wake-up, the measured TPS in
 * the globals drops below 15 and every client shows "the host's server is throttled" within 3 s,
 * the replicas stay equal to the server through the bursts, and everything recovers when the host
 * runs normally again. Then a guest's own link goes silent while the host is fine: that guest
 * shows "connection unstable" (no batches, no Pongs), the others nothing; when the link comes
 * back the reliable messages that waited arrive in order and the hint clears.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { MAX_CATCHUP_TICKS } from '../../src/net/protocol';
import { link, NetHarness, testMeta, type HeadlessClient } from './harness';
import { exampleBoat, launchBoat, SEA, SEA_TOP } from './e2e-scenes';

describe('stalls end to end', () => {
  it('a throttled host (one wake-up a second), then a guest whose link goes silent', async () => {
    const h = new NetHarness({ history: true });
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    const boat = exampleBoat(sim);
    const bot = sim.join('bot');
    const host = h.addClient('host', {}, { local: true, viewRadius: 4 });
    h.runUntil(() => host.ready);
    launchBoat(h, boat, bot);
    // A block changing every tick (after the launch: a world change drops an assembly preview).
    let k = 0;
    h.onTick = () => {
      sim.world.setCell(boat.helm.x + 20 + (k % 5), SEA_TOP + 2, boat.helm.z + 20, makeCell(k % 2 === 0 ? B.GLASS : B.AIR));
      k++;
    };
    bot.player.input.forward = 1;
    bot.player.input.strafe = 0.4;
    await h.host.control({ type: 'openRoom' });
    const up = link(75, 20, 0.05, 11);
    const down = link(75, 20, 0.05, 12);
    const g = h.addClient('guest', { up, down }, { viewRadius: 4 });
    const other = h.addClient('other', { up: link(40, 5, 0, 13), down: link(40, 5, 0, 14) }, { viewRadius: 3 });
    const clients: HeadlessClient[] = [host, g, other];
    for (const c of clients) h.track(c);
    h.runUntil(() => g.ready && other.ready, 20_000);
    h.run(3000);
    const hints = (): Array<string | null> => clients.map((c) => c.net.stall(h.net.now));
    expect(hints()).toEqual([null, null, null]);

    // The host's page goes to the background.
    const ticks: number[] = [];
    const prevTick = h.onTick;
    h.onTick = () => {
      prevTick();
      ticks.push(h.net.now);
    };
    const throttledAt = h.net.now;
    h.wakeEveryMs = 1000;
    const seenAt = new Map<HeadlessClient, number>();
    for (let t = 0; t < 6000; t += 50) {
      h.run(50);
      for (const c of clients) if (!seenAt.has(c) && c.net.stall(h.net.now) === 'host') seenAt.set(c, h.net.now);
    }
    for (const c of clients) {
      expect(seenAt.get(c), c.key).toBeDefined();
      expect(seenAt.get(c)! - throttledAt, c.key).toBeLessThan(3000);
      expect(c.state!.tps, c.key).toBeLessThan(15);
      expect(c.closed, c.key).toBe(false);
    }
    // 5 ticks per wake-up; the batches of a burst are applied in order.
    const late = ticks.filter((t) => t > h.net.now - 3000);
    const bursts = new Map<number, number>();
    for (const t of late) bursts.set(t, (bursts.get(t) ?? 0) + 1);
    expect([...bursts.values()].every((n) => n === MAX_CATCHUP_TICKS)).toBe(true);
    for (const c of clients) for (let i = 1; i < c.applied.length; i++) expect(c.applied[i], c.key).toBe(c.applied[i - 1]! + 1);

    // Back to normal: the hint clears once the TPS window refills.
    h.wakeEveryMs = 0;
    h.runUntil(() => hints().every((x) => x === null), 5000);
    for (const c of clients) expect(c.state!.tps, c.key).toBe(20);

    // The guest's link goes silent both ways (the host is fine): only it shows "link".
    down.loss = 1;
    down.rtoMs = 1e9;
    up.loss = 1;
    up.rtoMs = 1e9;
    const silentAt = h.net.now;
    h.runUntil(() => g.net.stall(h.net.now) === 'link', 5000);
    expect(h.net.now - silentAt).toBeLessThan(2600);
    h.run(2000);
    expect(g.net.stall(h.net.now)).toBe('link');
    expect(host.net.stall(h.net.now)).toBeNull();
    expect(other.net.stall(h.net.now)).toBeNull();
    const stuckAt = g.state!.tick;
    // It comes back: what waited arrives in order, the hint clears, nothing reconnected.
    down.loss = 0.05;
    up.loss = 0.05;
    h.runUntil(() => g.net.stall(h.net.now) === null && g.state!.tick > stuckAt + 100, 10_000);
    expect(g.net.connectionCount).toBe(1);
    for (let i = 1; i < g.applied.length; i++) expect(g.applied[i]).toBe(g.applied[i - 1]! + 1);
    h.run(2000);
    for (const c of clients) {
      expect(c.mismatches.slice(0, 5), c.key).toEqual([]);
      expect(c.checked, c.key).toBeGreaterThan(200);
    }
    bot.player.input.forward = 0;
    bot.player.input.strafe = 0;
    h.onTick = null;
    h.quiesce();
    for (const c of clients) expect(h.compareNow(c), c.key).toEqual([]);
  }, 180_000);
});
