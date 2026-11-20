/**
 * Overlays: target outline, mining cracks, assembly preview / conflict cells, glued faces, and the
 * two M2.4 markers (the chisel's octant highlight, the translucent placement preview).
 * Cells with structureId != 0 are in that structure's local cell space; their objects are
 * parented to the structure's group so they follow its pose exactly.
 *
 * Shapes (docs/SHAPES.md 8.6). Every overlay follows the octants it is given: the outline and the
 * cracks are built from the cell's octant mask (OverlayCell.fill, OverlayState.breakFill) by the
 * pure builders of boxgeom.ts, the preview and conflict tints draw one instance per box of
 * BOXES[fill], and a glued face is drawn over its quadrants (OverlayFace.quads) only. Geometry is
 * made once per mask and kept (256 octant masks, 16 quadrant masks), so a frame never builds any;
 * a whole block's mask gives exactly the unit-cube geometry these overlays always had.
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
 * Glue (docs/DESIGN.md 强力胶: glue belongs to a face and outlives the block on one side).
 *   - An EXPOSED glued face (one side open) is a DECAL of the glue_face tile lying on the face,
 *     on the open side, depth tested: it shows like paint on the block and hides behind others.
 *     It is lit like the face under it (OverlayFace.sky / block per instance, the parent's
 *     per-object light on top, the time of day, the face term), and it is drawn BEFORE water,
 *     so water over it tints it as it tints the block.
 *   - A COVERED glued face lies between two blocks, where a decal could never be seen. It is
 *     drawn twice instead:
 *       - a glue BEAD: a thin band straddling the seam along the outline of the covered quadrants
 *         (w thick across the face plane, just proud of the outline along it; for a whole face its
 *         sides lie on the outer surfaces of the two blocks). Depth tested: it shows exactly where
 *         the joint meets open air, like glue squeezed out of the joint;
 *       - an X-RAY ghost of the glued quadrants (glue_face tile, faint), drawn only where it is
 *         hidden (depth test GREATER), so glue between blocks buried in a wall is still visible
 *         to a player holding glue.
 *   - One face can be both: where a half slab covers half of a whole block's glued face, the
 *     covered half is a bead and a ghost and the other half an exposed decal (view.ts
 *     collectGlueFaces sends them as separate entries).
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  Discard,
  float,
  floor,
  int,
  Fn,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalize,
  select,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { makeCell } from '../../blocks/cell';
import { B } from '../../blocks/defs';
import { BOX_COUNT, BOXES } from '../../blocks/shapes';
import type { OverlayCell, OverlayFace, OverlayState } from '../backend';
import { beadStrips, crackShell, FACE_ROT, faceQuads, localQuadrants, outlineSegments, type OverlayGeometry } from './boxgeom';
import { crackLayer, crackStage, cubeTilesForCell, tileLayer } from './blocktiles';
import { applyFogNode, cameraRelativePosition, encodeOutput, faceShadeNode, skyBlockLightNode, type SharedUniforms } from './shading';

/** Resolves the parent object of a structure id (0 = world overlay root); null = unknown structure. */
export type ParentResolver = (structureId: number) => THREE.Object3D | null;

/** Integer origin subtracted from WORLD overlay cells (structureId 0); structure cells are not shifted. */
export interface OverlayAnchor {
  x: number;
  y: number;
  z: number;
}

const ZERO_ANCHOR: OverlayAnchor = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * Render orders inside the transparent list. Glue lying on block surfaces (decal, bead) goes
 * BEFORE water (renderOrder 0), so water in front of it blends over it as over the block; the
 * other overlays are markers and go after water.
 */
const ORDER_GLUE_DECAL = -2;
const ORDER_GLUE_BEAD = -1;
const ORDER_CELLS = 60;
const ORDER_DECALS = 61;
const ORDER_LINES = 63;
/**
 * Per-instance attribute of the lit glue decal: (sky / 15, block / 15, face Dir, 0). The
 * decal's material reads it as `attribute(LIGHT_ATTRIBUTE)`.
 */
export const LIGHT_ATTRIBUTE = 'olight';

/** Width of the glue bead across the seam (blocks; half on each block). */
export const GLUE_BEAD_WIDTH = 0.26;
/** How far the bead stands proud of the block surfaces (avoids z-fighting with them). */
export const GLUE_BEAD_LIFT = 0.006;
/** How far an exposed face's decal floats off the block surface, towards the open side. */
export const GLUE_DECAL_LIFT = 0.004;

/** How far the target outline stands off the part's surfaces (blocks). */
export const OUTLINE_INFLATE = 0.004;
/** How far the chisel's octant highlight stands off the octant (a little more than the outline, so both show). */
export const OCTANT_INFLATE = 0.007;
/** How far the crack shell stands off the part's surfaces (blocks). */
export const CRACK_OFFSET = 0.003;
/** How far the placement preview stands off the octants it would fill. */
export const PLACEMENT_INFLATE = 0.002;
const DIR_X = [1, -1, 0, 0, 0, 0];
const DIR_Y = [0, 0, 1, -1, 0, 0];
const DIR_Z = [0, 0, 0, 0, 1, -1];

function cellsHash(cells: readonly OverlayCell[], withFace: boolean, withLight: boolean): number {
  let h = 0x811c9dc5 ^ cells.length;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    h = Math.imul(h ^ c.structureId, 0x01000193);
    h = Math.imul(h ^ c.x, 0x01000193);
    h = Math.imul(h ^ c.y, 0x01000193);
    h = Math.imul(h ^ c.z, 0x01000193);
    // A change of shape alone re-uploads (docs/SHAPES.md 8.6).
    h = Math.imul(h ^ c.fill, 0x01000193);
    if (withFace) h = Math.imul(h ^ (c as OverlayFace).face ^ ((c as OverlayFace).quads << 3), 0x01000193);
    if (withLight) h = Math.imul(h ^ (((c as OverlayFace).sky << 4) | (c as OverlayFace).block), 0x01000193);
  }
  // 30 bits: a small integer on every platform. A full 32-bit hash is a heap number when it does not
  // fit, boxed on every frame that compares it (tests/client/shapes-alloc.test.ts).
  return h & 0x3fffffff;
}

/**
 * How an instance is placed:
 *   boxes: one instance per box of BOXES[cell.fill] (docs/SHAPES.md 2.2, at most 4): a unit box
 *          (centred on the origin) scaled to the box's size plus `inflate` and centred on it; a
 *          whole cell is one unit box scaled by 1 + inflate
 *   face : local +Z rotated onto the face direction, origin at the face centre pushed out by
 *          `offset` from the cell centre (0.5 = exactly on the face plane)
 */
type Placement = { kind: 'boxes'; inflate: number } | { kind: 'face'; offset: number };

/** Instances one cell takes in a layer with this placement. */
function instancesOf(placement: Placement, c: OverlayCell): number {
  return placement.kind === 'boxes' ? BOX_COUNT[c.fill & 0xff]! : 1;
}

/**
 * A set of instanced meshes (one per parent structure) drawing one cell list. A LIT layer
 * (faces only) also writes each face's light and direction into the per-instance attribute
 * LIGHT_ATTRIBUTE (each mesh then owns a copy of the geometry carrying it) and hands every
 * mesh its parent's per-object light (userData.bl, see shading.ts), so a decal on a structure
 * is lit by the structure's pose light like the structure's own mesh.
 */
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
    private readonly lit = false,
  ) {}

  private newMesh(capacity: number): THREE.InstancedMesh {
    let geo = this.geometry;
    if (this.lit) {
      geo = this.geometry.clone();
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(LIGHT_ATTRIBUTE, a);
    }
    const m = new THREE.InstancedMesh(geo, this.material, capacity);
    m.frustumCulled = false;
    return m;
  }

  private disposeMesh(m: THREE.InstancedMesh): void {
    m.removeFromParent();
    m.dispose();
    if (m.geometry !== this.geometry) m.geometry.dispose();
  }

  update(cells: readonly OverlayCell[], resolve: ParentResolver, topology: number, anchor: OverlayAnchor): void {
    const faces = this.placement.kind === 'face';
    const hash = cellsHash(cells, faces, this.lit);
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
    this.upload(cells, resolve, anchor);
  }

  /**
   * Writes the instances of `cells`. Kept out of update: its closures capture `this`, and V8
   * allocates a function's closure context on entry, so in update they would cost an object on
   * every frame that changes nothing.
   */
  private upload(cells: readonly OverlayCell[], resolve: ParentResolver, anchor: OverlayAnchor): void {
    this.counts.clear();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const n = instancesOf(this.placement, c);
      if (n > 0) this.counts.set(c.structureId, (this.counts.get(c.structureId) ?? 0) + n);
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
        if (m) this.disposeMesh(m);
        m = this.newMesh(Math.max(16, nextPow2(n)));
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
        // The parent's per-object light (a structure's pose light; none = the world's).
        if (this.lit) m.userData.bl = parent.userData.bl;
      }
      m.count = 0;
      m.visible = true;
      this.fill.set(id, 0);
    });
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const m = this.meshes.get(c.structureId);
      let k = this.fill.get(c.structureId);
      if (!m || k === undefined || !m.parent) continue;
      const world = c.structureId === 0;
      const ax = world ? anchor.x : 0;
      const ay = world ? anchor.y : 0;
      const az = world ? anchor.z : 0;
      if (this.placement.kind === 'boxes') {
        const fill = c.fill & 0xff;
        const n = BOX_COUNT[fill]!;
        for (let b = 0; b < n; b++) this.writeBox(m.instanceMatrix.array as Float32Array, (k + b) * 16, c, fill * 24 + b * 6, this.placement.inflate, ax, ay, az);
        k += n;
        this.fill.set(c.structureId, k);
        m.count = k;
        continue;
      }
      this.writeFace(m.instanceMatrix.array as Float32Array, k * 16, c as OverlayFace, this.placement.offset, ax, ay, az);
      if (this.lit) {
        const f = c as OverlayFace;
        const l = m.geometry.getAttribute(LIGHT_ATTRIBUTE).array as Float32Array;
        l[k * 4] = f.sky / 15;
        l[k * 4 + 1] = f.block / 15;
        l[k * 4 + 2] = f.face >= 0 && f.face < 6 ? f.face : 2;
        l[k * 4 + 3] = 0;
      }
      this.fill.set(c.structureId, k + 1);
      m.count = k + 1;
    }
    this.meshes.forEach((m) => {
      if (m.count === 0) return;
      m.instanceMatrix.needsUpdate = true;
      if (this.lit) m.geometry.getAttribute(LIGHT_ATTRIBUTE).needsUpdate = true;
    });
  }

  /** Box `b` (offset into BOXES, half units) of cell c: the unit box scaled to it plus `inflate`, centred on it. */
  private writeBox(a: Float32Array, o: number, c: OverlayCell, b: number, inflate: number, ax: number, ay: number, az: number): void {
    const x0 = BOXES[b]!;
    const y0 = BOXES[b + 1]!;
    const z0 = BOXES[b + 2]!;
    const x1 = BOXES[b + 3]!;
    const y1 = BOXES[b + 4]!;
    const z1 = BOXES[b + 5]!;
    a[o] = (x1 - x0) * 0.5 + inflate;
    a[o + 1] = 0;
    a[o + 2] = 0;
    a[o + 3] = 0;
    a[o + 4] = 0;
    a[o + 5] = (y1 - y0) * 0.5 + inflate;
    a[o + 6] = 0;
    a[o + 7] = 0;
    a[o + 8] = 0;
    a[o + 9] = 0;
    a[o + 10] = (z1 - z0) * 0.5 + inflate;
    a[o + 11] = 0;
    a[o + 12] = c.x - ax + (x0 + x1) * 0.25;
    a[o + 13] = c.y - ay + (y0 + y1) * 0.25;
    a[o + 14] = c.z - az + (z0 + z1) * 0.25;
    a[o + 15] = 1;
  }

  private writeFace(a: Float32Array, o: number, c: OverlayFace, off: number, ax: number, ay: number, az: number): void {
    const cx = c.x - ax + 0.5;
    const cy = c.y - ay + 0.5;
    const cz = c.z - az + 0.5;
    const f = c.face | 0;
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
    a[o + 12] = cx + DIR_X[d]! * off;
    a[o + 13] = cy + DIR_Y[d]! * off;
    a[o + 14] = cz + DIR_Z[d]! * off;
    a[o + 15] = 1;
  }

  /** One instanced mesh for pipeline warm-up. */
  warmupMesh(): THREE.InstancedMesh {
    return this.newMesh(1);
  }

  get drawn(): number {
    let n = 0;
    this.meshes.forEach((m) => {
      if (m.visible && m.parent) n += m.count;
    });
    return n;
  }

  dispose(): void {
    this.meshes.forEach((m) => this.disposeMesh(m));
    this.meshes.clear();
  }
}

/** An OverlayGeometry (boxgeom.ts) as a BufferGeometry with bounds. */
function toThree(g: OverlayGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The glue bead of the face squares `local` (a local quadrant mask, boxgeom.ts localQuadrants;
 * 15 = the whole face) in the glued face's own frame: the face lies in the z = 0 plane, x, y in
 * [-0.5, 0.5], z = +-0.5 are the two glued cells' centres' sides. A band `width` thick across the
 * seam runs along the outline of the squares, facing outwards, `lift` proud of it (boxgeom.ts
 * beadStrips). For the whole face: the four sides of the box [-h, h]^2 x [-w/2, w/2] (h = 0.5 +
 * lift), which lie just over the outer surfaces of the two blocks along the face's four edges.
 * uv: u along the band, v across the seam (0 on the -Z block, 1 on the +Z block).
 */
export function glueBeadGeometry(local = 15, width = GLUE_BEAD_WIDTH, lift = GLUE_BEAD_LIFT): THREE.BufferGeometry {
  return toThree(beadStrips(local, width, lift));
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

/**
 * Glued faces drawn over their quadrants: one InstancedCellLayer per local quadrant mask
 * (boxgeom.ts localQuadrants of the face's Dir and OverlayFace.quads), made on first use with that
 * mask's geometry, which is kept (16 masks, docs/SHAPES.md 8.6). A list is sorted into the masks
 * only when the client sends a new one (the view builder replaces the array whenever a face, its
 * quadrants or its light change, and keeps it otherwise). A frame with the same list, topology and
 * anchor touches no mask layer, so the per-frame cost does not grow with the number of masks in
 * use; on a change, a mask layer whose list is empty is updated once (its instances go away) and
 * then left alone until faces of its mask come back.
 */
class QuadrantFaceLayer {
  private readonly layers: (InstancedCellLayer | null)[] = new Array<InstancedCellLayer | null>(16).fill(null);
  private readonly lists: OverlayFace[][] = Array.from({ length: 16 }, () => []);
  /** Mask m's layer draws nothing (or does not exist yet). */
  private readonly drawnEmpty: boolean[] = new Array<boolean>(16).fill(true);
  /** The list sorted last (null until the first update, which therefore always runs). */
  private list: readonly OverlayFace[] | null = null;
  private lastTopology = -1;
  private lastAx = NaN;
  private lastAy = NaN;
  private lastAz = NaN;

  constructor(
    private readonly geometry: (local: number) => THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly order: number,
    private readonly offset: number,
    private readonly lit = false,
  ) {}

  private layer(local: number): InstancedCellLayer {
    let l = this.layers[local];
    if (!l) {
      l = new InstancedCellLayer(this.geometry(local), this.material, this.order, { kind: 'face', offset: this.offset }, this.lit);
      this.layers[local] = l;
    }
    return l;
  }

  update(faces: readonly OverlayFace[], resolve: ParentResolver, topology: number, anchor: OverlayAnchor): void {
    if (faces === this.list && topology === this.lastTopology && anchor.x === this.lastAx && anchor.y === this.lastAy && anchor.z === this.lastAz) return;
    if (faces !== this.list) {
      this.list = faces;
      for (const l of this.lists) l.length = 0;
      for (const f of faces) {
        const local = localQuadrants(f.face, f.quads & 15);
        if (local !== 0) this.lists[local]!.push(f);
      }
    }
    this.lastTopology = topology;
    this.lastAx = anchor.x;
    this.lastAy = anchor.y;
    this.lastAz = anchor.z;
    for (let m = 1; m < 16; m++) {
      const cells = this.lists[m]!;
      if (cells.length === 0 && this.drawnEmpty[m]) continue;
      this.layer(m).update(cells, resolve, topology, anchor);
      this.drawnEmpty[m] = cells.length === 0;
    }
  }

  warmupMesh(): THREE.InstancedMesh {
    return this.layer(15).warmupMesh();
  }

  get drawn(): number {
    let n = 0;
    for (const l of this.layers) if (l) n += l.drawn;
    return n;
  }

  dispose(): void {
    for (const l of this.layers) l?.dispose();
    this.layers.fill(null);
    this.drawnEmpty.fill(true);
    this.list = null;
  }
}

/** A Dir from a unit axis normal (the shells' quads are axis-aligned). */
function dirOfNormal(x: number, y: number, z: number): number {
  if (x > 0.5) return 0;
  if (x < -0.5) return 1;
  if (y > 0.5) return 2;
  if (y < -0.5) return 3;
  return z > 0.5 ? 4 : 5;
}

export class OverlayLayer {
  private readonly cellBox: THREE.BoxGeometry;
  /** Geometry kept per mask: outline (by fill), crack shell (by fill), chisel highlight (by octant), glue faces (by local quadrant mask). */
  private readonly outlineGeos: (THREE.BufferGeometry | undefined)[] = new Array<THREE.BufferGeometry | undefined>(256);
  private readonly crackGeos: (THREE.BufferGeometry | undefined)[] = new Array<THREE.BufferGeometry | undefined>(256);
  private readonly octantGeos: (THREE.BufferGeometry | undefined)[] = new Array<THREE.BufferGeometry | undefined>(8);
  private readonly faceGeos: (THREE.BufferGeometry | undefined)[] = new Array<THREE.BufferGeometry | undefined>(16);
  private readonly beadGeos: (THREE.BufferGeometry | undefined)[] = new Array<THREE.BufferGeometry | undefined>(16);
  /** Placement preview geometry per (item, fill), made when first shown. */
  private readonly placementGeos = new Map<number, THREE.BufferGeometry | null>();
  private readonly outline: THREE.LineSegments;
  private readonly octant: THREE.LineSegments;
  private readonly crack: THREE.Mesh;
  private readonly placement: THREE.Mesh;
  private readonly preview: InstancedCellLayer;
  private readonly conflicts: InstancedCellLayer;
  private readonly glueBead: QuadrantFaceLayer;
  private readonly glueGhost: QuadrantFaceLayer;
  private readonly glueDecal: QuadrantFaceLayer;
  /** OverlayState.glue split by OverlayFace.covered (redone when the client sends a new list). */
  private glueList: readonly OverlayFace[] | null = null;
  private coveredGlue: OverlayFace[] = [];
  private exposedGlue: OverlayFace[] = [];
  private readonly crackLayerU = uniform(0, 'int');
  private readonly glueLayerU = uniform(0, 'int');
  readonly materials: THREE.Material[] = [];

  /**
   * `objLight` is the backend's per-object light uniform (shading.ts: x = sky scale, y = minimum
   * block light, read from the drawn object's userData.bl); the glue decal is lit with it.
   */
  constructor(u: SharedUniforms, objLight: Node<'vec4'>, placeholder: THREE.DataArrayTexture, tileNodes: THREE.TextureNode[]) {
    this.cellBox = new THREE.BoxGeometry(1, 1, 1);

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

    // Decal of an exposed glued face: the glue_face tile on the block surface, depth tested and
    // lit like that surface (shading.ts lightColor without AO): the instance's light of the open
    // cell scaled by the parent's per-object light, the time of day, and the face term of the
    // face direction turned into world space (a rotated structure's faces shade like its mesh).
    const decalTex = texture(placeholder, uv()).depth(this.glueLayerU);
    tileNodes.push(decalTex);
    const inst = attribute(LIGHT_ATTRIBUTE, 'vec4');
    const decalSky = vertexStage(inst.x.mul(objLight.x));
    const decalBlock = vertexStage(max(inst.y, objLight.y));
    const faceAxis = floor(inst.z.mul(0.5));
    const faceSign = float(1).sub(inst.z.sub(faceAxis.mul(2)).mul(2));
    const faceDir = vec3(
      select(faceAxis.equal(0), faceSign, float(0)),
      select(faceAxis.equal(1), faceSign, float(0)),
      select(faceAxis.equal(2), faceSign, float(0)),
    );
    const decalNormal = vertexStage(normalize(modelWorldMatrix.mul(vec4(faceDir, 0)).xyz));
    const decalMat = new THREE.NodeMaterial();
    decalMat.name = 'overlay-glue-decal';
    decalMat.lights = false;
    decalMat.fog = false;
    decalMat.transparent = true;
    decalMat.depthWrite = false;
    decalMat.polygonOffset = true;
    decalMat.polygonOffsetFactor = -1;
    decalMat.polygonOffsetUnits = -2;
    // Built eagerly (no Fn): the texel test is the mask, and the graph stays inspectable.
    decalMat.maskNode = decalTex.a.greaterThanEqual(0.04);
    const decalLight = skyBlockLightNode(u, decalSky, decalBlock).mul(faceShadeNode(decalNormal));
    decalMat.colorNode = vec4(
      encodeOutput(applyFogNode(u, decalTex.rgb.mul(1.1).mul(decalLight), cameraRelativePosition())),
      min(decalTex.a.mul(1.6), float(0.95)),
    );
    this.materials.push(decalMat);

    // Translucent placement preview (M2.4): the item's block tiles over the octants it would fill.
    const placeTex = texture(placeholder, uv()).depth(int(attribute('layer', 'uint')));
    tileNodes.push(placeTex);
    const placeMat = new THREE.NodeMaterial();
    placeMat.name = 'overlay-placement';
    placeMat.lights = false;
    placeMat.fog = false;
    placeMat.transparent = true;
    placeMat.depthWrite = false;
    placeMat.colorNode = Fn(() => {
      Discard(placeTex.a.lessThan(0.04));
      const pulse = sin(u.time.mul(3)).mul(0.06).add(0.94);
      return vec4(encodeOutput(applyFogNode(u, placeTex.rgb.mul(1.05), cameraRelativePosition())), float(0.45).mul(pulse));
    })();
    this.materials.push(placeMat);

    const faceGeo = (local: number): THREE.BufferGeometry => (this.faceGeos[local] ??= toThree(faceQuads(local)));
    const beadGeo = (local: number): THREE.BufferGeometry => (this.beadGeos[local] ??= glueBeadGeometry(local));
    this.preview = new InstancedCellLayer(this.cellBox, cellMat(0x52e0ff, 0.16, 0.5), ORDER_CELLS, { kind: 'boxes', inflate: 0.03 });
    this.conflicts = new InstancedCellLayer(this.cellBox, cellMat(0xff3b30, 0.3, 0.55), ORDER_CELLS, { kind: 'boxes', inflate: 0.04 });
    this.glueGhost = new QuadrantFaceLayer(faceGeo, ghostMat, ORDER_DECALS, 0.5);
    this.glueBead = new QuadrantFaceLayer(beadGeo, beadMat, ORDER_GLUE_BEAD, 0.5);
    this.glueDecal = new QuadrantFaceLayer(faceGeo, decalMat, ORDER_GLUE_DECAL, 0.5 + GLUE_DECAL_LIFT, true);

    this.crack = new THREE.Mesh(this.crackGeo(0xff), crackMat);
    this.crack.renderOrder = ORDER_DECALS;
    this.crack.matrixAutoUpdate = false;
    this.crack.visible = false;

    this.placement = new THREE.Mesh(this.cellBox, placeMat);
    this.placement.renderOrder = ORDER_CELLS;
    this.placement.matrixAutoUpdate = false;
    this.placement.visible = false;

    const lineMat = (hex: number, opacity: number): THREE.LineBasicNodeMaterial => {
      const m = new THREE.LineBasicNodeMaterial({ transparent: opacity < 1, opacity, depthWrite: false });
      m.fog = false;
      const c = new THREE.Color(hex);
      m.colorNode = encodeOutput(applyFogNode(u, vec3(c.r, c.g, c.b), cameraRelativePosition()));
      this.materials.push(m);
      return m;
    };
    this.outline = new THREE.LineSegments(this.outlineGeo(0xff), lineMat(0x101418, 0.75));
    this.outline.renderOrder = ORDER_LINES;
    this.outline.matrixAutoUpdate = false;
    this.outline.visible = false;
    this.octant = new THREE.LineSegments(this.octantGeo(0), lineMat(0xfff4c2, 0.95));
    this.octant.renderOrder = ORDER_LINES;
    this.octant.matrixAutoUpdate = false;
    this.octant.visible = false;

    this.glueLayerU.value = Math.max(0, tileLayer('glue_face'));
  }

  /** The target outline of an octant mask (kept per mask). */
  private outlineGeo(fill: number): THREE.BufferGeometry {
    let g = this.outlineGeos[fill];
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(outlineSegments(fill, OUTLINE_INFLATE), 3));
      g.computeBoundingSphere();
      this.outlineGeos[fill] = g;
    }
    return g;
  }

  /** The chisel's highlight of one octant (kept per octant). */
  private octantGeo(o: number): THREE.BufferGeometry {
    let g = this.octantGeos[o];
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(outlineSegments(1 << o, OCTANT_INFLATE), 3));
      g.computeBoundingSphere();
      this.octantGeos[o] = g;
    }
    return g;
  }

  /** The crack shell of an octant mask (kept per mask). */
  private crackGeo(fill: number): THREE.BufferGeometry {
    return (this.crackGeos[fill] ??= toThree(crackShell(fill, CRACK_OFFSET)));
  }

  /**
   * The placement preview of `item` over `fill` (kept per item and mask): the octants' outer
   * surface with the block's face tiles; null when the item has no cube-like block look.
   */
  private placementGeo(item: number, fill: number): THREE.BufferGeometry | null {
    const key = item * 256 + fill;
    let g = this.placementGeos.get(key);
    if (g === undefined) {
      const v = item > 0 && item <= 0x3ff ? cubeTilesForCell(makeCell(item)) : null;
      g = null;
      if (v !== null && fill !== 0) {
        g = toThree(crackShell(fill, PLACEMENT_INFLATE));
        const n = g.getAttribute('normal');
        const layers = new Uint16Array(n.count);
        for (let i = 0; i < n.count; i++) layers[i] = v.tiles[dirOfNormal(n.getX(i), n.getY(i), n.getZ(i))]!;
        const layer = new THREE.BufferAttribute(layers, 1);
        layer.gpuType = THREE.IntType;
        g.setAttribute('layer', layer);
      }
      this.placementGeos.set(key, g);
    }
    return g;
  }

  /**
   * Applies the overlay state. `anchor` must be an integer vector near the camera; the caller
   * places the world overlay root (resolve(0)) at it.
   */
  update(o: OverlayState, resolve: ParentResolver, topology: number, anchor: OverlayAnchor = ZERO_ANCHOR): void {
    const t = o.target;
    if (t !== null) {
      const g = this.outlineGeo(t.fill & 0xff);
      if (this.outline.geometry !== g) this.outline.geometry = g;
    }
    placeOnCell(this.outline, t, resolve, anchor);
    if (t !== null && o.targetOctant >= 0 && o.targetOctant < 8) {
      const g = this.octantGeo(o.targetOctant);
      if (this.octant.geometry !== g) this.octant.geometry = g;
      placeOnCell(this.octant, t, resolve, anchor);
    } else {
      this.octant.visible = false;
    }
    const stage = crackStage(o.breakProgress);
    const layer = stage >= 0 ? crackLayer(stage) : -1;
    const crackFill = o.breakFill & 0xff;
    if (layer >= 0 && crackFill !== 0 && placeOnCell(this.crack, t, resolve, anchor)) {
      const g = this.crackGeo(crackFill);
      if (this.crack.geometry !== g) this.crack.geometry = g;
      this.crackLayerU.value = layer;
    } else {
      this.crack.visible = false;
    }
    const p = o.placement;
    const pg = p === null ? null : this.placementGeo(p.item, p.fill & 0xff);
    if (p !== null && pg !== null && placeOnCell(this.placement, p, resolve, anchor)) {
      if (this.placement.geometry !== pg) this.placement.geometry = pg;
    } else {
      this.placement.visible = false;
    }
    this.preview.update(o.preview, resolve, topology, anchor);
    this.conflicts.update(o.conflicts, resolve, topology, anchor);
    if (o.glue !== this.glueList) {
      this.glueList = o.glue;
      this.coveredGlue = o.glue.filter((f) => f.covered);
      this.exposedGlue = o.glue.filter((f) => !f.covered);
    }
    this.glueGhost.update(this.coveredGlue, resolve, topology, anchor);
    this.glueBead.update(this.coveredGlue, resolve, topology, anchor);
    this.glueDecal.update(this.exposedGlue, resolve, topology, anchor);
  }

  /** Objects covering every overlay pipeline, for warm-up compilation. */
  warmupObjects(): THREE.Object3D[] {
    const crack = new THREE.Mesh(this.crackGeo(0xff), this.crack.material);
    const outline = new THREE.LineSegments(this.outlineGeo(0xff), this.outline.material);
    const octant = new THREE.LineSegments(this.octantGeo(0), this.octant.material);
    // Any block with a cube look; its geometry carries the integer tile attribute the material reads.
    const placement = new THREE.Mesh(this.placementGeo(B.STONE, 0xff)!, this.placement.material);
    return [
      crack,
      outline,
      octant,
      placement,
      this.preview.warmupMesh(),
      this.conflicts.warmupMesh(),
      this.glueGhost.warmupMesh(),
      this.glueBead.warmupMesh(),
      this.glueDecal.warmupMesh(),
    ];
  }

  /** Called when the tile texture changes (glue tile layer may move). */
  refreshTiles(): void {
    this.glueLayerU.value = Math.max(0, tileLayer('glue_face'));
  }

  get instances(): number {
    return this.preview.drawn + this.conflicts.drawn + this.glueBead.drawn + this.glueDecal.drawn;
  }

  dispose(): void {
    this.preview.dispose();
    this.conflicts.dispose();
    this.glueGhost.dispose();
    this.glueBead.dispose();
    this.glueDecal.dispose();
    this.outline.removeFromParent();
    this.octant.removeFromParent();
    this.crack.removeFromParent();
    this.placement.removeFromParent();
    this.cellBox.dispose();
    for (const list of [this.outlineGeos, this.crackGeos, this.octantGeos, this.faceGeos, this.beadGeos]) {
      for (const g of list) g?.dispose();
      list.fill(undefined);
    }
    this.placementGeos.forEach((g) => g?.dispose());
    this.placementGeos.clear();
    for (const m of this.materials) m.dispose();
  }
}
