/**
 * End to end (NETCODE section 16, scenario 34): a guest joins an existing world through the real
 * stack (HeadlessClient = NetClient + ClientReplica, loopback links, ServerHost + NetServer +
 * Replicator) on three links. On the server: a dam that just broke (water still flowing), the
 * example windmill boat sailing in circles with its windmill turning, and a spinning windmill on
 * an island. From "ready" on, every applied batch's digest equals the server's at that tick
 * (cells, glue, structures, rotor angles to 1e-9; tests/net/digest.ts), and at every frame each
 * ship at renderTick is where the server had it at that tick, within the wire's quantisation
 * (on lossy links: unless the samples around renderTick were lost, then within the ship's motion
 * over the gap). After quiesce() everything is equal, poses included.
 */
import { describe, expect, it } from 'vitest';
import { NetHarness, testMeta } from './harness';
import { dam, exampleBoat, island, launchBoat, LINKS, lossOf, SEA, spinningWindmill, watchShipPoses } from './e2e-scenes';

describe.each(LINKS)('joining an existing world over $name (end to end)', ({ make }) => {
  it('a broken dam, a sailing windmill boat and a spinning windmill: digests every tick from ready, ship poses at renderTick', async () => {
    const h = new NetHarness({ history: true });
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    // Before the first tick, like a new world: the boat near the spawn, an island west of it.
    const boat = exampleBoat(sim);
    const ix = boat.helm.x < 0 ? 20 : -40;
    island(sim, ix, -12, ix + 20, 12);
    const breakDam = dam(sim, ix + 2, -10);
    const bot = sim.join('bot');
    // The host's own page starts the clock.
    const host = h.addClient('host', {}, { local: true, viewRadius: 5 });
    h.track(host);
    h.runUntil(() => host.ready);
    const windmill = spinningWindmill(sim, ix + 14, 0);
    const { ship, rotor } = launchBoat(h, boat, bot);
    bot.player.input.forward = 1;
    bot.player.input.strafe = 0.5;
    h.ticks(60);
    breakDam();
    h.ticks(5);
    let flowing = 0;
    sim.world.onCellChange(() => flowing++);

    await h.host.control({ type: 'openRoom' });
    const conds = make(31);
    const g = h.addClient('guest', conds, { viewRadius: 5 });
    h.track(g);
    const poses = watchShipPoses(h, g);
    h.runUntil(() => g.ready, 30_000);
    const readyAt = g.checked;
    expect(g.readyTick).not.toBeNull();
    h.run(12_000);

    expect(flowing).toBeGreaterThan(50); // the water was still moving while the guest joined
    expect(sim.structures.get(ship.id)).toBe(ship);
    expect(windmill.angularSpeed).not.toBe(0);
    expect(rotor.parent).toBe(ship);
    const rs = g.state!.structures;
    expect(rs.has(ship.id) && rs.has(rotor.id) && rs.has(windmill.id)).toBe(true);
    expect(g.mismatches.slice(0, 5)).toEqual([]);
    expect(host.mismatches.slice(0, 5)).toEqual([]);
    expect(g.checked - readyAt).toBeGreaterThan(150);
    // Ship poses at renderTick.
    expect(poses.frames).toBeGreaterThan(400);
    if (lossOf(conds) === 0) {
      expect(poses.exact).toBe(poses.frames);
    } else {
      // A lost sample at or before the newest applied batch makes the ship hold at the sample before
      // it (section 7): off by the ship's motion over the run of lost samples.
      const lossy = lossOf(conds) > 0.1;
      expect(poses.exact / poses.frames).toBeGreaterThan(lossy ? 0.5 : 0.8);
      expect(poses.worstPos).toBeLessThan(poses.serverStep * (lossy ? 5 : 3));
    }
    bot.player.input.forward = 0;
    bot.player.input.strafe = 0;
    h.quiesce();
    expect(h.compareNow(g)).toEqual([]);
    expect(h.compareNow(host)).toEqual([]);
  }, 120_000);
});
