/**
 * Per-frame render state built from the client's replica (docs/NETCODE.md section 15, package 9):
 * camera, environment, entities and overlays, written into objects owned by this class (no
 * per-frame garbage beyond a few small arrays when lists change).
 *
 * Everything is shown as the replica holds it for this frame: the structures at the display pose
 * the NetClient frame and the prediction left on their grids (ships at renderTick, rotors at
 * rotorTick), the other entities interpolated at renderTick in their carrier's frame
 * (ClientReplica.entities), and the player this client plays where the prediction shows it
 * (ShownPlayer: OwnPlayer.displayPos, the held look turned with its carrier). The own entity is not
 * in the replica's entity stream (section 8): in the third-person views it is drawn from ShownPlayer.
 *
 * OTHER PLAYERS (package 12) are drawn as people from what the replica holds of them: the body at the
 * interpolated position, facing its look (at a helm: toward the wheel, the head free to look around), the
 * head tilted by the pitch, the posture from the flags (sneaking, sprinting, flying) and the helm,
 * the main-hand item, and the name from the player table as a tag. A dead player is not drawn (nor
 * its tag); the own player never gets a tag. Every entity's own motion (EntityRenderState vx, vy, vz,
 * which drives the walk) is measured here from its interpolated position in the frame of its carrier
 * (as the display pose places it), over the display time: the replica's renderTick for the others,
 * the rotorTick the own prediction runs on for the own player. So someone standing on a sailing,
 * turning ship stands still and someone walking its deck walks at their speed on it.
 */
import { DAY_TICKS, TPS } from '../core/constants';
import { quat, vec3, type Vec3 } from '../core/math';
import { ID_MASK, liquidAmount, STATE_MASK, STATE_SHIFT } from '../blocks/cell';
import { I } from '../blocks/items';
import { B } from '../blocks/defs';
import { LIQUID, LIQUID_LAVA, LIQUID_WATER, OPAQUE, SOLID } from '../blocks/registry';
import { FALLING_HEIGHT, ITEM_HEIGHT, PLAYER_EYE_HEIGHT, PLAYER_HEIGHT, RABBIT_HEIGHT, TNT_HEIGHT } from '../entities/constants';
import type { Inventory } from '../entities/inventory';
import { headingOf } from '../entities/structs';
import { LIQUID_FULL_HEIGHT } from '../mesh/mesher';
import type { EntityKind, PlayerFlags, Target } from '../net/protocol';
import type { ReplicaView } from '../net/client/apply';
import type { ClientReplica } from '../net/client/replica';
import type {
  CameraState,
  EntityRenderState,
  EnvironmentState,
  OverlayCell,
  OverlayFace,
  OverlayState,
  PlayerPosture,
} from '../render/backend';
import { isDryHalf } from '../structures/hull';
import type { GlueStore } from '../structures/glue';
import { Ship } from '../structures/structure';
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
import { approach } from './interp';

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
/** Height of each entity kind's body (its light is sampled half way up, at most 0.5 above the feet). */
const KIND_HEIGHT: Readonly<Record<EntityKind, number>> = Object.freeze({
  player: PLAYER_HEIGHT,
  item: ITEM_HEIGHT,
  falling: FALLING_HEIGHT,
  tnt: TNT_HEIGHT,
  rabbit: RABBIT_HEIGHT,
});

/**
 * The player this client plays, as shown this frame (session.ts fills it from the prediction, or
 * from the server's correction while the world is still loading).
 */
export interface ShownPlayer {
  /** Its entity id (Welcome). */
  id: number;
  /** Feet, world, as shown. */
  readonly feet: Vec3;
  eyeHeight: number;
  /** The look as shown (radians): the held look, turned with the carrier at the frame's pose. */
  yaw: number;
  pitch: number;
  sprinting: boolean;
  /** Moving faster than 1 block/s relative to its carrier (the sprint widening needs it). */
  moving: boolean;
  dead: boolean;
  /** Hurt a moment ago (its model flashes). */
  hurt: boolean;
  /** The inventory as shown (predicted); null before the server sent one. */
  inventory: Inventory | null;
  /** The structure the predicted body stands on (0 = none): its own motion is measured on it. */
  carrierId: number;
  sneaking: boolean;
  flying: boolean;
  /** The ship whose wheel it holds (0 = none). */
  steeringShipId: number;
}

/** What the camera reads of the replica: the world and the structures at their display pose. */
export type CameraScene = Pick<ClientReplica, 'world' | 'structures'>;
/**
 * What the entity list reads of the replica: the entities at a renderTick, the world's light and
 * liquids, and the structures at their display pose (the carriers own motion is measured in, the
 * helms players face, the dry hulls that keep water off a head).
 */
export type EntityScene = Pick<ClientReplica, 'world' | 'entities' | 'state' | 'structures'>;

export function shownPlayer(): ShownPlayer {
  return { id: 0, feet: vec3(), eyeHeight: 1.62, yaw: 0, pitch: 0, sprinting: false, moving: false, dead: false, hurt: false, inventory: null, carrierId: 0, sneaking: false, flying: false, steeringShipId: 0 };
}

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
  return { id: 0, kind: 'item', x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, payload: 0, flash: 0, sky: 15, block: 0, headYaw: 0, headPitch: 0, held: 0, posture: 'stand', label: null };
}

/** Heading (yaw, radians) a body faces when it looks along a horizontal Dir: the camera convention, forward = (-sin yaw, 0, -cos yaw). */
const DIR_YAW: readonly number[] = [-Math.PI / 2, Math.PI / 2, 0, 0, Math.PI, 0];

/** The posture a player model shows for its flags and helm. */
export function postureOf(flags: PlayerFlags | null, steering: boolean): PlayerPosture {
  if (steering) return 'helm';
  if (flags === null) return 'stand';
  if (flags.flying) return 'fly';
  if (flags.sneaking) return 'sneak';
  if (flags.sprinting) return 'sprint';
  return 'stand';
}

/**
 * Where one entity was last frame, in the frame of its carrier: what its own motion is measured
 * against (ViewBuilder.trackMotion). Pooled by entity id; dropped when the entity is gone.
 */
interface MotionTrack {
  carrierId: number;
  /** Position last frame: local to the carrier (world when carrierId is 0). */
  x: number;
  y: number;
  z: number;
  /** Display time (ticks) of that position. */
  tick: number;
  /** The own velocity measured last (blocks / s, world axes). */
  vx: number;
  vy: number;
  vz: number;
  stamp: number;
}

/** True when the main hand or the off-hand of `inv` holds glue. */
function glueInHand(inv: Inventory | null): boolean {
  if (inv === null) return false;
  const main = inv.selectedStack();
  const off = inv.offhand;
  return (main !== null && main.item === I.GLUE) || (off !== null && off.item === I.GLUE);
}

export class ViewBuilder {
  readonly camera: CameraState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fov: 75 };
  readonly env: EnvironmentState = { dayTime: 0, submerged: 'none', viewDistance: 128, time: 0 };
  readonly overlay: OverlayState = { target: null, breakProgress: 0, preview: [], conflicts: [], glue: [] };

  private readonly entityPool: EntityRenderState[] = [];
  private readonly entityList: EntityRenderState[] = [];
  private readonly tracks = new Map<number, MotionTrack>();
  private readonly freeTracks: MotionTrack[] = [];
  private trackStamp = 0;
  private readonly sweepTrack = (t: MotionTrack, id: number): void => {
    if (t.stamp === this.trackStamp) return;
    this.tracks.delete(id);
    this.freeTracks.push(t);
  };
  private fovScale = 1;
  /** Third person with the camera clear of the player's model: the local player is drawn. */
  private showSelf = false;
  private readonly pose = cameraPose();
  private readonly eye: Vec3 = vec3();
  /** Easing state and scratch of the 'back' placement; reset when the view mode changes. */
  private readonly rig = cameraRig();
  private lastMode: ViewMode | null = null;
  /**
   * Grids the camera queries of the current updateCamera call test (null outside the call),
   * for the ray of 'front' (display poses).
   */
  private rayGrids: VoxelGrid[] | null = null;
  /** The world and every structure as drawn this frame (display pose), for the sweep of 'back'. */
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

  // overlay caches (rebuilt only when the replica holds a new object)
  private readonly targetCell: OverlayCell = { structureId: 0, x: 0, y: 0, z: 0 };
  /** What the cached preview list was built from (the replica replaces the preview object when it changes). */
  private lastPreview: ReplicaView['preview'] | undefined = undefined;
  private lastConflicts: ReplicaView['conflicts'] | undefined = undefined;
  private glueAt = -Infinity;
  /**
   * What the glue list was last collected from: [hand holds glue (0/1), world glue version,
   * then (structure id, glue version) per structure]. Compared and rewritten in place each
   * frame, so no string or array is built when nothing changed.
   */
  private readonly glueKey: number[] = [];

  // scratch
  private readonly scratch: Vec3 = vec3();
  private readonly scratch2: Vec3 = vec3();
  private readonly rot = quat();
  private readonly light = { sky: 15, block: 0 };

  /**
   * The camera for the view mode: first person at the player's eyes, or third person over the
   * shoulder ('back', kept CAMERA_CLEARANCE from every block of every grid as drawn this frame,
   * moving out again eased over `dt` seconds) or in front of the face ('front', pulled in by a
   * ray); see src/client/camera.ts. The look is the shown player's.
   */
  updateCamera(replica: CameraScene, me: ShownPlayer, fov: number, dt: number, mode: ViewMode = 'first'): CameraState {
    const eye = this.eye;
    eye.x = me.feet.x;
    eye.y = me.feet.y + me.eyeHeight;
    eye.z = me.feet.z;
    if (mode !== this.lastMode) {
      resetCameraRig(this.rig);
      this.lastMode = mode;
    }
    this.rayGrids = mode === 'front' ? replicaGrids(replica) : null;
    this.sweepCount = mode === 'back' ? this.collectSweepFrames(replica) : 0;
    const pose = placeCamera(mode, eye, me.yaw, me.pitch, this.cameraQueries, this.rig, dt, this.pose);
    this.rayGrids = null;
    this.sweepCount = 0;
    this.showSelf = mode !== 'first' && !me.dead && selfModelGap(pose.x, pose.y, pose.z, eye, me.yaw, me.eyeHeight) >= SELF_HIDE_CLEARANCE;
    const cam = this.camera;
    cam.x = pose.x;
    cam.y = pose.y;
    cam.z = pose.z;
    cam.yaw = pose.yaw;
    cam.pitch = pose.pitch;
    this.fovScale = approach(this.fovScale, me.sprinting && me.moving ? SPRINT_FOV_SCALE : 1, 10, dt);
    cam.fov = Math.min(150, fov * this.fovScale);
    return cam;
  }

  /** The eyes of the last updateCamera (world). */
  get eyePos(): Readonly<Vec3> {
    return this.eye;
  }

  /**
   * Fills sweepFrames with the world (identity) and every structure at the pose it is drawn
   * with (the display pose on its grid), so the camera keeps its clearance from what is on the
   * screen. Returns the number of frames.
   */
  private collectSweepFrames(replica: CameraScene): number {
    const frames = this.sweepFrames;
    const structures = replica.structures();
    while (frames.length < structures.length + 1) frames.push(cameraGridFrame());
    const w = frames[0]!;
    w.grid = replica.world;
    let n = 1;
    for (let i = 0; i < structures.length; i++) {
      const s = structures[i]!;
      const f = frames[n++]!;
      f.grid = s.grid;
      s.grid.renderPose(1, f.position, f.rotation);
      f.pivot.x = s.grid.pivot.x;
      f.pivot.y = s.grid.pivot.y;
      f.pivot.z = s.grid.pivot.z;
    }
    // Let go of grids that are gone.
    for (let i = n; i < frames.length; i++) frames[i]!.grid = null;
    return n;
  }

  /**
   * The time of day is the replica's (the server's world time and day offset at the renderTick
   * of the frame, section 4: never the client's own clock); the medium at the camera, except in
   * the dry cells of a ship's hull.
   */
  updateEnvironment(replica: ClientReplica, timeSec: number, renderDistance: number): EnvironmentState {
    const env = this.env;
    env.dayTime = replica.dayTime;
    env.viewDistance = renderDistance * 16;
    env.time = timeSec;
    const c = this.camera;
    let medium = mediumAt(replica.world, c.x, c.y, c.z);
    if (medium !== 'none' && this.inDryHull(replica, c)) medium = 'none';
    env.submerged = medium;
    return env;
  }

  /** True when the point is in a dry cell of some ship's hull (water there is cut away). */
  private inDryHull(replica: Pick<ClientReplica, 'structures'>, p: Vec3): boolean {
    const structures = replica.structures();
    for (let i = 0; i < structures.length; i++) {
      const s = structures[i]!;
      if (!(s instanceof Ship) || !s.hull) continue;
      const l = s.grid.toLocal(p, this.scratch);
      if (isDryHalf(s.hull, Math.floor(l.x * 2), Math.floor(l.y * 2), Math.floor(l.z * 2))) return true;
    }
    return false;
  }

  /**
   * Every entity of the replica at `renderTick`, lit, with its own motion; the other players as
   * people (posture, head, held item, name tag; the dead ones left out); plus the player this client
   * plays in the third-person views (not when the camera is too close to the model, see
   * selfModelGap), at the eyes of updateCamera facing the shown look, its motion measured over
   * `ownTick` (the rotorTick its prediction runs on) — so call updateCamera first in a frame, and
   * updateEnvironment (the medium the camera is in, which decides whether a diver's name shows).
   */
  updateEntities(replica: EntityScene, me: ShownPlayer, renderTick: number, ownTick: number): readonly EntityRenderState[] {
    const list = this.entityList;
    list.length = 0;
    this.trackStamp++;
    const world = replica.world;
    const views = replica.entities(renderTick);
    for (let i = 0; i < views.length; i++) {
      const e = views[i]!;
      const held = e.player;
      const flags = e.look?.flags ?? held?.flags ?? null;
      if (e.kind === 'player' && (held?.flags.dead === true || flags?.dead === true)) continue;
      const s = this.nextState();
      s.id = e.id;
      s.kind = e.kind;
      s.x = e.pos.x;
      s.y = e.pos.y;
      s.z = e.pos.z;
      s.yaw = e.yaw;
      s.payload = e.kind === 'item' ? e.item : e.kind === 'falling' ? e.cell : 0;
      s.flash = e.kind === 'tnt' ? (Math.floor(e.fuse / 4) % 2 === 0 ? 0.8 : 0) : 0;
      this.trackMotion(replica, e.id, e.carrierId, e.pos, renderTick, s);
      if (e.kind === 'player') {
        const steering = held !== null && held.steeringShipId !== 0 ? held.steeringShipId : 0;
        s.headYaw = e.yaw;
        s.headPitch = e.pitch;
        s.yaw = steering !== 0 ? this.helmYaw(replica, steering, e.pos, e.yaw) : e.yaw;
        s.held = held?.heldItem ?? 0;
        s.posture = postureOf(flags, steering !== 0);
        s.label = this.nameHiddenByLiquid(replica, e.pos) ? null : e.name;
      } else {
        s.headYaw = e.yaw;
        s.headPitch = 0;
        s.held = 0;
        s.posture = 'stand';
        s.label = null;
      }
      this.lightAt(world, s, KIND_HEIGHT[e.kind]);
      list.push(s);
    }
    if (this.showSelf) {
      const s = this.nextState();
      s.id = me.id;
      s.kind = 'player';
      s.x = me.feet.x;
      s.y = me.feet.y;
      s.z = me.feet.z;
      s.headYaw = me.yaw;
      s.headPitch = me.pitch;
      s.yaw = me.steeringShipId !== 0 ? this.helmYaw(replica, me.steeringShipId, me.feet, me.yaw) : me.yaw;
      s.payload = 0;
      s.flash = me.hurt ? 0.6 : 0;
      s.held = me.inventory?.selectedStack()?.item ?? 0;
      s.posture = me.steeringShipId !== 0 ? 'helm' : me.flying ? 'fly' : me.sneaking ? 'sneak' : me.sprinting ? 'sprint' : 'stand';
      s.label = null;
      this.trackMotion(replica, me.id, me.carrierId, me.feet, ownTick, s);
      this.lightAt(world, s, PLAYER_HEIGHT);
      list.push(s);
    }
    this.tracks.forEach(this.sweepTrack);
    return list;
  }

  /**
   * Own motion of entity `id` at world `pos` on `carrierId` at display time `tick`, written into
   * s.vx/vy/vz: the displacement since its last frame relative to the carrier (the point of the
   * carrier where it stood then, at the carrier's display pose now), over the display time that
   * passed. A new entity, a change of carrier or a carrier the replica lacks keeps the last measure
   * (zero at first); a frame whose display time did not advance (paused, stalled) has none.
   */
  private trackMotion(replica: EntityScene, id: number, carrierId: number, pos: Vec3, tick: number, s: EntityRenderState): void {
    let t = this.tracks.get(id);
    const fresh = t === undefined;
    if (t === undefined) {
      t = this.freeTracks.pop() ?? { carrierId: 0, x: 0, y: 0, z: 0, tick: 0, vx: 0, vy: 0, vz: 0, stamp: 0 };
      t.vx = t.vy = t.vz = 0;
      this.tracks.set(id, t);
    }
    t.stamp = this.trackStamp;
    const grid = carrierId === 0 ? null : (replica.state.structures.get(carrierId)?.structure.grid ?? null);
    const local = this.scratch;
    if (grid === null) {
      local.x = pos.x;
      local.y = pos.y;
      local.z = pos.z;
    } else {
      grid.toLocal(pos, local);
    }
    const dt = tick - t.tick;
    if (!fresh && t.carrierId === carrierId && (carrierId === 0 || grid !== null) && Number.isFinite(dt)) {
      if (dt > 1e-6) {
        const then = this.scratch2;
        then.x = t.x;
        then.y = t.y;
        then.z = t.z;
        if (grid !== null) grid.toWorld(then, then);
        const k = TPS / dt;
        t.vx = (pos.x - then.x) * k;
        t.vy = (pos.y - then.y) * k;
        t.vz = (pos.z - then.z) * k;
      } else {
        t.vx = t.vy = t.vz = 0;
      }
    }
    t.carrierId = carrierId;
    t.x = local.x;
    t.y = local.y;
    t.z = local.z;
    t.tick = tick;
    s.vx = t.vx;
    s.vy = t.vy;
    s.vz = t.vz;
  }

  /**
   * True when the eyes of a player standing at `feet` are in a liquid the camera is not in (this
   * frame's updateEnvironment): seen from above the surface, a diver's name is hidden with its body,
   * as a wall hides it. Seen from within the same liquid it fades with the medium's fog (labels.ts).
   */
  private nameHiddenByLiquid(replica: EntityScene, feet: Vec3): boolean {
    const y = feet.y + PLAYER_EYE_HEIGHT;
    const medium = mediumAt(replica.world, feet.x, y, feet.z);
    if (medium === 'none' || medium === this.env.submerged) return false;
    const eye = this.scratch2;
    eye.x = feet.x;
    eye.y = y;
    eye.z = feet.z;
    return !this.inDryHull(replica, eye);
  }

  /**
   * The world heading a player at (feet) `pos` at the wheel of ship `shipId` faces: toward the wheel
   * (the helm cell's centre at the ship's display pose; the seat is normally right behind it, but a
   * blocked seat leaves the helmsman where it stood), or along the ship's forward when standing on
   * the wheel's spot; `look` without that ship.
   */
  private helmYaw(replica: EntityScene, shipId: number, pos: Vec3, look: number): number {
    const ship = replica.state.structures.get(shipId)?.structure;
    if (!(ship instanceof Ship)) return look;
    const c = this.scratch2;
    c.x = ship.helmX + 0.5;
    c.y = ship.helmY + 0.5;
    c.z = ship.helmZ + 0.5;
    ship.grid.toWorld(c, c);
    const dx = c.x - pos.x;
    const dz = c.z - pos.z;
    if (dx * dx + dz * dz > 0.09) return Math.atan2(-dx, -dz);
    return headingOf(ship.grid.worldRotation(this.rot)) + DIR_YAW[ship.forward]!;
  }

  private nextState(): EntityRenderState {
    let s = this.entityPool[this.entityList.length];
    if (!s) {
      s = newEntityState();
      this.entityPool.push(s);
    }
    return s;
  }

  private lightAt(world: World, s: EntityRenderState, height: number): void {
    sampleLight(world, s.x, s.y + Math.min(0.5, height * 0.5), s.z, this.light);
    s.sky = this.light.sky;
    s.block = this.light.block;
  }

  /**
   * Overlays: the outline of `target` (the client's own use target, section 10: drawn at once),
   * the mining cracks the server reports (only on the target itself), the assembly preview and
   * the docking conflicts of the private view, and the glued faces around the player.
   */
  updateOverlays(replica: ClientReplica, me: ShownPlayer, target: Target | null, nowMs: number): OverlayState {
    const o = this.overlay;
    if (target !== null) {
      const t = this.targetCell;
      t.structureId = target.gridId;
      t.x = target.x;
      t.y = target.y;
      t.z = target.z;
      o.target = t;
    } else {
      o.target = null;
    }
    const v = replica.ownState.view;
    const m = v.mining;
    o.breakProgress =
      target !== null && m !== null && m.gridId === target.gridId && m.x === target.x && m.y === target.y && m.z === target.z ? Math.max(0, Math.min(1, m.progress)) : 0;
    if (v.preview !== this.lastPreview) {
      const pv = v.preview;
      this.lastPreview = pv;
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
    this.updateGlue(replica, me, nowMs);
    return o;
  }

  /**
   * Glued faces near the player (DESIGN 强力胶: glue on a face is visible): every EXPOSED face
   * (a side that is not a hard block) within GLUE_EXPOSED_RADIUS, whatever the player holds;
   * COVERED faces (hard blocks on both sides) within GLUE_VIEW_RADIUS while glue is in the main
   * hand or the off-hand (as shown). Re-collected when a glue store changes or a hand starts /
   * stops holding glue, and at least every GLUE_REFRESH_MS (blocks placed on or taken off a glued
   * face switch it between covered and exposed; the light at a decal changes). An unchanged result
   * keeps the previous array.
   */
  private updateGlue(replica: ClientReplica, me: ShownPlayer, nowMs: number): void {
    const o = this.overlay;
    if (me.dead) {
      if (o.glue.length > 0) o.glue = [];
      this.glueKey.length = 0;
      return;
    }
    const inHand = glueInHand(me.inventory);
    const structures = replica.structures();
    const changed = this.updateGlueKey(inHand ? 1 : 0, replica.worldGlue.version, structures);
    if (!changed && nowMs - this.glueAt < GLUE_REFRESH_MS) return;
    this.glueAt = nowMs;
    const faces: OverlayFace[] = [];
    const eye = this.scratch2;
    eye.x = me.feet.x;
    eye.y = me.feet.y + me.eyeHeight;
    eye.z = me.feet.z;
    collectGlueFaces(replica.world, replica.worldGlue, 0, eye, inHand, replica.world, faces);
    for (let i = 0; i < structures.length; i++) {
      const s = structures[i]!;
      if (s.glue.size === 0) continue;
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

  /** The world heading of structure `id` as displayed this frame (its grid's composed rotation), or NaN. */
  displayHeading(replica: ClientReplica, id: number): number {
    const rs = replica.state.structures.get(id);
    if (rs === undefined) return Number.NaN;
    return headingOf(rs.structure.grid.worldRotation(this.rot));
  }
}

/** The world and every structure grid of the replica (display poses). */
export function replicaGrids(replica: CameraScene): VoxelGrid[] {
  const out: VoxelGrid[] = [replica.world];
  for (const s of replica.structures()) out.push(s.grid);
  return out;
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
