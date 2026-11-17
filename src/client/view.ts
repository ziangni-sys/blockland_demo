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
import { B } from '../blocks/defs';
import { LIQUID, LIQUID_LAVA, LIQUID_WATER, OPAQUE, SOLID } from '../blocks/registry';
import { LIQUID_FULL_HEIGHT } from '../mesh/mesher';
import type {
  CameraState,
  EntityRenderState,
  EnvironmentState,
  OverlayCell,
  OverlayFace,
  OverlayState,
} from '../render/backend';
import type { PlayerControl } from '../sim/players';
import type { Simulation } from '../sim/simulation';
import type { InteractionView } from '../sim/view';
import { FallingBlockEntity, ItemEntity, Player, TntEntity, type Entity } from '../entities/entity';
import { isDryCell } from '../structures/hull';
import type { GlueStore } from '../structures/glue';
import type { VoxelGrid } from '../voxel/grid';
import { raycastGrids, type CellPredicate } from '../voxel/raycast';
import type { World } from '../voxel/world';
import {
  cameraGridFrame,
  cameraPose,
  cameraRig,
  placeCamera,
  resetCameraRig,
  SELF_HIDE_CLEARANCE,
  selfModelGap,
  sweepGrids,
  sweepScratch,
  type CameraGridFrame,
  type CameraQueries,
  type ViewMode,
} from './camera';
import { approach, interpolateCarried, lerpAngle, lerpVec, type FramePose } from './interp';

/** Radius (blocks) around the player in which COVERED glued faces are drawn while glue is in a hand. */
export const GLUE_VIEW_RADIUS = 8;
/** Radius (blocks) around the player in which EXPOSED glued faces are always drawn. */
export const GLUE_EXPOSED_RADIUS = 24;
/**
 * Glue faces are re-collected at most this often unless a glue store changed or a hand started
 * or stopped holding glue. Also the longest a face that became covered / exposed (a block put
 * on it or taken off) waits before it is drawn the other way, and the longest a decal keeps
 * the old light after the light at its face changed (a torch placed or removed).
 */
export const GLUE_REFRESH_MS = 250;
/** Raw light byte (sky << 4 | block) of open sky: the light structure glue is collected with. */
const FULL_SKY = 0xf0;
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

/**
 * Cells the third-person camera may not enter: every hard or opaque block (liquids, plants,
 * torches and the invisible unloaded sentinel do not stop it).
 */
export const blocksCamera: CellPredicate = (cell) => {
  const id = cell & ID_MASK;
  if (id === B.UNLOADED || LIQUID[id] !== 0) return false;
  return SOLID[id] === 1 || OPAQUE[id] === 1;
};

function newEntityState(): EntityRenderState {
  return { id: 0, kind: 'item', x: 0, y: 0, z: 0, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 };
}

export class ViewBuilder {
  readonly camera: CameraState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fov: 75 };
  readonly env: EnvironmentState = { dayTime: 0, submerged: 'none', viewDistance: 128, time: 0 };
  readonly overlay: OverlayState = { target: null, breakProgress: 0, preview: [], conflicts: [], glue: [] };

  private readonly entityPool: EntityRenderState[] = [];
  private readonly entityList: EntityRenderState[] = [];
  private fovScale = 1;
  /** Third person with the camera clear of the player's model: the local player is drawn. */
  private showSelf = false;
  /** Body yaw of the local player this frame (the interpolated look yaw). */
  private selfYaw = 0;
  private readonly pose = cameraPose();
  private readonly eye: Vec3 = vec3();
  /** Easing state and scratch of the 'back' placement; reset when the view mode changes. */
  private readonly rig = cameraRig();
  private lastMode: ViewMode | null = null;
  /**
   * Grids the camera queries of the current updateCamera call test (null outside the call),
   * for the ray of 'front' (current poses).
   */
  private rayGrids: VoxelGrid[] | null = null;
  /** The world and every structure as drawn this frame (render pose), for the sweep of 'back'. */
  private readonly sweepFrames: CameraGridFrame[] = [];
  private sweepCount = 0;
  private readonly sweepTmp = sweepScratch();
  private readonly cameraQueries: CameraQueries = {
    ray: (o, d, max) => {
      const h = this.rayGrids === null ? null : raycastGrids(this.rayGrids, o, d, max, blocksCamera);
      return h === null ? Infinity : h.dist;
    },
    sweep: (o, d, max, half, graded) => sweepGrids(this.sweepFrames, this.sweepCount, blocksCamera, o, d, max, half, graded, this.sweepTmp),
  };

  // overlay caches (rebuilt only when the simulation publishes a new object)
  private readonly targetCell: OverlayCell = { structureId: 0, x: 0, y: 0, z: 0 };
  /**
   * What the cached preview list was built from. Keyed on the parts, not the wrapper: the
   * simulation publishes a fresh `preview` object every tick around the same `cells` array.
   */
  private lastPreviewCells: Int32Array | null | undefined = undefined;
  private lastPreviewGrid = -1;
  private lastPreviewKind: string | null = null;
  private lastConflicts: InteractionView['conflicts'] | undefined = undefined;
  private glueAt = -Infinity;
  /**
   * What the glue list was last collected from: [hand holds glue (0/1), world glue version,
   * then (structure id, glue version) per structure]. Compared and rewritten in place each
   * frame, so no string or array is built when nothing changed.
   */
  private readonly glueKey: number[] = [];

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

  /**
   * The camera for the view mode: first person at the local player's eyes, or third person
   * over the shoulder ('back', kept CAMERA_CLEARANCE from every block of every grid as drawn
   * this frame, moving out again eased over `dt` seconds) or in front of the face ('front',
   * pulled in by a ray); see src/client/camera.ts. `yaw`/`pitch` come straight from the input
   * (blended with the carrier's turn). The eye position is interpolated exactly like the player
   * model's.
   */
  updateCamera(sim: Simulation, me: PlayerControl, alpha: number, yaw: number, pitch: number, fov: number, dt: number, mode: ViewMode = 'first'): CameraState {
    const p = me.player;
    const pos = this.renderPosition(sim, p, alpha, this.scratch2);
    const eye = this.eye;
    eye.x = pos.x;
    eye.y = pos.y + p.eyeHeight;
    eye.z = pos.z;
    if (mode !== this.lastMode) {
      resetCameraRig(this.rig);
      this.lastMode = mode;
    }
    this.rayGrids = mode === 'front' ? sim.grids() : null;
    this.sweepCount = mode === 'back' ? this.collectSweepFrames(sim, alpha) : 0;
    const pose = placeCamera(mode, eye, yaw, pitch, this.cameraQueries, this.rig, dt, this.pose);
    this.rayGrids = null;
    this.sweepCount = 0;
    this.showSelf = mode !== 'first' && !p.dead && selfModelGap(pose.x, pose.y, pose.z, eye, yaw, p.eyeHeight) >= SELF_HIDE_CLEARANCE;
    this.selfYaw = yaw;
    const cam = this.camera;
    cam.x = pose.x;
    cam.y = pose.y;
    cam.z = pose.z;
    cam.yaw = pose.yaw;
    cam.pitch = pose.pitch;
    const moving = Math.hypot(p.vel.x - p.carrierVel.x, p.vel.z - p.carrierVel.z) > 1;
    this.fovScale = approach(this.fovScale, p.sprinting && moving ? SPRINT_FOV_SCALE : 1, 10, dt);
    cam.fov = Math.min(150, fov * this.fovScale);
    return cam;
  }

  /**
   * Fills sweepFrames with the world (identity) and every structure at the pose it is drawn
   * with at `alpha` (the same renderPose the structure renderer uses), so the camera keeps its
   * clearance from what is on the screen. Returns the number of frames.
   */
  private collectSweepFrames(sim: Simulation, alpha: number): number {
    const frames = this.sweepFrames;
    const structures = sim.structures.all();
    while (frames.length < structures.length + 1) frames.push(cameraGridFrame());
    const w = frames[0]!;
    w.grid = sim.world;
    let n = 1;
    for (let i = 0; i < structures.length; i++) {
      const s = structures[i]!;
      if (s.removed) continue;
      const f = frames[n++]!;
      f.grid = s.grid;
      s.grid.renderPose(alpha, f.position, f.rotation);
      f.pivot.x = s.grid.pivot.x;
      f.pivot.y = s.grid.pivot.y;
      f.pivot.z = s.grid.pivot.z;
    }
    // Let go of grids that are gone.
    for (let i = n; i < frames.length; i++) frames[i]!.grid = null;
    return n;
  }

  updateEnvironment(sim: Simulation, alpha: number, timeSec: number, renderDistance: number): EnvironmentState {
    const env = this.env;
    // THE time of day is the simulation's (world.time + dayOffset, see Simulation.dayTime):
    // world.time alone is wrong once setDayTime() was used or a save restored an offset.
    // sim.dayTime is the current tick's; alpha interpolates from the previous one.
    const d = sim.dayTime + (alpha - 1) / DAY_TICKS;
    env.dayTime = d - Math.floor(d);
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

  /**
   * Every entity, interpolated and lit. The local player is left out in first person (and when
   * the third-person camera is too close to the model, see selfModelGap); in third person it
   * is drawn at the same interpolated position as the camera's eye, facing the look yaw of
   * updateCamera — so call updateCamera first in a frame.
   */
  updateEntities(sim: Simulation, me: PlayerControl, alpha: number): readonly EntityRenderState[] {
    const list = this.entityList;
    list.length = 0;
    const player = me.player;
    const all = sim.entities.all();
    const world = sim.world;
    for (let i = 0; i < all.length; i++) {
      const e = all[i]!;
      if (e.removed || (e === player && !this.showSelf)) continue;
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
      s.yaw = e === player ? this.selfYaw : lerpAngle(e.prevYaw, e.yaw, alpha);
      s.payload = e instanceof ItemEntity ? e.stack.item : e instanceof FallingBlockEntity ? e.cell : 0;
      s.flash = e instanceof TntEntity ? (Math.floor(e.fuse / 4) % 2 === 0 ? 0.8 : 0) : e instanceof Player && e.hurtTicks > 0 ? 0.6 : 0;
      sampleLight(world, pos.x, pos.y + Math.min(0.5, e.height * 0.5), pos.z, this.light);
      s.sky = this.light.sky;
      s.block = this.light.block;
      list.push(s);
    }
    return list;
  }

  /** Overlays from the interaction view plus the glued faces around the player. */
  updateOverlays(sim: Simulation, me: PlayerControl, nowMs: number): OverlayState {
    const o = this.overlay;
    const v = me.view;
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
    const pv = v.preview;
    const pvCells = pv ? pv.cells : null;
    const pvGrid = pv ? pv.gridId : -1;
    const pvKind = pv ? pv.kind : null;
    if (pvCells !== this.lastPreviewCells || pvGrid !== this.lastPreviewGrid || pvKind !== this.lastPreviewKind) {
      this.lastPreviewCells = pvCells;
      this.lastPreviewGrid = pvGrid;
      this.lastPreviewKind = pvKind;
      const cells: OverlayCell[] = [];
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
    this.updateGlue(sim, me, nowMs);
    return o;
  }

  /**
   * Glued faces near the player (DESIGN 强力胶: glue on a face is visible): every EXPOSED face
   * (a side that is not a hard block) within GLUE_EXPOSED_RADIUS, whatever the player holds;
   * COVERED faces (hard blocks on both sides) within GLUE_VIEW_RADIUS while glue is in the main
   * hand or the off-hand. Re-collected when a glue store changes or a hand starts / stops
   * holding glue, and at least every GLUE_REFRESH_MS (blocks placed on or taken off a glued face
   * switch it between covered and exposed; the light at a decal changes). An unchanged result
   * keeps the previous array.
   */
  private updateGlue(sim: Simulation, me: PlayerControl, nowMs: number): void {
    const o = this.overlay;
    const p = me.player;
    if (p.dead) {
      if (o.glue.length > 0) o.glue = [];
      this.glueKey.length = 0;
      return;
    }
    const inv = p.inventory;
    const main = inv.selectedStack();
    const off = inv.offhand;
    const inHand = (main !== null && main.item === I.GLUE) || (off !== null && off.item === I.GLUE);
    const structures = sim.structures.all();
    const changed = this.updateGlueKey(inHand ? 1 : 0, sim.worldGlue.version, structures);
    if (!changed && nowMs - this.glueAt < GLUE_REFRESH_MS) return;
    this.glueAt = nowMs;
    const faces: OverlayFace[] = [];
    const eye = p.eyePos(this.scratch2);
    collectGlueFaces(sim.world, sim.worldGlue, 0, eye, inHand, sim.world, faces);
    for (let i = 0; i < structures.length; i++) {
      const s = structures[i]!;
      if (s.removed || s.glue.size === 0) continue;
      collectGlueFaces(s.grid, s.glue, s.id, s.grid.toLocal(eye, this.scratch), inHand, null, faces);
    }
    if (!sameFaces(o.glue, faces)) o.glue = faces;
  }

  /** Writes the glue key (see glueKey) in place; true when it differs from the previous one. */
  private updateGlueKey(hand: number, worldVersion: number, structures: readonly { id: number; glue: GlueStore }[]): boolean {
    const k = this.glueKey;
    const len = 2 + 2 * structures.length;
    let changed = k.length !== len;
    if (k[0] !== hand || k[1] !== worldVersion) changed = true;
    k[0] = hand;
    k[1] = worldVersion;
    for (let i = 0, j = 2; i < structures.length; i++, j += 2) {
      const s = structures[i]!;
      const v = s.glue.version;
      if (k[j] !== s.id || k[j + 1] !== v) changed = true;
      k[j] = s.id;
      k[j + 1] = v;
    }
    k.length = len;
    return changed;
  }
}

/**
 * Append the glued faces of one grid around `at` (a point in that grid's local space) to `out`:
 * exposed ones within GLUE_EXPOSED_RADIUS, covered ones within GLUE_VIEW_RADIUS when `covered`
 * glue is to be shown. An exposed face is given as its hard cell plus the direction of the open
 * side (the decal lies on that side) and the light of the open cell, read from `light` (the
 * world, for world glue) or full sky light when null (a structure: its pose light is applied by
 * the renderer); a covered one as its canonical cell plus the positive face.
 */
export function collectGlueFaces(
  grid: VoxelGrid,
  glue: GlueStore,
  structureId: number,
  at: Vec3,
  showCovered: boolean,
  light: World | null,
  out: OverlayFace[],
): void {
  if (glue.size === 0) return;
  const R = GLUE_EXPOSED_RADIUS;
  const r = GLUE_VIEW_RADIUS;
  const cx = Math.floor(at.x);
  const cy = Math.floor(at.y);
  const cz = Math.floor(at.z);
  glue.forEachInBox(cx - R, cy - R, cz - R, cx + R, cy + R, cz + R, (x, y, z, axis) => {
    const bx = axis === 0 ? x + 1 : x;
    const by = axis === 1 ? y + 1 : y;
    const bz = axis === 2 ? z + 1 : z;
    const hardA = SOLID[grid.getCell(x, y, z) & ID_MASK] === 1;
    const hardB = SOLID[grid.getCell(bx, by, bz) & ID_MASK] === 1;
    if (hardA && hardB) {
      if (!showCovered || Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) > r) return;
      out.push({ structureId, x, y, z, face: axis * 2, covered: true, sky: 0, block: 0 });
    } else if (hardB) {
      // The decal lies on B's negative face, in the open cell A.
      const l = light === null ? FULL_SKY : light.getLightRaw(x, y, z);
      out.push({ structureId, x: bx, y: by, z: bz, face: axis * 2 + 1, covered: false, sky: l >> 4, block: l & 15 });
    } else {
      // The decal lies on A's positive face, in the open cell B.
      const l = light === null ? FULL_SKY : light.getLightRaw(bx, by, bz);
      out.push({ structureId, x, y, z, face: axis * 2, covered: false, sky: l >> 4, block: l & 15 });
    }
  });
}

function sameFaces(a: readonly OverlayFace[], b: readonly OverlayFace[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.structureId !== q.structureId || p.x !== q.x || p.y !== q.y || p.z !== q.z || p.face !== q.face || p.covered !== q.covered) return false;
    if (p.sky !== q.sky || p.block !== q.block) return false;
  }
  return true;
}
