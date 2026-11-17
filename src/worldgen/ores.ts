/**
 * Ore blobs. Each chunk column owns a fixed number of blobs per ore, seeded from a hash of
 * the chunk coordinates. A blob reaches at most ORE_REACH cells from its centre, so a chunk
 * is complete after replaying the blobs of itself and its 8 neighbours and keeping the
 * cells that land inside it (seam-free, no neighbour access). Ores only replace stone, so
 * running after the cave pass leaves cave air untouched and exposes ores on cave walls.
 */
import { CHUNK_SIZE } from '../core/constants';
import { Rng, hash3 } from '../core/rng';
import { makeCell } from '../blocks/cell';
import { B } from '../blocks/defs';
import { latticeHash3 } from './noise';

interface OreDef {
  cell: number;
  /** Range of blob centre heights (inclusive). */
  minY: number;
  maxY: number;
  /** Blobs per chunk column. */
  count: number;
  /** Sphere radius range. */
  rMin: number;
  rMax: number;
  /** Max length of the blob's spine (blobs are short capsules). */
  len: number;
  salt: number;
}

const ORES: readonly OreDef[] = [
  { cell: makeCell(B.COAL_ORE), minY: 10, maxY: 90, count: 16, rMin: 0.9, rMax: 1.6, len: 2.6, salt: 0x31 },
  { cell: makeCell(B.IRON_ORE), minY: 5, maxY: 60, count: 9, rMin: 0.8, rMax: 1.3, len: 1.8, salt: 0x32 },
  { cell: makeCell(B.COPPER_ORE), minY: 20, maxY: 70, count: 8, rMin: 0.9, rMax: 1.5, len: 2.4, salt: 0x33 },
];

/** Largest distance of an ore cell from its blob centre (spine half-length + radius). */
export const ORE_REACH = 3;

const STONE = makeCell(B.STONE);

export class OreStamper {
  private readonly seed: number;
  private readonly rng = new Rng(0);

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** Place the ores of the chunk (cx, cz) and of the blobs reaching in from its neighbours. */
  stamp(cells: Uint16Array, cx: number, cz: number): void {
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const rng = this.rng;
    for (let o = 0; o < ORES.length; o++) {
      const ore = ORES[o]!;
      for (let sz = cz - 1; sz <= cz + 1; sz++) {
        for (let sx = cx - 1; sx <= cx + 1; sx++) {
          rng.state = hash3(sx, ore.salt, sz, this.seed);
          for (let b = 0; b < ore.count; b++) {
            // Draw every random number of the blob up front so the stream is identical
            // whether or not the blob is skipped below.
            const bx = sx * CHUNK_SIZE + rng.next() * CHUNK_SIZE;
            const bz = sz * CHUNK_SIZE + rng.next() * CHUNK_SIZE;
            const by = ore.minY + rng.next() * (ore.maxY - ore.minY + 1);
            const r = ore.rMin + rng.next() * (ore.rMax - ore.rMin);
            const len = rng.next() * ore.len;
            // Random spine direction (not normalised exactly uniform; shape variety is all we need).
            let dx = rng.next() - 0.5;
            let dy = (rng.next() - 0.5) * 0.5;
            let dz = rng.next() - 0.5;
            const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            dx = (dx / dl) * len * 0.5;
            dy = (dy / dl) * len * 0.5;
            dz = (dz / dl) * len * 0.5;
            const salt = rng.nextU32();
            // Skip blobs that cannot reach this chunk.
            if (bx + ORE_REACH < x0 || bx - ORE_REACH >= x0 + CHUNK_SIZE) continue;
            if (bz + ORE_REACH < z0 || bz - ORE_REACH >= z0 + CHUNK_SIZE) continue;
            this.blob(cells, x0, z0, ore.cell, bx, by, bz, dx, dy, dz, r, salt);
          }
        }
      }
    }
  }

  /** Capsule from (c - d) to (c + d) with radius r; ragged surface from a per-cell hash. */
  private blob(
    cells: Uint16Array,
    x0: number,
    z0: number,
    cell: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    r: number,
    salt: number,
  ): void {
    const ext = Math.ceil(r + Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)));
    const ax = cx - dx;
    const ay = cy - dy;
    const az = cz - dz;
    const sx = 2 * dx;
    const sy = 2 * dy;
    const sz = 2 * dz;
    const ss = sx * sx + sy * sy + sz * sz;
    const r2 = r * r;
    const xa = Math.max(x0, Math.floor(cx) - ext);
    const xb = Math.min(x0 + CHUNK_SIZE - 1, Math.floor(cx) + ext);
    const za = Math.max(z0, Math.floor(cz) - ext);
    const zb = Math.min(z0 + CHUNK_SIZE - 1, Math.floor(cz) + ext);
    const ya = Math.max(1, Math.floor(cy) - ext);
    const yb = Math.min(126, Math.floor(cy) + ext);
    for (let y = ya; y <= yb; y++) {
      for (let z = za; z <= zb; z++) {
        for (let x = xa; x <= xb; x++) {
          // Distance from the cell centre to the spine segment.
          const px = x + 0.5 - ax;
          const py = y + 0.5 - ay;
          const pz = z + 0.5 - az;
          let t = ss > 0 ? (px * sx + py * sy + pz * sz) / ss : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = px - sx * t;
          const qy = py - sy * t;
          const qz = pz - sz * t;
          const d2 = qx * qx + qy * qy + qz * qz;
          if (d2 > r2) continue;
          if (d2 > r2 * 0.5 && (latticeHash3(salt | 0, x, y, z) & 3) === 0) continue;
          const i = (x - x0) | ((z - z0) << 4) | (y << 8);
          if (cells[i] === STONE) cells[i] = cell;
        }
      }
    }
  }
}
