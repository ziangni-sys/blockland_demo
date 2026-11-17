/**
 * CPU-side bookkeeping of the three.js backend, without a GPU: the backend is constructed in
 * Node and put in the state init() leaves it in (pipelines built, ready) by calling its
 * private setup steps. GPU-level behaviour (resize before init on a real canvas, dispose
 * during init, device loss, stats timing) is verified in the browser harness.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { BackendDisposedError, ThreeBackend } from '../../src/render/three/backend';
import type { DryVolume, StructurePose } from '../../src/render/backend';
import type { GeometryData, MeshData } from '../../src/mesh/types';
import { qfromAxisAngle, vec3 } from '../../src/core/math';

interface Internals {
  buildPipelines(): void;
  flushPending(): void;
  ready: boolean;
  width: number;
  height: number;
  pixelRatio: number;
  structures: Map<number, { group: THREE.Group; prevMatrix: Float64Array; hasPrev: boolean; hasPose: boolean }>;
  structureList: { group: THREE.Group; prevMatrix: Float64Array; hasPrev: boolean; hasPose: boolean }[];
  pendingPoses: Map<number, StructurePose>;
  selfMotion(x: number, y: number, z: number, dx: number, dy: number, dz: number, out: { x: number; y: number; z: number }): void;
  endFrame(): void;
  primeUploads(): void;
  releaseUploaded(): void;
  origin: { x: number; y: number; z: number };
  sections: Map<number, { meshes: (THREE.Mesh | null)[] }>;
  entities: { group: THREE.Group };
  overlayRoot: THREE.Group;
  assignDrySlots(): void;
  camera: THREE.PerspectiveCamera;
  u: { dryLayers: { value: THREE.Vector4 }; dryCount: { value: number }; dryMatrices: { value: THREE.Matrix4 }[] };
}
const internals = (be: ThreeBackend): Internals => be as unknown as Internals;

/** What init() does once its renderer exists (no GPU needed for these steps). */
function finishInit(be: ThreeBackend): void {
  const i = internals(be);
  i.buildPipelines();
  i.ready = true;
  i.flushPending();
}
function readyBackend(): ThreeBackend {
  const be = new ThreeBackend({ forceWebGL: true });
  finishInit(be);
  return be;
}

/** End-of-frame bookkeeping of render() (its renderer-free part). */
function endFrame(be: ThreeBackend): void {
  internals(be).endFrame();
}

function quad(y = 1): GeometryData {
  return {
    vertexCount: 4,
    indexCount: 6,
    positions: new Float32Array([0, y, 0, 1, y, 0, 1, y, 1, 0, y, 1]),
    normals: new Int8Array([0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 127, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    layers: new Uint16Array(4),
    light: new Uint8Array(16).fill(255),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}
const mesh = (): MeshData => ({ opaque: quad(), cutout: null, translucent: null });

function pose(px: number, py: number, pz: number, yaw = 0, pivot: [number, number, number] = [0, 0, 0]): StructurePose {
  const q = qfromAxisAngle(vec3(0, 1, 0), yaw);
  return { px, py, pz, qx: q.x, qy: q.y, qz: q.z, qw: q.w, pivotX: pivot[0], pivotY: pivot[1], pivotZ: pivot[2], sky: 15, block: 0 };
}

describe('lifecycle', () => {
  it('meshes, structures and dry volumes handed over before init are applied when it finishes', () => {
    const be = new ThreeBackend({ forceWebGL: true });
    be.setSectionMesh(1, 0, 0, 0, mesh());
    be.setSectionMesh(2, 16, 0, 0, mesh());
    be.setSectionMesh(2, 16, 0, 0, null); // removed again before init: last write wins
    be.setStructureMesh(7, 0, 0, 0, mesh());
    const dry: DryVolume = { ox: 0, oy: 0, oz: 0, sx: 1, sy: 1, sz: 1, mask: new Uint8Array([1]) };
    be.setStructureDryVolume(7, dry);
    dry.mask[0] = 0; // the caller reuses its buffer: the queued copy must not change
    expect(be.stats().sections).toBe(0);
    finishInit(be);
    expect(be.stats().sections).toBe(1);
    expect(be.stats().structures).toBe(1);
    const rec = (be as unknown as { structures: Map<number, { dry: DryVolume | null }> }).structures.get(7)!;
    expect(rec.dry?.mask[0]).toBe(255);
  });

  it('resize() before init is remembered for the renderer', () => {
    const be = new ThreeBackend({ forceWebGL: true });
    be.resize(960.7, 600.2, 2);
    const i = internals(be);
    expect([i.width, i.height, i.pixelRatio]).toEqual([960, 600, 2]);
    expect(i.camera.aspect).toBeCloseTo(960 / 600, 9);
  });

  it('after dispose() every call is a no-op and init() rejects', async () => {
    const be = readyBackend();
    be.setSectionMesh(1, 0, 0, 0, mesh());
    be.dispose();
    expect(be.stats().sections).toBe(0);
    be.setSectionMesh(2, 0, 0, 0, mesh());
    be.setStructureMesh(9, 0, 0, 0, mesh());
    be.setStructurePose(9, pose(0, 0, 0));
    be.setStructureDryVolume(9, { ox: 0, oy: 0, oz: 0, sx: 1, sy: 1, sz: 1, mask: new Uint8Array([1]) });
    be.setEntities([{ id: 1, kind: 'rabbit', x: 0, y: 0, z: 0, yaw: 0, payload: 0, flash: 0, sky: 15, block: 0 }]);
    be.setOverlays({ target: { structureId: 0, x: 0, y: 0, z: 0 }, breakProgress: 0.5, preview: [], conflicts: [], glue: [] });
    be.render();
    be.dispose(); // twice is fine
    expect(be.stats()).toEqual({ drawCalls: 0, triangles: 0, sections: 0, structures: 0 });
    await expect(be.init({} as HTMLCanvasElement)).rejects.toBeInstanceOf(BackendDisposedError);
  });
});

describe('structure records', () => {
  it('a pose sent before the mesh of the same frame is adopted; stale poses never create records', () => {
    const be = readyBackend();
    be.setStructurePose(3, pose(10, 50, 10));
    expect(be.stats().structures).toBe(0);
    be.setStructureMesh(3, 0, 0, 0, mesh());
    const g = internals(be).structures.get(3)!.group;
    expect(g.visible).toBe(true);
    expect(g.matrix.elements[12]).toBe(10);
    // Removed, then a stale pose in the same frame, then the frame ends.
    be.setStructureMesh(3, 0, 0, 0, null);
    be.setStructurePose(3, pose(11, 50, 10));
    for (let id = 100; id < 200; id++) be.setStructurePose(id, pose(0, 0, 0));
    endFrame(be);
    expect(be.stats().structures).toBe(0);
    expect(internals(be).pendingPoses.size).toBe(0);
    // A mesh arriving in a later frame (no pose yet) stays hidden until its pose comes.
    be.setStructureMesh(3, 0, 0, 0, mesh());
    expect(internals(be).structures.get(3)!.group.visible).toBe(false);
    be.setStructurePose(3, pose(12, 50, 10));
    expect(internals(be).structures.get(3)!.group.visible).toBe(true);
  });

  it('a dry volume may arrive before the first mesh and survives until the structure is removed', () => {
    const be = readyBackend();
    be.setStructureDryVolume(4, { ox: 0, oy: 0, oz: 0, sx: 2, sy: 1, sz: 1, mask: new Uint8Array([1, 0]) });
    expect(be.stats().structures).toBe(1);
    be.setStructureMesh(4, 0, 0, 0, mesh());
    expect(be.stats().structures).toBe(1);
    be.setStructureMesh(4, 0, 0, 0, null);
    expect(be.stats().structures).toBe(0);
  });

  it('dry slots get the mask layer count and camera-relative matrices', () => {
    const be = readyBackend();
    be.setStructureMesh(4, 0, 0, 0, mesh());
    be.setStructurePose(4, pose(1048576, 47.6, -2097152));
    be.setStructureDryVolume(4, { ox: -1, oy: -1, oz: -1, sx: 9, sy: 5, sz: 7, mask: new Uint8Array(9 * 5 * 7).fill(1) });
    be.setCamera({ x: 1048570, y: 50, z: -2097150, yaw: 0, pitch: 0, fov: 70 });
    const i = internals(be);
    i.assignDrySlots();
    expect(i.u.dryCount.value).toBe(1);
    expect(i.u.dryLayers.value.x).toBe(5);
    // Local cell (2, 0, 3) centre, camera-relative.
    const rel = new THREE.Vector3(1048576 + 2.5 - 1048570, 47.6 + 0.5 - 50, -2097152 + 3.5 + 2097150);
    const uvw = rel.applyMatrix4(i.u.dryMatrices[0]!.value);
    expect(uvw.x).toBeCloseTo(3.5 / 9, 5);
    expect(uvw.y).toBeCloseTo(4.5 / 7, 5);
    expect(uvw.z).toBeCloseTo(1.5 / 5, 5);
  });
});

describe('floating render origin (review: float32 precision far from the world origin)', () => {
  it('everything is drawn relative to an origin near the camera, rebased with hysteresis', () => {
    const be = readyBackend();
    const i = internals(be);
    const far = 4194304;
    be.setSectionMesh(1, far + 16, 32, far - 48, mesh());
    be.setStructureMesh(2, 0, 0, 0, mesh());
    be.setStructurePose(2, pose(far + 10.25, 47.5, far + 3.75));
    be.setCamera({ x: far + 5.5, y: 60, z: far + 2.5, yaw: 0, pitch: 0, fov: 70 });
    expect(i.origin).toEqual({ x: far, y: 0, z: far });
    // Small render-space numbers only.
    expect(i.camera.position.toArray()).toEqual([5.5, 60, 2.5]);
    const sec = i.sections.get(1)!.meshes[0]!;
    expect(sec.matrixWorld.elements.slice(12, 15)).toEqual([16, 32, -48]);
    const g = i.structures.get(2)!.group;
    expect(g.matrix.elements[12]).toBeCloseTo(10.25, 9);
    expect(g.matrix.elements[14]).toBeCloseTo(3.75, 9);
    expect(i.entities.group.matrix.elements.slice(12, 15)).toEqual([-far, -0, -far]);
    // Small moves (even across a period boundary) keep the origin...
    be.setCamera({ x: far + 300, y: 60, z: far - 100, yaw: 0, pitch: 0, fov: 70 });
    expect(i.origin).toEqual({ x: far, y: 0, z: far });
    // ...a long trip rebases it and every static matrix with it.
    be.setCamera({ x: far + 1000.5, y: 60, z: far, yaw: 0, pitch: 0, fov: 70 });
    expect(i.origin.x).toBe(far + 768);
    expect(i.camera.position.x).toBe(232.5);
    expect(sec.matrixWorld.elements[12]).toBe(16 - 768);
    expect(g.matrix.elements[12]).toBeCloseTo(10.25 - 768, 9);
    expect(i.entities.group.matrix.elements[12]).toBe(-(far + 768));
    // World overlays: root at (anchor - origin), anchor near the camera.
    be.setOverlays({ target: { structureId: 0, x: far + 1001, y: 59, z: far + 1 }, breakProgress: 0, preview: [], conflicts: [], glue: [] });
    const outline = i.overlayRoot.children.find((c) => c instanceof THREE.LineSegments)!;
    i.overlayRoot.updateMatrixWorld(true);
    const p = new THREE.Vector3().setFromMatrixPosition(outline.matrixWorld);
    expect(p.toArray()).toEqual([far + 1001 - i.origin.x, 59, 1]);
  });
});

describe('entity carrier compensation (review: carried rabbits hopped in place)', () => {
  /** A 10 x 1 x 6 deck spanning local [0,10] x [0,1] x [0,6]. */
  function deck(): MeshData {
    const g = quad(1);
    g.positions.set([0, 1, 0, 10, 1, 0, 10, 1, 6, 0, 1, 6]);
    return { opaque: g, cutout: null, translucent: null };
  }

  it('a passenger standing on a moving, turning ship has no self motion; one walking on it does', () => {
    const be = readyBackend();
    be.setStructureMesh(1, 0, 0, 0, deck());
    const p0 = pose(100, 47, 50, 0.3, [5, 0, 3]);
    be.setStructurePose(1, p0);
    endFrame(be);
    // Next frame: the ship moved 0.4 blocks and turned a little.
    const p1 = pose(100.4, 47.02, 50.1, 0.33, [5, 0, 3]);
    be.setStructurePose(1, p1);
    const toWorld = (p: StructurePose, lx: number, ly: number, lz: number): THREE.Vector3 => {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion(p.qx, p.qy, p.qz, p.qw);
      m.compose(new THREE.Vector3(p.px, p.py, p.pz), q, new THREE.Vector3(1, 1, 1));
      return new THREE.Vector3(lx - p.pivotX, ly - p.pivotY, lz - p.pivotZ).applyMatrix4(m);
    };
    const out = { x: 0, y: 0, z: 0 };
    // Standing at local (8, 1, 2) both frames.
    const a = toWorld(p0, 8, 1, 2);
    const b = toWorld(p1, 8, 1, 2);
    internals(be).selfMotion(b.x, b.y, b.z, b.x - a.x, b.y - a.y, b.z - a.z, out);
    expect(Math.hypot(out.x, out.y, out.z)).toBeLessThan(1e-9);
    // Walking 0.2 blocks along local +x on the deck.
    const c = toWorld(p1, 8.2, 1, 2);
    internals(be).selfMotion(c.x, c.y, c.z, c.x - a.x, c.y - a.y, c.z - a.z, out);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(0.2, 6);
  });

  it('entities away from every structure keep their raw motion; one standing on the shore stays still', () => {
    const be = readyBackend();
    be.setStructureMesh(1, 0, 0, 0, deck());
    be.setStructurePose(1, pose(100, 47, 50));
    endFrame(be);
    be.setStructurePose(1, pose(100.5, 47, 50));
    const out = { x: 0, y: 0, z: 0 };
    internals(be).selfMotion(0, 60, 0, 0.1, 0, 0.05, out);
    expect(out).toEqual({ x: 0.1, y: 0, z: 0.05 });
    // Right next to the ship (inside its padded bounds) but not moving: no motion invented.
    internals(be).selfMotion(99.6, 48, 52, 0, 0, 0, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('upload primer and CPU array release (review: turn hitch, retained mesh memory)', () => {
  /** What three does for a mesh it draws: call onBeforeRender, then upload. */
  const draw = (m: THREE.Mesh): void => m.onBeforeRender(undefined as never, undefined as never, undefined as never, m.geometry, m.material as THREE.Material, undefined as never);

  it('never-drawn meshes are drawn a budget at a time regardless of the frustum, then released', () => {
    const be = readyBackend();
    const i = internals(be);
    for (let k = 0; k < 100; k++) be.setSectionMesh(k, k * 16, 0, 0, mesh());
    i.primeUploads();
    const all = [...i.sections.values()].map((r) => r.meshes[0]!);
    const primed = all.filter((m) => !m.frustumCulled);
    expect(primed.length).toBe(48);
    // The renderer draws them (and one in-view mesh from the rest).
    for (const m of primed) draw(m);
    draw(all[99]!);
    // Next frame: the previous batch is culled normally again, the next batch is primed, and
    // the drawn meshes drop their CPU arrays (the GPU has its copy).
    i.releaseUploaded();
    i.primeUploads();
    expect(primed.every((m) => m.frustumCulled)).toBe(true);
    // 52 queued meshes left, one of them already drawn in view: the next 48 are primed.
    expect(all.filter((m) => !m.frustumCulled).length).toBe(48);
    expect(all[99]!.frustumCulled).toBe(true);
    for (const m of [...primed, all[99]!]) {
      expect(m.geometry.getAttribute('position').array.length).toBe(0);
      expect(m.geometry.getAttribute('position').count).toBe(4); // draw range intact
      expect(m.geometry.index!.array).toBeInstanceOf(Uint32Array);
      expect(m.geometry.index!.count).toBe(6);
    }
    expect(all[50]!.geometry.getAttribute('position').array.length).toBe(12);
  });

  it('a geometry replaced after its first draw is not released by mistake', () => {
    const be = readyBackend();
    const i = internals(be);
    be.setSectionMesh(1, 0, 0, 0, mesh());
    const m = i.sections.get(1)!.meshes[0]!;
    draw(m);
    be.setSectionMesh(1, 0, 0, 0, mesh()); // remeshed between frames: new geometry, not uploaded yet
    i.releaseUploaded();
    expect(m.geometry.getAttribute('position').array.length).toBe(12);
    draw(m);
    i.releaseUploaded();
    expect(m.geometry.getAttribute('position').array.length).toBe(0);
  });
});
