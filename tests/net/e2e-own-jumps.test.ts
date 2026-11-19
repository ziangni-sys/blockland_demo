/**
 * End to end (package 6): jumping, the move the vertical envelope judges (entities/drive.ts
 * VERTICAL ENVELOPE), for long enough that lost reports land everywhere in a jump:
 *  - random single-tick jumps while walking and sprinting on flat land, 2000 client ticks: on a
 *    lossy link the report of the take-off tick is often lost, and the body then left the ground
 *    up to several ticks after the last report the server saw it standing in;
 *  - jumping again and again on the example windmill boat while it sails in circles under a
 *    server-driven helmsman: the deck heels while it turns, and a rider pressed against the mast
 *    or the gunwale is lifted a little by that tilted face (the mover cancels the speed into the
 *    face along its normal), so its arc runs a little above a jump's.
 * Neither may cost a correction or any damage.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { vec3 } from '../../src/core/math';
import { DECK_Y, MAST_V } from '../../src/sim/exampleShip';
import { exampleBoat, launchBoat, LINKS, SEA } from './e2e-scenes';
import { NetHarness, testMeta, type HeadlessClient } from './harness';
import { LAND, ownWorld } from './own-scenes';

const LINK_0 = LINKS[0]!;
const LINK_150 = LINKS[1]!;

describe('random single-tick jumps on land, 2000 client ticks', () => {
  async function hop(link: (typeof LINKS)[number], seed: number): Promise<{ causes: string[]; damage: number; rejected: number; jumps: number }> {
    const r = await ownWorld(LAND, 'survival', link.make(seed * 7 + 3));
    const rnd = new Rng(seed);
    let jumps = 0;
    r.mark((k) => {
      const i = r.c.input;
      if (k > 2000) return r.idle();
      i.forward = 1;
      i.sprint = (k >> 6) % 2 === 0;
      i.jump = rnd.chance(0.1);
      if (i.jump && r.c.own!.player.onGround) jumps++;
      if (k % 40 === 0) i.yaw += (rnd.next() - 0.5) * 3;
      // Round and round near the spawn.
      const p = r.c.own!.player.pos;
      if (Math.hypot(p.x, p.z) > 18) i.yaw = Math.atan2(p.x, p.z);
    });
    r.runSteps(2000, 1000);
    return { causes: r.causes(), damage: r.damage(), rejected: r.rejected(), jumps };
  }
  it('0 ms: no correction, no damage', async () => {
    const res = await hop(LINK_0, 1);
    expect(res.jumps).toBeGreaterThan(60);
    expect(res).toMatchObject({ causes: [], damage: 0, rejected: 0 });
  }, 60_000);
  it('150 ms round trip, 20 ms jitter, 5% loss, four seeds: no correction, no damage', async () => {
    for (const seed of [2, 3, 6, 7]) {
      const res = await hop(LINK_150, seed);
      expect(res.jumps, `seed ${seed}`).toBeGreaterThan(60);
      expect(res, `seed ${seed}`).toMatchObject({ causes: [], damage: 0, rejected: 0 });
    }
  }, 120_000);
});

describe('jumping on the example boat while it sails in circles', () => {
  /** The boat under way with a server-driven helmsman; one client per link stands on the deck by the mast. */
  async function boat(seed: number): Promise<{ h: NetHarness; clients: HeadlessClient[]; shipId: number; deck: (c: HeadlessClient) => { along: number; across: number } | null; toward: (c: HeadlessClient, along: number, across: number) => number }> {
    const h = new NetHarness({ history: true });
    await h.create(testMeta('jumps', 'survival'), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    const b = exampleBoat(sim);
    const bot = sim.join('bot');
    const clients: HeadlessClient[] = [];
    const host = h.addClient('c0', LINK_0.make(seed), { local: true, viewRadius: 4 });
    h.runUntil(() => host.ready && host.own !== null, 60_000);
    clients.push(host);
    const { ship } = launchBoat(h, b, bot);
    await h.host.control({ type: 'openRoom' });
    const guest = h.addClient('c1', LINK_150.make(seed * 11 + 1), { viewRadius: 4 });
    h.runUntil(() => guest.ready && guest.own !== null, 60_000);
    clients.push(guest);
    bot.player.input.forward = 1;
    bot.player.input.strafe = 0.5;
    h.ticks(40);
    // The deck by the mast, in the ship's frame (a structure's cells keep the world coordinates
    // they were assembled at); `along` runs along the boat, `across` from side to side.
    const mast = b.at(0, MAST_V - 1, DECK_Y);
    const centre = vec3(mast.x + 0.5, DECK_Y, mast.z + 0.5);
    const alongX = Math.abs(b.helm.x + 0.5 - centre.x) > Math.abs(b.helm.z + 0.5 - centre.z);
    // One on each side of the mast's fore-and-aft line.
    clients.forEach((c, i) => {
      const across = i === 0 ? -1 : 1;
      const w = ship.grid.toWorld(vec3(centre.x + (alongX ? 0 : across), centre.y + 0.01, centre.z + (alongX ? across : 0)));
      sim.players.get(c.key)!.teleport(w.x, w.y, w.z);
    });
    h.run(2500);
    const local = (c: HeadlessClient) => {
      const own = c.own!;
      const rs = own.replica.state.structures.get(ship.id);
      return rs === undefined ? null : { grid: rs.structure.grid, l: rs.structure.grid.toLocal(own.player.pos) };
    };
    return {
      h,
      clients,
      shipId: ship.id,
      deck: (c) => {
        const x = local(c);
        if (x === null) return null;
        const dx = x.l.x - centre.x;
        const dz = x.l.z - centre.z;
        return alongX ? { along: dx, across: dz } : { along: dz, across: dx };
      },
      toward: (c, along, across) => {
        const x = local(c)!;
        const t = alongX ? vec3(centre.x + along, x.l.y, centre.z + across) : vec3(centre.x + across, x.l.y, centre.z + along);
        const w = x.grid.toWorld(t);
        const p = c.own!.player.pos;
        return Math.atan2(-(w.x - p.x), -(w.z - p.z));
      },
    };
  }

  it('0 ms and 150 ms (20 ms jitter, 5% loss), two seeds, 1200 client ticks each: no correction, no damage, everyone still aboard', async () => {
    for (const seed of [1, 2]) {
      const { h, clients, shipId, deck, toward } = await boat(seed);
      const since = h.sim.ticks;
      const damage = new Map<string, number>();
      h.sim.events.on((e) => {
        if (e.type === 'playerHurt') damage.set(e.player, (damage.get(e.player) ?? 0) + e.amount);
      });
      const rejected0 = clients.map((c) => h.sim.players.get(c.key)!.player.remote!.rejected);
      const done: boolean[] = clients.map(() => false);
      const jumps: number[] = clients.map(() => 0);
      clients.forEach((c, i) => {
        const rnd = new Rng(seed * 101 + i);
        const mark = c.own!.lastSeq;
        let target = { along: 0, across: 0 };
        let hold = 0;
        c.onStep = (seq) => {
          const k = seq - mark;
          const inp = c.input;
          if (k > 1200) {
            done[i] = true;
            return c.stopInput();
          }
          const at = deck(c);
          if (at === null) return;
          // Walk to a spot by the mast (now and then into it or against the gunwale), jumping at random.
          if (hold-- <= 0) {
            hold = 10 + rnd.int(0, 29);
            target = { along: rnd.range(-3, 2.5), across: rnd.range(-1.1, 1.1) };
            inp.sprint = rnd.chance(0.3);
            inp.sneak = rnd.chance(0.1);
          }
          // (Not by the gunwale: a jump clears it, and the sea drowns.)
          inp.jump = rnd.chance(0.08) && Math.abs(at.across) < 0.7;
          if (inp.jump && c.own!.player.onGround) jumps[i]!++;
          if (Math.hypot(target.along - at.along, target.across - at.across) < 0.3) {
            inp.forward = 0;
            return;
          }
          inp.yaw = toward(c, target.along, target.across);
          inp.forward = 1;
        };
      });
      h.runUntil(() => done.every((x) => x), 1200 * 600, 1);
      h.run(1000);
      clients.forEach((c, i) => {
        const who = `seed ${seed}, ${i === 0 ? LINK_0.name : LINK_150.name}`;
        const p = h.sim.players.get(c.key)!.player;
        expect(jumps[i], who).toBeGreaterThan(15);
        expect(c.correctionsSince(since), who).toEqual([]);
        expect(p.remote!.rejected - rejected0[i]!, who).toBe(0);
        expect(damage.get(c.key) ?? 0, who).toBe(0);
        expect(p.carrierId, who).toBe(shipId);
      });
    }
  }, 300_000);
});
