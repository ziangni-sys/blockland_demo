/**
 * Overlays: target outline, mining cracks, assembly preview / conflict cells, glue decals and
 * the glue anchor. Cells with structureId != 0 are in that structure's local cell space; their
 * objects are parented to the structure's group so they follow its pose exactly.
 *
 * Instanced cell layers re-upload instance matrices only when the cell list content changed
 * (cheap order-sensitive hash), so a client that re-sends the same lists every frame costs one
 * pass over them and nothing else.
 */
import * as THREE from 'three/webgpu';
import { abs, Discard, float, Fn, max, positionWorld, sin, smoothstep, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { OverlayCell, OverlayFace, OverlayState } from '../backend';
import { boxEdges } from './boxgeom';
import { crackLayer, crackStage, tileLayer } from './blocktiles';
import { applyFogNode, encodeOutput, type SharedUniforms } from './shading';

/** Resolves the parent object of a structure id (0 = world overlay root); null = unknown structure. */
export type ParentResolver = (structureId: number) => THREE.Object3D | null;

/** Render orders inside the transparent list: after water, before nothing else. */
const ORDER_CELLS = 60;
const ORDER_DECALS = 61;
const ORDER_LINES = 62;

// Face rotations mapping the decal quad's +Z normal onto each Dir, column-major 3x3.
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

/** A set of instanced meshes (one per parent structure) drawing one cell list. */
class InstancedCellLayer {
  private readonly meshes = new Map<number, THREE.InstancedMesh>();
  private readonly counts = new Map<number, number>();
  private readonly fill = new Map<number, number>();
  private lastHash = -1;
  private lastLen = -1;
  /** Bumped by the backend whenever structures appear / disappear, to force re-parenting. */
  private lastTopology = -1;

  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly order: number,
    private readonly faces: boolean,
    private readonly inflate: number,
  ) {}

  update(cells: readonly OverlayCell[], resolve: ParentResolver, topology: number): void {
    const hash = cellsHash(cells, this.faces);
    if (hash === this.lastHash && cells.length === this.lastLen && topology === this.lastTopology) return;
    this.lastHash = hash;
    this.lastLen = cells.length;
    this.lastTopology = topology;

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
      if (m.parent !== parent) parent.add(m);
      m.count = 0;
      m.visible = true;
      this.fill.set(id, 0);
    });
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const m = this.meshes.get(c.structureId);
      const k = this.fill.get(c.structureId);
      if (!m || k === undefined || !m.parent) continue;
      this.writeMatrix(m.instanceMatrix.array as Float32Array, k * 16, c);
      this.fill.set(c.structureId, k + 1);
      m.count = k + 1;
    }
    this.meshes.forEach((m) => {
      if (m.count > 0) m.instanceMatrix.needsUpdate = true;
    });
  }

  private writeMatrix(a: Float32Array, o: number, c: OverlayCell): void {
    if (!this.faces) {
      const s = 1 + this.inflate;
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
      a[o + 12] = c.x + 0.5;
      a[o + 13] = c.y + 0.5;
      a[o + 14] = c.z + 0.5;
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
    const off = 0.5 + this.inflate;
    a[o + 12] = c.x + 0.5 + DIR_X[d]! * off;
    a[o + 13] = c.y + 0.5 + DIR_Y[d]! * off;
    a[o + 14] = c.z + 0.5 + DIR_Z[d]! * off;
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

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** A single object (outline / crack shell) placed on one cell of some grid. */
function placeOnCell(obj: THREE.Object3D, cell: OverlayCell | null, resolve: ParentResolver): boolean {
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
  obj.position.set(cell.x, cell.y, cell.z);
  obj.updateMatrix();
  obj.visible = true;
  return true;
}

export class OverlayLayer {
  private readonly cellBox: THREE.BoxGeometry;
  private readonly decalQuad: THREE.PlaneGeometry;
  private readonly crackBox: THREE.BoxGeometry;
  private readonly outlineGeo: THREE.BufferGeometry;
  private readonly anchorGeo: THREE.BufferGeometry;
  private readonly outline: THREE.LineSegments;
  private readonly anchor: THREE.Mesh;
  private readonly crack: THREE.Mesh;
  private readonly preview: InstancedCellLayer;
  private readonly conflicts: InstancedCellLayer;
  private readonly glue: InstancedCellLayer;
  private readonly crackLayerU = uniform(0, 'int');
  private readonly glueLayerU = uniform(0, 'int');
  readonly materials: THREE.Material[] = [];

  constructor(u: SharedUniforms, placeholder: THREE.DataArrayTexture, tileNodes: THREE.TextureNode[]) {
    this.cellBox = new THREE.BoxGeometry(1, 1, 1);
    this.decalQuad = new THREE.PlaneGeometry(1, 1);
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
        return vec4(encodeOutput(applyFogNode(u, tint.mul(rim.mul(0.6).add(1)), positionWorld)), a);
      })();
      this.materials.push(m);
      return m;
    };

    const tileMat = (name: string, layerU: typeof this.crackLayerU, alpha: number, brighten: number): THREE.NodeMaterial => {
      const m = new THREE.NodeMaterial();
      m.name = name;
      m.lights = false;
      m.fog = false;
      m.transparent = true;
      m.depthWrite = false;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -2;
      const tex = texture(placeholder, uv()).depth(layerU);
      tileNodes.push(tex);
      m.colorNode = Fn(() => {
        Discard(tex.a.lessThan(0.04));
        return vec4(encodeOutput(applyFogNode(u, tex.rgb.mul(brighten), positionWorld)), tex.a.mul(alpha));
      })();
      this.materials.push(m);
      return m;
    };

    this.preview = new InstancedCellLayer(this.cellBox, cellMat(0x52e0ff, 0.16, 0.5), ORDER_CELLS, false, 0.03);
    this.conflicts = new InstancedCellLayer(this.cellBox, cellMat(0xff3b30, 0.3, 0.55), ORDER_CELLS, false, 0.04);
    this.glue = new InstancedCellLayer(this.decalQuad, tileMat('overlay-glue', this.glueLayerU, 0.95, 1.1), ORDER_DECALS, true, 0.006);

    const crackMat = tileMat('overlay-crack', this.crackLayerU, 0.9, 0.9);
    this.crack = new THREE.Mesh(this.crackBox, crackMat);
    this.crack.renderOrder = ORDER_DECALS;
    this.crack.matrixAutoUpdate = false;
    this.crack.visible = false;

    const lineMat = (hex: number, opacity: number): THREE.LineBasicNodeMaterial => {
      const m = new THREE.LineBasicNodeMaterial({ transparent: opacity < 1, opacity, depthWrite: false });
      m.fog = false;
      const c = new THREE.Color(hex);
      m.colorNode = encodeOutput(applyFogNode(u, vec3(c.r, c.g, c.b), positionWorld));
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
      return vec4(encodeOutput(applyFogNode(u, vec3(gold.r, gold.g, gold.b).mul(pulse), positionWorld)), 1);
    })();
    this.materials.push(anchorMat);
    this.anchor = new THREE.Mesh(this.anchorGeo, anchorMat);
    this.anchor.renderOrder = ORDER_LINES;
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;

    this.glueLayerU.value = Math.max(0, tileLayer('glue_face'));
  }

  update(o: OverlayState, resolve: ParentResolver, topology: number): void {
    placeOnCell(this.outline, o.target, resolve);
    const stage = crackStage(o.breakProgress);
    const layer = stage >= 0 ? crackLayer(stage) : -1;
    if (layer >= 0 && placeOnCell(this.crack, o.target, resolve)) {
      this.crackLayerU.value = layer;
    } else {
      this.crack.visible = false;
    }
    placeOnCell(this.anchor, o.glueAnchor, resolve);
    this.preview.update(o.preview, resolve, topology);
    this.conflicts.update(o.conflicts, resolve, topology);
    this.glue.update(o.glue, resolve, topology);
  }

  /** Objects covering every overlay pipeline, for warm-up compilation. */
  warmupObjects(): THREE.Object3D[] {
    const crack = new THREE.Mesh(this.crackBox, this.crack.material);
    const outline = new THREE.LineSegments(this.outlineGeo, this.outline.material);
    const anchor = new THREE.Mesh(this.anchorGeo, this.anchor.material);
    return [crack, outline, anchor, this.preview.warmupMesh(), this.conflicts.warmupMesh(), this.glue.warmupMesh()];
  }

  /** Called when the tile texture changes (glue tile layer may move). */
  refreshTiles(): void {
    this.glueLayerU.value = Math.max(0, tileLayer('glue_face'));
  }

  get instances(): number {
    return this.preview.drawn + this.conflicts.drawn + this.glue.drawn;
  }

  dispose(): void {
    this.preview.dispose();
    this.conflicts.dispose();
    this.glue.dispose();
    this.outline.removeFromParent();
    this.anchor.removeFromParent();
    this.crack.removeFromParent();
    this.cellBox.dispose();
    this.decalQuad.dispose();
    this.crackBox.dispose();
    this.outlineGeo.dispose();
    this.anchorGeo.dispose();
    for (const m of this.materials) m.dispose();
  }
}
