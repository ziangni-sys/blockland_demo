/**
 * Render harness: drives the three.js backend with synthetic content (see synth.ts).
 *
 * URL parameters:
 *   t=0.3            day time 0..1 (0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight)
 *   view=overview    camera preset: overview | above | waterline | under | hull | hut | mill | entities |
 *                    closeup | rabbit | deck | anchor | glue | gluetop | hold | holdeye | raft | ice
 *   cam=x,y,z,yaw,pitch   explicit camera (degrees), overrides view
 *   sub=water|lava|none   submerged state (default: from the camera preset)
 *   webgl=1          force the WebGL2 backend
 *   aa=0             disable MSAA
 *   validate=0       skip the WebGPU presentation check (to exercise device-loss handling)
 *   vd=96            view distance (blocks)
 *   time=12.5        animation clock start (seconds); freeze=1 keeps it fixed (stable screenshots)
 *   stress=4         replicate the world's sections on a 4 x 4 grid (performance testing)
 *   origin=1048576   shift the whole scene by (origin, 0, origin) blocks (float precision far
 *                    from the world origin; must be a multiple of 16)
 * window.harness exposes the same controls plus stats() for scripted runs.
 */
import { createThreeBackend } from '../../src/render/three/index';
import type { ThreeBackend } from '../../src/render/three/backend';
import type { BackendInfo, CameraState, EntityRenderState, EnvironmentState, OverlayCell, OverlayState, RenderStats, StructurePose } from '../../src/render/backend';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { qfromAxisAngle, qmul, qrotate, vec3 } from '../../src/core/math';
import { sectionKey } from '../../src/voxel/chunk';
import { buildRaft, buildRotor, buildShip, buildWorld, makeTiles, meshRegion, windmillAnchor, WORLD_X, WORLD_Y, WORLD_Z } from './synth';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = params.get(k);
  return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d;
};

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const backend = createThreeBackend({
  forceWebGL: params.get('webgl') === '1',
  antialias: params.get('aa') !== '0',
  validateWebGPU: params.get('validate') !== '0',
  onLost: (info) => {
    state.lost = `${info.api}: ${info.reason ?? ''} ${info.message}`;
  },
});

const SHIP = 1;
const ROTOR = 2;
const RAFT = 3;
const DEG = Math.PI / 180;
/** Scene offset in x and z (blocks, multiple of 16). */
const ORIGIN = Math.round(num('origin', 0) / 16) * 16;

const state = {
  dayTime: num('t', 0.3),
  time: num('time', 8),
  frozen: params.get('freeze') === '1',
  viewDistance: num('vd', 96),
  submerged: (params.get('sub') ?? '') as '' | 'none' | 'water' | 'lava',
  cam: { x: 48, y: 80, z: 110, yaw: 0, pitch: -30 * DEG, fov: 70 } as CameraState,
  frames: 0,
  frameMs: 0,
  /** Mean CPU time of backend.render() over the last 120 frames. */
  avgMs: 0,
  info: null as BackendInfo | null,
  /** Set when the backend reports a lost device. */
  lost: '',
};

// ---------------------------------------------------------------- world + structures
const world = buildWorld();
const ship = buildShip();
const rotor = buildRotor();
const raft = buildRaft();
const anchor = windmillAnchor(world);

function shipPose(t: number): StructurePose {
  const yaw = qfromAxisAngle(vec3(0, 1, 0), 25 * DEG + Math.sin(t * 0.2) * 2 * DEG);
  const roll = qfromAxisAngle(vec3(1, 0, 0), (3 + Math.sin(t * 0.9) * 1.5) * DEG);
  const q = qmul(yaw, roll);
  return { px: 47, py: 47.45 + Math.sin(t * 1.1) * 0.04, pz: 54, qx: q.x, qy: q.y, qz: q.z, qw: q.w, pivotX: ship.pivot[0], pivotY: ship.pivot[1], pivotZ: ship.pivot[2], sky: 15, block: 0 };
}

function rotorPose(t: number): StructurePose {
  const q = qfromAxisAngle(vec3(0, 0, 1), t * 0.9);
  return { px: anchor.x + 0.5, py: anchor.y + 0.5, pz: anchor.z + 0.5, qx: q.x, qy: q.y, qz: q.z, qw: q.w, pivotX: rotor.pivot[0], pivotY: rotor.pivot[1], pivotZ: rotor.pivot[2], sky: 15, block: 0 };
}

/**
 * The raft floats with its floor top at world 47.7, 0.1-0.19 below the (bobbing) water
 * surface: the band where small boats float and where the dry cut used to leak at the inner
 * corners of the hold.
 */
function raftPose(t: number): StructurePose {
  const q = qfromAxisAngle(vec3(0, 1, 0), 12 * DEG + Math.sin(t * 0.15) * DEG);
  return { px: 56, py: 46.7, pz: 41, qx: q.x, qy: q.y, qz: q.z, qw: q.w, pivotX: raft.pivot[0], pivotY: raft.pivot[1], pivotZ: raft.pivot[2], sky: 15, block: 0 };
}

/** Raft-local point -> world. */
function raftToWorld(x: number, y: number, z: number, t: number): { x: number; y: number; z: number } {
  const p = raftPose(t);
  const r = qrotate({ x: p.qx, y: p.qy, z: p.qz, w: p.qw }, vec3(x - p.pivotX, y - p.pivotY, z - p.pivotZ));
  return { x: r.x + p.px, y: r.y + p.py, z: r.z + p.pz };
}

/** Ship-local point -> world (for camera presets inside the hull). */
function shipToWorld(x: number, y: number, z: number, t: number): { x: number; y: number; z: number } {
  const p = shipPose(t);
  const r = qrotate({ x: p.qx, y: p.qy, z: p.qz, w: p.qw }, vec3(x - p.pivotX, y - p.pivotY, z - p.pivotZ));
  return { x: r.x + p.px, y: r.y + p.py, z: r.z + p.pz };
}

function lookAt(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): CameraState {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { x: from.x, y: from.y, z: from.z, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), fov: 70 };
}

const PRESETS: Record<string, () => { cam: CameraState; sub: 'none' | 'water' | 'lava' }> = {
  overview: () => ({ cam: lookAt({ x: 48, y: 78, z: 112 }, { x: 48, y: 50, z: 52 }), sub: 'none' }),
  above: () => ({ cam: lookAt({ x: 40, y: 64, z: 72 }, { x: 47, y: 48, z: 54 }), sub: 'none' }),
  waterline: () => ({ cam: lookAt({ x: 36, y: 48.25, z: 66 }, { x: 47, y: 48.5, z: 54 }), sub: 'none' }),
  under: () => ({ cam: lookAt({ x: 40, y: 44.5, z: 62 }, { x: 47, y: 47, z: 54 }), sub: 'water' }),
  hull: () => {
    const t = state.time;
    return { cam: lookAt(shipToWorld(2.5, 2.6, 3.5, t), shipToWorld(10, 1.6, 3.5, t)), sub: 'none' };
  },
  hut: () => ({ cam: lookAt({ x: 72.5, y: 58, z: 30 }, { x: 72.5, y: 54, z: 42 }), sub: 'none' }),
  mill: () => ({ cam: lookAt({ x: 31, y: 62, z: 52 }, { x: 30.5, y: 62, z: 33 }), sub: 'none' }),
  entities: () => ({ cam: lookAt({ x: 19, y: 55.5, z: 47.5 }, { x: 18.5, y: 52, z: 38.5 }), sub: 'none' }),
  closeup: () => {
    const c = { x: 18.5, y: groundY(18.5, 39.5), z: 39.5 };
    return { cam: lookAt({ x: c.x + 1.2, y: c.y + 2.4, z: c.z + 5.2 }, { x: c.x, y: c.y + 0.3, z: c.z - 0.5 }), sub: 'none' };
  },
  rabbit: () => {
    const r = entities.find((e) => e.kind === 'rabbit')!;
    updateEntities(state.time);
    return { cam: lookAt({ x: r.x + 1.3, y: r.y + 0.9, z: r.z + 1.3 }, { x: r.x, y: r.y + 0.25, z: r.z }), sub: 'none' };
  },
  anchor: () => {
    const t = state.time;
    return { cam: lookAt(shipToWorld(0.2, 5.6, 5.8, t), shipToWorld(2.5, 3.8, 3.2, t)), sub: 'none' };
  },
  deck: () => {
    const t = state.time;
    return { cam: lookAt(shipToWorld(-1.5, 7, 6.5, t), shipToWorld(4, 3, 3, t)), sub: 'none' };
  },
  glue: () => {
    const t = state.time;
    return { cam: lookAt(shipToWorld(3, 6.2, -2.6, t), shipToWorld(4.2, 2.2, 1.6, t)), sub: 'none' };
  },
  gluetop: () => {
    const t = state.time;
    return { cam: lookAt(shipToWorld(1.2, 6.6, 5.4, t), shipToWorld(3, 4, 3, t)), sub: 'none' };
  },
  hold: () => {
    const t = state.time;
    const c = raftToWorld(3.5, 1, 2.5, t);
    return { cam: { x: c.x, y: c.y + 5, z: c.z, yaw: 12 * DEG, pitch: -89.9 * DEG, fov: 70 }, sub: 'none' };
  },
  holdeye: () => {
    const t = state.time;
    return { cam: lookAt(raftToWorld(1.6, 2.62, 1.6, t), raftToWorld(5.4, 1, 3.4, t)), sub: 'none' };
  },
  raft: () => {
    const t = state.time;
    return { cam: lookAt(raftToWorld(-4, 5, -5, t), raftToWorld(3.5, 1, 2.5, t)), sub: 'none' };
  },
  ice: () => ({ cam: lookAt({ x: 31, y: 50.2, z: 68 }, { x: 36, y: 47.9, z: 60 }), sub: 'none' }),
};

function applyView(): void {
  const camParam = params.get('cam');
  const preset = PRESETS[params.get('view') ?? 'overview'] ?? PRESETS.overview!;
  const p = preset();
  if (camParam) {
    const [x, y, z, yaw, pitch] = camParam.split(',').map(Number);
    state.cam = { x: x!, y: y!, z: z!, yaw: (yaw ?? 0) * DEG, pitch: (pitch ?? 0) * DEG, fov: 70 };
  } else {
    state.cam = p.cam;
  }
  if (state.submerged === '') state.submerged = p.sub;
}

// ---------------------------------------------------------------- entities & overlays
const groundY = (x: number, z: number): number => {
  for (let y = WORLD_Y - 1; y > 0; y--) {
    const id = world.get(Math.floor(x), y, Math.floor(z));
    if (id !== B.AIR && id !== B.TALL_GRASS && id !== B.FLOWER_RED && id !== B.FLOWER_YELLOW) return y + 1;
  }
  return 0;
};

const entities: EntityRenderState[] = [
  { id: 1, kind: 'item', x: 17.5, y: 0, z: 40.5, yaw: 0, payload: B.LOG_OAK, flash: 0, sky: 15, block: 0 },
  { id: 2, kind: 'item', x: 18.6, y: 0, z: 40.8, yaw: 0, payload: I.GLUE, flash: 0, sky: 15, block: 0 },
  { id: 3, kind: 'item', x: 16.4, y: 0, z: 40.2, yaw: 0, payload: B.FLOWER_YELLOW, flash: 0, sky: 15, block: 0 },
  { id: 4, kind: 'falling', x: 21.5, y: 0, z: 38.5, yaw: 0, payload: B.SAND, flash: 0, sky: 15, block: 0 },
  { id: 5, kind: 'tnt', x: 23.5, y: 0, z: 41.5, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 },
  { id: 6, kind: 'rabbit', x: 18, y: 0, z: 37, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 },
  { id: 7, kind: 'player', x: 14.5, y: 0, z: 38, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 },
];

function updateEntities(t: number): void {
  for (const e of entities) {
    if (e.kind === 'rabbit') {
      const a = t * 0.6;
      e.x = 18.5 + Math.cos(a) * 2.2;
      e.z = 36.5 + Math.sin(a) * 2.2;
      // Motion direction d/da (cos, sin) = (-sin, cos); forward(yaw) = (-sin yaw, -cos yaw).
      e.yaw = Math.atan2(Math.sin(a), -Math.cos(a));
      e.y = groundY(e.x, e.z);
    } else if (e.kind === 'player') {
      const a = t * 0.35;
      e.x = 14.5 + Math.sin(a) * 1.5;
      e.z = 38;
      e.yaw = Math.cos(a) >= 0 ? -Math.PI / 2 : Math.PI / 2;
      e.y = groundY(e.x, e.z);
    } else if (e.kind === 'falling') {
      const g = groundY(e.x, e.z);
      const ph = (t * 0.5) % 1;
      e.y = g + 6 - ph * ph * 6;
    } else if (e.kind === 'tnt') {
      e.y = groundY(e.x, e.z);
      e.flash = Math.max(0, Math.sin(t * 6)) ** 4;
    } else {
      e.y = groundY(e.x, e.z);
    }
  }
}

const targetCell = { structureId: 0, x: 20, y: 0, z: 42 };
targetCell.y = groundY(20.5, 42.5) - 1;
const overlays: OverlayState = {
  target: targetCell,
  breakProgress: 0.45,
  preview: [
    { structureId: 0, x: 30, y: anchor.y - 1, z: 30 },
    { structureId: 0, x: 31, y: anchor.y - 1, z: 30 },
    { structureId: 0, x: 30, y: anchor.y - 1, z: 31 },
    { structureId: 0, x: 31, y: anchor.y - 1, z: 31 },
  ],
  conflicts: [
    { structureId: SHIP, x: 12, y: 1, z: 3 },
    { structureId: SHIP, x: 12, y: 2, z: 3 },
  ],
  // Real glue, as the client sends it: the smaller cell of two adjacent BLOCKS plus the
  // positive face along the glue axis (both sides are always occupied).
  glue: [
    { structureId: SHIP, x: 2, y: 3, z: 3, face: 0 }, // deck plank | deck plank (x)
    { structureId: SHIP, x: 3, y: 3, z: 2, face: 4 }, // deck plank | deck plank (z)
    { structureId: SHIP, x: 4, y: 0, z: 0, face: 2 }, // floor | wall (y)
    { structureId: SHIP, x: 6, y: 1, z: 0, face: 2 }, // wall | wall (y)
    { structureId: SHIP, x: 7, y: 2, z: 0, face: 0 }, // wall | wall (x)
  ],
  glueAnchor: { structureId: SHIP, x: 2, y: 3, z: 3 },
};

// ---------------------------------------------------------------- frame loop
function environment(): EnvironmentState {
  return { dayTime: state.dayTime, submerged: state.submerged === '' ? 'none' : state.submerged, viewDistance: state.viewDistance, time: state.time };
}

const msRing = new Float64Array(120);
let stopped = false;
let last = performance.now();

// ---- scene offset (origin=...): everything handed to the backend is shifted in x / z.
const shiftedCam: CameraState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fov: 70 };
function camAt(c: CameraState): CameraState {
  shiftedCam.x = c.x + ORIGIN;
  shiftedCam.y = c.y;
  shiftedCam.z = c.z + ORIGIN;
  shiftedCam.yaw = c.yaw;
  shiftedCam.pitch = c.pitch;
  shiftedCam.fov = c.fov;
  return shiftedCam;
}
function poseAt(p: StructurePose): StructurePose {
  p.px += ORIGIN;
  p.pz += ORIGIN;
  return p;
}
const shiftedEntities: EntityRenderState[] = entities.map((e) => ({ ...e }));
function entitiesAt(): EntityRenderState[] {
  for (let i = 0; i < entities.length; i++) {
    Object.assign(shiftedEntities[i]!, entities[i]!);
    shiftedEntities[i]!.x += ORIGIN;
    shiftedEntities[i]!.z += ORIGIN;
  }
  return shiftedEntities;
}
function shiftCell<T extends OverlayCell>(c: T): T {
  return c.structureId === 0 ? { ...c, x: c.x + ORIGIN, z: c.z + ORIGIN } : c;
}
const shiftedOverlays: OverlayState = {
  ...overlays,
  target: overlays.target && shiftCell(overlays.target),
  preview: overlays.preview.map(shiftCell),
  conflicts: overlays.conflicts.map(shiftCell),
  glue: overlays.glue.map(shiftCell),
  glueAnchor: overlays.glueAnchor && shiftCell(overlays.glueAnchor),
};

function frame(now: number): void {
  if (stopped) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!state.frozen) state.time += dt;
  const t = state.time;
  backend.setEnvironment(environment());
  backend.setCamera(camAt(state.cam));
  backend.setStructurePose(SHIP, poseAt(shipPose(t)));
  backend.setStructurePose(ROTOR, poseAt(rotorPose(t)));
  backend.setStructurePose(RAFT, poseAt(raftPose(t)));
  updateEntities(t);
  backend.setEntities(entitiesAt());
  shiftedOverlays.breakProgress = state.frozen ? 0.45 : (t * 0.25) % 1;
  backend.setOverlays(shiftedOverlays);
  const t0 = performance.now();
  backend.render();
  state.frameMs = performance.now() - t0;
  msRing[state.frames % msRing.length] = state.frameMs;
  state.frames++;
  if (state.frames >= msRing.length) {
    let sum = 0;
    for (let i = 0; i < msRing.length; i++) sum += msRing[i]!;
    state.avgMs = sum / msRing.length;
  }
  if (state.frames % 15 === 0) {
    const s = backend.stats();
    hud.textContent = `${state.info?.api ?? '?'} | ${state.info?.detail ?? ''}\ncalls ${s.drawCalls} tris ${s.triangles} sections ${s.sections} structures ${s.structures}\nday ${state.dayTime.toFixed(3)} cpu ${state.frameMs.toFixed(1)} ms`;
  }
  requestAnimationFrame(frame);
}

function resize(): void {
  backend.resize(window.innerWidth, window.innerHeight, Math.min(2, window.devicePixelRatio || 1));
}

function addStructures(): void {
  backend.setStructureMesh(SHIP, ship.ox, ship.oy, ship.oz, ship.mesh);
  backend.setStructurePose(SHIP, poseAt(shipPose(state.time)));
  backend.setStructureDryVolume(SHIP, ship.dry);
  backend.setStructureMesh(ROTOR, rotor.ox, rotor.oy, rotor.oz, rotor.mesh);
  backend.setStructurePose(ROTOR, poseAt(rotorPose(state.time)));
  backend.setStructureMesh(RAFT, raft.ox, raft.oy, raft.oz, raft.mesh);
  backend.setStructurePose(RAFT, poseAt(raftPose(state.time)));
  backend.setStructureDryVolume(RAFT, raft.dry);
}

async function start(): Promise<BackendInfo> {
  applyView();
  // Sized, textured and filled BEFORE init resolves: the backend applies the size when the
  // renderer exists and queues tiles / meshes until its pipelines are built.
  resize();
  window.addEventListener('resize', resize);
  const initDone = backend.init(canvas);
  backend.setTiles(makeTiles());
  const t0 = performance.now();
  let sections = 0;
  const stress = Math.max(1, Math.floor(num('stress', 1)));
  const half = Math.floor(stress / 2);
  const oc = ORIGIN / 16;
  for (let sy = 0; sy < WORLD_Y / 16; sy++) {
    for (let sz = 0; sz < WORLD_Z / 16; sz++) {
      for (let sx = 0; sx < WORLD_X / 16; sx++) {
        const mesh = meshRegion({ box: world, x0: sx * 16, y0: sy * 16, z0: sz * 16, sx: 16, sy: 16, sz: 16, lit: true });
        if (!mesh.opaque && !mesh.cutout && !mesh.translucent) continue;
        // Stress mode: the same section meshes repeated on a grid of world copies. The backend
        // takes ownership of MeshData arrays but only ever reads them, so read-only sharing
        // between sections is fine here.
        for (let gz = -half; gz < stress - half; gz++) {
          for (let gx = -half; gx < stress - half; gx++) {
            const cx = sx + gx * (WORLD_X / 16) + oc;
            const cz = sz + gz * (WORLD_Z / 16) + oc;
            backend.setSectionMesh(sectionKey(cx, sy, cz), cx * 16, sy * 16, cz * 16, mesh);
            sections++;
          }
        }
      }
    }
  }
  addStructures();
  const info = await initDone;
  state.info = info;
  console.info(`[harness] ${info.api} (${info.detail}); ${sections} sections meshed in ${(performance.now() - t0).toFixed(0)} ms`);
  requestAnimationFrame(frame);
  return info;
}

interface Harness {
  ready: Promise<BackendInfo>;
  state: typeof state;
  setDayTime(t: number): void;
  setView(name: string): void;
  setCamera(x: number, y: number, z: number, yawDeg: number, pitchDeg: number): void;
  setSubmerged(s: 'none' | 'water' | 'lava'): void;
  setTime(t: number, frozen?: boolean): void;
  stats(): RenderStats & { frames: number; frameMs: number };
  counters(): ReturnType<ThreeBackend['debugCounters']>;
  /** Removes / restores every structure (exercises structure teardown). */
  toggleStructures(on: boolean): void;
  /** Stops the loop and releases every GPU resource. */
  dispose(): void;
}

const harness: Harness = {
  ready: start(),
  state,
  setDayTime: (t) => {
    state.dayTime = t;
  },
  setView: (name) => {
    const p = (PRESETS[name] ?? PRESETS.overview!)();
    state.cam = p.cam;
    state.submerged = p.sub;
  },
  setCamera: (x, y, z, yawDeg, pitchDeg) => {
    state.cam = { x, y, z, yaw: yawDeg * DEG, pitch: pitchDeg * DEG, fov: 70 };
  },
  setSubmerged: (s) => {
    state.submerged = s;
  },
  setTime: (t, frozen) => {
    state.time = t;
    if (frozen !== undefined) state.frozen = frozen;
  },
  stats: () => ({ ...backend.stats(), frames: state.frames, frameMs: state.frameMs }),
  counters: () => (backend as ThreeBackend).debugCounters(),
  dispose: () => {
    stopped = true;
    backend.dispose();
  },
  toggleStructures: (on) => {
    if (on) {
      addStructures();
    } else {
      backend.setStructureMesh(SHIP, 0, 0, 0, null);
      backend.setStructureMesh(ROTOR, 0, 0, 0, null);
      backend.setStructureMesh(RAFT, 0, 0, 0, null);
    }
  },
};
(window as unknown as { harness: Harness }).harness = harness;
harness.ready.catch((e: unknown) => {
  console.error('[harness] init failed', e);
});
