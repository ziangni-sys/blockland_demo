/**
 * Package 13, regression: four players fly apart over terrain, unvisited and modified, in a room
 * on a host uplink of 1 Mbit/s shared by the guests (room-scenes.ts; the measurements are in
 * docs/NETCODE.md section 13; joining is room-join.test.ts). Bounds are the measured values with
 * room to spare; they count bytes and ticks (and milliseconds of the virtual clock), never wall time.
 */
import { describe, expect, it } from 'vitest';
import { flyApart, type RoomReport } from './room-scenes';

const MBIT = 125_000;

function every(r: RoomReport, f: (g: RoomReport['guests'][number]) => void): void {
  expect(r.guests.length).toBe(3);
  for (const g of r.guests) f(g);
}

describe('a room of four flying apart (package 13)', () => {
  it('four fly apart over modified terrain: the snapshots keep the batches within about 0.15 s', async () => {
    const r = await flyApart(MBIT, true);
    every(r, (g) => {
      // Measured 147 ms, 95th percentile 110 ms (before: 732 ms; 172 ms at the 95th percentile when a
      // snapshot longer than the budget left goes anyway).
      expect(g.waitMaxMs).toBeLessThan(400);
      expect(g.waitP95Ms).toBeLessThan(140);
      expect(g.sections.snapshots ?? 0).toBeGreaterThan(20_000);
    });
  }, 120_000);

  it('four fly apart over unvisited terrain: pristine columns cost next to nothing', async () => {
    const r = await flyApart(MBIT, false);
    every(r, (g) => {
      // Measured 287 B/s of batches, 600 B/s of samples, 3.4 KB/s on the wire (most of it headers).
      expect(g.batchBps).toBeLessThan(600);
      expect(g.sampleBps).toBeLessThan(1000);
      expect(g.wireBps).toBeLessThan(4500);
      expect(g.waitMaxMs).toBeLessThan(50);
    });
  }, 120_000);

});
