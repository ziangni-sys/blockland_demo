/**
 * Synthetic content for the render harness, written against the contracts only (no mesher,
 * art or worldgen modules): procedural tiles for every TILE_NAMES entry, a small voxel world
 * with a lake, a harness-only mesher producing MeshData (face culling, AO, smooth light,
 * liquid surfaces, plants), and structure meshes for a ship hull and a windmill rotor.
 */
import { BLOCKS, TILE_NAMES } from '../../src/blocks/registry';
import { B } from '../../src/blocks/defs';
import type { TileTextureData, DryVolume } from '../../src/render/backend';
import type { GeometryData, MeshData } from '../../src/mesh/types';
import { VFLAG_EMISSIVE, VFLAG_LIQUID_SURFACE, VFLAG_PLANT } from '../../src/mesh/types';
import { hash3, Rng } from '../../src/core/rng';

// ------------------------------------------------------------------ tiles

const T = 16;

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Painter = (x: number, y: number, n: number) => [number, number, number, number];

/** Base colour per tile family; y = 0 is the TOP row of the image (TileTextureData convention). */
function painterFor(name: string): Painter {
  const jitter = (r: number, g: number, b: number, amt: number): Painter => (_x, _y, n) => {
    const k = 1 + (n - 0.5) * amt;
    return [r * k, g * k, b * k, 255];
  };
  if (name === 'turf_top') return jitter(92, 160, 64, 0.35);
  if (name === 'turf_side') return (x, y, n) => (y < 3 + ((x * 7) % 3) ? [92 * (0.85 + n * 0.3), 160 * (0.85 + n * 0.3), 64, 255] : [134 * (0.8 + n * 0.4), 96 * (0.8 + n * 0.4), 62, 255]);
  if (name === 'dirt') return jitter(134, 96, 62, 0.4);
  if (name === 'stone') return jitter(128, 128, 132, 0.3);
  if (name === 'cobble') return (x, y, n) => {
    const edge = (x % 5 === 0 || (y + (x > 7 ? 2 : 0)) % 5 === 0) ? 0.7 : 1;
    const k = (0.85 + n * 0.3) * edge;
    return [120 * k, 120 * k, 124 * k, 255];
  };
  if (name === 'sand') return jitter(222, 206, 150, 0.15);
  if (name === 'gravel') return jitter(140, 132, 128, 0.6);
  if (name === 'deeprock') return jitter(50, 50, 56, 0.6);
  if (name.startsWith('log_') && name.endsWith('_side')) return (x, _y, n) => {
    const stripe = x % 4 === 0 ? 0.75 : 1;
    return [110 * stripe * (0.9 + n * 0.2), 78 * stripe, 46 * stripe, 255];
  };
  if (name.startsWith('log_') && name.endsWith('_end')) return (x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    const ring = Math.floor(d) % 3 === 0 ? 0.8 : 1;
    return d > 7 ? [110, 78, 46, 255] : [190 * ring, 150 * ring, 96 * ring, 255];
  };
  if (name.startsWith('planks')) return (x, y, n) => {
    const seam = y % 4 === 0 || (x + (Math.floor(y / 4) % 2) * 8) % 16 === 0 ? 0.72 : 1;
    const k = seam * (0.92 + n * 0.16);
    return name.includes('pine') ? [150 * k, 110 * k, 70 * k, 255] : [176 * k, 136 * k, 84 * k, 255];
  };
  if (name.startsWith('leaves')) return (x, y, n) => {
    const hole = hash3(x, y, 7, hashName(name)) % 5 === 0;
    const k = 0.75 + n * 0.5;
    return hole ? [0, 0, 0, 0] : name.includes('pine') ? [40 * k, 100 * k, 60 * k, 255] : [60 * k, 132 * k, 44 * k, 255];
  };
  if (name === 'glass') return (x, y) => {
    const frame = x === 0 || y === 0 || x === 15 || y === 15;
    const glint = (x + y === 6 || x + y === 7) && x > 1 && y > 1;
    return frame ? [200, 225, 235, 255] : glint ? [255, 255, 255, 180] : [0, 0, 0, 0];
  };
  if (name === 'water_still' || name === 'water_flow') return (_x, _y, n) => [40 + n * 20, 96 + n * 30, 190 + n * 25, 170];
  if (name === 'lava_still' || name === 'lava_flow') return (_x, _y, n) => [240, 90 + n * 90, 20, 255];
  if (name === 'bricks') return (x, y) => {
    // Up arrow in the top-left corner: verifies v orientation (arrow must point up on walls).
    const arrow = (y >= 1 && y <= 6 && x === 3) || (y === 2 && (x === 2 || x === 4)) || (y === 1 && x === 3);
    if (arrow) return [250, 250, 250, 255];
    const mortar = y % 4 === 3 || (x + (Math.floor(y / 4) % 2) * 4) % 8 === 7;
    return mortar ? [200, 196, 186, 255] : [160, 66, 50, 255];
  };
  if (name === 'stone_bricks') return (x, y, n) => {
    const mortar = y % 8 === 7 || (x + (Math.floor(y / 8) % 2) * 8) % 16 === 15;
    const k = mortar ? 0.6 : 0.9 + n * 0.2;
    return [130 * k, 130 * k, 136 * k, 255];
  };
  if (name.startsWith('wool_') || name === 'canvas') return (x, y, n) => {
    const base: Record<string, [number, number, number]> = {
      wool_white: [235, 235, 230], wool_red: [196, 52, 48], wool_orange: [232, 128, 40], wool_yellow: [236, 206, 60],
      wool_green: [80, 150, 60], wool_blue: [52, 84, 190], wool_purple: [128, 64, 170], wool_black: [36, 36, 40], canvas: [226, 214, 182],
    };
    const c = base[name] ?? [200, 200, 200];
    const weave = (x + y) % 2 === 0 ? 0.95 : 1.02;
    const k = weave * (0.94 + n * 0.12);
    return [c[0] * k, c[1] * k, c[2] * k, 255];
  };
  if (name === 'lamp') return (x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    return d > 6.5 ? [120, 100, 70, 255] : [255, 236 - d * 8, 170 - d * 10, 255];
  };
  if (name.startsWith('tnt_')) return (x, y) => {
    if (name === 'tnt_side') {
      const band = y >= 6 && y <= 9;
      const letter = band && (x === 4 || x === 8 || x === 12 || (y === 6 && x >= 3 && x <= 13));
      return letter ? [30, 30, 30, 255] : band ? [236, 230, 210, 255] : [196, 58, 40, 255];
    }
    return Math.hypot(x - 7.5, y - 7.5) < 3 ? [60, 60, 60, 255] : [180, 52, 36, 255];
  };
  if (name === 'flower_red' || name === 'flower_yellow' || name === 'tall_grass') return (x, y) => {
    const stem = x >= 7 && x <= 8 && y > 6;
    const blade = name === 'tall_grass' && (Math.abs(x - 3 - y * 0.1) < 1 || Math.abs(x - 12 + y * 0.1) < 1 || stem) && y > 3;
    const bloom = name !== 'tall_grass' && Math.hypot(x - 7.5, y - 4) < 3.2;
    if (bloom) return name === 'flower_red' ? [220, 40, 60, 255] : [250, 210, 40, 255];
    if (stem || blade) return [70, 150, 50, 255];
    return [0, 0, 0, 0];
  };
  if (name === 'torch') return (x, y) => (x >= 7 && x <= 8 && y >= 6 ? [120, 90, 50, 255] : x >= 6 && x <= 9 && y >= 3 && y < 6 ? [255, 200, 80, 255] : [0, 0, 0, 0]);
  if (name.startsWith('crack_')) {
    const stage = Number(name.slice(6));
    return (x, y) => {
      const h = hash3(x, y, 3, 99) % 100;
      const line = Math.abs(x - y) < 1 || Math.abs(x + y - 15) < 1 || (y === 8 && x > 3) || (x === 5 && y < 10);
      return line && h < 30 + stage * 10 ? [20, 20, 20, 200] : [0, 0, 0, 0];
    };
  }
  if (name === 'glue_face') return (x, y) => {
    const dot = (x % 4 === 1 && y % 4 === 1) || (x % 4 === 3 && y % 4 === 3);
    const border = x === 0 || y === 0 || x === 15 || y === 15;
    return dot ? [255, 236, 90, 230] : border ? [255, 220, 60, 160] : [0, 0, 0, 0];
  };
  if (name.startsWith('item_')) return (x, y) => {
    if (name === 'item_glue') {
      const body = x >= 5 && x <= 10 && y >= 5 && y <= 14;
      const cap = x >= 6 && x <= 9 && y >= 2 && y < 5;
      return body ? [240, 240, 232, 255] : cap ? [250, 180, 40, 255] : [0, 0, 0, 0];
    }
    const bucket = x >= 3 && x <= 12 && y >= 5 && y <= 14 && x - 3 >= (y - 5) * 0.2 && 12 - x >= (y - 5) * 0.2;
    const fill = name === 'item_bucket_water' ? [60, 110, 220] : name === 'item_bucket_lava' ? [240, 110, 20] : [150, 150, 160];
    return bucket ? (y < 8 ? [fill[0]!, fill[1]!, fill[2]!, 255] : [170, 170, 180, 255]) : [0, 0, 0, 0];
  };
  if (name.startsWith('helm') || name.startsWith('bearing') || name.startsWith('propeller')) return (x, y, n) => {
    const ring = Math.abs(Math.hypot(x - 7.5, y - 7.5) - 5) < 1.2;
    return ring ? [200, 170, 90, 255] : [110 + n * 30, 86, 60, 255];
  };
  if (name.startsWith('cactus')) return (x, y, n) => (x % 5 === 2 ? [200, 220, 140, 255] : [60 + n * 30, 140, 60, 255]);
  if (name === 'snow') return jitter(240, 244, 250, 0.08);
  if (name === 'ice') return (_x, _y, n) => [170, 205, 245, 190 + n * 20];
  // Anything else: a calm colour derived from the name.
  const h = hashName(name);
  return jitter(80 + (h & 127), 80 + ((h >> 7) & 127), 80 + ((h >> 14) & 127), 0.25);
}

export function makeTiles(): TileTextureData {
  const count = TILE_NAMES.length;
  const pixels = new Uint8Array(T * T * 4 * count);
  for (let l = 0; l < count; l++) {
    const name = TILE_NAMES[l]!;
    const paint = painterFor(name);
    const seed = hashName(name);
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const n = (hash3(x, y, l, seed) & 1023) / 1023;
        const c = paint(x, y, n);
        const o = (l * T * T + y * T + x) * 4;
        pixels[o] = Math.max(0, Math.min(255, Math.round(c[0])));
        pixels[o + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
        pixels[o + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
        pixels[o + 3] = Math.max(0, Math.min(255, Math.round(c[3])));
      }
    }
  }
  return { size: T, count, pixels };
}

// ------------------------------------------------------------------ voxel box

/** Dense box of block ids (no state) with optional light, origin at (ox, oy, oz) in its parent space. */
export class VoxelBox {
  readonly cells: Uint16Array;
  readonly sky: Uint8Array;
  readonly block: Uint8Array;
  constructor(
    readonly sx: number,
    readonly sy: number,
    readonly sz: number,
  ) {
    this.cells = new Uint16Array(sx * sy * sz);
    this.sky = new Uint8Array(sx * sy * sz);
    this.block = new Uint8Array(sx * sy * sz);
  }
  idx(x: number, y: number, z: number): number {
    return x + z * this.sx + y * this.sx * this.sz;
  }
  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }
  get(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.cells[this.idx(x, y, z)]! : B.AIR;
  }
  set(x: number, y: number, z: number, id: number): void {
    if (this.inside(x, y, z)) this.cells[this.idx(x, y, z)] = id;
  }
}

const isOpaque = (id: number): boolean => !!BLOCKS[id]?.opaque;
const shapeOf = (id: number): string => BLOCKS[id]?.shape ?? 'none';
const layerOf = (id: number): 'opaque' | 'cutout' | 'translucent' => BLOCKS[id]?.layer ?? 'opaque';

/** Sky light BFS (15 from above, -1 per step, -2 through water) and block light BFS. */
export function computeLight(box: VoxelBox): void {
  const { sx, sy, sz } = box;
  const q: number[] = [];
  box.sky.fill(0);
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      let lvl = 15;
      for (let y = sy - 1; y >= 0; y--) {
        const id = box.get(x, y, z);
        if (isOpaque(id)) break;
        if (BLOCKS[id]?.liquid) lvl = Math.max(0, lvl - 2);
        else if (id === B.LEAVES_OAK || id === B.LEAVES_PINE) lvl = Math.max(0, lvl - 1);
        box.sky[box.idx(x, y, z)] = lvl;
        q.push(box.idx(x, y, z));
      }
    }
  }
  bfs(box, box.sky, q);
  box.block.fill(0);
  q.length = 0;
  for (let i = 0; i < box.cells.length; i++) {
    const e = BLOCKS[box.cells[i]!]?.emit ?? 0;
    if (e > 0) {
      box.block[i] = e;
      q.push(i);
    }
  }
  bfs(box, box.block, q);
}

function bfs(box: VoxelBox, L: Uint8Array, q: number[]): void {
  const { sx, sz } = box;
  const layer = sx * sz;
  for (let h = 0; h < q.length; h++) {
    const i = q[h]!;
    const lvl = L[i]!;
    if (lvl <= 1) continue;
    const y = Math.floor(i / layer);
    const z = Math.floor((i - y * layer) / sx);
    const x = i - y * layer - z * sx;
    const nb = [
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y + 1, z],
      [x, y - 1, z],
      [x, y, z + 1],
      [x, y, z - 1],
    ];
    for (const [nx, ny, nz] of nb) {
      if (!box.inside(nx!, ny!, nz!)) continue;
      const j = box.idx(nx!, ny!, nz!);
      const id = box.cells[j]!;
      if (isOpaque(id)) continue;
      const cost = BLOCKS[id]?.liquid ? 2 : 1;
      const nl = lvl - cost;
      if (nl > L[j]!) {
        L[j] = nl;
        q.push(j);
      }
    }
  }
}

// ------------------------------------------------------------------ mesher (harness only)

class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  layer: number[] = [];
  light: number[] = [];
  idx: number[] = [];
  quad(p: number[], n: [number, number, number], tile: number, lights: number[][], flags: number, uvs?: number[], flip = false): void {
    const base = this.pos.length / 3;
    const U = uvs ?? [0, 0, 1, 0, 1, 1, 0, 1];
    for (let k = 0; k < 4; k++) {
      this.pos.push(p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!);
      this.nrm.push(n[0] * 127, n[1] * 127, n[2] * 127);
      this.uv.push(U[k * 2]!, U[k * 2 + 1]!);
      this.layer.push(tile);
      const l = lights[k]!;
      this.light.push(l[0]!, l[1]!, l[2]!, flags);
    }
    // Flip the diagonal when AO is anisotropic (avoids the classic AO crease).
    if (flip) this.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /**
   * Back copy of the quad just emitted (mesh contract: the renderer culls back faces in every
   * pass, so two-sided faces such as plants and liquids are emitted twice).
   */
  backCopy(): void {
    const v = this.pos.length / 3 - 4;
    const order = [3, 2, 1, 0];
    const base = this.pos.length / 3;
    for (const k of order) {
      const i = v + k;
      this.pos.push(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      this.nrm.push(-this.nrm[i * 3]!, -this.nrm[i * 3 + 1]!, -this.nrm[i * 3 + 2]!);
      this.uv.push(this.uv[i * 2]!, this.uv[i * 2 + 1]!);
      this.layer.push(this.layer[i]!);
      this.light.push(this.light[i * 4]!, this.light[i * 4 + 1]!, this.light[i * 4 + 2]!, this.light[i * 4 + 3]!);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build(): GeometryData | null {
    const v = this.pos.length / 3;
    if (v === 0) return null;
    return {
      vertexCount: v,
      indexCount: this.idx.length,
      positions: new Float32Array(this.pos),
      normals: new Int8Array(this.nrm),
      uvs: new Float32Array(this.uv),
      layers: new Uint16Array(this.layer),
      light: new Uint8Array(this.light),
      indices: new Uint32Array(this.idx),
    };
  }
}

// Unit-cube face corners (CCW from outside, uv u right / v up) — same table as boxgeom.ts.
const FACES: { n: [number, number, number]; c: number[] }[] = [
  { n: [1, 0, 0], c: [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1] },
  { n: [-1, 0, 0], c: [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0] },
  { n: [0, 1, 0], c: [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0] },
  { n: [0, -1, 0], c: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1] },
  { n: [0, 0, 1], c: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1] },
  { n: [0, 0, -1], c: [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0] },
];

function faceTile(id: number, f: number): number {
  const def = BLOCKS[id]!;
  const t = def.tileIds;
  if (def.stateKind === 'axis') return (f >> 1) === 1 ? t[1]! : t[0]!;
  if (def.shape === 'bearing') return f === 4 ? t[0]! : f === 5 ? t[1]! : t[2]!;
  if (t.length >= 6) return t[f]!;
  return t[0]!;
}

export interface MeshRegion {
  box: VoxelBox;
  /** Region of the box to mesh (min inclusive), size. */
  x0: number;
  y0: number;
  z0: number;
  sx: number;
  sy: number;
  sz: number;
  /** null light = structure: sky 255, block 0. */
  lit: boolean;
}

/** Meshes a region of a voxel box; positions relative to (x0, y0, z0). */
export function meshRegion(r: MeshRegion): MeshData {
  const { box } = r;
  const G = { opaque: new GeoBuilder(), cutout: new GeoBuilder(), translucent: new GeoBuilder() };
  const occ = (x: number, y: number, z: number): number => (isOpaque(box.get(x, y, z)) ? 1 : 0);
  const lightAt = (x: number, y: number, z: number): [number, number] => {
    if (!r.lit) return [15, 0];
    if (!box.inside(x, y, z)) return [15, 0];
    const i = box.idx(x, y, z);
    return [box.sky[i]!, box.block[i]!];
  };
  for (let y = r.y0; y < r.y0 + r.sy; y++) {
    for (let z = r.z0; z < r.z0 + r.sz; z++) {
      for (let x = r.x0; x < r.x0 + r.sx; x++) {
        const id = box.get(x, y, z);
        if (id === B.AIR) continue;
        const def = BLOCKS[id]!;
        const lx = x - r.x0;
        const ly = y - r.y0;
        const lz = z - r.z0;
        if (def.shape === 'cross') {
          const [s, b] = lightAt(x, y, z);
          const L = [s * 17, b * 17, 255];
          const t = def.tileIds[0]!;
          const d = 0.15;
          G.cutout.quad([lx + d, ly, lz + d, lx + 1 - d, ly, lz + 1 - d, lx + 1 - d, ly + 1, lz + 1 - d, lx + d, ly + 1, lz + d], [0.7, 0, -0.7], t, [L, L, L, L], VFLAG_PLANT);
          G.cutout.backCopy();
          G.cutout.quad([lx + 1 - d, ly, lz + d, lx + d, ly, lz + 1 - d, lx + d, ly + 1, lz + 1 - d, lx + 1 - d, ly + 1, lz + d], [0.7, 0, 0.7], t, [L, L, L, L], VFLAG_PLANT);
          G.cutout.backCopy();
          continue;
        }
        const liquid = def.liquid !== 0;
        const emissive = def.emit > 0 && (def.shape === 'cube' || liquid);
        const pass = layerOf(id);
        for (let f = 0; f < 6; f++) {
          const fn = FACES[f]!;
          const nx = x + fn.n[0];
          const ny = y + fn.n[1];
          const nz = z + fn.n[2];
          const nid = box.get(nx, ny, nz);
          if (isOpaque(nid)) continue;
          if (nid === id && (liquid || pass !== 'opaque')) continue;
          if (liquid && f !== 2 && BLOCKS[nid]?.solid) continue;
          if (liquid && f === 3) continue;
          const top = liquid && box.get(x, y + 1, z) !== id ? 0.875 : 1;
          const p: number[] = [];
          const lights: number[][] = [];
          const aos: number[] = [];
          for (let k = 0; k < 4; k++) {
            const cx = fn.c[k * 3]!;
            const cy = fn.c[k * 3 + 1]!;
            const cz = fn.c[k * 3 + 2]!;
            p.push(lx + cx, ly + (cy === 1 ? top : 0), lz + cz);
            // AO + smooth light from the 4 cells around this corner in the neighbour layer.
            const ax = fn.n[0] !== 0 ? 0 : cx === 1 ? 1 : -1;
            const ay = fn.n[1] !== 0 ? 0 : cy === 1 ? 1 : -1;
            const az = fn.n[2] !== 0 ? 0 : cz === 1 ? 1 : -1;
            // Two tangent offsets.
            const t1 = fn.n[0] !== 0 ? [0, ay, 0] : [ax, 0, 0];
            const t2 = fn.n[2] !== 0 ? [0, ay, 0] : [0, 0, az];
            const s1 = occ(nx + t1[0]!, ny + t1[1]!, nz + t1[2]!);
            const s2 = occ(nx + t2[0]!, ny + t2[1]!, nz + t2[2]!);
            const cr = occ(nx + t1[0]! + t2[0]!, ny + t1[1]! + t2[1]!, nz + t1[2]! + t2[2]!);
            const ao = s1 && s2 ? 0 : 3 - (s1 + s2 + cr);
            aos.push(ao);
            let ss = 0;
            let bb = 0;
            let c = 0;
            const samples = [
              [nx, ny, nz],
              [nx + t1[0]!, ny + t1[1]!, nz + t1[2]!],
              [nx + t2[0]!, ny + t2[1]!, nz + t2[2]!],
              [nx + t1[0]! + t2[0]!, ny + t1[1]! + t2[1]!, nz + t1[2]! + t2[2]!],
            ];
            for (let si = 0; si < 4; si++) {
              const sp = samples[si]!;
              if (si > 0 && occ(sp[0]!, sp[1]!, sp[2]!)) continue;
              if (si === 3 && s1 && s2) continue;
              const [sl, bl] = lightAt(sp[0]!, sp[1]!, sp[2]!);
              ss += sl;
              bb += bl;
              c++;
            }
            lights.push([Math.round((ss / c) * 17), Math.round((bb / c) * 17), Math.round((ao / 3) * 255)]);
          }
          const flags = (emissive ? VFLAG_EMISSIVE : 0) | (liquid && f === 2 ? VFLAG_LIQUID_SURFACE : 0);
          // Side faces of liquids: top vertices bob with the surface too.
          if (liquid && f !== 2) {
            const g = G[pass];
            const base = g.pos.length / 3;
            g.quad(p, fn.n, faceTile(id, f), lights, emissive ? VFLAG_EMISSIVE : 0, [0, 0, 1, 0, 1, top, 0, top]);
            g.light[(base + 2) * 4 + 3] |= top < 1 ? VFLAG_LIQUID_SURFACE : 0;
            g.light[(base + 3) * 4 + 3] |= top < 1 ? VFLAG_LIQUID_SURFACE : 0;
            g.backCopy();
            continue;
          }
          const flip = aos[0]! + aos[2]! < aos[1]! + aos[3]!;
          G[pass].quad(p, fn.n, faceTile(id, f), lights, flags, undefined, flip);
          if (liquid) G[pass].backCopy();
        }
      }
    }
  }
  return { opaque: G.opaque.build(), cutout: G.cutout.build(), translucent: G.translucent.build() };
}

// ------------------------------------------------------------------ the demo world

export const WORLD_X = 96;
export const WORLD_Y = 80;
export const WORLD_Z = 96;
export const WATER_TOP = 47; // SEA_LEVEL - 1

export function buildWorld(): VoxelBox {
  const w = new VoxelBox(WORLD_X, WORLD_Y, WORLD_Z);
  const rng = new Rng(42);
  const height = (x: number, z: number): number => {
    const h = 50 + Math.sin(x * 0.11) * 3 + Math.cos(z * 0.09) * 3 + Math.sin((x + z) * 0.05) * 4;
    // Lake basin in the middle.
    const d = Math.hypot(x - 48, z - 52);
    const basin = Math.max(0, 1 - d / 26);
    return Math.floor(h - basin * basin * 14);
  };
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const h = height(x, z);
      for (let y = 0; y <= h; y++) {
        let id: number = B.STONE;
        if (y === 0) id = B.DEEPROCK;
        else if (y > h - 3) id = h <= WATER_TOP + 1 ? B.SAND : y === h ? B.TURF : B.DIRT;
        w.set(x, y, z, id);
      }
      for (let y = h + 1; y <= WATER_TOP; y++) w.set(x, y, z, B.WATER);
      if (h > WATER_TOP + 1) {
        const r = rng.next();
        if (r < 0.04) w.set(x, h + 1, z, B.TALL_GRASS);
        else if (r < 0.05) w.set(x, h + 1, z, B.FLOWER_RED);
        else if (r < 0.06) w.set(x, h + 1, z, B.FLOWER_YELLOW);
      }
    }
  }
  // A few trees.
  const trees = [
    [14, 18],
    [22, 80],
    [78, 20],
    [84, 74],
    [70, 86],
    [12, 50],
  ];
  for (const [tx, tz] of trees) {
    const h = height(tx!, tz!);
    for (let y = h + 1; y <= h + 5; y++) w.set(tx!, y, tz!, B.LOG_OAK);
    for (let dy = 3; dy <= 6; dy++) {
      const r = dy >= 6 ? 1 : 2;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && dy > 4) continue;
        if (w.get(tx! + dx, h + dy, tz! + dz) === B.AIR || w.get(tx! + dx, h + dy, tz! + dz) === B.TALL_GRASS) w.set(tx! + dx, h + dy, tz! + dz, B.LEAVES_OAK);
      }
    }
  }
  // A small brick hut with a glass window and a lamp inside (block light, emissive faces).
  const hx = 70;
  const hz = 40;
  const hy = height(hx, hz) + 1;
  for (let y = hy; y < hy + 4; y++) for (let z = hz; z < hz + 6; z++) for (let x = hx; x < hx + 6; x++) {
    const wall = x === hx || x === hx + 5 || z === hz || z === hz + 5;
    if (wall || y === hy + 3) w.set(x, y, z, B.BRICKS);
    else w.set(x, y, z, B.AIR);
  }
  w.set(hx + 2, hy, hz, B.AIR);
  w.set(hx + 2, hy + 1, hz, B.AIR);
  w.set(hx + 5, hy + 1, hz + 2, B.GLASS);
  w.set(hx + 5, hy + 1, hz + 3, B.GLASS);
  w.set(hx + 3, hy, hz + 3, B.LAMP);
  // Lava pool next to the hut.
  for (let z = 30; z < 33; z++) for (let x = 60; x < 64; x++) {
    const h = height(x, z);
    w.set(x, h, z, B.LAVA);
  }
  // Windmill tower: stone bricks with a bearing facing south (+Z) at the top.
  const tx = 30;
  const tz = 30;
  const th = height(tx, tz);
  for (let y = th + 1; y <= th + 9; y++) for (let z = tz; z < tz + 2; z++) for (let x = tx; x < tx + 2; x++) w.set(x, y, z, B.STONE_BRICKS);
  w.set(tx, th + 9, tz + 2, B.BEARING);
  // A frozen corner of the lake: ice on the top water layer (translucent, but no water
  // effects: it must stay perfectly still).
  for (let z = 58; z < 64; z++) for (let x = 33; x < 39; x++) if (w.get(x, WATER_TOP, z) === B.WATER) w.set(x, WATER_TOP, z, B.ICE);
  computeLight(w);
  return w;
}

export function windmillAnchor(world: VoxelBox): { x: number; y: number; z: number } {
  // Bearing cell is (30, th + 9, 32); the rotor's axis cell sits in front of it (+Z).
  for (let y = WORLD_Y - 1; y > 0; y--) if (world.get(30, y, 32) === B.BEARING) return { x: 30, y, z: 33 };
  return { x: 30, y: 60, z: 33 };
}

// ------------------------------------------------------------------ structures

export interface StructureDemo {
  mesh: MeshData;
  /** Local origin of the meshed box (added to vertex positions). */
  ox: number;
  oy: number;
  oz: number;
  pivot: [number, number, number];
  dry: DryVolume | null;
}

/** A small planked boat: hull, deck with a hatch, mast and a canvas sail; dry interior below deck. */
export function buildShip(): StructureDemo {
  const L = 13;
  const H = 9;
  const W = 7;
  const box = new VoxelBox(L, H, W);
  for (let x = 0; x < L; x++) {
    // Tapered bow / stern.
    const taper = x < 2 ? 2 - x : x > L - 3 ? x - (L - 3) : 0;
    for (let z = taper; z < W - taper; z++) {
      box.set(x, 0, z, B.PLANKS_PINE);
      for (let y = 1; y <= 3; y++) {
        const edge = z === taper || z === W - 1 - taper || x === 0 || x === L - 1;
        if (edge) box.set(x, y, z, B.PLANKS_OAK);
      }
      // Deck at y = 3 except a hatch.
      const hatch = x >= 5 && x <= 6 && z >= 2 && z <= 3;
      if (!hatch) box.set(x, 3, z, B.PLANKS_PINE);
    }
  }
  // Mast and sail.
  for (let y = 4; y < H; y++) box.set(8, y, 3, B.LOG_PINE);
  for (let y = 5; y < H; y++) for (let z = 1; z <= 5; z++) if (z !== 3) box.set(9, y, z, B.CANVAS);
  box.set(3, 4, 3, B.HELM);
  const mesh = meshRegion({ box, x0: 0, y0: 0, z0: 0, sx: L, sy: H, sz: W, lit: false });
  // Dry volume: interior air cells below the deck (y 1..3) inside the hull walls.
  const dry: DryVolume = { ox: 0, oy: 1, oz: 0, sx: L, sy: 3, sz: W, mask: new Uint8Array(L * 3 * W) };
  for (let y = 1; y <= 3; y++) for (let z = 0; z < W; z++) for (let x = 0; x < L; x++) {
    const taper = x < 2 ? 2 - x : x > L - 3 ? x - (L - 3) : 0;
    // Interior air inside the hull walls (including under the open hatch) is dry.
    if (z > taper && z < W - 1 - taper && x > 0 && x < L - 1 && box.get(x, y, z) === B.AIR) dry.mask[x + z * L + (y - 1) * L * W] = 1;
  }
  return { mesh, ox: 0, oy: 0, oz: 0, pivot: [L / 2, 1.5, W / 2], dry };
}

/** Four canvas / felt sails around a log hub; axis along local Z through the hub cell centre. */
export function buildRotor(): StructureDemo {
  const S = 11;
  const box = new VoxelBox(S, S, 1);
  const c = 5;
  box.set(c, c, 0, B.LOG_OAK);
  for (let i = 1; i <= 5; i++) {
    box.set(c + i, c, 0, B.LOG_PINE);
    box.set(c - i, c, 0, B.LOG_PINE);
    box.set(c, c + i, 0, B.LOG_PINE);
    box.set(c, c - i, 0, B.LOG_PINE);
    if (i >= 2) {
      box.set(c + i, c + 1, 0, B.CANVAS);
      box.set(c - i, c - 1, 0, B.WOOL_RED);
      box.set(c - 1, c + i, 0, B.CANVAS);
      box.set(c + 1, c - i, 0, B.WOOL_RED);
    }
  }
  const mesh = meshRegion({ box, x0: 0, y0: 0, z0: 0, sx: S, sy: S, sz: 1, lit: false });
  return { mesh, ox: -c, oy: -c, oz: 0, pivot: [0.5, 0.5, 0.5], dry: null };
}

/**
 * A small open raft laid out exactly like src/structures/hull.ts analyses it: 7 x 5 planks
 * floor at local y 0, 2-high walls at y 1..2, analysed box = tight bounds grown by one cell
 * (so the mask layer below the bilge is the non-dry floor). Interior air at y 1..2 is dry.
 */
export function buildRaft(): StructureDemo {
  const L = 7;
  const W = 5;
  const box = new VoxelBox(L, 3, W);
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < L; x++) {
      box.set(x, 0, z, B.PLANKS_OAK);
      if (x === 0 || z === 0 || x === L - 1 || z === W - 1) for (let y = 1; y <= 2; y++) box.set(x, y, z, B.PLANKS_PINE);
    }
  }
  const mesh = meshRegion({ box, x0: 0, y0: 0, z0: 0, sx: L, sy: 3, sz: W, lit: false });
  const sx = L + 2;
  const sy = 3 + 2;
  const sz = W + 2;
  const dry: DryVolume = { ox: -1, oy: -1, oz: -1, sx, sy, sz, mask: new Uint8Array(sx * sy * sz) };
  for (let y = 1; y <= 2; y++) for (let z = 1; z < W - 1; z++) for (let x = 1; x < L - 1; x++) dry.mask[x + 1 + (z + 1) * sx + (y + 1) * sx * sz] = 1;
  return { mesh, ox: 0, oy: 0, oz: 0, pivot: [L / 2, 0, W / 2], dry };
}
