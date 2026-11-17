/**
 * Structure rendering: keeps one backend structure per live Structure, remeshes it when its
 * grid.version changes, writes its interpolated pose every frame, and uploads ship dry
 * volumes (water clipped inside hulls) when the hull analysis changes.
 *
 * Small structures are meshed synchronously (a freshly assembled raft then appears in the
 * same frame its blocks leave the world); big ones go to the mesh worker pool.
 */
import { quat, vec3, type Quat, type Vec3 } from '../core/math';
import { Mesher } from '../mesh/mesher';
import { snapshotStructure } from '../mesh/snapshot';
import type { MeshData, MeshRequest, MeshResponse } from '../mesh/types';
import type { RenderBackend, StructurePose } from '../render/backend';
import type { Simulation } from '../sim/simulation';
import { dryMask, type HullInfo } from '../structures/hull';
import { Ship, type Structure } from '../structures/structure';
import type { World } from '../voxel/world';
import { approach } from './interp';
import type { WorkerPool } from './workers';

/** Padded snapshot volumes up to this are meshed on the main thread. */
const SYNC_MESH_MAX_CELLS = 24 * 24 * 24;
/** Light smoothing rate (1/s) so a ship sailing under a cliff dims instead of flickering. */
const LIGHT_RATE = 6;

interface Rec {
  id: number;
  /** grid.version currently shown (-1: nothing yet). */
  shownVersion: number;
  /** grid.version of the job in flight (-1: none). */
  jobVersion: number;
  hull: HullInfo | null;
  hullVersion: number;
  hullFloats: boolean;
  sky: number;
  block: number;
  lightInit: boolean;
  seen: number;
}

export class StructureRenderer {
  private readonly recs = new Map<number, Rec>();
  private stamp = 0;
  private local: Mesher | null = null;
  private disposed = false;
  private readonly pose: StructurePose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, pivotX: 0, pivotY: 0, pivotZ: 0, sky: 15, block: 0 };
  private readonly pos: Vec3 = vec3();
  private readonly rot: Quat = quat();
  private readonly removedIds: number[] = [];

  constructor(
    private readonly backend: RenderBackend,
    private readonly pool: WorkerPool<MeshResponse> | null,
    private readonly onError: (what: string, err: unknown) => void,
  ) {}

  get count(): number {
    return this.recs.size;
  }

  /**
   * True when every live structure of the simulation has had a mesh installed (or settled as
   * empty / failed) at least once. A record exists before its mesh does: a big ship meshed in
   * the worker pool is invisible until the job returns, so loading must wait for this, not for
   * the record count.
   */
  allMeshed(sim: Simulation): boolean {
    const list = sim.structures.all();
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (s.removed) continue;
      const rec = this.recs.get(s.id);
      if (!rec || rec.shownVersion < 0) return false;
    }
    return true;
  }

  /**
   * Bring the backend in line with the simulation's structures and write every pose for the
   * blend factor `alpha`. `dt` (seconds) drives light smoothing.
   */
  update(sim: Simulation, alpha: number, dt: number): void {
    if (this.disposed) return;
    const stamp = ++this.stamp;
    const list = sim.structures.all();
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (s.removed) continue;
      let rec = this.recs.get(s.id);
      if (!rec) {
        rec = { id: s.id, shownVersion: -1, jobVersion: -1, hull: null, hullVersion: -1, hullFloats: false, sky: 15, block: 0, lightInit: false, seen: 0 };
        this.recs.set(s.id, rec);
      }
      rec.seen = stamp;
      try {
        if (s.grid.version !== rec.shownVersion && rec.jobVersion < 0) this.remesh(s, rec);
        this.writePose(sim.world, s, rec, alpha, dt);
        if (s instanceof Ship) this.updateDry(s, rec);
      } catch (e) {
        this.onError('structure rendering', e);
      }
    }
    const gone = this.removedIds;
    gone.length = 0;
    for (const rec of this.recs.values()) if (rec.seen !== stamp) gone.push(rec.id);
    for (let i = 0; i < gone.length; i++) {
      const id = gone[i]!;
      this.recs.delete(id);
      this.backend.setStructureMesh(id, 0, 0, 0, null);
    }
  }

  /** Remove every structure from the backend (session end). */
  dispose(): void {
    this.disposed = true;
    for (const id of this.recs.keys()) this.backend.setStructureMesh(id, 0, 0, 0, null);
    this.recs.clear();
  }

  private remesh(s: Structure, rec: Rec): void {
    const version = s.grid.version;
    const snap = snapshotStructure(s.grid);
    if (!snap) {
      // Empty grid (all cells gone this tick): nothing to draw until it is removed or refilled.
      this.backend.setStructureMesh(s.id, 0, 0, 0, null);
      rec.shownVersion = version;
      return;
    }
    const { input, ox, oy, oz } = snap;
    const volume = input.cells.length;
    const pool = this.pool && !this.pool.failed ? this.pool : null;
    if (pool && volume > SYNC_MESH_MAX_CELLS) {
      rec.jobVersion = version;
      const accepted = pool.submit(
        (id): MeshRequest => ({ type: 'mesh', id, input }),
        [input.cells.buffer as ArrayBuffer],
        (res) => {
          if (this.disposed || this.recs.get(s.id) !== rec) return;
          rec.jobVersion = -1;
          if ('error' in res) {
            this.onError('structure meshing', new Error(String((res as { error: unknown }).error)));
            rec.shownVersion = version; // keep the old mesh, do not loop on a bad input
            return;
          }
          this.install(s.id, ox, oy, oz, res.data);
          rec.shownVersion = version;
        },
        () => {
          // Worker lost: the next frame remeshes (on the main thread if the pool failed).
          if (this.recs.get(s.id) === rec) rec.jobVersion = -1;
        },
      );
      if (accepted) return;
      rec.jobVersion = -1;
    }
    let data: MeshData;
    try {
      this.local ??= new Mesher();
      data = this.local.build(input);
    } catch (e) {
      // Report once and keep what is shown: retrying a deterministic failure every frame would
      // spam the error and never let loading finish.
      this.onError('structure meshing', e);
      rec.shownVersion = version;
      return;
    }
    this.install(s.id, ox, oy, oz, data);
    rec.shownVersion = version;
  }

  private install(id: number, ox: number, oy: number, oz: number, data: MeshData): void {
    if (!data.opaque && !data.cutout && !data.translucent) {
      this.backend.setStructureMesh(id, 0, 0, 0, null);
      return;
    }
    this.backend.setStructureMesh(id, ox, oy, oz, data);
  }

  private writePose(world: World, s: Structure, rec: Rec, alpha: number, dt: number): void {
    const g = s.grid;
    g.renderPose(alpha, this.pos, this.rot);
    const p = this.pose;
    p.px = this.pos.x;
    p.py = this.pos.y;
    p.pz = this.pos.z;
    p.qx = this.rot.x;
    p.qy = this.rot.y;
    p.qz = this.rot.z;
    p.qw = this.rot.w;
    p.pivotX = g.pivot.x;
    p.pivotY = g.pivot.y;
    p.pivotZ = g.pivot.z;
    // World light where the structure is. Its own cells are not in the world, so the cell at
    // the pivot reads the light of the open space the structure occupies.
    const x = Math.floor(this.pos.x);
    const y = Math.floor(this.pos.y + 0.5);
    const z = Math.floor(this.pos.z);
    const sky = Math.max(world.getSkyLight(x, y, z), world.getSkyLight(x, y + 1, z));
    const block = Math.max(world.getBlockLight(x, y, z), world.getBlockLight(x, y + 1, z));
    if (!rec.lightInit) {
      rec.sky = sky;
      rec.block = block;
      rec.lightInit = true;
    } else {
      rec.sky = approach(rec.sky, sky, LIGHT_RATE, dt);
      rec.block = approach(rec.block, block, LIGHT_RATE, dt);
    }
    p.sky = rec.sky;
    p.block = rec.block;
    this.backend.setStructurePose(s.id, p);
  }

  private updateDry(ship: Ship, rec: Rec): void {
    const h = ship.hull;
    if (h === rec.hull && (h === null || (h.version === rec.hullVersion && h.floats === rec.hullFloats))) return;
    rec.hull = h;
    rec.hullVersion = h ? h.version : -1;
    rec.hullFloats = h ? h.floats : false;
    const mask = h ? dryMask(h) : null;
    this.backend.setStructureDryVolume(ship.id, h && mask ? { ox: h.ox, oy: h.oy, oz: h.oz, sx: h.sx, sy: h.sy, sz: h.sz, mask } : null);
  }
}
