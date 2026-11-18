import { describe, expect, it } from 'vitest';
import { FrameLoop, type FrameScheduler } from '../../src/client/loop';

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
