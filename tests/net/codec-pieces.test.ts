/**
 * codec.ts encodeTickBatch with pre-encoded pieces (package 4: a snapshot is encoded once per
 * column version and a spawn record once per tick, and the same bytes go into several batches).
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { decodeServerMessage, encodeServerMessage, encodeSnapshotPiece, encodeStructureRecordPiece, encodeTickBatch } from '../../src/net/codec';
import { emptyTickBatch, MAX_BATCH_CELLS, SECTION, type ChunkSnapshot, type StructureRecord, type TickBatchMsg } from '../../src/net/protocol';
import { RELIABLE } from '../../src/net/transport';

function column(cx: number, seed: number): ChunkSnapshot {
  const cells = new Uint16Array(CHUNK_VOLUME);
  for (let i = 0; i < cells.length; i++) cells[i] = i < 40 * 256 ? 1 + ((i * seed) % 3) : 0;
  return { cx, cz: -cx, cells, glue: [5, 70000] };
}

function ship(id: number): StructureRecord {
  return {
    kind: 'ship',
    id,
    parentId: 0,
    minX: -3,
    minY: 10,
    minZ: 4,
    sx: 2,
    sy: 1,
    sz: 2,
    cells: Uint16Array.from([5, 5, 0, 50]),
    pivot: { x: 1.25, y: 10.5, z: 4.75 },
    position: { x: 1.25, y: 10.5, z: 4.75 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    glue: Int32Array.from([-3, 10, 4, 0]),
    helm: { x: -2, y: 10, z: 5 },
    forward: 5,
    throttle: 0.5,
    rudder: -0.25,
    helmsmanId: 7,
  };
}

describe('TickBatch with pre-encoded pieces', () => {
  it('decodes exactly like the same batch encoded from objects; sections are measured', () => {
    const snaps = [column(1, 3), { cx: 2, cz: 2, cells: 'pristine' as const, glue: [] }, column(-4, 5)];
    const spawns = [ship(3), ship(9)];
    const b: TickBatchMsg = { ...emptyTickBatch(1234), unsubscribe: [{ cx: 9, cz: 9 }], structureRemoves: [4], events: [{ type: 'sound', name: 'glue', x: 1, y: 2, z: 3 }] };
    const whole = encodeServerMessage({ ...b, snapshots: snaps, structureSpawns: spawns });
    const pieces = { snapshots: snaps.map(encodeSnapshotPiece), structureSpawns: spawns.map(encodeStructureRecordPiece) };
    expect(pieces.snapshots.map((p) => p.cells)).toEqual([CHUNK_VOLUME, 0, CHUNK_VOLUME]);
    expect(pieces.structureSpawns.map((p) => p.cells)).toEqual([4, 4]);
    const sections: number[] = [];
    const shared = encodeTickBatch(b, pieces, sections);
    expect(shared).toEqual(whole);
    expect(decodeServerMessage(shared, RELIABLE)).toEqual(decodeServerMessage(whole, RELIABLE));
    expect(sections[SECTION.snapshots]).toBe(1 + pieces.snapshots.reduce((n, p) => n + p.bytes.length, 0));
    expect(sections[SECTION.structureSpawns]).toBe(1 + pieces.structureSpawns.reduce((n, p) => n + p.bytes.length, 0));
    const header = 1 + 2 + 2; // id, vu tick (2 bytes for 1234), u16 mask
    expect(sections.reduce((n, x) => n + (x ?? 0), 0)).toBe(shared.length - header);
  });

  it('charges the pieces to MAX_BATCH_CELLS like the objects', () => {
    const p = encodeSnapshotPiece({ cx: 0, cz: 0, cells: new Uint16Array(CHUNK_VOLUME).fill(1), glue: [] }); // a few bytes, 32768 cells
    const many = Array.from({ length: MAX_BATCH_CELLS / CHUNK_VOLUME + 1 }, () => p);
    expect(() => encodeTickBatch(emptyTickBatch(1), { snapshots: many, structureSpawns: [] })).toThrow(RangeError);
    expect(() => encodeTickBatch(emptyTickBatch(1), { snapshots: many.slice(1), structureSpawns: [] })).not.toThrow();
  });
});
