/**
 * Package 5: the hidden page (NETCODE section 5: no frames, batches applied in the message handler,
 * nothing piles up, the replica matches when frames resume) and the costs: frame(now) with nothing
 * new, applying a 3700-cell ship's spawn, a join of 300 columns.
 */
import { describe, expect, it } from 'vitest';
import { cellState, makeCell, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import type { Dir } from '../../src/core/dirs';
import { ClientReplica } from '../../src/net/client/replica';
import { decodeServerMessage, encodeServerMessage } from '../../src/net/codec';
import { LoopbackNet } from '../../src/net/loopback';
import { emptyTickBatch, type StructureRecord, type TickBatchMsg } from '../../src/net/protocol';
import { RELIABLE } from '../../src/net/transport';
import { BEARING_V, DECK_Y, exampleShipCell, MAST_TOP_Y, placeExampleShip } from '../../src/sim/exampleShip';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator, TerrainGenerator } from '../../src/worldgen/generator';
import { compareReplica, replicaDigest, serverDigest } from './digest';
import { link, ShimServer, ShimWorld, syncSource } from './shim';

const T = 35;

describe('the hidden page (package 5)', () => {
  it('no frames for 20 s: every batch is applied as it arrives, nothing piles up, the replica matches when frames resume', () => {
    const sim = new Simulation({ seed: 4, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 3, spawn: { x: 0.5, y: T, z: 0.5 } });
    const w = new ShimWorld(new ShimServer(new LoopbackNet(), sim));
    for (let i = 0; i < 4; i++) sim.entities.spawnRabbit(4.5 + i, T, 6.5);
    const bot = sim.join('bot');
    bot.player.input.forward = 1;
    let k = 0;
    w.onTick = () => {
      bot.player.input.yaw += 0.04;
      sim.world.setCell(((k * 5) % 30) - 15, T + 3, ((k * 3) % 30) - 15, k % 3 === 0 ? makeCell(B.LAMP) : makeCell(B.STONE));
      k++;
    };
    const a = w.add({ key: 'a', viewRadius: 3, up: link(30, 10, 0, 1), down: link(30, 10, 0, 2) });
    w.runUntil(() => a.net.status === 'ready');
    a.framesOn = false;
    a.net.setHidden(true);
    const r = a.replica!;
    const framesBefore = a.frames;
    const worst = { waiting: 0, light: 0, lag: 0, perRing: 0, pending: 0 };
    const check = (): void => {
      worst.waiting = Math.max(worst.waiting, a.net.waiting);
      worst.light = Math.max(worst.light, r.light.pending);
      worst.lag = Math.max(worst.lag, sim.ticks - r.state.tick);
      const c = r.sampleCounts();
      worst.perRing = Math.max(worst.perRing, c.entities / Math.max(1, r.state.entities.size));
      worst.pending = Math.max(worst.pending, c.pendingEntities + c.pendingShips);
    };
    const prev = w.onTick;
    w.onTick = () => {
      prev();
      check();
    };
    w.run(20_000);
    expect(a.frames).toBe(framesBefore);
    expect(k).toBeGreaterThan(400);
    expect(worst.waiting).toBe(0);
    expect(worst.light).toBe(0);
    expect(worst.lag).toBeLessThanOrEqual(2);
    expect(worst.perRing).toBeLessThanOrEqual(34);
    expect(worst.pending).toBeLessThan(10);
    expect(a.batchesChecked).toBeGreaterThan(380);
    // Frames resume.
    a.net.setHidden(false);
    a.framesOn = true;
    w.onTick = prev;
    w.run(1000);
    a.expectClean();
    const view = w.server.rep.clientView('a')!;
    const d = serverDigest(w.server.ctx, sim, { columns: view.columns, structures: view.structures, entities: view.entities });
    expect(compareReplica(d, replicaDigest(r.state), { poses: false })).toEqual([]);
    // The bot is shown where the server had it at renderTick.
    const clock = a.net.clock!;
    const v = r.entities(clock.renderTick).find((e) => e.id === bot.entityId)!;
    const s0 = w.server.history.get(Math.floor(clock.renderTick))!.entities.get(bot.entityId)!;
    expect(Math.hypot(v.pos.x - s0.pos.x, v.pos.z - s0.pos.z)).toBeLessThan(0.3);
  }, 60_000);
});

function wire(b: TickBatchMsg): TickBatchMsg {
  const m = decodeServerMessage(encodeServerMessage(b), RELIABLE);
  if (m.type !== 'tickBatch') throw new Error('not a batch');
  return m;
}

function ms(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

describe('costs (package 5)', () => {
  it('frame(now) with nothing new is cheap (radius 9, a windmill boat)', () => {
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: new TerrainGenerator(1), syncChunks: true, rabbits: false, loadRadius: 4 });
    const w = new ShimWorld(new ShimServer(new LoopbackNet(), sim));
    w.server.recordDigests = false;
    const helm = placeExampleShip(sim)!;
    const bow = stateFacing(cellState(sim.world.getCell(helm.x, helm.y, helm.z))) as Dir;
    const at = (u: number, v: number, y: number): { x: number; y: number; z: number } => exampleShipCell(helm, bow, u, v, y);
    const bot = sim.join('bot');
    bot.emptyHand();
    const stand = at(1, BEARING_V, DECK_Y);
    bot.teleport(stand.x + 0.5, DECK_Y, stand.z + 0.5);
    const a = w.add({ key: 'a', viewRadius: 9 });
    w.runUntil(() => a.net.status === 'ready', 60_000);
    const bearing = at(0, BEARING_V, MAST_TOP_Y);
    for (let i = 0; i < 2; i++) {
      expect(bot.aimAt(bearing.x, bearing.y, bearing.z, undefined, 0)).toBe(true);
      bot.use();
      w.run(50);
    }
    w.run(15_000); // everything subscribed and lit
    const r = a.replica!;
    expect(r.chunks.size).toBeGreaterThan(250);
    expect(r.structures().length).toBe(1);
    w.ticking = false;
    w.run(500);
    expect(a.net.waiting).toBe(0);
    let now = w.net.now;
    for (let i = 0; i < 200; i++) a.net.frame((now += 1000 / 60)); // warm up
    const n = 3000;
    const t = ms(() => {
      for (let i = 0; i < n; i++) a.net.frame((now += 1000 / 60));
    });
    const perFrame = (t / n) * 1000;
    console.log(`frame(now) with nothing new: ${perFrame.toFixed(1)} us (${r.chunks.size} columns, ${r.structures().length} structures, ${r.state.entities.size} entities)`);
    expect(perFrame).toBeLessThan(200);
  }, 120_000);

  it('applying a 3700-cell ship spawn, and a join of 300 columns (pristine: generated and lit; modified: lit)', () => {
    const plank = makeCell(B.PLANKS_OAK);
    const cells = new Uint16Array(37 * 100).fill(plank);
    for (let i = 0; i < cells.length; i += 7) cells[i] = makeCell(B.PLANKS_PINE);
    const ship: StructureRecord = {
      kind: 'ship',
      id: 1,
      parentId: 0,
      minX: 0,
      minY: 47,
      minZ: 0,
      sx: 37,
      sy: 1,
      sz: 100,
      cells,
      pivot: { x: 18.5, y: 47.5, z: 50 },
      position: { x: 18.5, y: 47.5, z: 50 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      glue: new Int32Array(0),
      helm: { x: 18, y: 48, z: 50 },
      forward: 5,
      throttle: 0,
      rudder: 0,
      helmsmanId: 0,
    };
    const gen = new TerrainGenerator(1);
    const spawnBatch = (tick: number): TickBatchMsg => {
      const b = emptyTickBatch(tick);
      b.structureSpawns.push(ship);
      return wire(b);
    };
    // 300 columns: the nearest of the circle of radius 10.
    const cols: Array<[number, number]> = [];
    for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) if (dx * dx + dz * dz <= 110) cols.push([dx, dz]);
    cols.sort((p, q) => p[0] ** 2 + p[1] ** 2 - (q[0] ** 2 + q[1] ** 2));
    cols.length = 300;
    const pristine = (): TickBatchMsg => {
      const b = emptyTickBatch(1);
      for (const [cx, cz] of cols) b.snapshots.push({ cx, cz, cells: 'pristine', glue: [] });
      return wire(b);
    };
    const modified = (): TickBatchMsg => {
      const b = emptyTickBatch(1);
      for (const [cx, cz] of cols) {
        const c = gen.generate(cx, cz);
        c[(5 << 8) | 17] = makeCell(B.LAMP);
        b.snapshots.push({ cx, cz, cells: c, glue: [] });
      }
      return wire(b);
    };
    const runs = 3;
    let spawn = Infinity;
    let joinPristine = Infinity;
    let joinCells = Infinity;
    for (let i = 0; i < runs; i++) {
      const r = new ClientReplica(syncSource(gen));
      const b = spawnBatch(1);
      spawn = Math.min(spawn, ms(() => r.applyBatch(b)));
      const r2 = new ClientReplica(syncSource(gen));
      const p = pristine();
      joinPristine = Math.min(joinPristine, ms(() => r2.applyBatch(p)));
      expect(r2.world.chunks.size).toBe(300);
      const r3 = new ClientReplica(syncSource(gen));
      const m = modified();
      joinCells = Math.min(joinCells, ms(() => r3.applyBatch(m)));
      r3.updateLight(Infinity);
    }
    const generateOnly = ms(() => {
      for (const [cx, cz] of cols) gen.generate(cx, cz);
    });
    console.log(
      `3700-cell ship spawn: ${spawn.toFixed(2)} ms; join of 300 columns: pristine ${joinPristine.toFixed(0)} ms (of which generation ~${generateOnly.toFixed(0)} ms), modified ${joinCells.toFixed(0)} ms (${(joinCells / 300).toFixed(2)} ms per column)`,
    );
    expect(spawn).toBeLessThan(20);
    expect(joinCells / 300).toBeLessThan(10);
  }, 120_000);
});
