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
import { emptyTickBatch, type StructureRecord, type TickBatchMsg } from '../../src/net/protocol';
import { RELIABLE } from '../../src/net/transport';
import { BEARING_V, DECK_Y, exampleShipCell, MAST_TOP_Y, placeExampleShip } from '../../src/sim/exampleShip';
import { TerrainGenerator } from '../../src/worldgen/generator';
import { link, NetHarness, syncSource, testMeta } from './harness';

/** First air above the harness's flat ground. */
const T = 5;

describe('the hidden page (package 5)', () => {
  it('no frames for 20 s: every batch is applied as it arrives, nothing piles up, the replica matches when frames resume', async () => {
    const h = new NetHarness({ history: true });
    await h.create();
    const sim = h.sim;
    for (let i = 0; i < 4; i++) sim.entities.spawnRabbit(4.5 + i, T, 6.5);
    const bot = sim.join('bot');
    bot.player.input.forward = 1;
    let k = 0;
    const edit = (): void => {
      bot.player.input.yaw += 0.04;
      sim.world.setCell(((k * 5) % 30) - 15, T + 3, ((k * 3) % 30) - 15, k % 3 === 0 ? makeCell(B.LAMP) : makeCell(B.STONE));
      k++;
    };
    h.onTick = edit;
    const a = h.addClient('a', { up: link(30, 10, 0, 1), down: link(30, 10, 0, 2) }, { local: true, viewRadius: 3 });
    h.track(a);
    h.runUntil(() => a.ready);
    a.hidden = true;
    const r = a.replica!;
    const framesBefore = a.frames;
    const checkedBefore = a.checked;
    const worst = { waiting: 0, light: 0, lag: 0, perRing: 0, pending: 0 };
    h.onTick = () => {
      edit();
      worst.waiting = Math.max(worst.waiting, a.net.waiting);
      worst.light = Math.max(worst.light, r.light.pending);
      worst.lag = Math.max(worst.lag, sim.ticks - r.state.tick);
      const c = r.sampleCounts();
      worst.perRing = Math.max(worst.perRing, c.entities / Math.max(1, r.state.entities.size));
      worst.pending = Math.max(worst.pending, c.pendingEntities + c.pendingShips);
    };
    h.run(20_000);
    expect(a.frames).toBe(framesBefore);
    expect(k).toBeGreaterThan(400);
    expect(worst.waiting).toBe(0);
    expect(worst.light).toBe(0);
    expect(worst.lag).toBeLessThanOrEqual(2);
    expect(worst.perRing).toBeLessThanOrEqual(34);
    expect(worst.pending).toBeLessThan(10);
    expect(a.checked - checkedBefore).toBeGreaterThan(380);
    // Frames resume.
    a.hidden = false;
    h.onTick = edit;
    h.run(1000);
    expect(a.frames).toBeGreaterThan(framesBefore + 50);
    expect(a.mismatches).toEqual([]);
    h.onTick = null;
    h.quiesce();
    expect(h.compareNow(a, false)).toEqual([]);
    // The bot is shown where the server had it at renderTick.
    h.run(500);
    const clock = a.net.clock!;
    const v = r.entities(clock.renderTick).find((e) => e.id === bot.entityId)!;
    const s0 = h.history.get(Math.floor(clock.renderTick))!.entities.get(bot.entityId)!;
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
  it('frame(now) with nothing new is cheap (radius 9, a windmill boat)', async () => {
    const w = new NetHarness();
    await w.create(testMeta(), { generator: { kind: 'terrain', seed: 1 }, exampleShip: false });
    const sim = w.sim;
    const helm = placeExampleShip(sim)!;
    const bow = stateFacing(cellState(sim.world.getCell(helm.x, helm.y, helm.z))) as Dir;
    const at = (u: number, v: number, y: number): { x: number; y: number; z: number } => exampleShipCell(helm, bow, u, v, y);
    const bot = sim.join('bot');
    bot.emptyHand();
    const stand = at(1, BEARING_V, DECK_Y);
    bot.teleport(stand.x + 0.5, DECK_Y, stand.z + 0.5);
    const a = w.addClient('a', {}, { local: true, viewRadius: 9 });
    w.runUntil(() => a.ready, 60_000);
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
    w.host.pause(true); // single player: nothing new arrives
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
      cells: { base: cells, holes: null, part2: null },
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
        b.snapshots.push({ cx, cz, cells: { base: c, holes: null, part2: null }, glue: [] });
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
