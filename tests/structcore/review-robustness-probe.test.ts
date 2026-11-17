import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { c, facing, fill, scene } from './helpers';

describe('probe', () => {
  it('sparse ship round trip', () => {
    const s = scene();
    fill(s.world, -2, 60, -2, 2, 60, 2, c(B.PLANKS_OAK));
    s.world.setCell(0, 61, 0, facing(B.HELM, 5));
    const r = s.mgr.assembleShip(0, 61, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.structure.grid;
    // the player extends the ship: two far-apart additions (ships are editable at any time)
    g.setCell(-210, 60, -300, c(B.PLANKS_OAK));
    g.setCell(210, 127, 300, c(B.PLANKS_OAK));
    const box = (g.sx * g.sy * g.sz);
    console.log('box', box, 'bytes', box * 2);
    const w = new ByteWriter();
    s.mgr.serialize(w);
    const bytes = w.finish();
    console.log('save bytes', bytes.length);
    const s2 = scene();
    expect(() => s2.mgr.deserialize(new ByteReader(bytes))).not.toThrow();
  });
});
