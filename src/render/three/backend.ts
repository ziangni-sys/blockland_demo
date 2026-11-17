/**
 * three.js implementation of RenderBackend (WebGPURenderer + TSL node materials; falls back
 * to WebGL2 when WebGPU is unavailable).
 *
 * Scene layout:
 *   sections   static world section meshes (matrices computed once, never re-traversed)
 *   structures one Group per structure, matrix written from StructurePose each frame
 *   entities   pooled entity views
 *   overlays   world-space overlays (structure-space overlays live under their structure)
 *   sky        far-plane dome drawn after the opaque world
 *
 * Render order: opaque (renderOrder 0, front to back) -> cutout (1) -> sky (50) ->
 * transparent list (water 0, overlays 60+).
 */
import * as THREE from 'three/webgpu';
import { renderGroup, uniform } from 'three/tsl';
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
} from '../backend';
import type { GeometryData, MeshData } from '../../mesh/types';
import { SECTION_SIZE } from '../../core/constants';
import { B } from '../../blocks/defs';
import { BLOCKS } from '../../blocks/registry';
import { buildBox } from './boxgeom';
import { EntityAssets, EntityLayer } from './entities';
import { computeBoundsFromPositions, setBoxBounds, toBufferGeometry, type GeometryOptions } from './geometry';
import { computeFog, computeSkyState, createFogParams, createSkyState, linearToSrgb, SUN_TILT } from './lighting';
import { createModelMaterial } from './models';
import { OverlayLayer } from './overlays';
import { dryVolumeCenter, dryVolumeMatrix, dryVolumeRadius, poseToMatrix } from './pose';
import { createSky, type Sky } from './sky';
import { createVoxelMaterials, DRY_SLOTS, SharedUniforms, type VoxelMaterials } from './shading';
import { prepareTilePixels } from './tiles';

export interface ThreeBackendOptions {
  /** Use the WebGL2 backend even when WebGPU is available. */
  forceWebGL?: boolean;
  /** Multisample anti-aliasing (default true). */
  antialias?: boolean;
  /** Passed to the WebGPU adapter request (default 'high-performance'). */
  powerPreference?: GPUPowerPreference;
}

/** Margin added to section bounds for liquid bobbing / plant sway. */
const ANIM_MARGIN = 0.25;
const GROUPS = ['opaque', 'cutout', 'translucent'] as const;
const ORDER = [0, 1, 0];

interface SectionRecord {
  meshes: [THREE.Mesh | null, THREE.Mesh | null, THREE.Mesh | null];
}

interface StructureRecord {
  group: THREE.Group;
  meshes: [THREE.Mesh | null, THREE.Mesh | null, THREE.Mesh | null];
  /** Per-object light uniform shared by the structure's meshes. */
  light: THREE.Vector4;
  pose: StructurePose;
  hasPose: boolean;
  dryTex: THREE.Data3DTexture | null;
  dry: DryVolume | null;
}

function newPose(): StructurePose {
  return { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, pivotX: 0, pivotY: 0, pivotZ: 0, sky: 15, block: 0 };
}

function copyPose(src: StructurePose, dst: StructurePose): void {
  dst.px = src.px;
  dst.py = src.py;
  dst.pz = src.pz;
  dst.qx = src.qx;
  dst.qy = src.qy;
  dst.qz = src.qz;
  dst.qw = src.qw;
  dst.pivotX = src.pivotX;
  dst.pivotY = src.pivotY;
  dst.pivotZ = src.pivotZ;
  dst.sky = src.sky;
  dst.block = src.block;
}

function makeTileTexture(data: Uint8Array, size: number, count: number): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, size, size, count);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  // Nearest within a level keeps pixel art crisp up close; linear between levels hides the
  // switch. Each layer is its own image, so mips never bleed between tiles.
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.unpackAlignment = 4;
  t.needsUpdate = true;
  return t;
}

function makeMaskTexture(data: Uint8Array, sx: number, sy: number, sz: number): THREE.Data3DTexture {
  // Width along local x, height along local z, depth along local y: the DryVolume byte order.
  const t = new THREE.Data3DTexture(data, sx, sz, sy);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = THREE.NoColorSpace;
  // Linear on purpose: with the shader's 0.2 threshold the dry region reaches ~0.3 cells
  // into neighbouring (hull wall) cells (still 0.25 at concave corners), which removes the 1 px
  // z-fight line where the water
  // plane meets the inner wall faces. The walls hide everything else that is cut.
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class ThreeBackend implements RenderBackend {
  private renderer: THREE.WebGPURenderer | null = null;
  private ready = false;
  private info: BackendInfo = { api: 'webgl2', detail: '' };
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 512);
  private readonly sectionsRoot = new THREE.Group();
  private readonly structuresRoot = new THREE.Group();
  private readonly overlayRoot = new THREE.Group();
  private readonly u = new SharedUniforms();
  /** Per-object vec4 uniform (see shading.ts). */
  private readonly worldLight = new THREE.Vector4(1, 0, 0, 1);
  private readonly objUniform = uniform(new THREE.Vector4(1, 0, 0, 1)).onObjectUpdate((frame) => {
    const bl = frame.object?.userData.bl as THREE.Vector4 | undefined;
    return bl ?? this.worldLight;
  });
  private readonly tileSize = uniform(16).setGroup(renderGroup);
  private readonly tileNodes: THREE.TextureNode[] = [];
  private readonly dryNodes: THREE.TextureNode[] = [];
  private readonly dryPlaceholders: THREE.Data3DTexture[] = [];
  private readonly placeholderTiles: THREE.DataArrayTexture;
  private tiles: THREE.DataArrayTexture | null = null;
  private pendingTiles: TileTextureData | null = null;
  private materials: VoxelMaterials | null = null;
  private modelMaterial: THREE.NodeMaterial | null = null;
  private sky: Sky | null = null;
  private entityAssets: EntityAssets | null = null;
  private entities: EntityLayer | null = null;
  private overlays: OverlayLayer | null = null;
  private warmup: THREE.Group | null = null;
  private geoOpts: GeometryOptions = { padNormals: false };

  private readonly sections = new Map<number, SectionRecord>();
  private readonly structures = new Map<number, StructureRecord>();
  /** Bumped when structures appear / disappear (overlay layers re-parent then). */
  private topology = 0;

  private readonly skyState = createSkyState();
  private readonly fog = createFogParams();
  private envTime = 0;
  /** -1 until the first setEnvironment, so the far plane is always fitted once. */
  private viewDistance = -1;
  private readonly clearColor = new THREE.Color(0, 0, 0);
  private width = 1;
  private height = 1;

  // Dry volume slot selection scratch (no allocation per frame).
  private readonly slotIds = new Int32Array(DRY_SLOTS);
  private readonly slotDist = new Float64Array(DRY_SLOTS);
  private readonly scratchV = { x: 0, y: 0, z: 0 };

  private readonly resolveParent = (structureId: number): THREE.Object3D | null => {
    if (structureId === 0) return this.overlayRoot;
    return this.structures.get(structureId)?.group ?? null;
  };

  constructor(private readonly opts: ThreeBackendOptions = {}) {
    this.placeholderTiles = makeTileTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 1);
    for (let i = 0; i < DRY_SLOTS; i++) {
      // Distinct textures per slot: three merges texture bindings by texture identity at
      // compile time, so identical placeholders would collapse the slots into one binding.
      this.dryPlaceholders.push(makeMaskTexture(new Uint8Array(1), 1, 1, 1));
    }
    this.scene.name = 'blocklands';
    this.sectionsRoot.name = 'sections';
    this.structuresRoot.name = 'structures';
    this.overlayRoot.name = 'overlays';
    this.sectionsRoot.matrixAutoUpdate = false;
    this.overlayRoot.matrixAutoUpdate = false;
    this.structuresRoot.matrixAutoUpdate = false;
    this.scene.add(this.sectionsRoot, this.structuresRoot, this.overlayRoot);
    this.camera.rotation.order = 'YXZ';
    this.scene.matrixAutoUpdate = false;
  }

  // ------------------------------------------------------------------ lifecycle

  async init(canvas: HTMLCanvasElement): Promise<BackendInfo> {
    let forceWebGL = this.opts.forceWebGL === true;
    let adapterDetail = '';
    if (!forceWebGL) {
      // Probe first: without an adapter three would log a fallback warning; probing lets us
      // pick the WebGL2 backend up front instead.
      const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined;
      if (!gpu) {
        forceWebGL = true;
      } else {
        try {
          const adapter = await gpu.requestAdapter({ powerPreference: this.opts.powerPreference ?? 'high-performance' });
          if (!adapter) forceWebGL = true;
          else {
            // GPUAdapter.info is missing in older Chromium builds; it is only cosmetic here.
            const ai = (adapter as { info?: GPUAdapterInfo }).info;
            if (ai) adapterDetail = [ai.vendor, ai.architecture, ai.device, ai.description].filter((s) => s && s.length > 0).join(' ');
          }
        } catch {
          forceWebGL = true;
        }
      }
    }

    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: this.opts.antialias ?? true,
      forceWebGL,
      alpha: false,
      powerPreference: this.opts.powerPreference ?? 'high-performance',
    });
    await renderer.init();
    this.renderer = renderer;
    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.NoToneMapping;
    // Output space == working space: three then renders straight into the canvas with no
    // RGBA16F framebuffer and no conversion pass; the materials encode sRGB themselves
    // (shading.ts encodeOutput). Saves a full-screen pass and lets MSAA resolve to 8-bit.
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; gl?: WebGL2RenderingContext };
    const isWebGPU = backend.isWebGPUBackend === true;
    this.geoOpts = { padNormals: isWebGPU };
    this.info = { api: isWebGPU ? 'webgpu' : 'webgl2', detail: isWebGPU ? `WebGPU ${adapterDetail}`.trim() : `WebGL2 ${glRendererName(backend.gl)}`.trim() };

    this.buildPipelines();
    await this.compileWarmup();
    if (this.pendingTiles) {
      const t = this.pendingTiles;
      this.pendingTiles = null;
      this.setTiles(t);
    }
    this.ready = true;
    return this.info;
  }

  private buildPipelines(): void {
    const u = this.u;
    const water = BLOCKS[B.WATER];
    if (water) u.waterLayers.value.set(water.tileIds[0] ?? -1, water.tileIds[1] ?? -1);
    this.materials = createVoxelMaterials(u, this.objUniform, this.placeholderTiles, this.tileSize, this.dryPlaceholders, this.tileNodes, this.dryNodes);
    this.modelMaterial = createModelMaterial(u, this.objUniform);
    this.sky = createSky(u);
    this.scene.add(this.sky.mesh);
    this.entityAssets = new EntityAssets(this.materials, this.modelMaterial, this.geoOpts);
    this.entities = new EntityLayer(this.entityAssets, this.materials.opaque);
    this.scene.add(this.entities.group);
    this.overlays = new OverlayLayer(u, this.placeholderTiles, this.tileNodes);
  }

  /**
   * Compiles every material / geometry-layout / object-type combination before the first
   * frame, so the first water section, structure, entity or overlay never stalls a frame.
   * The warm-up objects are kept alive (never rendered): disposing them would release the
   * cached pipelines again.
   */
  private async compileWarmup(): Promise<void> {
    const renderer = this.renderer!;
    const mats = this.materials!;
    const g = new THREE.Group();
    g.name = 'warmup';
    const box = buildBox({ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1, tiles: [0, 0, 0, 0, 0, 0] });
    for (const m of [mats.opaque, mats.cutout, mats.translucent]) {
      const geo = toBufferGeometry(box, this.geoOpts);
      setBoxBounds(geo, 1, 1, 1, 0);
      const mesh = new THREE.Mesh(geo, m);
      mesh.userData.bl = this.worldLight;
      g.add(mesh);
    }
    for (const o of this.entities!.warmupViews()) g.add(o);
    for (const o of this.overlays!.warmupObjects()) g.add(o);
    g.traverse((o) => {
      o.frustumCulled = false;
      if (o.userData.bl === undefined) o.userData.bl = this.worldLight;
    });
    this.warmup = g;
    this.camera.position.set(0, 0, 3);
    this.camera.updateMatrixWorld();
    await renderer.compileAsync(g, this.camera, this.scene);
    await renderer.compileAsync(this.scene, this.camera);
    // One frame while loading: configures the canvas / MSAA targets before the first game frame.
    renderer.render(this.scene, this.camera);
  }

  setTiles(tiles: TileTextureData): void {
    if (!this.renderer || !this.materials) {
      this.pendingTiles = tiles;
      return;
    }
    const tex = makeTileTexture(prepareTilePixels(tiles), tiles.size, tiles.count);
    for (const n of this.tileNodes) n.value = tex;
    this.tiles?.dispose();
    this.tiles = tex;
    this.tileSize.value = tiles.size;
    this.overlays?.refreshTiles();
  }

  // ------------------------------------------------------------------ world sections

  setSectionMesh(key: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void {
    const mats = this.materials;
    // Meshes only make sense after init() (the contract orders init -> setTiles -> meshes).
    if (!mats) return;
    let rec = this.sections.get(key);
    if (!mesh || (!mesh.opaque && !mesh.cutout && !mesh.translucent)) {
      if (rec) {
        for (const m of rec.meshes) if (m) this.disposeMesh(m);
        this.sections.delete(key);
      }
      return;
    }
    if (!rec) {
      rec = { meshes: [null, null, null] };
      this.sections.set(key, rec);
    }
    for (let i = 0; i < 3; i++) {
      const data: GeometryData | null = mesh[GROUPS[i]!];
      const old = rec.meshes[i]!;
      if (!data || data.indexCount === 0) {
        if (old) this.disposeMesh(old);
        rec.meshes[i] = null;
        continue;
      }
      const geo = toBufferGeometry(data, this.geoOpts);
      setBoxBounds(geo, SECTION_SIZE, SECTION_SIZE, SECTION_SIZE, ANIM_MARGIN);
      let m = old;
      if (m) {
        m.geometry.dispose();
        m.geometry = geo;
      } else {
        m = new THREE.Mesh(geo, i === 0 ? mats.opaque : i === 1 ? mats.cutout : mats.translucent);
        m.userData.bl = this.worldLight;
        m.renderOrder = ORDER[i]!;
        m.matrixAutoUpdate = false;
        // Static: computed once here, skipped by the per-frame scene graph traversal.
        m.matrixWorldAutoUpdate = false;
        this.sectionsRoot.add(m);
        rec.meshes[i] = m;
      }
      m.position.set(ox, oy, oz);
      m.updateMatrix();
      m.matrixWorld.copy(m.matrix);
    }
  }

  private disposeMesh(m: THREE.Mesh): void {
    m.removeFromParent();
    m.geometry.dispose();
  }

  // ------------------------------------------------------------------ structures

  private structure(id: number): StructureRecord {
    let rec = this.structures.get(id);
    if (!rec) {
      const group = new THREE.Group();
      group.name = `structure-${id}`;
      group.matrixAutoUpdate = false;
      rec = { group, meshes: [null, null, null], light: new THREE.Vector4(1, 0, 0, 0), pose: newPose(), hasPose: false, dryTex: null, dry: null };
      this.structures.set(id, rec);
      this.structuresRoot.add(group);
      this.topology++;
    }
    return rec;
  }

  setStructureMesh(id: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void {
    if (!mesh) {
      const rec = this.structures.get(id);
      if (!rec) return;
      for (const m of rec.meshes) if (m) this.disposeMesh(m);
      rec.dryTex?.dispose();
      rec.group.removeFromParent();
      this.structures.delete(id);
      this.topology++;
      return;
    }
    const mats = this.materials;
    if (!mats) return;
    const rec = this.structure(id);
    for (let i = 0; i < 3; i++) {
      const data: GeometryData | null = mesh[GROUPS[i]!];
      const old = rec.meshes[i]!;
      if (!data || data.indexCount === 0) {
        if (old) this.disposeMesh(old);
        rec.meshes[i] = null;
        continue;
      }
      const geo = toBufferGeometry(data, this.geoOpts);
      computeBoundsFromPositions(geo, data.positions, data.vertexCount, 0.05);
      let m = old;
      if (m) {
        m.geometry.dispose();
        m.geometry = geo;
      } else {
        m = new THREE.Mesh(geo, i === 0 ? mats.opaque : i === 1 ? mats.cutout : mats.translucent);
        m.userData.bl = rec.light;
        m.renderOrder = ORDER[i]!;
        m.matrixAutoUpdate = false;
        rec.group.add(m);
        rec.meshes[i] = m;
      }
      m.position.set(ox, oy, oz);
      m.updateMatrix();
    }
    rec.group.matrixWorldNeedsUpdate = true;
  }

  setStructurePose(id: number, pose: StructurePose): void {
    const rec = this.structure(id);
    copyPose(pose, rec.pose);
    rec.hasPose = true;
    poseToMatrix(pose, rec.group.matrix.elements);
    rec.group.matrixWorldNeedsUpdate = true;
    rec.light.set(clamp01(pose.sky / 15), clamp01(pose.block / 15), 0, 0);
  }

  setStructureDryVolume(id: number, dry: DryVolume | null): void {
    const rec = this.structures.get(id) ?? (dry ? this.structure(id) : undefined);
    if (!rec) return;
    if (!dry || dry.sx <= 0 || dry.sy <= 0 || dry.sz <= 0) {
      rec.dryTex?.dispose();
      rec.dryTex = null;
      rec.dry = null;
      return;
    }
    const n = dry.sx * dry.sy * dry.sz;
    const old = rec.dry;
    const sameSize = rec.dryTex !== null && old !== null && old.sx === dry.sx && old.sy === dry.sy && old.sz === dry.sz;
    // The contract marks dry cells with any non-zero byte; an R8 unorm texture would sample a
    // 1 as 1/255, so normalize to 0 / 255 while copying (we never keep the caller's buffer).
    const data = sameSize ? (rec.dryTex!.image.data as Uint8Array) : new Uint8Array(n);
    const src = dry.mask;
    const m = Math.min(n, src.length);
    for (let i = 0; i < m; i++) data[i] = src[i] !== 0 ? 255 : 0;
    data.fill(0, m);
    if (sameSize) {
      rec.dryTex!.needsUpdate = true;
    } else {
      rec.dryTex?.dispose();
      rec.dryTex = makeMaskTexture(data, dry.sx, dry.sy, dry.sz);
    }
    // Keep our own copy of the box (not the caller's object, which may be reused).
    rec.dry = { ox: dry.ox, oy: dry.oy, oz: dry.oz, sx: dry.sx, sy: dry.sy, sz: dry.sz, mask: data };
  }

  // ------------------------------------------------------------------ per frame state

  setEntities(list: readonly EntityRenderState[]): void {
    this.entities?.set(list, this.envTime);
  }

  setCamera(cam: CameraState): void {
    const c = this.camera;
    c.position.set(cam.x, cam.y, cam.z);
    c.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    if (c.fov !== cam.fov) {
      c.fov = cam.fov;
      c.updateProjectionMatrix();
    }
  }

  setEnvironment(env: EnvironmentState): void {
    this.envTime = env.time;
    this.u.time.value = env.time;
    computeSkyState(env.dayTime, this.skyState);
    const dt = env.dayTime - Math.floor(env.dayTime);
    this.u.applySky(this.skyState, dt * Math.PI * 2, SUN_TILT);
    computeFog(env.viewDistance, env.submerged, this.skyState.dayLight, this.fog);
    this.u.applyFog(this.fog);
    if (env.viewDistance !== this.viewDistance) {
      this.viewDistance = env.viewDistance;
      // Fog reaches full strength at 0.98 x viewDistance (radial), so anything beyond the far
      // plane is invisible anyway: fitting far to the view distance lets frustum culling drop
      // fully fogged sections (draw calls are the main CPU cost) and tightens depth precision.
      this.camera.far = Math.max(64, env.viewDistance + 24);
      this.camera.updateProjectionMatrix();
    }
    // The canvas holds sRGB values (see init), so the clear colour is stored pre-encoded.
    const c = this.fog.fixedColor > 0 ? this.fog.color : this.skyState.horizon;
    this.clearColor.setRGB(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b), THREE.LinearSRGBColorSpace);
  }

  setOverlays(o: OverlayState): void {
    this.overlays?.update(o, this.resolveParent, this.topology);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    if (this.renderer) {
      this.renderer.setPixelRatio(pixelRatio);
      this.renderer.setSize(this.width, this.height, false);
    }
  }

  render(): void {
    const r = this.renderer;
    if (!r || !this.ready) return;
    this.assignDrySlots();
    r.setClearColor(this.clearColor, 1);
    r.render(this.scene, this.camera);
  }

  /** Picks the DRY_SLOTS structures nearest to the camera that have a dry volume. */
  private assignDrySlots(): void {
    const ids = this.slotIds;
    const dist = this.slotDist;
    let count = 0;
    const cp = this.camera.position;
    this.structures.forEach((rec, id) => {
      if (!rec.dry || !rec.dryTex || !rec.hasPose) return;
      const c = dryVolumeCenter(rec.pose, rec.dry, this.scratchV);
      const dx = c.x - cp.x;
      const dy = c.y - cp.y;
      const dz = c.z - cp.z;
      const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - dryVolumeRadius(rec.dry));
      // Insertion into the sorted fixed-size list.
      let k = count < DRY_SLOTS ? count++ : DRY_SLOTS;
      if (k === DRY_SLOTS) {
        if (d >= dist[DRY_SLOTS - 1]!) return;
        k = DRY_SLOTS - 1;
      }
      while (k > 0 && dist[k - 1]! > d) {
        dist[k] = dist[k - 1]!;
        ids[k] = ids[k - 1]!;
        k--;
      }
      dist[k] = d;
      ids[k] = id;
    });
    for (let i = 0; i < DRY_SLOTS; i++) {
      const node = this.dryNodes[i];
      if (!node) continue;
      if (i < count) {
        const rec = this.structures.get(ids[i]!)!;
        dryVolumeMatrix(rec.pose, rec.dry!, this.u.dryMatrices[i]!.value.elements);
        if (node.value !== rec.dryTex) node.value = rec.dryTex!;
      } else if (node.value !== this.dryPlaceholders[i]) {
        node.value = this.dryPlaceholders[i]!;
      }
    }
    this.u.dryCount.value = count;
  }

  stats(): RenderStats {
    const info = this.renderer?.info.render;
    return {
      drawCalls: info?.drawCalls ?? 0,
      triangles: info?.triangles ?? 0,
      sections: this.sections.size,
      structures: this.structures.size,
    };
  }

  /** Debug info of the active backend (also returned by init). */
  backendInfo(): BackendInfo {
    return this.info;
  }

  /**
   * Debug counters: render pipelines / shader programs alive in three's caches. Used by the
   * harness to verify the warm-up (no new pipeline when the first water / structure / entity
   * appears) and that steady-state frames never create pipelines.
   */
  debugCounters(): { pipelines: number; programs: number; geometries: number; textures: number } {
    const r = this.renderer as unknown as {
      _pipelines?: { caches?: Map<string, unknown> };
      info: { memory: { programs: number; geometries: number; textures: number } };
    } | null;
    return {
      pipelines: r?._pipelines?.caches?.size ?? 0,
      programs: r?.info.memory.programs ?? 0,
      geometries: r?.info.memory.geometries ?? 0,
      textures: r?.info.memory.textures ?? 0,
    };
  }

  dispose(): void {
    this.ready = false;
    for (const rec of this.sections.values()) for (const m of rec.meshes) if (m) this.disposeMesh(m);
    this.sections.clear();
    for (const rec of this.structures.values()) {
      for (const m of rec.meshes) if (m) this.disposeMesh(m);
      rec.dryTex?.dispose();
      rec.group.removeFromParent();
    }
    this.structures.clear();
    this.entities?.dispose();
    this.entityAssets?.dispose();
    this.overlays?.dispose();
    this.sky?.dispose();
    this.warmup?.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        (o.geometry as THREE.BufferGeometry).dispose();
      }
    });
    this.warmup = null;
    const m = this.materials;
    if (m) {
      m.opaque.dispose();
      m.cutout.dispose();
      m.translucent.dispose();
    }
    this.modelMaterial?.dispose();
    this.tiles?.dispose();
    this.placeholderTiles.dispose();
    for (const t of this.dryPlaceholders) t.dispose();
    this.renderer?.dispose();
    this.renderer = null;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function glRendererName(gl: WebGL2RenderingContext | undefined): string {
  if (!gl) return '';
  const plain = String(gl.getParameter(gl.RENDERER) ?? '');
  // Chrome masks RENDERER; only then ask the debug extension (Firefox warns when it is used).
  if (plain && plain !== 'WebKit WebGL') return plain;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? plain) : plain;
}
