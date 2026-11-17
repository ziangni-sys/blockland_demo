/**
 * Adversarial review (robustness lens) of the three.js backend's CPU-side bookkeeping.
 * No GPU: the backend is constructed in Node and its pipelines are built without a renderer
 * (buildPipelines only creates TSL node graphs, geometries and textures). These tests encode
 * the behaviour dependents need; they FAIL against the current implementation on purpose.
 *
 * GPU-level findings of the same review (resize before init, dispose during init, glue decals,
 * ice ripples, far-from-origin cracks, device loss) are reproduced with the Playwright scripts
 * listed in the review report; they cannot run in vitest.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { ThreeBackend } from '../../src/render/three/backend';
import type { StructurePose } from '../../src/render/backend';
import type { GeometryData, MeshData } from '../../src/mesh/types';

function pose(px: number, py: number, pz: number): StructurePose {
  return { px, py, pz, qx: 0, qy: 0, qz: 0, qw: 1, pivotX: 0, pivotY: 0, pivotZ: 0, sky: 15, block: 0 };
}

/** One unit quad as a GeometryData (enough for the backend's bookkeeping). */
function quad(): GeometryData {
  return {
    vertexCount: 4,
    indexCount: 6,
    positions: new Float32Array([0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1]),
    normals: new Int8Array([0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 127, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    layers: new Uint16Array(4),
    light: new Uint8Array(16).fill(255),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}
function mesh(): MeshData {
  return { opaque: quad(), cutout: null, translucent: null };
}

/**
 * A backend in the state init() leaves it in (pipelines built, ready), without a GPU. Before
 * init completes the backend now queues meshes instead of dropping them, so `ready` must be
 * set as well for meshes to be applied immediately.
 */
function backendWithPipelines(): ThreeBackend {
  const be = new ThreeBackend({ forceWebGL: true });
  (be as unknown as { buildPipelines(): void }).buildPipelines();
  (be as unknown as { ready: boolean }).ready = true;
  return be;
}

function structureGroup(be: ThreeBackend, id: number): THREE.Group | undefined {
  const recs = (be as unknown as { structures: Map<number, { group: THREE.Group }> }).structures;
  return recs.get(id)?.group;
}

describe('review: structure lifecycle', () => {
  it('a pose that arrives after setStructureMesh(id, null) does not resurrect the structure', () => {
    // The client interpolates and sends the poses of every structure it knows each frame; a
    // structure removed this frame (blockified, destroyed) can still get one stale pose.
    const be = backendWithPipelines();
    be.setStructureMesh(7, 0, 0, 0, mesh());
    be.setStructurePose(7, pose(10, 50, 10));
    expect(be.stats().structures).toBe(1);
    be.setStructureMesh(7, 0, 0, 0, null);
    expect(be.stats().structures).toBe(0);
    be.setStructurePose(7, pose(10, 50, 10));
    // Currently 1: an empty Group + record that nothing ever removes again (leak; stats lie).
    expect(be.stats().structures).toBe(0);
  });

  it('a structure is not drawn at the world origin before its first pose', () => {
    // Meshes come back from the worker asynchronously; the first frame after the mesh lands
    // may not have a pose yet. With an identity group matrix the whole ship flashes at (0,0,0)
    // (reproduced on screen: scratch exp-own.js -> nopose.png).
    const be = backendWithPipelines();
    be.setStructureMesh(3, 0, 0, 0, mesh());
    const g = structureGroup(be, 3)!;
    expect(g).toBeDefined();
    const drawnAtOrigin = g.visible && g.parent !== null && g.matrix.equals(new THREE.Matrix4());
    expect(drawnAtOrigin).toBe(false);
  });
});

describe('review: use after dispose', () => {
  it('mesh uploads after dispose() are rejected instead of building GPU-less objects', () => {
    const be = backendWithPipelines();
    be.dispose();
    be.setSectionMesh(1, 0, 0, 0, mesh());
    be.setStructureMesh(9, 0, 0, 0, mesh());
    // Currently 1 and 1: new meshes are created with the disposed materials and kept forever.
    expect(be.stats().sections).toBe(0);
    expect(be.stats().structures).toBe(0);
  });
});
