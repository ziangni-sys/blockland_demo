/**
 * The client's idea of server time (docs/NETCODE.md section 4): ServerClock.
 *
 * Time is passed in (ms, the page's clock); the clock has no timers. NetClient feeds it every
 * arrival (arrival), every Pong (pong), every movement report it sends (moveSent) and the moveAck
 * of every batch it applies (moveAck), and calls frame(now, newestApplied) once per frame. Each
 * connection starts a new clock; the page's pause resets it (reset()).
 *
 *  - arrivalTick(now): every TickBatch and Samples message gives a sample s = tick - now*TPS/1000.
 *    The target offset is the largest s of the last 2 s (the least delayed). The offset in use
 *    moves toward it at no more than +-10% of the clock's rate (between frames, in advance()), and
 *    jumps forward when the target is more than 10 ticks ahead. arrivalTick = now*TPS/1000 +
 *    offset, roughly "the server's tick now minus the one-way delay". Backward it does not run as
 *    a rule: when the target is more than 10 ticks behind, arrivalTick holds until the target is
 *    within 10 ticks, then the -10% chase (a latency step up, a throttled host waking once a
 *    second). Only when the target is more than JUMP_BACK_TICKS (the 2 s window) behind, which is
 *    a host that stalled for longer than that and resumed without running every tick it missed,
 *    does the offset jump back to the target: holding would freeze the timeline as long as the
 *    stall lasted. renderTick does not go back with it (it holds until arrivalTick - D catches
 *    up), rotorTick does; the movement reports sent before the jump are forgotten, so rotorLead
 *    is measured again from the next moveAck.
 *  - rtt (ms): the smallest of the last 5 Ping round trips.
 *  - D (ticks) = clamp(1 + 2*jitter + lossTicks, 1.2, 8), moving by at most 0.02 per frame. jitter
 *    is the mean of (target - s) over the Samples messages of the last 2 s (reliable batches do not
 *    count: head-of-line blocking delays them in bursts); lossTicks = ceil(log 0.01 / log p) - 1
 *    for a Samples loss rate p > 1%, from the gaps in their seq numbers.
 *  - renderTick = min(arrivalTick - D, the newest applied batch's tick), never decreasing within a
 *    connection, -Infinity until the first batch is applied: ships, entities and the time of day
 *    are shown at it.
 *  - rotorTick = arrivalTick + rotorLead: where the rotors are shown and predicted. rotorLead is
 *    measured: arrivalTick is remembered for the last 64 movement reports sent; when a batch's
 *    moveAck changes to s, the sample is that batch's tick minus the arrivalTick when s was sent.
 *    It moves by at most 0.02 per frame and jumps when more than 4 ticks off; before the first
 *    sample it is rtt*TPS/1000 + 1.5 (1.5 before the first Pong).
 */
import { TPS } from '../../core/constants';

/** Arrival samples older than this are forgotten (target offset, jitter). */
const WINDOW_MS = 2000;
/** The offset chases its target at up to this fraction of the clock's rate. */
const CHASE_RATE = 0.1;
/** Larger gaps (ticks) are jumped (forward) or waited out (backward). */
const JUMP_TICKS = 10;
/** A target farther behind than this (ticks: the window) is jumped back to (a host stall ended). */
const JUMP_BACK_TICKS = (WINDOW_MS * TPS) / 1000;
const D_MIN = 1.2;
const D_MAX = 8;
/** Largest change of D and rotorLead per frame. */
const PER_FRAME_STEP = 0.02;
/** rotorLead jumps when its sample is this far away. */
const LEAD_JUMP_TICKS = 4;
/** rotorLead before the first sample: rtt in ticks plus this. */
const LEAD_DEFAULT_EXTRA = 1.5;
/** Movement reports whose send time is remembered. */
const MOVE_HISTORY = 64;
/** Pong round trips kept for rtt. */
const RTT_SAMPLES = 5;
/** Seq numbers of Samples looked at for the loss rate, and how many must have been expected first. */
const LOSS_SEQ_WINDOW = 200;
const LOSS_MIN_EXPECTED = 40;
/** Loss rates up to this give no extra delay. */
const LOSS_FREE = 0.01;

const TICKS_PER_MS = TPS / 1000;

export class ServerClock {
  // Arrival samples of the last WINDOW_MS: ring of (time, s, fromSamples).
  private times: number[] = [];
  private offsets: number[] = [];
  private fromSamples: boolean[] = [];
  private offset = 0;
  private synced = false;
  private lastAdvance = 0;
  /** Largest arrivalTick returned since the last jump back (it does not go below otherwise). */
  private floor = -Infinity;
  private targetValue = 0;

  // Samples seq numbers (loss rate): received seqs within LOSS_SEQ_WINDOW of the highest.
  private readonly seqs = new Set<number>();
  private seqHigh = -1;
  private seqLow = -1;

  private readonly rtts: number[] = [];
  private rttValue: number | null = null;

  private readonly moveSeqs = new Int32Array(MOVE_HISTORY).fill(-1);
  private readonly moveTicks = new Float64Array(MOVE_HISTORY);
  private lastMoveAck: number | null = null;
  private leadSample: number | null = null;

  private dValue = D_MIN;
  private leadValue: number | null = null;
  private renderValue = -Infinity;
  private rotorValue = 0;
  private jitterValue = 0;
  private lossValue = 0;

  /** Forget everything (the page's pause ended, or a test starts over). */
  reset(): void {
    this.times = [];
    this.offsets = [];
    this.fromSamples = [];
    this.offset = 0;
    this.synced = false;
    this.lastAdvance = 0;
    this.floor = -Infinity;
    this.targetValue = 0;
    this.seqs.clear();
    this.seqHigh = -1;
    this.seqLow = -1;
    this.rtts.length = 0;
    this.rttValue = null;
    this.moveSeqs.fill(-1);
    this.lastMoveAck = null;
    this.leadSample = null;
    this.dValue = D_MIN;
    this.leadValue = null;
    this.renderValue = -Infinity;
    this.rotorValue = 0;
    this.jitterValue = 0;
    this.lossValue = 0;
  }

  // ------------------------------------------------------------------ inputs

  /**
   * A TickBatch (seq null) or a Samples message (its seq) of `tick` arrived at `now`. Call it when
   * the message arrives, not when it is applied.
   */
  arrival(tick: number, now: number, samplesSeq: number | null): void {
    const s = tick - now * TICKS_PER_MS;
    this.times.push(now);
    this.offsets.push(s);
    this.fromSamples.push(samplesSeq !== null);
    this.prune(now);
    if (samplesSeq !== null) this.noteSeq(samplesSeq);
    if (!this.synced) {
      this.synced = true;
      this.offset = s;
      this.lastAdvance = now;
    }
  }

  /** A Pong answering a Ping sent at clientMs (u32 of the page's clock) arrived at `now`. */
  pong(clientMs: number, now: number): void {
    const rtt = (Math.floor(now) - clientMs) >>> 0;
    this.rtts.push(rtt);
    if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
    this.rttValue = Math.min(...this.rtts);
  }

  /** Movement report `seq` is being sent at `now` (rotorLead). */
  moveSent(seq: number, now: number): void {
    const i = seq % MOVE_HISTORY;
    this.moveSeqs[i] = seq;
    this.moveTicks[i] = this.arrivalTick(now);
  }

  /** An applied batch of `tick` carried moveAck `seq` (private state; it is only sent when it changes). */
  moveAck(seq: number, tick: number): void {
    if (seq === this.lastMoveAck) return;
    this.lastMoveAck = seq;
    const i = seq % MOVE_HISTORY;
    if (this.moveSeqs[i] !== seq) return;
    this.leadSample = tick - this.moveTicks[i]!;
  }

  /**
   * Once per frame, after the frame's batches are applied: move the offset, D and rotorLead, and
   * compute renderTick and rotorTick. `newestApplied` = tick of the newest applied batch (-1: none).
   */
  frame(now: number, newestApplied: number): void {
    this.advance(now);
    // D
    const dTarget = Math.min(D_MAX, Math.max(D_MIN, 1 + 2 * this.jitterValue + lossTicks(this.lossValue)));
    this.dValue = step(this.dValue, dTarget, PER_FRAME_STEP, Infinity);
    // rotorLead
    const leadTarget = this.leadSample ?? (this.rttValue ?? 0) * TICKS_PER_MS + LEAD_DEFAULT_EXTRA;
    this.leadValue = this.leadValue === null ? leadTarget : step(this.leadValue, leadTarget, PER_FRAME_STEP, LEAD_JUMP_TICKS);
    const arrival = this.arrivalTick(now);
    // Before the first applied batch renderTick does not move: it would run ahead uncapped (a lost
    // first batch, Samples arriving) and, never decreasing, stay beyond the batches applied later.
    if (newestApplied >= 0) {
      const render = Math.min(arrival - this.dValue, newestApplied);
      if (render > this.renderValue) this.renderValue = render;
    }
    this.rotorValue = arrival + this.leadValue;
  }

  /**
   * Move the offset toward its target for the time since the last call (frame() does it; NetClient
   * also calls it when it applies batches while the page is hidden).
   */
  advance(now: number): void {
    if (!this.synced) return;
    this.prune(now);
    const dt = now - this.lastAdvance;
    if (!(dt > 0)) return;
    this.lastAdvance = now;
    const target = this.target();
    this.targetValue = target;
    const gap = target - this.offset;
    if (gap > JUMP_TICKS) this.offset = target;
    else if (gap < -JUMP_BACK_TICKS) this.jumpBack(target);
    else if (gap >= -JUMP_TICKS) {
      const lim = CHASE_RATE * dt * TICKS_PER_MS;
      this.offset += Math.max(-lim, Math.min(lim, gap));
    } else {
      // Far behind the target: hold arrivalTick where it is until within JUMP_TICKS.
      this.offset = Math.max(target, this.floor - now * TICKS_PER_MS);
    }
    this.jitterValue = this.meanDeviation(target);
    this.lossValue = this.loss();
  }

  // ------------------------------------------------------------------ outputs

  /** The server tick of the newest arrival at `now`, roughly (see the file comment). Decreases only at a jump back. */
  arrivalTick(now: number): number {
    if (!this.synced) return -Infinity;
    const v = Math.max(this.floor, now * TICKS_PER_MS + this.offset);
    this.floor = v;
    return v;
  }

  /** Whether an arrival has been seen (arrivalTick is meaningful). */
  get isSynced(): boolean {
    return this.synced;
  }

  /** Round trip time in ms (smallest of the last 5 Pongs), null before the first Pong. */
  get rtt(): number | null {
    return this.rttValue;
  }

  /** Interpolation delay in ticks. */
  get D(): number {
    return this.dValue;
  }

  /** Where ships, entities and the time of day are shown (as of the last frame; -Infinity before the first applied batch). */
  get renderTick(): number {
    return this.renderValue;
  }

  /** Measured lead of the rotors over arrivalTick (as of the last frame). */
  get rotorLead(): number {
    return this.leadValue ?? (this.rttValue ?? 0) * TICKS_PER_MS + LEAD_DEFAULT_EXTRA;
  }

  /** Where the rotors are shown and predicted (as of the last frame). */
  get rotorTick(): number {
    return this.rotorValue;
  }

  /** Mean deviation (ticks) of the recent Samples arrivals from the target offset. */
  get jitter(): number {
    return this.jitterValue;
  }

  /** Samples loss rate 0..1 over the recent seq numbers. */
  get lossRate(): number {
    return this.lossValue;
  }

  /** The target offset (largest recent sample) as of the last advance. */
  get targetOffset(): number {
    return this.targetValue;
  }

  // ------------------------------------------------------------------ internals

  /**
   * The offset jumps back to `target` (arrivalTick and rotorTick go back; renderTick holds). The
   * movement reports sent so far were stamped with the old timeline: forgotten, together with a
   * lead measured from one of them, so rotorLead is measured again from the next moveAck.
   */
  private jumpBack(target: number): void {
    this.offset = target;
    this.floor = -Infinity;
    this.moveSeqs.fill(-1);
    this.leadSample = null;
  }

  private prune(now: number): void {
    const t = this.times;
    let n = 0;
    while (n < t.length - 1 && t[n]! < now - WINDOW_MS) n++;
    if (n > 0) {
      t.splice(0, n);
      this.offsets.splice(0, n);
      this.fromSamples.splice(0, n);
    }
  }

  private target(): number {
    let m = -Infinity;
    for (const s of this.offsets) if (s > m) m = s;
    return m;
  }

  private meanDeviation(target: number): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      if (!this.fromSamples[i]) continue;
      sum += target - this.offsets[i]!;
      n++;
    }
    return n > 0 ? sum / n : 0;
  }

  private noteSeq(seq: number): void {
    if (this.seqLow < 0) this.seqLow = seq;
    if (seq > this.seqHigh) this.seqHigh = seq;
    this.seqs.add(seq);
    const low = this.seqHigh - LOSS_SEQ_WINDOW + 1;
    if (this.seqLow < low) {
      for (const s of this.seqs) if (s < low) this.seqs.delete(s);
      this.seqLow = low;
    }
  }

  private loss(): number {
    if (this.seqHigh < 0) return 0;
    const expected = this.seqHigh - this.seqLow + 1;
    if (expected < LOSS_MIN_EXPECTED) return 0;
    return Math.max(0, 1 - this.seqs.size / expected);
  }
}

/** Extra ticks of delay for a loss rate p (section 4). */
export function lossTicks(p: number): number {
  if (!(p > LOSS_FREE)) return 0;
  if (p >= 1) return D_MAX;
  return Math.ceil(Math.log(0.01) / Math.log(p)) - 1;
}

/** Move `v` toward `target` by at most `maxStep`; jump when farther than `jump`. */
function step(v: number, target: number, maxStep: number, jump: number): number {
  const d = target - v;
  if (Math.abs(d) > jump) return target;
  return v + Math.max(-maxStep, Math.min(maxStep, d));
}
