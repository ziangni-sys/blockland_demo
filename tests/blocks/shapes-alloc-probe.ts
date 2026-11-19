/**
 * Child-process probe for tests/blocks/shapes-alloc.test.ts (not a test file itself): heap
 * bytes per call of the face-quadrant queries of blocks/shapes.ts that the mesher and the
 * overlays call per face (quadrantOctant, faceCover), and of the value-level queries on full
 * blocks and single parts (values below 2^24, small integers). Value-level queries on a packed
 * two-part cell box that value when not inlined and are not measured here.
 */
import { makeCell, makePart } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import type { Dir } from '../../src/core/dirs';
import { faceCover, partAt, quadrantOctant, solidCover, solidFill } from '../../src/blocks/shapes';
import { measureCases } from '../heap-probe';

const VALUES = [makeCell(B.STONE), makePart(B.PLANKS_OAK, 0, 0xcc), makePart(B.STONE, 0, 0x5a), makeCell(B.GLASS)];

await measureCases({
  'quadrantOctant(dir, q)': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += quadrantOctant((i % 6) as Dir, (i >> 3) & 3);
    return s;
  },
  'faceCover(fill, dir)': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += faceCover(i & 255, (i % 6) as Dir);
    return s;
  },
  'solidFill(single part)': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += solidFill(VALUES[i & 3]!);
    return s;
  },
  'solidCover(single part, dir)': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += solidCover(VALUES[i & 3]!, (i % 6) as Dir);
    return s;
  },
  'partAt(single part, octant)': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += partAt(VALUES[i & 3]!, i & 7) & 1023;
    return s;
  },
});
