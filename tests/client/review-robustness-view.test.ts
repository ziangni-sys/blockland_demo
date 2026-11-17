/**
 * Adversarial review (robustness / integration) of the client pipeline. These tests document
 * defects found in review; they are expected to FAIL until the client is fixed.
 */
import { describe, expect, it } from 'vitest';
import type {
  BackendInfo,
  CameraState,
  DryVolume,
  EntityRenderState,
  EnvironmentState,
  OverlayState,
  RenderBackend,
  RenderStats,
  StructurePose,
  TileTextureData,
} from '../../src/render/backend';
import type { MeshData, MeshResponse } from '../../src/mesh/types';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { ViewBuilder } from '../../src/client/view';
import { SectionMesher } from '../../src/client/meshing';
import type { WorkerPool } from '../../src/client/workers';

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

function flatSim(radius: number): Simulation {
  return new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, loadRadius: radius, rabbits: false });
}

describe('review: environment time of day', () => {
  it('EnvironmentState.dayTime follows Simulation.dayTime (world.time + dayOffset), not world.time alone', () => {
    const sim = flatSim(1);
    sim.tick();
    // The sim's own API for changing the time of day (also restored from saves: the 'sim' blob
    // stores dayOffset). It moves dayOffset and leaves the world clock alone.
    sim.setDayTime(0.75); // midnight
    expect(sim.dayTime).toBeCloseTo(0.75, 2);
    const v = new ViewBuilder();
    v.updateCamera(sim, 1, 0, 0, 75, 1 / 60);
    const env = v.updateEnvironment(sim, 1, 0, 4);
    // Fails today: the client computes (world.time % DAY_TICKS) / DAY_TICKS ≈ 0.04 (morning
    // sky) while the simulation (rabbits, isDay) is at midnight.
    expect(env.dayTime).toBeCloseTo(sim.dayTime, 2);
  });
});

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
    const sim = flatSim(3);
    for (let i = 0; i < 4; i++) sim.tick();
    const pool = new HoldingPool();
    const mesher = new SectionMesher(sim.world, new NullBackend(), pool as unknown as WorkerPool<MeshResponse>, () => 0, (w, e) => {
      throw new Error(`${w}: ${String(e)}`);
    });
    const p = sim.player.pos;
    // One frame with an unlimited time budget. Dozens of eligible non-trivial sections (the
    // turf layer of every inner chunk) are queued and the pool has room for size * 3 = 6 jobs.
    mesher.update(0, 1e9, p.x, p.y + 1.6, p.z, 0, -1);
    expect(mesher.queue.size).toBeGreaterThan(20);
    // Fails today (4 jobs): the sky / buried sections nearest to the camera are taken out of the
    // queue against the same 6 slots and finished on the main thread, so the workers get fewer
    // jobs than they have room for, and the rest waits for the next frame. Mesh throughput is
    // already bounded by "6 per rendered frame"; losing slots to trivial sections makes it
    // worse (at ~13 fps in SwiftShader, 15 s of flying left ~1000 sections queued and a visible
    // hole in front of the player).
    expect(pool.jobs).toBe(6);
  });
});
