/**
 * Adversarial review: glue overlays.
 *
 * Glue lives on the FACE BETWEEN TWO BLOCKS (src/structures/glue.ts: "the face between two
 * adjacent cells"; docs/DESIGN.md: glue vanishes when either side's block is removed). So the
 * neighbour across every OverlayFace the client sends is a block, almost always opaque.
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
import { OverlayLayer } from '../../src/render/three/overlays';
import { SharedUniforms } from '../../src/render/three/shading';
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
    const layer = new OverlayLayer(new SharedUniforms(), placeholder, []);
    const root = new THREE.Group();
    const cell = { structureId: 0, x: 2, y: 3, z: 3 };
    for (let face = 0; face < 6; face++) {
      const o: OverlayState = { target: null, breakProgress: 0, preview: [], conflicts: [], glue: [{ ...cell, face }], glueAnchor: null };
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
