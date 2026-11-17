/**
 * Frame loop and fixed-step tick clock.
 *
 * The simulation advances in fixed 1/20 s ticks; rendering runs at the display rate and
 * interpolates between the previous and the current tick with `alpha`. Both classes here
 * are DOM-free: the browser's requestAnimationFrame is injected (FrameScheduler) so the
 * accumulator logic is unit-tested in Node.
 */
import { TPS } from '../core/constants';

/** Length of one simulation tick in milliseconds. */
export const TICK_MS = 1000 / TPS;
/** Never run more ticks than this in one frame: a slow machine slows down instead of spiralling. */
export const MAX_TICKS_PER_FRAME = 5;
/** Frame deltas above this are clamped (debugger pauses, long GC, a stalled tab). */
export const MAX_FRAME_MS = 250;

/**
 * Accumulates real time and hands out whole ticks.
 *
 *   const n = clock.advance(dtMs, running);   // run n ticks
 *   render(clock.alpha);                       // blend prev -> current tick
 *
 * While not running (pause, menus) time is not accumulated and `alpha` is frozen, so the
 * interpolated scene stands perfectly still (DESIGN/ACCEPTANCE 21: nothing on a deck moves
 * while paused) and resumes without a jump.
 */
export class FixedStepClock {
  private acc = 0;
  /** Blend factor between the previous (0) and the current (1) tick for rendering. */
  alpha = 0;
  /** Whole ticks dropped because the frame was too long (diagnostics). */
  dropped = 0;

  advance(dtMs: number, running: boolean): number {
    if (!running) return 0;
    let dt = dtMs;
    if (!(dt > 0)) dt = 0;
    else if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;
    this.acc += dt;
    let n = Math.floor(this.acc / TICK_MS);
    this.acc -= n * TICK_MS;
    if (n > MAX_TICKS_PER_FRAME) {
      // Drop the backlog: keep only the fractional tick so the next frame does not owe more.
      this.dropped += n - MAX_TICKS_PER_FRAME;
      n = MAX_TICKS_PER_FRAME;
    }
    // Rounding can leave acc a hair below 0 or at TICK_MS.
    if (this.acc < 0) this.acc = 0;
    this.alpha = Math.min(1, this.acc / TICK_MS);
    return n;
  }

  /** Forget accumulated time (new session). */
  reset(): void {
    this.acc = 0;
    this.alpha = 0;
    this.dropped = 0;
  }
}

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
