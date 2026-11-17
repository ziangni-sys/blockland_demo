import { describe, expect, it } from 'vitest';
import { facingState, liquidState, makeCell } from '../../src/blocks/cell';
import { B, CELL_UNLOADED } from '../../src/blocks/defs';
import { ROTOR_MAX_CELLS, SHIP_MAX_CELLS } from '../../src/core/constants';
import { DIR_X, DIR_Y, DIR_Z, NX, NY, NZ, PX, PY, PZ, opposite, type Dir } from '../../src/core/dirs';
import { CellSet, collectRotor, collectShip, type CollectResult } from '../../src/structures/collect';
import { GlueStore } from '../../src/structures/glue';
import { Chunk } from '../../src/voxel/chunk';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { HARNESSES, c, cellKeys, keysOfBox, type Harness } from './harness';

const facing = (id: number, d: Dir): number => makeCell(id, facingState(d));
const HELM_N = facing(B.HELM, NZ);

function expectCells(h: Harness, r: CollectResult, want: Iterable<string>): void {
  const wantSet = new Set(want);
  const got = cellKeys(h, r.cells, r.count);
  expect(r.cells.length).toBe(r.count * 3);
  expect(got.size).toBe(r.count); // no duplicates
  expect([...got].sort()).toEqual([...wantSet].sort());
}

function startIs(h: Harness, r: CollectResult, x: number, y: number, z: number): void {
  expect(h.relKey(r.cells[0]!, r.cells[1]!, r.cells[2]!)).toBe(`${x},${y},${z}`);
}

/**
 * Acceptance 6 scene: a 5x4 plank raft (two wood kinds) floating on water with a helm on it,
 * pressed against a rubble pier that also reaches under the raft's east edge, a torch on the
 * pier and a lone helm standing on the pier.
 */
function raftScene(h: Harness): string[] {
  h.fill(-2, -2, -2, 9, -1, 5, c(B.WATER, liquidState(0, false)));
  h.fill(0, 0, 0, 4, 0, 3, c(B.PLANKS_OAK));
  h.set(2, 0, 1, c(B.PLANKS_PINE));
  h.set(3, 0, 3, c(B.PLANKS_PINE));
  h.set(2, 1, 1, HELM_N);
  // Pier: x 5..8 at deck level and below, plus a ledge under the raft (x 3..4, y -1).
  h.fill(5, -2, -1, 8, 0, 4, c(B.COBBLE));
  h.fill(3, -1, 0, 4, -1, 3, c(B.COBBLE));
  h.set(5, 1, 0, c(B.TORCH));
  return [...keysOfBox(0, 0, 0, 4, 0, 3), '2,1,1'];
}

/** Windmill for a bearing at the origin facing f: planks behind, canvas hub + four 2-long arms. */
function windmill(h: Harness, f: Dir): { cells: string[]; u: Dir; v: Dir } {
  const axis = f >> 1;
  const u = ((((axis + 1) % 3) << 1) as Dir);
  const v = ((((axis + 2) % 3) << 1) as Dir);
  const at = (base: [number, number, number], d: Dir, k: number): [number, number, number] => [
    base[0] + DIR_X[d]! * k,
    base[1] + DIR_Y[d]! * k,
    base[2] + DIR_Z[d]! * k,
  ];
  h.set(0, 0, 0, facing(B.BEARING, f));
  h.set(...at([0, 0, 0], opposite(f), 1), c(B.PLANKS_OAK));
  const hub = at([0, 0, 0], f, 1);
  const cells: string[] = [];
  const put = (p: [number, number, number]): void => {
    h.set(p[0], p[1], p[2], c(B.CANVAS));
    cells.push(p.join(','));
  };
  put(hub);
  for (const d of [u, opposite(u), v, opposite(v)]) for (let k = 1; k <= 2; k++) put(at(hub, d, k));
  return { cells, u, v };
}

for (const make of HARNESSES) {
  const name = make().name;

  describe(`collectShip on a ${name}`, () => {
    it('acceptance 6: takes exactly the raft and its helm, not the pier pressed against it', () => {
      const h = make();
      const want = raftScene(h);
      const r = collectShip(h.grid, h.glue, ...h.abs(2, 1, 1));
      expect(r.ok).toBe(true);
      expect(r.reason).toBe('ok');
      expect(r.count).toBe(21);
      expect(r.sails).toBe(0);
      expectCells(h, r, want);
      startIs(h, r, 2, 1, 1);
      expect(r.bounds).toEqual({
        minX: h.ox, minY: h.oy, minZ: h.oz, maxX: h.ox + 5, maxY: h.oy + 2, maxZ: h.oz + 4,
      });
    });

    it('a helm standing directly on the pier takes that one rubble block and nothing else', () => {
      const h = make();
      raftScene(h);
      h.set(6, 1, 2, facing(B.HELM, PX));
      const r = collectShip(h.grid, h.glue, ...h.abs(6, 1, 2));
      expect(r.ok).toBe(true);
      expectCells(h, r, ['6,1,2', '6,0,2']);
      startIs(h, r, 6, 1, 2);
      expect(h.relKey(r.cells[3]!, r.cells[4]!, r.cells[5]!)).toBe('6,0,2'); // BFS order
    });

    it('glue joins arbitrary hard blocks, one face at a time', () => {
      const h = make();
      const want = raftScene(h);
      h.glueFace(4, 0, 1, PX); // raft -> pier block (5,0,1)
      let r = collectShip(h.grid, h.glue, ...h.abs(2, 1, 1));
      expectCells(h, r, [...want, '5,0,1']);
      h.glueFace(6, 0, 1, NX); // that block -> its neighbour, glued from the far side
      h.glueFace(3, -1, 2, PY); // ledge under the raft -> raft
      r = collectShip(h.grid, h.glue, ...h.abs(2, 1, 1));
      expectCells(h, r, [...want, '5,0,1', '6,0,1', '3,-1,2']);
      // Removing the block's glue (as the world does when it is mined) detaches it again.
      h.glue.removeAllAt(...h.abs(5, 0, 1));
      r = collectShip(h.grid, h.glue, ...h.abs(2, 1, 1));
      expectCells(h, r, [...want, '3,-1,2']);
    });

    it('functional blocks come along through their mounting faces; a stopped windmill only when glued', () => {
      const h = make();
      const want = raftScene(h);
      h.set(0, 1, 0, c(B.TORCH)); // on the deck
      h.set(1, 1, 3, HELM_N); // second helm on the deck
      h.set(-1, 0, 1, facing(B.PROPELLER, NX)); // back (+X) on the hull side
      h.set(-1, 0, 3, HELM_N); // helm next to the hull, standing on water: not attached
      h.set(-1, 1, 0, facing(B.PROPELLER, PX)); // back (-X) towards air: not attached
      h.fill(4, 1, 3, 4, 3, 3, c(B.PLANKS_PINE)); // mast
      h.set(4, 2, 2, facing(B.BEARING, NZ)); // back (+Z) on the mast
      const mill = ['4,2,1', '3,2,1', '5,2,1', '4,3,1', '4,1,1'];
      for (const k of mill) {
        const [x, y, z] = k.split(',').map(Number) as [number, number, number];
        h.set(x, y, z, c(B.CANVAS));
      }
      const ship = [...want, '0,1,0', '1,1,3', '-1,0,1', '4,1,3', '4,2,3', '4,3,3', '4,2,2'];
      let r = collectShip(h.grid, h.glue, ...h.abs(2, 1, 1));
      expect(r.ok).toBe(true);
      expectCells(h, r, ship);
      expect(r.sails).toBe(0);
      h.glueFace(4, 2, 2, NZ); // bearing <-> hub
      r = collectShip(h.grid, h.glue, ...h.abs(2, 1, 1));
      expectCells(h, r, [...ship, ...mill]);
      expect(r.sails).toBe(5);
    });

    it('rejects a start cell that is not a helm', () => {
      const h = make();
      raftScene(h);
      for (const p of [[0, 0, 0], [5, 1, 0], [20, 20, 20]] as Array<[number, number, number]>) {
        const r = collectShip(h.grid, h.glue, ...h.abs(...p));
        expect(r).toEqual({ ok: false, reason: 'not_a_helm', cells: new Int32Array(0), count: 0, sails: 0, bounds: null });
      }
    });

    it('enforces the size limit: more than maxCells is too_big', () => {
      const h = make();
      h.fill(0, 0, 0, 29, 0, 0, c(B.PLANKS_OAK));
      h.set(0, 1, 0, HELM_N);
      let r = collectShip(h.grid, h.glue, ...h.abs(0, 1, 0), 31);
      expect(r.ok).toBe(true);
      expect(r.count).toBe(31);
      r = collectShip(h.grid, h.glue, ...h.abs(0, 1, 0), 30);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('too_big');
      expect(r.count).toBe(31); // stopped at the first cell over the limit
      r = collectShip(h.grid, h.glue, ...h.abs(0, 1, 0), 20);
      expect(r.reason).toBe('too_big');
      expect(r.count).toBe(21);
      expect(r.cells.length).toBe(63);
      startIs(h, r, 0, 1, 0);
      expect(r.bounds).toEqual({ minX: h.ox, minY: h.oy, minZ: h.oz, maxX: h.ox + 20, maxY: h.oy + 2, maxZ: h.oz + 1 });
      r = collectShip(h.grid, h.glue, ...h.abs(0, 1, 0), 0);
      expect(r.reason).toBe('too_big');
      expect(r.count).toBe(1);
      expect(() => collectShip(h.grid, h.glue, ...h.abs(0, 1, 0), Number.NaN)).toThrow(RangeError);
      expect(() => collectShip(h.grid, h.glue, ...h.abs(0, 1, 0), -1)).toThrow(RangeError);
      expect(collectShip(h.grid, h.glue, ...h.abs(0, 1, 0), Infinity).count).toBe(31);
    });

    it(`default limit is ${SHIP_MAX_CELLS} cells`, () => {
      const h = make();
      h.fill(0, 0, 0, 62, 0, 62, c(B.PLANKS_OAK)); // 3969
      h.fill(0, 0, 63, 29, 0, 63, c(B.PLANKS_PINE)); // +30 = 3999
      h.set(10, 1, 10, HELM_N);
      let r = collectShip(h.grid, h.glue, ...h.abs(10, 1, 10));
      expect(r.ok).toBe(true);
      expect(r.count).toBe(SHIP_MAX_CELLS);
      h.set(30, 0, 63, c(B.PLANKS_PINE));
      r = collectShip(h.grid, h.glue, ...h.abs(10, 1, 10));
      expect(r.reason).toBe('too_big');
      expect(r.count).toBe(SHIP_MAX_CELLS + 1);
    });

    it('is deterministic and pure (modifies neither grid nor glue)', () => {
      const h = make();
      raftScene(h);
      h.glueFace(4, 0, 1, PX);
      const glueBefore = h.glue.toArray();
      const g = h.grid;
      const snapshot = (): string => {
        if (g instanceof World) {
          g.takeDirtySections();
          return [...g.chunks.values()].map((ch) => ch.cells.join(',')).join('|');
        }
        const s = g as StructureGrid;
        return `${s.version}:${s.cells.join(',')}`;
      };
      const before = snapshot();
      const a = collectShip(g, h.glue, ...h.abs(2, 1, 1));
      const b = collectShip(g, h.glue, ...h.abs(2, 1, 1));
      collectRotor(g, h.glue, ...h.abs(2, 0, 1));
      expect(b.cells).toEqual(a.cells);
      expect(snapshot()).toBe(before);
      if (g instanceof World) expect(g.takeDirtySections()).toEqual([]);
      expect(h.glue.toArray()).toEqual(glueBefore);
    });
  });

  describe(`collectRotor on a ${name}`, () => {
    for (const f of [PX, NX, PY, NY, PZ, NZ] as Dir[]) {
      it(`assembles a windmill in front of a bearing facing dir ${f}`, () => {
        const h = make();
        const { cells } = windmill(h, f);
        const r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
        expect(r.ok).toBe(true);
        expect(r.reason).toBe('ok');
        expect(r.count).toBe(9);
        expect(r.sails).toBe(9);
        expectCells(h, r, cells);
        startIs(h, r, DIR_X[f]!, DIR_Y[f]!, DIR_Z[f]!); // the hub
      });
    }

    it('takes only cells strictly in front of the bearing plane, even when glued', () => {
      const h = make();
      const { cells } = windmill(h, PZ); // plane z = 0, rotor at z = 1
      h.set(1, 0, 0, c(B.CANVAS)); // touches arm (1,0,1) but lies in the plane
      h.set(2, 0, 0, c(B.CANVAS));
      h.set(2, 0, -1, c(B.CANVAS)); // behind the plane
      h.glueFace(2, 0, 1, NZ); // arm -> plane cell
      h.glueFace(2, 0, 0, NZ);
      h.glueFace(0, 0, 1, NZ); // hub <-> bearing
      let r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
      expect(r.ok).toBe(true);
      expectCells(h, r, cells);
      h.set(1, 0, 2, c(B.WOOL_RED)); // in front: joins
      r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
      expectCells(h, r, [...cells, '1,0,2']);
      expect(r.sails).toBe(10);
    });

    it('never includes functional blocks, and they stop the fill', () => {
      const h = make();
      const { cells } = windmill(h, PZ);
      h.set(0, 3, 1, HELM_N); // standing on the top arm
      h.set(3, 0, 1, facing(B.PROPELLER, PX)); // back on the east arm
      h.set(4, 0, 1, c(B.CANVAS)); // only reachable through the propeller...
      h.glueFace(3, 0, 1, PX); // ...even glued to it
      h.set(0, -3, 1, facing(B.BEARING, NY)); // back on the bottom arm
      h.set(0, -4, 1, c(B.CANVAS)); // its own hub
      h.set(-3, 0, 1, c(B.TORCH)); // a torch is not functional, but it needs a block below: not attached
      h.set(-2, 1, 1, c(B.TORCH)); // standing on the west arm: attached
      const r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
      expect(r.ok).toBe(true);
      expectCells(h, r, [...cells, '-2,1,1']);
    });

    it('reports not_a_bearing and no_hub', () => {
      const h = make();
      windmill(h, PZ);
      for (const p of [[0, 0, 1], [0, 0, -1], [5, 5, 5]] as Array<[number, number, number]>) {
        expect(collectRotor(h.grid, h.glue, ...h.abs(...p)).reason).toBe('not_a_bearing');
      }
      h.set(0, 5, 1, HELM_N);
      expect(collectRotor(h.grid, h.glue, ...h.abs(0, 5, 1)).reason).toBe('not_a_bearing');
      const hubs = [c(B.AIR), c(B.WATER), c(B.LAVA), c(B.DEEPROCK), HELM_N, facing(B.BEARING, PZ), facing(B.PROPELLER, PZ)];
      for (const hub of hubs) {
        h.set(0, 0, 1, hub);
        const r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
        expect(r.ok).toBe(false);
        expect(r.reason, `hub ${hub}`).toBe('no_hub');
        expect(r.count).toBe(0);
        expect(r.bounds).toBeNull();
      }
    });

    it('requires enough sails; reports the whole rotor when it has too few', () => {
      const h = make();
      h.set(0, 0, 0, facing(B.BEARING, PY));
      h.set(0, -1, 0, c(B.COBBLE));
      h.fill(-2, 1, 0, 2, 1, 0, c(B.PLANKS_OAK)); // hub (0,1,0) + 4 planks
      const wool = [[-2, 2, 0], [2, 2, 0], [-1, 2, 0]] as const;
      for (const [x, y, z] of wool) {
        h.set(x, y, z, c(B.WOOL_YELLOW));
        h.glueFace(x, y, z, NY);
      }
      let r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('not_enough_sails');
      expect(r.sails).toBe(3);
      expect(r.count).toBe(8);
      startIs(h, r, 0, 1, 0);
      expect(collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0), ROTOR_MAX_CELLS, 3).ok).toBe(true);
      h.set(1, 2, 0, c(B.CANVAS)); // sticks to the felt at (2,2,0): no glue needed
      r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
      expect(r.ok).toBe(true);
      expect(r.sails).toBe(4);
      expect(r.count).toBe(9);
    });

    it(`enforces the rotor size limit (${ROTOR_MAX_CELLS} by default)`, () => {
      const h = make();
      h.set(0, 0, 0, facing(B.BEARING, PZ));
      h.fill(-10, -10, 1, 10, 9, 1, c(B.CANVAS)); // 21 x 20 = 420 cells including the hub
      let r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('too_big');
      expect(r.count).toBe(ROTOR_MAX_CELLS + 1);
      r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0), 420);
      expect(r.ok).toBe(true);
      expect(r.count).toBe(420);
      expect(r.sails).toBe(420);
      expect(r.bounds).toEqual({ minX: h.ox - 10, minY: h.oy - 10, minZ: h.oz + 1, maxX: h.ox + 11, maxY: h.oy + 10, maxZ: h.oz + 2 });
      r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0), 419);
      expect(r.reason).toBe('too_big');
    });
  });
}

describe('collect: world edges', () => {
  function world(): World {
    const w = new World(4);
    w.addChunk(new Chunk(0, 0));
    return w;
  }
  it('a helm on the bottom layer stands on deeprock and takes nothing with it', () => {
    const w = world();
    w.setCell(3, 0, 3, HELM_N);
    const r = collectShip(w, new GlueStore(), 3, 0, 3);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
  });
  it('the fill stops at unloaded chunks', () => {
    const w = world();
    for (let x = 0; x < 16; x++) w.setCell(x, 40, 8, c(B.PLANKS_OAK));
    w.setCell(15, 41, 8, HELM_N);
    expect(w.getCell(16, 40, 8)).toBe(CELL_UNLOADED);
    const r = collectShip(w, new GlueStore(), 15, 41, 8);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(17);
    expect(r.bounds).toEqual({ minX: 0, minY: 40, minZ: 8, maxX: 16, maxY: 42, maxZ: 9 });
  });
  it('a rotor can be collected inside a ship grid nested in the world (negative local coords)', () => {
    const ship = new StructureGrid(3, new World(5));
    ship.setCell(-100, -50, -100, facing(B.BEARING, NX));
    ship.setCell(-99, -50, -100, c(B.PLANKS_OAK));
    for (let y = -52; y <= -48; y++) ship.setCell(-101, y, -100, c(B.WOOL_BLUE));
    const r = collectRotor(ship, new GlueStore(), -100, -50, -100);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(5);
    expect(Array.from(r.cells.slice(0, 3))).toEqual([-101, -50, -100]);
  });
});

describe('CellSet', () => {
  it('stores any int32 triple exactly, negatives included, and grows', () => {
    const s = new CellSet(1);
    const pts: Array<[number, number, number]> = [];
    for (let i = -40; i < 40; i++) pts.push([i, -i * 3, i * 7], [i * 1000003, 2147483647 - (i + 40), -2147483648 + i * i]);
    for (const p of pts) expect(s.add(...p)).toBe(true);
    for (const p of pts) expect(s.add(...p)).toBe(false);
    expect(s.size).toBe(pts.length);
    for (const p of pts) expect(s.has(...p)).toBe(true);
    expect(s.has(0, 0, 1)).toBe(false);
    expect(s.has(1, -3, 8)).toBe(false);
    s.clear();
    expect(s.size).toBe(0);
    for (const p of pts) expect(s.has(...p)).toBe(false);
  });
  it('fromCells builds the membership test for a collect result', () => {
    const h = HARNESSES[1]!();
    raftScene(h);
    const r = collectShip(h.grid, h.glue, ...h.abs(2, 1, 1));
    const set = CellSet.fromCells(r.cells);
    expect(set.size).toBe(r.count);
    expect(set.has(...h.abs(0, 0, 0))).toBe(true);
    expect(set.has(...h.abs(5, 0, 0))).toBe(false);
    expect(CellSet.fromCells(r.cells, 1).size).toBe(1);
  });
});

describe('collect: performance', () => {
  function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1]!;
  }
  it('a 4000-cell ship and a 400-cell rotor take a few milliseconds', () => {
    const w = new World(6);
    for (let cx = -1; cx <= 4; cx++) for (let cz = -1; cz <= 4; cz++) w.addChunk(new Chunk(cx, cz));
    // Plank raft: every connection is an auto-stick.
    for (let x = 0; x < 63; x++) for (let z = 0; z < 63; z++) w.setCell(x, 50, z, c(B.PLANKS_OAK));
    for (let x = 0; x < 30; x++) w.setCell(x, 50, 63, c(B.PLANKS_PINE));
    w.setCell(30, 51, 30, HELM_N);
    // Rubble raft: every connection goes through the glue store (worst case for lookups).
    const glue = new GlueStore();
    const inRaft = (x: number, z: number): boolean => x >= 0 && z >= 0 && ((z < 63 && x < 63) || (z === 63 && x < 30));
    for (let x = 0; x < 63; x++) for (let z = 0; z < 64; z++) if (inRaft(x, z)) w.setCell(x, 30, z, c(B.COBBLE));
    for (let x = 0; x < 63; x++) {
      for (let z = 0; z < 64; z++) {
        if (!inRaft(x, z)) continue;
        if (inRaft(x + 1, z)) glue.add(x, 30, z, PX);
        if (inRaft(x, z + 1)) glue.add(x, 30, z, PZ);
      }
    }
    w.setCell(30, 31, 30, HELM_N);
    // A dense 16^3 block exercises the "neighbour already visited" path.
    const g = new StructureGrid(9, w);
    for (let x = -8; x < 8; x++) for (let y = -8; y < 8; y++) for (let z = -8; z < 8; z++) g.setCell(x, y, z, c(B.PLANKS_OAK));
    g.setCell(0, 8, 0, HELM_N);
    // Rotor: 20 x 20 sheet in front of a bearing.
    w.setCell(20, 60, 20, facing(B.BEARING, PZ));
    for (let x = 10; x < 30; x++) for (let y = 51; y < 71; y++) w.setCell(x, y, 21, c(B.CANVAS));

    const ship: number[] = [];
    const glued: number[] = [];
    const dense: number[] = [];
    const rotor: number[] = [];
    for (let i = 0; i < 25; i++) {
      let t = performance.now();
      const r = collectShip(w, glue, 30, 51, 30);
      ship.push(performance.now() - t);
      expect(r.count).toBe(4000);
      t = performance.now();
      const rg = collectShip(w, glue, 30, 31, 30);
      glued.push(performance.now() - t);
      expect(rg.count).toBe(4000);
      t = performance.now();
      const d = collectShip(g, glue, 0, 8, 0, Infinity);
      dense.push(performance.now() - t);
      expect(d.count).toBe(4097);
      t = performance.now();
      const ro = collectRotor(w, glue, 20, 60, 20, 400, 4);
      rotor.push(performance.now() - t);
      expect(ro.reason).toBe('ok');
      expect(ro.count).toBe(400);
    }
    const ms = { ship4000: median(ship), gluedShip4000: median(glued), dense4097: median(dense), rotor400: median(rotor) };
    console.log(`[collect perf] median ms: ${JSON.stringify(ms)}`);
    expect(ms.ship4000).toBeLessThan(25);
    expect(ms.gluedShip4000).toBeLessThan(25);
    expect(ms.dense4097).toBeLessThan(25);
    expect(ms.rotor400).toBeLessThan(5);
  });
});
