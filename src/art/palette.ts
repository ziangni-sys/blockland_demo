/**
 * Representative colours of tiles, for particles, maps and distant LOD tints.
 */
import { TILE_SIZE } from '../core/constants';
import { paintTile } from './tiles';

/**
 * Lazily filled memo of averages. Values are pure functions of the tile name and callers only
 * ever receive copies, so the cache is not observable (it only saves repainting).
 */
const averages = new Map<string, readonly [number, number, number]>();

/**
 * Alpha-weighted mean colour of a tile as sRGB bytes [r, g, b] (0..255, rounded).
 * Fully transparent pixels do not contribute. A tile with no visible pixel yields [0, 0, 0].
 * Throws on an unknown tile name. Returns a fresh array on every call.
 */
export function tileAverageColor(name: string): [number, number, number] {
  let avg = averages.get(name);
  if (!avg) {
    const d = paintTile(name);
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (let i = 0; i < TILE_SIZE * TILE_SIZE * 4; i += 4) {
      const a = d[i + 3]!;
      r += d[i]! * a;
      g += d[i + 1]! * a;
      b += d[i + 2]! * a;
      w += a;
    }
    avg = w > 0 ? [Math.round(r / w), Math.round(g / w), Math.round(b / w)] : [0, 0, 0];
    averages.set(name, avg);
  }
  return [avg[0], avg[1], avg[2]];
}
