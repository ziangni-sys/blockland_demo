/**
 * Package 5: the client's chunk loading (NETCODE sections 5, 6): deltas that arrive while a pristine
 * column generates are applied before it is inserted; unsubscribe and resubscribe while a
 * generation is in flight discards the stale result (the race of section 5); a resend replaces
 * everything pending; the light of the replica equals a full recomputation after deltas and after
 * unsubscribe / resubscribe; a slow ChunkSource through the whole connection still ends equal to
 * the server.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { ClientChunks, type ChunkSource } from '../../src/net/client/chunks';
import { ClientReplica } from '../../src/net/client/replica';
import { decodeServerMessage, encodeServerMessage } from '../../src/net/codec';
import { LoopbackNet } from '../../src/net/loopback';
import { emptyTickBatch, type TickBatchMsg } from '../../src/net/protocol';
import { RELIABLE } from '../../src/net/transport';
import { LightEngine } from '../../src/light/engine';
import { Simulation } from '../../src/sim/simulation';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { FlatGenerator, TerrainGenerator } from '../../src/worldgen/generator';
import { compareReplica, replicaDigest, serverDigest } from './digest';
import { DelayedSource, link, ShimServer, ShimWorld } from './shim';

const gen = new FlatGenerator();
const STONE = makeCell(B.STONE);
const GLASS = makeCell(B.GLASS);
const LAMP = makeCell(B.LAMP);

/** A ChunkSource whose requests wait until the test answers them. */
class ManualSource implements ChunkSource {
  readonly requests: Array<{ cx: number; cz: number; done: (cells: Uint16Array) => void }> = [];
  generate(cx: number, cz: number, done: (cells: Uint16Array) => void): void {
    this.requests.push({ cx, cz, done });
  }
  answer(i = 0): void {
    const r = this.requests.splice(i, 1)[0]!;
    r.done(gen.generate(r.cx, r.cz));
  }
}

function wire(b: TickBatchMsg): TickBatchMsg {
  const m = decodeServerMessage(encodeServerMessage(b), RELIABLE);
  if (m.type !== 'tickBatch') throw new Error('not a batch');
  return m;
}

function batch(tick: number, fill: (b: TickBatchMsg) => void): TickBatchMsg {
  const b = emptyTickBatch(tick);
  fill(b);
  return wire(b);
}

/** Index of a cell in a column. */
const at = (lx: number, y: number, lz: number): number => lx | (lz << 4) | (y << 8);

function pristineWith(edits: Array<[number, number]>): Uint16Array {
  const c = gen.generate(0, 0);
  for (const [i, v] of edits) c[i] = v;
  return c;
}

describe('ClientChunks (package 5)', () => {
  it('deltas queued while a pristine column generates are applied, in order, before it is inserted', () => {
    const src = new ManualSource();
    const inserted: Chunk[] = [];
    const chunks = new ClientChunks(src, (c) => inserted.push(c));
    chunks.snapshot(0, 0, 'pristine');
    expect(chunks.has(0, 0)).toBe(true);
    expect(chunks.present(0, 0)).toBe(false);
    expect(chunks.world.getChunk(0, 0)).toBeUndefined();
    chunks.delta(0, 0, [[at(1, 40, 1), STONE]]);
    chunks.delta(0, 0, [[at(1, 40, 1), GLASS], [at(2, 40, 2), STONE]]);
    expect(chunks.queuedDeltas()).toBe(2);
    expect(inserted).toHaveLength(0);
    src.answer();
    expect(inserted).toHaveLength(1);
    expect(chunks.present(0, 0)).toBe(true);
    expect(chunks.queuedDeltas()).toBe(0);
    expect(chunks.world.getChunk(0, 0)!.cells).toEqual(pristineWith([[at(1, 40, 1), GLASS], [at(2, 40, 2), STONE]]));
    // Later deltas go straight into the world.
    chunks.delta(0, 0, [[at(3, 40, 3), STONE]]);
    expect(chunks.world.getCell(3, 40, 3)).toBe(STONE);
  });

  it('pristine snapshot, unsubscribe, edit, resubscribe with cells, then the old generation finishes: it is dropped', () => {
    const src = new ManualSource();
    const chunks = new ClientChunks(src, () => {});
    chunks.snapshot(0, 0, 'pristine');
    chunks.delta(0, 0, [[at(1, 40, 1), STONE]]);
    chunks.unsubscribe(0, 0);
    expect(chunks.has(0, 0)).toBe(false);
    expect(chunks.generating).toBe(0);
    const fresh = pristineWith([[at(5, 41, 5), GLASS]]);
    chunks.snapshot(0, 0, fresh.slice());
    expect(chunks.present(0, 0)).toBe(true);
    src.answer(); // the stale generation
    expect(chunks.staleResults).toBe(1);
    expect(chunks.world.getChunk(0, 0)!.cells).toEqual(fresh);
    expect(chunks.world.getCell(1, 40, 1)).not.toBe(STONE);
  });

  it('pristine, unsubscribe, pristine again while the first generation is in flight: only the second counts', () => {
    const src = new ManualSource();
    const chunks = new ClientChunks(src, () => {});
    chunks.snapshot(0, 0, 'pristine');
    chunks.delta(0, 0, [[at(1, 40, 1), STONE]]);
    chunks.unsubscribe(0, 0);
    chunks.snapshot(0, 0, 'pristine');
    chunks.delta(0, 0, [[at(2, 40, 2), GLASS]]);
    expect(src.requests).toHaveLength(2);
    src.answer(0); // the first, stale
    expect(chunks.present(0, 0)).toBe(false);
    expect(chunks.staleResults).toBe(1);
    src.answer(0);
    expect(chunks.world.getChunk(0, 0)!.cells).toEqual(pristineWith([[at(2, 40, 2), GLASS]]));
  });

  it('a resend replaces everything pending: queued deltas and the generation in flight', () => {
    const src = new ManualSource();
    const chunks = new ClientChunks(src, () => {});
    chunks.snapshot(0, 0, 'pristine');
    chunks.delta(0, 0, [[at(1, 40, 1), STONE]]);
    const resend = pristineWith([[at(7, 42, 7), STONE]]);
    chunks.snapshot(0, 0, resend.slice());
    expect(chunks.queuedDeltas()).toBe(0);
    expect(chunks.generating).toBe(0);
    src.answer();
    expect(chunks.staleResults).toBe(1);
    expect(chunks.world.getChunk(0, 0)!.cells).toEqual(resend);
    // A cells resend of a present column replaces it too.
    chunks.delta(0, 0, [[at(1, 40, 1), GLASS]]);
    chunks.snapshot(0, 0, resend.slice());
    expect(chunks.world.getChunk(0, 0)!.cells).toEqual(resend);
  });

  it('through applyBatch: a delta for an unsubscribed column is a ReplicaError, a generating column counts as subscribed', () => {
    const src = new ManualSource();
    const r = new ClientReplica(src);
    r.applyBatch(batch(1, (b) => b.snapshots.push({ cx: 0, cz: 0, cells: 'pristine', glue: [] })));
    r.applyBatch(batch(2, (b) => b.chunkDeltas.push({ cx: 0, cz: 0, cells: [[at(1, 40, 1), STONE]], glue: [] })));
    expect(() => r.applyBatch(batch(3, (b) => b.chunkDeltas.push({ cx: 1, cz: 0, cells: [[0, STONE]], glue: [] })))).toThrow(/does not have/);
    src.answer();
    expect(r.world.getCell(1, 40, 1)).toBe(STONE);
  });
});

/** Light of every chunk of `world` recomputed from scratch over the same cells. */
function fullLight(world: World): Map<string, Uint8Array> {
  const fresh = new World();
  const engine = new LightEngine(fresh);
  const out = new Map<string, Uint8Array>();
  const chunks = [...world.chunks.values()];
  for (const c of chunks) fresh.addChunk(new Chunk(c.cx, c.cz, c.cells.slice()));
  for (const c of fresh.chunks.values()) engine.initChunk(c);
  for (const c of fresh.chunks.values()) out.set(`${c.cx},${c.cz}`, c.light);
  return out;
}

function expectLightEqual(r: ClientReplica): void {
  expect(r.updateLight(Infinity)).toBe(true);
  const want = fullLight(r.world);
  let n = 0;
  for (const c of r.world.chunks.values()) {
    const w = want.get(`${c.cx},${c.cz}`)!;
    let diff = 0;
    for (let i = 0; i < CHUNK_VOLUME; i++) if (c.light[i] !== w[i]) diff++;
    expect(diff, `light of column ${c.cx},${c.cz}`).toBe(0);
    n++;
  }
  expect(n).toBeGreaterThan(0);
}

describe('light on the replica (package 5)', () => {
  it('equals a full recomputation after deltas, after unsubscribe and resubscribe, and after a pristine column arrives late', () => {
    const src = new ManualSource();
    const r = new ClientReplica(src);
    r.applyBatch(
      batch(1, (b) => {
        for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) b.snapshots.push({ cx, cz, cells: 'pristine', glue: [] });
      }),
    );
    while (src.requests.length > 0) src.answer();
    expectLightEqual(r);
    // A roof over a corner with a lamp under it, across a column border; a hole.
    const cells: Array<[number, number]> = [];
    for (let lx = 10; lx < 16; lx++) for (let lz = 10; lz < 16; lz++) cells.push([at(lx, 20, lz), STONE]);
    cells.push([at(14, 18, 14), LAMP]);
    cells.sort((x, y) => x[0] - y[0]);
    r.applyBatch(batch(2, (b) => b.chunkDeltas.push({ cx: 0, cz: 0, cells, glue: [] })));
    r.applyBatch(batch(3, (b) => b.chunkDeltas.push({ cx: 1, cz: 0, cells: [[at(0, 18, 14), LAMP], [at(0, 20, 14), STONE]], glue: [] })));
    expectLightEqual(r);
    // Unsubscribe the middle column: no ghost light left in the neighbours.
    r.applyBatch(batch(4, (b) => b.unsubscribe.push({ cx: 0, cz: 0 })));
    expectLightEqual(r);
    // Resubscribe with cells (the edits), while a pristine column on the side generates late with a queued delta.
    const edited = gen.generate(0, 0);
    for (const [i, v] of cells) edited[i] = v;
    r.applyBatch(
      batch(5, (b) => {
        b.snapshots.push({ cx: 0, cz: 0, cells: edited, glue: [] });
        b.snapshots.push({ cx: 2, cz: 0, cells: 'pristine', glue: [] });
      }),
    );
    r.applyBatch(batch(6, (b) => b.chunkDeltas.push({ cx: 2, cz: 0, cells: [[at(0, 19, 3), LAMP]], glue: [] })));
    expectLightEqual(r);
    src.answer();
    expect(r.world.getCell(32, 19, 3)).toBe(LAMP);
    expectLightEqual(r);
  });
});

describe('a slow ChunkSource through a whole connection (package 5)', () => {
  it('join and jump away and back with 200 ms generation: deltas queue, stale generations are dropped, the replica ends equal', () => {
    const sim = new Simulation({ seed: 3, mode: 'creative', generator: new TerrainGenerator(3), syncChunks: true, rabbits: false, loadRadius: 3 });
    const w = new ShimWorld(new ShimServer(new LoopbackNet(), sim));
    const a = w.add({ key: 'a', viewRadius: 3, genDelayMs: 200, up: link(20, 5, 0, 3), down: link(20, 5, 0, 4) });
    w.runUntil(() => a.net.status === 'ready');
    a.checkEveryBatch = false; // columns may still be generating (absent on the client) at their batch
    const ctrl = sim.players.get('a')!;
    const p0 = { ...ctrl.player.pos };
    // Edits near the player, every tick for a while (some land in columns that are generating).
    let k = 0;
    w.onTick = () => {
      if (k > 400) return;
      const x = Math.floor(ctrl.player.pos.x) + ((k * 7) % 40) - 20;
      const z = Math.floor(ctrl.player.pos.z) + ((k * 13) % 40) - 20;
      sim.world.setCell(x, 90, z, k % 2 === 0 ? STONE : GLASS);
      k++;
    };
    // Away (unsubscribes behind, pristine columns ahead) and back while generations are in flight.
    ctrl.teleport(p0.x + 6 * 16, p0.y + 30, p0.z);
    w.run(100);
    ctrl.teleport(p0.x, p0.y + 30, p0.z);
    w.run(100);
    ctrl.teleport(p0.x + 6 * 16, p0.y + 30, p0.z);
    w.run(4000);
    ctrl.teleport(p0.x, p0.y + 30, p0.z);
    w.run(6000);
    const src = a.source as DelayedSource;
    const r = a.replica!;
    expect(r.chunks.generating).toBe(0);
    expect(r.chunks.staleResults).toBeGreaterThan(0);
    expect(src.requests).toBeGreaterThan(40);
    // Every column the client holds equals the server's, and the light is the full recomputation.
    const view = w.server.rep.clientView('a')!;
    const d = serverDigest(w.server.ctx, sim, { columns: view.columns, structures: [], entities: [] });
    expect(compareReplica(d, replicaDigest(r.state), { poses: false }).filter((x) => !x.startsWith('entity'))).toEqual([]);
    expectLightEqual(r);
  }, 60_000);
});
