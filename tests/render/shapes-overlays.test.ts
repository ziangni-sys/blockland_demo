/**
 * The overlay layer over partial cells (docs/SHAPES.md 8.6), scene graph and instance matrices
 * only (no GPU): the outline and the cracks follow their masks and keep one geometry per mask,
 * the preview and conflict tints draw BOXES[fill], glued faces are drawn over their quadrants, and
 * the two M2.4 markers (targetOctant, placement) are drawn when set and hidden at -1 / null.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { BOX_COUNT, BOXES } from '../../src/blocks/shapes';
import { NX, NY, PX, PY, type Dir } from '../../src/core/dirs';
import type { OverlayCell, OverlayFace, OverlayState } from '../../src/render/backend';
import { crackShell, localQuadrants, outlineSegments } from '../../src/render/three/boxgeom';
import { CRACK_OFFSET, LIGHT_ATTRIBUTE, OCTANT_INFLATE, OUTLINE_INFLATE, OverlayLayer } from '../../src/render/three/overlays';
import { SharedUniforms } from '../../src/render/three/shading';

function state(partial: Partial<OverlayState>): OverlayState {
  return { target: null, breakProgress: 0, breakFill: 0, preview: [], conflicts: [], glue: [], targetOctant: -1, placement: null, ...partial };
}

function layer(): { layer: OverlayLayer; tex: THREE.DataArrayTexture } {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4, 1);
  return { layer: new OverlayLayer(new SharedUniforms(), uniform(new THREE.Vector4(1, 0, 0, 1)), tex, []), tex };
}

const cell = (x: number, y: number, z: number, fill: number): OverlayCell => ({ structureId: 0, x, y, z, fill });
const face = (x: number, y: number, z: number, f: Dir, covered: boolean, quads: number): OverlayFace => ({
  structureId: 0,
  x,
  y,
  z,
  fill: 0xff,
  face: f,
  covered,
  sky: 15,
  block: 0,
  quads,
});

/** Visible objects under root with this material name. */
function objects(root: THREE.Object3D, name: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o instanceof THREE.Mesh || o instanceof THREE.LineSegments) && o.visible && (o.material as THREE.Material).name === name) out.push(o as THREE.Mesh);
  });
  return out;
}

/** Instance boxes (world-space bounding boxes) of every visible instanced mesh with this material. */
function instanceBoxes(root: THREE.Object3D, name: string): THREE.Box3[] {
  const out: THREE.Box3[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh) || !o.visible || (o.material as THREE.Material).name !== name) return;
    const geo = o.geometry as THREE.BufferGeometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    for (let i = 0; i < o.count; i++) {
      const m = new THREE.Matrix4();
      o.getMatrixAt(i, m);
      out.push(geo.boundingBox!.clone().applyMatrix4(m));
    }
  });
  return out;
}

/** Visible LineSegments under root (the outline first, then the chisel's octant). */
function lines(root: THREE.Object3D): THREE.LineSegments[] {
  return root.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments && c.visible);
}

const sortBoxes = (bs: THREE.Box3[]): string[] => bs.map((b) => [...b.min.toArray(), ...b.max.toArray()].map((v) => v.toFixed(4)).join(' ')).sort();

describe('target outline and cracks over a part (docs/SHAPES.md 6.3, 8.6)', () => {
  it('the outline is built from the target fill, one geometry kept per mask', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    l.update(state({ target: cell(3, 4, 5, 0x33) }), () => root, 1);
    const [outline] = lines(root);
    expect(outline!.geometry.getAttribute('position').array).toEqual(outlineSegments(0x33, OUTLINE_INFLATE));
    expect(outline!.position.toArray()).toEqual([3, 4, 5]);
    const slab = outline!.geometry;
    l.update(state({ target: cell(3, 4, 5, 0xcc) }), () => root, 1);
    expect(outline!.geometry).not.toBe(slab);
    expect(outline!.geometry.getAttribute('position').array).toEqual(outlineSegments(0xcc, OUTLINE_INFLATE));
    l.update(state({ target: cell(3, 4, 5, 0x33) }), () => root, 1);
    expect(outline!.geometry).toBe(slab); // kept, not rebuilt
    l.update(state({ target: cell(3, 4, 5, 0xff) }), () => root, 1);
    expect(outline!.geometry.getAttribute('position').count).toBe(24); // the unit cube's 12 edges
    l.dispose();
    tex.dispose();
  });

  it('the cracks wrap breakFill (the mined part, or one octant), shown only while there is progress', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const crackOf = (): THREE.Mesh | undefined => objects(root, 'overlay-crack')[0];
    l.update(state({ target: cell(0, 1, 0, 0x33), breakProgress: 0.5, breakFill: 0x33 }), () => root, 1);
    expect(crackOf()!.geometry.getAttribute('position').array).toEqual(crackShell(0x33, CRACK_OFFSET).positions);
    // The chisel's timed progress on one octant (mining.sub bit 3): one octant's shell.
    l.update(state({ target: cell(0, 1, 0, 0x33), breakProgress: 0.5, breakFill: 1 << 1 }), () => root, 1);
    expect(crackOf()!.geometry.getAttribute('position').array).toEqual(crackShell(0x02, CRACK_OFFSET).positions);
    // No progress, or nothing to wrap: no cracks.
    l.update(state({ target: cell(0, 1, 0, 0x33), breakProgress: 0, breakFill: 0x33 }), () => root, 1);
    expect(crackOf()).toBeUndefined();
    l.update(state({ target: cell(0, 1, 0, 0x33), breakProgress: 0.5, breakFill: 0 }), () => root, 1);
    expect(crackOf()).toBeUndefined();
    // A whole block: the crack box of old, 1.006 around the cell.
    l.update(state({ target: cell(0, 1, 0, 0xff), breakProgress: 0.9, breakFill: 0xff }), () => root, 1);
    const g = crackOf()!.geometry;
    g.computeBoundingBox();
    expect(g.boundingBox!.min.toArray().map((v) => +v.toFixed(4))).toEqual([-0.003, -0.003, -0.003]);
    expect(g.boundingBox!.max.toArray().map((v) => +v.toFixed(4))).toEqual([1.003, 1.003, 1.003]);
    l.dispose();
    tex.dispose();
  });

  it("the chisel's octant (targetOctant, M2.4): hidden at -1, else that octant's outline on the target cell", () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    l.update(state({ target: cell(7, 2, 1, 0xff), targetOctant: -1 }), () => root, 1);
    expect(lines(root).length).toBe(1);
    l.update(state({ target: cell(7, 2, 1, 0xff), targetOctant: 6 }), () => root, 1);
    const [, octant] = lines(root);
    expect(octant!.position.toArray()).toEqual([7, 2, 1]);
    expect(octant!.geometry.getAttribute('position').array).toEqual(outlineSegments(1 << 6, OCTANT_INFLATE));
    l.update(state({ target: null, targetOctant: 6 }), () => root, 1);
    expect(lines(root).length).toBe(0);
    l.dispose();
    tex.dispose();
  });
});

describe('preview and conflict tints draw BOXES[fill] (docs/SHAPES.md 8.6)', () => {
  it('one instance per box, each the box (half units) plus the inflation; a whole cell is the unit box of old', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const fills = [0xff, 0x3f, 0x69, 0x01, 0x33];
    l.update(state({ preview: fills.map((f, i) => cell(i * 2, 0, 0, f)) }), () => root, 1);
    const got = instanceBoxes(root, 'overlay-cells');
    const want: THREE.Box3[] = [];
    fills.forEach((f, i) => {
      for (let k = 0; k < BOX_COUNT[f]!; k++) {
        const b = f * 24 + k * 6;
        const g = 0.03 / 2; // the inflation, half on each side
        want.push(new THREE.Box3(new THREE.Vector3(i * 2 + BOXES[b]! / 2 - g, BOXES[b + 1]! / 2 - g, BOXES[b + 2]! / 2 - g), new THREE.Vector3(i * 2 + BOXES[b + 3]! / 2 + g, BOXES[b + 4]! / 2 + g, BOXES[b + 5]! / 2 + g)));
      }
    });
    expect(got.length).toBe(1 + 2 + 4 + 1 + 1);
    expect(sortBoxes(got)).toEqual(sortBoxes(want));
    l.dispose();
    tex.dispose();
  });

  it('a change of shape alone re-uploads (fill is part of the list hash); an empty fill draws nothing', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    l.update(state({ conflicts: [cell(1, 1, 1, 0xff)] }), () => root, 1);
    expect(instanceBoxes(root, 'overlay-cells').length).toBe(1);
    l.update(state({ conflicts: [cell(1, 1, 1, 0x69)] }), () => root, 1);
    expect(instanceBoxes(root, 'overlay-cells').length).toBe(4);
    l.update(state({ conflicts: [cell(1, 1, 1, 0)] }), () => root, 1);
    expect(instanceBoxes(root, 'overlay-cells').length).toBe(0);
    l.dispose();
    tex.dispose();
  });
});

describe('glued faces over their quadrants (docs/SHAPES.md 8.6)', () => {
  it('an exposed half face: a decal over that half only; a covered half: a bead along its outline and a ghost of it', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    // The top face of (4, 2, -3): quadrants q = hu | hv << 1 on x (u) and z (v).
    const lowZ = 0b0011; // hv = 0: the -Z half
    l.update(state({ glue: [face(4, 2, -3, PY, false, lowZ), face(4, 2, -3, PY, true, 0b1100)] }), () => root, 1);
    const [decal] = instanceBoxes(root, 'overlay-glue-decal');
    expect(decal!.min.x).toBeCloseTo(4, 6);
    expect(decal!.max.x).toBeCloseTo(5, 6);
    expect(decal!.min.z).toBeCloseTo(-3, 6);
    expect(decal!.max.z).toBeCloseTo(-2.5, 6);
    expect(decal!.min.y).toBeCloseTo(3.004, 6);
    const [ghost] = instanceBoxes(root, 'overlay-glue-xray');
    expect(ghost!.min.z).toBeCloseTo(-2.5, 6);
    expect(ghost!.max.z).toBeCloseTo(-2, 6);
    expect(ghost!.min.y).toBeCloseTo(3, 6);
    const [bead] = instanceBoxes(root, 'overlay-glue');
    // Along the outline of the +Z half: from the middle line (z = -2.5, lifted toward the open
    // half) to just past the cell's edge; across the seam half the width on each side.
    expect(bead!.min.z).toBeCloseTo(-2.5 - 0.006, 6);
    expect(bead!.max.z).toBeCloseTo(-2 + 0.006, 6);
    expect(bead!.min.x).toBeCloseTo(4 - 0.006, 6);
    expect(bead!.max.x).toBeCloseTo(5 + 0.006, 6);
    expect(bead!.min.y).toBeCloseTo(3 - 0.13, 5);
    expect(bead!.max.y).toBeCloseTo(3 + 0.13, 5);
    l.dispose();
    tex.dispose();
  });

  it('faces are sorted into one instanced layer per local quadrant mask, each with its own geometry made once', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const glue: OverlayFace[] = [];
    for (let q = 1; q < 16; q++) glue.push(face(q * 2, 0, 0, NY, false, q), face(q * 2, 0, 3, PX, false, q));
    l.update(state({ glue }), () => root, 1);
    const meshes: THREE.InstancedMesh[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.visible) meshes.push(o);
    });
    // 15 local masks; both faces of a mask land in the layer of their local mask.
    let instances = 0;
    for (const m of meshes) instances += m.count;
    expect(instances).toBe(30);
    expect(meshes.length).toBe(15);
    const before = new Set(meshes.map((m) => m.geometry.getAttribute('position')));
    // The same list again, and a new list with the same masks: no new geometry.
    l.update(state({ glue: [...glue] }), () => root, 2);
    const after: THREE.InstancedMesh[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.visible) after.push(o);
    });
    for (const m of after) expect(before.has(m.geometry.getAttribute('position'))).toBe(true);
    // Each decal's area is a quarter per quadrant.
    for (const f of glue) expect(localQuadrants(f.face, f.quads)).not.toBe(0);
    l.dispose();
    tex.dispose();
  });
});

describe('glue layers per frame (review: the per-frame cost grew with the number of quadrant masks)', () => {
  /** Light attribute values (sky / 15) of the visible decal instances, in instance order. */
  function decalSky(root: THREE.Object3D): number[] {
    const out: number[] = [];
    root.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh) || !o.visible || (o.material as THREE.Material).name !== 'overlay-glue-decal') return;
      const a = o.geometry.getAttribute(LIGHT_ATTRIBUTE).array as Float32Array;
      for (let i = 0; i < o.count; i++) out.push(Math.round(a[i * 4]! * 15));
    });
    return out;
  }

  it('a frame with the same glue array, topology and anchor reads nothing; a new array, topology or anchor is applied', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const glue = [face(1, 2, 3, PY, false, 0b0011), face(4, 2, 3, NX, false, 0b1000), face(6, 2, 3, PY, false, 15)];
    const st = state({ glue });
    l.update(st, () => root, 1, { x: 0, y: 0, z: 0 });
    expect(decalSky(root)).toEqual([15, 15, 15]);
    // The renderer reads a glue array once (the view builder sends a new one on any change): a
    // change made in place is not picked up while nothing else changes.
    glue[0]!.sky = 3;
    l.update(st, () => root, 1, { x: 0, y: 0, z: 0 });
    expect(decalSky(root)).toEqual([15, 15, 15]);
    // A new topology re-applies the faces (their sub-layers see the new light).
    l.update(st, () => root, 2, { x: 0, y: 0, z: 0 });
    expect(decalSky(root).sort((a, b) => a - b)).toEqual([3, 15, 15]);
    glue[1]!.sky = 5;
    // A new anchor too, and the world faces move with it.
    l.update(st, () => root, 2, { x: 16, y: 0, z: 0 });
    expect(decalSky(root).sort((a, b) => a - b)).toEqual([3, 5, 15]);
    for (const b of instanceBoxes(root, 'overlay-glue-decal')) expect(b.max.x).toBeLessThan(0);
    // A new array with new content.
    l.update(state({ glue: [face(1, 2, 3, PY, false, 0b0011)] }), () => root, 2, { x: 16, y: 0, z: 0 });
    expect(decalSky(root)).toEqual([15]);
    l.dispose();
    tex.dispose();
  });

  it("a mask whose faces are gone is emptied, and drawn again when faces of that mask come back", () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const a = face(1, 2, 3, PY, false, 0b0011);
    const b = face(4, 2, 3, PY, false, 0b0101);
    l.update(state({ glue: [a, b] }), () => root, 1);
    expect(instanceBoxes(root, 'overlay-glue-decal').length).toBe(2);
    l.update(state({ glue: [a] }), () => root, 1);
    expect(instanceBoxes(root, 'overlay-glue-decal').length).toBe(1);
    l.update(state({ glue: [] }), () => root, 1);
    expect(instanceBoxes(root, 'overlay-glue-decal').length).toBe(0);
    l.update(state({ glue: [b] }), () => root, 1);
    const boxes = instanceBoxes(root, 'overlay-glue-decal');
    expect(boxes.length).toBe(1);
    expect(boxes[0]!.min.x).toBeCloseTo(4, 6);
    l.dispose();
    tex.dispose();
  });
});

describe('the placement preview (M2.4)', () => {
  it('null hides it; a block item draws the outer surface of its fill with the block tiles; an item without a block look is not drawn', () => {
    const { layer: l, tex } = layer();
    const root = new THREE.Group();
    const preview = (): THREE.Mesh | undefined => objects(root, 'overlay-placement')[0];
    l.update(state({ placement: null }), () => root, 1);
    expect(preview()).toBeUndefined();
    l.update(state({ placement: { structureId: 0, x: 2, y: 3, z: 4, fill: 0xcc, item: B.PLANKS_OAK } }), () => root, 1);
    const p = preview()!;
    expect(p.position.toArray()).toEqual([2, 3, 4]);
    const g = p.geometry;
    expect(g.getAttribute('position').array).toEqual(crackShell(0xcc, 0.002).positions);
    expect(g.getAttribute('layer').count).toBe(g.getAttribute('position').count);
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(0.498, 6);
    l.update(state({ placement: { structureId: 0, x: 2, y: 3, z: 4, fill: 0xcc, item: I.GLUE } }), () => root, 1);
    expect(preview()).toBeUndefined();
    l.dispose();
    tex.dispose();
  });
});

describe('pipeline warm-up', () => {
  it('warmupObjects covers every overlay material, the placement preview included (with its tile attribute)', () => {
    const { layer: l, tex } = layer();
    const objs = l.warmupObjects();
    const used = new Set(objs.map((o) => (o as THREE.Mesh).material as THREE.Material));
    for (const m of l.materials) expect(used.has(m), m.name || m.type).toBe(true);
    const placement = objs.find((o) => ((o as THREE.Mesh).material as THREE.Material).name === 'overlay-placement') as THREE.Mesh;
    expect(placement.geometry.getAttribute('layer')).toBeDefined();
    l.dispose();
    tex.dispose();
  });
});
