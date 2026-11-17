/**
 * Overlays: target outline, mining cracks, assembly preview / conflict cells, glued faces and
 * the glue anchor. Cells with structureId != 0 are in that structure's local cell space; their
 * objects are parented to the structure's group so they follow its pose exactly.
 *
 * World-space overlays (structureId 0) live under `overlayRoot`, which the backend places at
 * an integer ANCHOR near the camera (OverlayLayer.update's anchor argument): positions are
 * written relative to it, so instance matrices hold small numbers and stay exact in float32
 * however far the player is from the world origin.
 *
 * Instanced cell layers re-upload instance matrices only when the cell list content changed
 * (cheap order-sensitive hash), so a client that re-sends the same lists every frame costs one
 * pass over them and nothing else.
 *
 * Glue. A glued face always lies BETWEEN two blocks (docs/DESIGN.md 强力胶: the glue vanishes
 * when either block goes), so a decal on that face would sit inside solid blocks where it can
 * never be seen. It is drawn twice instead:
 *   - a glue BEAD: a thin band straddling the seam on every surface of the pair that touches
 *     the glued face's edges (a box w thick across the face plane, just over 1 x 1 along it;
 *     its side faces lie on the outer surfaces of the two blocks). Depth tested: it shows
 *     exactly where the joint meets open air, like glue squeezed out of the joint;
 *   - an X-RAY ghost of the glued face itself (glue_face tile, faint), drawn only where it is
 *     hidden (depth test GREATER), so glue between blocks buried in a wall is still visible
 *     to a player holding glue.
 */
import * as THREE from 'three/webgpu';
import { abs, Discard, float, Fn, max, mix, sin, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { OverlayCell, OverlayFace, OverlayState } from '../backend';
import { boxEdges } from './boxgeom';
import { crackLayer, crackStage, tileLayer } from './blocktiles';
import { applyFogNode, cameraRelativePosition, encodeOutput, type SharedUniforms } from './shading';

/** Resolves the parent object of a structure id (0 = world overlay root); null = unknown structure. */
export type ParentResolver = (structureId: number) => THREE.Object3D | null;

/** Integer origin subtracted from WORLD overlay cells (structureId 0); structure cells are not shifted. */
export interface OverlayAnchor {
  x: number;
  y: number;
  z: number;
}

const ZERO_ANCHOR: OverlayAnchor = Object.freeze({ x: 0, y: 0, z: 0 });

/** Render orders inside the transparent list: after water. */
const ORDER_CELLS = 60;
const ORDER_DECALS = 61;
const ORDER_GLUE = 62;
const ORDER_LINES = 63;

/** Width of the glue bead across the seam (blocks; half on each block). */
export const GLUE_BEAD_WIDTH = 0.26;
/** How far the bead stands proud of the block surfaces (avoids z-fighting with them). */
export const GLUE_BEAD_LIFT = 0.006;

// Face rotations mapping the local +Z axis onto each Dir, column-major 3x3.
const FACE_ROT: readonly (readonly number[])[] = [
  [0, 0, -1, 0, 1, 0, 1, 0, 0], // +X: Ry(+90)
  [0, 0, 1, 0, 1, 0, -1, 0, 0], // -X: Ry(-90)
  [1, 0, 0, 0, 0, -1, 0, 1, 0], // +Y: Rx(-90)
  [1, 0, 0, 0, 0, 1, 0, -1, 0], // -Y: Rx(+90)
  [1, 0, 0, 0, 1, 0, 0, 0, 1], // +Z
  [-1, 0, 0, 0, 1, 0, 0, 0, -1], // -Z: Ry(180)
];
const DIR_X = [1, -1, 0, 0, 0, 0];
const DIR_Y = [0, 0, 1, -1, 0, 0];
const DIR_Z = [0, 0, 0, 0, 1, -1];

function cellsHash(cells: readonly OverlayCell[], withFace: boolean): number {
  let h = 0x811c9dc5 ^ cells.length;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    h = Math.imul(h ^ c.structureId, 0x01000193);
    h = Math.imul(h ^ c.x, 0x01000193);
    h = Math.imul(h ^ c.y, 0x01000193);
    h = Math.imul(h ^ c.z, 0x01000193);
    if (withFace) h = Math.imul(h ^ (c as OverlayFace).face, 0x01000193);
  }
  return h >>> 0;
}

/**
 * How an instance is placed:
 *   cell : a unit box centred on the cell, scaled by 1 + inflate
 *   face : local +Z rotated onto the face direction, origin at the face centre pushed out by
 *          `offset` from the cell centre (0.5 = exactly on the face plane)
 */
type Placement = { kind: 'cell'; inflate: number } | { kind: 'face'; offset: number };

/** A set of instanced meshes (one per parent structure) drawing one cell list. */
class InstancedCellLayer {
  private readonly meshes = new Map<number, THREE.InstancedMesh>();
  private readonly counts = new Map<number, number>();
  private readonly fill = new Map<number, number>();
  private lastHash = -1;
  private lastLen = -1;
  /** Bumped by the backend whenever structures appear / disappear, to force re-parenting. */
  private lastTopology = -1;
  private lastAx = NaN;
  private lastAy = NaN;
  private lastAz = NaN;

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly order: number,
    private readonly placement: Placement,
  ) {}

  update(cells: readonly OverlayCell[], resolve: ParentResolver, topology: number, anchor: OverlayAnchor): void {
    const faces = this.placement.kind === 'face';
    const hash = cellsHash(cells, faces);
    if (
      hash === this.lastHash &&
      cells.length === this.lastLen &&
      topology === this.lastTopology &&
      anchor.x === this.lastAx &&
      anchor.y === this.lastAy &&
      anchor.z === this.lastAz
    ) {
      return;
    }
    this.lastHash = hash;
    this.lastLen = cells.length;
    this.lastTopology = topology;
    this.lastAx = anchor.x;
    this.lastAy = anchor.y;
    this.lastAz = anchor.z;

    this.counts.clear();
    for (let i = 0; i < cells.length; i++) {
      const id = cells[i]!.structureId;
      this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    }
    // Hide meshes whose structure no longer has cells.
    this.meshes.forEach((m, id) => {
      if (!this.counts.has(id)) {
        m.count = 0;
        m.visible = false;
      }
    });
    this.fill.clear();
    this.counts.forEach((n, id) => {
      const parent = resolve(id);
      let m = this.meshes.get(id);
      if (!parent) {
        if (m) {
          m.visible = false;
          m.removeFromParent();
        }
        return;
      }
      if (!m || m.instanceMatrix.count < n) {
        if (m) {
          m.removeFromParent();
          m.dispose();
        }
        m = new THREE.InstancedMesh(this.geometry, this.material, Math.max(16, nextPow2(n)));
        m.frustumCulled = false;
        m.renderOrder = this.order;
        m.matrixAutoUpdate = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.meshes.set(id, m);
      }
      if (m.parent !== parent) {
        parent.add(m);
        // three only recomputes a child's matrixWorld when the child is dirty or its parent's
        // matrixWorld was recomputed in the same frame. A structure whose pose did not change
        // this frame would leave the new child with an identity matrixWorld (drawn near the
        // world origin) until its next pose.
        m.matrixWorldNeedsUpdate = true;
      }
      m.count = 0;
      m.visible = true;
      this.fill.set(id, 0);
    });
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const m = this.meshes.get(c.structureId);
      const k = this.fill.get(c.structureId);
      if (!m || k === undefined || !m.parent) continue;
      const world = c.structureId === 0;
      this.writeMatrix(m.instanceMatrix.array as Float32Array, k * 16, c, world ? anchor.x : 0, world ? anchor.y : 0, world ? anchor.z : 0);
      this.fill.set(c.structureId, k + 1);
      m.count = k + 1;
    }
    this.meshes.forEach((m) => {
      if (m.count > 0) m.instanceMatrix.needsUpdate = true;
    });
  }

  private writeMatrix(a: Float32Array, o: number, c: OverlayCell, ax: number, ay: number, az: number): void {
    const cx = c.x - ax + 0.5;
    const cy = c.y - ay + 0.5;
    const cz = c.z - az + 0.5;
    if (this.placement.kind === 'cell') {
      const s = 1 + this.placement.inflate;
      a[o] = s;
      a[o + 1] = 0;
      a[o + 2] = 0;
      a[o + 3] = 0;
      a[o + 4] = 0;
      a[o + 5] = s;
      a[o + 6] = 0;
      a[o + 7] = 0;
      a[o + 8] = 0;
      a[o + 9] = 0;
      a[o + 10] = s;
      a[o + 11] = 0;
      a[o + 12] = cx;
      a[o + 13] = cy;
      a[o + 14] = cz;
      a[o + 15] = 1;
      return;
    }
    const f = (c as OverlayFace).face | 0;
    const d = f >= 0 && f < 6 ? f : 2;
    const r = FACE_ROT[d]!;
    a[o] = r[0]!;
    a[o + 1] = r[1]!;
    a[o + 2] = r[2]!;
    a[o + 3] = 0;
    a[o + 4] = r[3]!;
    a[o + 5] = r[4]!;
    a[o + 6] = r[5]!;
    a[o + 7] = 0;
    a[o + 8] = r[6]!;
    a[o + 9] = r[7]!;
    a[o + 10] = r[8]!;
    a[o + 11] = 0;
    const off = this.placement.offset;
    a[o + 12] = cx + DIR_X[d]! * off;
    a[o + 13] = cy + DIR_Y[d]! * off;
    a[o + 14] = cz + DIR_Z[d]! * off;
    a[o + 15] = 1;
  }

  /** One instanced mesh for pipeline warm-up. */
  warmupMesh(): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geometry, this.material, 1);
    m.frustumCulled = false;
    return m;
  }

  get drawn(): number {
    let n = 0;
    this.meshes.forEach((m) => {
      if (m.visible && m.parent) n += m.count;
    });
    return n;
  }

  dispose(): void {
    this.meshes.forEach((m) => {
      m.removeFromParent();
      m.dispose();
    });
    this.meshes.clear();
  }
}

/** 12 square bars of thickness `t` along the edges of the box [lo, hi]^3, merged into one geometry. */
function frameGeometry(lo: number, hi: number, t: number): THREE.BufferGeometry {
  const len = hi - lo + t;
  const mid = (lo + hi) / 2;
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let k = 0; k < 4; k++) {
      const b = k & 1 ? hi : lo;
      const c = k & 2 ? hi : lo;
      const size = [t, t, t];
      size[axis] = len;
      const center = axis === 0 ? [mid, b, c] : axis === 1 ? [b, mid, c] : [b, c, mid];
      const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
      g.translate(center[0]!, center[1]!, center[2]!);
      const base = pos.length / 3;
      pos.push(...(g.getAttribute('position').array as Float32Array));
      nrm.push(...(g.getAttribute('normal').array as Float32Array));
      for (const i of g.getIndex()!.array as ArrayLike<number> as number[]) idx.push(base + i);
      g.dispose();
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  return geo;
}

/**
 * The glue bead in the glued face's own frame: the face lies in the z = 0 plane spanning
 * x, y in [-0.5, 0.5], z = +-0.5 are the two glued block centres' sides. Only the four side
 * faces of the box [-h, h]^2 x [-w/2, w/2] (h = 0.5 + lift) are built, facing outwards; they
 * lie just over the outer surfaces of the two blocks along the face's four edges. uv: u along
 * the edge, v across the seam (0 on the -Z block, 1 on the +Z block).
 */
export function glueBeadGeometry(width = GLUE_BEAD_WIDTH, lift = GLUE_BEAD_LIFT): THREE.BufferGeometry {
  const h = 0.5 + lift;
  const z0 = -width / 2;
  const z1 = width / 2;
  // For each side: outward normal and the two in-plane corner positions (CCW seen from outside).
  const sides: { n: [number, number, number]; a: [number, number]; b: [number, number] }[] = [
    { n: [1, 0, 0], a: [h, -h], b: [h, h] },
    { n: [0, 1, 0], a: [h, h], b: [-h, h] },
    { n: [-1, 0, 0], a: [-h, h], b: [-h, -h] },
    { n: [0, -1, 0], a: [-h, -h], b: [h, -h] },
  ];
  const pos = new Float32Array(4 * 4 * 3);
  const nrm = new Float32Array(4 * 4 * 3);
  const uvs = new Float32Array(4 * 4 * 2);
  const idx = new Uint16Array(4 * 6);
  sides.forEach((s, i) => {
    // Corners: (a, z0) (b, z0) (b, z1) (a, z1); a -> b runs counter-clockwise around +Z.
    const corners: [number, number, number, number][] = [
      [s.a[0], s.a[1], z0, 0],
      [s.b[0], s.b[1], z0, 1],
      [s.b[0], s.b[1], z1, 1],
      [s.a[0], s.a[1], z1, 0],
    ];
    corners.forEach((c, k) => {
      const v = i * 4 + k;
      pos.set([c[0], c[1], c[2]], v * 3);
      nrm.set(s.n, v * 3);
      // u along the edge, v across the seam (z0 -> 0, z1 -> 1).
      uvs.set([c[3], c[2] < 0 ? 0 : 1], v * 2);
    });
    // (b0 - a0) x (b1 - a0) points along n: counter-clockwise seen from outside.
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** A single object (outline / crack shell) placed on one cell of some grid. */
function placeOnCell(obj: THREE.Object3D, cell: OverlayCell | null, resolve: ParentResolver, anchor: OverlayAnchor): boolean {
  if (!cell) {
    obj.visible = false;
    return false;
  }
  const parent = resolve(cell.structureId);
  if (!parent) {
    obj.visible = false;
    obj.removeFromParent();
    return false;
  }
  if (obj.parent !== parent) parent.add(obj);
  if (cell.structureId === 0) obj.position.set(cell.x - anchor.x, cell.y - anchor.y, cell.z - anchor.z);
  else obj.position.set(cell.x, cell.y, cell.z);
  // updateMatrix() also flags matrixWorldNeedsUpdate, so a fresh parent is handled.
  obj.updateMatrix();
  obj.visible = true;
  return true;
}

export class OverlayLayer {
  private readonly cellBox: THREE.BoxGeometry;
  private readonly decalQuad: THREE.PlaneGeometry;
  private readonly beadGeo: THREE.BufferGeometry;
  private readonly crackBox: THREE.BoxGeometry;
  private readonly outlineGeo: THREE.BufferGeometry;
  private readonly anchorGeo: THREE.BufferGeometry;
  private readonly outline: THREE.LineSegments;
  private readonly anchor: THREE.Mesh;
  private readonly crack: THREE.Mesh;
  private readonly preview: InstancedCellLayer;
  private readonly conflicts: InstancedCellLayer;
  private readonly glueBead: InstancedCellLayer;
  private readonly glueGhost: InstancedCellLayer;
  private readonly crackLayerU = uniform(0, 'int');
  private readonly glueLayerU = uniform(0, 'int');
  readonly materials: THREE.Material[] = [];

  constructor(u: SharedUniforms, placeholder: THREE.DataArrayTexture, tileNodes: THREE.TextureNode[]) {
    this.cellBox = new THREE.BoxGeometry(1, 1, 1);
    this.decalQuad = new THREE.PlaneGeometry(1, 1);
    this.beadGeo = glueBeadGeometry();
    this.crackBox = new THREE.BoxGeometry(1.006, 1.006, 1.006);
    this.crackBox.translate(0.5, 0.5, 0.5);

    const cellMat = (hex: number, base: number, edge: number): THREE.NodeMaterial => {
      const m = new THREE.NodeMaterial();
      m.name = 'overlay-cells';
      m.lights = false;
      m.fog = false;
      m.transparent = true;
      m.depthWrite = false;
      const c = new THREE.Color(hex);
      const tint = vec3(c.r, c.g, c.b); // linear (Color converts the sRGB hex)
      m.colorNode = Fn(() => {
        const q = uv();
        const e = max(abs(q.x.sub(0.5)), abs(q.y.sub(0.5))).mul(2);
        const rim = smoothstep(0.8, 0.96, e);
        const pulse = sin(u.time.mul(4.2)).mul(0.22).add(0.78);
        const a = float(base).add(rim.mul(edge)).mul(pulse);
        return vec4(encodeOutput(applyFogNode(u, tint.mul(rim.mul(0.6).add(1)), cameraRelativePosition())), a);
      })();
      this.materials.push(m);
      return m;
    };

    // Mining cracks: a depth-tested decal shell just outside the target block.
    const crackTex = texture(placeholder, uv()).depth(this.crackLayerU);
    tileNodes.push(crackTex);
    const crackMat = new THREE.NodeMaterial();
    crackMat.name = 'overlay-crack';
    crackMat.lights = false;
    crackMat.fog = false;
    crackMat.transparent = true;
    crackMat.depthWrite = false;
    crackMat.polygonOffset = true;
    crackMat.polygonOffsetFactor = -1;
    crackMat.polygonOffsetUnits = -2;
    crackMat.colorNode = Fn(() => {
      Discard(crackTex.a.lessThan(0.04));
      return vec4(encodeOutput(applyFogNode(u, crackTex.rgb.mul(0.9), cameraRelativePosition())), crackTex.a.mul(0.9));
    })();
    this.materials.push(crackMat);

    // Glue bead: glue colour from the glue_face tile (its coarsest mip = the average colour;
    // the tile prep dilates colour into transparent texels, so the average is the glue's own
    // colour, not darkened by the empty background), brightened to full value.
    const glueAvg = texture(placeholder, vec2(0.5, 0.5)).depth(this.glueLayerU).level(float(16));
    tileNodes.push(glueAvg);
    const beadMat = new THREE.NodeMaterial();
    beadMat.name = 'overlay-glue';
    beadMat.lights = false;
    beadMat.fog = false;
    beadMat.transparent = true;
    beadMat.depthWrite = false;
    beadMat.polygonOffset = true;
    beadMat.polygonOffsetFactor = -1;
    beadMat.polygonOffsetUnits = -2;
    beadMat.colorNode = Fn(() => {
      const base = glueAvg.rgb.div(max(max(glueAvg.r, glueAvg.g), max(glueAvg.b, float(0.05))));
      const d = abs(uv().y.sub(0.5)).mul(2); // 0 on the seam, 1 at the bead's edges
      const body = float(1).sub(smoothstep(0.62, 1, d));
      // A darker joint line in the middle and a glossy ridge either side read as a bead.
      const joint = mix(float(0.55), float(1), smoothstep(0.06, 0.16, d));
      const gloss = smoothstep(0.18, 0.32, d).mul(float(1).sub(smoothstep(0.32, 0.5, d))).mul(0.35);
      const pulse = sin(u.time.mul(3.6)).mul(0.1).add(0.9);
      const col = base.mul(0.95).mul(joint).add(gloss);
      return vec4(encodeOutput(applyFogNode(u, col, cameraRelativePosition())), body.mul(0.9).mul(pulse));
    })();
    this.materials.push(beadMat);

    // X-ray ghost of the glued face: drawn only where something is in front of it.
    const ghostTex = texture(placeholder, uv()).depth(this.glueLayerU);
    tileNodes.push(ghostTex);
    const ghostMat = new THREE.NodeMaterial();
    ghostMat.name = 'overlay-glue-xray';
    ghostMat.lights = false;
    ghostMat.fog = false;
    ghostMat.transparent = true;
    ghostMat.depthWrite = false;
    ghostMat.depthFunc = THREE.GreaterDepth;
    ghostMat.side = THREE.DoubleSide;
    ghostMat.forceSinglePass = true;
    ghostMat.colorNode = Fn(() => {
      Discard(ghostTex.a.lessThan(0.04));
      const pulse = sin(u.time.mul(3.6)).mul(0.08).add(0.92);
      return vec4(encodeOutput(applyFogNode(u, ghostTex.rgb.mul(1.15), cameraRelativePosition())), ghostTex.a.mul(0.38).mul(pulse));
    })();
    this.materials.push(ghostMat);

    this.preview = new InstancedCellLayer(this.cellBox, cellMat(0x52e0ff, 0.16, 0.5), ORDER_CELLS, { kind: 'cell', inflate: 0.03 });
    this.conflicts = new InstancedCellLayer(this.cellBox, cellMat(0xff3b30, 0.3, 0.55), ORDER_CELLS, { kind: 'cell', inflate: 0.04 });
    this.glueGhost = new InstancedCellLayer(this.decalQuad, ghostMat, ORDER_DECALS, { kind: 'face', offset: 0.5 });
    this.glueBead = new InstancedCellLayer(this.beadGeo, beadMat, ORDER_GLUE, { kind: 'face', offset: 0.5 });

    this.crack = new THREE.Mesh(this.crackBox, crackMat);
    this.crack.renderOrder = ORDER_DECALS;
    this.crack.matrixAutoUpdate = false;
    this.crack.visible = false;

    const lineMat = (hex: number, opacity: number): THREE.LineBasicNodeMaterial => {
      const m = new THREE.LineBasicNodeMaterial({ transparent: opacity < 1, opacity, depthWrite: false });
      m.fog = false;
      const c = new THREE.Color(hex);
      m.colorNode = encodeOutput(applyFogNode(u, vec3(c.r, c.g, c.b), cameraRelativePosition()));
      this.materials.push(m);
      return m;
    };
    const e = 0.004;
    this.outlineGeo = new THREE.BufferGeometry();
    this.outlineGeo.setAttribute('position', new THREE.BufferAttribute(boxEdges(-e, -e, -e, 1 + e, 1 + e, 1 + e), 3));
    this.outline = new THREE.LineSegments(this.outlineGeo, lineMat(0x101418, 0.75));
    this.outline.renderOrder = ORDER_LINES;
    this.outline.matrixAutoUpdate = false;
    this.outline.visible = false;

    // The anchor is a solid frame of 12 thin bars (1 px lines vanish against the block faces),
    // bright and gently pulsing so the first pick of a glue operation is easy to find again.
    this.anchorGeo = frameGeometry(-0.02, 1.02, 0.045);
    const anchorMat = new THREE.NodeMaterial();
    anchorMat.name = 'overlay-anchor';
    anchorMat.lights = false;
    anchorMat.fog = false;
    const gold = new THREE.Color(0xffc93a);
    anchorMat.colorNode = Fn(() => {
      const pulse = sin(u.time.mul(5)).mul(0.15).add(0.95);
      return vec4(encodeOutput(applyFogNode(u, vec3(gold.r, gold.g, gold.b).mul(pulse), cameraRelativePosition())), 1);
    })();
    this.materials.push(anchorMat);
    this.anchor = new THREE.Mesh(this.anchorGeo, anchorMat);
    this.anchor.renderOrder = ORDER_LINES;
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;

    this.glueLayerU.value = Math.max(0, tileLayer('glue_face'));
  }

  /**
   * Applies the overlay state. `anchor` must be an integer vector near the camera; the caller
   * places the world overlay root (resolve(0)) at it.
   */
  update(o: OverlayState, resolve: ParentResolver, topology: number, anchor: OverlayAnchor = ZERO_ANCHOR): void {
    placeOnCell(this.outline, o.target, resolve, anchor);
    const stage = crackStage(o.breakProgress);
    const layer = stage >= 0 ? crackLayer(stage) : -1;
    if (layer >= 0 && placeOnCell(this.crack, o.target, resolve, anchor)) {
      this.crackLayerU.value = layer;
    } else {
      this.crack.visible = false;
    }
    placeOnCell(this.anchor, o.glueAnchor, resolve, anchor);
    this.preview.update(o.preview, resolve, topology, anchor);
    this.conflicts.update(o.conflicts, resolve, topology, anchor);
    this.glueGhost.update(o.glue, resolve, topology, anchor);
    this.glueBead.update(o.glue, resolve, topology, anchor);
  }

  /** Objects covering every overlay pipeline, for warm-up compilation. */
  warmupObjects(): THREE.Object3D[] {
    const crack = new THREE.Mesh(this.crackBox, this.crack.material);
    const outline = new THREE.LineSegments(this.outlineGeo, this.outline.material);
    const anchor = new THREE.Mesh(this.anchorGeo, this.anchor.material);
    return [crack, outline, anchor, this.preview.warmupMesh(), this.conflicts.warmupMesh(), this.glueGhost.warmupMesh(), this.glueBead.warmupMesh()];
  }

  /** Called when the tile texture changes (glue tile layer may move). */
  refreshTiles(): void {
    this.glueLayerU.value = Math.max(0, tileLayer('glue_face'));
  }

  get instances(): number {
    return this.preview.drawn + this.conflicts.drawn + this.glueBead.drawn;
  }

  dispose(): void {
    this.preview.dispose();
    this.conflicts.dispose();
    this.glueGhost.dispose();
    this.glueBead.dispose();
    this.outline.removeFromParent();
    this.anchor.removeFromParent();
    this.crack.removeFromParent();
    this.cellBox.dispose();
    this.decalQuad.dispose();
    this.beadGeo.dispose();
    this.crackBox.dispose();
    this.outlineGeo.dispose();
    this.anchorGeo.dispose();
    for (const m of this.materials) m.dispose();
  }
}
