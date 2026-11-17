/**
 * The client's simulation -> backend pipeline against a real headless Simulation and a
 * recording fake backend (no DOM, no WebGL, no workers: every pool is null, so the
 * main-thread fallbacks run).
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
import type { MeshData } from '../../src/mesh/types';
import { B } from '../../src/blocks/defs';
import { makeCell, facingState } from '../../src/blocks/cell';
import { NZ } from '../../src/core/dirs';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { sectionKey } from '../../src/voxel/chunk';
import { SectionMesher, isTriviallyEmpty } from '../../src/client/meshing';
import { StructureRenderer } from '../../src/client/structures';
import { ChunkStreamer } from '../../src/client/chunkstream';
import { ViewBuilder, mediumAt, sampleLight } from '../../src/client/view';
import { WorldSession } from '../../src/client/session';
import { snapshotSection } from '../../src/mesh/snapshot';

class RecordingBackend implements RenderBackend {
  readonly sections = new Map<number, { ox: number; oy: number; oz: number }>();
  readonly structures = new Map<number, { ox: number; oy: number; oz: number }>();
  readonly poses = new Map<number, StructurePose>();
  readonly dry = new Map<number, DryVolume | null>();
  entities: readonly EntityRenderState[] = [];
  camera: CameraState | null = null;
  env: EnvironmentState | null = null;
  overlays: OverlayState | null = null;
  async init(): Promise<BackendInfo> {
    return { api: 'webgl2', detail: 'fake' };
  }
  setTiles(_t: TileTextureData): void {}
  setSectionMesh(key: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void {
    if (mesh) this.sections.set(key, { ox, oy, oz });
    else this.sections.delete(key);
  }
  setStructureMesh(id: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void {
    if (mesh) this.structures.set(id, { ox, oy, oz });
    else {
      this.structures.delete(id);
      this.poses.delete(id);
    }
  }
  setStructurePose(id: number, pose: StructurePose): void {
    this.poses.set(id, { ...pose });
  }
  setStructureDryVolume(id: number, dry: DryVolume | null): void {
    this.dry.set(id, dry);
  }
  setEntities(list: readonly EntityRenderState[]): void {
    this.entities = list.map((e) => ({ ...e }));
  }
  setCamera(cam: CameraState): void {
    this.camera = { ...cam };
  }
  setEnvironment(env: EnvironmentState): void {
    this.env = { ...env };
  }
  setOverlays(o: OverlayState): void {
    this.overlays = o;
  }
  resize(): void {}
  render(): void {}
  stats(): RenderStats {
    return { drawCalls: 0, triangles: 0, sections: this.sections.size, structures: this.structures.size };
  }
  dispose(): void {}
}

const noErrors = (what: string, err: unknown): void => {
  throw new Error(`${what}: ${String(err)}`);
};

function flatSim(radius = 2): Simulation {
  return new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, loadRadius: radius });
}

function meshAll(m: SectionMesher, sim: Simulation): void {
  // Until nothing is waiting and the queue only holds sections whose neighbours are missing.
  let stable = 0;
  for (let i = 0; i < 400 && stable < 3; i++) {
    const before = m.stats.installed;
    m.update(0, 1e9, sim.player.pos.x, sim.player.pos.y, sim.player.pos.z, 0, -1);
    stable = m.stats.installed === before && m.stats.waiting === 0 ? stable + 1 : 0;
  }
}

describe('isTriviallyEmpty', () => {
  it('detects all-air and all-opaque boxes', () => {
    const sim = flatSim(1);
    expect(isTriviallyEmpty(snapshotSection(sim.world, 0, 7, 0))).toBe(true); // sky
    expect(isTriviallyEmpty(snapshotSection(sim.world, 0, 0, 0))).toBe(true); // buried stone + deeprock
    expect(isTriviallyEmpty(snapshotSection(sim.world, 0, 2, 0))).toBe(false); // the surface (y = 35)
  });
});

describe('SectionMesher (main-thread fallback)', () => {
  it('meshes sections whose 8 neighbour chunks are loaded and nothing else', () => {
    const sim = flatSim(2);
    sim.tick();
    const backend = new RecordingBackend();
    const m = new SectionMesher(sim.world, backend, null, () => 0, noErrors);
    meshAll(m, sim);
    expect(backend.sections.size).toBeGreaterThan(0);
    for (const key of backend.sections.keys()) {
      const { ox, oy, oz } = backend.sections.get(key)!;
      const cx = ox / 16;
      const cz = oz / 16;
      expect(key).toBe(sectionKey(cx, oy / 16, cz));
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) expect(sim.world.getChunk(cx + dx, cz + dz)).toBeDefined();
    }
    // the flat surface lies in section y 2 (y 32..47): the player's chunk has it
    expect(backend.sections.has(sectionKey(0, 2, 0))).toBe(true);
    expect(m.isSettled(sectionKey(0, 2, 0))).toBe(true);
    // sky sections are settled but have no mesh
    expect(m.isSettled(sectionKey(0, 7, 0))).toBe(true);
    expect(backend.sections.has(sectionKey(0, 7, 0))).toBe(false);
  });

  it('remeshes after an edit and drops meshes when a chunk unloads', () => {
    const sim = flatSim(2);
    sim.tick();
    const backend = new RecordingBackend();
    const m = new SectionMesher(sim.world, backend, null, () => 0, noErrors);
    meshAll(m, sim);
    const installed = m.stats.installed;
    sim.world.setCell(3, 40, 3, makeCell(B.BRICKS));
    m.update(0, 1e9, 0, 40, 0, 0, -1); // snapshot + mesh
    m.update(0, 1e9, 0, 40, 0, 0, -1); // install
    expect(m.stats.installed).toBeGreaterThan(installed);
    expect(backend.sections.has(sectionKey(0, 2, 0))).toBe(true);
    m.dropChunk(0, 0);
    for (let sy = 0; sy < 8; sy++) expect(backend.sections.has(sectionKey(0, sy, 0))).toBe(false);
    expect(m.isSettled(sectionKey(0, 2, 0))).toBe(false);
    m.dispose();
    expect(backend.sections.size).toBe(0);
  });
});

describe('ChunkStreamer (main-thread fallback)', () => {
  it('feeds wanted columns into the world one or more per frame', () => {
    const gen = new FlatGenerator();
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: gen, loadRadius: 3 });
    sim.tick(); // sets the load anchors
    const before = sim.world.chunks.size;
    const s = new ChunkStreamer(sim, null, gen, () => 0, noErrors);
    for (let i = 0; i < 200; i++) s.update(0, 1e9);
    expect(sim.world.chunks.size).toBeGreaterThan(before);
    // every column within the radius is now loaded
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx * dx + dz * dz <= 12) expect(sim.world.getChunk(dx, dz)).toBeDefined();
    expect(s.stats.syncGenerated).toBeGreaterThan(0);
  });
});

describe('StructureRenderer', () => {
  it('meshes a freshly assembled ship, poses it every frame and removes it when it docks', () => {
    const sim = flatSim(2);
    sim.tick();
    const y = 35;
    for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) sim.world.setCell(x, y, z, makeCell(B.PLANKS_OAK));
    sim.world.setCell(4, y + 1, 4, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(4, y + 1, 4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    const backend = new RecordingBackend();
    const r = new StructureRenderer(backend, null, noErrors);
    r.update(sim, 1, 1 / 60);
    expect(backend.structures.has(ship.id)).toBe(true);
    const pose = backend.poses.get(ship.id)!;
    expect(pose.pivotX).toBeCloseTo(ship.grid.pivot.x);
    expect(pose.px).toBeCloseTo(ship.grid.position.x);
    expect(pose.sky).toBeGreaterThan(0);
    expect(backend.structures.get(ship.id)).toEqual({ ox: 2, oy: y, oz: 2 });
    // editing the ship remeshes it
    const meshed = backend.structures.get(ship.id);
    ship.grid.setCell(2, y + 1, 2, makeCell(B.PLANKS_OAK));
    r.update(sim, 1, 1 / 60);
    expect(backend.structures.get(ship.id)).not.toBe(meshed);
    // the structure leaves -> its mesh is removed
    sim.structures.clear();
    r.update(sim, 1, 1 / 60);
    expect(backend.structures.size).toBe(0);
  });
});

describe('ViewBuilder', () => {
  it('puts the camera at the eyes and lists every entity but the player', () => {
    const sim = flatSim(1);
    for (let i = 0; i < 5; i++) sim.tick();
    const p = sim.player;
    sim.entities.spawnItem(p.pos.x + 2, p.pos.y + 0.5, p.pos.z, B.STONE, 3);
    sim.tick();
    const v = new ViewBuilder();
    const cam = v.updateCamera(sim, 1, 0.5, -0.2, 70, 1 / 60);
    expect(cam.x).toBeCloseTo(p.pos.x);
    expect(cam.y).toBeCloseTo(p.pos.y + p.eyeHeight);
    expect(cam.yaw).toBe(0.5);
    expect(cam.pitch).toBe(-0.2);
    expect(cam.fov).toBeCloseTo(70);
    const list = v.updateEntities(sim, 0.5);
    expect(list.length).toBe(1);
    expect(list[0]!.kind).toBe('item');
    expect(list[0]!.payload).toBe(B.STONE);
    expect(list[0]!.sky).toBe(15);
    const env = v.updateEnvironment(sim, 0, 12.5, 6);
    expect(env.viewDistance).toBe(96);
    expect(env.submerged).toBe('none');
    expect(env.time).toBe(12.5);
    expect(env.dayTime).toBeGreaterThanOrEqual(0);
    expect(env.dayTime).toBeLessThan(1);
  });

  it('detects water above and below its surface', () => {
    const sim = flatSim(1);
    sim.world.setCell(1, 35, 1, makeCell(B.WATER, 0));
    sim.world.setCell(1, 36, 1, makeCell(B.WATER, 0));
    expect(mediumAt(sim.world, 1.5, 35.9, 1.5)).toBe('water'); // water above: full cell
    expect(mediumAt(sim.world, 1.5, 36.5, 1.5)).toBe('water'); // source surface at 14/16
    expect(mediumAt(sim.world, 1.5, 36.95, 1.5)).toBe('none');
    expect(mediumAt(sim.world, 1.5, 40, 1.5)).toBe('none');
    const light = { sky: 0, block: 0 };
    sampleLight(sim.world, 0.5, 34.5, 0.5, light); // inside turf -> samples the cell above
    expect(light.sky).toBe(15);
  });

  it('turns the interaction view into overlays and caches the preview list', () => {
    const sim = flatSim(1);
    sim.tick();
    const v = new ViewBuilder();
    sim.view = {
      ...sim.view,
      target: { gridId: 0, x: 1, y: 34, z: 1, face: 2 },
      breakProgress: 2,
      preview: { gridId: 0, kind: 'ship', cells: Int32Array.from([1, 34, 1, 2, 34, 1]) },
      conflicts: [{ x: 5, y: 6, z: 7 }],
    };
    const o = v.updateOverlays(sim, 0);
    expect(o.target).toEqual({ structureId: 0, x: 1, y: 34, z: 1 });
    expect(o.breakProgress).toBe(1);
    expect(o.preview.length).toBe(2);
    expect(o.conflicts).toEqual([{ structureId: 0, x: 5, y: 6, z: 7 }]);
    const previewList = o.preview;
    v.updateOverlays(sim, 16);
    expect(o.preview).toBe(previewList);
  });
});

describe('WorldSession', () => {
  it('reaches "loading done" once the area around the player is generated and meshed', () => {
    const gen = new FlatGenerator();
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: gen, loadRadius: 4 });
    const backend = new RecordingBackend();
    const events: string[] = [];
    const s = new WorldSession(sim, { id: 'x', name: 'x', seed: '', seedHash: 1, mode: 'creative', createdAt: 0, lastPlayed: 0, version: 1, time: 0 }, gen, true, {
      backend,
      genPool: null,
      meshPool: null,
      now: () => 0,
      onError: noErrors,
      onEvent: (e) => events.push(e.type),
    });
    sim.tick();
    expect(s.loadingProgress().done).toBe(false);
    let frames = 0;
    while (!s.loadingProgress().done && frames < 500) {
      s.work(0, 1e9, sim.player.pos.x, sim.player.pos.y + 1.6, sim.player.pos.z, Number.NaN);
      frames++;
    }
    const prog = s.loadingProgress();
    expect(prog.done).toBe(true);
    expect(prog.progress).toBe(1);
    s.present(1, 1 / 60, 0, 0, 70, 4, 0, 0);
    expect(backend.camera).not.toBeNull();
    expect(backend.overlays).not.toBeNull();
    s.dispose();
    expect(backend.sections.size).toBe(0);
    expect(sim.chunks.onUnload).toBeNull();
  });
});
