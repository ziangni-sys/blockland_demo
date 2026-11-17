/**
 * A small pool of Web Workers speaking a request/response protocol keyed by a numeric job id
 * (both the chunk generation and the mesh workers echo `id`).
 *
 * The hosting page may not allow workers at all, or module workers from blob URLs may fail to
 * start in some build / browser combination. The pool notices (a worker that errors before
 * its first reply, or stays silent past a generous timeout, or cannot even be constructed),
 * switches to `failed`, and fails every job in flight, so the caller re-runs that work on the
 * main thread instead of waiting forever. DOM-free: the Worker constructor and the clock are
 * injected (tests drive it with fakes).
 */

/** The part of the Worker API the pool uses. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', fn: (e: { data?: unknown }) => void): void;
}

export interface WorkerPoolOptions {
  /** For diagnostics ("mesh", "terrain"). */
  name: string;
  size: number;
  /** Creates one worker; may throw (then the pool fails, or moves on to `alternatives`). */
  create: () => WorkerLike;
  /**
   * Other ways to start the same worker, tried in order when every worker of the current way
   * failed to start (e.g. module workers from blob URLs are refused in opaque-origin sandboxes,
   * while the same code from a data: URL runs). Jobs in flight fail with 'restarting' and are
   * retried by their callers.
   */
  alternatives?: ReadonlyArray<() => WorkerLike>;
  /** A worker that has not answered its first job after this long is considered dead. */
  firstReplyTimeoutMs: number;
  now: () => number;
  /** Called once when the pool gives up on workers. */
  onFailed?: (reason: string) => void;
  /** Restarts of crashed (already proven) workers before the pool gives up. */
  maxRestarts?: number;
}

interface Job {
  id: number;
  onDone: (res: unknown) => void;
  onFail: (reason: string) => void;
}

interface Slot {
  worker: WorkerLike;
  jobs: Map<number, Job>;
  /** Answered at least once (the script loaded and runs). */
  proven: boolean;
  /** Time the oldest unanswered job was posted to a not yet proven worker. */
  waitingSince: number;
  dead: boolean;
}

export type PoolState = 'idle' | 'running' | 'failed';

export class WorkerPool<Res extends { id: number }> {
  private slots: Slot[] = [];
  private nextId = 1;
  private restarts = 0;
  /** 0 = opts.create, k = opts.alternatives[k - 1]. */
  private way = 0;
  private anyProven = false;
  private _state: PoolState = 'idle';
  private _failReason = '';

  constructor(private readonly opts: WorkerPoolOptions) {}

  get state(): PoolState {
    return this._state;
  }
  get failed(): boolean {
    return this._state === 'failed';
  }
  get failReason(): string {
    return this._failReason;
  }
  get size(): number {
    return this.slots.length;
  }
  /** Jobs posted and not yet answered. */
  get inFlight(): number {
    let n = 0;
    for (const s of this.slots) n += s.jobs.size;
    return n;
  }

  /**
   * Post a job. `build(id)` makes the message (it must carry `id`); `transfer` lists buffers
   * to move. Returns false — and calls nothing — when the pool has failed: run the work
   * synchronously then. Otherwise exactly one of onDone / onFail is called later (unless the
   * job is dropped with cancelAll()).
   */
  submit(build: (id: number) => unknown, transfer: Transferable[], onDone: (res: Res) => void, onFail: (reason: string) => void): boolean {
    if (this._state === 'failed') return false;
    // A way of starting workers that throws right away moves on to the next one at once.
    for (let guard = 0; this._state === 'idle' && guard <= (this.opts.alternatives?.length ?? 0); guard++) this.start();
    if (this._state !== 'running') return false;
    const slot = this.leastLoaded();
    if (!slot) return false;
    const id = this.nextId++;
    const job: Job = { id, onDone: onDone as (res: unknown) => void, onFail };
    let msg: unknown;
    try {
      msg = build(id);
    } catch (e) {
      // A bad request is the caller's bug, not the worker's: report it on the job only.
      onFail(e instanceof Error ? e.message : String(e));
      return true;
    }
    if (!slot.proven && slot.jobs.size === 0) slot.waitingSince = this.opts.now();
    slot.jobs.set(id, job);
    try {
      slot.worker.postMessage(msg, transfer);
    } catch (e) {
      slot.jobs.delete(id);
      this.fail(`postMessage failed: ${e instanceof Error ? e.message : String(e)}`);
      onFail('pool failed');
    }
    return true;
  }

  /** Call every frame: detects workers that never start. */
  poll(): void {
    if (this._state !== 'running') return;
    const now = this.opts.now();
    for (const s of this.slots) {
      if (!s.proven && s.jobs.size > 0 && now - s.waitingSince > this.opts.firstReplyTimeoutMs) {
        this.fail(`${this.opts.name} worker did not answer within ${Math.round(this.opts.firstReplyTimeoutMs)} ms`);
        return;
      }
    }
  }

  /** Forget every job in flight without calling back (their replies are ignored). */
  cancelAll(): void {
    for (const s of this.slots) s.jobs.clear();
  }

  dispose(): void {
    for (const s of this.slots) {
      s.dead = true;
      s.jobs.clear();
      try {
        s.worker.terminate();
      } catch {
        // already gone
      }
    }
    this.slots = [];
    if (this._state !== 'failed') this._state = 'idle';
  }

  // ------------------------------------------------------------------ internals

  private start(): void {
    this._state = 'running';
    for (let i = 0; i < this.opts.size; i++) {
      const s = this.spawn();
      if (!s) return; // fail() already ran
      this.slots.push(s);
    }
  }

  private spawn(): Slot | null {
    let worker: WorkerLike;
    try {
      const create = this.way === 0 ? this.opts.create : this.opts.alternatives![this.way - 1]!;
      worker = create();
    } catch (e) {
      this.fail(`cannot create a ${this.opts.name} worker: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    const slot: Slot = { worker, jobs: new Map(), proven: false, waitingSince: 0, dead: false };
    worker.addEventListener('message', (e) => this.onMessage(slot, e.data));
    worker.addEventListener('error', () => this.onError(slot, 'error event'));
    worker.addEventListener('messageerror', () => this.onError(slot, 'message could not be deserialized'));
    return slot;
  }

  private onMessage(slot: Slot, data: unknown): void {
    if (slot.dead) return;
    slot.proven = true;
    this.anyProven = true;
    const id = data !== null && typeof data === 'object' ? (data as { id?: unknown }).id : undefined;
    if (typeof id !== 'number') return;
    const job = slot.jobs.get(id);
    if (!job) return; // cancelled
    slot.jobs.delete(id);
    job.onDone(data);
  }

  private onError(slot: Slot, what: string): void {
    if (slot.dead || this._state !== 'running') return;
    if (!slot.proven) {
      // The script never ran: every worker shares the cause (no blob/module workers here).
      this.fail(`${this.opts.name} worker failed to start (${what})`);
      return;
    }
    // A proven worker crashed: replace it, re-run its jobs elsewhere (callers retry).
    slot.dead = true;
    try {
      slot.worker.terminate();
    } catch {
      // ignore
    }
    const jobs = [...slot.jobs.values()];
    slot.jobs.clear();
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    if (++this.restarts > (this.opts.maxRestarts ?? 3)) {
      this.fail(`${this.opts.name} workers keep crashing`);
    } else {
      const fresh = this.spawn();
      if (fresh) this.slots.push(fresh);
    }
    for (const j of jobs) j.onFail('worker crashed');
  }

  private fail(reason: string): void {
    if (this._state === 'failed') return;
    const alternatives = this.opts.alternatives ?? [];
    if (!this.anyProven && this.way < alternatives.length) {
      // This way of starting workers does not work here: try the next one on the next submit.
      this.way++;
      const jobs = this.dropAll();
      this._state = 'idle';
      for (const j of jobs) j.onFail('restarting');
      return;
    }
    this._state = 'failed';
    this._failReason = reason;
    const jobs = this.dropAll();
    try {
      this.opts.onFailed?.(reason);
    } catch {
      // ignore
    }
    for (const j of jobs) j.onFail('pool failed');
  }

  /** Terminate every worker; returns the jobs that were in flight. */
  private dropAll(): Job[] {
    const jobs: Job[] = [];
    for (const s of this.slots) {
      s.dead = true;
      for (const j of s.jobs.values()) jobs.push(j);
      s.jobs.clear();
      try {
        s.worker.terminate();
      } catch {
        // ignore
      }
    }
    this.slots = [];
    return jobs;
  }

  private leastLoaded(): Slot | null {
    let best: Slot | null = null;
    for (const s of this.slots) if (!best || s.jobs.size < best.jobs.size) best = s;
    return best;
  }
}
