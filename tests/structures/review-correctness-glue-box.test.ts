/**
 * Review (correctness): GlueStore.facesInBox / forEachInBox clamp the query box to
 * [GLUE_MIN - 1, GLUE_MAX + 1] before filtering. For a box lying ENTIRELY beyond the upper end
 * of the key range, both bounds collapse onto GLUE_MAX + 1, which drags the far end cell of
 * faces keyed at GLUE_MAX into the box: faces are returned although neither end cell is inside
 * the requested box (the documented contract is "at least one end cell inside the box").
 */
import { describe, expect, it } from 'vitest';
import { PX, PY } from '../../src/core/dirs';
import { GLUE_MAX_XZ, GLUE_MAX_Y, GlueStore } from '../../src/structures/glue';

describe('review: facesInBox with a box beyond the key range', () => {
  it('returns nothing when no end cell of any face lies in the box (x)', () => {
    const s = new GlueStore();
    s.add(GLUE_MAX_XZ, 0, 0, PX); // joins GLUE_MAX_XZ and GLUE_MAX_XZ + 1
    // Box x in [MAX+5, MAX+10]: neither MAX nor MAX+1 is inside.
    expect(s.facesInBox(GLUE_MAX_XZ + 5, 0, 0, GLUE_MAX_XZ + 10, 0, 0)).toEqual([]);
  });

  it('returns nothing when no end cell of any face lies in the box (y)', () => {
    const s = new GlueStore();
    s.add(0, GLUE_MAX_Y, 0, PY);
    expect(s.facesInBox(0, GLUE_MAX_Y + 5, 0, 0, GLUE_MAX_Y + 10, 0)).toEqual([]);
  });

  it('forEachInBox agrees', () => {
    const s = new GlueStore();
    s.add(GLUE_MAX_XZ, 7, -3, PX);
    let n = 0;
    s.forEachInBox(GLUE_MAX_XZ + 2, 7, -3, GLUE_MAX_XZ + 1000, 7, -3, () => n++);
    expect(n).toBe(0);
  });
});
