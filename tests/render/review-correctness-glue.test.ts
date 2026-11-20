/**
 * Adversarial review (correctness): glue faces must be visible to a player holding glue.
 *
 * Game rule (docs/DESIGN.md "强力胶"): glue belongs to a face. A COVERED glued face (OverlayFace
 * covered: true) lies between two cells that are BOTH occupied by blocks; src/client/view.ts sends
 * it as the canonical (smaller) cell plus the positive face along the glue axis (face = axis * 2).
 *
 * The overlay layer draws a depth-tested quad 0.006 "above" that face, i.e. INSIDE the neighbour
 * block, so the neighbour's own (opaque) faces hide it from every viewpoint: the player never sees
 * the glue. (The render harness only shows decals because it glues EXPOSED faces, a state the game
 * cannot produce.) Repro in a browser: glue two floor planks of a hull and look at them — nothing.
 *
 * This test checks the geometric fact without a GPU: a glue decal whose transformed bounds lie
 * entirely inside the two glued cells is enclosed by opaque blocks, so it can only be seen if its
 * material does not depth-test against them.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { OverlayLayer } from '../../src/render/three/overlays';
import { SharedUniforms } from '../../src/render/three/shading';
import type { OverlayFace, OverlayState } from '../../src/render/backend';

function overlays(glue: OverlayFace[]): OverlayState {
  return { target: null, breakProgress: 0, breakFill: 0xff, preview: [], conflicts: [], glue, targetOctant: -1, placement: null };
}

/** World-space AABB of every glue instance under `root`, plus whether its material depth-tests. */
function glueInstances(root: THREE.Object3D): { box: THREE.Box3; depthTested: boolean }[] {
  const out: { box: THREE.Box3; depthTested: boolean }[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    const mat = o.material as THREE.Material;
    if (!mat.name.includes('glue')) return;
    const geo = o.geometry as THREE.BufferGeometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const m = new THREE.Matrix4();
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      const box = geo.boundingBox!.clone().applyMatrix4(m);
      // Hidden by the blocks in front of it only under a "nearer wins" depth function. (An
      // x-ray pass with GreaterDepth is drawn precisely BECAUSE something is in front of it.)
      const nearerWins = mat.depthFunc === THREE.LessDepth || mat.depthFunc === THREE.LessEqualDepth || mat.depthFunc === THREE.EqualDepth;
      const depthTested = mat.depthTest !== false && nearerWins;
      out.push({ box, depthTested });
    }
  });
  return out;
}

describe('review: glue overlay visibility', () => {
  const cases: { name: string; face: OverlayFace; pair: [number, number, number, number, number, number] }[] = [
    // canonical cell (0,0,0), neighbour along +X / +Y / +Z (exactly what client/view.ts emits)
    { name: '+X', face: { structureId: 0, x: 0, y: 0, z: 0, face: 0, covered: true, sky: 15, block: 0, fill: 0xff, quads: 15 }, pair: [0, 0, 0, 2, 1, 1] },
    { name: '+Y', face: { structureId: 0, x: 0, y: 0, z: 0, face: 2, covered: true, sky: 15, block: 0, fill: 0xff, quads: 15 }, pair: [0, 0, 0, 1, 2, 1] },
    { name: '+Z', face: { structureId: 0, x: 0, y: 0, z: 0, face: 4, covered: true, sky: 15, block: 0, fill: 0xff, quads: 15 }, pair: [0, 0, 0, 1, 1, 2] },
  ];
  for (const c of cases) {
    it(`a glued face between two blocks (${c.name}) is not hidden inside them`, () => {
      const placeholder = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4, 1);
      const layer = new OverlayLayer(new SharedUniforms(), uniform(new THREE.Vector4(1, 0, 0, 1)), placeholder, []);
      const root = new THREE.Group();
      layer.update(overlays([c.face]), () => root, 0);
      const inst = glueInstances(root);
      expect(inst.length).toBeGreaterThan(0);
      const [x0, y0, z0, x1, y1, z1] = c.pair;
      const pair = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
      for (const g of inst) {
        const enclosed = pair.containsBox(g.box);
        // Enclosed by the two opaque glued blocks AND depth-tested => occluded from every viewpoint.
        expect({ enclosedByGluedBlocks: enclosed, depthTested: g.depthTested }).not.toEqual({ enclosedByGluedBlocks: true, depthTested: true });
      }
      layer.dispose();
    });
  }
});
