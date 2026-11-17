/**
 * Package 4: batch sizes of typical scenes measured against NETCODE section 13, and the cost of
 * the Replicator per tick for four clients, busy and idle. The numbers are printed ([sizes],
 * [cost]) for the report; the assertions hold the section 13 figures with some margin.
 */
import { describe, expect, it } from 'vitest';
import { cellState, makeCell, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import type { Dir } from '../../src/core/dirs';
import { DECK_Y, exampleShipCell, placeExampleShip } from '../../src/sim/exampleShip';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator, TerrainGenerator } from '../../src/worldgen/generator';
import { SECTION } from '../../src/net/protocol';
import { Rig, type TestClient } from './rig';

const T = 35;
/** Per-message overhead of WebRTC (section 13): IP + UDP + DTLS + SCTP. */
const OVERHEAD = 80;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Reliable and unreliable bytes per tick of a client over its batches from tick `from` on. */
function rates(c: TestClient, from: number): { reliable: number; reliableMsgs: number; unreliable: number; unreliableMsgs: number } {
  const bs = c.batches.filter((b) => b.tick >= from);
  const ss = c.samples.filter((s) => s.msg.tick >= from);
  const ticks = Math.max(1, bs.length);
  return {
    reliable: bs.reduce((n, b) => n + b.bytes, 0) / ticks,
    reliableMsgs: bs.length / ticks,
    unreliable: ss.reduce((n, s) => n + s.bytes, 0) / ticks,
    unreliableMsgs: ss.length / ticks,
  };
}

/** The "everyday" scene of section 13: four players on a sailing windmill boat, six rabbits near by. */
function everyday(): { rig: Rig; keys: string[] } {
  const sim = new Simulation({ seed: 1, mode: 'creative', generator: new TerrainGenerator(1), syncChunks: true, loadRadius: 4, rabbits: false });
  const rig = new Rig(sim);
  rig.checkEveryTick = false;
  const keys = ['a', 'b', 'c', 'd'];
  for (const k of keys) rig.join(k, { viewRadius: 4 });
  const helm = placeExampleShip(sim)!;
  const bow = stateFacing(cellState(sim.world.getCell(helm.x, helm.y, helm.z))) as Dir;
  const at = (u: number, v: number, y: number): { x: number; y: number; z: number } => exampleShipCell(helm, bow, u, v, y);
  rig.tick(10);
  const spots: Array<[number, number]> = [
    [0, 2],
    [-1, 4],
    [1, 4],
    [-1, 6],
  ];
  keys.forEach((k, i) => {
    const s = at(spots[i]![0], spots[i]![1], DECK_Y);
    rig.ctrl(k).teleport(s.x + 0.5, DECK_Y, s.z + 0.5);
    rig.ctrl(k).emptyHand();
  });
  rig.tick(5);
  // Start the windmill, then assemble at the helm (player a steers).
  const b = at(0, 6, DECK_Y + 5);
  const st = at(1, 6, DECK_Y);
  rig.ctrl('b').teleport(st.x + 0.5, DECK_Y, st.z + 0.5);
  rig.tick(2);
  rig.useOn('b', b.x, b.y, b.z);
  rig.useOn('b', b.x, b.y, b.z);
  rig.useOn('a', helm.x, helm.y, helm.z);
  rig.useOn('a', helm.x, helm.y, helm.z);
  expect(sim.structures.ships().length).toBe(1);
  expect(sim.structures.rotors().length).toBe(1);
  // Six rabbits on the nearest shore of land the player can see.
  const p = rig.ctrl('d').player.pos;
  for (let i = 0; i < 6; i++) {
    const x = Math.floor(p.x) + 10 + i;
    const z = Math.floor(p.z) - 6;
    let y = 100;
    while (y > 1 && sim.world.getCell(x, y - 1, z) === 0) y--;
    sim.entities.spawnRabbit(x + 0.5, y, z + 0.5);
  }
  const pa = rig.ctrl('a').player;
  pa.input.forward = 1;
  pa.input.strafe = 0.5;
  return { rig, keys };
}

describe('batch sizes against section 13 (package 4)', () => {
  it('an empty batch is 4 to 6 bytes; the everyday scene stays near the estimate; joining, a dam break and flying', () => {
    // ---- empty batches
    const flat = new Rig(new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 2, spawn: { x: 0.5, y: T, z: 0.5 } }));
    flat.checkEveryTick = false;
    const e = flat.join('e', { viewRadius: 2 });
    flat.tick(40);
    const empty = e.batches.at(-1)!.bytes;
    expect(empty).toBeGreaterThanOrEqual(4);
    expect(empty).toBeLessThanOrEqual(6);

    // ---- everyday
    const { rig, keys } = everyday();
    const t0 = rig.sim.ticks + 40;
    rig.tick(240);
    const ev = keys.map((k) => rates(rig.clients.get(k)!, t0));
    const evMean = {
      reliable: mean(ev.map((r) => r.reliable)),
      unreliable: mean(ev.map((r) => r.unreliable)),
      unreliableMsgs: mean(ev.map((r) => r.unreliableMsgs)),
    };
    const kbps = (evMean.reliable + OVERHEAD + evMean.unreliable + evMean.unreliableMsgs * OVERHEAD) * 20 / 1024;
    console.log(`[sizes] everyday (4 players on a sailing windmill boat, 6 rabbits): reliable ${evMean.reliable.toFixed(1)} B/tick, unreliable ${evMean.unreliable.toFixed(1)} B/tick in ${evMean.unreliableMsgs.toFixed(2)} msgs; with overhead ${kbps.toFixed(2)} KB/s per guest`);
    expect(evMean.reliable).toBeLessThan(60); // section 13: mostly 6-30 B, 20 B on average
    expect(evMean.unreliable).toBeLessThan(250); // section 13: about 125 B
    expect(kbps).toBeLessThan(12); // section 13: about 6 KB/s

    // ---- a guest joins the everyday scene
    const j = rig.join('j', { viewRadius: 9 });
    const tj = rig.sim.ticks + 1;
    let readyTick = -1;
    for (let i = 0; i < 300; i++) {
      rig.tick();
      if (readyTick < 0 && j.state.ready) readyTick = rig.sim.ticks;
      if (readyTick >= 0 && rig.rep.clientView('j')!.pendingColumns === 0) break;
    }
    const toReady = j.batches.filter((b) => b.tick <= readyTick).reduce((n, b) => n + b.bytes, 0);
    const all = j.batches.reduce((n, b) => n + b.bytes, 0);
    const cells = j.batches.flatMap((b) => b.batch.snapshots).filter((s) => s.cells !== 'pristine').length;
    const pristine = j.batches.flatMap((b) => b.batch.snapshots).filter((s) => s.cells === 'pristine').length;
    console.log(`[sizes] join (radius 9, terrain, the boat): ready after ${readyTick - tj + 1} ticks and ${(toReady / 1024).toFixed(1)} KB; whole circle ${(all / 1024).toFixed(1)} KB in ${j.batches.length} batches (${cells} modified columns, ${pristine} pristine)`);
    expect(j.state.ready).toBe(true);
    rig.check('full');

    // ---- a dam break: a basin 30 x 30, 4 deep, on a platform 6 high; its east wall goes
    const dam = new Rig(new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 4, spawn: { x: 14.5, y: T + 16, z: -12.5 } }));
    dam.checkEveryTick = false;
    const d = dam.join('d', { viewRadius: 4 });
    dam.ctrl('d').player.flying = true;
    dam.tick(20);
    const w = dam.sim.world;
    for (let x = -1; x <= 30; x++) {
      for (let z = -1; z <= 30; z++) {
        for (let y = T; y < T + 6; y++) w.setCell(x, y, z, makeCell(B.STONE));
        for (let y = T + 6; y <= T + 9; y++) {
          const wall = x === -1 || x === 30 || z === -1 || z === 30;
          w.setCell(x, y, z, makeCell(wall ? B.GLASS : B.WATER));
        }
      }
    }
    dam.tick(80);
    for (let z = -1; z <= 30; z++) for (let y = T + 6; y <= T + 9; y++) w.setCell(30, y, z, 0);
    const td = dam.sim.ticks + 1;
    const deltas0 = dam.rep.stats('d')!.sectionBytes[SECTION.chunkDeltas]!;
    dam.tick(200);
    const dr = rates(d, td);
    const deltaBytes = dam.rep.stats('d')!.sectionBytes[SECTION.chunkDeltas]! - deltas0;
    const changed = d.batches.filter((b) => b.tick >= td).reduce((n, b) => n + b.batch.chunkDeltas.reduce((m, x) => m + x.cells.length, 0), 0);
    const peak = Math.max(...d.batches.filter((b) => b.tick >= td).map((b) => b.batch.chunkDeltas.reduce((m, x) => m + x.cells.length, 0)));
    console.log(
      `[sizes] dam break: ${((dr.reliable * 20) / 1024).toFixed(1)} KB/s reliable over 10 s, ${(changed / 200).toFixed(0)} cells/tick on average (peak ${peak}), ${(deltaBytes / Math.max(1, changed)).toFixed(2)} B/cell in the deltas`,
    );
    expect(deltaBytes / Math.max(1, changed)).toBeLessThan(4); // section 13: about 2.5 B per cell at hundreds of cells per tick
    dam.check('full');

    // ---- flying over unvisited (pristine) land at 18 blocks/s, radius 9
    const fly = new Rig(new Simulation({ seed: 3, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 9, spawn: { x: 0.5, y: T + 20, z: 0.5 } }));
    fly.checkEveryTick = false;
    const f = fly.join('f', { viewRadius: 9 });
    fly.ctrl('f').player.flying = true;
    fly.tick(60);
    const tf = fly.sim.ticks + 1;
    for (let i = 1; i <= 200; i++) {
      fly.ctrl('f').teleport(0.5 + i * 0.9, T + 20, 0.5);
      fly.tick();
    }
    const fr = rates(f, tf);
    const newCols = f.batches.filter((b) => b.tick >= tf).reduce((n, b) => n + b.batch.snapshots.length, 0);
    console.log(`[sizes] flying 18 b/s over pristine land, radius 9: ${((fr.reliable * 20) / 1024).toFixed(2)} KB/s, ${(newCols / 10).toFixed(1)} new columns/s`);
    expect((fr.reliable * 20) / 1024).toBeLessThan(1);
  }, 300_000);
});

describe('cost of the Replicator per tick (package 4)', () => {
  it('four clients: busy (sailing boat, windmill, rabbits) and idle; idle is small next to a simulation tick', () => {
    const { rig } = everyday();
    rig.tick(60);
    const ms0 = { ...rig.ms };
    rig.tick(200);
    const busySim = (rig.ms.sim - ms0.sim) / 200;
    const busyRep = (rig.ms.replicator - ms0.replicator) / 200;

    const idle = new Rig(new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 4, spawn: { x: 0.5, y: T, z: 0.5 } }));
    idle.checkEveryTick = false;
    for (const k of ['a', 'b', 'c', 'd']) idle.join(k, { viewRadius: 9 });
    idle.tick(200); // everything sent, nothing moves
    const i0 = { ...idle.ms };
    idle.tick(400);
    const idleSim = (idle.ms.sim - i0.sim) / 400;
    const idleRep = (idle.ms.replicator - i0.replicator) / 400;
    console.log(
      `[cost] 4 clients: busy scene sim ${busySim.toFixed(3)} ms/tick, replicator ${busyRep.toFixed(3)} ms/tick; idle scene (radius 9) sim ${idleSim.toFixed(3)} ms/tick, replicator ${idleRep.toFixed(3)} ms/tick`,
    );
    expect(idleRep).toBeLessThan(Math.max(0.5, idleSim));
    expect(busyRep).toBeLessThan(busySim);
  }, 300_000);
});
