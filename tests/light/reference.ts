/**
 * Brute-force reference relighter for the light engine tests.
 *
 * It knows nothing about heightmaps, queues or removal: it copies the lit chunks of a world
 * into flat arrays, starts every cell at 0 and applies the local light rule in repeated
 * full sweeps (alternating directions) until nothing changes. Values only ever increase, so
 * this reaches the least fixed point, which is the unique fixed point of the rule:
 *
 *   cost(c)  = max(1, lightOpacity(c)); cells with lightOpacity >= 15 receive nothing
 *   block(c) = max(EMIT(c), max_n block(n) - cost(c))
 *   sky(c)   = max(above(c) when lightOpacity(c) == 0 else above(c) - cost(c),
 *                  max over the other 5 neighbours n of sky(n) - cost(c))
 *   where above(c) of the top layer is a virtual fully lit (15) layer above the world.
 *
 * Chunks that are absent (or not lit) are walls of nothing: no light enters or leaves them.
 */
import { ID_MASK } from '../../src/blocks/cell';
import { EMIT, LIGHT_OPACITY } from '../../src/blocks/registry';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { cellIndex, chunkKey, type Chunk } from '../../src/voxel/chunk';
import type { World } from '../../src/voxel/world';

const ABSENT = 255;

export interface ReferenceLight {
  /** World x/z of flat index 0. */
  x0: number;
  z0: number;
  /** Flat box size in cells. */
  sx: number;
  sz: number;
  sky: Uint8Array;
  block: Uint8Array;
  /** Number of full sweeps it took. */
  sweeps: number;
}

export function computeReference(world: World, include: (c: Chunk) => boolean = (c) => c.lit): ReferenceLight {
  const chunks = [...world.chunks.values()].filter(include);
  if (chunks.length === 0) throw new Error('reference: no chunks');
  let minCx = Infinity;
  let minCz = Infinity;
  let maxCx = -Infinity;
  let maxCz = -Infinity;
  for (const c of chunks) {
    minCx = Math.min(minCx, c.cx);
    minCz = Math.min(minCz, c.cz);
    maxCx = Math.max(maxCx, c.cx);
    maxCz = Math.max(maxCz, c.cz);
  }
  const sx = (maxCx - minCx + 1) * 16;
  const sz = (maxCz - minCz + 1) * 16;
  const H = WORLD_HEIGHT;
  const layer = sx * sz;
  const n = layer * H;
  const op = new Uint8Array(n).fill(ABSENT);
  const emit = new Uint8Array(n);
  for (const c of chunks) {
    const bx = (c.cx - minCx) * 16;
    const bz = (c.cz - minCz) * 16;
    for (let y = 0; y < H; y++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const id = c.cells[cellIndex(lx, y, lz)]! & ID_MASK;
          const f = y * layer + (bz + lz) * sx + (bx + lx);
          op[f] = Math.min(LIGHT_OPACITY[id]!, 15);
          emit[f] = EMIT[id]!;
        }
      }
    }
  }

  const sky = new Uint8Array(n);
  const block = new Uint8Array(n);
  let sweeps = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const down = (sweeps & 1) === 0;
    const xFwd = (sweeps & 2) === 0;
    const zFwd = (sweeps & 4) === 0;
    for (let yy = 0; yy < H; yy++) {
      const y = down ? H - 1 - yy : yy;
      for (let zz = 0; zz < sz; zz++) {
        const z = zFwd ? zz : sz - 1 - zz;
        for (let xx = 0; xx < sx; xx++) {
          const x = xFwd ? xx : sx - 1 - xx;
          const f = y * layer + z * sx + x;
          const o = op[f]!;
          if (o === ABSENT) continue;
          let s = 0;
          let b = emit[f]!;
          if (o < 15) {
            const cost = Math.max(1, o);
            const above = y === H - 1 ? 15 : sky[f + layer]!;
            s = o === 0 ? above : above - cost;
            if (y < H - 1) b = Math.max(b, block[f + layer]! - cost);
            if (y > 0) {
              s = Math.max(s, sky[f - layer]! - cost);
              b = Math.max(b, block[f - layer]! - cost);
            }
            if (x > 0 && op[f - 1] !== ABSENT) {
              s = Math.max(s, sky[f - 1]! - cost);
              b = Math.max(b, block[f - 1]! - cost);
            }
            if (x < sx - 1 && op[f + 1] !== ABSENT) {
              s = Math.max(s, sky[f + 1]! - cost);
              b = Math.max(b, block[f + 1]! - cost);
            }
            if (z > 0 && op[f - sx] !== ABSENT) {
              s = Math.max(s, sky[f - sx]! - cost);
              b = Math.max(b, block[f - sx]! - cost);
            }
            if (z < sz - 1 && op[f + sx] !== ABSENT) {
              s = Math.max(s, sky[f + sx]! - cost);
              b = Math.max(b, block[f + sx]! - cost);
            }
            if (s < 0) s = 0;
          }
          if (s !== sky[f] || b !== block[f]) {
            sky[f] = s;
            block[f] = b;
            changed = true;
          }
        }
      }
    }
    sweeps++;
    if (sweeps > 400) throw new Error('reference relighter did not converge');
  }
  return { x0: minCx * 16, z0: minCz * 16, sx, sz, sky, block, sweeps };
}

export interface Mismatch {
  x: number;
  y: number;
  z: number;
  cell: number;
  engineSky: number;
  engineBlock: number;
  refSky: number;
  refBlock: number;
}

/** Every lit cell where the engine's stored light differs from the reference. */
export function diffAgainstReference(world: World, ref: ReferenceLight = computeReference(world)): Mismatch[] {
  const out: Mismatch[] = [];
  const layer = ref.sx * ref.sz;
  for (const c of world.chunks.values()) {
    if (!c.lit) continue;
    const bx = c.cx * 16 - ref.x0;
    const bz = c.cz * 16 - ref.z0;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const i = cellIndex(lx, y, lz);
          const f = y * layer + (bz + lz) * ref.sx + (bx + lx);
          const l = c.light[i]!;
          if (l >> 4 !== ref.sky[f] || (l & 15) !== ref.block[f]) {
            out.push({
              x: c.cx * 16 + lx,
              y,
              z: c.cz * 16 + lz,
              cell: c.cells[i]!,
              engineSky: l >> 4,
              engineBlock: l & 15,
              refSky: ref.sky[f]!,
              refBlock: ref.block[f]!,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Human-readable summary of the first few mismatches (for assertion messages). */
export function describeMismatches(m: Mismatch[], max = 8): string {
  if (m.length === 0) return 'no mismatches';
  const lines = m
    .slice(0, max)
    .map(
      (e) =>
        `(${e.x},${e.y},${e.z}) id=${e.cell & ID_MASK} engine sky/block=${e.engineSky}/${e.engineBlock} ref=${e.refSky}/${e.refBlock}`,
    );
  return `${m.length} mismatches:\n  ${lines.join('\n  ')}`;
}

/** Columns whose stored heightmap differs from a from-scratch scan. */
export function heightmapErrors(world: World): string[] {
  const out: string[] = [];
  for (const c of world.chunks.values()) {
    if (!c.lit) continue;
    for (let col = 0; col < 256; col++) {
      let h = 0;
      for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
        if (LIGHT_OPACITY[c.cells[col | (y << 8)]! & ID_MASK]! > 0) {
          h = y + 1;
          break;
        }
      }
      if (c.heightmap[col] !== h) {
        out.push(`chunk ${c.cx},${c.cz} col ${col & 15},${col >> 4}: stored ${c.heightmap[col]} expected ${h}`);
      }
    }
  }
  return out;
}

/** Snapshot of every lit chunk's light bytes, keyed by chunk key (for order-independence checks). */
export function lightSnapshot(world: World): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  for (const c of world.chunks.values()) if (c.lit) out.set(chunkKey(c.cx, c.cz), c.light.slice());
  return out;
}
