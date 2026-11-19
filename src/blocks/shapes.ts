/**
 * Shapes on VALUES (docs/SHAPES.md sections 2 and 3): the geometry tables indexed by an
 * octant mask, and the pure queries every system uses to read a cell's geometry. Nothing here
 * knows a grid; the grid-level queries live in src/voxel/.
 *
 * Octant o = ox | oy << 1 | oz << 2 occupies [ox/2, ox/2 + 0.5) x [oy/2, ...) x [oz/2, ...) of
 * its cell. A FILL is an 8-bit mask of occupied octants; a part's fill is `~holes & 0xff`.
 *
 * Every table below is a constant computed once when the module loads (read-only afterwards;
 * not a cache filled on use). The tests recompute each table from the specification's text
 * and compare FNV-1a checksums of the bytes.
 *
 * Arguments named `c`, `packed`, `dest`, `incoming`, `a`, `b`, `dst`, `src` are PACKED cells
 * (cell.ts). A value from getCell can be passed directly when it has no CELL_MULTI_BIT.
 *
 * Totality (section 3): the queries of sections 3.1 and 3.2 and mergeProblem are defined for
 * every value that passes the protocol's Cell layout check (section 13.1), including values
 * that are semantically invalid (overlapping parts, holes on a material that cannot be cut,
 * unregistered ids). They read the bits only: a part's fill is `~partHoles(p) & 0xff` and the
 * material tables have 1024 entries (unregistered ids read 0). The only throws are the
 * tripwire (a value in [2^24, 2^25): CELL_MULTI_BIT without a second part) and the functions
 * that say they require something (mergeCells, canonCell, withOctant, and the carving helpers).
 */
import { DIR_X, DIR_Y, DIR_Z, nearestDir, PY, type Dir } from '../core/dirs';
import {
  CELL_LIMIT,
  CELL_MULTI_BIT,
  FULL_LIMIT,
  HOLES_MASK,
  HOLES_SHIFT,
  ID_MASK,
  makePart,
  PACK_SCALE,
  PART_LIMIT,
  PART_MASK,
  STATE_MASK,
  STATE_SHIFT,
} from './cell';
import { BLOCKS, CUTTABLE, EMIT, LIGHT_OPACITY, OPAQUE, SOLID } from './registry';
// Importing defs also registers the block table, which cellProblem and rotatePart look ids up in.
import { B } from './defs';

/** What getCell answers for a position that is not loaded. A reading, never a stored content. */
const UNLOADED_ID = B.UNLOADED;

// ====================================================================== 2.1 volume and centroid

/** [fill] = number of occupied octants, 0..8. */
export const FILL_VOLUME = new Uint8Array(256);
/** [fill * 3 + axis] = mean of the occupied octants' centres, cell-local 0..1; 0.5 for fill 0. */
export const CENTROID = new Float64Array(256 * 3);
/** [dir] = the 4 octants on that side of the cell: +X, -X, +Y, -Y, +Z, -Z. */
export const HALF_FILL: readonly number[] = Object.freeze([0xaa, 0x55, 0xcc, 0x33, 0xf0, 0x0f]);
/**
 * [fill * 3 + axis] = where the item drop of a removed part with this fill appears (the item's
 * feet, cell-local 0..1): the cell centre for fill 0xff (and 0), otherwise the centre of the
 * lowest-numbered occupied octant. Not the centroid: a part need not be convex or connected,
 * and its centroid can lie inside the other part of the cell (section 2.1).
 */
export const DROP_POINT = new Float64Array(256 * 3);

// ====================================================================== 2.2 box decomposition

/** [fill] = number of boxes, 0..4. */
export const BOX_COUNT = new Uint8Array(256);
/**
 * [fill * 24 + k * 6 + (0..5)] = x0, y0, z0, x1, y1, z1 of box k in half-cell units (0..2);
 * unused entries 0. The boxes are disjoint, their union is the fill, and their number is
 * minimal; the decomposition is the first one found by the fixed search of section 2.2.
 */
export const BOXES = new Uint8Array(256 * 24);

// ====================================================================== 2.3 face quadrant cover

/**
 * [fill]: bit (d * 4 + q) = the octant behind quadrant q of face d is occupied. Quadrant
 * q = hu | hv << 1 where u < v are the two axes other than the face's axis and hu, hv the half
 * (0 low, 1 high) on each. The same quadrant number names the same square on both sides of a
 * shared face, so "two cells touch on face d" is faceCover(a, d) & faceCover(b, d ^ 1).
 */
export const FACE_COVER = new Uint32Array(256);

// ====================================================================== 2.4 the 24 rotations

/** [rot * 256 + fill] = the fill rotated by rotation number rot (see rotIndex). */
export const ROT_FILL = new Uint8Array(24 * 256);

/** Octant mask of the half-cell box with per-axis range r (0 low half, 1 high half, 2 both). */
function rangeMask(rx: number, ry: number, rz: number): number {
  let m = 0;
  for (let o = 0; o < 8; o++) {
    const ox = o & 1;
    const oy = (o >> 1) & 1;
    const oz = (o >> 2) & 1;
    if ((rx === 2 || rx === ox) && (ry === 2 || ry === oy) && (rz === 2 || rz === oz)) m |= 1 << o;
  }
  return m;
}

function buildVolumeTables(): void {
  for (let f = 0; f < 256; f++) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let lowest = -1;
    for (let o = 0; o < 8; o++) {
      if (((f >> o) & 1) === 0) continue;
      if (lowest < 0) lowest = o;
      n++;
      sx += 0.25 + 0.5 * (o & 1);
      sy += 0.25 + 0.5 * ((o >> 1) & 1);
      sz += 0.25 + 0.5 * ((o >> 2) & 1);
    }
    FILL_VOLUME[f] = n;
    CENTROID[f * 3] = n === 0 ? 0.5 : sx / n;
    CENTROID[f * 3 + 1] = n === 0 ? 0.5 : sy / n;
    CENTROID[f * 3 + 2] = n === 0 ? 0.5 : sz / n;
    const centre = f === 0 || f === 0xff;
    DROP_POINT[f * 3] = centre ? 0.5 : 0.25 + 0.5 * (lowest & 1);
    DROP_POINT[f * 3 + 1] = centre ? 0.5 : 0.25 + 0.5 * ((lowest >> 1) & 1);
    DROP_POINT[f * 3 + 2] = centre ? 0.5 : 0.25 + 0.5 * ((lowest >> 2) & 1);
  }
}

function buildBoxTables(): void {
  // The 27 candidate boxes, coded rx + 3*ry + 9*rz; larger volume first, then smaller code.
  const codes: number[] = [];
  for (let code = 0; code < 27; code++) codes.push(code);
  const vol = (code: number): number => (code % 3 === 2 ? 2 : 1) * (Math.floor(code / 3) % 3 === 2 ? 2 : 1) * (Math.floor(code / 9) === 2 ? 2 : 1);
  codes.sort((a, b) => vol(b) - vol(a) || a - b);
  const masks = codes.map((code) => rangeMask(code % 3, Math.floor(code / 3) % 3, Math.floor(code / 9)));
  const chosen: number[] = [];
  // Depth first: each step covers the lowest remaining octant with a candidate that lies
  // entirely inside the remaining octants, tried in candidate order.
  const search = (rem: number, budget: number): boolean => {
    if (rem === 0) return true;
    if (budget === 0) return false;
    const low = rem & -rem;
    for (let i = 0; i < 27; i++) {
      const m = masks[i]!;
      if ((m & low) === 0 || (m & ~rem) !== 0) continue;
      chosen.push(i);
      if (search(rem & ~m, budget - 1)) return true;
      chosen.pop();
    }
    return false;
  };
  for (let f = 1; f < 256; f++) {
    let k = 1;
    while (!search(f, k)) k++;
    BOX_COUNT[f] = chosen.length;
    chosen.forEach((i, j) => {
      const code = codes[i]!;
      const r = [code % 3, Math.floor(code / 3) % 3, Math.floor(code / 9)];
      for (let axis = 0; axis < 3; axis++) {
        BOXES[f * 24 + j * 6 + axis] = r[axis] === 1 ? 1 : 0;
        BOXES[f * 24 + j * 6 + 3 + axis] = r[axis] === 0 ? 1 : 2;
      }
    });
    chosen.length = 0;
  }
}

function buildFaceCover(): void {
  for (let f = 0; f < 256; f++) {
    let bits = 0;
    for (let d = 0; d < 6; d++) {
      for (let q = 0; q < 4; q++) {
        if ((f >> quadrantOctant(d as Dir, q)) & 1) bits |= 1 << (d * 4 + q);
      }
    }
    FACE_COVER[f] = bits;
  }
}

/** Right-handed third axis image: ax x ay. */
function crossDir(a: Dir, b: Dir): Dir {
  const x = DIR_Y[a]! * DIR_Z[b]! - DIR_Z[a]! * DIR_Y[b]!;
  const y = DIR_Z[a]! * DIR_X[b]! - DIR_X[a]! * DIR_Z[b]!;
  const z = DIR_X[a]! * DIR_Y[b]! - DIR_Y[a]! * DIR_X[b]!;
  return nearestDir(x, y, z);
}

function buildRotFill(): void {
  const image = new Uint8Array(8);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      if (j >> 1 === i >> 1) continue;
      const ax = i as Dir;
      const ay = j as Dir;
      const az = crossDir(ax, ay);
      const rot = rotIndex(ax, ay);
      // Octant o's centre relative to the cell centre is (ox - 1/2, oy - 1/2, oz - 1/2); rotate it
      // like rotVec does (x * image(+X) + y * image(+Y) + z * image(+Z)) and read the signs.
      for (let o = 0; o < 8; o++) {
        const x = (o & 1) * 2 - 1;
        const y = ((o >> 1) & 1) * 2 - 1;
        const z = ((o >> 2) & 1) * 2 - 1;
        const rx = x * DIR_X[ax]! + y * DIR_X[ay]! + z * DIR_X[az]!;
        const ry = x * DIR_Y[ax]! + y * DIR_Y[ay]! + z * DIR_Y[az]!;
        const rz = x * DIR_Z[ax]! + y * DIR_Z[ay]! + z * DIR_Z[az]!;
        image[o] = (rx > 0 ? 1 : 0) | (ry > 0 ? 2 : 0) | (rz > 0 ? 4 : 0);
      }
      for (let f = 0; f < 256; f++) {
        let g = 0;
        for (let o = 0; o < 8; o++) if ((f >> o) & 1) g |= 1 << image[o]!;
        ROT_FILL[rot * 256 + f] = g;
      }
    }
  }
}

/** Cover bits (4) of face `dir` for an octant mask. */
export function faceCover(fill: number, dir: Dir): number {
  return (FACE_COVER[fill]! >>> (dir * 4)) & 15;
}

/**
 * The octant right behind quadrant q of face dir. Allocation free (consumers walk face quadrants
 * per face): the two other axes u < v are plain scalars, never a tuple.
 */
export function quadrantOctant(dir: Dir, q: number): number {
  const a = dir >> 1;
  const u = a === 0 ? 1 : 0;
  const v = a === 2 ? 1 : 2;
  return (((dir & 1) ^ 1) << a) | ((q & 1) << u) | (((q >> 1) & 1) << v);
}

/** True when this face of the octant lies on the cell boundary (not on the cell's middle plane). */
export function isCellFace(octant: number, face: Dir): boolean {
  return ((octant >> (face >> 1)) & 1) === ((face & 1) ^ 1);
}

/**
 * Number 0..23 of the grid rotation whose images of +X and +Y are ax and ay (structures/orient.ts
 * GridRot; az follows from right-handedness): ax * 4 + the rank of ay among the four directions
 * not on ax's axis, in Dir order. Throws RangeError when ay is on ax's axis.
 */
export function rotIndex(ax: Dir, ay: Dir): number {
  if (!(ax >= 0 && ax < 6 && ay >= 0 && ay < 6) || ax >> 1 === ay >> 1) throw new RangeError(`not a rotation: ax ${ax}, ay ${ay}`);
  return ax * 4 + (ay >> 1 > ax >> 1 ? ay - 2 : ay);
}

/** The fill rotated by the grid rotation with images ax, ay of +X, +Y. */
export function rotateFill(fill: number, ax: Dir, ay: Dir): number {
  return ROT_FILL[rotIndex(ax, ay) * 256 + fill]!;
}

buildVolumeTables();
buildBoxTables();
buildFaceCover();
buildRotFill();

// ====================================================================== 2.5 rotating parts

/**
 * Rotate a part value (< 2^24) by the grid rotation with axis images ax, ay, az. State and holes
 * rotate independently: stateKind 'axis' gets the rotated axis in its low 2 bits, 'facing' the
 * rotated direction in its low 3 bits (the rules of structures/orient.ts rotCell), other states
 * are unchanged; the holes become `~ROT_FILL[rot][~holes & 0xff] & 0xff`. The id is unchanged.
 * Throws RangeError for a value that is not a part (negative, fractional, or with bit 24).
 */
export function rotatePart(part: number, ax: Dir, ay: Dir, az: Dir): number {
  if (!Number.isInteger(part) || part < 0 || part >= PART_LIMIT) throw new RangeError(`not a part value: ${part}`);
  const rot = rotIndex(ax, ay);
  const id = part & ID_MASK;
  let state = (part >>> STATE_SHIFT) & STATE_MASK;
  const kind = BLOCKS[id]?.stateKind;
  if (kind === 'axis') {
    const axis = (state & 3) > 2 ? 1 : state & 3;
    state = (state & (STATE_MASK & ~3)) | (imageDir(axis << 1, ax, ay, az) >> 1);
  } else if (kind === 'facing') {
    const f = (state & 7) > 5 ? 0 : state & 7;
    state = (state & (STATE_MASK & ~7)) | imageDir(f, ax, ay, az);
  }
  let holes = (part >>> HOLES_SHIFT) & HOLES_MASK;
  if (holes !== 0) holes = ~ROT_FILL[rot * 256 + (~holes & 0xff)]! & 0xff;
  return makePart(id, state, holes);
}

/** Image of direction d under the grid rotation with axis images ax, ay, az (orient.ts rotDir). */
function imageDir(d: number, ax: Dir, ay: Dir, az: Dir): number {
  const img = d >> 1 === 0 ? ax : d >> 1 === 1 ? ay : az;
  return (d & 1) === 0 ? img : img ^ 1;
}

/** Rotate a packed cell: each part with rotatePart, then the parts are put back in canonical order (I6). */
export function rotatePacked(packed: number, ax: Dir, ay: Dir, az: Dir): number {
  if (packed < FULL_LIMIT) return rotatePart(packed, ax, ay, az);
  tripwire(packed);
  const p2 = second(packed);
  const r1 = rotatePart(packed & PART_MASK, ax, ay, az);
  return p2 === 0 ? r1 : canonCell(r1, rotatePart(p2, ax, ay, az));
}

// ====================================================================== 3 helpers

/** Throws on the tripwire value: CELL_MULTI_BIT set and no second part (a value in [2^24, 2^25)). */
function tripwire(c: number): void {
  if (c >= CELL_MULTI_BIT && c < CELL_LIMIT) {
    throw new RangeError(`cell ${c} has CELL_MULTI_BIT but no second part (copy cells with getPacked / copyCell, not getCell)`);
  }
}

/** Second part of a packed cell (0 = none). */
function second(c: number): number {
  return c < PACK_SCALE ? 0 : Math.floor(c / PACK_SCALE);
}

/** Occupied octants of a part value. */
function fillOf(part: number): number {
  return ~(part >>> HOLES_SHIFT) & 0xff;
}

/** Union of the fills of the parts whose material has table[id] !== 0. */
function materialFill(c: number, table: Uint8Array): number {
  tripwire(c);
  const p1 = c & PART_MASK;
  let f = table[p1 & ID_MASK] !== 0 ? fillOf(p1) : 0;
  const p2 = second(c);
  if (p2 !== 0 && table[p2 & ID_MASK] !== 0) f |= fillOf(p2);
  return f;
}

function checkOctant(octant: number): void {
  if (!(octant >= 0 && octant < 8) || !Number.isInteger(octant)) throw new RangeError(`not an octant: ${octant}`);
}

// ====================================================================== 3.1 occupancy

/** Octants occupied by hard material (SOLID), the union over both parts. */
export function solidFill(c: number): number {
  if (c < FULL_LIMIT) return SOLID[c & ID_MASK] !== 0 ? 0xff : 0;
  return materialFill(c, SOLID);
}

/** Octants occupied by opaque material (OPAQUE). */
export function opaqueFill(c: number): number {
  if (c < FULL_LIMIT) return OPAQUE[c & ID_MASK] !== 0 ? 0xff : 0;
  return materialFill(c, OPAQUE);
}

/**
 * "Which octants of this cell are taken": air 0; a cuttable material its part's fill; any
 * other block (liquid, model, hard block that cannot be cut) 0xff. Union over both parts.
 */
export function cellFill(c: number): number {
  if (c < FULL_LIMIT) return (c & ID_MASK) === 0 ? 0 : 0xff;
  tripwire(c);
  const p1 = c & PART_MASK;
  const id1 = p1 & ID_MASK;
  let f = id1 === 0 ? 0 : CUTTABLE[id1] !== 0 ? fillOf(p1) : 0xff;
  const p2 = second(c);
  if (p2 !== 0) f |= CUTTABLE[p2 & ID_MASK] !== 0 ? fillOf(p2) : 0xff;
  return f;
}

/** Number of parts: 0 for air, 2 for a two-part cell. */
export function partCount(c: number): 0 | 1 | 2 {
  if (c < FULL_LIMIT) return (c & ID_MASK) === 0 ? 0 : 1;
  tripwire(c);
  return (((c & ID_MASK) === 0 ? 0 : 1) + (second(c) === 0 ? 0 : 1)) as 0 | 1 | 2;
}

/**
 * The part value that contains this octant, 0 when the octant is empty. The first part counts
 * when its id is not 0 and its holes lack the octant, then the second part likewise. So a full
 * single-part block (models included) answers its value for every octant, air answers 0.
 */
export function partAt(c: number, octant: number): number {
  if (c < FULL_LIMIT) return (c & ID_MASK) === 0 ? 0 : c;
  tripwire(c);
  const p1 = c & PART_MASK;
  if ((p1 & ID_MASK) !== 0 && ((p1 >>> (HOLES_SHIFT + octant)) & 1) === 0) return p1;
  const p2 = second(c);
  if (p2 !== 0 && ((p2 >>> (HOLES_SHIFT + octant)) & 1) === 0) return p2;
  return 0;
}

/** The other part of the cell: the one partAt(c, octant) is not; 0 when there is none or the octant is empty. */
export function otherPart(c: number, octant: number): number {
  if (c < FULL_LIMIT) return 0;
  tripwire(c);
  const p1 = c & PART_MASK;
  const has1 = (p1 & ID_MASK) !== 0;
  const p2 = second(c);
  if (has1 && ((p1 >>> (HOLES_SHIFT + octant)) & 1) === 0) return p2;
  if (p2 !== 0 && ((p2 >>> (HOLES_SHIFT + octant)) & 1) === 0) return has1 ? p1 : 0;
  return 0;
}

/** Octants of hard material, 0..8 (mass, sail count and buoyancy come from it). */
export function volume8(c: number): number {
  return FILL_VOLUME[solidFill(c)]!;
}

// ====================================================================== 3.2 face cover

/** Quadrants (4 bits) of face dir covered by hard material. */
export function solidCover(c: number, dir: Dir): number {
  if (c < FULL_LIMIT) return SOLID[c & ID_MASK] !== 0 ? 15 : 0;
  return faceCover(materialFill(c, SOLID), dir);
}

/** Quadrants (4 bits) of face dir covered by opaque material. */
export function opaqueCover(c: number, dir: Dir): number {
  if (c < FULL_LIMIT) return OPAQUE[c & ID_MASK] !== 0 ? 15 : 0;
  return faceCover(materialFill(c, OPAQUE), dir);
}

/** The top face is fully covered by hard material (can carry a torch, flower, snow cover, helm). */
export function topCovered(c: number): boolean {
  return solidCover(c, PY) === 15;
}

/** Cells a and b (b in direction dirAtoB of a) touch: their hard covers of the shared face overlap. */
export function cellsTouch(a: number, b: number, dirAtoB: Dir): boolean {
  return (solidCover(a, dirAtoB) & solidCover(b, (dirAtoB ^ 1) as Dir)) !== 0;
}

/**
 * Light opacity of the cell's medium op(c), 0..15 (section 7.1): the largest LIGHT_OPACITY
 * below 15 among the parts; with no such part, 15 when opaque material fills all 8 octants,
 * otherwise 0 (the rest of the cell is air).
 */
export function lightOpacity(c: number): number {
  if (c < FULL_LIMIT) return LIGHT_OPACITY[c & ID_MASK]!;
  tripwire(c);
  let m = -1;
  const id1 = c & ID_MASK;
  if (id1 !== 0 && LIGHT_OPACITY[id1]! < 15) m = LIGHT_OPACITY[id1]!;
  const p2 = second(c);
  if (p2 !== 0) {
    const lo = LIGHT_OPACITY[p2 & ID_MASK]!;
    if (lo < 15 && lo > m) m = lo;
  }
  if (m >= 0) return m;
  return materialFill(c, OPAQUE) === 0xff ? 15 : 0;
}

/** Block light emitted by the cell emit(c), 0..15: the largest EMIT among its parts. */
export function lightEmit(c: number): number {
  if (c < FULL_LIMIT) return EMIT[c & ID_MASK]!;
  tripwire(c);
  const e1 = (c & ID_MASK) === 0 ? 0 : EMIT[c & ID_MASK]!;
  const p2 = second(c);
  const e2 = p2 === 0 ? 0 : EMIT[p2 & ID_MASK]!;
  return e1 > e2 ? e1 : e2;
}

/** Light can cross the face between a and b: the opaque covers of both sides together do not fill it. */
export function lightOpen(a: number, b: number, dirAtoB: Dir): boolean {
  return (opaqueCover(a, dirAtoB) | opaqueCover(b, (dirAtoB ^ 1) as Dir)) !== 15;
}

/**
 * Light the emitting parts of src shine straight into dst through their shared face (src is in
 * direction dirDstToSrc of dst), 0..15: the largest EMIT among the parts p of src whose cover
 * of the shared face reaches a quadrant dst does not cover with opaque material.
 */
export function emitInto(dst: number, src: number, dirDstToSrc: Dir): number {
  const open = ~opaqueCover(dst, dirDstToSrc) & 15;
  if (src < FULL_LIMIT) return open !== 0 ? EMIT[src & ID_MASK]! : 0;
  tripwire(src);
  const back = (dirDstToSrc ^ 1) as Dir;
  let m = 0;
  const p1 = src & PART_MASK;
  if ((p1 & ID_MASK) !== 0 && (faceCover(fillOf(p1), back) & open) !== 0) m = EMIT[p1 & ID_MASK]!;
  const p2 = second(src);
  if (p2 !== 0 && (faceCover(fillOf(p2), back) & open) !== 0) {
    const e = EMIT[p2 & ID_MASK]!;
    if (e > m) m = e;
  }
  return m;
}

// ====================================================================== 3.3 merging and splitting

export const MERGE_OK = 0;
/** The fills overlap (a target that is a hard block that cannot be cut counts as overlapping). */
export const MERGE_OVERLAP = 1;
/** The merged cell would hold more than two parts. */
export const MERGE_LIMIT = 2;

/**
 * Can `incoming` be merged into `dest`? In order: dest has no hard material (air, liquid, soft
 * block) -> MERGE_OK (whether to overwrite is the caller's decision; mergeCells returns
 * incoming); the cellFills overlap -> MERGE_OVERLAP; more than two parts -> MERGE_LIMIT;
 * otherwise MERGE_OK.
 */
export function mergeProblem(dest: number, incoming: number): 0 | 1 | 2 {
  if (solidFill(dest) === 0) {
    tripwire(incoming);
    return MERGE_OK;
  }
  if ((cellFill(dest) & cellFill(incoming)) !== 0) return MERGE_OVERLAP;
  if (partCount(dest) + partCount(incoming) > 2) return MERGE_LIMIT;
  return MERGE_OK;
}

/** The merge of incoming into dest, in canonical form. Requires mergeProblem === MERGE_OK, else RangeError. */
export function mergeCells(dest: number, incoming: number): number {
  const problem = mergeProblem(dest, incoming);
  if (problem !== MERGE_OK) throw new RangeError(`cannot merge ${incoming} into ${dest}: ${problem === MERGE_OVERLAP ? 'overlap' : 'more than two parts'}`);
  if (solidFill(dest) === 0) return incoming;
  // At most two of these four are non-zero (mergeProblem checked the part count).
  const d1 = (dest & ID_MASK) === 0 ? 0 : dest & PART_MASK;
  const d2 = second(dest);
  const i1 = (incoming & ID_MASK) === 0 ? 0 : incoming & PART_MASK;
  const i2 = second(incoming);
  let a = 0;
  let b = 0;
  for (const p of [d1, d2, i1, i2]) {
    if (p === 0) continue;
    if (a === 0) a = p;
    else b = p;
  }
  return canonCell(a, b);
}

/** RangeError unless `p` is 0 or a valid lone part value (I1-I3 for one part). */
function checkPart(p: number): void {
  if (!Number.isInteger(p) || p < 0 || p >= PART_LIMIT) throw new RangeError(`not a part value: ${p}`);
  if (p === 0) return;
  if ((p & ID_MASK) === 0) throw new RangeError(`part ${p} has id 0`);
  const holes = (p >>> HOLES_SHIFT) & HOLES_MASK;
  if (holes === 0xff) throw new RangeError(`part ${p} fills no octant`);
  if (holes !== 0 && CUTTABLE[p & ID_MASK] === 0) throw new RangeError(`part ${p} has holes but block ${p & ID_MASK} cannot be cut`);
}

/**
 * The canonical packed cell made of at most two part values (either may be 0). The first part
 * is the one containing the lowest occupied octant (I6). Throws RangeError when the parts
 * overlap, a part has holes on a material that cannot be cut, or a value is not a part.
 */
export function canonCell(partA: number, partB: number): number {
  checkPart(partA);
  checkPart(partB);
  if (partA === 0) return partB;
  if (partB === 0) return partA;
  const fa = fillOf(partA);
  const fb = fillOf(partB);
  if ((fa & fb) !== 0) throw new RangeError(`parts ${partA} and ${partB} overlap`);
  // Disjoint and both non-empty, so both have holes and (checkPart) both are cuttable.
  const aFirst = (fa & -fa) < (fb & -fb);
  const first = aFirst ? partA : partB;
  const last = aFirst ? partB : partA;
  return (first | CELL_MULTI_BIT) + last * PACK_SCALE;
}

/**
 * Carve one octant out of the cell. The part losing its last octant is removed (the other part
 * then becomes the first). An empty octant leaves the cell unchanged. Throws RangeError when
 * the octant belongs to a block that cannot be cut.
 */
export function withoutOctant(c: number, octant: number): number {
  checkOctant(octant);
  const p = partAt(c, octant);
  if (p === 0) return c;
  // A carved part of a block that cannot be cut is refused by canonCell (holes on an uncuttable material).
  const holes = ((p >>> HOLES_SHIFT) & HOLES_MASK) | (1 << octant);
  const kept = holes === 0xff ? 0 : (p & ~(HOLES_MASK << HOLES_SHIFT)) | (holes << HOLES_SHIFT);
  return canonCell(kept, otherPart(c, octant));
}

/**
 * Remove the part containing this octant; the remaining part becomes the first, and a cell
 * without parts is AIR (a full single-part block becomes AIR). An empty octant leaves the cell
 * unchanged.
 */
export function withoutPartAt(c: number, octant: number): number {
  checkOctant(octant);
  if (partAt(c, octant) === 0) return c;
  return otherPart(c, octant);
}

/**
 * Give the part containing partOctant the octant `octant` back. Requires the octant to be empty
 * in the whole cell and partOctant to hold a part, else RangeError. A part filled back to 8
 * octants is a full block (holes 0).
 */
export function withOctant(c: number, partOctant: number, octant: number): number {
  checkOctant(partOctant);
  checkOctant(octant);
  if (partAt(c, octant) !== 0) throw new RangeError(`octant ${octant} of cell ${c} is not empty`);
  const p = partAt(c, partOctant);
  if (p === 0) throw new RangeError(`octant ${partOctant} of cell ${c} holds no part`);
  const holes = ((p >>> HOLES_SHIFT) & HOLES_MASK) & ~(1 << octant);
  return canonCell((p & ~(HOLES_MASK << HOLES_SHIFT)) | (holes << HOLES_SHIFT), otherPart(c, partOctant));
}

// ====================================================================== 3.4 validation

/** Problem with one part value of a non-empty cell (I1-I3, registered id), or null. */
function partProblem(p: number, which: string): string | null {
  const id = p & ID_MASK;
  if (id === 0) return `${which} part has id 0`;
  if (BLOCKS[id] === undefined) return `${which} part has unknown block id ${id}`;
  if (id === UNLOADED_ID) return `${which} part is the unloaded reading (id ${id})`;
  const holes = (p >>> HOLES_SHIFT) & HOLES_MASK;
  if (holes === 0xff) return `${which} part fills no octant`;
  if (holes !== 0 && CUTTABLE[id] === 0) return `${which} part has holes but block ${id} cannot be cut`;
  return null;
}

/**
 * Null when c is a valid packed cell, otherwise an English reason for the logs. Never throws
 * (the tripwire value is reported as a reason). Checks: a non-negative integer below 2^49; the
 * invariants I1-I6 of section 1.3 (id 0 only for the value 0; no part without octants; holes
 * only on cuttable materials; CELL_MULTI_BIT exactly when there is a second part, whose id is
 * not 0; two parts both cuttable, both with holes, disjoint; the first part holds the lowest
 * occupied octant); both ids registered; no part is B.UNLOADED (what getCell answers for a
 * position that is not loaded: a reading, never a content). State bits are not checked (as
 * before M2.3).
 */
export function cellProblem(c: number): string | null {
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c >= PACK_SCALE * PART_LIMIT) return `not a cell value: ${c}`;
  if (c < FULL_LIMIT) {
    const id = c & ID_MASK;
    if (id === 0) return c === 0 ? null : `id 0 with state bits (${c})`;
    if (BLOCKS[id] === undefined) return `unknown block id ${id}`;
    return id === UNLOADED_ID ? `the unloaded reading (id ${id}) is never a content` : null;
  }
  const cell = c % PACK_SCALE;
  const p2 = Math.floor(c / PACK_SCALE);
  const multi = cell >= CELL_MULTI_BIT;
  if (multi && p2 === 0) return `CELL_MULTI_BIT without a second part (${c})`;
  if (!multi && p2 !== 0) return `second part without CELL_MULTI_BIT (${c})`;
  const p1 = cell & PART_MASK;
  if ((p1 & ID_MASK) === 0) return `id 0 in a non-empty value (${c})`;
  const first = partProblem(p1, 'first');
  if (first !== null) return first;
  if (p2 === 0) return null;
  const last = partProblem(p2, 'second');
  if (last !== null) return last;
  const f1 = fillOf(p1);
  const f2 = fillOf(p2);
  if (f1 === 0xff || f2 === 0xff) return `a full part in a two-part cell (${c})`;
  if ((f1 & f2) !== 0) return `the two parts overlap (${c})`;
  if ((f2 & -f2) < (f1 & -f1)) return `parts out of order: the second part holds the lowest occupied octant (${c})`;
  return null;
}
