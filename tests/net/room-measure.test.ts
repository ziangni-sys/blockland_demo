/**
 * The measurement table of package 13 (docs/NETCODE.md section 13): every room scene of
 * room-scenes.ts on every uplink, with the host's wall-time cost. Not part of the suite: it runs
 * only when MEASURE_ROOM names the scenes ('all', or a comma list of join, ship, fly, flymod,
 * windmill, blast, blastline, dam), e.g.
 *
 *   MEASURE_ROOM=all MEASURE_OUT=/tmp/room.txt npx vitest run tests/net/room-measure.test.ts
 *
 * MEASURE_UPLINK picks uplinks by name prefix ('256', '1', '5', and below the table '96', '128',
 * '192'; 'none' for unlimited; default the three of the table). Lines go to the console and, with
 * MEASURE_OUT, are appended to that file.
 */
import { appendFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { bigShip, blastChain, damBreak, flyApart, formatReport, joinBuiltUp, UPLINKS, windmillShip, type RoomReport } from './room-scenes';

const SCENES: Record<string, (uplink: number | null) => Promise<RoomReport>> = {
  join: (u) => joinBuiltUp(u, true),
  ship: (u) => bigShip(u, true),
  fly: (u) => flyApart(u, false, true),
  flymod: (u) => flyApart(u, true, true),
  windmill: (u) => windmillShip(u, true),
  blast: (u) => blastChain(u, true),
  blastline: (u) => blastChain(u, true, true),
  dam: (u) => damBreak(u, true),
};

const wanted = process.env.MEASURE_ROOM ?? '';
const names = wanted === 'all' ? Object.keys(SCENES) : wanted.split(',').filter((n) => n in SCENES);
const uplinkFilter = (process.env.MEASURE_UPLINK ?? '').split(',').filter((s) => s !== '');
/** Below the three of the table, for finding where a room stops being playable (only when asked for). */
const LOW = [
  { name: '96 kbit/s', bytesPerSec: 12_000 },
  { name: '128 kbit/s', bytesPerSec: 16_000 },
  { name: '192 kbit/s', bytesPerSec: 24_000 },
];
const uplinks: Array<{ name: string; bytesPerSec: number | null }> = [...UPLINKS, ...LOW, { name: 'unlimited', bytesPerSec: null }].filter((u) =>
  uplinkFilter.length === 0 ? UPLINKS.includes(u as (typeof UPLINKS)[number]) : uplinkFilter.some((f) => (f === 'none' ? u.bytesPerSec === null : u.name.split(' ')[0] === f)),
);

describe.runIf(names.length > 0)('room measurements (package 13)', () => {
  for (const scene of names) {
    for (const u of uplinks) {
      it(`${scene} on ${u.name}`, async () => {
        const t0 = performance.now();
        const r = await SCENES[scene]!(u.bytesPerSec);
        const lines = formatReport(scene, u.name, r);
        lines.push(`${scene} | ${u.name} | run took ${((performance.now() - t0) / 1000).toFixed(1)} s of wall time`);
        console.log(lines.join('\n'));
        if (process.env.MEASURE_OUT !== undefined) appendFileSync(process.env.MEASURE_OUT, lines.join('\n') + '\n');
      }, 3_600_000);
    }
  }
});
