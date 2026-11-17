import { describe, expect, it } from 'vitest';
import { MeshQueue, sectionKeyCx, sectionKeyCz, sectionKeySy, sectionScore } from '../../src/client/meshqueue';
import { sectionKey } from '../../src/voxel/chunk';

const all = (): boolean => true;

function takeAll(q: MeshQueue, max = 1000, eligible: (cx: number, cz: number) => boolean = all): number[] {
  const out: number[] = [];
  q.take(max, eligible, out);
  return out;
}

describe('section key helpers', () => {
  it('decode sectionKey for negative and positive chunks', () => {
    for (const [cx, sy, cz] of [
      [0, 0, 0],
      [-1, 7, -1],
      [123, 3, -456],
      [-5000, 5, 4000],
    ] as const) {
      const k = sectionKey(cx, sy, cz);
      expect(sectionKeyCx(k)).toBe(cx);
      expect(sectionKeySy(k)).toBe(sy);
      expect(sectionKeyCz(k)).toBe(cz);
    }
  });

  it('scores by distance and penalises sections behind the camera', () => {
    const near = sectionScore(sectionKey(0, 0, 0), 8, 8, 8, 0, -1);
    const ahead = sectionScore(sectionKey(0, 0, -3), 8, 8, 8, 0, -1);
    const behind = sectionScore(sectionKey(0, 0, 3), 8, 8, 8, 0, -1);
    expect(near).toBe(0);
    expect(behind).toBeCloseTo(ahead * 3);
    // without a facing nothing is penalised
    expect(sectionScore(sectionKey(0, 0, 3), 8, 8, 8, 0, 0)).toBeCloseTo(ahead);
    // the immediate surroundings are never penalised (turning around must not leave holes)
    expect(sectionScore(sectionKey(0, 0, 1), 8, 8, 8, 0, -1)).toBe(256);
  });
});

describe('MeshQueue', () => {
  it('de-duplicates sections dirtied many times', () => {
    const q = new MeshQueue();
    const k = sectionKey(1, 2, 3);
    q.add(k);
    q.add(k);
    q.add(k);
    expect(q.size).toBe(1);
    expect(takeAll(q)).toEqual([k]);
    expect(q.size).toBe(0);
  });

  it('hands out the nearest sections first', () => {
    const q = new MeshQueue();
    q.setFocus(8, 8, 8, 0, 0);
    const far = sectionKey(5, 0, 0);
    const mid = sectionKey(0, 0, 2);
    const near = sectionKey(0, 0, 0);
    const up = sectionKey(0, 3, 0);
    for (const k of [far, up, mid, near]) q.add(k);
    expect(takeAll(q, 2)).toEqual([near, mid]);
    expect(takeAll(q, 5)).toEqual([up, far]);
  });

  it('re-sorts when the focus moves', () => {
    const q = new MeshQueue();
    const a = sectionKey(0, 0, 0);
    const b = sectionKey(10, 0, 0);
    q.add(a);
    q.add(b);
    q.setFocus(8, 8, 8, 0, 0);
    q.take(0, all, []);
    q.setFocus(10 * 16 + 8, 8, 8, 0, 0);
    expect(takeAll(q, 1)).toEqual([b]);
  });

  it('keeps ineligible sections queued until their neighbours load', () => {
    const q = new MeshQueue();
    const edge = sectionKey(4, 0, 0);
    const inner = sectionKey(0, 0, 0);
    q.add(edge);
    q.add(inner);
    const loaded = new Set([0]);
    const eligible = (cx: number): boolean => loaded.has(cx);
    expect(takeAll(q, 10, eligible)).toEqual([inner]);
    expect(q.size).toBe(1);
    expect(q.isQueued(edge)).toBe(true);
    loaded.add(4);
    expect(takeAll(q, 10, eligible)).toEqual([edge]);
  });

  it('re-queues a section dirtied while its job is in flight, and still installs the old result', () => {
    const q = new MeshQueue();
    const k = sectionKey(0, 1, 0);
    q.add(k);
    takeAll(q);
    expect(q.isInFlight(k)).toBe(true);
    q.add(k); // dirtied again while meshing
    expect(q.size).toBe(0);
    expect(q.complete(k)).toBe('install');
    expect(q.isQueued(k)).toBe(true);
    expect(takeAll(q)).toEqual([k]);
    expect(q.complete(k)).toBe('install');
    expect(q.isPending(k)).toBe(false);
  });

  it('discards results of a chunk that unloaded while its jobs were in flight', () => {
    const q = new MeshQueue();
    const a = sectionKey(2, 0, 2);
    const b = sectionKey(2, 1, 2);
    const other = sectionKey(3, 0, 2);
    q.add(a);
    q.add(other);
    takeAll(q);
    q.add(b); // queued, not in flight
    q.dropChunk(2, 2);
    expect(q.isQueued(b)).toBe(false);
    expect(q.complete(a)).toBe('discard');
    expect(q.complete(other)).toBe('install');
    expect(q.size).toBe(0);
  });

  it('a chunk that unloads and reloads during a job discards the stale result but meshes again', () => {
    const q = new MeshQueue();
    const k = sectionKey(1, 0, 1);
    q.add(k);
    takeAll(q);
    q.dropChunk(1, 1);
    q.add(k); // reloaded: World.addChunk dirties every section again
    expect(q.complete(k)).toBe('discard');
    expect(q.isQueued(k)).toBe(true);
  });

  it('retry puts a failed job back unless its chunk is gone', () => {
    const q = new MeshQueue();
    const a = sectionKey(0, 0, 0);
    const b = sectionKey(5, 0, 5);
    q.add(a);
    q.add(b);
    takeAll(q);
    q.retry(a);
    expect(q.isQueued(a)).toBe(true);
    q.dropChunk(5, 5);
    q.retry(b);
    expect(q.isPending(b)).toBe(false);
    // completing something that is not in flight is a no-op
    expect(q.complete(sectionKey(9, 9 % 8, 9))).toBe('discard');
  });

  it('big queues still hand out keys added between (throttled) sorts', () => {
    const q = new MeshQueue();
    q.setFocus(0, 0, 0, 0, 0);
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) q.add(sectionKey(x, 0, z));
    expect(q.size).toBe(1600);
    const first = takeAll(q, 1);
    expect(first).toEqual([sectionKey(0, 0, 0)]);
    const late = sectionKey(-1, 0, -1);
    q.add(late);
    const got = takeAll(q, 2000);
    expect(got.length).toBe(1600);
    expect(got).toContain(late);
    expect(new Set(got).size).toBe(got.length);
  });

  it('clear forgets everything', () => {
    const q = new MeshQueue();
    q.add(1);
    q.add(2);
    takeAll(q, 1);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.inFlightCount).toBe(0);
  });
});
