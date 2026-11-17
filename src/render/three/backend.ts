/**
 * three.js implementation of RenderBackend (WebGPURenderer + TSL node materials; falls back
 * to WebGL2 when WebGPU is unavailable or cannot present).
 *
 * Scene layout:
 *   sections   static world section meshes (matrices computed once, never re-traversed)
 *   structures one Group per structure, matrix written from StructurePose each frame
 *   entities   pooled entity views
 *   overlays   world-space overlays, placed at an integer anchor near the camera
 *              (structure-space overlays live under their structure)
 *   sky        far-plane dome drawn after the opaque world
 *
 * Render order: opaque (renderOrder 0, front to back) -> cutout (1) -> sky (50) ->
 * transparent list (water 0, overlays 60+). Every voxel pass culls back faces (mesh
 * contract). Rendering goes straight to the canvas; materials encode sRGB themselves.
 *
 * Precision: the scene is drawn in a floating RENDER SPACE, world minus an integer origin
 * near the camera (a multiple of WAVE_PERIOD, rebased with hysteresis as the camera
 * travels). Every matrix three uploads and every position a shader sees is then small, so
 * nothing cracks, shifts or swims however far the player is from the world origin, at no
 * per-object cost (three's highPrecision would compute a model-view matrix per object per
 * frame on the CPU). Poses, entity states, overlay cells and the camera stay in WORLD space at
 * the API; only the backend knows the origin.
 *
 * Lifecycle: every public method is callable at any time. Before init() resolves, tiles,
 * meshes and dry volumes are queued (last write wins) and applied when the pipelines exist;
 * after dispose() (also while init() is still pending) every call is a no-op and a pending
 * init() rejects. A lost GPU device / context stops rendering and is reported through
 * ThreeBackendOptions.onLost and isLost().
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
import { EntityAssets, EntityLayer, type CarrierQuery } from './entities';
import { computeBoundsFromPositions, setBoxBounds, toBufferGeometry, type GeometryOptions } from './geometry';
import { computeFog, computeSkyState, createFogParams, createSkyState, linearToSrgb, SUN_TILT } from './lighting';
import { createModelMaterial } from './models';
import { OverlayLayer, type OverlayAnchor } from './overlays';
import { dryVolumeCenter, dryVolumeMatrix, dryVolumeRadius, poseToMatrix, transformPoint, worldToLocal } from './pose';
import { createSky, type Sky } from './sky';
import { createVoxelMaterials, DRY_SLOTS, SharedUniforms, type VoxelMaterials } from './shading';
import { prepareTilePixels } from './tiles';
import { animOrigin, WAVE_PERIOD } from './waves';

/** Why the GPU stopped rendering (ThreeBackendOptions.onLost). */
export interface DeviceLostInfo {
  api: 'webgpu' | 'webgl2';
  message: string;
  reason: string | null;
}

export interface ThreeBackendOptions {
  /** Use the WebGL2 backend even when WebGPU is available. */
  forceWebGL?: boolean;
  /** Multisample anti-aliasing (default true). */
  antialias?: boolean;
  /** Passed to the WebGPU adapter request (default 'high-performance'). */
  powerPreference?: GPUPowerPreference;
  /**
   * Before committing the caller's canvas to WebGPU, present two frames on a throw-away
   * canvas and fall back to WebGL2 if the device dies (default true). A canvas that once had
   * a WebGPU context can never get a WebGL2 one, so this is the only point where falling
   * back is still possible; some environments (e.g. headless SwiftShader) hand out an
   * adapter whose device is lost on the first presented frame.
   */
  validateWebGPU?: boolean;
  /**
   * Called once when the GPU device / WebGL context is lost after init. The backend draws
   * nothing from then on; to recover, dispose it and create a new backend on a NEW canvas
   * (forceWebGL: true is the safe choice after a WebGPU loss).
   */
  onLost?: (info: DeviceLostInfo) => void;
}

/** Thrown by init() when dispose() was called before it finished. */
export class BackendDisposedError extends Error {
  constructor() {
    super('ThreeBackend was disposed during init()');
    this.name = 'BackendDisposedError';
  }
}

/** Margin added to section bounds for liquid bobbing / plant sway. */
const ANIM_MARGIN = 0.25;
const GROUPS = ['opaque', 'cutout', 'translucent'] as const;
const ORDER = [0, 1, 0];

/**
 * Upload budget: meshes that were handed over but never drawn (outside the view) are drawn
 * once with frustum culling off, a few per frame, so their GPU buffers and render objects
 * exist before they first come into view. Otherwise turning the camera after loading uploads
 * hundreds of sections inside one frame (tens of ms).
 */
const PRIME_MAX_MESHES = 48;
const PRIME_MAX_VERTICES = 65536;

/** Horizontal / vertical slack of the carrier test around a structure's mesh bounds (blocks). */
const CARRY_PAD_XZ = 0.75;
const CARRY_PAD_BELOW = 0.5;
const CARRY_PAD_ABOVE = 2.5;

interface SectionRecord {
  meshes: [THREE.Mesh | null, THREE.Mesh | null, THREE.Mesh | null];
  /** World position of the section's local origin. */
  ox: number;
  oy: number;
  oz: number;
}

interface StructureRecord {
  id: number;
  group: THREE.Group;
  meshes: [THREE.Mesh | null, THREE.Mesh | null, THREE.Mesh | null];
  /** Per-object light uniform shared by the structure's meshes. */
  light: THREE.Vector4;
  pose: StructurePose;
  hasPose: boolean;
  /** WORLD local->world matrix at the end of the previous rendered frame (carrier motion of entities). */
  prevMatrix: Float64Array;
  hasPrev: boolean;
  /** Local-space bounds of all meshes (minX, minY, minZ, maxX, maxY, maxZ); hasBounds false = none. */
  bounds: Float64Array;
  hasBounds: boolean;
  dryTex: THREE.Data3DTexture | null;
  dry: DryVolume | null;
}

interface PendingMesh {
  ox: number;
  oy: number;
  oz: number;
  mesh: MeshData;
}

/** Per-mesh bookkeeping of the upload primer, kept in Object3D.userData. */
interface MeshUpload {
  /** Light uniform read by the voxel materials (see shading.ts). */
  bl: THREE.Vector4;
  /** The geometry has been drawn at least once (its GPU buffers exist). */
  drawn: boolean;
  /** Geometry that was drawn (a replaced geometry must not be released by mistake). */
  drawnGeo: THREE.BufferGeometry | null;
  queued: boolean;
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
  // Linear: the shader samples each mask layer at its centre (exact in y) and filters only
  // across x / z, which pulls the cut ~0.3 cells into the hull walls (see shading.ts
  // dryVolumeFactor) and removes the z-fight line where the water meets the inner walls.
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

/** Replaces every CPU-side array of an uploaded geometry by an empty one of the same type. */
function releaseGeometryArrays(geo: THREE.BufferGeometry): void {
  // three reads an attribute's array only to create / update its GPU buffer (version change)
  // and for its element type (BYTES_PER_ELEMENT, constructor), which an empty array of the
  // same type preserves. `count` is a plain property fixed at construction and keeps the draw
  // range. Nothing here ever bumps the version again, so the arrays are dead weight.
  const release = (a: THREE.BufferAttribute): void => {
    const arr = a.array as unknown as { length: number; constructor: new (n: number) => THREE.TypedArray };
    if (arr.length > 0) a.array = new arr.constructor(0);
  };
  for (const name in geo.attributes) {
    const a = geo.attributes[name];
    if (a instanceof THREE.BufferAttribute) release(a);
  }
  if (geo.index) release(geo.index);
}

/**
 * Presents two frames with a device of `adapter` on a detached canvas and reports whether the
 * device survived. The probe device is destroyed afterwards.
 */
async function webgpuCanPresent(adapter: GPUAdapter): Promise<boolean> {
  if (typeof document === 'undefined' || !navigator.gpu) return false;
  let device: GPUDevice | null = null;
  let lost = false;
  try {
    device = await adapter.requestDevice();
    const dev = device;
    void dev.lost.then(() => {
      lost = true;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) return false;
    ctx.configure({ device: dev, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    for (let f = 0; f < 2 && !lost; f++) {
      const enc = dev.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.end();
      dev.queue.submit([enc.finish()]);
      await Promise.race([dev.queue.onSubmittedWorkDone(), dev.lost]);
      // Presentation happens at the end of the frame: give it one.
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 16);
      });
    }
    ctx.unconfigure();
    return !lost;
  } catch {
    return false;
  } finally {
    device?.destroy();
  }
}

export class ThreeBackend implements RenderBackend {
  private renderer: THREE.WebGPURenderer | null = null;
  private ready = false;
  private disposed = false;
  private lost = false;
  private initPromise: Promise<BackendInfo> | null = null;
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
    const ud = frame.object?.userData as Partial<MeshUpload> | undefined;
    return ud?.bl ?? this.worldLight;
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
  /** Same records as `structures`, densely packed for allocation-free per-frame loops. */
  private readonly structureList: StructureRecord[] = [];
  /** Bumped when structures appear / disappear (overlay layers re-parent then). */
  private topology = 0;

  // Work handed over before the pipelines exist (applied at the end of init, last write wins).
  private readonly pendingSections = new Map<number, PendingMesh | null>();
  private readonly pendingStructures = new Map<number, PendingMesh | null>();
  private readonly pendingDry = new Map<number, DryVolume | null>();
  /**
   * Poses of structures that have no record (yet) this frame. A record adopts its pose when
   * its mesh arrives later in the same frame; the map is cleared after every render() so a
   * stale pose of a removed structure (or of one that never gets a mesh) never resurrects
   * or leaks anything.
   */
  private readonly pendingPoses = new Map<number, StructurePose>();
  private readonly freePoses: StructurePose[] = [];

  // Upload primer (see PRIME_MAX_MESHES).
  private readonly primeQueue: THREE.Mesh[] = [];
  private primeHead = 0;
  private readonly primed: THREE.Mesh[] = [];
  private readonly primeDeferred: THREE.Mesh[] = [];
  /** Meshes drawn for the first time during the last render() (their CPU arrays get released). */
  private justDrawn: THREE.Mesh[] = [];
  private releasing: THREE.Mesh[] = [];
  private readonly markDrawn: THREE.Object3D['onBeforeRender'];

  private readonly skyState = createSkyState();
  private readonly fog = createFogParams();
  private envTime = 0;
  /** -1 until the first setEnvironment, so the far plane is always fitted once. */
  private viewDistance = -1;
  private readonly clearColor = new THREE.Color(0, 0, 0);
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private readonly anchor: OverlayAnchor = { x: 0, y: 0, z: 0 };
  /** Integer origin of render space (multiple of WAVE_PERIOD); render = world - origin. */
  private readonly origin = { x: 0, y: 0, z: 0 };
  /** Camera position in world space (camera.position is in render space). */
  private readonly camWorld = { x: 0, y: 0, z: 3 };

  // Dry volume slot selection scratch (no allocation per frame).
  /** Indices into structureList of the chosen slots. */
  private readonly slotIds = new Int32Array(DRY_SLOTS);
  private readonly slotDist = new Float64Array(DRY_SLOTS);
  private readonly scratchV = { x: 0, y: 0, z: 0 };
  private readonly scratchL = { x: 0, y: 0, z: 0 };

  private readonly resolveParent = (structureId: number): THREE.Object3D | null => {
    if (structureId === 0) return this.overlayRoot;
    return this.structures.get(structureId)?.group ?? null;
  };

  private readonly carrierQuery: CarrierQuery = {
    selfMotion: (x, y, z, dx, dy, dz, out) => this.selfMotion(x, y, z, dx, dy, dz, out),
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
    const justDrawn = (): THREE.Mesh[] => this.justDrawn;
    // First-draw hook of world / structure meshes: three calls onBeforeRender right before it
    // uploads the geometry for a draw, so a mesh seen here has its GPU buffers after this
    // frame. The hook removes itself (one call per geometry).
    this.markDrawn = function (this: THREE.Object3D): void {
      const mesh = this as THREE.Mesh;
      delete (mesh as Partial<THREE.Object3D>).onBeforeRender;
      const ud = mesh.userData as MeshUpload;
      ud.drawn = true;
      ud.drawnGeo = mesh.geometry;
      justDrawn().push(mesh);
    };
  }

  // ------------------------------------------------------------------ lifecycle

  init(canvas: HTMLCanvasElement): Promise<BackendInfo> {
    if (this.disposed) return Promise.reject(new BackendDisposedError());
    this.initPromise ??= this.initInner(canvas);
    return this.initPromise;
  }

  private async initInner(canvas: HTMLCanvasElement): Promise<BackendInfo> {
    let forceWebGL = this.opts.forceWebGL === true;
    let adapterDetail = '';
    if (!forceWebGL) {
      // Probe first: without an adapter three would log a fallback warning, and once the
      // canvas has a WebGPU context it can never fall back to WebGL2.
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
            if (this.opts.validateWebGPU !== false && !(await webgpuCanPresent(adapter))) {
              console.warn('[render] WebGPU device could not present a frame; using WebGL2');
              forceWebGL = true;
            }
          }
        } catch {
          forceWebGL = true;
        }
      }
      if (this.disposed) throw new BackendDisposedError();
    }

    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: this.opts.antialias ?? true,
      forceWebGL,
      alpha: false,
      powerPreference: this.opts.powerPreference ?? 'high-performance',
    });
    try {
      await renderer.init();
    } catch (e) {
      renderer.dispose();
      throw e;
    }
    if (this.disposed) {
      renderer.dispose();
      throw new BackendDisposedError();
    }
    this.renderer = renderer;
    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.NoToneMapping;
    // Output space == working space: three then renders straight into the canvas with no
    // RGBA16F framebuffer and no conversion pass; the materials encode sRGB themselves
    // (shading.ts encodeOutput). Saves a full-screen pass and lets MSAA resolve to 8-bit.
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    // stats() reports the last render() call, independent of rAF timing.
    renderer.info.autoReset = false;
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setSize(this.width, this.height, false);

    const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; gl?: WebGL2RenderingContext; device?: GPUDevice };
    const isWebGPU = backend.isWebGPUBackend === true;
    this.geoOpts = { padNormals: isWebGPU };
    this.info = { api: isWebGPU ? 'webgpu' : 'webgl2', detail: isWebGPU ? `WebGPU ${adapterDetail}`.trim() : `WebGL2 ${glRendererName(backend.gl)}`.trim() };
    this.hookDeviceLoss(renderer, backend.device ?? null);

    this.buildPipelines();
    await this.compileWarmup();
    if (this.disposed) throw new BackendDisposedError();
    this.ready = true;
    this.flushPending();
    return this.info;
  }

  /**
   * Device / context loss: three's own handler only logs (and ignores a WebGPU loss whose
   * reason is 'destroyed', which is also what a crashed GPU process can report), so the
   * WebGPU device is watched directly as well. A loss after dispose() is our own doing.
   */
  private hookDeviceLoss(renderer: THREE.WebGPURenderer, device: GPUDevice | null): void {
    const api = this.info.api;
    renderer.onDeviceLost = (i: { message?: string; reason?: string | null }) => this.handleLost({ api, message: i.message ?? 'unknown', reason: i.reason ?? null });
    if (device) {
      void device.lost.then((i) => this.handleLost({ api, message: i.message || 'unknown', reason: i.reason ?? null }));
    }
  }

  private handleLost(info: DeviceLostInfo): void {
    if (this.disposed || this.lost) return;
    this.lost = true;
    this.ready = false;
    console.error(`[render] ${info.api} device lost (${info.reason ?? 'no reason'}): ${info.message}`);
    try {
      this.opts.onLost?.(info);
    } catch (e) {
      console.error('[render] onLost handler threw', e);
    }
  }

  /** True once the GPU device / context was lost; the backend then draws nothing. */
  isLost(): boolean {
    return this.lost;
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
    this.entities.group.matrixAutoUpdate = false;
    this.entities.group.matrix.makeTranslation(-this.origin.x, -this.origin.y, -this.origin.z);
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
    if (this.disposed) return;
    await renderer.compileAsync(this.scene, this.camera);
    if (this.disposed) return;
    // One frame while loading: configures the canvas / MSAA targets before the first game frame.
    renderer.render(this.scene, this.camera);
    // Back to the caller's camera (setCamera may have run before init).
    const w = this.camWorld;
    this.camera.position.set(w.x - this.origin.x, w.y - this.origin.y, w.z - this.origin.z);
  }

  /** Applies everything queued before the pipelines existed. */
  private flushPending(): void {
    if (this.pendingTiles) {
      const t = this.pendingTiles;
      this.pendingTiles = null;
      this.setTiles(t);
    }
    for (const [key, p] of this.pendingSections) if (p) this.setSectionMesh(key, p.ox, p.oy, p.oz, p.mesh);
    this.pendingSections.clear();
    for (const [id, p] of this.pendingStructures) if (p) this.setStructureMesh(id, p.ox, p.oy, p.oz, p.mesh);
    this.pendingStructures.clear();
    for (const [id, d] of this.pendingDry) if (d) this.setStructureDryVolume(id, d);
    this.pendingDry.clear();
  }

  setTiles(tiles: TileTextureData): void {
    if (this.disposed) return;
    if (!this.ready) {
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

  /**
   * The backend takes ownership of the MeshData typed arrays (zero copy): the caller must not
   * modify, reuse or transfer them afterwards. They are released (replaced by empty arrays)
   * once the GPU has its copy.
   */
  setSectionMesh(key: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void {
    if (this.disposed) return;
    const empty = !mesh || (!mesh.opaque && !mesh.cutout && !mesh.translucent);
    if (!this.ready) {
      if (empty) this.pendingSections.delete(key);
      else this.pendingSections.set(key, { ox, oy, oz, mesh });
      return;
    }
    const mats = this.materials!;
    let rec = this.sections.get(key);
    if (empty) {
      if (rec) {
        for (const m of rec.meshes) if (m) this.disposeMesh(m);
        this.sections.delete(key);
      }
      return;
    }
    if (!rec) {
      rec = { meshes: [null, null, null], ox, oy, oz };
      this.sections.set(key, rec);
    }
    rec.ox = ox;
    rec.oy = oy;
    rec.oz = oz;
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
        m = this.newMesh(geo, i === 0 ? mats.opaque : i === 1 ? mats.cutout : mats.translucent, this.worldLight);
        m.renderOrder = ORDER[i]!;
        m.matrixAutoUpdate = false;
        // Static: computed once here, skipped by the per-frame scene graph traversal.
        m.matrixWorldAutoUpdate = false;
        this.sectionsRoot.add(m);
        rec.meshes[i] = m;
      }
      this.placeSection(m, rec);
      this.queueUpload(m);
    }
    if (!rec.meshes[0] && !rec.meshes[1] && !rec.meshes[2]) this.sections.delete(key);
  }

  /** Static section matrix in render space (computed here only, never by the scene traversal). */
  private placeSection(m: THREE.Mesh, rec: SectionRecord): void {
    const o = this.origin;
    m.position.set(rec.ox - o.x, rec.oy - o.y, rec.oz - o.z);
    m.updateMatrix();
    m.matrixWorld.copy(m.matrix);
  }

  private newMesh(geo: THREE.BufferGeometry, mat: THREE.Material, light: THREE.Vector4): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    const ud: MeshUpload = { bl: light, drawn: false, drawnGeo: null, queued: false };
    m.userData = ud as unknown as Record<string, unknown>;
    return m;
  }

  /** (Re)arms the first-draw hook of a mesh whose geometry is new and queues it for priming. */
  private queueUpload(m: THREE.Mesh): void {
    const ud = m.userData as MeshUpload;
    ud.drawn = false;
    ud.drawnGeo = null;
    m.onBeforeRender = this.markDrawn;
    if (!ud.queued) {
      ud.queued = true;
      this.primeQueue.push(m);
    }
  }

  private disposeMesh(m: THREE.Mesh): void {
    m.removeFromParent();
    m.geometry.dispose();
  }

  // ------------------------------------------------------------------ structures

  private createStructure(id: number): StructureRecord {
    const group = new THREE.Group();
    group.name = `structure-${id}`;
    group.matrixAutoUpdate = false;
    // Hidden until its first pose: an identity matrix would flash the structure at the origin.
    group.visible = false;
    const rec: StructureRecord = {
      id,
      group,
      meshes: [null, null, null],
      light: new THREE.Vector4(1, 0, 0, 0),
      pose: newPose(),
      hasPose: false,
      prevMatrix: new Float64Array(16),
      hasPrev: false,
      bounds: new Float64Array(6),
      hasBounds: false,
      dryTex: null,
      dry: null,
    };
    this.structures.set(id, rec);
    this.structureList.push(rec);
    this.structuresRoot.add(group);
    this.topology++;
    const pending = this.pendingPoses.get(id);
    if (pending) {
      this.applyPose(rec, pending);
      this.pendingPoses.delete(id);
      this.freePoses.push(pending);
    }
    return rec;
  }

  private removeStructure(rec: StructureRecord): void {
    for (const m of rec.meshes) if (m) this.disposeMesh(m);
    rec.dryTex?.dispose();
    rec.dryTex = null;
    rec.group.removeFromParent();
    this.structures.delete(rec.id);
    const li = this.structureList.indexOf(rec);
    if (li >= 0) this.structureList.splice(li, 1);
    this.topology++;
  }

  /** See setSectionMesh for the ownership of the MeshData arrays. */
  setStructureMesh(id: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void {
    if (this.disposed) return;
    if (!this.ready) {
      if (mesh) this.pendingStructures.set(id, { ox, oy, oz, mesh });
      else {
        this.pendingStructures.delete(id);
        this.pendingDry.delete(id);
      }
      return;
    }
    if (!mesh) {
      const rec = this.structures.get(id);
      if (rec) this.removeStructure(rec);
      const p = this.pendingPoses.get(id);
      if (p) {
        this.pendingPoses.delete(id);
        this.freePoses.push(p);
      }
      return;
    }
    const mats = this.materials!;
    const rec = this.structures.get(id) ?? this.createStructure(id);
    const b = rec.bounds;
    b[0] = b[1] = b[2] = Infinity;
    b[3] = b[4] = b[5] = -Infinity;
    rec.hasBounds = false;
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
        m = this.newMesh(geo, i === 0 ? mats.opaque : i === 1 ? mats.cutout : mats.translucent, rec.light);
        m.renderOrder = ORDER[i]!;
        m.matrixAutoUpdate = false;
        rec.group.add(m);
        rec.meshes[i] = m;
      }
      m.position.set(ox, oy, oz);
      m.updateMatrix();
      m.matrixWorldNeedsUpdate = true;
      const bb = geo.boundingBox!;
      b[0] = Math.min(b[0]!, bb.min.x + ox);
      b[1] = Math.min(b[1]!, bb.min.y + oy);
      b[2] = Math.min(b[2]!, bb.min.z + oz);
      b[3] = Math.max(b[3]!, bb.max.x + ox);
      b[4] = Math.max(b[4]!, bb.max.y + oy);
      b[5] = Math.max(b[5]!, bb.max.z + oz);
      rec.hasBounds = true;
      this.queueUpload(m);
    }
    rec.group.matrixWorldNeedsUpdate = true;
  }

  setStructurePose(id: number, pose: StructurePose): void {
    if (this.disposed) return;
    const rec = this.structures.get(id);
    if (rec) {
      this.applyPose(rec, pose);
      return;
    }
    // No record (yet): keep the pose for the rest of this frame only.
    let p = this.pendingPoses.get(id);
    if (!p) {
      p = this.freePoses.pop() ?? newPose();
      this.pendingPoses.set(id, p);
    }
    copyPose(pose, p);
  }

  private applyPose(rec: StructureRecord, pose: StructurePose): void {
    copyPose(pose, rec.pose);
    rec.hasPose = true;
    rec.group.visible = true;
    this.placeStructure(rec);
    rec.light.set(clamp01(pose.sky / 15), clamp01(pose.block / 15), 0, 0);
  }

  /** Structure group matrix in render space, from its world pose. */
  private placeStructure(rec: StructureRecord): void {
    const e = rec.group.matrix.elements;
    poseToMatrix(rec.pose, e);
    e[12] = e[12]! - this.origin.x;
    e[13] = e[13]! - this.origin.y;
    e[14] = e[14]! - this.origin.z;
    rec.group.matrixWorldNeedsUpdate = true;
  }

  setStructureDryVolume(id: number, dry: DryVolume | null): void {
    if (this.disposed) return;
    const valid = dry !== null && dry.sx > 0 && dry.sy > 0 && dry.sz > 0;
    if (!this.ready) {
      // Copy: the caller may reuse its mask buffer before init finishes.
      this.pendingDry.set(id, valid ? { ...dry, mask: dry.mask.slice() } : null);
      return;
    }
    // A dry volume may arrive before the structure's first mesh (meshing is asynchronous),
    // so it creates the record; only setStructureMesh(id, null) removes it.
    const rec = this.structures.get(id) ?? (valid ? this.createStructure(id) : undefined);
    if (!rec) return;
    if (!valid) {
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
    if (this.disposed) return;
    this.entities?.set(list);
  }

  setCamera(cam: CameraState): void {
    if (this.disposed) return;
    const w = this.camWorld;
    w.x = cam.x;
    w.y = cam.y;
    w.z = cam.z;
    this.updateOrigin();
    const o = this.origin;
    const c = this.camera;
    c.position.set(cam.x - o.x, cam.y - o.y, cam.z - o.z);
    c.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    if (c.fov !== cam.fov) {
      c.fov = cam.fov;
      c.updateProjectionMatrix();
    }
  }

  /**
   * Moves the render-space origin when the camera has travelled far from it. Hysteresis
   * (the camera may roam up to 1.5 periods from the origin) keeps a player walking back and
   * forth across a period boundary from rebasing every few steps; a rebase rewrites every
   * section matrix once (cheap: no GPU upload, matrices are per-object uniforms anyway).
   */
  private updateOrigin(): void {
    const w = this.camWorld;
    const o = this.origin;
    const reach = WAVE_PERIOD * 1.5;
    if (Math.abs(w.x - o.x - WAVE_PERIOD / 2) <= reach && Math.abs(w.y - o.y - WAVE_PERIOD / 2) <= reach && Math.abs(w.z - o.z - WAVE_PERIOD / 2) <= reach) return;
    o.x = animOrigin(w.x);
    o.y = animOrigin(w.y);
    o.z = animOrigin(w.z);
    for (const rec of this.sections.values()) for (const m of rec.meshes) if (m) this.placeSection(m, rec);
    const list = this.structureList;
    for (let i = 0; i < list.length; i++) if (list[i]!.hasPose) this.placeStructure(list[i]!);
    if (this.entities) {
      this.entities.group.matrix.makeTranslation(-o.x, -o.y, -o.z);
      this.entities.group.matrixWorldNeedsUpdate = true;
    }
    this.placeOverlayRoot();
  }

  /** World overlays are written relative to `anchor`; their root sits at anchor - origin. */
  private placeOverlayRoot(): void {
    const a = this.anchor;
    const o = this.origin;
    this.overlayRoot.matrix.makeTranslation(a.x - o.x, a.y - o.y, a.z - o.z);
    this.overlayRoot.matrixWorldNeedsUpdate = true;
  }

  setEnvironment(env: EnvironmentState): void {
    if (this.disposed) return;
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
    if (this.disposed || !this.overlays) return;
    // World overlays are positioned relative to an integer anchor near the camera (exact
    // float32 instance matrices anywhere in the world).
    const p = this.camWorld;
    const a = this.anchor;
    const ax = animOrigin(p.x);
    const ay = animOrigin(p.y);
    const az = animOrigin(p.z);
    if (ax !== a.x || ay !== a.y || az !== a.z) {
      a.x = ax;
      a.y = ay;
      a.z = az;
      this.placeOverlayRoot();
    }
    this.overlays.update(o, this.resolveParent, this.topology, a);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (this.disposed) return;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.pixelRatio = pixelRatio > 0 && Number.isFinite(pixelRatio) ? pixelRatio : 1;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    // Before init the size is stored and applied when the renderer is created.
    if (this.renderer) {
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.setSize(this.width, this.height, false);
    }
  }

  render(): void {
    const r = this.renderer;
    if (!r || !this.ready || this.lost || this.disposed) {
      this.clearPendingPoses();
      return;
    }
    this.entities?.animate(this.envTime, this.carrierQuery);
    this.assignDrySlots();
    this.releaseUploaded();
    this.primeUploads();
    r.setClearColor(this.clearColor, 1);
    r.info.reset();
    r.render(this.scene, this.camera);
    this.lastDrawCalls = r.info.render.drawCalls;
    this.lastTriangles = r.info.render.triangles;
    this.endFrame();
  }

  /** Per-frame bookkeeping after drawing: previous structure poses, per-frame pose cache. */
  private endFrame(): void {
    const list = this.structureList;
    for (let i = 0; i < list.length; i++) {
      const rec = list[i]!;
      if (rec.hasPose) poseToMatrix(rec.pose, rec.prevMatrix);
      rec.hasPrev = rec.hasPose;
    }
    this.clearPendingPoses();
  }

  private clearPendingPoses(): void {
    if (this.pendingPoses.size === 0) return;
    this.pendingPoses.forEach((p) => this.freePoses.push(p));
    this.pendingPoses.clear();
  }

  /** Drops the CPU copies of geometries whose first draw happened in the previous frame. */
  private releaseUploaded(): void {
    const list = this.justDrawn;
    this.justDrawn = this.releasing;
    this.releasing = list;
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!;
      const ud = m.userData as MeshUpload;
      // Skip meshes that were removed or got a new geometry since that draw.
      if (ud.drawn && ud.drawnGeo === m.geometry && m.parent) releaseGeometryArrays(m.geometry);
    }
    list.length = 0;
  }

  /** Lets a budget of never-drawn meshes be drawn this frame regardless of the frustum. */
  private primeUploads(): void {
    const primed = this.primed;
    for (let i = 0; i < primed.length; i++) primed[i]!.frustumCulled = true;
    primed.length = 0;
    const q = this.primeQueue;
    const deferred = this.primeDeferred;
    let vertices = 0;
    while (this.primeHead < q.length && primed.length < PRIME_MAX_MESHES && vertices < PRIME_MAX_VERTICES) {
      const m = q[this.primeHead++]!;
      const ud = m.userData as MeshUpload;
      if (ud.drawn || !m.parent) {
        ud.queued = false;
        continue;
      }
      // A structure still hidden (no pose yet) would not be drawn: try again later.
      if (!m.parent.visible) {
        deferred.push(m);
        continue;
      }
      ud.queued = false;
      m.frustumCulled = false;
      primed.push(m);
      vertices += m.geometry.getAttribute('position').count;
    }
    if (this.primeHead >= q.length) {
      q.length = 0;
      this.primeHead = 0;
    } else if (this.primeHead > 1024 && this.primeHead * 2 > q.length) {
      q.copyWithin(0, this.primeHead);
      q.length -= this.primeHead;
      this.primeHead = 0;
    }
    for (let i = 0; i < deferred.length; i++) q.push(deferred[i]!);
    deferred.length = 0;
  }

  /**
   * CarrierQuery: the displacement of an entity relative to the structure that most
   * plausibly carries it. For every structure whose (padded) bounds contain the entity, the
   * point fixed to the structure that is at the entity now was at prevMatrix * local in the
   * previous frame; the entity's motion relative to that structure is its own displacement
   * minus the point's. The smallest relative motion wins (no carrier included), so an
   * entity standing on a sailing ship or a turntable reads as standing still.
   */
  private selfMotion(x: number, y: number, z: number, dx: number, dy: number, dz: number, out: { x: number; y: number; z: number }): void {
    out.x = dx;
    out.y = dy;
    out.z = dz;
    let best = dx * dx + dy * dy + dz * dz;
    const list = this.structureList;
    for (let i = 0; i < list.length && best > 0; i++) {
      const rec = list[i]!;
      if (!rec.hasPose || !rec.hasPrev || !rec.hasBounds) continue;
      const l = worldToLocal(rec.pose, x, y, z, this.scratchL);
      const b = rec.bounds;
      if (l.x < b[0]! - CARRY_PAD_XZ || l.x > b[3]! + CARRY_PAD_XZ) continue;
      if (l.z < b[2]! - CARRY_PAD_XZ || l.z > b[5]! + CARRY_PAD_XZ) continue;
      if (l.y < b[1]! - CARRY_PAD_BELOW || l.y > b[4]! + CARRY_PAD_ABOVE) continue;
      const prev = transformPoint(rec.prevMatrix, l.x, l.y, l.z, this.scratchV);
      const rx = dx - (x - prev.x);
      const ry = dy - (y - prev.y);
      const rz = dz - (z - prev.z);
      const m = rx * rx + ry * ry + rz * rz;
      if (m < best) {
        best = m;
        out.x = rx;
        out.y = ry;
        out.z = rz;
      }
    }
  }

  /** Picks the DRY_SLOTS structures nearest to the camera that have a dry volume. */
  private assignDrySlots(): void {
    const ids = this.slotIds;
    const dist = this.slotDist;
    let count = 0;
    const cp = this.camWorld;
    const list = this.structureList;
    for (let si = 0; si < list.length; si++) {
      const rec = list[si]!;
      if (!rec.dry || !rec.dryTex || !rec.hasPose) continue;
      const c = dryVolumeCenter(rec.pose, rec.dry, this.scratchV);
      const dx = c.x - cp.x;
      const dy = c.y - cp.y;
      const dz = c.z - cp.z;
      const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - dryVolumeRadius(rec.dry));
      // Insertion into the sorted fixed-size list.
      let k = count < DRY_SLOTS ? count++ : DRY_SLOTS;
      if (k === DRY_SLOTS) {
        if (d >= dist[DRY_SLOTS - 1]!) continue;
        k = DRY_SLOTS - 1;
      }
      while (k > 0 && dist[k - 1]! > d) {
        dist[k] = dist[k - 1]!;
        ids[k] = ids[k - 1]!;
        k--;
      }
      dist[k] = d;
      ids[k] = si;
    }
    const layers = this.u.dryLayers.value;
    for (let i = 0; i < DRY_SLOTS; i++) {
      const node = this.dryNodes[i];
      if (!node) continue;
      if (i < count) {
        const rec = list[ids[i]!]!;
        // Camera-relative: the shader feeds camera-relative positions (precise anywhere).
        dryVolumeMatrix(rec.pose, rec.dry!, this.u.dryMatrices[i]!.value.elements, cp.x, cp.y, cp.z);
        layers.setComponent(i, rec.dry!.sy);
        if (node.value !== rec.dryTex) node.value = rec.dryTex!;
      } else {
        layers.setComponent(i, 1);
        if (node.value !== this.dryPlaceholders[i]) node.value = this.dryPlaceholders[i]!;
      }
    }
    this.u.dryCount.value = count;
  }

  /** Draw calls / triangles of the LAST render() call (not reset by three's rAF loop). */
  stats(): RenderStats {
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      sections: this.sections.size,
      structures: this.structures.size,
    };
  }

  /** Debug info of the active backend (also returned by init). */
  backendInfo(): BackendInfo {
    return this.info;
  }

  /**
   * Debug counters: render pipelines / shader programs alive in three's caches, plus the
   * upload primer's backlog. Used by the harness to verify the warm-up (no new pipeline when
   * the first water / structure / entity appears) and that steady-state frames never create
   * pipelines.
   */
  debugCounters(): { pipelines: number; programs: number; geometries: number; textures: number; uploadBacklog: number } {
    const r = this.renderer as unknown as {
      _pipelines?: { caches?: Map<string, unknown> };
      info: { memory: { programs: number; geometries: number; textures: number } };
    } | null;
    return {
      pipelines: r?._pipelines?.caches?.size ?? 0,
      programs: r?.info.memory.programs ?? 0,
      geometries: r?.info.memory.geometries ?? 0,
      textures: r?.info.memory.textures ?? 0,
      uploadBacklog: this.primeQueue.length - this.primeHead,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.lastDrawCalls = 0;
    this.lastTriangles = 0;
    for (const rec of this.sections.values()) for (const m of rec.meshes) if (m) this.disposeMesh(m);
    this.sections.clear();
    for (const rec of [...this.structureList]) this.removeStructure(rec);
    this.pendingSections.clear();
    this.pendingStructures.clear();
    this.pendingDry.clear();
    this.pendingPoses.clear();
    this.pendingTiles = null;
    this.primeQueue.length = 0;
    this.primeHead = 0;
    this.primed.length = 0;
    this.primeDeferred.length = 0;
    this.justDrawn.length = 0;
    this.releasing.length = 0;
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
