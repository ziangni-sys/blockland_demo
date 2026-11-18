/**
 * Package 13, regression: a room of four on a home uplink in the scenes of play that stress it
 * (room-scenes.ts; the measurements are in docs/NETCODE.md section 13): a 3700-cell ship
 * assembling and docking beside everybody, all four on a sailing windmill boat, a chain of blast
 * crates, a dam break. Bounds are the measured values with room to spare; they count bytes and
 * ticks (and milliseconds of the virtual clock), never wall time.
 */
import { describe, expect, it } from 'vitest';
import { bigShip, blastChain, damBreak, windmillShip, type RoomReport } from './room-scenes';

const MBIT = 125_000;
const KBIT_256 = 32_000;

function every(r: RoomReport, f: (g: RoomReport['guests'][number]) => void): void {
  expect(r.guests.length).toBe(3);
  for (const g of r.guests) f(g);
}

describe('a room of four at play (package 13)', () => {
  it('a 3700-cell ship assembles and docks beside everybody: one batch of under 9 KB each, through 1 Mbit/s in 0.2 s', async () => {
    const r = await bigShip(MBIT);
    every(r, (g) => {
      // Measured: the assembly batch 7706 bytes (3700 cells leaving the world and the ship's record).
      expect(g.largestBatch).toBeGreaterThan(5000);
      expect(g.largestBatch).toBeLessThan(9000);
      expect(g.waitMaxMs).toBeLessThan(400);
    });
  }, 120_000);

  it('all four on the sailing windmill boat: about 4.3 KB/s on the wire for each guest', async () => {
    const r = await windmillShip(MBIT);
    every(r, (g) => {
      // Measured 325 B/s of batches, 697 B/s of samples, 4305 B/s on the wire.
      expect(g.batchBps).toBeLessThan(600);
      expect(g.sampleBps).toBeLessThan(1000);
      expect(g.wireBps).toBeLessThan(5500);
      expect(g.waitMaxMs).toBeLessThan(50);
    });
  }, 120_000);

  it('a chain of blast crates on 256 kbit/s: the samples give way, the batches wait under 0.7 s', async () => {
    const r = await blastChain(KBIT_256);
    every(r, (g) => {
      // Measured 329 ms (before package 13: 1387 ms, four Samples messages a tick in front of every batch).
      expect(g.waitMaxMs).toBeLessThan(700);
      // The samples were cut to what the share carries (measured 4.9 KB/s; 24.7 KB/s on 5 Mbit/s).
      expect(g.sampleBps).toBeLessThan(8000);
      expect(g.sampleBps).toBeGreaterThan(1000);
    });
  }, 120_000);

  it('a longer chain whose must-send content alone overruns the share of 256 kbit/s: no samples while the batches queue past the line', async () => {
    const r = await blastChain(KBIT_256, false, true);
    every(r, (g) => {
      // Measured 478 ms, sample gaps 95% within 8 ticks (with samples sent while batches queued:
      // 736 ms and 16 ticks, the samples taking a third of the share).
      expect(g.waitMaxMs).toBeLessThan(600);
      expect(g.sampleGapP95).toBeLessThanOrEqual(12);
      expect(g.sampleBps).toBeGreaterThan(1000);
    });
  }, 120_000);

  it('a dam breaks beside the players: a few hundred bytes a second', async () => {
    const r = await damBreak(MBIT);
    every(r, (g) => {
      // Measured 193 B/s of batches (37 of them cell deltas), 1.9 KB/s on the wire.
      expect(g.batchBps).toBeLessThan(400);
      expect(g.wireBps).toBeLessThan(2500);
    });
  }, 120_000);
});
