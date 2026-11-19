/**
 * applyBatch refuses batches that break the protocol's promises (src/net/client/apply.ts header):
 * every case goes through the codec first (encode, decode) and must end in a ReplicaError, never
 * in a corrupt replica or another error. And the cases at the edge that are valid stay valid.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { applyBatch, applySamples, ReplicaError, ReplicaState } from '../../src/net/client/apply';
import { ClientChunks } from '../../src/net/client/chunks';
import { decodeServerMessage, encodeServerMessage } from '../../src/net/codec';
import { emptyTickBatch, MAX_STRUCTURE_BOX_CELLS, type EntityMotion, type StructureRecord, type TickBatchMsg } from '../../src/net/protocol';
import { RELIABLE } from '../../src/net/transport';
import { Rotor } from '../../src/structures/structure';
import { FlatGenerator } from '../../src/worldgen/generator';

const gen = new FlatGenerator();
const STONE = makeCell(B.STONE);

function fresh(own = 0): ReplicaState {
  const st = new ReplicaState(new ClientChunks({ generate: (cx, cz, done) => done(gen.generate(cx, cz)) }, () => {}));
  st.ownEntityId = own;
  return st;
}

function wire(b: TickBatchMsg): TickBatchMsg {
  const m = decodeServerMessage(encodeServerMessage(b), RELIABLE);
  if (m.type !== 'tickBatch') throw new Error('not a batch');
  return m;
}

/** Apply through the codec; 'ok', or the error's class name and message. */
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

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function ship(id: number, extra: Partial<StructureRecord> = {}): StructureRecord {
  return {
    kind: 'ship',
    id,
    parentId: 0,
    minX: 0,
    minY: 0,
    minZ: 0,
    sx: 1,
    sy: 1,
    sz: 1,
    cells: new Uint16Array([STONE]),
    pivot: { x: 0.5, y: 0.5, z: 0.5 },
    position: { x: 0.5, y: 40.5, z: 0.5 },
    rotation: IDENTITY,
    glue: new Int32Array(0),
    helm: { x: 0, y: 0, z: 0 },
    forward: 5,
    throttle: 0,
    rudder: 0,
    helmsmanId: 0,
    ...extra,
  } as StructureRecord;
}

function rotor(id: number, parentId: number, extra: Partial<StructureRecord> = {}): StructureRecord {
  return {
    kind: 'rotor',
    id,
    parentId,
    minX: 0,
    minY: 0,
    minZ: 0,
    sx: 1,
    sy: 1,
    sz: 1,
    cells: new Uint16Array([STONE]),
    pivot: { x: 0.5, y: 0.5, z: 0.5 },
    position: { x: 0.5, y: 2.5, z: 0.5 },
    rotation: IDENTITY,
    glue: new Int32Array(0),
    bearing: { x: 0, y: 1, z: 0 },
    axis: 4,
    baseRotation: IDENTITY,
    angle: 0,
    angularSpeed: 0,
    sails: 0,
    frozen: false,
    ...extra,
  } as StructureRecord;
}

const rabbit = (id: number, carrierId = 0) => ({ id, kind: 'rabbit' as const, carrierId, pos: { x: 1, y: 2, z: 3 }, yaw: 0 });
const motion = (carrierId: number): EntityMotion => ({ kind: 'rabbit', carrierId, pos: { x: 0, y: 0, z: 0 }, yaw: 0, look: null });

/** A replica holding ship 1 with rotor 2, ship 3, rabbit 7 (free) and column 0,0. */
function scene(): ReplicaState {
  const st = fresh(5);
  expect(
    apply(
      st,
      batch(1, (b) => {
        b.snapshots.push({ cx: 0, cz: 0, cells: 'pristine', glue: [] });
        b.structureSpawns.push(ship(1), rotor(2, 1), ship(3));
        b.entitySpawns.push(rabbit(7));
      }),
    ),
  ).toBe('ok');
  return st;
}

describe('applyBatch refuses invalid batches with a ReplicaError', () => {
  const cases: Array<[string, (b: TickBatchMsg) => void]> = [
    ['entity spawn with an unknown carrier', (b) => b.entitySpawns.push(rabbit(8, 99))],
    ['entity spawn on a structure removed in the same batch', (b) => {
      b.structureRemoves.push(3);
      b.entitySpawns.push(rabbit(8, 3));
    }],
    ['final state with an unknown carrier', (b) => b.entityUpdates.push({ id: 7, final: motion(55) })],
    ['final state on a structure removed in the same batch', (b) => {
      b.structureRemoves.push(3);
      b.entityUpdates.push({ id: 7, final: motion(3) });
    }],
    ['a ship removed while its rotor stays', (b) => b.structureRemoves.push(1)],
    ['a ship removed before its rotor', (b) => b.structureRemoves.push(1, 2)],
    ['a spawn of the own entity', (b) => b.entitySpawns.push(rabbit(5))],
    ['a rest of a rotor', (b) => b.structureRests.push({ id: 2, pose: { pos: { x: 1, y: 1, z: 1 }, rot: IDENTITY } })],
    ['a ship record with a parent', (b) => b.structureSpawns.push(ship(9, { parentId: 3 }))],
    ['a rotor on a rotor', (b) => b.structureSpawns.push(rotor(9, 2))],
    ['the same structure spawned twice', (b) => b.structureSpawns.push(ship(9), ship(9))],
    ['the same column snapshotted twice', (b) => b.snapshots.push({ cx: 1, cz: 0, cells: 'pristine', glue: [] }, { cx: 1, cz: 0, cells: 'pristine', glue: [] })],
    ['two deltas of one column', (b) => b.chunkDeltas.push({ cx: 0, cz: 0, cells: [[1, STONE]], glue: [] }, { cx: 0, cz: 0, cells: [[2, STONE]], glue: [] })],
    ['two deltas of one structure', (b) => b.structureDeltas.push({ id: 3, cells: [[1, 0, 0, STONE]] }, { id: 3, cells: [[2, 0, 0, STONE]] })],
    ['two updates of one entity', (b) => b.entityUpdates.push({ id: 7, final: motion(0) }, { id: 7, final: motion(0) })],
    ['a delta growing the box to 2e5 x 1 x 2e5', (b) => b.structureDeltas.push({ id: 3, cells: [[200_000, 0, 200_000, STONE]] })],
    ['a delta growing the box one past the limit along x', (b) => b.structureDeltas.push({ id: 3, cells: [[MAX_STRUCTURE_BOX_CELLS, 0, 0, STONE]] })],
    ['a NaN pivot in a delta', (b) => b.structureDeltas.push({ id: 3, pivot: { x: NaN, y: 0, z: 0 } })],
    ['an infinite position in a record', (b) => b.structureSpawns.push(ship(9, { position: { x: Infinity, y: 0, z: 0 } }))],
    ['a zero rotation in a record', (b) => b.structureSpawns.push(ship(9, { rotation: { x: 0, y: 0, z: 0, w: 0 } }))],
    ['a NaN rotor angle', (b) => b.structureDeltas.push({ id: 2, rotor: { angle: NaN, angularSpeed: 0, sails: 0, frozen: false } })],
    ['rotor state for a ship', (b) => b.structureDeltas.push({ id: 3, rotor: { angle: 0, angularSpeed: 0, sails: 0, frozen: false } })],
    ['helm fields for a rotor', (b) => b.structureDeltas.push({ id: 2, control: { throttle: 1, rudder: 0 } })],
    ['an item stack for a rabbit', (b) => b.entityUpdates.push({ id: 7, stack: { item: 1, count: 2 } })],
    ['a fuse for a rabbit', (b) => b.entityUpdates.push({ id: 7, fuse: 3 })],
    ['the mode of a player the table does not have', (b) => (b.globals = { players: [{ op: 'mode', entityId: 42, mode: 'survival' }] })],
  ];
  for (const [name, fill] of cases) {
    it(name, () => {
      const st = scene();
      const before = st.structures.get(3)!.structure.grid.cells.length;
      expect(apply(st, batch(2, fill))).toMatch(/^ReplicaError: /);
      // Nothing was allocated in proportion to the input's coordinates.
      expect(st.structures.get(3)?.structure.grid.cells.length ?? before).toBeLessThan(1000);
    });
  }
});

describe('applyBatch accepts the valid cases at the edges', () => {
  it('removes children before parents, and re-parents a rotor whose ship is removed (docking)', () => {
    let st = scene();
    expect(apply(st, batch(2, (b) => b.structureRemoves.push(2, 1)))).toBe('ok');
    expect([...st.structures.keys()]).toEqual([3]);
    st = scene();
    expect(apply(st, batch(2, (b) => {
      b.structureRemoves.push(1);
      b.structureSpawns.push(rotor(2, 0, { position: { x: 0.5, y: 42.5, z: 0.5 } }));
    }))).toBe('ok');
    const r = st.structures.get(2)!.structure as Rotor;
    expect(r.parent).toBeNull();
    expect(r.grid.parent).toBe(st.world);
  });

  it('a delta may grow a box to exactly the limit, and replace one end by the other at the limit', () => {
    const st = scene();
    const far = MAX_STRUCTURE_BOX_CELLS - 1;
    expect(apply(st, batch(2, (b) => b.structureDeltas.push({ id: 3, cells: [[far, 0, 0, STONE]] })))).toBe('ok');
    const g = st.structures.get(3)!.structure.grid;
    expect(g.cellBounds()).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: far + 1, maxY: 1, maxZ: 1 });
    // Clearing x = 0 and adding x = far + 1 in one delta keeps the box at the limit (exact check).
    expect(apply(st, batch(3, (b) => b.structureDeltas.push({ id: 3, cells: [[far + 1, 0, 0, STONE], [0, 0, 0, 0]] })))).toBe('ok');
    expect(g.cellBounds()).toEqual({ minX: far, minY: 0, minZ: 0, maxX: far + 2, maxY: 1, maxZ: 1 });
    // Putting x = 0 back makes the box one cell wider than the limit: refused.
    expect(apply(st, batch(4, (b) => b.structureDeltas.push({ id: 3, cells: [[0, 0, 0, STONE]] })))).toMatch(/^ReplicaError: /);
  });

  it('samples: unknown carriers are skipped (reordered channel), a ship sample of a rotor is refused', () => {
    const st = scene();
    applySamples(st, { type: 'samples', tick: 2, seq: 0, ships: [], entities: [{ id: 7, ...motion(42) }] });
    expect(st.entities.get(7)!.carrierId).toBe(0);
    expect(st.entities.get(7)!.poseTick).toBe(1);
    applySamples(st, { type: 'samples', tick: 2, seq: 1, ships: [], entities: [{ id: 7, ...motion(3) }] });
    expect(st.entities.get(7)!.carrierId).toBe(3);
    expect(() => applySamples(st, { type: 'samples', tick: 3, seq: 2, ships: [{ id: 2, pose: { pos: { x: 0, y: 0, z: 0 }, rot: IDENTITY } }], entities: [] })).toThrow(ReplicaError);
  });
});

describe('the player table (globals)', () => {
  it('a join brings the mode; a mode change changes only the mode; a leave removes the player', () => {
    const st = fresh();
    expect(apply(st, batch(1, (b) => (b.globals = { players: [{ op: 'join', entityId: 4, name: 'Ann', host: false, mode: 'creative' }] })))).toBe('ok');
    expect(st.players.get(4)).toEqual({ entityId: 4, name: 'Ann', host: false, mode: 'creative' });
    expect(apply(st, batch(2, (b) => (b.globals = { players: [{ op: 'mode', entityId: 4, mode: 'survival' }] })))).toBe('ok');
    expect(st.players.get(4)).toEqual({ entityId: 4, name: 'Ann', host: false, mode: 'survival' });
    expect(apply(st, batch(3, (b) => (b.globals = { players: [{ op: 'leave', entityId: 4 }] })))).toBe('ok');
    expect(st.players.has(4)).toBe(false);
  });
});
