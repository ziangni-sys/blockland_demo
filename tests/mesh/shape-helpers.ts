/**
 * Test helpers for meshing partial cells (docs/SHAPES.md 8): reading a mesh input back as packed
 * cells, random partial cells, and describing quads by the face region they cover.
 */
import { CELL_MULTI_BIT, FULL_LIMIT, makePart, packCell } from '../../src/blocks/cell';
import { CUTTABLE, BLOCKS } from '../../src/blocks/registry';
import { canonCell } from '../../src/blocks/shapes';
import type { Rng } from '../../src/core/rng';
import type { MeshInput } from '../../src/mesh/types';
import { dirOfQuad, idx, put, type Quad } from './helpers';

/** Every registered cuttable material (docs/SHAPES.md 1.4). */
export const CUTTABLE_IDS: readonly number[] = BLOCKS.filter((d) => d !== undefined && CUTTABLE[d.id] === 1).map((d) => d!.id);

/** The packed content (blocks/cell.ts) of padded-interior cell (x, y, z) of a mesh input, read from its three layers. */
export function packedAt(input: MeshInput, x: number, y: number, z: number): number {
  const i = idx(input, x, y, z);
  const part1 = input.cells[i]! | ((input.holes !== null ? input.holes[i]! : 0) << 16);
  const p2 = input.part2 !== null ? input.part2[i]! : 0;
  return p2 === 0 ? part1 : packCell(part1 + CELL_MULTI_BIT, p2);
}

/** The cell has holes or a second part (docs/SHAPES.md 8.2 "partial"). */
export function isPartial(packed: number): boolean {
  return packed >= FULL_LIMIT;
}

/** Write a cell made of one or two parts (part values) into the input, in canonical order. */
export function putParts(input: MeshInput, x: number, y: number, z: number, a: number, b = 0): void {
  put(input, x, y, z, canonCell(a, b));
}

/** A random part fill 1..0xfe (never the full cell). */
export function randomFill(rng: Rng): number {
  return rng.int(1, 0xfe);
}

/** A random partial cell: one cut part (any fill but full) or two disjoint cut parts. */
export function randomPartialCell(rng: Rng, ids: readonly number[] = CUTTABLE_IDS): number {
  const fa = randomFill(rng);
  const idA = ids[rng.int(0, ids.length - 1)]!;
  const a = makePart(idA, rng.int(0, 3), ~fa & 0xff);
  const rest = ~fa & 0xff;
  if (rng.chance(0.5) || rest === 0) return canonCell(a, 0);
  let fb = 0;
  while (fb === 0) fb = rest & rng.int(1, 0xff);
  const idB = ids[rng.int(0, ids.length - 1)]!;
  return canonCell(a, makePart(idB, rng.int(0, 3), ~fb & 0xff));
}

/** Axis-aligned bounds of a quad's corners. */
export function quadBounds(q: Quad): [number, number, number, number, number, number] {
  const xs = q.p.map((p) => p.x);
  const ys = q.p.map((p) => p.y);
  const zs = q.p.map((p) => p.z);
  return [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)];
}

/** "d|x0,y0,z0|x1,y1,z1" of an axis-aligned quad: the face region it covers and the way it faces. */
export function faceKey(q: Quad): string {
  const b = quadBounds(q);
  return `${dirOfQuad(q)}|${b[0]},${b[1]},${b[2]}|${b[3]},${b[4]},${b[5]}`;
}

/** The key faceKey gives the face of the box [lo, lo + size]^3 (box-space) toward Dir d. */
export function boxFaceKey(d: number, lx: number, ly: number, lz: number, size: number): string {
  const lo = [lx, ly, lz];
  const hi = [lx + size, ly + size, lz + size];
  const a = d >> 1;
  if ((d & 1) === 0) lo[a] = hi[a]!;
  else hi[a] = lo[a]!;
  return `${d}|${lo.join(',')}|${hi.join(',')}`;
}

/**
 * The interior cell a quad belongs to: for an axis-aligned quad, the cell behind its plane
 * (along the normal) that contains its lower corner on the other two axes.
 */
export function ownerCell(q: Quad): [number, number, number] {
  const d = dirOfQuad(q);
  const b = quadBounds(q);
  const out: [number, number, number] = [Math.floor(b[0]), Math.floor(b[1]), Math.floor(b[2])];
  const a = d >> 1;
  if ((d & 1) === 0) out[a] = Math.ceil(b[a]!) - 1;
  return out;
}

/** Area of a quad from its two index triangles (a padded triangle counts once). */
export function quadArea(q: Quad): number {
  let s = 0;
  for (let t = 0; t < 2; t++) {
    const a = q.p[q.idx[t * 3]!]!;
    const b = q.p[q.idx[t * 3 + 1]!]!;
    const c = q.p[q.idx[t * 3 + 2]!]!;
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    s += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return s;
}
