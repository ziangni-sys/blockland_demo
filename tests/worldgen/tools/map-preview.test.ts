/**
 * Env-guarded entry for the map preview tool (skipped in normal test runs).
 *
 *   WORLDGEN_PREVIEW=1 WORLDGEN_OUT=/tmp/maps WORLDGEN_SEEDS=1,2,3 WORLDGEN_SIZE=768 \
 *     npx vitest run tests/worldgen/tools
 *
 * WORLDGEN_SPAWN_CENTRE=1 centres the maps on the spawn point instead of the origin;
 * WORLDGEN_FOCUS=x,z adds a zoom view around that column.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { renderPreviews } from './map-preview';

const enabled = !!process.env.WORLDGEN_PREVIEW;

describe.runIf(enabled)('worldgen map preview (tool)', () => {
  it('renders maps', () => {
    const seeds = (process.env.WORLDGEN_SEEDS ?? '1,2,3').split(',').map((s) => Number(s.trim()) >>> 0);
    const size = Number(process.env.WORLDGEN_SIZE ?? 768);
    const outDir = process.env.WORLDGEN_OUT ?? join(tmpdir(), 'blocklands-worldgen');
    const focusArg = process.env.WORLDGEN_FOCUS?.split(',').map(Number);
    const focus = focusArg && focusArg.length === 2 ? { x: focusArg[0]!, z: focusArg[1]! } : undefined;
    const stats = renderPreviews({ seeds, size, outDir, centreOnSpawn: !!process.env.WORLDGEN_SPAWN_CENTRE, focus });
    for (const s of stats) {
      const biomes = Object.entries(s.biomeFractions)
        .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`)
        .join(', ');
      console.log(
        `seed ${s.seed}: spawn (${s.spawn.x}, ${s.spawn.y}, ${s.spawn.z}) sea ${(s.seaFraction * 100).toFixed(1)}% ` +
          `max ${s.maxHeight} ${s.msPerChunk.toFixed(2)} ms/chunk\n  ${biomes}\n  ${s.files.join('\n  ')}`,
      );
    }
  }, 600_000);
});
