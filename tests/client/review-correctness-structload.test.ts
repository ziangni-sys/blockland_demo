/**
 * Adversarial review (correctness lens): the loading screen's "structures ready" check counts
 * structure RECORDS, not structure MESHES. A big ship is meshed in the worker pool; loading
 * finishes before its mesh exists, so the player starts the game standing on an invisible deck.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { facingState, makeCell } from '../../src/blocks/cell';
import { NZ } from '../../src/core/dirs';
import { Mesher } from '../../src/mesh/mesher';
import type { MeshData, MeshRequest, MeshResponse } from '../../src/mesh/types';
import type { RenderBackend } from '../../src/render/backend';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { WorldSession } from '../../src/client/session';
import { WorkerPool, type WorkerLike } from '../../src/client/workers';

/** A mesh "worker" that answers world sections at once but is slow with anything bigger. */
class SlowStructureWorker implements WorkerLike {
  private readonly listeners: Array<(e: { data?: unknown }) => void> = [];
  private readonly mesher = new Mesher();
  readonly held: MeshRequest[] = [];
  postMessage(msg: unknown): void {
    const m = msg as MeshRequest;
    const i = m.input;
    if (i.sx === 16 && i.sy === 16 && i.sz === 16) {
      const data = this.mesher.build(i);
      for (const fn of this.listeners) fn({ data: { type: 'mesh', id: m.id, data } as MeshResponse });
    } else {
      this.held.push(m); // a structure job still running
    }
  }
  terminate(): void {}
  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void {
    if (type === 'message') this.listeners.push(fn);
  }
}

describe('review: loading waits for structure meshes', () => {
  it('does not report "done" while a big ship has no mesh on screen yet', () => {
    const gen = new FlatGenerator();
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: gen, loadRadius: 4, syncChunks: true, rabbits: false });
    for (let i = 0; i < 40; i++) sim.tick(); // load the columns around the raft
    // A 40 x 40 raft with a 10-high mast: padded snapshot 42*13*42 > 24^3 cells -> worker path
    const y = 35;
    for (let x = -20; x < 20; x++) for (let z = -20; z < 20; z++) sim.world.setCell(x, y, z, makeCell(B.PLANKS_OAK));
    for (let h = 1; h <= 10; h++) sim.world.setCell(5, y + h, 5, makeCell(B.PLANKS_OAK));
    sim.world.setCell(0, y + 1, 0, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(0, y + 1, 0);
    expect(res.ok ? 'ok' : (res as { reason?: unknown }).reason).toBe('ok');
    if (!res.ok) return;
    const shipId = res.structure.id;

    const meshes = new Map<number, MeshData | null>();
    const noop = (): void => undefined;
    const backend: RenderBackend = {
      init: async () => ({ api: 'webgl2', detail: 'fake' }),
      setTiles: noop,
      setSectionMesh: noop,
      setStructureMesh: (id, _x, _y, _z, mesh) => {
        meshes.set(id, mesh);
      },
      setStructurePose: noop,
      setStructureDryVolume: noop,
      setEntities: noop,
      setCamera: noop,
      setEnvironment: noop,
      setOverlays: noop,
      resize: noop,
      render: noop,
      stats: () => ({ drawCalls: 0, triangles: 0, sections: 0, structures: 0 }),
      dispose: noop,
    };
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
    const s = new WorldSession(sim, { id: 'x', name: 'x', seed: '', seedHash: 1, mode: 'creative', createdAt: 0, lastPlayed: 0, version: 1, time: 0 }, gen, false, {
      backend,
      genPool: null,
      meshPool: pool,
      now: () => 0,
      onError: (what, err) => {
        throw new Error(`${what}: ${String(err)}`);
      },
      onEvent: noop,
    });
    // The game's loading frame: work every frame, present now and then (here: every frame).
    let frames = 0;
    while (!s.loadingProgress().done && frames < 400) {
      s.work(0, 1e9, sim.player.pos.x, sim.player.pos.y + 1.6, sim.player.pos.z, Number.NaN);
      s.present(0, 1 / 60, 0, 0, 70, 4, 0, frames);
      frames++;
    }
    expect(workers.some((w) => w.held.length > 0)).toBe(true); // the ship job is still running
    const shipMeshed = meshes.get(shipId) != null;
    // Loading may only finish once the ship is drawable.
    expect(s.loadingProgress().done && !shipMeshed).toBe(false);
  });
});
