/**
 * Chunk streaming: asks the simulation's ChunkManager which columns it wants, generates them
 * in the terrain worker pool and feeds the results back with provide().
 *
 * provide() lights the new column on the main thread (and lights the border of its loaded
 * neighbours), which costs a few milliseconds, so finished columns are queued and provided
 * within a per-frame time budget. When workers are unavailable the same generator runs on
 * the main thread, one column per frame.
 */
import { CHUNK_VOLUME } from '../core/constants';
import { chunkKey } from '../voxel/chunk';
import type { ChunkGenerator } from '../worldgen/generator';
import type { GenErrorResponse, GenRequest, GenResponse } from '../worldgen/protocol';
import type { Simulation } from '../sim/simulation';
import type { WorkerPool } from './workers';

/** Generation requests in flight plus finished columns waiting to be provided. */
export const MAX_CHUNKS_IN_FLIGHT = 6;
/** Frames to wait before asking wanted() again after it returned nothing. */
const IDLE_QUERY_FRAMES = 8;
/** Worker failures of one column before it is generated on the main thread instead. */
const MAX_WORKER_FAILURES = 2;
/**
 * Main-thread generator failures of one column before it is given up: it is then provided
 * empty (air; not modified, so never saved and regenerated next session). Otherwise it stayed
 * pending in the ChunkManager forever and loading never finished when it was near the player.
 */
const MAX_SYNC_FAILURES = 3;

type GenReply = GenResponse | GenErrorResponse;

interface Column {
  cx: number;
  cz: number;
}

export interface ChunkStreamStats {
  inFlight: number;
  waiting: number;
  provided: number;
  syncGenerated: number;
  /** Mean main-thread milliseconds per provide(). */
  provideMs: number;
}

export class ChunkStreamer {
  private readonly ready: GenResponse[] = [];
  private readonly syncQueue: Column[] = [];
  private readonly failures = new Map<number, number>();
  private readonly syncFailures = new Map<number, number>();
  private inFlight = 0;
  private frame = 0;
  private nextQuery = 0;
  private disposed = false;
  private provideTotalMs = 0;
  readonly stats: ChunkStreamStats = { inFlight: 0, waiting: 0, provided: 0, syncGenerated: 0, provideMs: 0 };

  constructor(
    private readonly sim: Simulation,
    private readonly pool: WorkerPool<GenReply> | null,
    /** Main-thread generator for the same seed (fallback path). */
    private readonly generator: ChunkGenerator,
    private readonly now: () => number,
    private readonly onError: (what: string, err: unknown) => void,
  ) {}

  /**
   * One frame of streaming work: request more columns, then provide finished ones until
   * `budgetMs` (measured from `frameStart`) is used up — at least one per frame so loading
   * always progresses.
   */
  update(frameStart: number, budgetMs: number): void {
    if (this.disposed) return;
    this.frame++;
    this.request();
    let provided = 0;
    while (this.ready.length > 0 && (provided === 0 || this.now() - frameStart < budgetMs)) {
      const r = this.ready.shift()!;
      this.provide(r.cx, r.cz, r.cells);
      provided++;
    }
    // Main-thread generation (no workers): one column per frame, more while within budget.
    let generated = 0;
    const retry: Column[] = [];
    while (this.syncQueue.length > 0 && (generated === 0 || this.now() - frameStart < budgetMs * 0.5)) {
      const c = this.syncQueue.shift()!;
      let cells: Uint16Array;
      try {
        cells = this.generator.generate(c.cx, c.cz);
      } catch (e) {
        this.onError('terrain generation', e);
        generated++;
        const key = chunkKey(c.cx, c.cz);
        const n = (this.syncFailures.get(key) ?? 0) + 1;
        if (n < MAX_SYNC_FAILURES) {
          // Try again on a later frame (a transient failure), not in a tight loop.
          this.syncFailures.set(key, n);
          retry.push(c);
          continue;
        }
        // A deterministic generator bug: give the column up (empty) so the game goes on.
        this.syncFailures.delete(key);
        this.provide(c.cx, c.cz, new Uint16Array(CHUNK_VOLUME));
        continue;
      }
      this.syncFailures.delete(chunkKey(c.cx, c.cz));
      this.stats.syncGenerated++;
      this.provide(c.cx, c.cz, cells);
      generated++;
    }
    for (let i = 0; i < retry.length; i++) this.syncQueue.push(retry[i]!);
    this.stats.inFlight = this.inFlight;
    this.stats.waiting = this.ready.length + this.syncQueue.length;
  }

  /** Columns requested but not yet in the world. */
  get pending(): number {
    return this.inFlight + this.ready.length + this.syncQueue.length;
  }

  dispose(): void {
    this.disposed = true;
    this.ready.length = 0;
    this.syncQueue.length = 0;
  }

  private request(): void {
    const free = MAX_CHUNKS_IN_FLIGHT - this.inFlight - this.ready.length - this.syncQueue.length;
    if (free <= 0 || this.frame < this.nextQuery) return;
    const wanted = this.sim.chunks.wanted(free);
    // wanted() scans every column in range; when nothing is missing, do not rescan every frame.
    this.nextQuery = wanted.length === 0 ? this.frame + IDLE_QUERY_FRAMES : this.frame;
    for (const c of wanted) this.dispatch(c.cx, c.cz);
  }

  private dispatch(cx: number, cz: number): void {
    const pool = this.pool;
    if (!pool || pool.failed) {
      this.syncQueue.push({ cx, cz });
      return;
    }
    this.inFlight++;
    const seed = this.generator.seed;
    const accepted = pool.submit(
      (id): GenRequest => ({ type: 'gen', id, seed, cx, cz }),
      [],
      (res) => {
        this.inFlight--;
        if (this.disposed) return;
        if (res.type === 'gen') this.ready.push(res);
        else this.workerFailed(cx, cz, new Error(res.message));
      },
      (reason) => {
        this.inFlight--;
        if (this.disposed) return;
        if (pool.failed) this.syncQueue.push({ cx, cz });
        else this.workerFailed(cx, cz, new Error(reason));
      },
    );
    if (!accepted) {
      this.inFlight--;
      this.syncQueue.push({ cx, cz });
    }
  }

  private workerFailed(cx: number, cz: number, err: Error): void {
    const key = chunkKey(cx, cz);
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    if (n >= MAX_WORKER_FAILURES) {
      this.onError('terrain worker', err);
      this.syncQueue.push({ cx, cz });
    } else {
      this.dispatch(cx, cz);
    }
  }

  private provide(cx: number, cz: number, cells: Uint16Array): void {
    const t0 = this.now();
    try {
      this.sim.chunks.provide(cx, cz, cells);
    } catch (e) {
      this.onError('chunk loading', e);
    }
    this.provideTotalMs += this.now() - t0;
    this.stats.provided++;
    this.stats.provideMs = this.provideTotalMs / this.stats.provided;
    // Something changed: the next wanted() scan may find work right away.
    this.nextQuery = this.frame;
  }
}
