/**
 * Per-frame render state built from the simulation: camera, environment, entities and
 * overlays. Everything is interpolated between the previous and the current tick with the
 * loop's alpha, and written into objects owned by this class (no per-frame garbage beyond a
 * few small arrays when lists change).
 */
import { DAY_TICKS } from '../core/constants';
import { quat, vec3, type Vec3 } from '../core/math';
import { ID_MASK, liquidAmount, STATE_MASK, STATE_SHIFT } from '../blocks/cell';
import { I } from '../blocks/items';
import { LIQUID, LIQUID_LAVA, LIQUID_WATER, OPAQUE } from '../blocks/registry';
import { LIQUID_FULL_HEIGHT } from '../mesh/mesher';
import type {
  CameraState,
  EntityRenderState,
  EnvironmentState,
  OverlayCell,
  OverlayFace,
  OverlayState,
} from '../render/backend';
import type { Simulation } from '../sim/simulation';
import type { InteractionView } from '../sim/view';
import { FallingBlockEntity, ItemEntity, Player, TntEntity, type Entity } from '../entities/entity';
import { isDryCell } from '../structures/hull';
import type { World } from '../voxel/world';
import { approach, interpolateCarried, lerpAngle, lerpVec, type FramePose } from './interp';

/** Radius (blocks) around the player in which glued faces are drawn while holding glue. */
export const GLUE_VIEW_RADIUS = 8;
/** Glue faces are re-collected at most this often unless a glue store changed. */
const GLUE_REFRESH_MS = 250;
/** Sprinting widens the view a little (smoothed). */
const SPRINT_FOV_SCALE = 1.1;

/** Light (sky, block) of the open cell at or just above a point, 0..15 each. */
export function sampleLight(world: World, x: number, y: number, z: number, out: { sky: number; block: number }): void {
  const fx = Math.floor(x);
  let fy = Math.floor(y);
  const fz = Math.floor(z);
  // Inside an opaque block every light is 0; the cell above is what lights the body.
  if (OPAQUE[world.getCell(fx, fy, fz) & ID_MASK] === 1) fy++;
  out.sky = world.getSkyLight(fx, fy, fz);
  out.block = world.getBlockLight(fx, fy, fz);
}

/**
 * Medium at a world point: the liquid of the cell if the point is below that liquid's
 * surface (the mesher's surface height), else 'none'. Dry hull cells are handled by the caller.
 */
export function mediumAt(world: World, x: number, y: number, z: number): 'none' | 'water' | 'lava' {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const cell = world.getCell(fx, fy, fz);
  const kind = LIQUID[cell & ID_MASK];
  if (kind !== LIQUID_WATER && kind !== LIQUID_LAVA) return 'none';
  const above = world.getCell(fx, fy + 1, fz);
  if (LIQUID[above & ID_MASK] !== kind) {
    const height = (liquidAmount((cell >>> STATE_SHIFT) & STATE_MASK) / 8) * LIQUID_FULL_HEIGHT;
    if (y - fy >= height) return 'none';
  }
  return kind === LIQUID_WATER ? 'water' : 'lava';
}

function newEntityState(): EntityRenderState {
  return { id: 0, kind: 'item', x: 0, y: 0, z: 0, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 };
}

export class ViewBuilder {
  readonly camera: CameraState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fov: 75 };
  readonly env: EnvironmentState = { dayTime: 0, submerged: 'none', viewDistance: 128, time: 0 };
  readonly overlay: OverlayState = { target: null, breakProgress: 0, preview: [], conflicts: [], glue: [], glueAnchor: null };

  private readonly entityPool: EntityRenderState[] = [];
  private readonly entityList: EntityRenderState[] = [];
  private fovScale = 1;

  // overlay caches (rebuilt only when the simulation publishes a new object)
  private readonly targetCell: OverlayCell = { structureId: 0, x: 0, y: 0, z: 0 };
  private readonly anchorCell: OverlayCell = { structureId: 0, x: 0, y: 0, z: 0 };
  private lastPreview: InteractionView['preview'] | undefined = undefined;
  private lastConflicts: InteractionView['conflicts'] | undefined = undefined;
  private glueAt = -Infinity;
  private glueKey = '';
  private glueShown = false;

  // scratch
  private readonly framePrev: FramePose = { position: vec3(), rotation: quat() };
  private readonly frameCur: FramePose = { position: vec3(), rotation: quat() };
  private readonly frameRender: FramePose = { position: vec3(), rotation: quat() };
  private readonly scratch: Vec3 = vec3();
  private readonly scratch2: Vec3 = vec3();
  private readonly light = { sky: 15, block: 0 };

  /**
   * Interpolated position of an entity's feet. Riders (and helmsmen) are interpolated in their
   * carrier's frame so they do not jitter against the carrier's interpolated mesh.
   */
  renderPosition(sim: Simulation, e: Entity, alpha: number, out: Vec3): Vec3 {
    const carrierId = e instanceof Player && e.steeringShipId !== 0 ? e.steeringShipId : e.carrierId;
    if (carrierId !== 0) {
      const s = sim.structures.get(carrierId);
      if (s && !s.removed) {
        const g = s.grid;
        g.renderPose(0, this.framePrev.position, this.framePrev.rotation);
        g.renderPose(1, this.frameCur.position, this.frameCur.rotation);
        g.renderPose(alpha, this.frameRender.position, this.frameRender.rotation);
        return interpolateCarried(e.prevPos, e.pos, this.framePrev, this.frameCur, this.frameRender, g.pivot, alpha, out, this.scratch);
      }
    }
    return lerpVec(e.prevPos, e.pos, alpha, out);
  }

  /** First-person camera at the local player's eyes. `yaw`/`pitch` come straight from the input. */
  updateCamera(sim: Simulation, alpha: number, yaw: number, pitch: number, fov: number, dt: number): CameraState {
    const p = sim.player;
    const pos = this.renderPosition(sim, p, alpha, this.scratch2);
    const cam = this.camera;
    cam.x = pos.x;
    cam.y = pos.y + p.eyeHeight;
    cam.z = pos.z;
    cam.yaw = yaw;
    cam.pitch = pitch;
    const moving = Math.hypot(p.vel.x - p.carrierVel.x, p.vel.z - p.carrierVel.z) > 1;
    this.fovScale = approach(this.fovScale, p.sprinting && moving ? SPRINT_FOV_SCALE : 1, 10, dt);
    cam.fov = Math.min(150, fov * this.fovScale);
    return cam;
  }

  updateEnvironment(sim: Simulation, alpha: number, timeSec: number, renderDistance: number): EnvironmentState {
    const env = this.env;
    const t = (sim.world.time % DAY_TICKS) + alpha;
    env.dayTime = (t / DAY_TICKS) % 1;
    env.viewDistance = renderDistance * 16;
    env.time = timeSec;
    const c = this.camera;
    let medium = mediumAt(sim.world, c.x, c.y, c.z);
    if (medium !== 'none' && this.inDryHull(sim, c)) medium = 'none';
    env.submerged = medium;
    return env;
  }

  /** True when the point is in a dry cell of some ship's hull (water there is cut away). */
  private inDryHull(sim: Simulation, p: Vec3): boolean {
    const ships = sim.structures.ships();
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i]!;
      const h = s.hull;
      if (!h || s.removed) continue;
      const l = s.grid.toLocal(p, this.scratch);
      if (isDryCell(h, Math.floor(l.x), Math.floor(l.y), Math.floor(l.z))) return true;
    }
    return false;
  }

  /** Every entity except the local player, interpolated and lit. */
  updateEntities(sim: Simulation, alpha: number): readonly EntityRenderState[] {
    const list = this.entityList;
    list.length = 0;
    const player = sim.player;
    const all = sim.entities.all();
    const world = sim.world;
    for (let i = 0; i < all.length; i++) {
      const e = all[i]!;
      if (e === player || e.removed) continue;
      let s = this.entityPool[list.length];
      if (!s) {
        s = newEntityState();
        this.entityPool.push(s);
      }
      const pos = this.renderPosition(sim, e, alpha, this.scratch2);
      s.id = e.id;
      s.kind = e.kind;
      s.x = pos.x;
      s.y = pos.y;
      s.z = pos.z;
      s.yaw = lerpAngle(e.prevYaw, e.yaw, alpha);
      s.payload = e instanceof ItemEntity ? e.stack.item : e instanceof FallingBlockEntity ? e.cell : 0;
      s.flash = e instanceof TntEntity ? (Math.floor(e.fuse / 4) % 2 === 0 ? 0.8 : 0) : e instanceof Player && e.hurtTicks > 0 ? 0.6 : 0;
      sampleLight(world, pos.x, pos.y + Math.min(0.5, e.height * 0.5), pos.z, this.light);
      s.sky = this.light.sky;
      s.block = this.light.block;
      list.push(s);
    }
    return list;
  }

  /** Overlays from the interaction view plus nearby glue while holding glue. */
  updateOverlays(sim: Simulation, nowMs: number): OverlayState {
    const o = this.overlay;
    const v = sim.view;
    if (v.target) {
      const t = this.targetCell;
      t.structureId = v.target.gridId;
      t.x = v.target.x;
      t.y = v.target.y;
      t.z = v.target.z;
      o.target = t;
    } else {
      o.target = null;
    }
    o.breakProgress = v.target ? Math.max(0, Math.min(1, v.breakProgress)) : 0;
    if (v.preview !== this.lastPreview) {
      this.lastPreview = v.preview;
      const cells: OverlayCell[] = [];
      const pv = v.preview;
      if (pv) {
        const a = pv.cells;
        for (let i = 0; i + 2 < a.length; i += 3) cells.push({ structureId: pv.gridId, x: a[i]!, y: a[i + 1]!, z: a[i + 2]! });
      }
      o.preview = cells;
    }
    if (v.conflicts !== this.lastConflicts) {
      this.lastConflicts = v.conflicts;
      o.conflicts = v.conflicts.map((c) => ({ structureId: 0, x: c.x, y: c.y, z: c.z }));
    }
    if (v.glueAnchor) {
      const a = this.anchorCell;
      a.structureId = v.glueAnchor.gridId;
      a.x = v.glueAnchor.x;
      a.y = v.glueAnchor.y;
      a.z = v.glueAnchor.z;
      o.glueAnchor = a;
    } else {
      o.glueAnchor = null;
    }
    this.updateGlue(sim, nowMs);
    return o;
  }

  private updateGlue(sim: Simulation, nowMs: number): void {
    const o = this.overlay;
    const p = sim.player;
    const held = p.inventory.selectedStack();
    if (!held || held.item !== I.GLUE || p.dead) {
      if (this.glueShown) {
        o.glue = [];
        this.glueShown = false;
        this.glueKey = '';
      }
      return;
    }
    // Re-collect when a store changed or the player moved, at most every GLUE_REFRESH_MS.
    let key = `${sim.worldGlue.version}`;
    const structures = sim.structures.all();
    for (let i = 0; i < structures.length; i++) key += `,${structures[i]!.id}:${structures[i]!.glue.version}`;
    const changed = key !== this.glueKey;
    if (!changed && nowMs - this.glueAt < GLUE_REFRESH_MS) return;
    this.glueKey = key;
    this.glueAt = nowMs;
    this.glueShown = true;
    const r = GLUE_VIEW_RADIUS;
    const faces: OverlayFace[] = [];
    const px = Math.floor(p.pos.x);
    const py = Math.floor(p.pos.y + 1);
    const pz = Math.floor(p.pos.z);
    for (const f of sim.worldGlue.facesInBox(px - r, py - r, pz - r, px + r, py + r, pz + r)) {
      faces.push({ structureId: 0, x: f.x, y: f.y, z: f.z, face: f.axis * 2 });
    }
    const eye = p.eyePos(this.scratch2);
    for (let i = 0; i < structures.length; i++) {
      const s = structures[i]!;
      if (s.removed || s.glue.size === 0) continue;
      const l = s.grid.toLocal(eye, this.scratch);
      const lx = Math.floor(l.x);
      const ly = Math.floor(l.y);
      const lz = Math.floor(l.z);
      for (const f of s.glue.facesInBox(lx - r, ly - r, lz - r, lx + r, ly + r, lz + r)) {
        faces.push({ structureId: s.id, x: f.x, y: f.y, z: f.z, face: f.axis * 2 });
      }
    }
    o.glue = faces;
  }
}
