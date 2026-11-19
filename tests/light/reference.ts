/**
 * Brute-force reference relighter for the light engine tests: a direct implementation of
 * docs/SHAPES.md section 7.1, written from the text of the specification (not from the engine).
 *
 * It knows nothing about queues, removal or the engine's fast paths: it copies the lit chunks of
 * a world into flat arrays, starts every cell at 0 and applies the local light rule in repeated
 * full sweeps (alternating directions) until nothing changes. Values only ever increase, so this
 * reaches the least fixed point, which is the unique fixed point of the rule. For a cell c
 * (packed contents, both parts) and a direction d with neighbour n:
 *
 *   op(c) = lightOpacity(c), emit(c) = lightEmit(c), cost(c) = max(1, op(c))
 *   open(c, d) = lightOpen(c, n, d)          (the opaque covers of both sides do not fill the face)
 *   from(c, d) = open ? level(n) : (block light ? emitInto(c, n, d) : 0)
 *   take(c, d) = from(c, d) - cost(c); sky light with d = up, op(c) = 0 and open: from(c, d)
 *   block(c) = max(emit(c), max_d take(c, d))
 *   sky(c)   = max(skySrc(c), max_d take(c, d))
 *   skySrc(c) = 15 at or above the heightmap; on the top layer, open(c, up) ? 15 - cost(c) : 0
 *   heightmap = 1 + the highest y with direct(y) false; direct(TOP_Y + 1) is true and
 *              direct(y) = direct(y + 1) && op(y) === 0 && open(y, up)
 *
 * The layer above the world is a virtual row of cells that cover nothing (air), hold sky light
 * 15 and emit nothing; it is the up-neighbour of the top layer. The four light queries are the
 * value queries of section 3.2 (src/blocks/shapes.ts). Chunks that are absent (or not lit) are
 * walls of nothing: no light enters or leaves them.
 */
import { CELL_MULTI_BIT, ID_MASK, packCell } from '../../src/blocks/cell';
import { emitInto, lightEmit, lightOpacity, lightOpen } from '../../src/blocks/shapes';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { NX, NY, NZ, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import { cellIndex, chunkKey, type Chunk } from '../../src/voxel/chunk';
import type { World } from '../../src/voxel/world';

const TOP_Y = WORLD_HEIGHT - 1;
// Local copies of imported bindings used in the loops: vitest turns every use of an imported
// binding into a getter call, which made this reference several times slower.
const UP: Dir = PY;
const DIRS: readonly Dir[] = [PX, NX, PY, NY, PZ, NZ];
const lightOpenQ = lightOpen;
const emitIntoQ = emitInto;
const ABSENT = 255;
/** The virtual cell above the world: covers nothing, emits nothing. */
const VIRTUAL = 0;

/** Packed contents (both parts) of cell i of a chunk, from its three layers. */
export function chunkCell(c: Chunk, i: number): number {
  const holes = c.holes === null ? 0 : c.holes[i]!;
  const p2 = c.part2 === null ? 0 : c.part2[i]!;
  return packCell(c.cells[i]! | (holes << 16) | (p2 !== 0 ? CELL_MULTI_BIT : 0), p2);
}

/** heightmap of one column from the direct() recursion; cell(y) gives the packed contents. */
export function referenceHeight(cell: (y: number) => number): number {
  for (let y = TOP_Y; y >= 0; y--) {
    const c = cell(y);
    const above = y === TOP_Y ? VIRTUAL : cell(y + 1);
    // direct(y + 1) holds here (the loop stops at the first y where direct is false).
    if (lightOpacity(c) !== 0 || !lightOpen(c, above, PY)) return y + 1;
  }
  return 0;
}

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
  // Distinct cell contents get a small index, so each query of section 3.2 runs once per
  // distinct value (or pair of values and direction) instead of once per cell.
  const valueIndex = new Map<number, number>();
  const values: number[] = [];
  const indexOf = (v: number): number => {
    let k = valueIndex.get(v);
    if (k === undefined) {
      k = values.length;
      values.push(v);
      valueIndex.set(v, k);
    }
    return k;
  };
  const virtual = indexOf(VIRTUAL);
  const vi = new Int32Array(n).fill(-1);
  for (const c of chunks) {
    const bx = (c.cx - minCx) * 16;
    const bz = (c.cz - minCz) * 16;
    for (let y = 0; y < H; y++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) vi[y * layer + (bz + lz) * sx + (bx + lx)] = indexOf(chunkCell(c, cellIndex(lx, y, lz)));
      }
    }
  }
  const K = values.length;
  const opOfValue = values.map((v) => lightOpacity(v));
  const emitOfValue = values.map((v) => lightEmit(v));
  // [(a * K + b) * 6 + d] = open(a, b, d) | emitInto(a, b, d) << 1, -1 until computed.
  const pairs = new Int16Array(K * K * 6).fill(-1);
  const face = (a: number, b: number, d: Dir): number => {
    const key = (a * K + b) * 6 + d;
    let v = pairs[key]!;
    if (v < 0) {
      v = (lightOpenQ(values[a]!, values[b]!, d) ? 1 : 0) | (emitIntoQ(values[a]!, values[b]!, d) << 1);
      pairs[key] = v;
    }
    return v;
  };

  // Per cell: op, emit, skySrc; per cell and direction: the flat index of the neighbour
  // (ABSENT_INDEX for none; the virtual layer above the world is one more layer of the light
  // arrays, at n + column, with sky light 15 and block light 0) and open | emitInto << 1.
  const op = new Uint8Array(n).fill(ABSENT);
  const emit = new Uint8Array(n);
  const skySrc = new Uint8Array(n);
  const rule = new Uint8Array(n * 6);
  const nb = new Int32Array(n * 6);
  const ABSENT_INDEX = -1;
  const step = [1, -1, layer, -layer, sx, -sx];
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const f = y * layer + z * sx + x;
        const a = vi[f]!;
        if (a < 0) continue;
        op[f] = opOfValue[a]!;
        emit[f] = emitOfValue[a]!;
        for (const d of DIRS) {
          // Dir order: +x, -x, +y, -y, +z, -z.
          const inside = d === 0 ? x < sx - 1 : d === 1 ? x > 0 : d === 2 ? y < H - 1 : d === 3 ? y > 0 : d === 4 ? z < sz - 1 : z > 0;
          let g: number;
          let b: number;
          if (inside && vi[f + step[d]!]! >= 0) {
            g = f + step[d]!;
            b = vi[g]!;
          } else if (d === UP && y === H - 1) {
            g = n + z * sx + x;
            b = virtual;
          } else {
            nb[f * 6 + d] = ABSENT_INDEX;
            continue;
          }
          nb[f * 6 + d] = g;
          rule[f * 6 + d] = face(a, b, d);
        }
      }
    }
  }
  // Heightmaps by direct(), and skySrc.
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      if (vi[z * sx + x]! < 0) continue;
      const h = referenceHeight((y) => values[vi[y * layer + z * sx + x]!]!);
      for (let y = 0; y < H; y++) {
        const f = y * layer + z * sx + x;
        if (y >= h) skySrc[f] = 15;
        else if (y === TOP_Y) skySrc[f] = (rule[f * 6 + UP]! & 1) !== 0 ? 15 - Math.max(1, op[f]!) : 0;
      }
    }
  }

  const sky = new Uint8Array(n + layer).fill(15, n);
  const block = new Uint8Array(n + layer);
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
          if (op[f] === ABSENT) continue;
          const o = op[f]!;
          const cost = Math.max(1, o);
          let s = skySrc[f]!;
          let b = emit[f]!;
          // With cost 15 every take is from - 15 <= 0: the cell keeps its sources.
          for (let d = 0; d < 6 && cost < 15; d++) {
            const k = f * 6 + d;
            const g = nb[k]!;
            if (g === ABSENT_INDEX) continue;
            const r = rule[k]!;
            if ((r & 1) !== 0) {
              const ts = d === UP && o === 0 ? sky[g]! : sky[g]! - cost;
              if (ts > s) s = ts;
              if (block[g]! - cost > b) b = block[g]! - cost;
            } else if ((r >> 1) - cost > b) b = (r >> 1) - cost;
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
  return { x0: minCx * 16, z0: minCz * 16, sx, sz, sky: sky.subarray(0, n), block: block.subarray(0, n), sweeps };
}

export interface Mismatch {
  x: number;
  y: number;
  z: number;
  /** Packed contents of the cell. */
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
              cell: chunkCell(c, i),
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
  const lines = m.slice(0, max).map((e) => {
    const holes = Math.floor(e.cell / 65536) % 256;
    const p2 = Math.floor(e.cell / 2 ** 25);
    const shape = holes !== 0 ? ` holes=${holes.toString(16)}${p2 !== 0 ? ` part2=${p2.toString(16)}` : ''}` : '';
    return `(${e.x},${e.y},${e.z}) id=${e.cell % 65536 & ID_MASK}${shape} engine sky/block=${e.engineSky}/${e.engineBlock} ref=${e.refSky}/${e.refBlock}`;
  });
  return `${m.length} mismatches:\n  ${lines.join('\n  ')}`;
}

/** Columns whose stored heightmap differs from the direct() recursion of section 7.1. */
export function heightmapErrors(world: World): string[] {
  const out: string[] = [];
  for (const c of world.chunks.values()) {
    if (!c.lit) continue;
    for (let col = 0; col < 256; col++) {
      const h = referenceHeight((y) => chunkCell(c, col | (y << 8)));
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
