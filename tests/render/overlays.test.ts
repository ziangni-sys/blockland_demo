/**
 * Overlay placement without a GPU (scene graph and instance matrices only).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { GLUE_BEAD_LIFT, GLUE_BEAD_WIDTH, GLUE_DECAL_LIFT, glueBeadGeometry, LIGHT_ATTRIBUTE, OverlayLayer } from '../../src/render/three/overlays';
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
  return { target: null, breakProgress: 0, preview: [], conflicts: [], glue: [], ...partial };
}

function layer(): { layer: OverlayLayer; tex: THREE.DataArrayTexture } {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4, 1);
  return { layer: new OverlayLayer(new SharedUniforms(), uniform(new THREE.Vector4(1, 0, 0, 1)), tex, []), tex };
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
  it('an exposed glued face is a depth-tested decal on the face, on its open side; no bead or ghost', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const cell = { structureId: 0, x: 4, y: 2, z: -3 };
    for (let face = 0; face < 6; face++) {
      l.update(state({ glue: [{ ...cell, face, covered: false, sky: 15, block: 0 }] }), () => root, face);
      expect(instancesOf(root, 'overlay-glue')).toEqual([]);
      expect(instancesOf(root, 'overlay-glue-xray')).toEqual([]);
      const decals = instancesOf(root, 'overlay-glue-decal');
      expect(decals.length).toBe(1);
      const mat = decals[0]!.mat;
      expect(mat.depthTest).toBe(true);
      expect(mat.depthFunc).toBe(THREE.LessEqualDepth); // hidden behind other blocks
      const [dx, dy, dz] = DIRS[face]!;
      const axis = dx !== 0 ? 'x' : dy !== 0 ? 'y' : 'z';
      const sign = dx + dy + dz;
      const plane = cell[axis] + 0.5 + 0.5 * sign;
      const box = decals[0]!.box;
      // A flat 1 x 1 quad lying just off the face, on the open side (outside the block's cell).
      expect(box.min[axis]).toBeCloseTo(plane + sign * GLUE_DECAL_LIFT, 6);
      expect(box.max[axis]).toBeCloseTo(plane + sign * GLUE_DECAL_LIFT, 6);
      for (const a of ['x', 'y', 'z'] as const) {
        if (a === axis) continue;
        expect(box.max[a] - box.min[a]).toBeCloseTo(1, 6);
        expect(box.min[a]).toBeCloseTo(cell[a], 6);
      }
      // The quad faces the open side (its +Z normal is rotated onto the face direction).
      const n = new THREE.Vector3(0, 0, 1).transformDirection(decals[0]!.matrix);
      expect([n.x, n.y, n.z].map((v) => Math.round(v))).toEqual([dx, dy, dz]);
    }
    l.dispose();
    tex.dispose();
  });

  it('a list mixing both kinds draws each the right way', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    l.update(
      state({
        glue: [
          { structureId: 0, x: 0, y: 0, z: 0, face: 0, covered: true, sky: 15, block: 0 },
          { structureId: 0, x: 5, y: 0, z: 0, face: 2, covered: false, sky: 15, block: 0 },
          { structureId: 0, x: 9, y: 0, z: 0, face: 4, covered: false, sky: 15, block: 0 },
        ],
      }),
      () => root,
      1,
    );
    expect(instancesOf(root, 'overlay-glue').length).toBe(1);
    expect(instancesOf(root, 'overlay-glue-xray').length).toBe(1);
    expect(instancesOf(root, 'overlay-glue-decal').length).toBe(2);
    l.update(state({ glue: [] }), () => root, 1);
    expect(instancesOf(root, 'overlay-glue-decal').length).toBe(0);
    expect(instancesOf(root, 'overlay-glue').length).toBe(0);
    l.dispose();
    tex.dispose();
  });

  it('a covered face: the bead straddles the shared face and reaches the outer surfaces along all four edges', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const cell = { structureId: 0, x: 4, y: 2, z: -3 };
    for (let face = 0; face < 6; face++) {
      l.update(state({ glue: [{ ...cell, face, covered: true, sky: 15, block: 0 }] }), () => root, face);
      expect(instancesOf(root, 'overlay-glue-decal')).toEqual([]);
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

describe('glue decal lighting (review: the decal glowed at full brightness at night and in caves)', () => {
  function decalMeshes(root: THREE.Object3D): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.visible && (o.material as THREE.Material).name === 'overlay-glue-decal') out.push(o);
    });
    return out;
  }
  const lightOf = (m: THREE.InstancedMesh, k: number): number[] => {
    const a = m.geometry.getAttribute(LIGHT_ATTRIBUTE);
    return [a.getX(k), a.getY(k), a.getZ(k), a.getW(k)];
  };

  it('each decal carries the light of its open cell and its face, re-sent when only the light changes', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const a: OverlayFace = { structureId: 0, x: 1, y: 2, z: 3, face: 1, covered: false, sky: 3, block: 9 };
    const b: OverlayFace = { structureId: 0, x: 4, y: 2, z: 3, face: 2, covered: false, sky: 15, block: 0 };
    l.update(state({ glue: [a, b] }), () => root, 1);
    const [m] = decalMeshes(root);
    expect(m!.geometry.getAttribute(LIGHT_ATTRIBUTE)).toBeInstanceOf(THREE.InstancedBufferAttribute);
    expect(lightOf(m!, 0)).toEqual([3 / 15, 9 / 15, 1, 0].map(Math.fround));
    expect(lightOf(m!, 1)).toEqual([1, 0, 2, 0]);
    // A torch put next to the face: same cells, new light.
    const version = (m!.geometry.getAttribute(LIGHT_ATTRIBUTE) as THREE.InstancedBufferAttribute).version;
    l.update(state({ glue: [{ ...a, block: 14 }, b] }), () => root, 1);
    expect(lightOf(m!, 0)[1]).toBeCloseTo(14 / 15, 6);
    expect((m!.geometry.getAttribute(LIGHT_ATTRIBUTE) as THREE.InstancedBufferAttribute).version).toBeGreaterThan(version);
    l.dispose();
    tex.dispose();
  });

  it("a decal under a structure takes the structure's per-object light; a world decal the default", () => {
    const { layer: l, tex } = layer();
    const world = new THREE.Group();
    const ship = new THREE.Group();
    const shipLight = new THREE.Vector4(0.2, 0.4, 0, 0);
    ship.userData.bl = shipLight;
    const face = { x: 0, y: 0, z: 0, face: 2, covered: false, sky: 15, block: 0 };
    l.update(state({ glue: [{ structureId: 0, ...face }, { structureId: 7, ...face }] }), (id) => (id === 0 ? world : id === 7 ? ship : null), 1);
    expect(decalMeshes(ship)[0]!.userData.bl).toBe(shipLight);
    expect(decalMeshes(world)[0]!.userData.bl).toBeUndefined();
    l.dispose();
    tex.dispose();
  });

  it('the decal colour depends on the instance light, the per-object light, the time of day and the light tints', () => {
    const u = new SharedUniforms();
    const objLight = uniform(new THREE.Vector4(1, 0, 0, 1));
    const tex = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4, 1);
    const l = new OverlayLayer(u, objLight, tex, []);
    const mat = l.materials.find((m) => m.name === 'overlay-glue-decal') as THREE.NodeMaterial;
    expect(mat.lights).toBe(false); // lit by the voxel light model, not three's lights
    const seen = new Set<unknown>();
    const attributes = new Set<string>();
    const walk = (n: THREE.Node): void => {
      if (seen.has(n)) return;
      seen.add(n);
      if (n instanceof THREE.AttributeNode) attributes.add((n as unknown as { _attributeName: string })._attributeName);
      for (const c of n.getChildren()) walk(c as THREE.Node);
    };
    walk(mat.colorNode!);
    expect(attributes.has(LIGHT_ATTRIBUTE)).toBe(true);
    for (const node of [objLight, u.dayLight, u.skyTint, u.blockTint]) expect(seen.has(node)).toBe(true);
    l.dispose();
    tex.dispose();
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
    const face: OverlayFace = { structureId: 5, x: 2, y: 1, z: 2, face: 2, covered: true, sky: 15, block: 0 };
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
