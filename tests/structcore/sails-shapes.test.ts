/**
 * Sails count by volume and travel as eighths (docs/SHAPES.md 11.1, 11.5; NETCODE section 14):
 * a rotor of felt slabs has fractional sails; the structure save, the structure record and the
 * rotor delta carry round(sails x 8) and read it back divided by 8, exactly; the helm instrument
 * shows the exact value.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { decodeServerMessage, encodeServerMessage } from '../../src/net/codec';
import { emptyTickBatch, MESSAGE_CHANNEL, type RotorRecord, type TickBatchMsg } from '../../src/net/protocol';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { Rotor } from '../../src/structures/structure';
import { sailsText } from '../../src/ui/views/helm';
import { LOWER, slab } from '../shapes';
import { c, facing, scene } from './helpers';

/** A bearing at (0,65,0) facing +Z, a canvas slab hub and `n` felt lower slabs in a row towards +X. */
function slabMill(n: number): { s: ReturnType<typeof scene>; rotor: Rotor } {
  const s = scene();
  s.world.setCell(0, 65, -1, c(B.PLANKS_OAK));
  s.world.setCell(0, 65, 0, facing(B.BEARING, 4));
  s.world.setCell(0, 65, 1, slab(B.CANVAS, LOWER));
  for (let i = 1; i <= n; i++) s.world.setCell(i, 65, 1, slab(B.WOOL_RED, LOWER));
  const r = s.mgr.startRotor(s.world, 0, 65, 0);
  if (!r.ok) throw new Error(r.reason);
  return { s, rotor: r.structure };
}

function batchWith(m: Partial<TickBatchMsg>): TickBatchMsg {
  return { ...emptyTickBatch(7), ...m };
}

describe('sails by volume on the rotor and the ship (SHAPES 11.1)', () => {
  it('a rotor of slabs has the volume of its sail material as sails', () => {
    const { rotor } = slabMill(8);
    expect(rotor.sails).toBe(4.5);
    expect(rotor.sails * 8).toBe(36);
  });
});

describe('sails in the structure save: varuint round(sails x 8) (SHAPES 11.5)', () => {
  it('a fractional sail count comes back exactly; a whole one too', () => {
    for (const n of [7, 8, 9]) {
      const { s, rotor } = slabMill(n);
      rotor.grid.setCell(1, 65, 1, slab(B.WOOL_RED, 0x11)); // two octants: a quarter sail
      const want = 0.5 + (n - 1) * 0.5 + 0.25;
      expect(rotor.sails).toBe(want);
      const w = new ByteWriter();
      s.mgr.serialize(w);
      const t = scene();
      t.mgr.deserialize(new ByteReader(w.finish()));
      const back = t.mgr.rotors()[0]!;
      expect(back.sails).toBe(want);
    }
  });

  it('the value written is the number of eighths', () => {
    const { s, rotor } = slabMill(8);
    const w1 = new ByteWriter();
    s.mgr.serialize(w1);
    const a = w1.finish();
    rotor.sails = 4.625;
    const w2 = new ByteWriter();
    s.mgr.serialize(w2);
    const b = w2.finish();
    // 36 and 37 eighths are both one-byte varuints: the saves differ in exactly that byte.
    expect(a.length).toBe(b.length);
    const diff = [...a].map((v, i) => (v !== b[i] ? i : -1)).filter((i) => i >= 0);
    expect(diff).toHaveLength(1);
    expect([a[diff[0]!], b[diff[0]!]]).toEqual([36, 37]);
  });
});

describe('sails on the wire: vu round(sails x 8) in the record and the rotor delta (SHAPES 13.2)', () => {
  const record: RotorRecord = {
    kind: 'rotor',
    id: 3,
    parentId: 0,
    minX: 0,
    minY: 0,
    minZ: 0,
    sx: 0,
    sy: 0,
    sz: 0,
    cells: { base: new Uint16Array(0), holes: null, part2: null },
    pivot: { x: 0.5, y: 65.5, z: 1.5 },
    position: { x: 0.5, y: 65.5, z: 1.5 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    glue: new Int32Array(0),
    bearing: { x: 0, y: 65, z: 0 },
    axis: 4,
    baseRotation: { x: 0, y: 0, z: 0, w: 1 },
    angle: 0.25,
    angularSpeed: 0.5,
    sails: 4.625,
    frozen: false,
  };

  it('a fractional count round-trips exactly in the spawn record and in the delta', () => {
    for (const sails of [0, 0.125, 4.5, 4.625, 40, 1000.875]) {
      const m = batchWith({ structureSpawns: [{ ...record, sails }], structureDeltas: [{ id: 3, rotor: { angle: 1, angularSpeed: 0.5, sails, frozen: true } }] });
      const back = decodeServerMessage(encodeServerMessage(m), MESSAGE_CHANNEL.tickBatch) as TickBatchMsg;
      expect((back.structureSpawns[0] as RotorRecord).sails).toBe(sails);
      expect(back.structureDeltas[0]!.rotor!.sails).toBe(sails);
    }
  });

  it('the field is the number of eighths: 4.5 and 4.625 sails differ in one byte, 36 against 37', () => {
    const enc = (sails: number) => encodeServerMessage(batchWith({ structureDeltas: [{ id: 3, rotor: { angle: 1, angularSpeed: 0.5, sails, frozen: false } }] }));
    const a = enc(4.5);
    const b = enc(4.625);
    expect(a.length).toBe(b.length);
    const diff = [...a].map((v, i) => (v !== b[i] ? i : -1)).filter((i) => i >= 0);
    expect(diff).toHaveLength(1);
    expect([a[diff[0]!], b[diff[0]!]]).toEqual([36, 37]);
  });
});

describe('the helm shows the exact sail count', () => {
  it('whole, half and eighth values; never negative', () => {
    expect(sailsText(8)).toBe('8');
    expect(sailsText(4.5)).toBe('4.5');
    expect(sailsText(4.125)).toBe('4.125');
    expect(sailsText(0)).toBe('0');
    expect(sailsText(-0.125)).toBe('0');
  });
});
