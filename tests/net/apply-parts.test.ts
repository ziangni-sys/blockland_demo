/**
 * The client side of the layered cells (docs/SHAPES.md 4.5, 13.2): applyBatch takes parts with
 * holes and two-part cells from every section into its replica (snapshots, chunk deltas, structure
 * records and deltas), refuses every cell that is not valid (cellProblem) with a ReplicaError,
 * reloads a resent structure without stale layers, and ClientChunks applies a delta with holes
 * queued while its column generates. The digests see a difference in a holes byte or a second part.
 * A Welcome whose flat generator has an invalid layer ends the connection as a protocol error.
 */
import { describe, expect, it } from 'vitest';
import { makeCell, makePart, PACK_SCALE, type CellLayers } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, cellProblem } from '../../src/blocks/shapes';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { applyBatch, ReplicaError, ReplicaState } from '../../src/net/client/apply';
import { ClientChunks, type ChunkSource } from '../../src/net/client/chunks';
import { NetClient } from '../../src/net/client/netclient';
import { decodeServerMessage, encodeServerMessage } from '../../src/net/codec';
import { createLoopbackPair, LoopbackNet } from '../../src/net/loopback';
import { emptyTickBatch, type StructureRecord, type TickBatchMsg } from '../../src/net/protocol';
import { RELIABLE } from '../../src/net/transport';
import { getPacked } from '../../src/voxel/parts';
import { FlatGenerator } from '../../src/worldgen/generator';
import { compareReplica, replicaDigest, type Digest } from './digest';
import { link, syncSource } from './harness';
import { LOWER, slab, UPPER } from '../shapes';

const gen = new FlatGenerator();
const STONE = makeCell(B.STONE);
const SLAB = slab(B.PLANKS_OAK, LOWER);
const TWO = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
const FILLED = canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_OAK, UPPER));
/** Overlapping parts: layout-valid, semantically invalid. */
const OVERLAP = (slab(B.STONE, LOWER) | (1 << 24)) + slab(B.DIRT, LOWER | 0x40) * PACK_SCALE;
const INVALID: Array<[string, number]> = [
  ['overlapping parts', OVERLAP],
  ['an unregistered id', makeCell(999)],
  ['holes on a helm', slab(B.HELM, LOWER)],
  ['parts out of order', (slab(B.DIRT, UPPER) | (1 << 24)) + slab(B.STONE, LOWER) * PACK_SCALE],
];

function fresh(source?: ChunkSource): ReplicaState {
  const st = new ReplicaState(new ClientChunks(source ?? { generate: (cx, cz, done) => done(gen.generate(cx, cz)) }, () => {}));
  st.ownEntityId = 5;
  return st;
}
function wire(b: TickBatchMsg): TickBatchMsg {
  const m = decodeServerMessage(encodeServerMessage(b), RELIABLE);
  if (m.type !== 'tickBatch') throw new Error('not a batch');
  return m;
}
function apply(st: ReplicaState, b: TickBatchMsg): string {
  try {
    applyBatch(st, wire(b));
    return 'ok';
  } catch (e) {
    return e instanceof ReplicaError ? `ReplicaError: ${e.message}` : `${(e as Error).name}: ${(e as Error).message}`;
  }
}
function batch(tick: number, fill: (b: TickBatchMsg) => void): TickBatchMsg {
  const b = emptyTickBatch(tick);
  fill(b);
  return b;
}

/** Layers of n cells holding the given packed cells at the given indices. */
function layers(n: number, cells: Array<[number, number]>): CellLayers {
  const l: CellLayers = { base: new Uint16Array(n), holes: null, part2: null };
  for (const [i, packed] of cells) {
    const v = packed % PACK_SCALE;
    l.base[i] = v & 0xffff;
    if ((v >>> 16) & 0xff) (l.holes ??= new Uint8Array(n))[i] = (v >>> 16) & 0xff;
    if (packed >= PACK_SCALE) (l.part2 ??= new Uint32Array(n))[i] = Math.floor(packed / PACK_SCALE);
  }
  return l;
}

function shipRecord(id: number, cells: CellLayers, sx: number): StructureRecord {
  return {
    kind: 'ship', id, parentId: 0, minX: 0, minY: 40, minZ: 0, sx, sy: 1, sz: 1, cells,
    pivot: { x: 0.5, y: 40.5, z: 0.5 }, position: { x: 0.5, y: 40.5, z: 0.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    glue: new Int32Array(0), helm: { x: 0, y: 40, z: 0 }, forward: 5, throttle: 0, rudder: 0, helmsmanId: 0,
  };
}

const at = (lx: number, y: number, lz: number): number => lx | (lz << 4) | (y << 8);

describe('applyBatch carries both parts from every section', () => {
  it('snapshot, chunk delta, structure record and structure delta: parts arrive whole', () => {
    const st = fresh();
    const column = layers(CHUNK_VOLUME, [[at(1, 40, 1), SLAB], [at(2, 40, 1), TWO], [at(3, 40, 1), FILLED]]);
    expect(apply(st, batch(1, (b) => {
      b.snapshots.push({ cx: 0, cz: 0, cells: column, glue: [] });
      b.structureSpawns.push(shipRecord(3, layers(3, [[0, STONE], [1, TWO], [2, SLAB]]), 3));
    }))).toBe('ok');
    const w = st.world;
    expect([getPacked(w, 1, 40, 1), getPacked(w, 2, 40, 1), getPacked(w, 3, 40, 1)]).toEqual([SLAB, TWO, FILLED]);
    const g = st.structures.get(3)!.structure.grid;
    expect([getPacked(g, 0, 40, 0), getPacked(g, 1, 40, 0), getPacked(g, 2, 40, 0)]).toEqual([STONE, TWO, SLAB]);
    // The replica's column owns its layers (the batch's arrays are not shared).
    column.holes![at(1, 40, 1)] = 0;
    expect(getPacked(w, 1, 40, 1)).toBe(SLAB);
    // Deltas: a holes-only change and a second-part-only change.
    const notch = canonCell(slab(B.STONE, LOWER & 0xfe), slab(B.PLANKS_OAK, UPPER));
    const glass = canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER));
    expect(apply(st, batch(2, (b) => {
      b.chunkDeltas.push({ cx: 0, cz: 0, cells: [[at(2, 40, 1), notch], [at(4, 40, 1), TWO]], glue: [] });
      b.structureDeltas.push({ id: 3, cells: [[1, 40, 0, glass], [3, 40, 0, FILLED]] });
    }))).toBe('ok');
    expect([getPacked(w, 2, 40, 1), getPacked(w, 4, 40, 1)]).toEqual([notch, TWO]);
    expect([getPacked(g, 1, 40, 0), getPacked(g, 3, 40, 0)]).toEqual([glass, FILLED]);
  });

  it('the replica owns its arrays: editing it later never writes into the batch it came from', () => {
    const st = fresh();
    const b = wire(batch(1, (x) => x.snapshots.push({ cx: 0, cz: 0, cells: layers(CHUNK_VOLUME, [[at(1, 40, 1), SLAB], [at(2, 40, 1), TWO]]), glue: [] })));
    applyBatch(st, b);
    const sent = b.snapshots[0]!.cells as CellLayers;
    const before = { base: sent.base.slice(), holes: sent.holes!.slice(), part2: sent.part2!.slice() };
    st.world.setCell(1, 40, 1, STONE);
    st.world.setCell(2, 40, 1, FILLED);
    expect(sent).toEqual(before);
  });

  it('a resent structure keeps no layers of its old record', () => {
    const st = fresh();
    expect(apply(st, batch(1, (b) => b.structureSpawns.push(shipRecord(3, layers(2, [[0, TWO], [1, SLAB]]), 2))))).toBe('ok');
    const g = st.structures.get(3)!.structure.grid;
    expect(g.layered).toBe(true);
    expect(apply(st, batch(2, (b) => b.structureSpawns.push(shipRecord(3, layers(2, [[0, STONE], [1, STONE]]), 2))))).toBe('ok');
    expect(st.structures.get(3)!.structure.grid).toBe(g); // the same grid, reloaded
    expect(g.layered).toBe(false);
    expect([getPacked(g, 0, 40, 0), getPacked(g, 1, 40, 0)]).toEqual([STONE, STONE]);
  });

  it('a delta with holes queued while the column generates lands in the inserted column', () => {
    const waiting: Array<() => void> = [];
    const st = fresh({ generate: (cx, cz, done) => waiting.push(() => done(gen.generate(cx, cz))) });
    expect(apply(st, batch(1, (b) => b.snapshots.push({ cx: 0, cz: 0, cells: 'pristine', glue: [] })))).toBe('ok');
    expect(apply(st, batch(2, (b) => b.chunkDeltas.push({ cx: 0, cz: 0, cells: [[at(5, 40, 5), SLAB]], glue: [] })))).toBe('ok');
    expect(apply(st, batch(3, (b) => b.chunkDeltas.push({ cx: 0, cz: 0, cells: [[at(6, 40, 5), TWO], [at(7, 40, 5), STONE]], glue: [] })))).toBe('ok');
    expect(st.world.getChunk(0, 0)).toBeUndefined();
    waiting.shift()!();
    const w = st.world;
    expect([getPacked(w, 5, 40, 5), getPacked(w, 6, 40, 5), getPacked(w, 7, 40, 5)]).toEqual([SLAB, TWO, STONE]);
    // A queue of full blocks only: the column gets no extra layers.
    const st2 = fresh({ generate: (cx, cz, done) => waiting.push(() => done(gen.generate(cx, cz))) });
    apply(st2, batch(1, (b) => b.snapshots.push({ cx: 0, cz: 0, cells: 'pristine', glue: [] })));
    apply(st2, batch(2, (b) => b.chunkDeltas.push({ cx: 0, cz: 0, cells: [[at(5, 40, 5), STONE]], glue: [] })));
    waiting.shift()!();
    expect(st2.world.getChunk(0, 0)!.layers()).toMatchObject({ holes: null, part2: null });
  });
});

describe('applyBatch refuses cells that are not valid (cellProblem) with a ReplicaError', () => {
  const base = (): ReplicaState => {
    const st = fresh();
    expect(apply(st, batch(1, (b) => {
      b.snapshots.push({ cx: 0, cz: 0, cells: layers(CHUNK_VOLUME, [[at(0, 1, 0), STONE]]), glue: [] });
      b.structureSpawns.push(shipRecord(3, layers(1, [[0, STONE]]), 1));
    }))).toBe('ok');
    return st;
  };
  for (const [why, cell] of INVALID) {
    it(`${why}: in a snapshot, a chunk delta, a structure record and a structure delta`, () => {
      expect(apply(fresh(), batch(1, (b) => b.snapshots.push({ cx: 0, cz: 0, cells: layers(CHUNK_VOLUME, [[at(3, 9, 3), cell]]), glue: [] })))).toMatch(/^ReplicaError: snapshot/);
      expect(apply(base(), batch(2, (b) => b.chunkDeltas.push({ cx: 0, cz: 0, cells: [[7, cell]], glue: [] })))).toMatch(/^ReplicaError: delta of column/);
      expect(apply(fresh(), batch(1, (b) => b.structureSpawns.push(shipRecord(3, layers(2, [[0, STONE], [1, cell]]), 2))))).toMatch(/^ReplicaError: record of structure/);
      const st = base();
      expect(apply(st, batch(2, (b) => b.structureDeltas.push({ id: 3, cells: [[1, 40, 0, cell]] })))).toMatch(/^ReplicaError: delta of structure/);
    });
  }

  it('a refused snapshot or structure record names the volume, the index of the first invalid cell and the reason', () => {
    // The scan forms this text only when a cell fails (one string per run of equal cells cost more
    // than the checks), so what it says is pinned here.
    for (const [, cell] of INVALID) {
      const i = at(3, 9, 3);
      expect(apply(fresh(), batch(1, (b) => b.snapshots.push({ cx: 0, cz: 0, cells: layers(CHUNK_VOLUME, [[at(0, 1, 0), STONE], [i, cell]]), glue: [] })))).toBe(
        `ReplicaError: snapshot of column 0,0, cell ${i}: ${cellProblem(cell)}`,
      );
      expect(apply(fresh(), batch(1, (b) => b.structureSpawns.push(shipRecord(3, layers(2, [[0, STONE], [1, cell]]), 2))))).toBe(
        `ReplicaError: record of structure 3, cell 1: ${cellProblem(cell)}`,
      );
    }
  });

  it('a falling block entity with an unregistered id, block events with an invalid part', () => {
    expect(apply(base(), batch(2, (b) => b.entitySpawns.push({ id: 9, kind: 'falling', carrierId: 0, pos: { x: 1, y: 2, z: 3 }, yaw: 0, cell: makeCell(999) })))).toMatch(/^ReplicaError: falling block entity 9/);
    expect(apply(base(), batch(2, (b) => b.entitySpawns.push({ id: 9, kind: 'falling', carrierId: 0, pos: { x: 1, y: 2, z: 3 }, yaw: 0, cell: 0x0400 })))).toMatch(/^ReplicaError: falling block entity 9/);
    expect(apply(base(), batch(2, (b) => (b.events = [{ type: 'blockBroken', gridId: 0, x: 1, y: 2, z: 3, cell: slab(B.HELM, LOWER) }])))).toMatch(/^ReplicaError: blockBroken event/);
    expect(apply(base(), batch(2, (b) => (b.events = [{ type: 'blockPlaced', gridId: 0, x: 1, y: 2, z: 3, cell: makeCell(999) }])))).toMatch(/^ReplicaError: blockPlaced event/);
    // Valid ones pass: a full sand block falling, a part with holes broken.
    expect(apply(base(), batch(2, (b) => {
      b.entitySpawns.push({ id: 9, kind: 'falling', carrierId: 0, pos: { x: 1, y: 2, z: 3 }, yaw: 0, cell: makeCell(B.SAND) });
      b.events = [{ type: 'blockBroken', gridId: 0, x: 1, y: 2, z: 3, cell: SLAB }];
    }))).toBe('ok');
  });

  it('an unknown id in a column of full blocks is caught by the base-layer scan (it used to surface only in meshing)', () => {
    const column = layers(CHUNK_VOLUME, []);
    column.base.fill(STONE, 0, 30 * 256);
    column.base[30 * 256 + 17] = makeCell(1000);
    expect(apply(fresh(), batch(1, (b) => b.snapshots.push({ cx: 0, cz: 0, cells: column, glue: [] })))).toMatch(/unknown block id 1000/);
  });
});

describe('digests see every layer', () => {
  function digestWith(cell: number): Digest {
    const st = fresh();
    apply(st, batch(1, (b) => {
      b.snapshots.push({ cx: 0, cz: 0, cells: layers(CHUNK_VOLUME, [[at(1, 40, 1), cell]]), glue: [] });
      b.structureSpawns.push(shipRecord(3, layers(1, [[0, cell]]), 1));
    }));
    return replicaDigest(st);
  }
  it('two replicas that differ only in a holes byte, or only in a second part, are reported', () => {
    const a = digestWith(TWO);
    const holes = digestWith(canonCell(slab(B.STONE, LOWER & 0xfe), slab(B.PLANKS_OAK, UPPER)));
    const second = digestWith(canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER)));
    expect(compareReplica(a, digestWith(TWO), { poses: false })).toEqual([]);
    const d1 = compareReplica(a, holes, { poses: false });
    const d2 = compareReplica(a, second, { poses: false });
    expect(d1.some((s) => s.includes('column'))).toBe(true);
    expect(d1.some((s) => s.includes('structure'))).toBe(true);
    expect(d2.some((s) => s.includes('column'))).toBe(true);
    expect(d2.some((s) => s.includes('structure'))).toBe(true);
  });
});

describe('a Welcome with an invalid flat generator layer', () => {
  it('ends the connection as a protocol error before any generator is built', () => {
    const net = new LoopbackNet();
    let built = 0;
    const nc = new NetClient({
      openTransport: (ready) => {
        const { client, server } = createLoopbackPair(net, link(10), link(10));
        server.onMessage = () => {
          server.send(RELIABLE, encodeServerMessage({
            type: 'welcome', entityId: 1, generator: { kind: 'flat', seed: 1, layers: [{ cell: makeCell(B.STONE), thickness: 3 }, { cell: makePart(0, 1, 0), thickness: 1 }] },
            worldTime: 0, dayOffset: 0, rules: { defaultMode: 'creative', dropsEnabled: false }, isHost: false, roomOpen: false, players: [],
          }));
        };
        ready(client);
      },
      now: () => net.now,
      chunkSource: () => {
        built++;
        return syncSource(new FlatGenerator());
      },
      playerKey: 'k',
      name: 'k',
      viewRadius: 3,
      build: 'test',
    });
    nc.start();
    for (let t = 10; t <= 500; t += 10) net.advanceTo(t);
    expect(nc.status).toBe('failed');
    expect(nc.failure).toMatch(/protocol error: flat layer 1: id 0 with state bits/);
    expect(built).toBe(0);
  });
});
