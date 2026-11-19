/**
 * World section meshing: drains World.takeDirtySections() into a MeshQueue, snapshots the
 * best eligible sections on the main thread, meshes them in the mesh worker pool and hands
 * the results to the render backend — all within a per-frame time budget.
 *
 * A section is only meshed when its chunk and the 8 neighbouring chunks are loaded
 * (sectionNeighborsLoaded): otherwise its border faces would be culled or exposed against
 * missing data and a visible seam would stay until the next edit. Such sections stay queued
 * and go as soon as the neighbours arrive (World.addChunk re-dirties them anyway).
 */
import { SECTION_SIZE, SECTIONS_PER_CHUNK } from '../core/constants';
import { AIR, ID_MASK } from '../blocks/cell';
import { OPAQUE } from '../blocks/registry';
import { sectionNeighborsLoaded, snapshotSection } from '../mesh/snapshot';
import { Mesher } from '../mesh/mesher';
import { meshInputTransferables, type MeshData, type MeshInput, type MeshRequest, type MeshResponse } from '../mesh/types';
import type { MeshErrorResponse } from '../mesh/worker';
import type { RenderBackend } from '../render/backend';
import { sectionKey } from '../voxel/chunk';
import type { World } from '../voxel/world';
import { MeshQueue, sectionKeyCx, sectionKeyCz, sectionKeySy } from './meshqueue';
import type { WorkerPool } from './workers';

/** Jobs per worker kept in flight (keeps workers busy across the round trip). */
const JOBS_PER_WORKER = 3;
/** Most sections dispatched in one frame. */
const MAX_DISPATCH_PER_FRAME = 24;
/**
 * Most trivially empty sections (all air / all opaque: finished on the main thread without the
 * mesher) settled in one frame on top of the real jobs. They cost a snapshot each and must not
 * use up the worker slots, but an unbounded sweep through a sky full of them could stall a frame.
 */
const MAX_TRIVIAL_PER_FRAME = 96;
/**
 * A section whose snapshot or main-thread mesh throws is tried this many times in all (a
 * transient error gets another chance), then settled as it is — whatever was on screen stays,
 * like a worker's error reply — so loading can finish and the frame loop is never stuck on it.
 */
const MAX_MESH_ATTEMPTS = 3;

/** What dispatch() did with a section. */
const Dispatched = {
  /** A worker job was posted, or the section was meshed on the main thread (real work). */
  Job: 0,
  /** Trivially empty: settled without the mesher. */
  Trivial: 1,
  /** Snapshot or mesh failed (retried later or settled). */
  Failed: 2,
} as const;
type Dispatched = (typeof Dispatched)[keyof typeof Dispatched];

/**
 * True when nothing in the padded box can produce a visible face (all air, or all opaque cubes).
 * A box with a holes or second-part layer never is: one chiselled octant in buried stone has only
 * opaque ids in the base layer, but its hole must be drawn (docs/SHAPES.md 8.1).
 */
export function isTriviallyEmpty(input: MeshInput): boolean {
  if (input.holes !== null || input.part2 !== null) return false;
  const cells = input.cells;
  const first = cells[0]! & ID_MASK;
  if (first === AIR) {
    for (let i = 1; i < cells.length; i++) if (cells[i] !== AIR) return false;
    return true;
  }
  if (OPAQUE[first] !== 1) return false;
  for (let i = 1; i < cells.length; i++) if (OPAQUE[cells[i]! & ID_MASK] !== 1) return false;
  return true;
}

export interface SectionMeshStats {
  /** Sections whose mesh was installed (including known-empty ones). */
  installed: number;
  /** Sections that skipped the mesher (all air / all opaque). */
  trivial: number;
  /** Sections meshed on the main thread (worker fallback). */
  syncMeshed: number;
  queued: number;
  inFlight: number;
  /** Results received and waiting to be installed. */
  waiting: number;
}

interface Result {
  key: number;
  data: MeshData | null;
}

export class SectionMesher {
  readonly queue = new MeshQueue();
  /** Sections that have a mesh (possibly empty) on screen. */
  private readonly meshed = new Set<number>();
  private readonly results: Result[] = [];
  private readonly picked: number[] = [];
  /** Failed attempts per section (snapshot / main-thread mesh), until it meshes or is settled. */
  private readonly failures = new Map<number, number>();
  private local: Mesher | null = null;
  private disposed = false;
  private readonly eligible: (cx: number, cz: number) => boolean;
  readonly stats: SectionMeshStats = { installed: 0, trivial: 0, syncMeshed: 0, queued: 0, inFlight: 0, waiting: 0 };

  constructor(
    private readonly world: World,
    private readonly backend: RenderBackend,
    private readonly pool: WorkerPool<MeshResponse> | null,
    private readonly now: () => number,
    private readonly onError: (what: string, err: unknown) => void,
  ) {
    this.eligible = (cx, cz) => sectionNeighborsLoaded(world, cx, cz);
  }

  /** One frame of meshing work, from `frameStart` until `budgetMs` is spent. */
  update(frameStart: number, budgetMs: number, camX: number, camY: number, camZ: number, dirX: number, dirZ: number): void {
    if (this.disposed) return;
    const world = this.world;
    const dirty = world.takeDirtySections();
    for (let i = 0; i < dirty.length; i++) {
      const key = dirty[i]!;
      // Border marks can name sections of chunks that are not loaded: they would never become
      // eligible, and the chunk re-dirties all its sections when it does load.
      if (world.getChunk(sectionKeyCx(key), sectionKeyCz(key))) this.queue.add(key);
    }
    this.queue.setFocus(camX, camY, camZ, dirX, dirZ);

    // Install finished meshes first: they are what the player is waiting for.
    let installed = 0;
    while (this.results.length > 0 && (installed < 2 || this.now() - frameStart < budgetMs)) {
      this.install(this.results.shift()!);
      installed++;
    }

    const pool = this.pool && !this.pool.failed ? this.pool : null;
    const cap = pool ? Math.max(1, pool.size || 2) * JOBS_PER_WORKER : 1;
    const room = pool ? Math.min(MAX_DISPATCH_PER_FRAME, cap - pool.inFlight) : MAX_DISPATCH_PER_FRAME;
    const picked = this.picked;
    // Only real jobs count against `room`: trivially empty sections finish here without a
    // worker, so keep taking until the workers have their share (or the budget is spent).
    let jobs = 0;
    let trivial = 0;
    let done = 0;
    let outOfTime = false;
    while (!outOfTime && room - jobs > 0 && trivial < MAX_TRIVIAL_PER_FRAME) {
      picked.length = 0;
      this.queue.take(room - jobs, this.eligible, picked);
      if (picked.length === 0) break;
      for (let i = 0; i < picked.length; i++) {
        const key = picked[i]!;
        // Always make some progress, then respect the budget; hand back what is left.
        if (outOfTime || (done > 0 && this.now() - frameStart >= budgetMs)) {
          outOfTime = true;
          this.queue.retry(key);
          continue;
        }
        const r = this.dispatch(key, pool);
        done++;
        if (r === Dispatched.Trivial) trivial++;
        else jobs++;
      }
    }
    this.stats.queued = this.queue.size;
    this.stats.inFlight = this.queue.inFlightCount;
    this.stats.waiting = this.results.length;
  }

  /** True when the section has a mesh on screen and no pending work. */
  isSettled(key: number): boolean {
    return this.meshed.has(key) && !this.queue.isPending(key);
  }

  get meshedCount(): number {
    return this.meshed.size;
  }

  /** A chunk unloaded: remove its section meshes and forget its work. */
  dropChunk(cx: number, cz: number): void {
    this.queue.dropChunk(cx, cz);
    for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
      const key = sectionKey(cx, sy, cz);
      this.failures.delete(key);
      if (this.meshed.delete(key)) this.backend.setSectionMesh(key, 0, 0, 0, null);
    }
  }

  /** Remove every section mesh this mesher installed (session end). */
  dispose(): void {
    this.disposed = true;
    for (const key of this.meshed) this.backend.setSectionMesh(key, 0, 0, 0, null);
    this.meshed.clear();
    this.failures.clear();
    this.results.length = 0;
    this.queue.clear();
  }

  private dispatch(key: number, pool: WorkerPool<MeshResponse> | null): Dispatched {
    const cx = sectionKeyCx(key);
    const sy = sectionKeySy(key);
    const cz = sectionKeyCz(key);
    let input: MeshInput;
    try {
      input = snapshotSection(this.world, cx, sy, cz);
    } catch (e) {
      this.failed(key, 'section snapshot', e);
      return Dispatched.Failed;
    }
    if (isTriviallyEmpty(input)) {
      this.stats.trivial++;
      this.failures.delete(key);
      if (this.queue.complete(key) === 'install') this.results.push({ key, data: null });
      return Dispatched.Trivial;
    }
    if (pool) {
      const accepted = pool.submit(
        (id): MeshRequest => ({ type: 'mesh', id, input }),
        meshInputTransferables(input),
        (res) => this.onReply(key, res),
        () => {
          // Worker died (the buffers went with it): snapshot again later, maybe on the main thread.
          if (!this.disposed) this.queue.retry(key);
        },
      );
      if (accepted) return Dispatched.Job;
    }
    // Main-thread fallback.
    let data: MeshData;
    try {
      this.local ??= new Mesher();
      data = this.local.build(input);
    } catch (e) {
      this.failed(key, 'meshing', e);
      return Dispatched.Failed;
    }
    this.stats.syncMeshed++;
    this.failures.delete(key);
    if (this.queue.complete(key) === 'install') this.results.push({ key, data });
    return Dispatched.Job;
  }

  /**
   * The snapshot or main-thread mesh of `key` threw. Report it; queue it again while attempts
   * remain, otherwise settle it as it is (like a worker's error reply: whatever is on screen
   * stays, and a later edit re-queues it). Never leaves the section unsettled for good, which
   * kept the loading screen up forever.
   */
  private failed(key: number, what: string, err: unknown): void {
    this.onError(what, err);
    const n = (this.failures.get(key) ?? 0) + 1;
    if (n < MAX_MESH_ATTEMPTS) {
      this.failures.set(key, n);
      this.queue.retry(key);
      return;
    }
    this.failures.delete(key);
    this.queue.complete(key);
    if (this.world.getChunk(sectionKeyCx(key), sectionKeyCz(key))) this.meshed.add(key);
  }

  private onReply(key: number, res: MeshResponse): void {
    if (this.disposed) return;
    const fate = this.queue.complete(key);
    if ('error' in res) {
      // Keep whatever is on screen (MeshErrorResponse contract); do not retry a deterministic failure.
      this.onError('meshing', new Error((res as MeshErrorResponse).error));
      this.meshed.add(key);
      return;
    }
    if (fate === 'install') this.results.push({ key, data: res.data });
  }

  private install(r: Result): void {
    const cx = sectionKeyCx(r.key);
    const cz = sectionKeyCz(r.key);
    // The chunk may have unloaded after the reply arrived.
    if (!this.world.getChunk(cx, cz)) return;
    const sy = sectionKeySy(r.key);
    const empty = r.data === null || (!r.data.opaque && !r.data.cutout && !r.data.translucent);
    try {
      if (empty) {
        if (this.meshed.has(r.key)) this.backend.setSectionMesh(r.key, 0, 0, 0, null);
      } else {
        this.backend.setSectionMesh(r.key, cx * SECTION_SIZE, sy * SECTION_SIZE, cz * SECTION_SIZE, r.data);
      }
    } catch (e) {
      this.onError('mesh upload', e);
    }
    this.meshed.add(r.key);
    this.stats.installed++;
  }
}
