/**
 * One running world: the Simulation plus everything that turns it into pictures — chunk
 * streaming, section meshing, structure meshes / poses, camera, environment, entities and
 * overlays. Created when a world is created or loaded, disposed on save & quit; the Game owns
 * screens, input, saving and the frame loop.
 */
import { CHUNK_SHIFT, SECTIONS_PER_CHUNK } from '../core/constants';
import type { MeshResponse } from '../mesh/types';
import type { RenderBackend } from '../render/backend';
import type { Simulation } from '../sim/simulation';
import type { SimEvent } from '../sim/view';
import type { WorldMeta } from '../save/codec';
import { sectionKey } from '../voxel/chunk';
import type { ChunkGenerator } from '../worldgen/generator';
import type { GenErrorResponse, GenResponse } from '../worldgen/protocol';
import type { ViewMode } from './camera';
import { ChunkStreamer } from './chunkstream';
import { SectionMesher } from './meshing';
import { StructureRenderer } from './structures';
import { ViewBuilder } from './view';
import type { WorkerPool } from './workers';

/** Sections of chunks within this (square) radius of the player must be meshed before play starts. */
export const READY_MESH_RADIUS = 2;

export interface SessionDeps {
  backend: RenderBackend;
  genPool: WorkerPool<GenResponse | GenErrorResponse> | null;
  meshPool: WorkerPool<MeshResponse> | null;
  now: () => number;
  onError: (what: string, err: unknown) => void;
  onEvent: (ev: SimEvent) => void;
}

export interface LoadingProgress {
  done: boolean;
  /** 0..1 */
  progress: number;
  phase: 'terrain' | 'meshing' | 'finishing';
  chunksLoaded: number;
  chunksNeeded: number;
  sectionsReady: number;
  sectionsNeeded: number;
}

export class WorldSession {
  state: 'loading' | 'ready' = 'loading';
  readonly streamer: ChunkStreamer;
  readonly mesher: SectionMesher;
  readonly structures: StructureRenderer;
  readonly view = new ViewBuilder();
  /** Set once the first autosave / initial save of a new world went through. */
  savedOnce = false;
  /** Saving is refused for this world (a newer build wrote it meanwhile). */
  saveBlocked = false;
  /** Milliseconds of running simulation since the last autosave. */
  sinceAutosave = 0;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    readonly sim: Simulation,
    public meta: WorldMeta,
    readonly generator: ChunkGenerator,
    readonly isNew: boolean,
    private readonly deps: SessionDeps,
  ) {
    this.streamer = new ChunkStreamer(sim, deps.genPool, generator, deps.now, deps.onError);
    this.mesher = new SectionMesher(sim.world, deps.backend, deps.meshPool, deps.now, deps.onError);
    this.structures = new StructureRenderer(deps.backend, deps.meshPool, deps.onError);
    sim.chunks.onUnload = (cx, cz) => this.mesher.dropChunk(cx, cz);
    this.unsubscribe = sim.events.on((ev) => {
      if (!this.disposed) deps.onEvent(ev);
    });
  }

  /**
   * Streaming + meshing for one frame within `budgetMs` (from `frameStart`). `yaw` = view
   * direction for meshing priority; NaN = no preferred direction (loading: everything around
   * the player is needed before play starts).
   */
  work(frameStart: number, budgetMs: number, camX: number, camY: number, camZ: number, yaw: number): void {
    // Chunks first (they unblock meshing), but never more than about half the budget.
    try {
      this.streamer.update(frameStart, budgetMs * 0.5);
    } catch (e) {
      this.deps.onError('chunk streaming', e);
    }
    try {
      const facing = Number.isFinite(yaw);
      this.mesher.update(frameStart, budgetMs, camX, camY, camZ, facing ? -Math.sin(yaw) : 0, facing ? -Math.cos(yaw) : 0);
    } catch (e) {
      this.deps.onError('meshing', e);
    }
  }

  /** How far the area around the player is from being playable. */
  loadingProgress(): LoadingProgress {
    const p = this.sim.player.pos;
    const pcx = Math.floor(p.x) >> CHUNK_SHIFT;
    const pcz = Math.floor(p.z) >> CHUNK_SHIFT;
    const world = this.sim.world;
    const rl = READY_MESH_RADIUS + 1;
    let loaded = 0;
    let needed = 0;
    for (let dz = -rl; dz <= rl; dz++) {
      for (let dx = -rl; dx <= rl; dx++) {
        needed++;
        if (world.getChunk(pcx + dx, pcz + dz)) loaded++;
      }
    }
    let ready = 0;
    let sections = 0;
    const r = READY_MESH_RADIUS;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
          sections++;
          if (this.mesher.isSettled(sectionKey(pcx + dx, sy, pcz + dz))) ready++;
        }
      }
    }
    const structuresReady = this.structures.allMeshed(this.sim);
    const done = loaded === needed && ready === sections && structuresReady;
    const progress = Math.min(1, 0.45 * (loaded / needed) + 0.55 * (ready / sections));
    const phase = loaded < needed ? 'terrain' : ready < sections ? 'meshing' : 'finishing';
    return { done, progress: done ? 1 : Math.min(progress, 0.99), phase, chunksLoaded: loaded, chunksNeeded: needed, sectionsReady: ready, sectionsNeeded: sections };
  }

  /**
   * Push this frame's state to the backend: structures, camera, environment, entities and
   * overlays, all at blend factor `alpha`. Each part is isolated so one failure cannot blank
   * the others. `viewMode` places the camera (first / third person); the camera goes first, the
   * entity list (which then includes the local player in third person) after it.
   */
  present(
    alpha: number,
    dt: number,
    yaw: number,
    pitch: number,
    fov: number,
    renderDistance: number,
    envTime: number,
    nowMs: number,
    viewMode: ViewMode = 'first',
  ): void {
    const b = this.deps.backend;
    const sim = this.sim;
    const v = this.view;
    try {
      this.structures.update(sim, alpha, dt);
    } catch (e) {
      this.deps.onError('structures', e);
    }
    try {
      b.setCamera(v.updateCamera(sim, alpha, yaw, pitch, fov, dt, viewMode));
    } catch (e) {
      this.deps.onError('camera', e);
    }
    try {
      b.setEnvironment(v.updateEnvironment(sim, alpha, envTime, renderDistance));
    } catch (e) {
      this.deps.onError('environment', e);
    }
    try {
      b.setEntities(v.updateEntities(sim, alpha));
    } catch (e) {
      this.deps.onError('entities', e);
    }
    try {
      b.setOverlays(v.updateOverlays(sim, nowMs));
    } catch (e) {
      this.deps.onError('overlays', e);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (this.sim.chunks.onUnload) this.sim.chunks.onUnload = null;
    this.streamer.dispose();
    this.mesher.dispose();
    this.structures.dispose();
    try {
      this.deps.backend.setEntities([]);
      this.deps.backend.setOverlays({ target: null, breakProgress: 0, preview: [], conflicts: [], glue: [], glueAnchor: null });
    } catch {
      // the backend may already be gone
    }
  }
}
