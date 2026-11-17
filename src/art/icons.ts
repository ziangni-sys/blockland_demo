/**
 * Item icons for the UI (hotbar, inventory, creative palette). Pure: returns RGBA bytes that
 * the UI blits through ImageData. No DOM.
 *
 * Block items are drawn by a tiny orthographic ray caster: the block is described as a few
 * textured parallelograms (box faces, the helm wheel plane, propeller blades), each pixel
 * of the icon finds every quad it hits, and hits are composited front to back with
 * nearest-neighbour texel lookup. That yields crisp edges, correct overlap for compound
 * shapes and see-through rendering for cutout / translucent blocks, from one code path.
 *
 * Projection: a 2:1 dimetric view from the south-east above (+X right face, +Z left face,
 * +Y top), the classic pixel-art cube whose top edges are clean two-across-one-down stairs.
 */
import { itemDef } from '../blocks/items';
import { blockDef, type BlockDef } from '../blocks/registry';
import { TILE_SIZE } from '../core/constants';
import { shadeColor } from './color';
import { paintTile } from './tiles';

const T = TILE_SIZE;

/** Brightness of each face direction in icons: top lit, left (+Z) half shade, right (+X) shade. */
const SHADE_TOP = 1;
const SHADE_LEFT = 0.8;
const SHADE_RIGHT = 0.62;
const SHADE_BACK = 0.55;

/** A textured parallelogram: points o + s*u + t*v for s, t in [0,1). */
interface Quad {
  o: readonly [number, number, number];
  u: readonly [number, number, number];
  v: readonly [number, number, number];
  /** RGBA tile, already shaded for this quad. */
  tex: Uint8Array;
  /** Texel rectangle mapped onto the quad: s -> tu0..tu1, t -> tv0..tv1 (texel units). */
  tu0: number;
  tv0: number;
  tu1: number;
  tv1: number;
  /**
   * Drawn in a second pass on top of everything else, with its own dark outline. Only for
   * parts that are in front of the rest anyway (the helm wheel), where wood-on-wood would
   * otherwise blend into one blob at hotbar sizes.
   */
  overlay?: boolean;
}

/** Shaded copies of tiles, local to one icon render (keyed by name and shade). */
class TileSource {
  private readonly cache = new Map<string, Uint8Array>();

  get(name: string, shade: number): Uint8Array {
    const key = `${name}@${shade}`;
    let tex = this.cache.get(key);
    if (!tex) {
      tex = paintTile(name);
      if (shade < 1) {
        for (let i = 0; i < tex.length; i += 4) {
          if (tex[i + 3] === 0) continue;
          const c = shadeColor([tex[i]!, tex[i + 1]!, tex[i + 2]!], shade);
          tex[i] = c[0];
          tex[i + 1] = c[1];
          tex[i + 2] = c[2];
        }
      }
      this.cache.set(key, tex);
    }
    return tex;
  }
}

interface BoxTiles {
  top: string;
  /** +Z face (left in the icon). */
  south: string;
  /** +X face (right in the icon). */
  east: string;
  /** Back faces, only used when `back` is set. */
  north?: string;
  west?: string;
  bottom?: string;
}

interface BoxOptions {
  /** Also emit the three far faces (see-through blocks). */
  back?: boolean;
  /** Map the whole tile onto every face instead of the cell-space sub-rectangle. */
  fullUV?: boolean;
}

/**
 * Faces of the axis-aligned box [x0,x1] x [y0,y1] x [z0,z1] (cell units 0..1), with the same
 * texture orientation the world mesher uses: side faces have image-up = +Y, viewed from
 * outside; the top face has image-up = -Z (north).
 */
function boxQuads(
  src: TileSource,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  tiles: BoxTiles,
  opts: BoxOptions = {},
): Quad[] {
  const full = opts.fullUV ?? false;
  const r = (a: number, b: number): [number, number] => (full ? [0, T] : [a * T, b * T]);
  const out: Quad[] = [];
  const w = x1 - x0;
  const h = y1 - y0;
  const d = z1 - z0;
  if (opts.back) {
    const [bu0, bu1] = r(x0, x1);
    const [bv0, bv1] = r(1 - z1, 1 - z0);
    out.push({ o: [x0, y0, z1], u: [w, 0, 0], v: [0, 0, -d], tex: src.get(tiles.bottom ?? tiles.top, SHADE_BACK), tu0: bu0, tu1: bu1, tv0: bv0, tv1: bv1 });
    const [wu0, wu1] = r(z0, z1);
    const [wv0, wv1] = r(1 - y1, 1 - y0);
    out.push({ o: [x0, y1, z0], u: [0, 0, d], v: [0, -h, 0], tex: src.get(tiles.west ?? tiles.east, SHADE_BACK), tu0: wu0, tu1: wu1, tv0: wv0, tv1: wv1 });
    const [nu0, nu1] = r(1 - x1, 1 - x0);
    out.push({ o: [x1, y1, z0], u: [-w, 0, 0], v: [0, -h, 0], tex: src.get(tiles.north ?? tiles.south, SHADE_BACK), tu0: nu0, tu1: nu1, tv0: wv0, tv1: wv1 });
  }
  const [tu0, tu1] = r(x0, x1);
  const [tv0, tv1] = r(z0, z1);
  out.push({ o: [x0, y1, z0], u: [w, 0, 0], v: [0, 0, d], tex: src.get(tiles.top, SHADE_TOP), tu0, tu1, tv0, tv1 });
  const [su0, su1] = r(x0, x1);
  const [sv0, sv1] = r(1 - y1, 1 - y0);
  out.push({ o: [x0, y1, z1], u: [w, 0, 0], v: [0, -h, 0], tex: src.get(tiles.south, SHADE_LEFT), tu0: su0, tu1: su1, tv0: sv0, tv1: sv1 });
  const [eu0, eu1] = r(1 - z1, 1 - z0);
  out.push({ o: [x1, y1, z1], u: [0, 0, -d], v: [0, -h, 0], tex: src.get(tiles.east, SHADE_RIGHT), tu0: eu0, tu1: eu1, tv0: sv0, tv1: sv1 });
  return out;
}

/** Screen layout of the unit cell for an icon of `size` px. */
interface Projection {
  cx: number;
  top: number;
  /** Half width of the cell's silhouette, half height of its top rhombus, vertical edge length. */
  hw: number;
  ht: number;
  h: number;
}

function projection(size: number): Projection {
  // Width a multiple of 4 keeps the rhombus corners on whole pixels, so the 2:1 edges
  // become perfectly regular stairs. Vertical edge ~ 4/7 of the width reads as a cube.
  const margin = Math.max(1, Math.round(size / 16));
  const w = Math.max(4, 4 * Math.floor((size - 2 * margin) / 4));
  const ht = w / 4;
  const h = Math.round((w * 4) / 7);
  const total = 2 * ht + h;
  return { cx: size / 2, top: Math.floor((size - total) / 2), hw: w / 2, ht, h };
}

/** Ray-casts the quads into a size x size RGBA image (straight alpha). */
function rasterize(quads: readonly Quad[], size: number, p: Projection): Uint8ClampedArray {
  const img = new Uint8ClampedArray(size * size * 4);
  // Screen mapping: sx = cx + (x - z) * hw ; sy = top + (x + z) * ht + (1 - y) * h.
  // Direction toward the viewer is (1, 2*ht/h, 1): depth = x + z + y * 2ht/h (larger = nearer).
  const ky = (2 * p.ht) / p.h;
  interface Prepared {
    q: Quad;
    sx0: number;
    sy0: number;
    // inverse of [[ax, bx], [ay, by]]
    i00: number;
    i01: number;
    i10: number;
    i11: number;
    d0: number;
    du: number;
    dv: number;
  }
  const prep: Prepared[] = [];
  for (const q of quads) {
    const ax = (q.u[0] - q.u[2]) * p.hw;
    const ay = (q.u[0] + q.u[2]) * p.ht - q.u[1] * p.h;
    const bx = (q.v[0] - q.v[2]) * p.hw;
    const by = (q.v[0] + q.v[2]) * p.ht - q.v[1] * p.h;
    const det = ax * by - bx * ay;
    if (Math.abs(det) < 1e-9) continue; // seen edge-on
    prep.push({
      q,
      sx0: p.cx + (q.o[0] - q.o[2]) * p.hw,
      sy0: p.top + (q.o[0] + q.o[2]) * p.ht + (1 - q.o[1]) * p.h,
      i00: by / det,
      i01: -bx / det,
      i10: -ay / det,
      i11: ax / det,
      d0: q.o[0] + q.o[2] + q.o[1] * ky,
      du: q.u[0] + q.u[2] + q.u[1] * ky,
      dv: q.v[0] + q.v[2] + q.v[1] * ky,
    });
  }
  const hitDepth: number[] = [];
  const hitRGBA: number[] = [];
  const hitQuad: number[] = [];
  const order: number[] = [];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      hitDepth.length = 0;
      hitRGBA.length = 0;
      hitQuad.length = 0;
      for (let k = 0; k < prep.length; k++) {
        const e = prep[k]!;
        const dx = px + 0.5 - e.sx0;
        const dy = py + 0.5 - e.sy0;
        const s = e.i00 * dx + e.i01 * dy;
        const t = e.i10 * dx + e.i11 * dy;
        if (s < 0 || s >= 1 || t < 0 || t >= 1) continue;
        const q = e.q;
        const tx = Math.min(T - 1, Math.max(0, Math.floor(q.tu0 + s * (q.tu1 - q.tu0))));
        const ty = Math.min(T - 1, Math.max(0, Math.floor(q.tv0 + t * (q.tv1 - q.tv0))));
        const o = (ty * T + tx) * 4;
        if (q.tex[o + 3] === 0) continue;
        hitDepth.push(e.d0 + s * e.du + t * e.dv);
        hitRGBA.push(o);
        hitQuad.push(k);
      }
      if (!hitDepth.length) continue;
      order.length = 0;
      for (let i = 0; i < hitDepth.length; i++) order.push(i);
      // Nearest first; ties (coplanar seams) resolve by quad order for determinism.
      order.sort((a, b) => hitDepth[b]! - hitDepth[a]! || hitQuad[a]! - hitQuad[b]!);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const i of order) {
        const tex = prep[hitQuad[i]!]!.q.tex;
        const o = hitRGBA[i]!;
        const ta = tex[o + 3]! / 255;
        const wgt = (1 - a) * ta;
        r += tex[o]! * wgt;
        g += tex[o + 1]! * wgt;
        b += tex[o + 2]! * wgt;
        a += wgt;
        if (a >= 0.999) break;
      }
      const o = (py * size + px) * 4;
      img[o] = r / a;
      img[o + 1] = g / a;
      img[o + 2] = b / a;
      img[o + 3] = a * 255;
    }
  }
  return img;
}

/** Darkens the silhouette's border pixels: a crisp 1-px outline inside the icon bounds. */
function outlineSilhouette(img: Uint8ClampedArray, size: number): void {
  const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < size && y < size && img[(y * size + x) * 4 + 3]! > 0;
  const edge: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!solid(x, y)) continue;
      if (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)) edge.push(y * size + x);
    }
  }
  for (const i of edge) {
    const o = i * 4;
    const c = shadeColor([img[o]!, img[o + 1]!, img[o + 2]!], 0.5);
    img[o] = c[0];
    img[o + 1] = c[1];
    img[o + 2] = c[2];
    img[o + 3] = Math.max(img[o + 3]!, 200);
  }
}

/** Grows a 1-px dark ring OUTSIDE the silhouette, coloured from the neighbouring pixel. */
function outlineOutside(img: Uint8ClampedArray, size: number): void {
  const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < size && y < size && img[(y * size + x) * 4 + 3]! > 0;
  const ring: Array<[number, number]> = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (solid(x, y)) continue;
      for (const [dx, dy] of [
        [0, -1],
        [-1, 0],
        [1, 0],
        [0, 1],
      ] as const) {
        if (solid(x + dx, y + dy)) {
          ring.push([y * size + x, ((y + dy) * size + x + dx) * 4]);
          break;
        }
      }
    }
  }
  for (const [i, n] of ring) {
    const c = shadeColor([img[n]!, img[n + 1]!, img[n + 2]!], 0.35);
    const o = i * 4;
    img[o] = c[0];
    img[o + 1] = c[1];
    img[o + 2] = c[2];
    img[o + 3] = 255;
  }
}

/** Source-over composite of `top` onto `dst` (same size, straight alpha). */
function composite(dst: Uint8ClampedArray, top: Uint8ClampedArray): void {
  for (let o = 0; o < dst.length; o += 4) {
    const ta = top[o + 3]! / 255;
    if (ta === 0) continue;
    const da = (dst[o + 3]! / 255) * (1 - ta);
    const a = ta + da;
    for (let c = 0; c < 3; c++) dst[o + c] = (top[o + c]! * ta + dst[o + c]! * da) / a;
    dst[o + 3] = a * 255;
  }
}

/** Nearest-neighbour scale of one tile to size x size. */
function spriteIcon(tile: Uint8Array, size: number): Uint8ClampedArray {
  const img = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ty = Math.min(T - 1, Math.floor(((y + 0.5) * T) / size));
    for (let x = 0; x < size; x++) {
      const tx = Math.min(T - 1, Math.floor(((x + 0.5) * T) / size));
      const s = (ty * T + tx) * 4;
      const o = (y * size + x) * 4;
      if (tile[s + 3] === 0) continue; // keep fully transparent pixels at 0,0,0,0
      img[o] = tile[s]!;
      img[o + 1] = tile[s + 1]!;
      img[o + 2] = tile[s + 2]!;
      img[o + 3] = tile[s + 3]!;
    }
  }
  return img;
}

/** Tile names of a full-cube block's top / south / east faces (see the table in defs.ts). */
function cubeTiles(def: BlockDef): BoxTiles {
  const t = def.tiles;
  if (def.stateKind === 'axis') return { top: t[1]!, south: t[0]!, east: t[0]!, bottom: t[1]!, north: t[0]!, west: t[0]! };
  if (t.length >= 6) return { top: t[2]!, south: t[4]!, east: t[0]!, bottom: t[3]!, north: t[5]!, west: t[1]! };
  const any = t[0]!;
  return { top: any, south: any, east: any };
}

/**
 * A quad facing the viewer (its plane contains the screen-horizontal direction (1, 0, -1)),
 * so a round sprite stays round. Centred on cell point (c, y, c) with c = 0.5 + `forward`,
 * spanning `screenW` x `screenH` pixels for projection `p`.
 */
function billboard(p: Projection, y: number, forward: number, screenW: number, screenH: number, tex: Uint8Array): Quad {
  const a = screenW / (2 * p.hw);
  const b = screenH / p.h;
  const c = 0.5 + forward;
  return { o: [c - a / 2, y + b / 2, c + a / 2], u: [a, 0, -a], v: [0, -b, 0], tex, tu0: 0, tu1: T, tv0: 0, tv1: T };
}

function blockQuads(def: BlockDef, src: TileSource, p: Projection): Quad[] | null {
  const t = def.tiles;
  switch (def.shape) {
    case 'cross':
    case 'torch':
      return null; // flat sprite
    case 'layers':
      // Two layers tall, so the slab reads as snow cover rather than a flat line.
      return boxQuads(src, 0, 0, 0, 1, 0.25, 1, { top: t[0]!, south: t[0]!, east: t[0]! });
    case 'cactus':
      return boxQuads(src, 1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16, { top: t[1]!, south: t[0]!, east: t[0]! }, { fullUV: true });
    case 'bearing': {
      // Shown facing up: casing below the seam, the raised turntable plate on top.
      const [front, back, side] = [t[0]!, t[1]!, t[2]!];
      return [
        ...boxQuads(src, 0, 0, 0, 1, 11 / 16, 1, { top: back, south: side, east: side }),
        ...boxQuads(src, 1 / 16, 11 / 16, 1 / 16, 15 / 16, 1, 15 / 16, { top: front, south: side, east: side }),
      ];
    }
    case 'helm': {
      const [base, wheel] = [t[0]!, t[1]!];
      // Pedestal below, the wheel upright in front of it and turned toward the viewer so it
      // reads as a wheel at hotbar sizes. Its hub (texel 7.5) sits at the pedestal top.
      // The post must be taller than the wheel's radius below the hub, or it vanishes behind it.
      const hubY = 0.96;
      const quads = boxQuads(src, 5 / 16, 0, 5 / 16, 11 / 16, 1, 11 / 16, { top: base, south: base, east: base });
      const d = p.hw * 2 * 0.62;
      const q = billboard(p, hubY, 0.25, d, d, src.get(wheel, 1));
      // Shift so the texel centre (7.5, 7.5) of the 16-px wheel, not the tile centre, is the hub.
      const off = 0.5 / 16;
      quads.push({ ...q, overlay: true, o: [q.o[0] + (q.u[0] + q.v[0]) * off, q.o[1] + (q.u[1] + q.v[1]) * off, q.o[2] + (q.u[2] + q.v[2]) * off] });
      return quads;
    }
    case 'propeller': {
      const [hub, blade, back] = [t[0]!, t[1]!, t[2]!];
      // Facing +Z (left): mounting plate at the back, hub, four blades in an X.
      const quads = [
        ...boxQuads(src, 3 / 16, 3 / 16, 0, 13 / 16, 13 / 16, 2 / 16, { top: back, south: back, east: back }, { fullUV: true }),
        ...boxQuads(src, 6 / 16, 6 / 16, 2 / 16, 10 / 16, 10 / 16, 7 / 16, { top: hub, south: hub, east: hub }, { fullUV: true }),
      ];
      const cx = 0.5;
      const cy = 0.5;
      const z = 5 / 16;
      const L = 0.7;
      const W = 0.5;
      const tex = src.get(blade, 0.9);
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        // Perpendicular in the blade plane; image s runs across, t from the tip to the root.
        const px = -dy;
        const py = dx;
        quads.push({
          o: [cx + dx * L - (px * W) / 2, cy + dy * L - (py * W) / 2, z],
          u: [px * W, py * W, 0],
          v: [-dx * L, -dy * L, 0],
          tex,
          tu0: 0,
          tu1: T,
          tv0: 0,
          tv1: T,
        });
      }
      return quads;
    }
    default: {
      const see = def.layer !== 'opaque';
      return boxQuads(src, 0, 0, 0, 1, 1, 1, cubeTiles(def), { back: see });
    }
  }
}

/**
 * Renders an item icon: size*size*4 RGBA bytes, row 0 = top, transparent background.
 * Block items are drawn as small 3D renditions (cube, slab, inset cactus, bearing with its
 * plate, helm with wheel, propeller with blades); plants and torches as their flat sprite;
 * non-block items as their icon tile. Nearest-neighbour throughout (crisp pixels).
 * Throws on an unknown item id or a size outside 1..1024.
 */
export function renderItemIcon(itemId: number, size: number): Uint8ClampedArray {
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new RangeError(`icon size must be an integer in 1..1024, got ${size}`);
  const item = itemDef(itemId);
  if (item.block < 0) {
    if (!item.icon) throw new Error(`item ${itemId} has neither a block nor an icon tile`);
    return spriteIcon(paintTile(item.icon), size);
  }
  const def = blockDef(item.block);
  const src = new TileSource();
  const p = projection(size);
  const quads = blockQuads(def, src, p);
  if (!quads) return spriteIcon(paintTile(def.tiles[0]!), size);
  const img = rasterize(
    quads.filter((q) => !q.overlay),
    size,
    p,
  );
  if (size >= 12) outlineSilhouette(img, size);
  const over = quads.filter((q) => q.overlay);
  if (over.length) {
    const top = rasterize(over, size, p);
    if (size >= 12) outlineOutside(top, size);
    composite(img, top);
  }
  return img;
}
