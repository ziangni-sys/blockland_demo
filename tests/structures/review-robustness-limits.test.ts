/**
 * Adversarial review (robustness lens): failing reproductions for verified defects in the
 * stick module. Each test states the expected behaviour from the module's own documentation.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { PX } from '../../src/core/dirs';
import { collectRotor } from '../../src/structures/collect';
import { GLUE_MAX_XZ, GLUE_MAX_Y, GlueStore } from '../../src/structures/glue';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';

describe('review: GlueStore box queries at the upper edge of the key range', () => {
  // forEachInBox clamps every bound to [MIN - 1, MAX + 1]. A box lying entirely beyond
  // MAX + 1 is therefore squashed onto the plane MAX + 1, which is exactly where the far end
  // of a face keyed on MAX lies, so that face is reported although neither of its end cells
  // is inside the requested box.
  it('a box entirely beyond GLUE_MAX_XZ + 1 on z returns nothing', () => {
    const s = new GlueStore();
    s.add(0, 0, GLUE_MAX_XZ, 4); // face between z = MAX and z = MAX + 1
    expect(s.facesInBox(-1, -1, GLUE_MAX_XZ + 2, 1, 1, GLUE_MAX_XZ + 5)).toEqual([]);
  });

  it('a box entirely beyond GLUE_MAX_XZ + 1 on x returns nothing', () => {
    const s = new GlueStore();
    s.add(GLUE_MAX_XZ, 0, 0, 0); // face between x = MAX and x = MAX + 1
    const seen: number[] = [];
    s.forEachInBox(GLUE_MAX_XZ + 10, -1, -1, GLUE_MAX_XZ + 20, 1, 1, (x) => seen.push(x));
    expect(seen).toEqual([]);
  });

  it('a box entirely beyond GLUE_MAX_Y + 1 on y returns nothing', () => {
    const s = new GlueStore();
    s.add(0, GLUE_MAX_Y, 0, 2); // face between y = MAX_Y and y = MAX_Y + 1
    expect(s.facesInBox(-1, GLUE_MAX_Y + 3, -1, 1, GLUE_MAX_Y + 9, 1)).toEqual([]);
  });
});

describe('review: collectRotor limit handling', () => {
  // collect.ts documents checkLimit as "Validates a limit and floors it" and the module
  // report says "Limits: they are floored". For maxCells the floored value is used, but for
  // minSails the floored value is discarded, so a fractional minSails acts as a ceiling.
  it('a fractional minSails is floored like maxCells (3 sails satisfy minSails 3.5)', () => {
    const g = new StructureGrid(5, new World(1));
    g.setCell(0, 0, 0, makeCell(B.PLANKS_OAK));
    g.setCell(1, 0, 0, makeCell(B.BEARING, facingState(PX)));
    g.setCell(2, 0, 0, makeCell(B.CANVAS)); // hub
    g.setCell(2, 1, 0, makeCell(B.CANVAS));
    g.setCell(2, -1, 0, makeCell(B.CANVAS));
    const r = collectRotor(g, new GlueStore(), 1, 0, 0, 400, 3.5);
    expect(r.sails).toBe(3);
    expect(r.reason).toBe('ok');
  });
});
