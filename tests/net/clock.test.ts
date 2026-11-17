/**
 * Package 5: ServerClock (NETCODE section 4). Under jitter, loss and bursts of catch-up batches the
 * arrival timeline never runs backwards and D converges to the formula's value; renderTick never
 * passes the newest applied batch while the reliable channel is stalled behind a retransmission
 * and samples keep arriving; rotorLead follows the move ack (and the tick the server applies a
 * report at is the rotorTick the client had when it sent it). After a host stall longer than the
 * 2 s window the arrival timeline jumps back once, renderTick does not, and the clock is usable
 * again within a second.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { lossTicks, ServerClock } from '../../src/net/client/clock';
import { LoopbackNet } from '../../src/net/loopback';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { link, ShimServer, ShimWorld } from './shim';

interface Arrival {
  at: number;
  tick: number;
  seq: number | null;
}

/**
 * Synthetic traffic: a server ticking every 50 ms (or waking every `wakeMs` and running up to
 * `burst` ticks, the rest of the time lost), a batch per tick on a channel with `latency` + U(0,
 * `jitter`) ms, and a Samples message per tick lost with probability `loss`.
 */
function traffic(o: { ms: number; latency: number; jitter: number; loss: number; wakeMs?: number; burst?: number; seed?: number }): Arrival[] {
  const rng = new Rng(o.seed ?? 1);
  const out: Arrival[] = [];
  const wake = o.wakeMs ?? 50;
  const burst = o.burst ?? 1;
  let tick = 0;
  let seq = 0;
  let lastBatch = 0;
  for (let t = 0; t < o.ms; t += wake) {
    const n = Math.min(burst, Math.max(1, Math.round(wake / 50)));
    for (let i = 0; i < n; i++) {
      tick++;
      // Reliable: in order (a batch never overtakes the previous one).
      lastBatch = Math.max(lastBatch, t + o.latency + rng.next() * o.jitter);
      out.push({ at: lastBatch, tick, seq: null });
      const s = seq++;
      if (rng.next() >= o.loss) out.push({ at: t + o.latency + rng.next() * o.jitter, tick, seq: s });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Feed arrivals and run frames every `frameMs`; check monotony at every query. */
function drive(clock: ServerClock, arrivals: Arrival[], ms: number, frameMs = 1000 / 60): { renderBack: number; arrivalBack: number; overApplied: number; frames: number; dHistory: number[] } {
  let i = 0;
  let newest = -1;
  let lastArrival = -Infinity;
  let lastRender = -Infinity;
  const r = { renderBack: 0, arrivalBack: 0, overApplied: 0, frames: 0, dHistory: [] as number[] };
  for (let now = 0; now < ms; now += frameMs) {
    while (i < arrivals.length && arrivals[i]!.at <= now) {
      const a = arrivals[i++]!;
      clock.arrival(a.tick, a.at, a.seq);
      if (a.seq === null) newest = Math.max(newest, a.tick);
      const v = clock.arrivalTick(a.at);
      if (v < lastArrival) r.arrivalBack++;
      lastArrival = v;
    }
    clock.frame(now, newest);
    const v = clock.arrivalTick(now);
    if (v < lastArrival) r.arrivalBack++;
    lastArrival = v;
    if (clock.renderTick < lastRender) r.renderBack++;
    if (clock.renderTick > newest) r.overApplied++;
    lastRender = clock.renderTick;
    r.frames++;
    if (r.frames % 60 === 0) r.dHistory.push(clock.D);
  }
  return r;
}

describe('ServerClock (package 5)', () => {
  it('lossTicks follows section 4: 5% -> 1, 20% -> 2, 1% or less -> 0', () => {
    expect(lossTicks(0)).toBe(0);
    expect(lossTicks(0.01)).toBe(0);
    expect(lossTicks(0.05)).toBe(1);
    expect(lossTicks(0.2)).toBe(2);
  });

  it('a local Worker (1 ms, 2 ms jitter): D settles at the floor, arrivalTick tracks the server', () => {
    const clock = new ServerClock();
    const r = drive(clock, traffic({ ms: 20_000, latency: 1, jitter: 2, loss: 0 }), 20_000);
    expect(r.arrivalBack).toBe(0);
    expect(r.renderBack).toBe(0);
    expect(r.overApplied).toBe(0);
    expect(clock.D).toBeCloseTo(1.2, 5);
    // Tick k leaves at (k - 1) * 50 ms: the server's tick at 20 s is 401; one-way delay 1 ms (0.02 ticks).
    expect(Math.abs(clock.arrivalTick(20_000) - 400.98)).toBeLessThan(0.1);
  });

  it('150 ms round trip, 20 ms jitter, 5% loss: never backwards, D converges near 1 + 2 * jitter + 1', () => {
    const clock = new ServerClock();
    const r = drive(clock, traffic({ ms: 30_000, latency: 75, jitter: 20, loss: 0.05, seed: 7 }), 30_000);
    expect(r.arrivalBack).toBe(0);
    expect(r.renderBack).toBe(0);
    expect(r.overApplied).toBe(0);
    // Mean deviation of U(0, 20 ms) from its minimum is about 10 ms = 0.2 ticks: D = 1 + 0.4 + 1.
    const late = r.dHistory.slice(-10);
    for (const d of late) expect(d).toBeGreaterThan(2.1);
    for (const d of late) expect(d).toBeLessThan(2.8);
    expect(Math.max(...late) - Math.min(...late)).toBeLessThan(0.3);
    expect(clock.lossRate).toBeGreaterThan(0.02);
    expect(clock.lossRate).toBeLessThan(0.09);
  });

  it('20% loss and 60 ms jitter: D grows to the formula (capped at 8), still monotone', () => {
    const clock = new ServerClock();
    const r = drive(clock, traffic({ ms: 30_000, latency: 100, jitter: 60, loss: 0.2, seed: 3 }), 30_000);
    expect(r.arrivalBack + r.renderBack + r.overApplied).toBe(0);
    const d = r.dHistory.at(-1)!;
    // 1 + 2 * (about 0.6 ticks) + 2 (or 3 when the measured loss passes 21.5%).
    expect(d).toBeGreaterThan(3.5);
    expect(d).toBeLessThan(5.6);
  });

  it('a throttled host waking once a second with 5 catch-up ticks: never backwards, renderTick never past the newest batch', () => {
    const clock = new ServerClock();
    const r = drive(clock, traffic({ ms: 30_000, latency: 40, jitter: 10, loss: 0, wakeMs: 1000, burst: 5 }), 30_000);
    expect(r.arrivalBack).toBe(0);
    expect(r.renderBack).toBe(0);
    expect(r.overApplied).toBe(0);
    // Then the host recovers (normal ticks again from tick 151 on): the clock follows without going back.
    const later = traffic({ ms: 10_000, latency: 40, jitter: 10, loss: 0 }).map((a) => ({ ...a, at: a.at + 30_000, tick: a.tick + 150 }));
    let lastArrival = clock.arrivalTick(30_000);
    let newest = 150;
    let back = 0;
    let i = 0;
    for (let now = 30_000; now < 40_000; now += 1000 / 60) {
      while (i < later.length && later[i]!.at <= now) {
        const a = later[i++]!;
        clock.arrival(a.tick, a.at, a.seq);
        if (a.seq === null) newest = Math.max(newest, a.tick);
      }
      clock.frame(now, newest);
      const v = clock.arrivalTick(now);
      if (v < lastArrival) back++;
      lastArrival = v;
    }
    expect(back).toBe(0);
    // Caught up: the server's tick at 40 s is 351, 40 ms (0.8 ticks) away.
    expect(Math.abs(clock.arrivalTick(40_000) - 350.2)).toBeLessThan(0.3);
  });

  it('a host that stalls for a minute and resumes without the missed ticks: the clock is back within a second, rotorLead measured again', () => {
    // The server runs a tick every 50 ms, stops at 10 s for 60 s, runs 5 catch-up ticks and goes on
    // normally. 40 ms each way. The client sends a movement report every 50 ms (also during the
    // stall: the page keeps running); each batch acks the newest report that reached the server.
    const clock = new ServerClock();
    const ONE_WAY = 40;
    const tickTimes: number[] = [];
    for (let k = 1; k * 50 <= 10_000; k++) tickTimes.push(k * 50);
    for (let k = 0; k < 5; k++) tickTimes.push(70_000);
    for (let t = 70_050; t <= 85_000; t += 50) tickTimes.push(t);
    const reports: number[] = []; // send time by seq
    let nextTick = 0;
    let newest = -1;
    let lastRender = -Infinity;
    let lastArrival = -Infinity;
    const s = { renderBack: 0, overApplied: 0, arrivalBack: 0, clamped: 0, framesAfter: 0, worstRotor: 0, worstArrival: 0 };
    const pendingBatches: Array<{ at: number; tick: number; ack: number }> = [];
    let nextReport = 0;
    for (let now = 0; now < 85_000; now += 1000 / 60) {
      // Server ticks up to now (their batches and samples leave then).
      while (nextTick < tickTimes.length && tickTimes[nextTick]! <= now) {
        const at = tickTimes[nextTick]!;
        let ack = -1;
        for (let q = reports.length - 1; q >= 0; q--) if (reports[q]! + ONE_WAY <= at) { ack = q; break; }
        nextTick++;
        pendingBatches.push({ at: at + ONE_WAY, tick: nextTick, ack });
      }
      while (pendingBatches.length > 0 && pendingBatches[0]!.at <= now) {
        const b = pendingBatches.shift()!;
        clock.arrival(b.tick, b.at, null);
        clock.arrival(b.tick, b.at, b.tick);
        newest = b.tick;
        if (b.ack >= 0) clock.moveAck(b.ack, b.tick);
      }
      clock.frame(now, newest);
      if (clock.isSynced && now >= nextReport) {
        nextReport = now + 50;
        clock.moveSent(reports.length, now);
        reports.push(now);
      }
      const v = clock.arrivalTick(now);
      if (v < lastArrival) s.arrivalBack++;
      lastArrival = v;
      if (clock.renderTick < lastRender) s.renderBack++;
      if (clock.renderTick > newest) s.overApplied++;
      lastRender = clock.renderTick;
      const serverTick = 205 + (now - 70_000) / 50; // after the stall: the server's tick at `now` (fractional)
      // From the first frame after the resumed batches arrived, the rotors are where the server
      // will take a report sent now: reports stamped before the jump do not measure rotorLead.
      if (now >= 70_000 + ONE_WAY + 20) s.worstRotor = Math.max(s.worstRotor, Math.abs(clock.rotorTick - (serverTick + ONE_WAY / 50)));
      if (now >= 71_000) {
        // A second after the host resumed: interpolating again.
        s.framesAfter++;
        if (clock.renderTick >= newest) s.clamped++;
        s.worstArrival = Math.max(s.worstArrival, Math.abs(v - (serverTick - ONE_WAY / 50)));
      }
    }
    expect(s.renderBack).toBe(0);
    expect(s.overApplied).toBe(0);
    // The one jump back, when the host resumed.
    expect(s.arrivalBack).toBe(1);
    expect(s.clamped).toBe(0);
    expect(s.worstArrival).toBeLessThan(1);
    expect(s.worstRotor).toBeLessThan(1.5);
  });

  it('a latency step up and down: D and arrivalTick follow, never backwards', () => {
    const clock = new ServerClock();
    const a1 = traffic({ ms: 10_000, latency: 30, jitter: 5, loss: 0 });
    const a2 = traffic({ ms: 10_000, latency: 600, jitter: 5, loss: 0 }).map((a) => ({ ...a, at: a.at + 10_000, tick: a.tick + 200 }));
    const a3 = traffic({ ms: 10_000, latency: 30, jitter: 5, loss: 0 }).map((a) => ({ ...a, at: a.at + 20_000, tick: a.tick + 400 }));
    const r = drive(clock, [...a1, ...a2, ...a3].sort((x, y) => x.at - y.at), 30_000);
    expect(r.arrivalBack + r.renderBack + r.overApplied).toBe(0);
    expect(Math.abs(clock.arrivalTick(30_000) - (601 - 0.6))).toBeLessThan(0.2);
  });
});

describe('ServerClock on a real connection (package 5)', () => {
  function world(): ShimWorld {
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: true, loadRadius: 3, spawn: { x: 0.5, y: 35, z: 0.5 } });
    return new ShimWorld(new ShimServer(new LoopbackNet(), sim));
  }

  it('reliable retransmissions stall the batches while samples keep coming: renderTick never passes the newest applied batch', () => {
    const w = world();
    // Something moving all the time: a bot walking in circles (samples every tick).
    const bot = w.server.sim.join('bot');
    bot.player.input.forward = 1;
    let turn = 0;
    w.onTick = () => {
      bot.player.input.yaw += 0.05;
      turn++;
    };
    const a = w.add({ key: 'a', viewRadius: 3, up: link(60, 10, 0, 5), down: link(60, 10, 0.08, 6, { rtoMs: 700 }) });
    w.runUntil(() => a.net.status === 'ready');
    const s = { frames: 0, capped: 0, over: 0, aheadSamples: 0, back: 0 };
    let last = -Infinity;
    a.onFrame = (now) => {
      const r = a.replica!;
      const clock = a.net.clock!;
      s.frames++;
      if (clock.renderTick > r.state.tick) s.over++;
      if (clock.renderTick < last) s.back++;
      last = clock.renderTick;
      if (clock.arrivalTick(now) - clock.D > r.state.tick + 0.5) s.capped++;
      const bot = r.state.entities.get(w.server.sim.players.get('bot')!.entityId);
      if (bot !== undefined && bot.poseTick > r.state.tick) s.aheadSamples++;
    };
    w.run(30_000);
    expect(turn).toBeGreaterThan(500);
    expect(s.over).toBe(0);
    expect(s.back).toBe(0);
    // The stalls happened: frames where the timeline was ahead of the applied batches, samples newer than them.
    expect(s.capped).toBeGreaterThan(20);
    expect(s.aheadSamples).toBeGreaterThan(20);
    a.expectClean();
  }, 60_000);

  it('rotorLead follows the move ack: rotorTick at sending equals the tick the server takes the report', () => {
    const w = world();
    const a = w.add({ key: 'a', viewRadius: 2, up: link(75, 10, 0, 7), down: link(75, 10, 0, 8) });
    w.runUntil(() => a.net.status === 'ready');
    // A movement report every 50 ms (package 6's client tick); remember rotorTick at each.
    let seq = 0;
    const sentAt = new Map<number, number>();
    let next = w.net.now;
    const prevFrame = a.onFrame;
    a.onFrame = (now) => {
      prevFrame?.(now);
      if (now < next) return;
      next += 50;
      const clock = a.net.clock!;
      sentAt.set(seq, clock.rotorTick);
      a.net.sendMoveReport({ seq, epoch: 1, viewTick: Math.floor(clock.renderTick), carrierId: 0, pos: { x: 0.5, y: 35, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, sneaking: false, sprinting: false, flying: false, forward: 0, strafe: 0, sneak: false, landings: 0 });
      seq++;
    };
    const before = a.net.clock!.rotorLead;
    w.run(10_000);
    const clock = a.net.clock!;
    const conn = w.server.live('a')!;
    const errs: number[] = [];
    for (const [s, tick] of conn.acceptedAt) if (s > seq - 100 && sentAt.has(s)) errs.push(sentAt.get(s)! - tick);
    expect(errs.length).toBeGreaterThan(50);
    const mean = errs.reduce((x, y) => x + y, 0) / errs.length;
    expect(Math.abs(mean)).toBeLessThan(0.6);
    expect(Math.max(...errs.map(Math.abs))).toBeLessThan(1.6);
    // Measured, not the default rtt * TPS / 1000 + 1.5.
    expect(Math.abs(clock.rotorLead - before)).toBeGreaterThan(0.3);
    // The uplink gets slower by 200 ms: the lead follows within a few seconds.
    a.links.up.latencyMs = 275;
    w.run(8000);
    const errs2: number[] = [];
    for (const [s, tick] of conn.acceptedAt) if (s > seq - 60 && sentAt.has(s)) errs2.push(sentAt.get(s)! - tick);
    const mean2 = errs2.reduce((x, y) => x + y, 0) / errs2.length;
    expect(Math.abs(mean2)).toBeLessThan(0.6);
  }, 60_000);
});
