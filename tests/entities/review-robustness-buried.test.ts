/**
 * Review (robustness / performance): item drops buried in solid world blocks.
 *
 * Blockify drops a structure cell that lands in a hard world block as an item at that cell's
 * centre (structures/assembly.ts: host.spawnDrop at the cell centre; ACCEPTANCE 12 "船上的风车
 * 停在岩石里时，落在岩石里的那几格掉落"). A windmill blade stopped inside a hill therefore spawns
 * drops several blocks deep in rock.
 *
 * EntityManager.moveBody then runs relocate(e, UNSTUCK_SEARCH_RADIUS = 2) for every such item on
 * EVERY tick; with no free spot within 2 blocks the full lattice search (~2000 candidates) fails
 * each time and is repeated forever (until the 6000-tick despawn). Measured: ~0.26 ms per
 * buried item per tick, i.e. 8 buried drops alone exceed the module's whole 2 ms budget.
 */
import { describe, expect, it, vi } from 'vitest';
import * as shape from '../../src/voxel/shape';
import { B, Bench, fill } from './harness';

vi.mock('../../src/voxel/shape', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/voxel/shape')>();
  return { ...m, nearestFreeOffset: vi.fn(m.nearestFreeOffset) };
});

describe('review: item drops buried deep in rock', () => {
  it('do not repeat a failing free-spot search every tick (bounded cost)', () => {
    const b = new Bench();
    fill(b.world, -12, 20, -12, 12, 50, 12, B.STONE); // solid hill, top layer y = 50
    b.entities.spawnPlayer('survival', 0.5, 51, 0.5);
    // Ten drops of blade cells 3 blocks under the surface (cell y = 47).
    for (let k = 0; k < 10; k++) b.entities.spawnItem(-5.5 + k, 47.5, 0.5, B.CANVAS, 1);
    const spy = vi.mocked(shape.nearestFreeOffset);
    b.tick(5);
    spy.mockClear();
    b.tick(100);
    // 10 items x 100 ticks = 1000 item-ticks. Before the fix every one of them ran a failing ~2000-candidate
    // search (1000 calls). Allow at most one search per 10 item-ticks.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(100);
  });
});
