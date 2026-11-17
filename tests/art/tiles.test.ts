import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { B } from '../../src/blocks/defs';
import { BLOCKS, TILE_NAMES } from '../../src/blocks/registry';
import { TILE_SIZE } from '../../src/core/constants';
import { hasTilePainter, paintAllTiles, paintableTileNames, paintTile, tileAlphaMode } from '../../src/art/tiles';

const LAYER = TILE_SIZE * TILE_SIZE * 4;

function alphas(px: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 3; i < px.length; i += 4) out.push(px[i]!);
  return out;
}

/** Mean absolute RGB difference between two columns (or rows) of a tile. */
function lineDiff(px: Uint8Array, a: number, b: number, vertical: boolean): number {
  let sum = 0;
  for (let i = 0; i < TILE_SIZE; i++) {
    const pa = vertical ? (i * TILE_SIZE + a) * 4 : (a * TILE_SIZE + i) * 4;
    const pb = vertical ? (i * TILE_SIZE + b) * 4 : (b * TILE_SIZE + i) * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(px[pa + c]! - px[pb + c]!);
  }
  return sum / (TILE_SIZE * 3);
}

describe('art/tiles', () => {
  it('has a painter for every TILE_NAMES entry', () => {
    expect(TILE_NAMES.length).toBeGreaterThan(60);
    const missing = TILE_NAMES.filter((n) => !hasTilePainter(n));
    expect(missing).toEqual([]);
    for (const n of TILE_NAMES) {
      const px = paintTile(n);
      expect(px).toBeInstanceOf(Uint8Array);
      expect(px.length).toBe(LAYER);
    }
  });

  it('paints no stray tiles that the block table does not use', () => {
    const used = new Set(TILE_NAMES);
    expect(paintableTileNames().filter((n) => !used.has(n))).toEqual([]);
  });

  it('is byte-identical across calls and independent of call order', () => {
    const first = TILE_NAMES.map((n) => paintTile(n));
    const reversed = [...TILE_NAMES].reverse().map((n) => paintTile(n)).reverse();
    for (let i = 0; i < TILE_NAMES.length; i++) {
      expect(Buffer.from(reversed[i]!).equals(Buffer.from(first[i]!)), TILE_NAMES[i]).toBe(true);
    }
  });

  it('returns a fresh array each call', () => {
    const a = paintTile('stone');
    a.fill(0);
    expect(paintTile('stone').some((v) => v !== 0)).toBe(true);
  });

  it('throws on unknown names (including Object prototype keys)', () => {
    expect(() => paintTile('no_such_tile')).toThrow(/unknown tile/);
    expect(() => paintTile('toString')).toThrow(/unknown tile/);
    expect(() => paintTile('')).toThrow(/unknown tile/);
    expect(() => tileAlphaMode('no_such_tile')).toThrow();
  });

  it('paintAllTiles concatenates every tile in TILE_NAMES order', () => {
    const all = paintAllTiles();
    expect(all.size).toBe(TILE_SIZE);
    expect(all.count).toBe(TILE_NAMES.length);
    expect(all.pixels.length).toBe(LAYER * TILE_NAMES.length);
    TILE_NAMES.forEach((n, i) => {
      expect(Buffer.from(all.pixels.subarray(i * LAYER, (i + 1) * LAYER)).equals(Buffer.from(paintTile(n))), n).toBe(true);
    });
    expect(Buffer.from(paintAllTiles().pixels).equals(Buffer.from(all.pixels))).toBe(true);
  });

  describe('determinism guard', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('Math.random must not be used by the art module');
      });
    });
    afterEach(() => vi.restoreAllMocks());
    it('never calls Math.random', () => {
      expect(() => paintAllTiles()).not.toThrow();
    });
  });

  it('honours the alpha contract of every tile', () => {
    for (const n of TILE_NAMES) {
      const a = alphas(paintTile(n));
      const mode = tileAlphaMode(n);
      if (mode === 'opaque') {
        expect(a.every((v) => v === 255), n).toBe(true);
      } else if (mode === 'cutout') {
        expect(a.every((v) => v === 0 || v === 255), n).toBe(true);
        expect(a.some((v) => v === 0) && a.some((v) => v === 255), n).toBe(true);
      } else {
        expect(a.some((v) => v > 0 && v < 255), n).toBe(true);
      }
    }
  });

  it('gives translucent tiles the alpha the art direction asks for', () => {
    for (const n of ['water_still', 'water_flow']) {
      const a = alphas(paintTile(n));
      expect(Math.min(...a), n).toBeGreaterThanOrEqual(150);
      expect(Math.max(...a), n).toBeLessThanOrEqual(175);
    }
    expect(alphas(paintTile('ice')).every((v) => v === 200)).toBe(true);
    const glue = alphas(paintTile('glue_face'));
    expect(glue.some((v) => v === 0)).toBe(true);
    expect(glue.filter((v) => v > 0).every((v) => v >= 120 && v <= 170)).toBe(true);
    for (let k = 0; k < 8; k++) expect(alphas(paintTile(`crack_${k}`)).every((v) => v === 0 || v === 200)).toBe(true);
  });

  it('leaves have roughly 20-25 % see-through pixels', () => {
    for (const n of ['leaves_oak', 'leaves_pine']) {
      const holes = alphas(paintTile(n)).filter((v) => v === 0).length / (TILE_SIZE * TILE_SIZE);
      expect(holes, n).toBeGreaterThanOrEqual(0.18);
      expect(holes, n).toBeLessThanOrEqual(0.27);
    }
  });

  it('crack stages grow monotonically from the centre', () => {
    let prev: number[] = [];
    let prevCount = 0;
    for (let k = 0; k < 8; k++) {
      const a = alphas(paintTile(`crack_${k}`));
      const count = a.filter((v) => v > 0).length;
      expect(count, `crack_${k}`).toBeGreaterThan(prevCount);
      // Every pixel cracked at the previous stage is still cracked.
      prev.forEach((v, i) => {
        if (v > 0) expect(a[i]).toBeGreaterThan(0);
      });
      prev = a;
      prevCount = count;
    }
    const first = alphas(paintTile('crack_0'));
    const centre = [7, 8].flatMap((y) => [7, 8].map((x) => first[y * TILE_SIZE + x]!));
    expect(centre.some((v) => v > 0)).toBe(true);
  });

  it('torch stick is exactly the two centre columns below the flame', () => {
    const px = paintTile('torch');
    for (let y = 9; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const a = px[(y * TILE_SIZE + x) * 4 + 3]!;
        expect(a, `torch ${x},${y}`).toBe(x === 7 || x === 8 ? 255 : 0);
      }
    }
  });

  it('glass is fully transparent in the centre and framed at the border', () => {
    const a = alphas(paintTile('glass'));
    expect(a[0]).toBe(255);
    expect(a[8 * TILE_SIZE + 0]).toBe(255);
    expect(a[8 * TILE_SIZE + 8]).toBe(0);
    expect(a[9 * TILE_SIZE + 9]).toBe(0);
  });

  it('blocks rendered in the opaque pass only use fully opaque cube tiles', () => {
    for (const def of BLOCKS) {
      if (!def || def.layer !== 'opaque' || def.shape !== 'cube') continue;
      for (const t of def.tiles) expect(tileAlphaMode(t), `${def.key}:${t}`).toBe('opaque');
    }
  });

  it('repeating materials tile without visible seams', () => {
    // A seam shows up as a jump between the last and first column (row) that is larger than
    // the jumps between neighbouring interior columns (rows). Banded materials (strata,
    // planks, bricks) legitimately have large interior jumps, so compare against the largest.
    const repeating = [
      'stone', 'cobble', 'dirt', 'turf_top', 'sand', 'gravel', 'deeprock', 'log_oak_side', 'log_pine_side',
      'planks_oak', 'planks_pine', 'stone_bricks', 'bricks', 'sandstone_side', 'sandstone_top', 'obsidian',
      'iron_block', 'lamp', 'snow', 'clay', 'water_still', 'water_flow', 'lava_still', 'lava_flow', 'canvas',
      'wool_white', 'wool_red', 'wool_blue', 'wool_black', 'cactus_side', 'coal_ore', 'iron_ore', 'copper_ore',
    ];
    for (const n of repeating) {
      const px = paintTile(n);
      for (const vertical of [true, false]) {
        let mean = 0;
        let max = 0;
        for (let i = 0; i < TILE_SIZE - 1; i++) {
          const d = lineDiff(px, i, i + 1, vertical);
          mean += d;
          max = Math.max(max, d);
        }
        mean /= TILE_SIZE - 1;
        const seam = lineDiff(px, TILE_SIZE - 1, 0, vertical);
        expect(seam, `${n} ${vertical ? 'x' : 'y'} seam`).toBeLessThanOrEqual(Math.max(max * 1.15, mean * 2) + 3);
      }
    }
  });

  it('turf side shares its dirt with the dirt tile below the grass fringe', () => {
    const side = paintTile('turf_side');
    const dirt = paintTile('dirt');
    // Below row 8 the fringe never reaches: the bytes must match exactly.
    expect(Buffer.from(side.subarray(8 * TILE_SIZE * 4)).equals(Buffer.from(dirt.subarray(8 * TILE_SIZE * 4)))).toBe(true);
    // The top row is grass-green.
    const r = side[0]!;
    const g = side[1]!;
    expect(g).toBeGreaterThan(r);
  });

  it('ores keep the stone base around their nuggets', () => {
    const stone = paintTile('stone');
    for (const n of ['coal_ore', 'iron_ore', 'copper_ore']) {
      const ore = paintTile(n);
      let same = 0;
      for (let i = 0; i < LAYER; i += 4) if (ore[i] === stone[i] && ore[i + 1] === stone[i + 1] && ore[i + 2] === stone[i + 2]) same++;
      const frac = same / (TILE_SIZE * TILE_SIZE);
      expect(frac, n).toBeGreaterThan(0.5);
      expect(frac, n).toBeLessThan(0.95);
    }
  });

  it('is fast enough to run at startup', () => {
    const t0 = performance.now();
    paintAllTiles();
    const ms = performance.now() - t0;
    console.log(`paintAllTiles: ${TILE_NAMES.length} tiles in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(400);
  });

  it('keeps the block ids it relies on', () => {
    expect(B.TORCH).toBe(60);
  });
});
