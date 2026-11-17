/**
 * Tooling only: a z-buffered dimetric voxel renderer for a small hand-built diorama, so the
 * tiles can be judged side by side the way they meet in the world (turf next to sand next to
 * water, a house, trees, a windmill...).
 */
import { B } from '../../../src/blocks/defs';
import { blockDef } from '../../../src/blocks/registry';
import { TILE_SIZE } from '../../../src/core/constants';
import { shadeColor } from '../../../src/art/color';
import { paintTile } from '../../../src/art/tiles';
import { Image } from './image';

const T = TILE_SIZE;
type V3 = readonly [number, number, number];

interface Face {
  o: V3;
  u: V3;
  v: V3;
  tile: string;
  shade: number;
  translucent: boolean;
}

export class Diorama {
  private readonly cells = new Map<string, number>();
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;

  constructor(sx: number, sy: number, sz: number) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
  }
  set(x: number, y: number, z: number, id: number): void {
    this.cells.set(`${x},${y},${z}`, id);
  }
  get(x: number, y: number, z: number): number {
    return this.cells.get(`${x},${y},${z}`) ?? 0;
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, id);
  }

  private faces(): Face[] {
    const out: Face[] = [];
    const opaqueAt = (x: number, y: number, z: number): boolean => {
      const id = this.get(x, y, z);
      return id !== 0 && blockDef(id).opaque;
    };
    for (const [key, id] of this.cells) {
      if (id === 0) continue;
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      const def = blockDef(id);
      const tiles = def.tiles;
      if (def.shape === 'cross' || def.shape === 'torch') {
        out.push({ o: [x, y + 1, z], u: [1, 0, 1], v: [0, -1, 0], tile: tiles[0]!, shade: 0.9, translucent: false });
        out.push({ o: [x, y + 1, z + 1], u: [1, 0, -1], v: [0, -1, 0], tile: tiles[0]!, shade: 0.85, translucent: false });
        continue;
      }
      let top: string;
      let south: string;
      let east: string;
      if (def.shape === 'liquid') {
        if (this.get(x, y + 1, z) !== id) {
          out.push({ o: [x, y + 0.875, z], u: [1, 0, 0], v: [0, 0, 1], tile: tiles[0]!, shade: 1, translucent: def.layer === 'translucent' });
        }
        continue;
      }
      if (def.stateKind === 'axis') [top, south, east] = [tiles[1]!, tiles[0]!, tiles[0]!];
      else if (def.shape === 'cactus') [top, south, east] = [tiles[1]!, tiles[0]!, tiles[0]!];
      else if (def.shape === 'bearing') [top, south, east] = [tiles[2]!, tiles[0]!, tiles[2]!];
      else if (tiles.length >= 6) [top, south, east] = [tiles[2]!, tiles[4]!, tiles[0]!];
      else [top, south, east] = [tiles[0]!, tiles[0]!, tiles[0]!];
      const tr = def.layer === 'translucent';
      const h = def.shape === 'layers' ? 0.25 : 1;
      if (!opaqueAt(x, y + 1, z) || h < 1) out.push({ o: [x, y + h, z], u: [1, 0, 0], v: [0, 0, 1], tile: top, shade: 1, translucent: tr });
      if (!opaqueAt(x, y, z + 1)) out.push({ o: [x, y + h, z + 1], u: [1, 0, 0], v: [0, -h, 0], tile: south, shade: 0.8, translucent: tr });
      if (!opaqueAt(x + 1, y, z)) out.push({ o: [x + 1, y + h, z + 1], u: [0, 0, -1], v: [0, -h, 0], tile: east, shade: 0.62, translucent: tr });
    }
    return out;
  }

  /** Renders with `w` px per block width (multiple of 4). */
  render(w: number, bg: readonly [number, number, number]): Image {
    const hw = w / 2;
    const ht = w / 4;
    const h = Math.round((w * 4) / 7);
    const width = Math.ceil((this.sx + this.sz) * hw) + 16;
    const height = Math.ceil((this.sx + this.sz) * ht + this.sy * h) + 16;
    const img = new Image(width, height, bg);
    const zbuf = new Float32Array(width * height).fill(-Infinity);
    const cx = this.sz * hw + 8;
    const top = 8;
    const P = (p: V3): [number, number] => [cx + (p[0] - p[2]) * hw, top + (p[0] + p[2]) * ht + (this.sy - p[1]) * h];
    const ky = (2 * ht) / h;
    const D = (p: V3): number => p[0] + p[2] + p[1] * ky;
    const texCache = new Map<string, Uint8Array>();
    const tex = (name: string, shade: number): Uint8Array => {
      const key = `${name}@${shade}`;
      let t = texCache.get(key);
      if (!t) {
        t = paintTile(name);
        for (let i = 0; i < t.length; i += 4) {
          const c = shadeColor([t[i]!, t[i + 1]!, t[i + 2]!], shade);
          t[i] = c[0];
          t[i + 1] = c[1];
          t[i + 2] = c[2];
        }
        texCache.set(key, t);
      }
      return t;
    };
    const faces = this.faces();
    const draw = (f: Face, blend: boolean): void => {
      const [x0, y0] = P(f.o);
      const ax = f.u[0] * hw - f.u[2] * hw;
      const ay = (f.u[0] + f.u[2]) * ht - f.u[1] * h;
      const bx = f.v[0] * hw - f.v[2] * hw;
      const by = (f.v[0] + f.v[2]) * ht - f.v[1] * h;
      const det = ax * by - bx * ay;
      if (Math.abs(det) < 1e-9) return;
      const xs = [x0, x0 + ax, x0 + bx, x0 + ax + bx];
      const ys = [y0, y0 + ay, y0 + by, y0 + ay + by];
      const d0 = D(f.o);
      const du = f.u[0] + f.u[2] + f.u[1] * ky;
      const dv = f.v[0] + f.v[2] + f.v[1] * ky;
      const t = tex(f.tile, f.shade);
      for (let py = Math.max(0, Math.floor(Math.min(...ys))); py <= Math.min(height - 1, Math.ceil(Math.max(...ys))); py++) {
        for (let px = Math.max(0, Math.floor(Math.min(...xs))); px <= Math.min(width - 1, Math.ceil(Math.max(...xs))); px++) {
          const dx = px + 0.5 - x0;
          const dy = py + 0.5 - y0;
          const s = (by * dx - bx * dy) / det;
          const tt = (-ay * dx + ax * dy) / det;
          if (s < 0 || s >= 1 || tt < 0 || tt >= 1) continue;
          const depth = d0 + s * du + tt * dv;
          const zi = py * width + px;
          if (depth < zbuf[zi]! - 1e-6) continue;
          const o = (Math.floor(tt * T) * T + Math.floor(s * T)) * 4;
          const a = t[o + 3]!;
          if (a === 0) continue;
          if (!blend) zbuf[zi] = depth;
          img.put(px, py, t[o]!, t[o + 1]!, t[o + 2]!, blend ? a : 255);
        }
      }
    };
    for (const f of faces) if (!f.translucent) draw(f, false);
    const tr = faces.filter((f) => f.translucent).sort((a, b) => D(a.o) - D(b.o));
    for (const f of tr) draw(f, true);
    return img;
  }
}

/** The review diorama: a little coast with a house, trees, windmill, raft and a mine cut. */
export function buildDiorama(): Diorama {
  const d = new Diorama(14, 9, 12);
  // Bedrock-ish base and ground layers.
  d.fill(0, 0, 0, 13, 0, 11, B.STONE);
  d.fill(0, 1, 0, 13, 1, 11, B.DIRT);
  d.fill(0, 2, 0, 9, 2, 11, B.TURF);
  // Beach and sea on the east side.
  d.fill(10, 1, 0, 13, 1, 11, B.SAND);
  d.fill(10, 2, 0, 10, 2, 11, B.SAND);
  d.fill(11, 1, 0, 13, 1, 11, B.WATER);
  d.fill(11, 0, 0, 13, 0, 11, B.SAND);
  // Raft with a helm on the water.
  d.fill(11, 1, 6, 13, 1, 8, B.PLANKS_PINE);
  d.set(12, 2, 7, B.HELM);
  // Hill at the back with a mine cut showing ores.
  d.fill(0, 3, 0, 4, 4, 2, B.STONE);
  d.fill(0, 5, 0, 3, 5, 1, B.TURF);
  d.set(1, 3, 2, B.COAL_ORE);
  d.set(2, 4, 2, B.IRON_ORE);
  d.set(3, 3, 2, B.COPPER_ORE);
  d.set(4, 3, 2, B.GRAVEL);
  d.set(4, 4, 2, B.COBBLE);
  d.fill(0, 6, 0, 1, 6, 0, B.SNOW_BLOCK);
  d.set(0, 7, 0, B.SNOW_LAYER);
  // Oak tree.
  d.fill(6, 3, 1, 6, 5, 1, B.LOG_OAK);
  d.fill(5, 6, 0, 7, 6, 2, B.LEAVES_OAK);
  d.set(6, 7, 1, B.LEAVES_OAK);
  // Pine tree.
  d.fill(9, 3, 0, 9, 6, 0, B.LOG_PINE);
  d.fill(8, 5, 0, 9, 5, 1, B.LEAVES_PINE);
  d.set(9, 7, 0, B.LEAVES_PINE);
  // House: stone-brick footing, plank walls, glass window, brick chimney, lamp.
  d.fill(1, 3, 5, 4, 3, 8, B.STONE_BRICKS);
  d.fill(1, 4, 5, 4, 5, 8, B.PLANKS_OAK);
  d.fill(2, 4, 6, 3, 5, 7, 0);
  d.set(2, 5, 8, B.GLASS);
  d.set(4, 5, 7, B.GLASS);
  d.fill(1, 6, 5, 4, 6, 8, B.LOG_OAK);
  d.fill(1, 7, 5, 1, 8, 5, B.BRICKS);
  d.set(3, 4, 8, B.LAMP);
  // Windmill: bearing on a post with felt and canvas sails.
  d.fill(7, 3, 9, 7, 5, 9, B.LOG_PINE);
  d.set(7, 6, 9, B.BEARING);
  d.fill(7, 7, 9, 7, 8, 9, B.CANVAS);
  d.set(6, 7, 9, B.WOOL_RED);
  d.set(8, 7, 9, B.WOOL_WHITE);
  // Details.
  d.set(5, 3, 4, B.FLOWER_RED);
  d.set(8, 3, 6, B.FLOWER_YELLOW);
  d.set(6, 3, 6, B.TALL_GRASS);
  d.set(7, 3, 4, B.TALL_GRASS);
  d.set(5, 3, 7, B.TORCH);
  d.set(9, 3, 9, B.TNT);
  d.set(10, 3, 3, B.CACTUS);
  d.set(10, 4, 3, B.CACTUS);
  d.set(10, 3, 9, B.SANDSTONE);
  // Lava pool with an obsidian lip, iron block and felt stack.
  d.fill(7, 2, 10, 8, 2, 11, B.LAVA);
  d.set(6, 2, 11, B.OBSIDIAN);
  d.set(9, 2, 11, B.OBSIDIAN);
  d.set(0, 3, 10, B.IRON_BLOCK);
  d.set(0, 3, 11, B.WOOL_BLUE);
  d.set(1, 3, 11, B.WOOL_YELLOW);
  d.set(0, 4, 11, B.WOOL_GREEN);
  d.set(2, 3, 11, B.CLAY);
  d.set(3, 3, 11, B.ICE);
  d.set(4, 3, 11, B.DEEPROCK);
  return d;
}
