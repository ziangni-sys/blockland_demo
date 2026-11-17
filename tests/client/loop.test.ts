import { describe, expect, it } from 'vitest';
import { FixedStepClock, FrameLoop, MAX_FRAME_MS, MAX_TICKS_PER_FRAME, TICK_MS, type FrameScheduler } from '../../src/client/loop';

describe('FixedStepClock', () => {
  it('hands out whole ticks and keeps the remainder as alpha', () => {
    const c = new FixedStepClock();
    expect(TICK_MS).toBe(50);
    expect(c.advance(16, true)).toBe(0);
    expect(c.alpha).toBeCloseTo(16 / 50);
    expect(c.advance(16, true)).toBe(0);
    expect(c.advance(20, true)).toBe(1); // 52 ms
    expect(c.alpha).toBeCloseTo(2 / 50);
    let total = 1;
    for (let i = 0; i < 997; i++) total += c.advance(16, true);
    // 1000 frames of 16 ms = 16 s = 320 ticks (the first 52 ms already gave one)
    expect(total).toBe(Math.floor((52 + 997 * 16) / 50));
  });

  it('runs at most MAX_TICKS_PER_FRAME and drops the backlog', () => {
    const c = new FixedStepClock();
    expect(c.advance(240, true)).toBe(4);
    expect(c.advance(240, true)).toBe(MAX_TICKS_PER_FRAME); // 40 + 240 = 280 -> 5 (exact)
    const d = new FixedStepClock();
    const n = d.advance(MAX_FRAME_MS, true);
    expect(n).toBe(MAX_TICKS_PER_FRAME);
    // a huge frame is clamped first, then capped; nothing is owed afterwards
    const e = new FixedStepClock();
    expect(e.advance(10_000, true)).toBe(MAX_TICKS_PER_FRAME);
    expect(e.advance(10, true)).toBe(0);
  });

  it('never exceeds the cap whatever the frame times', () => {
    const c = new FixedStepClock();
    let seed = 7;
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const dt = (seed % 4000) / 10; // 0 .. 400 ms
      const n = c.advance(dt, true);
      expect(n).toBeLessThanOrEqual(MAX_TICKS_PER_FRAME);
      expect(c.alpha).toBeGreaterThanOrEqual(0);
      expect(c.alpha).toBeLessThan(1);
    }
  });

  it('does not accumulate while paused and keeps alpha frozen', () => {
    const c = new FixedStepClock();
    c.advance(30, true);
    const a = c.alpha;
    for (let i = 0; i < 100; i++) expect(c.advance(16, false)).toBe(0);
    expect(c.alpha).toBe(a);
    // resumes from the same remainder: 30 + 20 = 50 -> exactly one tick
    expect(c.advance(20, true)).toBe(1);
  });

  it('treats negative and NaN deltas as zero', () => {
    const c = new FixedStepClock();
    expect(c.advance(-100, true)).toBe(0);
    expect(c.advance(Number.NaN, true)).toBe(0);
    expect(c.alpha).toBe(0);
  });

  it('reset forgets the remainder', () => {
    const c = new FixedStepClock();
    c.advance(45, true);
    c.reset();
    expect(c.alpha).toBe(0);
    expect(c.advance(10, true)).toBe(0);
  });
});

class FakeScheduler implements FrameScheduler {
  t = 0;
  queue = new Map<number, () => void>();
  next = 1;
  request(cb: () => void): number {
    const h = this.next++;
    this.queue.set(h, cb);
    return h;
  }
  cancel(h: number): void {
    this.queue.delete(h);
  }
  now(): number {
    return this.t;
  }
  /** Advance time and run the pending frame callbacks. */
  frame(ms: number): void {
    this.t += ms;
    const cbs = [...this.queue.values()];
    this.queue.clear();
    for (const cb of cbs) {
      try {
        cb();
      } catch {
        // like a browser: an exception does not stop other callbacks
      }
    }
  }
}

describe('FrameLoop', () => {
  it('reports frame deltas, starting at 0', () => {
    const s = new FakeScheduler();
    const dts: number[] = [];
    const loop = new FrameLoop(s, (_now, dt) => dts.push(dt));
    loop.start();
    s.frame(16);
    s.frame(17);
    s.frame(20);
    expect(dts).toEqual([0, 17, 20]);
  });

  it('resetTimebase drops the hidden time', () => {
    const s = new FakeScheduler();
    const dts: number[] = [];
    const loop = new FrameLoop(s, (_now, dt) => dts.push(dt));
    loop.start();
    s.frame(16);
    loop.resetTimebase();
    s.frame(60_000);
    s.frame(16);
    expect(dts).toEqual([0, 0, 16]);
  });

  it('keeps running when a frame throws, and stops on stop()', () => {
    const s = new FakeScheduler();
    let n = 0;
    const loop = new FrameLoop(s, () => {
      n++;
      if (n === 2) throw new Error('boom');
    });
    loop.start();
    s.frame(16);
    s.frame(16);
    s.frame(16);
    expect(n).toBe(3);
    loop.stop();
    expect(loop.isRunning).toBe(false);
    s.frame(16);
    expect(n).toBe(3);
  });
});
