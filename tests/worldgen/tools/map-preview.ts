/**
 * World preview renderer (a development tool, not a test).
 *
 * For each seed writes into `outDir`:
 *   map_<seed>.png      top-down colour map of real generated chunks, hill-shaded,
 *                       water shaded by depth, spawn marked with a red cross;
 *   biome_<seed>.png    biome labels (from biomeAt) over the same area;
 *   section_<seed>.png  vertical cross-section (x along the map's middle row, y 0..127,
 *                       2 px per block vertically) showing caves (black), ores, lava, water;
 *   zoom_<seed>.png     160 x 160 blocks around the spawn at 4 px per block;
 *   peak_<seed>.png     the same around the highest land column of the map;
 *   focus_<seed>.png    the same around an optional focus column (WORLDGEN_FOCUS=x,z),
 *                       anywhere in the world (its chunks are generated for it);
 *   relief_<seed>.png   grey-scale height with a contour line every 8 blocks.
 *
 * Run (env-guarded vitest entry, see map-preview.test.ts):
 *   WORLDGEN_PREVIEW=1 WORLDGEN_OUT=/some/dir WORLDGEN_SEEDS=1,2,3 npx vitest run tests/worldgen/tools
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_HEIGHT } from '../../../src/core/constants';
import { B } from '../../../src/blocks/defs';
import { BIOME_NAMES, type Biome } from '../../../src/worldgen/biome';
import { TerrainGenerator } from '../../../src/worldgen/generator';
import { encodePng } from './png';

type RGB = [number, number, number];

const BLOCK_COLOR = new Map<number, RGB>([
  [B.STONE, [128, 128, 132]],
  [B.COBBLE, [110, 110, 110]],
  [B.DIRT, [134, 96, 67]],
  [B.TURF, [96, 156, 58]],
  [B.SAND, [222, 210, 160]],
  [B.GRAVEL, [140, 132, 128]],
  [B.DEEPROCK, [40, 40, 44]],
  [B.LOG_OAK, [110, 84, 52]],
  [B.LOG_PINE, [74, 54, 34]],
  [B.LEAVES_OAK, [56, 122, 40]],
  [B.LEAVES_PINE, [36, 88, 58]],
  [B.COAL_ORE, [70, 64, 60]],
  [B.IRON_ORE, [214, 170, 140]],
  [B.COPPER_ORE, [214, 112, 64]],
  [B.SNOW_BLOCK, [242, 246, 252]],
  [B.SNOW_LAYER, [236, 242, 250]],
  [B.CLAY, [158, 164, 180]],
  [B.WATER, [40, 92, 200]],
  [B.LAVA, [240, 110, 20]],
  [B.CACTUS, [70, 140, 60]],
  [B.FLOWER_RED, [210, 40, 40]],
  [B.FLOWER_YELLOW, [236, 210, 40]],
  [B.TALL_GRASS, [110, 170, 66]],
]);

const BIOME_COLOR: Record<Biome, RGB> = {
  sea: [30, 70, 170],
  lake: [70, 140, 230],
  shore: [230, 214, 150],
  meadow: [140, 200, 80],
  broadleaf: [40, 130, 40],
  conifer: [30, 90, 80],
  highland: [150, 150, 90],
  peaks: [230, 230, 240],
  scrub: [210, 160, 80],
};

const SKY: RGB = [180, 214, 240];

export interface PreviewOptions {
  seeds: number[];
  /** Side of the square map in blocks (rounded to whole chunks). */
  size: number;
  outDir: string;
  /** Centre the map on the spawn point instead of the origin. */
  centreOnSpawn?: boolean;
  /** Extra zoom view centred on this world column (written as focus_<seed>.png). */
  focus?: { x: number; z: number };
}

export interface PreviewStats {
  seed: number;
  spawn: { x: number; y: number; z: number };
  seaFraction: number;
  biomeFractions: Record<string, number>;
  maxHeight: number;
  msPerChunk: number;
  files: string[];
}

function colorOf(id: number): RGB {
  return BLOCK_COLOR.get(id) ?? [255, 0, 255];
}

export function renderPreviews(opts: PreviewOptions): PreviewStats[] {
  mkdirSync(opts.outDir, { recursive: true });
  const stats: PreviewStats[] = [];
  for (const seed of opts.seeds) stats.push(renderSeed(seed, opts));
  return stats;
}

function renderSeed(seed: number, opts: PreviewOptions): PreviewStats {
  const gen = new TerrainGenerator(seed);
  const spawn = gen.spawnPoint();
  const chunks = Math.max(1, Math.round(opts.size / CHUNK_SIZE));
  const size = chunks * CHUNK_SIZE;
  const ccx = opts.centreOnSpawn ? Math.floor(spawn.x / CHUNK_SIZE) : 0;
  const ccz = opts.centreOnSpawn ? Math.floor(spawn.z / CHUNK_SIZE) : 0;
  const c0x = ccx - (chunks >> 1);
  const c0z = ccz - (chunks >> 1);
  const x0 = c0x * CHUNK_SIZE;
  const z0 = c0z * CHUNK_SIZE;

  // Top block + height per column; one cross-section row.
  const sectionZ = z0 + (size >> 1);
  const section = new Uint16Array(size * WORLD_HEIGHT);
  const area = scanArea(gen, c0x, c0z, chunks, sectionZ, section);
  const { topId, topY, groundY, genMs } = area;
  let maxHeight = 0;
  for (let i = 0; i < size * size; i++) if (topId[i] !== B.WATER && topY[i]! > maxHeight) maxHeight = topY[i]!;

  // ---- map
  const { map, sea } = shadeMap(area);
  // Spawn marker (the zoom view keeps an unmarked copy, with only the spawn cell outlined).
  const sx = Math.floor(spawn.x) - x0;
  const sz = Math.floor(spawn.z) - z0;
  const mapClean = map.slice();
  plot(mapClean, size, sx, sz, [255, 0, 0]);
  for (let d = -6; d <= 6; d++) {
    plot(map, size, sx + d, sz, [255, 0, 0]);
    plot(map, size, sx, sz + d, [255, 0, 0]);
  }
  // Section line marker (thin, every 4th pixel) so the cross-section can be located.
  for (let px = 0; px < size; px += 4) plot(map, size, px, sectionZ - z0, [255, 255, 255]);

  // ---- biome map (sampled at full resolution)
  const biomeImg = new Uint8Array(size * size * 3);
  const biomeCount = new Map<string, number>();
  for (let pz = 0; pz < size; pz++) {
    for (let px = 0; px < size; px++) {
      const name = gen.biomeAt(x0 + px, z0 + pz);
      biomeCount.set(name, (biomeCount.get(name) ?? 0) + 1);
      const c = BIOME_COLOR[name];
      const i = (px + pz * size) * 3;
      biomeImg[i] = c[0];
      biomeImg[i + 1] = c[1];
      biomeImg[i + 2] = c[2];
    }
  }
  for (let d = -6; d <= 6; d++) {
    plot(biomeImg, size, sx + d, sz, [255, 0, 0]);
    plot(biomeImg, size, sx, sz + d, [255, 0, 0]);
  }

  // ---- cross-section (y up, 2 px per block vertically)
  const sh = WORLD_HEIGHT * 2;
  const sec = new Uint8Array(size * sh * 3);
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let px = 0; px < size; px++) {
      const id = section[px + y * size]!;
      // Air below the surface (caves) is black; open air is sky.
      const c = id === 0 ? (y <= topY[px + (sectionZ - z0) * size]! ? ([0, 0, 0] as RGB) : SKY) : colorOf(id);
      for (let k = 0; k < 2; k++) {
        const row = sh - 1 - (y * 2 + k);
        const i = (px + row * size) * 3;
        sec[i] = c[0];
        sec[i + 1] = c[1];
        sec[i + 2] = c[2];
      }
    }
  }

  // ---- zooms: 160 x 160 blocks at 4 px per block, around the spawn and the highest summit
  let peakI = 0;
  for (let i = 0; i < size * size; i++) if (topId[i] !== B.WATER && topY[i]! > topY[peakI]!) peakI = i;
  const zoom = zoomAt(mapClean, size, sx, sz);
  const peakZoom = zoomAt(mapClean, size, peakI % size, Math.floor(peakI / size));
  // The focus may lie anywhere in the world: render its own neighbourhood rather than
  // cropping the main map (which would come out black outside the map square).
  let focusZoom: Uint8Array | null = null;
  if (opts.focus) {
    const n = Math.ceil(ZOOM_BLOCKS / CHUNK_SIZE) + 1;
    const fc0x = Math.floor((opts.focus.x - (ZOOM_BLOCKS >> 1)) / CHUNK_SIZE);
    const fc0z = Math.floor((opts.focus.z - (ZOOM_BLOCKS >> 1)) / CHUNK_SIZE);
    const fa = scanArea(gen, fc0x, fc0z, n);
    focusZoom = zoomAt(shadeMap(fa).map, fa.size, opts.focus.x - fa.x0, opts.focus.z - fa.z0);
  }

  // ---- relief: terrain height (water columns show their floor), contours every 8 blocks
  const relief = new Uint8Array(size * size * 3);
  for (let pz = 0; pz < size; pz++) {
    for (let px = 0; px < size; px++) {
      const i = px + pz * size;
      const h = groundY[i]!;
      let v = 30 + ((h - 10) / 110) * 225;
      const band = Math.floor(h / 8);
      const right = px + 1 < size ? Math.floor(groundY[i + 1]! / 8) : band;
      const down = pz + 1 < size ? Math.floor(groundY[i + size]! / 8) : band;
      if (band !== right || band !== down) v *= 0.6;
      const water = topId[i] === B.WATER;
      relief[i * 3] = clamp255(water ? v * 0.6 : v);
      relief[i * 3 + 1] = clamp255(water ? v * 0.75 : v);
      relief[i * 3 + 2] = clamp255(water ? v * 1.1 : v * 0.9);
    }
  }

  const files = [
    join(opts.outDir, `map_${seed}.png`),
    join(opts.outDir, `biome_${seed}.png`),
    join(opts.outDir, `section_${seed}.png`),
    join(opts.outDir, `zoom_${seed}.png`),
    join(opts.outDir, `relief_${seed}.png`),
    join(opts.outDir, `peak_${seed}.png`),
  ];
  writeFileSync(files[0]!, encodePng(size, size, map));
  writeFileSync(files[1]!, encodePng(size, size, biomeImg));
  writeFileSync(files[2]!, encodePng(size, sh, sec));
  writeFileSync(files[3]!, encodePng(ZOOM_BLOCKS * ZOOM_SCALE, ZOOM_BLOCKS * ZOOM_SCALE, zoom));
  writeFileSync(files[4]!, encodePng(size, size, relief));
  writeFileSync(files[5]!, encodePng(ZOOM_BLOCKS * ZOOM_SCALE, ZOOM_BLOCKS * ZOOM_SCALE, peakZoom));
  if (focusZoom) {
    files.push(join(opts.outDir, `focus_${seed}.png`));
    writeFileSync(files[6]!, encodePng(ZOOM_BLOCKS * ZOOM_SCALE, ZOOM_BLOCKS * ZOOM_SCALE, focusZoom));
  }

  const biomeFractions: Record<string, number> = {};
  for (const name of BIOME_NAMES) biomeFractions[name] = (biomeCount.get(name) ?? 0) / (size * size);
  return {
    seed,
    spawn,
    seaFraction: sea / (size * size),
    biomeFractions,
    maxHeight,
    msPerChunk: genMs / (chunks * chunks),
    files,
  };
}

const ZOOM_BLOCKS = 160;
const ZOOM_SCALE = 4;

/** Top block, top y and floor y (under water) of every column of a square of chunks. */
interface AreaScan {
  size: number;
  x0: number;
  z0: number;
  topId: Uint16Array;
  topY: Int16Array;
  /** Highest non-water cell (the floor under water). */
  groundY: Int16Array;
  genMs: number;
}

/** Generate `chunks` x `chunks` chunks from (c0x, c0z); optionally copy one z row into `section`. */
function scanArea(
  gen: TerrainGenerator,
  c0x: number,
  c0z: number,
  chunks: number,
  sectionZ?: number,
  section?: Uint16Array,
): AreaScan {
  const size = chunks * CHUNK_SIZE;
  const x0 = c0x * CHUNK_SIZE;
  const z0 = c0z * CHUNK_SIZE;
  const topId = new Uint16Array(size * size);
  const topY = new Int16Array(size * size);
  const groundY = new Int16Array(size * size);
  let genMs = 0;
  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      const t0 = performance.now();
      const cells = gen.generate(c0x + cx, c0z + cz);
      genMs += performance.now() - t0;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const px = cx * CHUNK_SIZE + lx;
          const pz = cz * CHUNK_SIZE + lz;
          let y = WORLD_HEIGHT - 1;
          while (y > 0 && cells[lx | (lz << 4) | (y << 8)] === 0) y--;
          topId[px + pz * size] = cells[lx | (lz << 4) | (y << 8)]! & 0x3ff;
          topY[px + pz * size] = y;
          let g = y;
          while (g > 0 && (cells[lx | (lz << 4) | (g << 8)]! & 0x3ff) === B.WATER) g--;
          groundY[px + pz * size] = g;
          if (section && z0 + pz === sectionZ) {
            for (let yy = 0; yy < WORLD_HEIGHT; yy++) section[px + yy * size] = cells[lx | (lz << 4) | (yy << 8)]! & 0x3ff;
          }
        }
      }
    }
  }
  return { size, x0, z0, topId, topY, groundY, genMs };
}

/** Hill-shaded colour map of a scan; water shaded by depth. Returns the RGB image and the water column count. */
function shadeMap(a: AreaScan): { map: Uint8Array; sea: number } {
  const { size, topId, topY, groundY } = a;
  const map = new Uint8Array(size * size * 3);
  let sea = 0;
  for (let pz = 0; pz < size; pz++) {
    for (let px = 0; px < size; px++) {
      const i = px + pz * size;
      const id = topId[i]!;
      let [r, g, b] = colorOf(id);
      if (id === B.WATER) {
        sea++;
        const depth = SEA_LEVEL - 1 - groundY[i]!;
        const k = Math.min(1, depth / 26);
        r = 70 - 50 * k;
        g = 170 - 110 * k;
        b = 225 - 75 * k;
      } else {
        // Hill shading from the north-west plus a gentle height tint.
        const nw = px > 0 && pz > 0 ? topY[i - 1 - size]! : topY[i]!;
        const shade = Math.max(0.55, Math.min(1.45, 1 + (topY[i]! - nw) * 0.09));
        const tint = 0.85 + ((topY[i]! - SEA_LEVEL) / 70) * 0.3;
        r *= shade * tint;
        g *= shade * tint;
        b *= shade * tint;
      }
      map[i * 3] = clamp255(r);
      map[i * 3 + 1] = clamp255(g);
      map[i * 3 + 2] = clamp255(b);
    }
  }
  return { map, sea };
}

/** ZOOM_BLOCKS^2 blocks of `map` centred on (cx, cz), scaled up ZOOM_SCALE times. */
function zoomAt(map: Uint8Array, size: number, cx: number, cz: number): Uint8Array {
  const side = ZOOM_BLOCKS * ZOOM_SCALE;
  const out = new Uint8Array(side * side * 3);
  for (let zy = 0; zy < side; zy++) {
    for (let zx = 0; zx < side; zx++) {
      const mx = cx - (ZOOM_BLOCKS >> 1) + Math.floor(zx / ZOOM_SCALE);
      const mz = cz - (ZOOM_BLOCKS >> 1) + Math.floor(zy / ZOOM_SCALE);
      if (mx < 0 || mz < 0 || mx >= size || mz >= size) continue;
      const si = (mx + mz * size) * 3;
      const di = (zx + zy * side) * 3;
      out[di] = map[si]!;
      out[di + 1] = map[si + 1]!;
      out[di + 2] = map[si + 2]!;
    }
  }
  return out;
}

function plot(img: Uint8Array, size: number, x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (x + y * size) * 3;
  img[i] = c[0];
  img[i + 1] = c[1];
  img[i + 2] = c[2];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
