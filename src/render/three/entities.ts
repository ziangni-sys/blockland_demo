/**
 * Entity drawing. setEntities() hands over the full list every frame; views are pooled by
 * entity id (and per kind once released), so steady-state frames allocate nothing.
 *
 * Positions: (x, y, z) is the bottom centre of the entity (feet / resting point), yaw in the
 * game's convention (0 looks toward -Z, CCW from above) which equals Object3D.rotation.y.
 *
 * Animation (rabbit hop, player walk) is driven by the entity's OWN motion. The contract
 * carries no velocity, so it is measured from successive positions, and an entity riding a
 * ship or a turntable would otherwise walk / hop in place. EntityLayer.set() only records
 * the states; animate() runs once per rendered frame, after every structure pose of the
 * frame is known, and asks a CarrierQuery for the displacement relative to whatever might be
 * carrying the entity.
 */
import * as THREE from 'three/webgpu';
import type { EntityKind, EntityRenderState } from '../backend';
import { B } from '../../blocks/defs';
import { blastCrateVisual, cubeTilesForCell, itemVisual, type CubeVisual } from './blocktiles';
import { buildBox, buildQuad } from './boxgeom';
import { toBufferGeometry, type GeometryOptions } from './geometry';
import { VFLAG_EMISSIVE } from '../../mesh/types';
import type { VoxelMaterials } from './shading';
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

/**
 * Removes carrier motion from a measured displacement. Given an entity at world (x, y, z)
 * that moved by (dx, dy, dz) since the previous rendered frame, writes into `out` the
 * displacement relative to the structure most plausibly carrying it (the raw displacement
 * when none is).
 */
export interface CarrierQuery {
  selfMotion(x: number, y: number, z: number, dx: number, dy: number, dz: number, out: { x: number; y: number; z: number }): void;
}

/** A CarrierQuery for a world without structures. */
export const NO_CARRIERS: CarrierQuery = Object.freeze({
  selfMotion(_x: number, _y: number, _z: number, dx: number, dy: number, dz: number, out: { x: number; y: number; z: number }): void {
    out.x = dx;
    out.y = dy;
    out.z = dz;
  },
});

function makeMesh(geo: THREE.BufferGeometry, mat: THREE.Material, light: THREE.Vector4): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.userData.bl = light;
  return m;
}

/** Base of every pooled entity view. */
abstract class EntityView {
  readonly root = new THREE.Group();
  /** Per-object light uniform shared by every mesh of the view (x sky, y block, z flash). */
  readonly light = new THREE.Vector4(1, 0, 0, 0);
  /** The state of this frame (copied: the caller may reuse its objects after setEntities). */
  readonly cur: EntityRenderState = { id: -1, kind: 'item', x: 0, y: 0, z: 0, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 };
  id = -1;
  stamp = 0;
  // Motion tracking for animation.
  protected lastX = 0;
  protected lastY = 0;
  protected lastZ = 0;
  protected lastT = -1;
  /** Smoothed velocity relative to the carrier (blocks / s). */
  protected vx = 0;
  protected vy = 0;
  protected vz = 0;
  private readonly rel = { x: 0, y: 0, z: 0 };

  abstract readonly kind: EntityKind;

  /** Called when the view is (re)assigned to an entity. */
  reset(s: EntityRenderState): void {
    this.id = s.id;
    this.capture(s);
    this.lastX = s.x;
    this.lastY = s.y;
    this.lastZ = s.z;
    this.lastT = -1;
    this.vx = this.vy = this.vz = 0;
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
    c.payload = s.payload;
    c.flash = s.flash;
    c.sky = s.sky;
    c.block = s.block;
  }

  /**
   * Smoothed self-motion velocity from successive positions, carrier motion removed; returns
   * the frame dt (0 on the first frame).
   */
  protected track(time: number, carriers: CarrierQuery): number {
    const s = this.cur;
    let dt = 0;
    if (this.lastT >= 0) {
      dt = time - this.lastT;
      if (dt > 1e-4 && dt < 0.5) {
        const r = this.rel;
        carriers.selfMotion(s.x, s.y, s.z, s.x - this.lastX, s.y - this.lastY, s.z - this.lastZ, r);
        const k = Math.min(1, dt * 12);
        this.vx += (r.x / dt - this.vx) * k;
        this.vy += (r.y / dt - this.vy) * k;
        this.vz += (r.z / dt - this.vz) * k;
      } else if (dt >= 0.5) {
        this.vx = this.vy = this.vz = 0;
      }
    }
    if (dt < 0 || dt > 0.25) dt = 0;
    this.lastX = s.x;
    this.lastY = s.y;
    this.lastZ = s.z;
    this.lastT = time;
    return dt;
  }

  protected setLight(s: EntityRenderState): void {
    this.light.set(clamp01(s.sky / 15), clamp01(s.block / 15), clamp01(s.flash), 0);
  }

  /** Poses the view from `cur` for this frame. */
  abstract update(time: number, carriers: CarrierQuery): void;
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

  update(time: number, carriers: CarrierQuery): void {
    const s = this.cur;
    this.track(time, carriers);
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

  update(time: number, carriers: CarrierQuery): void {
    const s = this.cur;
    this.track(time, carriers);
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

  update(time: number, carriers: CarrierQuery): void {
    const s = this.cur;
    this.track(time, carriers);
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

  update(time: number, carriers: CarrierQuery): void {
    const s = this.cur;
    const dt = this.track(time, carriers);
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

class PlayerView extends EntityView {
  readonly kind = 'player' as const;
  private readonly armL: THREE.Mesh;
  private readonly armR: THREE.Mesh;
  private readonly legL: THREE.Mesh;
  private readonly legR: THREE.Mesh;
  private phase = 0;

  constructor(a: EntityAssets) {
    super();
    const g = a.models.player;
    const mat = a.modelMaterial;
    const L = this.light;
    const torso = makeMesh(g.torso, mat, L);
    torso.position.set(0, 0.74, 0);
    const head = makeMesh(g.head, mat, L);
    head.position.set(0, 1.4, 0);
    this.armL = makeMesh(g.arm, mat, L);
    this.armL.position.set(-0.325, 1.38, 0);
    this.armR = makeMesh(g.arm, mat, L);
    this.armR.position.set(0.325, 1.38, 0);
    this.legL = makeMesh(g.leg, mat, L);
    this.legL.position.set(-0.11, 0.74, 0);
    this.legR = makeMesh(g.leg, mat, L);
    this.legR.position.set(0.11, 0.74, 0);
    this.root.add(torso, head, this.armL, this.armR, this.legL, this.legR);
  }

  update(time: number, carriers: CarrierQuery): void {
    const s = this.cur;
    const dt = this.track(time, carriers);
    this.setLight(s);
    const speed = Math.hypot(this.vx, this.vz);
    const amp = Math.min(1, speed / 4.3) * 0.75;
    this.phase += dt * (2 + speed * 1.9);
    const sw = Math.sin(this.phase) * amp;
    this.legL.rotation.x = sw;
    this.legR.rotation.x = -sw;
    this.armL.rotation.x = -sw * 0.8;
    this.armR.rotation.x = sw * 0.8;
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.set(0, s.yaw, 0);
  }
}

/** Pool of entity views keyed by entity id. */
export class EntityLayer {
  readonly group = new THREE.Group();
  private readonly live = new Map<number, EntityView>();
  private readonly free: Record<EntityKind, EntityView[]> = { player: [], item: [], falling: [], tnt: [], rabbit: [] };
  private stamp = 0;
  /** animate() arguments, held for the allocation-free forEach callback. */
  private time = 0;
  private carriers: CarrierQuery = NO_CARRIERS;
  private readonly animateOne = (v: EntityView): void => {
    v.update(this.time, this.carriers);
  };
  private readonly sweep = (v: EntityView, id: number): void => {
    if (v.stamp !== this.stamp) {
      v.root.visible = false;
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
        return new PlayerView(this.assets);
    }
  }

  /** Records this frame's entity list (views are posed later, in animate()). */
  set(list: readonly EntityRenderState[]): void {
    const stamp = ++this.stamp;
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      let v = this.live.get(s.id);
      if (v && v.kind !== s.kind) {
        v.root.visible = false;
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

  /** Poses every live view for a frame at `time` (seconds); call once per rendered frame. */
  animate(time: number, carriers: CarrierQuery): void {
    this.time = time;
    this.carriers = carriers;
    this.live.forEach(this.animateOne);
    this.carriers = NO_CARRIERS;
  }

  /** Builds one view of every kind (for pipeline warm-up). */
  warmupViews(): THREE.Object3D[] {
    const kinds: EntityKind[] = ['item', 'falling', 'tnt', 'rabbit', 'player'];
    const out: THREE.Object3D[] = [];
    const dummy: EntityRenderState = { id: -1, kind: 'item', x: 0, y: 0, z: 0, yaw: 0, payload: B.STONE, flash: 0, sky: 15, block: 0 };
    for (const k of kinds) {
      const v = this.create(k);
      dummy.kind = k;
      dummy.payload = k === 'falling' ? B.SAND : B.STONE;
      v.reset(dummy);
      v.update(0, NO_CARRIERS);
      out.push(v.root);
    }
    return out;
  }

  dispose(): void {
    this.live.clear();
    this.group.clear();
  }
}
