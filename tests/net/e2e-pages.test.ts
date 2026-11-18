/**
 * End to end, the page's states (NETCODE sections 4 and 5):
 *  - a guest whose page is hidden for a while (no frames): NetClient applies every batch in the
 *    message handler, nothing piles up, Pings go on (no stall hint, no timeout); when the page
 *    returns, frames pick up where the replica is and ships are shown where the server had them
 *    (on each of the three links of e2e-scenes.ts);
 *  - single-player pause (one local client, the room closed): the page pauses its client, then
 *    the server; for a minute nothing moves on either side (server ticks, ships, rotors, entities
 *    as shown); resuming the server, then the client, everything moves on and stays equal.
 */
import { describe, expect, it } from 'vitest';
import { vec3, type Quat, type Vec3 } from '../../src/core/math';
import { Rotor, Ship } from '../../src/structures/structure';
import { NetHarness, testMeta, type HeadlessClient } from './harness';
import { exampleBoat, island, launchBoat, LINKS, lossOf, SEA, SEA_TOP, spinningWindmill, untilShipsRest, watchShipPoses } from './e2e-scenes';

/** What a client shows now: every structure's display pose and every entity at renderTick. */
function shown(c: HeadlessClient): string {
  const r = c.replica!;
  const clock = c.net.clock!;
  const out: string[] = [`render ${clock.renderTick}`];
  const f = (v: Vec3 | Quat): string => Object.values(v).map((x: number) => x.toFixed(9)).join(',');
  for (const s of r.structures()) out.push(`${s.kind} ${s.id} ${f(s.grid.position)} ${f(s.grid.rotation)}`);
  for (const e of r.entities(clock.renderTick)) out.push(`entity ${e.id} ${f(e.pos)} ${e.yaw.toFixed(9)}`);
  return out.join('\n');
}

describe.each(LINKS)('a hidden page end to end over $name', ({ make }) => {
  it('a guest\'s page hidden for 30 s while a boat sails: batches applied as they arrive, then frames resume', async () => {
    const h = new NetHarness({ history: true, rabbits: true });
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    const boat = exampleBoat(sim);
    const bot = sim.join('bot');
    const host = h.addClient('host', {}, { local: true, viewRadius: 4 });
    h.runUntil(() => host.ready);
    launchBoat(h, boat, bot);
    bot.player.input.forward = 1;
    bot.player.input.strafe = 0.5;
    await h.host.control({ type: 'openRoom' });
    const conds = make(21);
    const lossy = lossOf(conds) > 0.1;
    const g = h.addClient('guest', conds, { viewRadius: 4 });
    h.track(g);
    h.runUntil(() => g.ready, 20_000);
    h.run(2000);
    g.hidden = true;
    const frames = g.frames;
    const worst = { waiting: 0, lag: 0, hint: 0 };
    h.onTick = () => {
      worst.waiting = Math.max(worst.waiting, g.net.waiting);
      worst.lag = Math.max(worst.lag, sim.ticks - g.state!.tick);
      if (g.net.stall(h.net.now) !== null) worst.hint++;
    };
    h.run(30_000);
    expect(g.frames).toBe(frames);
    expect(worst.waiting).toBe(0);
    expect(worst.lag).toBeLessThan(15); // the link's delay and its retransmissions, never a pile
    expect(worst.hint).toBe(0);
    expect(g.closed).toBe(false);
    expect(g.net.connectionCount).toBe(1);
    // The page comes back.
    h.onTick = null;
    g.hidden = false;
    let back = Infinity;
    g.onFrame = () => {
      const rt = g.net.clock!.renderTick;
      if (back !== Infinity) expect(rt).toBeGreaterThanOrEqual(back);
      back = rt;
    };
    h.run(1000);
    const poses = watchShipPoses(h, g);
    h.run(5000);
    expect(g.frames).toBeGreaterThan(frames + 300);
    expect(poses.frames).toBeGreaterThan(250);
    // As in e2e-join: lost samples hold the ship at the one before (section 7).
    expect(poses.exact / poses.frames).toBeGreaterThan(lossy ? 0.5 : 0.8);
    expect(g.mismatches.slice(0, 5)).toEqual([]);
    expect(g.checked).toBeGreaterThan(700);
    bot.player.input.forward = 0;
    bot.player.input.strafe = 0;
    untilShipsRest(h);
    h.quiesce();
    expect(h.compareNow(g)).toEqual([]);
  }, 120_000);
});

describe('single-player pause end to end', () => {

  it('single-player pause: the client, then the server; nothing moves on either side for a minute; resume', async () => {
    const h = new NetHarness({ rabbits: true });
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    const boat = exampleBoat(sim);
    const ix = boat.helm.x < 0 ? 20 : -40;
    island(sim, ix, -12, ix + 20, 12);
    for (let i = 0; i < 4; i++) sim.entities.spawnRabbit(ix + 4.5 + i, SEA_TOP, 3.5);
    const bot = sim.join('bot');
    const me = h.addClient('me', {}, { local: true, viewRadius: 5 });
    h.track(me);
    h.runUntil(() => me.ready);
    const windmill = spinningWindmill(sim, ix + 14, 0);
    const { ship } = launchBoat(h, boat, bot);
    bot.player.input.forward = 1;
    bot.player.input.strafe = 0.5;
    h.run(3000);
    // The pause menu opens: the client first, then the server (host control).
    me.net.setPaused(true);
    await h.host.control({ type: 'pause', paused: true });
    expect(h.host.paused).toBe(true);
    h.run(200); // the batches already on their way
    const ticks = sim.ticks;
    const serverPose = { ...ship.grid.position };
    const angle = windmill.angle;
    const before = shown(me);
    let moved = 0;
    me.onFrame = () => {
      if (shown(me) !== before) moved++;
    };
    h.run(60_000);
    expect(sim.ticks).toBe(ticks);
    expect(ship.grid.position).toEqual(serverPose);
    expect(windmill.angle).toBe(angle);
    expect(me.frames).toBeGreaterThan(3000); // the page kept drawing
    expect(moved).toBe(0);
    expect(me.closed).toBe(false);
    // Resume: the server first, then the client (its clock starts over).
    me.onFrame = null;
    await h.host.control({ type: 'pause', paused: false });
    me.net.setPaused(false);
    const shipAt = vec3(ship.grid.position.x, 0, ship.grid.position.z);
    h.run(3000);
    expect(sim.ticks).toBeGreaterThan(ticks + 55);
    expect(Math.hypot(ship.grid.position.x - shipAt.x, ship.grid.position.z - shipAt.z)).toBeGreaterThan(1);
    expect(shown(me)).not.toBe(before);
    const rs = me.replica!.structures();
    expect(rs.some((s) => s instanceof Ship) && rs.some((s) => s instanceof Rotor)).toBe(true);
    expect(me.net.clock!.renderTick).toBeGreaterThan(ticks);
    expect(me.mismatches.slice(0, 5)).toEqual([]);
    bot.player.input.forward = 0;
    bot.player.input.strafe = 0;
    h.quiesce();
    expect(h.compareNow(me)).toEqual([]);
  }, 120_000);
});
