/**
 * The frame loop. DOM-free: the browser's requestAnimationFrame is injected (FrameScheduler) so it
 * is unit-tested in Node. The game has no fixed tick of its own: the server ticks (in its Worker),
 * the client's own player steps at the server's pace (net/client/predict.ts), and a frame shows
 * whatever the replica holds for it.
 */

/** requestAnimationFrame + a monotonic clock, injected so the loop can run in tests. */
export interface FrameScheduler {
  request(cb: () => void): number;
  cancel(handle: number): void;
  /** Monotonic milliseconds. */
  now(): number;
}

/**
 * Calls `onFrame(nowMs, dtMs)` once per animation frame. `resetTimebase()` makes the next
 * frame report dt = 0 — called when the tab becomes visible again, so the time the tab spent
 * hidden is dropped instead of being simulated in a burst.
 */
export class FrameLoop {
  private handle = -1;
  private last = -1;
  private running = false;
  private readonly tick = (): void => {
    if (!this.running) return;
    this.handle = this.sched.request(this.tick);
    const now = this.sched.now();
    const dt = this.last < 0 ? 0 : now - this.last;
    this.last = now;
    this.onFrame(now, dt);
  };

  constructor(
    private readonly sched: FrameScheduler,
    private readonly onFrame: (nowMs: number, dtMs: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    this.handle = this.sched.request(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.handle >= 0) this.sched.cancel(this.handle);
    this.handle = -1;
  }

  resetTimebase(): void {
    this.last = -1;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
