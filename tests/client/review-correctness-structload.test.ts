/**
 * Adversarial review (correctness): the loading screen must wait until every structure has a
 * mesh on screen. A record exists before its mesh does: a big ship meshed in the worker pool is
 * invisible until the job returns.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { facingState, makeCell } from '../../src/blocks/cell';
import { NZ } from '../../src/core/dirs';
import { Mesher } from '../../src/mesh/mesher';
import type { MeshRequest, MeshResponse } from '../../src/mesh/types';
import { WorkerPool, type WorkerLike } from '../../src/client/workers';
import { FLAT_TOP, SessionRig } from './rig';

/** A mesh "worker" that answers world sections at once but holds anything bigger until released. */
class SlowStructureWorker implements WorkerLike {
  private readonly listeners: Array<(e: { data?: unknown }) => void> = [];
  private readonly mesher = new Mesher();
  readonly held: MeshRequest[] = [];
  postMessage(msg: unknown): void {
    const m = msg as MeshRequest;
    const i = m.input;
    if (i.sx === 16 && i.sy === 16 && i.sz === 16) this.answer(m);
    else this.held.push(m); // a structure job still running
  }
  release(): void {
    for (const m of this.held.splice(0)) this.answer(m);
  }
  private answer(m: MeshRequest): void {
    const data = this.mesher.build(m.input);
    for (const fn of this.listeners) fn({ data: { type: 'mesh', id: m.id, data } as MeshResponse });
  }
  terminate(): void {}
  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void {
    if (type === 'message') this.listeners.push(fn);
  }
}

describe('review: loading waits for structure meshes', () => {
  it('does not report "done" while a big ship has no mesh on screen yet', async () => {
    const workers: SlowStructureWorker[] = [];
    const pool = new WorkerPool<MeshResponse>({
      name: 'mesh',
      size: 2,
      create: () => {
        const w = new SlowStructureWorker();
        workers.push(w);
        return w;
      },
      firstReplyTimeoutMs: 1e9,
      now: () => 0,
    });
    let shipId = 0;
    const y = FLAT_TOP;
    const rig = await SessionRig.create({
      deps: { meshPool: pool },
      setup: (sim) => {
        // A 40 x 40 raft with a 10-high mast: padded snapshot 42*13*42 > 24^3 cells -> worker path
        for (let x = -20; x < 20; x++) for (let z = -20; z < 20; z++) sim.world.setCell(x, y, z, makeCell(B.PLANKS_OAK));
        for (let h = 1; h <= 10; h++) sim.world.setCell(5, y + h, 5, makeCell(B.PLANKS_OAK));
        sim.world.setCell(0, y + 1, 0, makeCell(B.HELM, facingState(NZ)));
        const res = sim.structures.assembleShip(0, y + 1, 0);
        expect(res.ok ? 'ok' : (res as { reason?: unknown }).reason).toBe('ok');
        if (res.ok) shipId = res.structure.id;
      },
    });
    rig.run(3000);
    expect(rig.session.replica!.state.structures.has(shipId)).toBe(true);
    expect(workers.some((w) => w.held.length > 0)).toBe(true); // the ship job is still running
    expect(rig.backend.structures.has(shipId)).toBe(false);
    // Loading may only finish once the ship is drawable.
    expect(rig.session.loadingProgress().done).toBe(false);
    expect(rig.session.state).toBe('loading');
    for (const w of workers) w.release();
    rig.playUntilReady();
    expect(rig.backend.structures.has(shipId)).toBe(true);
    expect(rig.errors).toEqual([]);
  });
});
