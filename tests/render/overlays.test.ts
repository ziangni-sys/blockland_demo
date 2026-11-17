/**
 * Overlay placement without a GPU (scene graph and instance matrices only).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GLUE_BEAD_LIFT, GLUE_BEAD_WIDTH, glueBeadGeometry, OverlayLayer } from '../../src/render/three/overlays';
import { SharedUniforms } from '../../src/render/three/shading';
import type { OverlayFace, OverlayState } from '../../src/render/backend';

const DIRS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function state(partial: Partial<OverlayState>): OverlayState {
  return { target: null, breakProgress: 0, preview: [], conflicts: [], glue: [], glueAnchor: null, ...partial };
}

function layer(): { layer: OverlayLayer; tex: THREE.DataArrayTexture } {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4, 1);
  return { layer: new OverlayLayer(new SharedUniforms(), tex, []), tex };
}

function instancesOf(root: THREE.Object3D, name: string): { box: THREE.Box3; matrix: THREE.Matrix4; mat: THREE.Material }[] {
  const out: { box: THREE.Box3; matrix: THREE.Matrix4; mat: THREE.Material }[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh) || !o.visible) return;
    const mat = o.material as THREE.Material;
    if (mat.name !== name) return;
    const geo = o.geometry as THREE.BufferGeometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    for (let i = 0; i < o.count; i++) {
      const m = new THREE.Matrix4();
      o.getMatrixAt(i, m);
      out.push({ box: geo.boundingBox!.clone().applyMatrix4(m), matrix: m, mat });
    }
  });
  return out;
}

describe('glued faces (review: glue between two blocks was invisible)', () => {
  it('the bead straddles the shared face and reaches the outer surfaces along all four edges', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const cell = { structureId: 0, x: 4, y: 2, z: -3 };
    for (let face = 0; face < 6; face++) {
      l.update(state({ glue: [{ ...cell, face }] }), () => root, face);
      const beads = instancesOf(root, 'overlay-glue');
      expect(beads.length).toBe(1);
      const box = beads[0]!.box;
      const [dx, dy, dz] = DIRS[face]!;
      // The pair of glued cells A (cell) and B (neighbour) as a box.
      const pair = new THREE.Box3(
        new THREE.Vector3(Math.min(cell.x, cell.x + dx), Math.min(cell.y, cell.y + dy), Math.min(cell.z, cell.z + dz)),
        new THREE.Vector3(Math.max(cell.x, cell.x + dx) + 1, Math.max(cell.y, cell.y + dy) + 1, Math.max(cell.z, cell.z + dz) + 1),
      );
      const axis = dx !== 0 ? 'x' : dy !== 0 ? 'y' : 'z';
      const plane = (cell[axis] + 0.5) + 0.5 * (dx + dy + dz);
      for (const a of ['x', 'y', 'z'] as const) {
        if (a === axis) {
          // Across the seam: half the bead width on each block.
          expect(box.min[a]).toBeCloseTo(plane - GLUE_BEAD_WIDTH / 2, 5);
          expect(box.max[a]).toBeCloseTo(plane + GLUE_BEAD_WIDTH / 2, 5);
        } else {
          // Along the face: just proud of the pair's outer surfaces on both sides.
          expect(box.min[a]).toBeCloseTo(pair.min[a] - GLUE_BEAD_LIFT, 5);
          expect(box.max[a]).toBeCloseTo(pair.max[a] + GLUE_BEAD_LIFT, 5);
        }
      }
      // Depth tested normally: shown exactly where the joint meets open air.
      const mat = beads[0]!.mat;
      expect(mat.depthTest).toBe(true);
      expect(mat.depthFunc).toBe(THREE.LessEqualDepth);
      // The x-ray ghost of the face itself is drawn only where something is in front of it.
      const ghosts = instancesOf(root, 'overlay-glue-xray');
      expect(ghosts.length).toBe(1);
      expect(ghosts[0]!.mat.depthFunc).toBe(THREE.GreaterDepth);
      const centre = new THREE.Vector3().setFromMatrixPosition(ghosts[0]!.matrix);
      expect(centre[axis]).toBeCloseTo(plane, 6);
    }
    l.dispose();
    tex.dispose();
  });

  it('bead faces face outwards (front faces survive back-face culling)', () => {
    const g = glueBeadGeometry();
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const idx = g.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1));
      c.fromBufferAttribute(pos, idx.getX(t + 2));
      n.fromBufferAttribute(nrm, idx.getX(t));
      const cross = b.clone().sub(a).cross(c.clone().sub(a));
      expect(cross.dot(n)).toBeGreaterThan(0);
      // And the normal points away from the face centre.
      expect(a.clone().add(b).add(c).dot(n)).toBeGreaterThan(0);
    }
    g.dispose();
  });
});

describe('overlay parenting', () => {
  // Review finding: a new instanced mesh added under a structure whose pose did not change
  // that frame kept an identity matrixWorld (drawn near the world origin).
  it('instanced overlays added under an unchanged structure group follow its pose at once', () => {
    const { layer: l, tex } = layer();
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.makeRotationY(0.6).setPosition(100, 47.5, -20);
    scene.add(group);
    scene.updateMatrixWorld(); // the structure's pose is settled before the overlay appears
    const face: OverlayFace = { structureId: 5, x: 2, y: 1, z: 2, face: 2 };
    l.update(state({ glue: [face], preview: [{ structureId: 5, x: 1, y: 1, z: 1 }] }), (id) => (id === 5 ? group : id === 0 ? scene : null), 1);
    scene.updateMatrixWorld();
    let meshes = 0;
    group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.visible) {
        meshes++;
        expect(o.matrixWorld.equals(group.matrixWorld)).toBe(true);
      }
    });
    expect(meshes).toBe(3); // preview, glue ghost, glue bead
    l.dispose();
    tex.dispose();
  });

  // Review finding (float32 far from the origin): world overlays are written relative to an
  // integer anchor near the camera; the backend places the overlay root at that anchor.
  it('world overlays are written relative to the anchor, structure overlays are not', () => {
    const { layer: l, tex } = layer();
    const world = new THREE.Group();
    const ship = new THREE.Group();
    const anchor = { x: 1048576, y: 0, z: -2097152 };
    l.update(
      state({
        target: { structureId: 0, x: 1048580, y: 60, z: -2097150 },
        preview: [{ structureId: 0, x: 1048590, y: 61, z: -2097140 }, { structureId: 9, x: 3, y: 1, z: 2 }],
      }),
      (id) => (id === 0 ? world : id === 9 ? ship : null),
      1,
      anchor,
    );
    const wp = instancesOf(world, 'overlay-cells');
    expect(wp.length).toBe(1);
    const t = new THREE.Vector3().setFromMatrixPosition(wp[0]!.matrix);
    expect(t.toArray()).toEqual([14.5, 61.5, 12.5]);
    const sp = instancesOf(ship, 'overlay-cells');
    expect(new THREE.Vector3().setFromMatrixPosition(sp[0]!.matrix).toArray()).toEqual([3.5, 1.5, 2.5]);
    const outline = world.children.find((c) => c instanceof THREE.LineSegments)!;
    expect(outline.position.toArray()).toEqual([4, 60, 2]);
    // Moving the anchor rewrites the matrices even though the cell list is unchanged.
    const moved = { x: 1048576 + 256, y: 0, z: -2097152 };
    l.update(
      state({ preview: [{ structureId: 0, x: 1048590, y: 61, z: -2097140 }] }),
      (id) => (id === 0 ? world : null),
      1,
      moved,
    );
    const again = instancesOf(world, 'overlay-cells');
    expect(new THREE.Vector3().setFromMatrixPosition(again[0]!.matrix).x).toBe(14.5 - 256);
    l.dispose();
    tex.dispose();
  });
});
