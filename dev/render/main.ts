/**
 * Render harness: drives the three.js backend with synthetic content (see synth.ts).
 *
 * URL parameters:
 *   t=0.3            day time 0..1 (0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight)
 *   view=overview    camera preset: overview | above | waterline | under | hull | hut | mill | entities
 *   cam=x,y,z,yaw,pitch   explicit camera (degrees), overrides view
 *   sub=water|lava|none   submerged state (default: from the camera preset)
 *   webgl=1          force the WebGL2 backend
 *   aa=0             disable MSAA
 *   vd=96            view distance (blocks)
 *   time=12.5        animation clock start (seconds); freeze=1 keeps it fixed (stable screenshots)
 * window.harness exposes the same controls plus stats() for scripted runs.
 */
import { createThreeBackend } from '../../src/render/three/index';
import type { BackendInfo, CameraState, EntityRenderState, EnvironmentState, OverlayState, RenderStats, StructurePose } from '../../src/render/backend';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { qfromAxisAngle, qmul, qrotate, vec3 } from '../../src/core/math';
import { sectionKey } from '../../src/voxel/chunk';
import { buildRotor, buildShip, buildWorld, makeTiles, meshRegion, windmillAnchor, WORLD_X, WORLD_Y, WORLD_Z } from './synth';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = params.get(k);
  return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d;
};

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const backend = createThreeBackend({ forceWebGL: params.get('webgl') === '1', antialias: params.get('aa') !== '0' });

const SHIP = 1;
const ROTOR = 2;
const DEG = Math.PI / 180;

const state = {
  dayTime: num('t', 0.3),
  time: num('time', 8),
  frozen: params.get('freeze') === '1',
  viewDistance: num('vd', 96),
  submerged: (params.get('sub') ?? '') as '' | 'none' | 'water' | 'lava',
  cam: { x: 48, y: 80, z: 110, yaw: 0, pitch: -30 * DEG, fov: 70 } as CameraState,
  frames: 0,
  frameMs: 0,
  info: null as BackendInfo | null,
};

// ---------------------------------------------------------------- world + structures
const world = buildWorld();
const ship = buildShip();
const rotor = buildRotor();
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
  entities: () => ({ cam: lookAt({ x: 26, y: 57, z: 64 }, { x: 31, y: 53, z: 56 }), sub: 'none' }),
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
  { id: 1, kind: 'item', x: 30, y: 0, z: 58, yaw: 0, payload: B.LOG_OAK, flash: 0, sky: 15, block: 0 },
  { id: 2, kind: 'item', x: 31.2, y: 0, z: 58.4, yaw: 0, payload: I.GLUE, flash: 0, sky: 15, block: 0 },
  { id: 3, kind: 'item', x: 29, y: 0, z: 57.5, yaw: 0, payload: B.FLOWER_YELLOW, flash: 0, sky: 15, block: 0 },
  { id: 4, kind: 'falling', x: 33.5, y: 0, z: 55.5, yaw: 0, payload: B.SAND, flash: 0, sky: 15, block: 0 },
  { id: 5, kind: 'tnt', x: 35.5, y: 0, z: 57.5, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 },
  { id: 6, kind: 'rabbit', x: 30, y: 0, z: 54, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 },
  { id: 7, kind: 'player', x: 27.5, y: 0, z: 55, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 },
];

function updateEntities(t: number): void {
  for (const e of entities) {
    if (e.kind === 'rabbit') {
      const a = t * 0.6;
      e.x = 30.5 + Math.cos(a) * 2.2;
      e.z = 54 + Math.sin(a) * 2.2;
      // Motion direction d/da (cos, sin) = (-sin, cos); forward(yaw) = (-sin yaw, -cos yaw).
      e.yaw = Math.atan2(Math.sin(a), -Math.cos(a));
      e.y = groundY(e.x, e.z);
    } else if (e.kind === 'player') {
      const a = t * 0.35;
      e.x = 27.5 + Math.sin(a) * 1.5;
      e.z = 55;
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

const targetCell = { structureId: 0, x: 33, y: 0, z: 59 };
targetCell.y = groundY(33.5, 59.5) - 1;
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
  glue: [
    { structureId: SHIP, x: 2, y: 3, z: 3, face: 2 },
    { structureId: SHIP, x: 3, y: 3, z: 2, face: 2 },
    { structureId: SHIP, x: 0, y: 2, z: 3, face: 1 },
  ],
  glueAnchor: { structureId: SHIP, x: 2, y: 3, z: 3 },
};

// ---------------------------------------------------------------- frame loop
function environment(): EnvironmentState {
  return { dayTime: state.dayTime, submerged: state.submerged === '' ? 'none' : state.submerged, viewDistance: state.viewDistance, time: state.time };
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!state.frozen) state.time += dt;
  const t = state.time;
  backend.setEnvironment(environment());
  backend.setCamera(state.cam);
  backend.setStructurePose(SHIP, shipPose(t));
  backend.setStructurePose(ROTOR, rotorPose(t));
  updateEntities(t);
  backend.setEntities(entities);
  overlays.breakProgress = state.frozen ? 0.45 : (t * 0.25) % 1;
  backend.setOverlays(overlays);
  const t0 = performance.now();
  backend.render();
  state.frameMs = performance.now() - t0;
  state.frames++;
  if (state.frames % 15 === 0) {
    const s = backend.stats();
    hud.textContent = `${state.info?.api ?? '?'} | ${state.info?.detail ?? ''}\ncalls ${s.drawCalls} tris ${s.triangles} sections ${s.sections} structures ${s.structures}\nday ${state.dayTime.toFixed(3)} cpu ${state.frameMs.toFixed(1)} ms`;
  }
  requestAnimationFrame(frame);
}

function resize(): void {
  backend.resize(window.innerWidth, window.innerHeight, Math.min(2, window.devicePixelRatio || 1));
}

async function start(): Promise<BackendInfo> {
  applyView();
  const info = await backend.init(canvas);
  state.info = info;
  resize();
  window.addEventListener('resize', resize);
  backend.setTiles(makeTiles());
  const t0 = performance.now();
  let sections = 0;
  for (let sy = 0; sy < WORLD_Y / 16; sy++) {
    for (let sz = 0; sz < WORLD_Z / 16; sz++) {
      for (let sx = 0; sx < WORLD_X / 16; sx++) {
        const mesh = meshRegion({ box: world, x0: sx * 16, y0: sy * 16, z0: sz * 16, sx: 16, sy: 16, sz: 16, lit: true });
        if (!mesh.opaque && !mesh.cutout && !mesh.translucent) continue;
        backend.setSectionMesh(sectionKey(sx, sy, sz), sx * 16, sy * 16, sz * 16, mesh);
        sections++;
      }
    }
  }
  backend.setStructureMesh(SHIP, ship.ox, ship.oy, ship.oz, ship.mesh);
  backend.setStructurePose(SHIP, shipPose(state.time));
  backend.setStructureDryVolume(SHIP, ship.dry);
  backend.setStructureMesh(ROTOR, rotor.ox, rotor.oy, rotor.oz, rotor.mesh);
  backend.setStructurePose(ROTOR, rotorPose(state.time));
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
  /** Removes / restores every structure (exercises structure teardown). */
  toggleStructures(on: boolean): void;
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
  toggleStructures: (on) => {
    if (on) {
      backend.setStructureMesh(SHIP, ship.ox, ship.oy, ship.oz, ship.mesh);
      backend.setStructurePose(SHIP, shipPose(state.time));
      backend.setStructureDryVolume(SHIP, ship.dry);
      backend.setStructureMesh(ROTOR, rotor.ox, rotor.oy, rotor.oz, rotor.mesh);
    } else {
      backend.setStructureMesh(SHIP, 0, 0, 0, null);
      backend.setStructureMesh(ROTOR, 0, 0, 0, null);
    }
  },
};
(window as unknown as { harness: Harness }).harness = harness;
harness.ready.catch((e: unknown) => {
  console.error('[harness] init failed', e);
});
