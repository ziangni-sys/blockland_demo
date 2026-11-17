/**
 * Queue of world sections waiting to be (re)meshed. Pure bookkeeping, no DOM, no workers:
 *
 *  - de-duplicated: a section dirtied many times is meshed once;
 *  - ordered by distance to the camera (sections behind the camera count farther), so what
 *    the player looks at appears first;
 *  - a section dirtied again while its job is in flight is re-queued when the job returns
 *    (the in-flight result is still installed: it is newer than what is on screen);
 *  - when a chunk unloads, its queued sections are dropped and the results of its in-flight
 *    jobs are discarded.
 *
 * Section keys are src/voxel/chunk.ts sectionKey(cx, sy, cz) values.
 */
import { SECTION_SIZE, SECTIONS_PER_CHUNK } from '../core/constants';
import { chunkKeyX, chunkKeyZ, sectionKey } from '../voxel/chunk';

/** Queue sizes up to this are re-sorted whenever they change; bigger ones at most every SORT_INTERVAL frames. */
const ALWAYS_SORT_BELOW = 1024;
const SORT_INTERVAL = 8;
/** Focus movement (blocks) that forces a re-sort. */
const REFOCUS_DIST = 6;
/** Facing change (cosine) that forces a re-sort. */
const REFOCUS_COS = Math.cos((40 * Math.PI) / 180);

export function sectionKeyCx(key: number): number {
  return chunkKeyX(Math.floor(key / SECTIONS_PER_CHUNK));
}
export function sectionKeyCz(key: number): number {
  return chunkKeyZ(Math.floor(key / SECTIONS_PER_CHUNK));
}
export function sectionKeySy(key: number): number {
  return key % SECTIONS_PER_CHUNK;
}

/**
 * Priority of a section for a camera at (x,y,z) facing horizontally along (fx,fz) (unit or
 * zero): squared distance to the section centre, tripled for sections behind the camera
 * beyond the immediate surroundings. Smaller = sooner.
 */
export function sectionScore(key: number, x: number, y: number, z: number, fx: number, fz: number): number {
  const half = SECTION_SIZE / 2;
  const dx = sectionKeyCx(key) * SECTION_SIZE + half - x;
  const dy = sectionKeySy(key) * SECTION_SIZE + half - y;
  const dz = sectionKeyCz(key) * SECTION_SIZE + half - z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const h2 = dx * dx + dz * dz;
  if (h2 > 24 * 24 && dx * fx + dz * fz < 0) return d2 * 3;
  return d2;
}

export type MeshResultFate = 'install' | 'discard';

export class MeshQueue {
  private readonly queued = new Set<number>();
  private readonly inFlight = new Set<number>();
  /** In flight and dirtied again: re-queue on completion. */
  private readonly again = new Set<number>();
  /** In flight while their chunk unloaded: discard the result. */
  private readonly stale = new Set<number>();

  /** Sorted snapshot of the queue (may contain keys no longer queued; skipped lazily). */
  private order: number[] = [];
  /** Keys queued since the last sort (taken after the sorted ones). */
  private fresh: number[] = [];
  private dirty = false;
  private frame = 0;
  private lastSortFrame = -1_000_000;

  // focus
  private fx = 0;
  private fy = 0;
  private fz = 0;
  private dirX = 0;
  private dirZ = -1;
  private sortX = Number.NaN;
  private sortY = 0;
  private sortZ = 0;
  private sortDirX = 0;
  private sortDirZ = -1;

  // sort scratch, grown on demand
  private scores = new Float64Array(0);
  private idx = new Uint32Array(0);
  private keysTmp: number[] = [];

  get size(): number {
    return this.queued.size;
  }
  get inFlightCount(): number {
    return this.inFlight.size;
  }
  isQueued(key: number): boolean {
    return this.queued.has(key);
  }
  isInFlight(key: number): boolean {
    return this.inFlight.has(key);
  }
  /** Queued, in flight, or due to be re-queued. */
  isPending(key: number): boolean {
    return this.queued.has(key) || this.inFlight.has(key);
  }

  /** Camera position and horizontal facing (need not be normalized). */
  setFocus(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    this.fx = x;
    this.fy = y;
    this.fz = z;
    const l = Math.hypot(dirX, dirZ);
    this.dirX = l > 1e-9 ? dirX / l : 0;
    this.dirZ = l > 1e-9 ? dirZ / l : 0;
  }

  add(key: number): void {
    if (this.inFlight.has(key)) {
      this.again.add(key);
      return;
    }
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.fresh.push(key);
    this.dirty = true;
  }

  /**
   * Move up to `max` queued sections, best first, whose chunk passes `eligible(cx, cz)` into
   * the in-flight set and append them to `out`. Ineligible sections stay queued. Returns the
   * number taken.
   */
  take(max: number, eligible: (cx: number, cz: number) => boolean, out: number[]): number {
    this.frame++;
    if (max <= 0 || this.queued.size === 0) return 0;
    this.maybeSort();
    let n = 0;
    n = this.takeFrom(this.order, max, eligible, out, n);
    if (n < max) n = this.takeFrom(this.fresh, max, eligible, out, n);
    return n;
  }

  private takeFrom(list: number[], max: number, eligible: (cx: number, cz: number) => boolean, out: number[], n: number): number {
    // Eligibility is per chunk; remember the last answer since a chunk's 8 sections are adjacent-ish.
    let lastChunk = Number.NaN;
    let lastOk = false;
    for (let i = 0; i < list.length && n < max; i++) {
      const key = list[i]!;
      if (!this.queued.has(key)) continue;
      const ck = Math.floor(key / SECTIONS_PER_CHUNK);
      if (ck !== lastChunk) {
        lastChunk = ck;
        lastOk = eligible(chunkKeyX(ck), chunkKeyZ(ck));
      }
      if (!lastOk) continue;
      this.queued.delete(key);
      this.inFlight.add(key);
      out.push(key);
      n++;
    }
    return n;
  }

  /**
   * The job for `key` finished. Returns whether to install its result; re-queues the key if
   * it was dirtied (or dropped and reloaded) while the job ran.
   */
  complete(key: number): MeshResultFate {
    if (!this.inFlight.delete(key)) return 'discard';
    const fate: MeshResultFate = this.stale.delete(key) ? 'discard' : 'install';
    if (this.again.delete(key)) this.add(key);
    return fate;
  }

  /** The job for `key` failed transiently (worker died): queue it again. */
  retry(key: number): void {
    if (!this.inFlight.delete(key)) return;
    const wasStale = this.stale.delete(key);
    const wasAgain = this.again.delete(key);
    if (!wasStale || wasAgain) this.add(key);
  }

  /** A chunk unloaded: forget its queued sections and discard its in-flight results. */
  dropChunk(cx: number, cz: number): void {
    for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
      const key = sectionKey(cx, sy, cz);
      this.queued.delete(key);
      this.again.delete(key);
      if (this.inFlight.has(key)) this.stale.add(key);
    }
  }

  clear(): void {
    this.queued.clear();
    this.inFlight.clear();
    this.again.clear();
    this.stale.clear();
    this.order = [];
    this.fresh = [];
    this.dirty = false;
  }

  private maybeSort(): void {
    const moved =
      !(this.sortX === this.sortX) ||
      Math.abs(this.fx - this.sortX) > REFOCUS_DIST ||
      Math.abs(this.fy - this.sortY) > REFOCUS_DIST ||
      Math.abs(this.fz - this.sortZ) > REFOCUS_DIST ||
      this.dirX * this.sortDirX + this.dirZ * this.sortDirZ < REFOCUS_COS;
    if (!moved && !this.dirty) return;
    const big = this.queued.size > ALWAYS_SORT_BELOW;
    if (big && this.frame - this.lastSortFrame < SORT_INTERVAL) return;
    this.sort();
  }

  private sort(): void {
    this.lastSortFrame = this.frame;
    this.sortX = this.fx;
    this.sortY = this.fy;
    this.sortZ = this.fz;
    this.sortDirX = this.dirX;
    this.sortDirZ = this.dirZ;
    this.dirty = false;
    const n = this.queued.size;
    if (this.scores.length < n) {
      const cap = Math.max(64, n * 2);
      this.scores = new Float64Array(cap);
      this.idx = new Uint32Array(cap);
    }
    const keys = this.keysTmp;
    keys.length = 0;
    for (const k of this.queued) keys.push(k);
    const sc = this.scores;
    const idx = this.idx;
    for (let i = 0; i < n; i++) {
      sc[i] = sectionScore(keys[i]!, this.fx, this.fy, this.fz, this.dirX, this.dirZ);
      idx[i] = i;
    }
    const view = idx.subarray(0, n);
    view.sort((a, b) => sc[a]! - sc[b]! || keys[a]! - keys[b]!);
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = keys[view[i]!]!;
    this.fresh.length = 0;
  }
}
