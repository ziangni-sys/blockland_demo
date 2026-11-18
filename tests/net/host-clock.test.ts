/**
 * Package 8: the server's clock (NETCODE section 4, scenario 37's server side): ticks on their
 * target times, catch-up of at most MAX_CATCHUP_TICKS with the rest dropped, the measured TPS over
 * the last 2 s of wall time in the globals, pause and resume only while the room is closed, the
 * clock starting at the first accepted Hello, chunk generation between ticks within its budget,
 * autosave every AUTOSAVE_TICKS simulated ticks.
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_BUDGET_MS, ServerHost, TICK_MS, TPS_WINDOW_MS, type HostClock } from '../../src/net/host/host';
import { AUTOSAVE_TICKS, MAX_CATCHUP_TICKS } from '../../src/net/protocol';
import { MemoryStorage } from '../../src/save/storage';
import { NetHarness, testMeta, FLAT } from './harness';

/** Server tick -> virtual time it ran at. */
function tickTimes(h: NetHarness): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const prev = h.host.onTick;
  h.host.onTick = () => {
    prev?.();
    out.push([h.sim.ticks, h.net.now]);
  };
  return out;
}

describe('the server clock (package 8)', () => {
  it('starts at the first accepted Hello, then ticks every 50 ms on target (no drift)', async () => {
    const h = new NetHarness();
    await h.create();
    const t0 = h.sim.ticks;
    h.run(1000);
    expect(h.sim.ticks).toBe(t0);
    h.addRawClient('guest'); // refused: the room is closed
    h.run(1000);
    expect(h.sim.ticks).toBe(t0);
    const times = tickTimes(h);
    h.addClient('a', {}, { local: true });
    h.run(10_000);
    expect(times.length).toBe(201);
    const start = times[0]![1];
    times.forEach(([, at], i) => expect(at).toBeCloseTo(start + i * TICK_MS, 6));
  });

  it(`a late wake-up runs at most ${MAX_CATCHUP_TICKS} ticks; the time beyond is dropped and the phase kept`, async () => {
    const h = new NetHarness();
    await h.create();
    h.addClient('a', {}, { local: true });
    h.run(500);
    const times = tickTimes(h);
    const phase = h.net.now % TICK_MS;
    h.stallServer(3000); // the timer is held for 3 s
    expect(times.length).toBe(0);
    h.run(1);
    const burst = times.filter(([, at]) => at === times[0]![1]);
    expect(burst.length).toBe(MAX_CATCHUP_TICKS);
    const before = times.length;
    h.run(1000);
    expect(times.length - before).toBeGreaterThanOrEqual(19);
    expect(times.length - before).toBeLessThanOrEqual(20);
    for (const [, at] of times.slice(before)) expect(((at % TICK_MS) - phase + TICK_MS) % TICK_MS).toBeCloseTo(0, 6);
  });

  it('woken only once a second (a background page): 5 ticks per wake-up, TPS < 15 in the globals within 3 s, back to 20 when it runs normally', async () => {
    const h = new NetHarness();
    await h.create();
    const a = h.addClient('a', {}, { local: true });
    h.run(3000);
    expect(a.state!.tps).toBe(20);
    const times = tickTimes(h);
    const throttledAt = h.net.now;
    h.wakeEveryMs = 1000;
    let lowAt: number | null = null;
    for (let i = 0; i < 300 && lowAt === null; i++) {
      h.run(10);
      if (a.state!.tps !== null && a.state!.tps < 15) lowAt = h.net.now;
    }
    expect(lowAt).not.toBeNull();
    expect(lowAt! - throttledAt).toBeLessThan(3000);
    h.run(6000);
    const late = times.filter(([, at]) => at > h.net.now - 4000);
    const byWake = new Map<number, number>();
    for (const [, at] of late) byWake.set(at, (byWake.get(at) ?? 0) + 1);
    expect([...byWake.values()].every((n) => n === MAX_CATCHUP_TICKS)).toBe(true);
    expect(h.host.tps).toBe(5);
    expect(a.state!.tps).toBe(5);
    expect(h.reports.some((r) => r.type === 'status' && r.tps === 5)).toBe(true);
    h.wakeEveryMs = 0;
    h.run(4000);
    expect(h.host.tps).toBe(20);
    expect(a.state!.tps).toBe(20);
  });

  it('timers that fire a little late every time: from the first tick on, TPS is exactly 20 (never 20.5 or 19.9), one TPS in the globals, one status report', async () => {
    const h = new NetHarness();
    await h.create();
    h.timerLateMs = 5;
    const seen: number[] = [];
    h.host.onTick = () => seen.push(h.host.tps);
    const a = h.addClient('a', {}, { local: true });
    const globalsTps: number[] = [];
    a.onBatch = (b) => {
      if (b.globals?.tps !== undefined) globalsTps.push(b.globals.tps);
    };
    h.run(13_000);
    expect(seen.length).toBeGreaterThan(250); // late wake-ups still tick 20 times a second (drift corrected)
    expect(new Set(seen)).toEqual(new Set([20]));
    expect(globalsTps).toEqual([20]); // the first batch (section 18), never again
    expect(h.reports.filter((r) => r.type === 'status')).toEqual([{ type: 'status', tps: 20, players: 1 }]);
  });

  it.each([
    [2500, 2.5], // one wake-up of 5 ticks in the 2 s window (a 1 s window would say 5, a 3 s one 1.7)
    [700, 7.5], // three wake-ups of 5 ticks (a 1 s window would say 10, a 3 s one 8.3)
  ])(`the measured TPS counts the last ${TPS_WINDOW_MS} ms of wall time: woken every %i ms it is %f`, async (every, tps) => {
    const h = new NetHarness();
    await h.create();
    const a = h.addClient('a', {}, { local: true });
    h.run(1000);
    h.wakeEveryMs = every;
    h.run(8000);
    const seen: number[] = [];
    h.host.onTick = () => seen.push(h.host.tps);
    h.run(6000);
    expect(new Set(seen)).toEqual(new Set([tps]));
    expect(a.state!.tps).toBe(tps);
  });

  it('pause stops the ticks only while the room is closed; resume goes on from now; opening the room resumes', async () => {
    const h = new NetHarness();
    await h.create();
    const a = h.addRawClient('a', {}, { local: true });
    h.run(500);
    await h.host.control({ type: 'pause', paused: true });
    const t = h.sim.ticks;
    h.run(5000);
    expect(h.sim.ticks).toBe(t);
    a.send({ type: 'ping', clientMs: 1 });
    h.run(10);
    expect(a.pongs.at(-1)?.tick).toBe(t); // connections are still served
    await h.host.control({ type: 'pause', paused: false });
    h.run(1000);
    expect(h.sim.ticks - t).toBeGreaterThanOrEqual(20); // no catch-up of the paused time
    expect(h.sim.ticks - t).toBeLessThanOrEqual(21);
    expect(h.host.tps).toBe(20);
    await h.host.control({ type: 'openRoom' });
    await h.host.control({ type: 'pause', paused: true });
    expect(h.host.paused).toBe(false);
    expect(h.reports.at(-1)).toMatchObject({ type: 'error', what: 'pause' });
    await h.host.control({ type: 'closeRoom' });
    await h.host.control({ type: 'pause', paused: true });
    expect(h.host.paused).toBe(true);
    await h.host.control({ type: 'openRoom' });
    expect(h.host.paused).toBe(false);
    const t2 = h.sim.ticks;
    h.run(500);
    expect(h.sim.ticks).toBeGreaterThan(t2);
  });

  it('chunk generation between ticks: the budget in columns is kept; the joined player gets its simulation radius', async () => {
    const h = new NetHarness({ chunkColumns: 3 });
    await h.create();
    h.addClient('a', {}, { local: true, viewRadius: 6 });
    const counts: number[] = [];
    const prev = h.host.onTick;
    h.host.onTick = () => {
      prev?.();
      counts.push(h.sim.world.chunks.size);
    };
    h.run(3000);
    for (let i = 1; i < counts.length; i++) expect(counts[i]! - counts[i - 1]!).toBeLessThanOrEqual(3);
    // r = 6: the 137 columns with dx^2 + dz^2 <= 42.
    expect(h.sim.world.chunks.size).toBe(137);
  });

  it('chunk generation by time: it stops when the budget in ms is used up', async () => {
    let t = 0;
    const clock: HostClock = { now: () => (t += 1), epochMs: () => 0, setTimer: () => 0, clearTimer: () => {} };
    const host = new ServerHost({ clock, openStorage: async () => ({ storage: new MemoryStorage(), persistent: true }), report: () => {}, rabbits: false });
    await host.control({ type: 'create', meta: testMeta(), options: { generator: FLAT, exampleShip: false } });
    host.sim.join('a').viewRadius = 8;
    host.sim.tick(); // sets the anchors
    const before = host.sim.world.chunks.size;
    host.generateChunks();
    const made = host.sim.world.chunks.size - before;
    // One clock reading per column plus the first: CHUNK_BUDGET_MS - 1 columns.
    expect(made).toBe(CHUNK_BUDGET_MS - 1);
  });

  it(`autosave every ${AUTOSAVE_TICKS} simulated ticks; paused time does not count`, async () => {
    const h = new NetHarness();
    await h.create();
    await h.settle();
    const saves = (): number => h.reports.filter((r) => r.type === 'saved' && r.ok).length;
    expect(saves()).toBe(1); // the new world was saved at once
    h.addClient('a', {}, { local: true });
    h.run(29_000);
    await h.settle();
    expect(saves()).toBe(1);
    h.host.pause(true);
    h.run(60_000);
    await h.settle();
    expect(saves()).toBe(1);
    h.host.pause(false);
    h.run(1_200);
    await h.settle();
    expect(saves()).toBe(2);
  });
});
