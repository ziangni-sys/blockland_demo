/**
 * Adversarial review (robustness): structures are saved as their dense tight cell box, and the
 * reader refuses boxes above 2^24 cells. A ship whose cells are few but far apart (ships may be
 * edited at any time; a legally assembled 878-cell "jack" of planks spanning 301 x 127 x 451 hits
 * the same wall) therefore writes a multi-megabyte save that deserialize() rejects with a
 * SaveFormatError — i.e. the whole world save becomes unloadable.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { c, facing, fill, scene } from './helpers';

function sparseShipSave(): { bytes: Uint8Array; cells: number } {
  const s = scene();
  fill(s.world, -2, 60, -2, 2, 60, 2, c(B.PLANKS_OAK));
  s.world.setCell(0, 61, 0, facing(B.HELM, 5));
  const r = s.mgr.assembleShip(0, 61, 0);
  if (!r.ok) throw new Error(r.reason);
  const g = r.structure.grid;
  // The player extends the ship far out in two directions (plain ship.grid.setCell edits,
  // which the brief explicitly allows at any time). Tight box: 421 x 68 x 601 = 17.2M cells.
  g.setCell(-210, 60, -300, c(B.PLANKS_OAK));
  g.setCell(210, 127, 300, c(B.PLANKS_OAK));
  const w = new ByteWriter();
  s.mgr.serialize(w);
  return { bytes: w.finish(), cells: g.count };
}

describe('review-robustness: sparse structures and persistence', () => {
  it('a save written by serialize() can always be read back by deserialize()', () => {
    const { bytes } = sparseShipSave();
    const s2 = scene();
    // Currently throws: "SaveFormatError: data: cell box of 17205428 cells is too large".
    expect(() => s2.mgr.deserialize(new ByteReader(bytes))).not.toThrow();
    expect(s2.mgr.ships()).toHaveLength(1);
    expect(s2.mgr.ships()[0]!.grid.count).toBe(28);
  });

  it('save size scales with the cell count, not with the bounding box', () => {
    const { bytes, cells } = sparseShipSave();
    expect(cells).toBe(28);
    // Currently ~34 MB for 28 cells (every autosave writes it again).
    expect(bytes.length).toBeLessThan(64 * 1024);
  });
});
