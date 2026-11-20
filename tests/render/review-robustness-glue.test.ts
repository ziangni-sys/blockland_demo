/**
 * Adversarial review: glue overlays.
 *
 * A COVERED glued face (OverlayFace.covered) lies between two blocks, so the neighbour across
 * it is a block, almost always opaque. (Exposed faces are drawn as decals on their open side:
 * tests/render/overlays.test.ts.)
 *
 * The backend draws each glued face as a depth-tested quad 0.006 beyond the face, i.e. strictly
 * INSIDE that neighbouring block, where both blocks' own faces hide it. On screen the glue is
 * invisible except for 1 px polygon-offset slivers at block edges (scratch exp-glue.js:
 * glue-exposed.png vs glue-between.png). This test fails while that is the case; any fix that
 * makes the glue visible (no depth test / x-ray pass, or drawing on the exterior faces next to
 * the seam) passes.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { OverlayLayer } from '../../src/render/three/overlays';
import { SharedUniforms } from '../../src/render/three/shading';
import type { Dir } from '../../src/core/dirs';
import type { OverlayState } from '../../src/render/backend';

const DIRS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

describe('review: glue faces between two blocks', () => {
  it('a glued face is drawn somewhere the neighbouring block cannot hide it', () => {
    const placeholder = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4, 1);
    const layer = new OverlayLayer(new SharedUniforms(), uniform(new THREE.Vector4(1, 0, 0, 1)), placeholder, []);
    const root = new THREE.Group();
    const cell = { structureId: 0, x: 2, y: 3, z: 3, fill: 0xff };
    for (let face = 0; face < 6; face++) {
      const o: OverlayState = { target: null, breakProgress: 0, breakFill: 0xff, preview: [], conflicts: [], glue: [{ ...cell, face: face as Dir, covered: true, sky: 15, block: 0, quads: 15 }], targetOctant: -1, placement: null };
      layer.update(o, () => root, face);
      const mesh = root.children.find((c) => c instanceof THREE.InstancedMesh && c.count > 0 && c.visible) as THREE.InstancedMesh;
      expect(mesh).toBeDefined();
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(0, m);
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      const [dx, dy, dz] = DIRS[face]!;
      // The block on the other side of the glued face.
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      const nz = cell.z + dz;
      // The quad's centre (and so the whole quad, which is parallel to the face) lies strictly
      // inside the neighbouring block's cell.
      const insideNeighbour = p.x > nx && p.x < nx + 1 && p.y > ny && p.y < ny + 1 && p.z > nz && p.z < nz + 1;
      const depthTested = (mesh.material as THREE.Material).depthTest;
      expect({ face, hiddenInsideNeighbour: insideNeighbour && depthTested }).toEqual({ face, hiddenInsideNeighbour: false });
    }
    layer.dispose();
    placeholder.dispose();
  });
});
