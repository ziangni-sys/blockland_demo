/**
 * Package 13, regression: three guests join a room at once beside a built-up area (room-scenes.ts;
 * the measurements are in docs/NETCODE.md section 13), on host uplinks of 256 kbit/s, 1 Mbit/s and
 * 5 Mbit/s shared by the guests. Bounds are the measured values with room to spare; they count
 * bytes and ticks (and milliseconds of the virtual clock), never wall time.
 */
import { describe, expect, it } from 'vitest';
import { joinBuiltUp, type RoomReport } from './room-scenes';

const MBIT = 125_000;
const KBIT_256 = 32_000;

function every(r: RoomReport, f: (g: RoomReport['guests'][number]) => void): void {
  expect(r.guests.length).toBe(3);
  for (const g of r.guests) f(g);
}

describe('three guests join a room of four at once (package 13)', () => {
  it('three guests join at once beside a built-up area: each batch starts within about 0.1 s plus one snapshot, the joins take about 3 s', async () => {
    const r = await joinBuiltUp(MBIT);
    every(r, (g) => {
      // Measured 150 ms (before package 13: 687 ms, a full 16 KB of snapshots in front of every batch);
      // 95th percentile 100 ms (163 ms when a snapshot longer than the budget left goes anyway).
      expect(g.waitMaxMs).toBeLessThan(300);
      expect(g.waitP95Ms).toBeLessThan(140);
      // Measured 63 ticks to ready, 115 to every column of the circle.
      expect(g.joinTicks).not.toBeNull();
      expect(g.joinTicks!).toBeLessThan(100);
      expect(g.completeTicks!).toBeLessThan(180);
      // The uplink's share is used: about 37 KB/s of snapshots each.
      expect(g.sections.snapshots ?? 0).toBeGreaterThan(25_000);
    });
  }, 120_000);

  it('on 256 kbit/s the joins take about 13 s and a batch waits behind at most a floor of 2 KiB and one snapshot', async () => {
    const r = await joinBuiltUp(KBIT_256);
    every(r, (g) => {
      // Measured 490 ms (with the old floor of 8 KiB about 1.1 s; before package 13: 2956 ms).
      expect(g.waitMaxMs).toBeLessThan(750);
      // Measured 269 ticks to ready, 509 to the whole circle.
      expect(g.joinTicks!).toBeLessThan(330);
      expect(g.completeTicks!).toBeLessThan(600);
    });
  }, 120_000);

  it('on 5 Mbit/s the joins take about a second: the line grows as fast as the link carries', async () => {
    const r = await joinBuiltUp(5 * MBIT);
    every(r, (g) => {
      // Measured 20 ticks to ready, 27 to the whole circle (27 and 34 if the send rate only follows
      // its smoothed measurement, without doubling while each tick's bytes go through).
      expect(g.joinTicks!).toBeLessThan(24);
      expect(g.completeTicks!).toBeLessThan(31);
      expect(g.waitMaxMs).toBeLessThan(150);
    });
  }, 120_000);

  it('a server Worker busy for 200 ms every 2 s (long ticks, GC) does not make the guests wait: the backlog reports it gets bunched are not read as a fast link', async () => {
    // With the drain measured between reports that arrived 0.02 ms apart, the backlog read 0 after
    // every report and a full budget went into each full channel: one stall made batches wait
    // 8.6 s at 256 kbit/s and 4.5 s at 1 Mbit/s. Measured with the stalls: 529 ms and 186 ms
    // (without them 522 ms and 190 ms).
    for (const [uplink, waitMs] of [
      [KBIT_256, 750],
      [MBIT, 300],
    ] as const) {
      const r = await joinBuiltUp(uplink, false, { everyTicks: 40, ms: 200 });
      every(r, (g) => {
        expect(g.waitMaxMs).toBeLessThan(waitMs);
        expect(g.completeTicks).not.toBeNull();
      });
    }
  }, 240_000);
});
