/**
 * Stand-in icon provider for the harness (the real one is src/art/icons.ts, written by
 * another module). Draws a shaded isometric cube for solid block items and returns null for
 * everything else, so the harness exercises both the provider path and the placeholder path.
 */
import { BLOCKS } from '../../src/blocks/registry';

const COLORS: Record<string, string> = {
  stone: '#8a8f96', cobble: '#767b83', dirt: '#7a5536', turf: '#5f9e45', sand: '#dccb8f', gravel: '#8f8780',
  deeprock: '#3b3d44', log_oak: '#6d4f2e', log_pine: '#4e3a24', planks_oak: '#b98d55', planks_pine: '#9b7444',
  leaves_oak: '#3f7d32', leaves_pine: '#2e5f3a', glass: '#a7d3e6', stone_bricks: '#8d9198', bricks: '#a8533e',
  sandstone: '#d8c27e', obsidian: '#2a2236', coal_ore: '#6f7379', iron_ore: '#9a8e84', copper_ore: '#8f7f6c',
  iron_block: '#c9cdd2', lamp: '#f5e39a', snow_block: '#eef3f7', ice: '#a8d3f2', clay: '#9aa3ae',
  wool_white: '#ecebe6', wool_red: '#b8382f', wool_orange: '#e07b2a', wool_yellow: '#e8c33a', wool_green: '#4f8f3a',
  wool_blue: '#2f5fb0', wool_purple: '#7a43a8', wool_black: '#26262b', canvas: '#e8dcc0', helm: '#8a6236',
  bearing: '#6f7780', tnt: '#c0392b',
};

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Point-in-convex-quad test (vertices in order). */
function inQuad(px: number, py: number, q: ReadonlyArray<readonly [number, number]>): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i]!;
    const [bx, by] = q[(i + 1) % 4]!;
    const c = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (c !== 0) {
      const s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

export function fakeIconProvider(itemId: number, size: number): Uint8ClampedArray | null {
  const def = BLOCKS[itemId];
  if (!def || !def.solid || def.shape !== 'cube') return null;
  const base = rgb(COLORS[def.key] ?? '#888888');
  const s = size;
  const top: [number, number] = [s * 0.5, s * 0.06];
  const left: [number, number] = [s * 0.08, s * 0.29];
  const right: [number, number] = [s * 0.92, s * 0.29];
  const mid: [number, number] = [s * 0.5, s * 0.52];
  const bottom: [number, number] = [s * 0.5, s * 0.95];
  const ll: [number, number] = [s * 0.08, s * 0.72];
  const lr: [number, number] = [s * 0.92, s * 0.72];
  const faces = [
    { q: [top, right, mid, left] as const, k: 1.12 },
    { q: [left, mid, bottom, ll] as const, k: 0.8 },
    { q: [mid, right, lr, bottom] as const, k: 0.6 },
  ];
  const out = new Uint8ClampedArray(s * s * 4);
  const cell = Math.max(1, Math.floor(s / 16));
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      for (const f of faces) {
        if (!inQuad(px, py, f.q)) continue;
        // Cheap deterministic texel noise so faces read as textured blocks.
        const tx = Math.floor(x / cell);
        const ty = Math.floor(y / cell);
        const n = ((tx * 73856093) ^ (ty * 19349663) ^ (itemId * 83492791)) >>> 0;
        const jitter = 0.9 + ((n % 1000) / 1000) * 0.2;
        const i = (y * s + x) * 4;
        out[i] = base[0] * f.k * jitter;
        out[i + 1] = base[1] * f.k * jitter;
        out[i + 2] = base[2] * f.k * jitter;
        out[i + 3] = def.key === 'glass' || def.key === 'ice' ? 170 : 255;
        break;
      }
    }
  }
  return out;
}
