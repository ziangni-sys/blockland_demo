/**
 * Acceptance scenario 33 (docs/ACCEPTANCE.md; NETCODE section 16): two players place and mine at
 * the same time in the same chunk, and in the end both clients have the server's world.
 *
 * Two clients — the host on a 30 ms round trip, a guest on 120 ms with 5% loss — each act like a
 * person at random (fixed seeds) for 30 s in the same 16 x 16 area (chunk 0, 0): every few hundred
 * milliseconds a block within reach, on top of a column, is mined or gets a block of a random kind
 * placed on it, by intents alone, without waiting for the server. The changed columns are compared
 * with the server after every tick each client applies (NetHarness.track); after quiesce() both
 * replicas equal the server in full.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { PY } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { link, type HeadlessClient } from './harness';
import { LAND, LAND_TOP, ownWorld, stat } from './own-scenes';

const T = LAND_TOP;
const ITEMS = [B.COBBLE, B.PLANKS_OAK, B.GLASS, B.BRICKS];

interface Tally {
  actions: number;
  places: number;
  mines: number;
  skipped: number;
}

/** From now on `c` acts at random every 150..400 ms (its own seed) inside x, z 0..15, until stop() is called. */
function actor(c: HeadlessClient, seed: number, others: () => HeadlessClient[]): { tally: Tally; stop: () => void } {
  const rng = new Rng(seed);
  const tally: Tally = { actions: 0, places: 0, mines: 0, skipped: 0 };
  let next = 0;
  let stopped = false;
  const prev = c.onFrame;
  c.onFrame = (now) => {
    prev?.(now);
    if (stopped || c.intents === null || c.own === null || now < next) return;
    next = now + rng.range(150, 400);
    const w = c.replica!.world;
    const me = c.own.player.pos;
    // A column within reach of the eyes, not next to a player's feet, whose top can be aimed at (a few tries).
    for (let tries = 0; tries < 4; tries++) {
      const x = Math.floor(me.x) + rng.int(-3, 3);
      const z = Math.floor(me.z) + rng.int(-3, 3);
      if (x < 0 || x > 15 || z < 0 || z > 15) continue;
      const near = [c, ...others()].some((o) => o.own !== null && Math.abs(o.own.player.pos.x - (x + 0.5)) < 1.4 && Math.abs(o.own.player.pos.z - (z + 0.5)) < 1.4);
      if (near) continue;
      let y = T + 3;
      while (y >= T - 3 && (w.getCell(x, y, z) & ID_MASK) === B.AIR) y--;
      if (y < T - 3) continue;
      const place = rng.chance(0.5) ? y < T + 3 : y < T - 2;
      if (!c.aimAt(x, y, z, PY, 0, !place)) continue;
      tally.actions++;
      if (place) {
        c.hold(ITEMS[rng.int(0, ITEMS.length - 1)]!);
        c.use(false);
        tally.places++;
      } else {
        c.emptyHand();
        c.attack();
        tally.mines++;
      }
      return;
    }
    tally.skipped++;
  };
  return { tally, stop: () => (stopped = true) };
}

describe('33. two players place and mine in the same chunk at once', () => {
  it('30 s, host on 30 ms, guest on 120 ms with 5% loss: the changed columns equal the server\'s after every tick; in full at the end', async () => {
    const r = await ownWorld(LAND, 'creative', { up: link(15, 0, 0, 33), down: link(15, 0, 0, 34) });
    const { h, sim } = r;
    await h.host.control({ type: 'openRoom' });
    const a = r.c;
    const b = h.addClient('b', { up: link(60, 0, 0.05, 35), down: link(60, 0, 0.05, 36) }, { viewRadius: 3 });
    h.runUntil(() => b.ready && b.intents !== null, 30_000);
    sim.players.get('p')!.teleport(5.5, T, 8.5);
    sim.players.get('b')!.teleport(10.5, T, 8.5);
    h.run(1500);
    h.track(a);
    h.track(b);
    let placed = 0;
    let broken = 0;
    sim.events.on((e) => {
      if (e.type === 'blockPlaced') placed++;
      else if (e.type === 'blockBroken') broken++;
    });
    const ra = actor(a, 3301, () => [b]);
    const rb = actor(b, 3302, () => [a]);
    h.run(30_000);
    ra.stop();
    rb.stop();
    h.quiesce();
    expect(a.mismatches).toEqual([]);
    expect(b.mismatches).toEqual([]);
    expect(a.checked).toBeGreaterThan(500);
    expect(b.checked).toBeGreaterThan(500);
    expect(h.compareNow(a)).toEqual([]);
    expect(h.compareNow(b)).toEqual([]);
    expect(placed).toBeGreaterThan(40);
    expect(broken).toBeGreaterThan(40);
    stat(
      `33: ${placed} blocks placed, ${broken} broken in 30 s; host ${JSON.stringify(ra.tally)}, guest ${JSON.stringify(rb.tally)}; ` +
        `ticks compared ${a.checked} / ${b.checked}; stale targets refused: host ${h.intentStats('p')!.failed.cell}, guest ${h.intentStats('b')!.failed.cell}`,
    );
  }, 300_000);
});
