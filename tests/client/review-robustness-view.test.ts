/**
 * Adversarial review (robustness) of the meshing throughput.
 */
import { describe, expect, it } from 'vitest';
import type { BackendInfo, CameraState, DryVolume, EntityRenderState, EnvironmentState, OverlayState, RenderBackend, RenderStats, StructurePose, TileTextureData } from '../../src/render/backend';
import type { MeshData, MeshResponse } from '../../src/mesh/types';
import { SectionMesher } from '../../src/client/meshing';
import type { WorkerPool } from '../../src/client/workers';
import { FLAT_TOP, flatWorld } from './rig';

class NullBackend implements RenderBackend {
  async init(): Promise<BackendInfo> {
    return { api: 'webgl2', detail: 'fake' };
  }
  setTiles(_t: TileTextureData): void {}
  setSectionMesh(_k: number, _x: number, _y: number, _z: number, _m: MeshData | null): void {}
  setStructureMesh(_id: number, _x: number, _y: number, _z: number, _m: MeshData | null): void {}
  setStructurePose(_id: number, _p: StructurePose): void {}
  setStructureDryVolume(_id: number, _d: DryVolume | null): void {}
  setEntities(_l: readonly EntityRenderState[]): void {}
  setCamera(_c: CameraState): void {}
  setEnvironment(_e: EnvironmentState): void {}
  setOverlays(_o: OverlayState): void {}
  resize(): void {}
  render(): void {}
  stats(): RenderStats {
    return { drawCalls: 0, triangles: 0, sections: 0, structures: 0 };
  }
  dispose(): void {}
}

/** A worker pool that accepts jobs and never answers (we only look at what was dispatched). */
class HoldingPool {
  readonly failed = false;
  readonly size = 2;
  jobs = 0;
  get inFlight(): number {
    return this.jobs;
  }
  submit(_build: (id: number) => unknown, _t: Transferable[], _done: (r: MeshResponse) => void, _fail: (r: string) => void): boolean {
    this.jobs++;
    return true;
  }
}

describe('review: mesh worker utilisation', () => {
  it('trivially empty sections (all air / all solid) do not use up the per-frame worker slots', () => {
    const world = flatWorld(3);
    const pool = new HoldingPool();
    const mesher = new SectionMesher(world, new NullBackend(), pool as unknown as WorkerPool<MeshResponse>, () => 0, (w, e) => {
      throw new Error(`${w}: ${String(e)}`);
    });
    // One frame with an unlimited time budget. Dozens of eligible non-trivial sections (the
    // turf layer of every inner chunk) are queued and the pool has room for size * 3 = 6 jobs.
    mesher.update(0, 1e9, 0.5, FLAT_TOP + 1.6, 0.5, 0, -1);
    expect(mesher.queue.size).toBeGreaterThan(20);
    // The sky / buried sections nearest to the camera finish on the main thread without taking
    // the workers' slots: the workers get all the jobs they have room for.
    expect(pool.jobs).toBe(6);
  });
});
