/**
 * Bandwidth with partial blocks (docs/SHAPES.md 16.2 P10 "带宽重量"; NETCODE sections 5, 6 and 13):
 * a heavily chiselled scene against the same scene in full blocks, through the real Replicator and
 * codec (tests/net/rig.ts).
 *
 * The scene: a 16 x 16 x 16 volume (one chunk column, y T..T+15) where every cell is filled and
 * every second cell (x + y + z odd) is partial, cycling through a lower slab, a stair, a two-part
 * cell (stone below, planks above) and a carved cell (one octant out). The full scene has the same
 * cells as full blocks of their first part's material. Then each tick K cells of the volume change
 * (seeded positions), each to the next value of its cycle (partial scene) or to the next full block
 * of that cycle's materials (full scene). A third scene draws every partial cell's fill from a seeded
 * hash (four materials, about a thousand distinct values), so the column's palette is large.
 *
 * Measured, for the report ([shapes-bandwidth] lines) and with ceilings that keep the encoding
 * honest: the bytes of the chunk deltas per changed cell, the batch bytes per tick, the snapshot of
 * the volume's column (what a joining client receives for it) and the total a client joining with
 * view radius 2 receives until the column is in its replica.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, withoutOctant } from '../../src/blocks/shapes';
import { PX } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { ByteWriter } from '../../src/save/bytes';
import { writeCellVolume } from '../../src/save/cells';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { LOWER, slab, stairFill, UPPER } from '../shapes';
import { Rig } from './rig';

const T = new FlatGenerator().top;
const N = 16;
/** Cells changed per tick, and ticks measured. */
const K = 4;
const TICKS = 200;

/** The partial values of the cycle, and the full block each stands for (its first part's material). */
const PARTIAL: readonly number[] = [
  slab(B.STONE, LOWER),
  slab(B.PLANKS_OAK, stairFill(PX)),
  canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)),
  withoutOctant(makeCell(B.BRICKS), 5),
];
const FULL: readonly number[] = [makeCell(B.STONE), makeCell(B.PLANKS_OAK), makeCell(B.STONE), makeCell(B.BRICKS)];
/** The cells that are full in both scenes. */
const SOLID = makeCell(B.COBBLE);

type Scene = 'full' | 'chiselled' | 'varied';

/** Materials of the varied scene, and a hash of a cell (and its step) into 1..254: a fill with holes. */
const VARIED: readonly number[] = [B.STONE, B.PLANKS_OAK, B.BRICKS, B.WOOL_WHITE];
function hashFill(x: number, y: number, z: number, k: number): number {
  const h = Math.imul(x * 73856093 ^ y * 19349663 ^ z * 83492791 ^ k * 2654435761, 0x9e3779b1) >>> 0;
  return 1 + (h % 254);
}

function valueAt(scene: Scene, x: number, y: number, z: number, k: number): number {
  if (((x + y + z) & 1) === 0) return SOLID;
  const i = (x + 2 * y + 3 * z + k) % PARTIAL.length;
  if (scene === 'full') return FULL[i]!;
  if (scene === 'chiselled') return PARTIAL[i]!;
  return slab(VARIED[i]!, hashFill(x, y, z, k));
}

interface Measured {
  /** Bytes of the chunk deltas (cells) per changed cell. */
  deltaPerCell: number;
  /** Mean reliable batch bytes per tick while K cells change each tick. */
  batchPerTick: number;
  /** Bytes of the column's CellVolume (the cells of its snapshot). */
  volumeBytes: number;
  /** Bytes a client joining with view radius 2 receives until the column is in its replica. */
  joinBytes: number;
}

function measure(scene: Scene): Measured {
  const sim = new Simulation({ seed: 5, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, loadRadius: 2, rabbits: false, spawn: { x: 0.5, y: T + N, z: -20.5 } });
  const rig = new Rig(sim);
  rig.checkEveryTick = false;
  const watcher = rig.join('w', { viewRadius: 2 });
  rig.tick(2);
  for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) sim.world.setCell(x, T + y, z, valueAt(scene, x, y, z, 0));
  rig.tick(2);
  // The chunk's snapshot: the CellVolume of its layers (NETCODE 6; the codec of save/cells.ts).
  const w = new ByteWriter(4096);
  writeCellVolume(w, sim.world.getChunk(0, 0)!.layers());
  const volumeBytes = w.length;
  // A client joins at the spawn, 20 cells north (view radius 2: the volume's column and 12 pristine ones), and receives the column.
  const joiner = rig.join('j', { viewRadius: 2 });
  rig.tick(1);
  let joinBytes = 0;
  for (let i = 0; i < 20 && !(joiner.state.columns as unknown as { present(cx: number, cz: number): boolean }).present(0, 0); i++) rig.tick(1);
  expect((joiner.state.columns as unknown as { present(cx: number, cz: number): boolean }).present(0, 0)).toBe(true);
  joinBytes = joiner.batches.reduce((n, b) => n + b.bytes, 0);
  // K cells a tick change to the next value of their cycle.
  const rng = new Rng(77);
  const from = sim.ticks + 1;
  let deltaBytes = 0;
  let changed = 0;
  const k = new Map<number, number>();
  for (let t = 0; t < TICKS; t++) {
    for (let i = 0; i < K; i++) {
      let x: number, y: number, z: number;
      do {
        x = rng.int(0, N - 1);
        y = rng.int(0, N - 1);
        z = rng.int(0, N - 1);
      } while (((x + y + z) & 1) === 0);
      const key = x | (y << 4) | (z << 8);
      const step = (k.get(key) ?? 0) + 1;
      k.set(key, step);
      sim.world.setCell(x, T + y, z, valueAt(scene, x, y, z, step));
    }
    rig.tick(1);
    const b = watcher.batches[watcher.batches.length - 1]!;
    for (const d of b.batch.chunkDeltas) changed += d.cells.length;
  }
  // The deltas' bytes: re-measure each batch without its chunkDeltas section by difference with an
  // empty tick (a batch with nothing in it is the heartbeat; everything else is the same per tick).
  const bs = watcher.batches.filter((b) => b.tick >= from);
  const batchPerTick = bs.reduce((n, b) => n + b.bytes, 0) / bs.length;
  rig.tick(5);
  const idle = watcher.batches.slice(-3).reduce((n, b) => n + b.bytes, 0) / 3;
  deltaBytes = (batchPerTick - idle) * bs.length;
  return { deltaPerCell: deltaBytes / changed, batchPerTick, volumeBytes, joinBytes };
}

describe('bandwidth of partial blocks', () => {
  it('a 16^3 volume, every second cell partial, 4 cells changed a tick: deltas, batches, the snapshot and the join, against the same scene in full blocks', () => {
    const full = measure('full');
    const part = measure('chiselled');
    const varied = measure('varied');
    const line = (name: string, m: Measured): string =>
      `${name}: deltas ${m.deltaPerCell.toFixed(2)} B/changed cell, batches ${m.batchPerTick.toFixed(1)} B/tick, column CellVolume ${m.volumeBytes} B, join (radius 2) ${m.joinBytes} B`;
    console.log(`[shapes-bandwidth] ${line('full blocks', full)}`);
    console.log(`[shapes-bandwidth] ${line('chiselled', part)}`);
    console.log(`[shapes-bandwidth] ${line('chiselled, every partial cell a seeded random fill of 4 materials (about 1000 distinct values)', varied)}`);
    console.log(
      `[shapes-bandwidth] ratio chiselled / full: deltas ${(part.deltaPerCell / full.deltaPerCell).toFixed(2)}, batches ${(part.batchPerTick / full.batchPerTick).toFixed(2)}, column ${(part.volumeBytes / full.volumeBytes).toFixed(2)}, join ${(part.joinBytes / full.joinBytes).toFixed(2)}`,
    );
    // SHAPES 15: a lone cell with holes costs at most 7 bytes in a chunk delta, a two-part cell 11
    // (index difference up to 3, a part with holes up to 4, two of them 4 + 4); the cycle holds three
    // of the first kind and one of the second, so at most 8 bytes a changed cell on average, plus the
    // share of the delta's column header (4 cells a tick share one), which the full scene pays too.
    // The values themselves: a full block is 1 to 2 bytes, so the difference stays under 5.
    expect(part.deltaPerCell).toBeLessThan(9);
    expect(part.deltaPerCell - full.deltaPerCell).toBeLessThan(5);
    expect(full.deltaPerCell).toBeLessThan(5);
    // The column: 2048 partial cells of at most 8 bytes each and their runs.
    expect(part.volumeBytes).toBeLessThan(24 * 1024);
    expect(part.joinBytes).toBeLessThan(part.volumeBytes + 1024);
    // About 1000 distinct values: whichever form the encoder picks, no more than 2048 cells of a part
    // with holes (up to 4 bytes) and 2048 full ones.
    expect(varied.volumeBytes).toBeLessThan(2048 * 4 + 2048 * 2 + 1024);
    expect(varied.deltaPerCell).toBeLessThan(9);
  });
});
