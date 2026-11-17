import { describe, expect, it } from 'vitest';
import { WorkerPool, type WorkerLike } from '../../src/client/workers';

type Msg = { id: number; value: number };

class FakeWorker implements WorkerLike {
  readonly posted: Msg[] = [];
  terminated = false;
  private listeners = new Map<string, Array<(e: { data?: unknown }) => void>>();
  postMessage(msg: unknown): void {
    this.posted.push(msg as Msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  emit(type: string, data?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  /** Answer the oldest unanswered message with value * 2. */
  reply(): void {
    const m = this.posted.shift()!;
    this.emit('message', { id: m.id, value: m.value * 2 });
  }
}

function makePool(opts: { size?: number; timeout?: number; create?: () => WorkerLike } = {}) {
  const workers: FakeWorker[] = [];
  let now = 0;
  const failures: string[] = [];
  const pool = new WorkerPool<Msg>({
    name: 'test',
    size: opts.size ?? 2,
    create:
      opts.create ??
      (() => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      }),
    firstReplyTimeoutMs: opts.timeout ?? 1000,
    now: () => now,
    onFailed: (r) => failures.push(r),
  });
  return { pool, workers, failures, setNow: (t: number) => (now = t) };
}

describe('WorkerPool', () => {
  it('spreads jobs over the least loaded workers and routes replies by id', () => {
    const { pool, workers } = makePool();
    const done: number[] = [];
    for (let i = 1; i <= 4; i++) {
      expect(pool.submit((id) => ({ id, value: i }), [], (r) => done.push(r.value), () => done.push(-1))).toBe(true);
    }
    expect(workers.length).toBe(2);
    expect(workers[0]!.posted.length).toBe(2);
    expect(workers[1]!.posted.length).toBe(2);
    expect(pool.inFlight).toBe(4);
    workers[1]!.reply();
    workers[0]!.reply();
    expect(done).toEqual([4, 2]);
    expect(pool.inFlight).toBe(2);
    expect(pool.state).toBe('running');
  });

  it('a worker that errors before its first reply fails the pool and every job', () => {
    const { pool, workers, failures } = makePool();
    const fails: string[] = [];
    pool.submit((id) => ({ id, value: 1 }), [], () => undefined, (r) => fails.push(r));
    pool.submit((id) => ({ id, value: 2 }), [], () => undefined, (r) => fails.push(r));
    workers[0]!.emit('error');
    expect(pool.failed).toBe(true);
    expect(failures.length).toBe(1);
    expect(fails).toEqual(['pool failed', 'pool failed']);
    expect(workers.every((w) => w.terminated)).toBe(true);
    // the caller then runs the work itself
    expect(pool.submit((id) => ({ id, value: 3 }), [], () => undefined, () => undefined)).toBe(false);
  });

  it('a worker that stays silent past the timeout fails the pool', () => {
    const { pool, setNow } = makePool({ timeout: 500 });
    const fails: string[] = [];
    pool.submit((id) => ({ id, value: 1 }), [], () => undefined, (r) => fails.push(r));
    setNow(400);
    pool.poll();
    expect(pool.failed).toBe(false);
    setNow(501);
    pool.poll();
    expect(pool.failed).toBe(true);
    expect(fails).toEqual(['pool failed']);
  });

  it('cannot construct workers -> failed on first submit', () => {
    const { pool } = makePool({
      create: () => {
        throw new Error('SecurityError');
      },
    });
    expect(pool.submit((id) => ({ id, value: 1 }), [], () => undefined, () => undefined)).toBe(false);
    expect(pool.failed).toBe(true);
    expect(pool.failReason).toContain('SecurityError');
  });

  it('a proven worker that crashes is replaced and its jobs fail individually', () => {
    const { pool, workers } = makePool({ size: 1 });
    const done: number[] = [];
    const fails: string[] = [];
    pool.submit((id) => ({ id, value: 1 }), [], (r) => done.push(r.value), (r) => fails.push(r));
    workers[0]!.reply();
    pool.submit((id) => ({ id, value: 5 }), [], (r) => done.push(r.value), (r) => fails.push(r));
    workers[0]!.emit('error');
    expect(pool.failed).toBe(false);
    expect(fails).toEqual(['worker crashed']);
    expect(workers.length).toBe(2);
    expect(workers[0]!.terminated).toBe(true);
    pool.submit((id) => ({ id, value: 7 }), [], (r) => done.push(r.value), (r) => fails.push(r));
    workers[1]!.reply();
    expect(done).toEqual([2, 14]);
  });

  it('cancelAll drops callbacks; late replies are ignored', () => {
    const { pool, workers } = makePool({ size: 1 });
    const done: number[] = [];
    pool.submit((id) => ({ id, value: 1 }), [], (r) => done.push(r.value), () => done.push(-1));
    pool.cancelAll();
    workers[0]!.reply();
    expect(done).toEqual([]);
    expect(pool.inFlight).toBe(0);
    pool.dispose();
    expect(workers[0]!.terminated).toBe(true);
  });

  it('a request builder that throws fails only that job', () => {
    const { pool } = makePool();
    const fails: string[] = [];
    expect(
      pool.submit(
        () => {
          throw new Error('bad input');
        },
        [],
        () => undefined,
        (r) => fails.push(r),
      ),
    ).toBe(true);
    expect(fails).toEqual(['bad input']);
    expect(pool.failed).toBe(false);
  });
});

describe('WorkerPool alternatives', () => {
  it('moves on to the next way of starting workers when none of the first way ever answered', () => {
    const first: FakeWorker[] = [];
    const second: FakeWorker[] = [];
    let failed = '';
    const pool = new WorkerPool<Msg>({
      name: 'alt',
      size: 1,
      create: () => {
        const w = new FakeWorker();
        first.push(w);
        return w;
      },
      alternatives: [
        () => {
          const w = new FakeWorker();
          second.push(w);
          return w;
        },
      ],
      firstReplyTimeoutMs: 1000,
      now: () => 0,
      onFailed: (r) => (failed = r),
    });
    const fails: string[] = [];
    const done: number[] = [];
    pool.submit((id) => ({ id, value: 1 }), [], (r) => done.push(r.value), (r) => fails.push(r));
    first[0]!.emit('error');
    expect(fails).toEqual(['restarting']);
    expect(pool.failed).toBe(false);
    expect(first[0]!.terminated).toBe(true);
    pool.submit((id) => ({ id, value: 4 }), [], (r) => done.push(r.value), (r) => fails.push(r));
    expect(second.length).toBe(1);
    second[0]!.reply();
    expect(done).toEqual([8]);
    // once a worker answered, a later startup failure is a real failure
    expect(failed).toBe('');
  });

  it('a throwing first way falls through to the alternative within the same submit', () => {
    const second: FakeWorker[] = [];
    const pool = new WorkerPool<Msg>({
      name: 'alt2',
      size: 2,
      create: () => {
        throw new Error('no blob workers');
      },
      alternatives: [
        () => {
          const w = new FakeWorker();
          second.push(w);
          return w;
        },
      ],
      firstReplyTimeoutMs: 1000,
      now: () => 0,
    });
    expect(pool.submit((id) => ({ id, value: 2 }), [], () => undefined, () => undefined)).toBe(true);
    expect(second.length).toBe(2);
    expect(pool.state).toBe('running');
  });

  it('fails for good when every way failed', () => {
    const pool = new WorkerPool<Msg>({
      name: 'alt3',
      size: 1,
      create: () => {
        throw new Error('a');
      },
      alternatives: [
        () => {
          throw new Error('b');
        },
      ],
      firstReplyTimeoutMs: 1000,
      now: () => 0,
    });
    expect(pool.submit((id) => ({ id, value: 2 }), [], () => undefined, () => undefined)).toBe(false);
    expect(pool.failed).toBe(true);
    expect(pool.failReason).toContain('b');
  });
});
