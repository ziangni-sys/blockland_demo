/**
 * Entity drawing. setEntities() hands over the full list every frame; views are pooled by
 * entity id (and per kind once released), so steady-state frames allocate nothing.
 *
 * Positions: (x, y, z) is the bottom centre of the entity (feet / resting point), yaw in the
 * game's convention (0 looks toward -Z, CCW from above) which equals Object3D.rotation.y.
 *
 * Animation (rabbit hop, player walk) is driven by the entity's OWN motion, which the client hands
 * over (EntityRenderState vx, vy, vz: relative to whatever carries it, measured in the carrier's
 * frame), smoothed here over frame time: someone standing on a sailing ship stands still, someone
 * walking its deck walks. EntityLayer.set() only records the states; animate() poses every view
 * once per rendered frame and sizes the name tags for the camera.
 *
 * Players: the box model of models.ts, built as a hierarchy that bends at the hips (sneaking,
 * sprinting, flying lean), turns and tilts the head (headYaw within HEAD_TURN_LIMIT of the body,
 * headPitch), swings arms and legs with the walk, holds the main-hand item in the right hand,
 * grips the wheel at a helm, and carries a name tag (labels.ts).
 */
import * as THREE from 'three/webgpu';
import type { EntityKind, EntityRenderState } from '../backend';
import { B } from '../../blocks/defs';
import { blastCrateVisual, cubeTilesForCell, itemVisual, type CubeVisual } from './blocktiles';
import { buildBox, buildQuad } from './boxgeom';
import { toBufferGeometry, type GeometryOptions } from './geometry';
import { VFLAG_EMISSIVE } from '../../mesh/types';
import type { VoxelMaterials } from './shading';
import { LABEL_GAP, LabelCache, labelView, NameTag, placeholderLabelMaterial, type LabelView } from './labels';
import { createModelGeometries, detailGeometry, RABBIT_EYE, RABBIT_NOSE, type ModelGeometries } from './models';

const ITEM_CUBE = 0.28;
const ITEM_ICON = 0.44;

/** Shared, lazily built geometries for entity visuals. */
export class EntityAssets {
  readonly models: ModelGeometries;
  readonly eye: THREE.BufferGeometry;
  readonly nose: THREE.BufferGeometry;
  private readonly itemGeo = new Map<number, { geo: THREE.BufferGeometry; mat: THREE.NodeMaterial } | null>();
  private readonly cellGeo = new Map<number, { geo: THREE.BufferGeometry; mat: THREE.NodeMaterial } | null>();
  private tntGeo: THREE.BufferGeometry | null = null;

  constructor(
    readonly materials: VoxelMaterials,
    readonly modelMaterial: THREE.NodeMaterial,
    private readonly geoOpts: GeometryOptions,
  ) {
    this.models = createModelGeometries();
    this.eye = detailGeometry(0.035, 0.05, 0.05, RABBIT_EYE);
    this.nose = detailGeometry(0.05, 0.035, 0.02, RABBIT_NOSE);
  }

  private materialFor(layer: CubeVisual['layer']): THREE.NodeMaterial {
    return layer === 'cutout' ? this.materials.cutout : layer === 'translucent' ? this.materials.translucent : this.materials.opaque;
  }

  private cube(v: CubeVisual, half: number, height: number, bottom: number): THREE.BufferGeometry {
    const g = buildBox({ x0: -half, y0: bottom, z0: -half, x1: half, y1: bottom + height, z1: half, tiles: v.tiles, flags: v.emissive ? VFLAG_EMISSIVE : 0 });
    const geo = toBufferGeometry(g, this.geoOpts);
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-half, bottom, -half), new THREE.Vector3(half, bottom + height, half));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, bottom + height / 2, 0), Math.sqrt(2 * half * half + 0.25 * height * height) + 0.01);
    return geo;
  }

  /** Visual of a dropped item stack (centred on the origin), or null to draw nothing. */
  item(itemId: number): { geo: THREE.BufferGeometry; mat: THREE.NodeMaterial } | null {
    let e = this.itemGeo.get(itemId);
    if (e !== undefined) return e;
    const v = itemVisual(itemId);
    if (v.kind === 'cube') {
      e = { geo: this.cube(v, ITEM_CUBE / 2, ITEM_CUBE, -ITEM_CUBE / 2), mat: this.materialFor(v.layer) };
    } else if (v.kind === 'icon') {
      const geo = toBufferGeometry(buildQuad(ITEM_ICON, v.tile, 0, true), this.geoOpts);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), ITEM_ICON);
      geo.boundingBox = new THREE.Box3(new THREE.Vector3(-ITEM_ICON, -ITEM_ICON, -0.01), new THREE.Vector3(ITEM_ICON, ITEM_ICON, 0.01));
      e = { geo, mat: this.materials.cutout };
    } else {
      e = null;
    }
    this.itemGeo.set(itemId, e);
    return e;
  }

  /** Full-size cube showing `cell`, bottom centre at the origin. */
  cell(cell: number): { geo: THREE.BufferGeometry; mat: THREE.NodeMaterial } | null {
    let e = this.cellGeo.get(cell);
    if (e !== undefined) return e;
    const v = cubeTilesForCell(cell);
    e = v ? { geo: this.cube(v, 0.5, 1, 0), mat: this.materialFor(v.layer) } : null;
    this.cellGeo.set(cell, e);
    return e;
  }

  tnt(): THREE.BufferGeometry {
    if (!this.tntGeo) this.tntGeo = this.cube(blastCrateVisual(), 0.5, 1, 0);
    return this.tntGeo;
  }

  dispose(): void {
    for (const e of this.itemGeo.values()) e?.geo.dispose();
    for (const e of this.cellGeo.values()) e?.geo.dispose();
    this.tntGeo?.dispose();
    this.models.dispose();
    this.eye.dispose();
    this.nose.dispose();
    this.itemGeo.clear();
    this.cellGeo.clear();
  }
}

function makeMesh(geo: THREE.BufferGeometry, mat: THREE.Material, light: THREE.Vector4): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.userData.bl = light;
  return m;
}

/** A blank state (the view's copy before its first frame). */
function blankState(): EntityRenderState {
  return { id: -1, kind: 'item', x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, payload: 0, flash: 0, sky: 15, block: 0, headYaw: 0, headPitch: 0, held: 0, posture: 'stand', label: null };
}

/** Per-frame inputs of every view's update(). */
interface FrameInfo {
  time: number;
  labels: LabelView;
}

/** Base of every pooled entity view. */
abstract class EntityView {
  readonly root = new THREE.Group();
  /** Per-object light uniform shared by every mesh of the view (x sky, y block, z flash). */
  readonly light = new THREE.Vector4(1, 0, 0, 0);
  /** The state of this frame (copied: the caller may reuse its objects after setEntities). */
  readonly cur: EntityRenderState = blankState();
  id = -1;
  stamp = 0;
  protected lastT = -1;
  /** Own velocity (blocks / s), smoothed over frame time. */
  protected vx = 0;
  protected vy = 0;
  protected vz = 0;

  abstract readonly kind: EntityKind;

  /** Called when the view is (re)assigned to an entity. */
  reset(s: EntityRenderState): void {
    this.id = s.id;
    this.capture(s);
    this.lastT = -1;
    const h = horizontalScale(s.vx, s.vz);
    this.vx = s.vx * h;
    this.vy = s.vy;
    this.vz = s.vz * h;
    this.root.visible = true;
  }

  capture(s: EntityRenderState): void {
    const c = this.cur;
    c.id = s.id;
    c.kind = s.kind;
    c.x = s.x;
    c.y = s.y;
    c.z = s.z;
    c.yaw = s.yaw;
    c.vx = s.vx;
    c.vy = s.vy;
    c.vz = s.vz;
    c.payload = s.payload;
    c.flash = s.flash;
    c.sky = s.sky;
    c.block = s.block;
    c.headYaw = s.headYaw;
    c.headPitch = s.headPitch;
    c.held = s.held;
    c.posture = s.posture;
    c.label = s.label;
  }

  /** The view goes back to the pool (its entity left): let go of what it holds. */
  release(): void {
    this.root.visible = false;
  }

  /**
   * Smooths the own velocity toward this frame's (its horizontal part no faster than
   * MAX_OWN_SPEED: a jump of the measured position is not a run); returns the frame dt. A frame
   * where time did not move forward (the first one, the world paused, a gap or a clock jump) has
   * dt 0 and changes nothing, so the pose stays as it was.
   */
  protected track(time: number): number {
    const s = this.cur;
    const dt = this.lastT >= 0 ? time - this.lastT : 0;
    this.lastT = time;
    if (dt <= 0 || dt > 0.25) return 0;
    const k = Math.min(1, dt * 12);
    const h = horizontalScale(s.vx, s.vz);
    this.vx += (s.vx * h - this.vx) * k;
    this.vy += (s.vy - this.vy) * k;
    this.vz += (s.vz * h - this.vz) * k;
    return dt;
  }

  protected setLight(s: EntityRenderState): void {
    this.light.set(clamp01(s.sky / 15), clamp01(s.block / 15), clamp01(s.flash), 0);
  }

  /** Poses the view from `cur` for this frame. */
  abstract update(f: FrameInfo): void;
}

/**
 * The fastest own horizontal motion anything shows (blocks / s): a player's flying sprint
 * (entities/constants FLY_SPEED x FLY_SPRINT_MULTIPLIER). Faster measures are scaled down to it.
 */
const MAX_OWN_SPEED = 18;

/** Factor (at most 1) that brings a horizontal velocity down to MAX_OWN_SPEED. */
function horizontalScale(vx: number, vz: number): number {
  const h2 = vx * vx + vz * vz;
  return h2 > MAX_OWN_SPEED * MAX_OWN_SPEED ? MAX_OWN_SPEED / Math.sqrt(h2) : 1;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

class ItemView extends EntityView {
  readonly kind = 'item' as const;
  private readonly mesh: THREE.Mesh;
  private shown = -1;

  constructor(private readonly assets: EntityAssets) {
    super();
    this.mesh = makeMesh(assets.tnt(), assets.materials.opaque, this.light);
    this.mesh.visible = false;
    this.root.add(this.mesh);
  }

  update(f: FrameInfo): void {
    const s = this.cur;
    const time = f.time;
    this.setLight(s);
    if (s.payload !== this.shown) {
      this.shown = s.payload;
      const v = this.assets.item(s.payload);
      this.mesh.visible = v !== null;
      if (v) {
        this.mesh.geometry = v.geo;
        this.mesh.material = v.mat;
      }
    }
    const phase = (s.id % 97) * 0.731;
    const bob = Math.sin(time * 2.2 + phase) * 0.05;
    this.root.position.set(s.x, s.y + 0.2 + bob, s.z);
    this.root.rotation.set(0, s.yaw + time * 1.1 + phase, 0);
  }
}

class CellView extends EntityView {
  readonly kind = 'falling' as const;
  private readonly mesh: THREE.Mesh;
  private shown = -1;

  constructor(private readonly assets: EntityAssets) {
    super();
    this.mesh = makeMesh(assets.tnt(), assets.materials.opaque, this.light);
    this.mesh.visible = false;
    this.root.add(this.mesh);
  }

  update(): void {
    const s = this.cur;
    this.setLight(s);
    if (s.payload !== this.shown) {
      this.shown = s.payload;
      const v = this.assets.cell(s.payload);
      this.mesh.visible = v !== null;
      if (v) {
        this.mesh.geometry = v.geo;
        this.mesh.material = v.mat;
      }
    }
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.set(0, 0, 0);
  }
}

class TntView extends EntityView {
  readonly kind = 'tnt' as const;
  private readonly mesh: THREE.Mesh;

  constructor(assets: EntityAssets, opaque: THREE.NodeMaterial) {
    super();
    this.mesh = makeMesh(assets.tnt(), opaque, this.light);
    this.root.add(this.mesh);
  }

  update(): void {
    const s = this.cur;
    this.setLight(s);
    // Swells a touch as it flashes, around its centre.
    const k = 1 + clamp01(s.flash) * 0.06;
    this.mesh.scale.set(k, k, k);
    this.mesh.position.set(0, 0.5 - 0.5 * k, 0);
    this.root.position.set(s.x, s.y, s.z);
  }
}

class RabbitView extends EntityView {
  readonly kind = 'rabbit' as const;
  private readonly hopper = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Group;
  private readonly earL: THREE.Mesh;
  private readonly earR: THREE.Mesh;
  private readonly hindL: THREE.Mesh;
  private readonly hindR: THREE.Mesh;
  private phase = 0;

  constructor(a: EntityAssets) {
    super();
    const g = a.models.rabbit;
    const mat = a.modelMaterial;
    const L = this.light;
    this.root.add(this.hopper);
    this.body = makeMesh(g.body, mat, L);
    this.body.position.set(0, 0.2, 0.03);
    this.hopper.add(this.body);
    this.head = new THREE.Group();
    this.head.position.set(0, 0.34, -0.2);
    this.hopper.add(this.head);
    this.head.add(makeMesh(g.head, mat, L));
    const eyeL = makeMesh(a.eye, mat, L);
    eyeL.position.set(-0.122, 0.03, -0.04);
    const eyeR = makeMesh(a.eye, mat, L);
    eyeR.position.set(0.122, 0.03, -0.04);
    const nose = makeMesh(a.nose, mat, L);
    nose.position.set(0, -0.02, -0.115);
    this.head.add(eyeL, eyeR, nose);
    this.earL = makeMesh(g.ear, mat, L);
    this.earL.position.set(-0.06, 0.1, 0.02);
    this.earR = makeMesh(g.ear, mat, L);
    this.earR.position.set(0.06, 0.1, 0.02);
    this.head.add(this.earL, this.earR);
    const tail = makeMesh(g.tail, mat, L);
    tail.position.set(0, 0.26, 0.27);
    this.hopper.add(tail);
    this.hindL = makeMesh(g.hindFoot, mat, L);
    this.hindL.position.set(-0.11, 0, 0.12);
    this.hindR = makeMesh(g.hindFoot, mat, L);
    this.hindR.position.set(0.11, 0, 0.12);
    const foreL = makeMesh(g.foreFoot, mat, L);
    foreL.position.set(-0.075, 0, -0.13);
    const foreR = makeMesh(g.foreFoot, mat, L);
    foreR.position.set(0.075, 0, -0.13);
    this.hopper.add(this.hindL, this.hindR, foreL, foreR);
  }

  update(f: FrameInfo): void {
    const s = this.cur;
    const time = f.time;
    const dt = this.track(time);
    this.setLight(s);
    const speed = Math.hypot(this.vx, this.vz);
    let lift = 0;
    let stretch: number;
    if (Math.abs(this.vy) > 0.35) {
      // The simulation makes the rabbit jump: pose from the vertical motion.
      stretch = Math.max(-0.14, Math.min(0.14, this.vy * 0.05));
      this.phase = 0;
    } else if (speed > 0.15) {
      // Moving along the ground without vertical motion: procedural bounding hop.
      this.phase += dt * (5 + speed * 2.5);
      const sn = Math.sin(this.phase);
      lift = Math.abs(sn) * Math.min(0.24, 0.1 + speed * 0.05);
      stretch = Math.cos(this.phase) * Math.sign(sn) * 0.1;
    } else {
      this.phase = 0;
      stretch = 0;
    }
    const airborne = Math.max(0, Math.min(1, stretch * 8 + lift * 4));
    this.hopper.position.y = lift;
    this.body.scale.set(1 - stretch * 0.4, 1 + stretch * 0.3, 1 + stretch);
    this.head.rotation.x = -stretch * 1.2;
    // Ears stream back while hopping; idle ears twitch now and then.
    const idle = Math.max(0, Math.sin(time * 0.9 + s.id * 1.7) - 0.92) * 6;
    this.earL.rotation.x = 0.35 + airborne * 0.6 + Math.sin(time * 18) * idle * 0.15;
    this.earR.rotation.x = 0.35 + airborne * 0.6;
    this.earL.rotation.z = 0.12;
    this.earR.rotation.z = -0.12;
    this.hindL.rotation.x = this.hindR.rotation.x = airborne * 0.9;
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.set(0, s.yaw, 0);
  }
}

/** How far the head turns from the body (radians), and how far it tilts. */
export const HEAD_TURN_LIMIT = 1.2;
const HEAD_PITCH_LIMIT = 1.3;
/** Model joints (blocks over the feet): hips, the neck and shoulders over the hips, the top of the head. */
const HIP_Y = 0.74;
const NECK_Y = 0.66;
const SHOULDER_Y = 0.64;
const HEAD_TOP = 1.82;
/** Sneaking lowers the body this much. */
const SNEAK_DROP = 0.14;
/** Horizontal speed (blocks / s) at which the walk reaches its full swing, and the swing limits. */
const FULL_SWING_SPEED = 4.3;
const SWING = 0.75;
const SPRINT_SWING = 0.95;


class PlayerView extends EntityView {
  readonly kind = 'player' as const;
  /** Bends at the hips: torso, head and arms. */
  private readonly upper = new THREE.Group();
  /** Turns and tilts the head. */
  private readonly neck = new THREE.Group();
  private readonly armL: THREE.Mesh;
  private readonly armR: THREE.Mesh;
  private readonly legL: THREE.Mesh;
  private readonly legR: THREE.Mesh;
  /** The main-hand item, in the right hand. */
  private readonly handItem: THREE.Mesh;
  private readonly tag: NameTag;
  private shownHeld = -1;
  private phase = 0;

  constructor(
    private readonly assets: EntityAssets,
    labels: LabelCache,
    labelPlaceholder: THREE.SpriteNodeMaterial,
  ) {
    super();
    const g = assets.models.player;
    const mat = assets.modelMaterial;
    const L = this.light;
    this.upper.position.set(0, HIP_Y, 0);
    this.upper.rotation.order = 'YXZ';
    const torso = makeMesh(g.torso, mat, L);
    this.neck.position.set(0, NECK_Y, 0);
    this.neck.rotation.order = 'YXZ';
    this.neck.add(makeMesh(g.head, mat, L));
    this.armL = makeMesh(g.arm, mat, L);
    this.armL.position.set(-0.325, SHOULDER_Y, 0);
    this.armR = makeMesh(g.arm, mat, L);
    this.armR.position.set(0.325, SHOULDER_Y, 0);
    this.handItem = makeMesh(assets.tnt(), assets.materials.opaque, L);
    this.handItem.visible = false;
    this.armR.add(this.handItem);
    this.upper.add(torso, this.neck, this.armL, this.armR);
    this.legL = makeMesh(g.leg, mat, L);
    this.legL.position.set(-0.11, HIP_Y, 0);
    this.legR = makeMesh(g.leg, mat, L);
    this.legR.position.set(0.11, HIP_Y, 0);
    this.tag = new NameTag(labels, labelPlaceholder);
    this.root.add(this.upper, this.legL, this.legR, this.tag.sprite);
  }

  /** The name tag's text (null = none), for tests. */
  get labelText(): string | null {
    return this.tag.text;
  }

  /** Takes the tag's text at once (before the layer sweeps the views that left: a text passed on is not re-made). */
  override capture(s: EntityRenderState): void {
    super.capture(s);
    this.tag.setText(s.label);
  }

  override release(): void {
    super.release();
    this.tag.release();
  }

  /** Puts the held item's visual in the right hand (a block as a small cube, a flat item as its icon). */
  private setHeld(item: number): void {
    if (item === this.shownHeld) return;
    this.shownHeld = item;
    const v = item > 0 ? this.assets.item(item) : null;
    const m = this.handItem;
    m.visible = v !== null;
    if (v === null) return;
    m.geometry = v.geo;
    m.material = v.mat;
    const icon = v.geo.boundingBox !== null && v.geo.boundingBox.max.z - v.geo.boundingBox.min.z < 0.05;
    if (icon) {
      // A flat item: held by its lower end, its face turned half way between the front and the
      // side, so it reads from both.
      m.position.set(0.02, -0.62, -0.14);
      m.rotation.set(0, Math.PI / 4, 0);
      m.scale.setScalar(0.8);
    } else {
      m.position.set(0, -0.62, -0.06);
      m.rotation.set(0, Math.PI / 4, 0);
      m.scale.setScalar(0.85);
    }
  }

  update(f: FrameInfo): void {
    const s = this.cur;
    const time = f.time;
    const dt = this.track(time);
    this.setLight(s);
    const posture = s.posture;
    // At a helm both hands are on the wheel: nothing in the hand.
    this.setHeld(posture === 'helm' ? 0 : s.held);
    const speed = posture === 'helm' ? 0 : Math.sqrt(this.vx * this.vx + this.vz * this.vz);
    // Walk: legs and arms swing with the own horizontal motion; not while flying or steering.
    const walking = posture !== 'fly' && posture !== 'helm';
    const maxSwing = posture === 'sprint' ? SPRINT_SWING : SWING;
    let amp = walking ? Math.min(1, speed / FULL_SWING_SPEED) * maxSwing : 0;
    if (posture === 'sneak') amp *= 0.6;
    if (amp > 1e-3) this.phase += dt * (2 + speed * 1.9);
    else this.phase = 0;
    const sw = Math.sin(this.phase) * amp;
    let lean = 0;
    let drop = 0;
    let armBase = 0;
    let armSpread = 0;
    let legBase = 0;
    let legSway = 0;
    let bob = 0;
    switch (posture) {
      case 'sneak':
        lean = -0.42;
        drop = SNEAK_DROP;
        armBase = 0.3;
        break;
      case 'sprint':
        lean = -0.22 * Math.min(1, speed / FULL_SWING_SPEED);
        break;
      case 'fly': {
        const fwd = Math.min(1, speed / 6);
        lean = -0.35 * fwd;
        legBase = -0.2 - 0.3 * fwd;
        legSway = Math.sin(time * 2.1 + s.id) * 0.08;
        armSpread = 0.22;
        bob = (1 - fwd) * Math.sin(time * 2 + s.id * 0.7) * 0.05;
        break;
      }
      case 'helm':
        armBase = 1.2;
        armSpread = -0.18;
        break;
      case 'stand':
        break;
    }
    const idle = Math.sin(time * 1.3 + s.id) * 0.03;
    this.upper.rotation.set(lean, 0, 0);
    this.upper.position.set(0, HIP_Y, 0);
    // The head: within HEAD_TURN_LIMIT of the body, its pitch measured from the horizon.
    let turn = s.headYaw - s.yaw;
    turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI));
    turn = turn < -HEAD_TURN_LIMIT ? -HEAD_TURN_LIMIT : turn > HEAD_TURN_LIMIT ? HEAD_TURN_LIMIT : turn;
    const pitch = s.headPitch < -HEAD_PITCH_LIMIT ? -HEAD_PITCH_LIMIT : s.headPitch > HEAD_PITCH_LIMIT ? HEAD_PITCH_LIMIT : s.headPitch;
    this.neck.rotation.set(pitch - lean, turn, 0);
    const holding = this.shownHeld > 0;
    this.armL.rotation.set(armBase - sw * 0.8, 0, -armSpread - idle);
    this.armR.rotation.set(armBase + sw * 0.8 + (holding ? 0.35 - sw * 0.4 : 0), 0, armSpread + idle);
    this.legL.rotation.set(legBase + sw + legSway, 0, 0);
    this.legR.rotation.set(legBase - sw - legSway, 0, 0);
    this.root.position.set(s.x, s.y - drop + bob, s.z);
    this.root.rotation.set(0, s.yaw, 0);
    this.tag.place(s.x, s.y - drop + bob, s.z, HEAD_TOP + LABEL_GAP - (posture === 'sneak' ? 0.12 : 0), f.labels);
  }
}

/** Pool of entity views keyed by entity id. */
export class EntityLayer {
  readonly group = new THREE.Group();
  private readonly live = new Map<number, EntityView>();
  private readonly free: Record<EntityKind, EntityView[]> = { player: [], item: [], falling: [], tnt: [], rabbit: [] };
  private stamp = 0;
  /** Rasterised name tags (counted; see labels.ts). */
  readonly labels = new LabelCache();
  private readonly labelPlaceholder = placeholderLabelMaterial();
  /** The warm-up player's tag (warmupViews): its own cache, never released before dispose(). */
  private readonly warmupLabels = new LabelCache();
  /** animate() arguments, held for the allocation-free forEach callback. */
  private readonly frame: FrameInfo = { time: 0, labels: labelView() };
  private readonly animateOne = (v: EntityView): void => {
    v.update(this.frame);
  };
  private readonly sweep = (v: EntityView, id: number): void => {
    if (v.stamp !== this.stamp) {
      v.release();
      this.live.delete(id);
      this.free[v.kind].push(v);
    }
  };

  constructor(
    private readonly assets: EntityAssets,
    private readonly opaque: THREE.NodeMaterial,
  ) {
    this.group.name = 'entities';
  }

  get count(): number {
    return this.live.size;
  }

  private create(kind: EntityKind): EntityView {
    switch (kind) {
      case 'item':
        return new ItemView(this.assets);
      case 'falling':
        return new CellView(this.assets);
      case 'tnt':
        return new TntView(this.assets, this.opaque);
      case 'rabbit':
        return new RabbitView(this.assets);
      case 'player':
        return new PlayerView(this.assets, this.labels, this.labelPlaceholder);
    }
  }

  /** Records this frame's entity list (views are posed later, in animate()). */
  set(list: readonly EntityRenderState[]): void {
    const stamp = ++this.stamp;
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      let v = this.live.get(s.id);
      if (v && v.kind !== s.kind) {
        v.release();
        this.free[v.kind].push(v);
        v = undefined;
      }
      if (!v) {
        v = this.free[s.kind].pop() ?? this.create(s.kind);
        if (!v.root.parent) this.group.add(v.root);
        v.reset(s);
        this.live.set(s.id, v);
      } else {
        v.capture(s);
      }
      v.stamp = stamp;
    }
    this.live.forEach(this.sweep);
  }

  /**
   * Poses every live view for a frame at `time` (seconds) and sizes the name tags for the camera
   * described by `labels` (copied; its fog object is only read during the call); call once per
   * rendered frame.
   */
  animate(time: number, labels: LabelView): void {
    const f = this.frame;
    f.time = time;
    const l = f.labels;
    l.x = labels.x;
    l.y = labels.y;
    l.z = labels.z;
    l.fov = labels.fov;
    l.viewportPx = labels.viewportPx;
    l.fog = labels.fog;
    this.live.forEach(this.animateOne);
  }

  /** The live view of entity `id` (tests). */
  viewOf(id: number): { kind: EntityKind; root: THREE.Object3D; labelText: string | null } | null {
    const v = this.live.get(id);
    if (v === undefined) return null;
    return { kind: v.kind, root: v.root, labelText: v instanceof PlayerView ? v.labelText : null };
  }

  /** Builds one view of every kind (for pipeline warm-up); the player holds an item and has a tag. */
  warmupViews(): THREE.Object3D[] {
    const kinds: EntityKind[] = ['item', 'falling', 'tnt', 'rabbit', 'player'];
    const out: THREE.Object3D[] = [];
    const dummy = blankState();
    const f: FrameInfo = { time: 0, labels: labelView() };
    for (const k of kinds) {
      const v = k === 'player' ? new PlayerView(this.assets, this.warmupLabels, this.labelPlaceholder) : this.create(k);
      dummy.kind = k;
      dummy.payload = k === 'falling' ? B.SAND : B.STONE;
      dummy.held = k === 'player' ? B.STONE : 0;
      dummy.label = k === 'player' ? '·' : null;
      v.reset(dummy);
      v.update(f);
      out.push(v.root);
    }
    return out;
  }

  dispose(): void {
    this.live.forEach((v) => v.release());
    this.live.clear();
    this.group.clear();
    this.labels.dispose();
    this.warmupLabels.dispose();
    this.labelPlaceholder.dispose();
  }
}
