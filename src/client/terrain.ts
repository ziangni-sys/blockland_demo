/**
 * The browser's ChunkSource (docs/NETCODE.md section 6 "客户端的区块装载"): the pristine columns the
 * server tells the replica to generate itself, built in the terrain worker pool (the world's
 * generator on the main thread when there is no pool, when the pool has failed, or for a generator
 * the terrain workers do not know: they build TerrainGenerator worlds by seed).
 *
 * Inserting a column into the replica lights it on the main thread (ClientReplica: initChunk on the
 * new column and the border of its neighbours), which costs a few milliseconds; so finished columns
 * are not handed to the replica when they arrive (worker messages come between frames) but queued
 * and delivered by pump() within the frame's budget, at least one per frame so loading always
 * progresses. Main-thread generation is budgeted the same way.
 *
 * Failures: a worker failure is retried once in the pool, then the column is generated on the main
 * thread; a main-thread failure is retried on later frames, and after MAX_SYNC_FAILURES the column
 * is delivered empty (air) so the game goes on (a column the source never answers would keep the
 * loading screen up for good). Results the replica no longer wants (the column was unsubscribed
 * or snapshotted again meanwhile) are dropped by the replica itself (net/client/chunks.ts).
 */
import { CHUNK_VOLUME } from '../core/constants';
import type { ChunkSource } from '../net/client/chunks';
import { chunkKey } from '../voxel/chunk';
import { generatorFromSpec, type ChunkGenerator, type GeneratorSpec } from '../worldgen/generator';
import type { GenErrorResponse, GenRequest, GenResponse } from '../worldgen/protocol';
import type { WorkerPool } from './workers';

/** Worker failures of one column before it is generated on the main thread instead. */
const MAX_WORKER_FAILURES = 2;
/** Main-thread generator failures of one column before it is delivered empty. */
const MAX_SYNC_FAILURES = 3;

type GenReply = GenResponse | GenErrorResponse;

interface Request {
  cx: number;
  cz: number;
  done: (cells: Uint16Array) => void;
}

interface Finished {
  cells: Uint16Array;
  done: (cells: Uint16Array) => void;
}

export interface TerrainStats {
  /** Columns in the worker pool. */
  inFlight: number;
  /** Finished columns waiting for delivery plus columns waiting for main-thread generation. */
  waiting: number;
  delivered: number;
  syncGenerated: number;
  /** Mean main-thread milliseconds per delivery (inserting and lighting the column). */
  deliverMs: number;
}

export class TerrainSource implements ChunkSource {
  readonly stats: TerrainStats = { inFlight: 0, waiting: 0, delivered: 0, syncGenerated: 0, deliverMs: 0 };
  private readonly generator: ChunkGenerator;
  /** The pool builds this world's columns (a terrain world by seed). */
  private readonly pooled: boolean;
  private readonly finished: Finished[] = [];
  private readonly syncQueue: Request[] = [];
  private readonly workerFailures = new Map<number, number>();
  private readonly syncFailures = new Map<number, number>();
  private inFlight = 0;
  private deliverTotalMs = 0;
  private disposed = false;

  constructor(
    spec: GeneratorSpec,
    private readonly pool: WorkerPool<GenReply> | null,
    private readonly now: () => number,
    private readonly onError: (what: string, err: unknown) => void,
  ) {
    this.generator = generatorFromSpec(spec);
    this.pooled = spec.kind === 'terrain';
  }

  generate(cx: number, cz: number, done: (cells: Uint16Array) => void): void {
    if (this.disposed) return;
    this.dispatch({ cx, cz, done });
  }

  /** Columns asked for and not delivered yet. */
  get pending(): number {
    return this.inFlight + this.finished.length + this.syncQueue.length;
  }

  /**
   * One frame of work, from `frameStart`: deliver finished columns until `budgetMs` is used (at
   * least one), then generate waiting columns on the main thread within half of what is left
   * (at least one).
   */
  pump(frameStart: number, budgetMs: number): void {
    if (this.disposed) return;
    let n = 0;
    while (this.finished.length > 0 && (n === 0 || this.now() - frameStart < budgetMs)) {
      const f = this.finished.shift()!;
      this.deliver(f.cells, f.done);
      n++;
    }
    let generated = 0;
    const retry: Request[] = [];
    while (this.syncQueue.length > 0 && (generated === 0 || this.now() - frameStart < budgetMs * 0.5)) {
      const r = this.syncQueue.shift()!;
      generated++;
      const key = chunkKey(r.cx, r.cz);
      let cells: Uint16Array;
      try {
        cells = this.generator.generate(r.cx, r.cz);
      } catch (e) {
        this.onError('terrain generation', e);
        const failures = (this.syncFailures.get(key) ?? 0) + 1;
        if (failures < MAX_SYNC_FAILURES) {
          // Try again on a later frame (a transient failure), not in a tight loop.
          this.syncFailures.set(key, failures);
          retry.push(r);
          continue;
        }
        // A deterministic generator bug: give the column up (empty) so the game goes on.
        this.syncFailures.delete(key);
        this.deliver(new Uint16Array(CHUNK_VOLUME), r.done);
        continue;
      }
      this.syncFailures.delete(key);
      this.stats.syncGenerated++;
      this.deliver(cells, r.done);
    }
    for (const r of retry) this.syncQueue.push(r);
    this.stats.inFlight = this.inFlight;
    this.stats.waiting = this.finished.length + this.syncQueue.length;
  }

  /** Forget everything (the connection ended): nothing is delivered any more. */
  dispose(): void {
    this.disposed = true;
    this.finished.length = 0;
    this.syncQueue.length = 0;
  }

  private dispatch(r: Request): void {
    const pool = this.pool;
    if (!this.pooled || pool === null || pool.failed) {
      this.syncQueue.push(r);
      return;
    }
    this.inFlight++;
    const seed = this.generator.seed;
    const accepted = pool.submit(
      (id): GenRequest => ({ type: 'gen', id, seed, cx: r.cx, cz: r.cz }),
      [],
      (res) => {
        this.inFlight--;
        if (this.disposed) return;
        if (res.type === 'gen') this.finished.push({ cells: res.cells, done: r.done });
        else this.workerFailed(r, new Error(res.message));
      },
      (reason) => {
        this.inFlight--;
        if (this.disposed) return;
        if (pool.failed) this.syncQueue.push(r);
        else this.workerFailed(r, new Error(reason));
      },
    );
    if (!accepted) {
      this.inFlight--;
      this.syncQueue.push(r);
    }
  }

  private workerFailed(r: Request, err: Error): void {
    const key = chunkKey(r.cx, r.cz);
    const n = (this.workerFailures.get(key) ?? 0) + 1;
    this.workerFailures.set(key, n);
    if (n >= MAX_WORKER_FAILURES) {
      this.workerFailures.delete(key);
      this.onError('terrain worker', err);
      this.syncQueue.push(r);
    } else {
      this.dispatch(r);
    }
  }

  private deliver(cells: Uint16Array, done: (cells: Uint16Array) => void): void {
    const t0 = this.now();
    try {
      done(cells);
    } catch (e) {
      this.onError('chunk loading', e);
    }
    this.deliverTotalMs += this.now() - t0;
    this.stats.delivered++;
    this.stats.deliverMs = this.deliverTotalMs / this.stats.delivered;
  }
}
