/**
 * Every structure path that copies cells keeps holes and second parts (docs/SHAPES.md 4.5):
 * collecting and assembling a ship (collect.ts FillQueue, assembly.ts transferCells), docking it
 * back with a rotation (gridCells, rotCell, commitDock), stopping a rotor (blockifyGrid), and the
 * structure save (serialize.ts: sparse runs of Cells). The semantics (what touches what, merging)
 * belong to later packages; here a part with holes, a two-part cell and a two-part cell that fills
 * its cell must come out exactly as they went in (rotated where the structure rotated).
 */
import { describe, expect, it, vi } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, rotatePacked } from '../../src/blocks/shapes';
import { STRUCTURE_MAX_BOX_CELLS } from '../../src/core/constants';
import { qfromYaw, qrotate, vec3, vsub } from '../../src/core/math';
import { applyRotorPose } from '../../src/structures/rotor';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';
import { writeCell } from '../../src/save/cells';
import { rotCell, type GridRot } from '../../src/structures/orient';
import { STRUCTURES_FORMAT } from '../../src/structures/serialize';
import type { Rotor, Ship } from '../../src/structures/structure';
import { getPacked } from '../../src/voxel/parts';
import { StructureGrid } from '../../src/voxel/sgrid';
import { EAST, LOWER, slab, UPPER, WEST } from '../shapes';
import { c, cellMap, facing, fill, MILL_BEARING, millShip, rotY, scene, SHIP_HELM, type Scene } from './helpers';

const [HX, HY, HZ] = SHIP_HELM;
const [BX, BY, BZ] = MILL_BEARING;

/** Oak planks slab: its faces overlap the oak deck's, so it auto-sticks like a full plank. */
const SLAB = slab(B.PLANKS_OAK, LOWER);
const TWO = canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST));
const FILLED = canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_OAK, UPPER));
/** The rotation of k quarter yaw turns (+X -> -Z for k = 1, as rotY). */
function yawRot(k: number): GridRot {
  const rots: GridRot[] = [
    { ax: 0, ay: 2, az: 4 },
    { ax: 5, ay: 2, az: 0 },
    { ax: 1, ay: 2, az: 5 },
    { ax: 4, ay: 2, az: 1 },
  ];
  return rots[((k % 4) + 4) % 4]!;
}

/** The millShip with three partial cells on its deck (y = 61). */
function partialShip(s: Scene): Ship {
  millShip(s.world, s.host.worldGlue);
  s.world.setCell(-2, 61, 1, SLAB);
  s.world.setCell(-1, 61, 1, TWO);
  s.world.setCell(1, 61, 1, FILLED);
  const r = s.mgr.assembleShip(HX, HY, HZ);
  if (!r.ok) throw new Error(r.reason);
  return r.structure;
}

function poseExact(ship: Ship, k: number, h: { x: number; y: number; z: number }): void {
  const q = qfromYaw(k * (Math.PI / 2));
  const off = qrotate(q, vsub(vec3(ship.helmX + 0.5, ship.helmY + 0.5, ship.helmZ + 0.5), ship.grid.pivot));
  ship.grid.setPoseImmediate(vec3(h.x + 0.5 - off.x, h.y + 0.5 - off.y, h.z + 0.5 - off.z), q);
}

describe('assembly and docking carry both parts', () => {
  it('assembling moves a part with holes, a two-part cell and a filled two-part cell into the ship unchanged', () => {
    const s = scene();
    const ship = partialShip(s);
    expect([getPacked(ship.grid, -2, 61, 1), getPacked(ship.grid, -1, 61, 1), getPacked(ship.grid, 1, 61, 1)]).toEqual([SLAB, TWO, FILLED]);
    // ... and the world cells are cleared (all three layers).
    expect([getPacked(s.world, -2, 61, 1), getPacked(s.world, -1, 61, 1), getPacked(s.world, 1, 61, 1)]).toEqual([0, 0, 0]);
  });

  for (const k of [0, 1, 2, 3]) {
    it(`docking at yaw ${k * 90} puts them back rotated (rotCell = rotatePacked), the second part included`, () => {
      const s = scene();
      const ship = partialShip(s);
      const target = { x: 9, y: 62, z: -6 };
      poseExact(ship, k, target);
      expect(s.mgr.dockShip(ship).ok).toBe(true);
      const r = yawRot(k);
      for (const [[x, z], packed] of [[[-2, 1], SLAB], [[-1, 1], TWO], [[1, 1], FILLED]] as const) {
        const [rx, rz] = rotY(x - HX, z - HZ, k);
        const got = getPacked(s.world, target.x + rx, target.y + 61 - HY, target.z + rz);
        expect(got, `${x},${z}`).toBe(rotCell(r, packed));
        expect(got).toBe(rotatePacked(packed, r.ax, r.ay, r.az));
      }
      // A quarter turn swaps which half of the west/east cell is first: the result is still canonical.
      if (k % 2 === 1) expect(rotCell(r, TWO)).not.toBe(TWO);
    });
  }

  it('rotCell leaves full blocks as they were and rotates a log\'s axis exactly as before', () => {
    const r = yawRot(1);
    expect(rotCell(r, makeCell(B.STONE))).toBe(makeCell(B.STONE));
    expect(rotCell(r, makeCell(B.LOG_OAK, 0))).toBe(makeCell(B.LOG_OAK, 2));
    expect(rotCell(r, facing(B.HELM, 5))).toBe(facing(B.HELM, 1)); // north (-Z) turns to west (-X)
  });
});

describe('stopping a rotor carries both parts', () => {
  it('a two-part cell and a holed cell on the windmill come back into the world rotated with it', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue);
    // Arms are wool (cuttable): replace one cell of each of two arms by partial ones.
    const holed = slab(B.WOOL_RED, 0x3f);
    const two = canonCell(slab(B.WOOL_WHITE, LOWER), slab(B.WOOL_BLUE, UPPER));
    s.world.setCell(BX + 1, BY, BZ + 1, holed);
    s.world.setCell(BX, BY + 1, BZ + 1, two);
    const rr = s.mgr.startRotor(s.world, BX, BY, BZ);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor: Rotor = rr.structure;
    expect(getPacked(rotor.grid, BX + 1, BY, BZ + 1)).toBe(holed);
    expect(getPacked(rotor.grid, BX, BY + 1, BZ + 1)).toBe(two);
    // A quarter turn about +Z (the bearing faces +Z): (x, y) -> (-y, x) relative to the bearing.
    rotor.angle = Math.PI / 2;
    applyRotorPose(rotor);
    s.mgr.stopRotor(rotor);
    const r: GridRot = { ax: 2, ay: 1, az: 4 }; // +X -> +Y, +Y -> -X
    expect(getPacked(s.world, BX, BY + 1, BZ + 1)).toBe(rotCell(r, holed));
    expect(getPacked(s.world, BX - 1, BY, BZ + 1)).toBe(rotCell(r, two));
  });
});

describe('structure save: sparse runs of Cells', () => {
  function save(s: Scene): Uint8Array {
    const w = new ByteWriter();
    s.mgr.serialize(w);
    return w.finish();
  }

  it('round-trips parts with holes and two-part cells, nesting and all', () => {
    const s = scene();
    const ship = partialShip(s);
    ship.grid.setCell(3, 61, -2, canonCell(slab(B.STONE, 0x01), slab(B.GLASS, 0x80)));
    const before = cellMap(ship.grid);
    const bytes = save(s);
    const b = scene();
    b.mgr.deserialize(new ByteReader(bytes, 'structures'));
    expect(cellMap(b.mgr.ships()[0]!.grid)).toEqual(before);
    expect(save(b)).toEqual(bytes);
  });

  /** A save of one ship whose cell section is written by `cells`. */
  function shipSave(cells: (w: ByteWriter) => void): Uint8Array {
    const w = new ByteWriter();
    w.u8(STRUCTURES_FORMAT).varuint(2).varuint(1);
    w.u8(0).varuint(1).varuint(0);
    cells(w);
    for (const v of [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]) w.f64(v);
    w.i32Array(new Int32Array(0));
    w.varint(0).varint(0).varint(0).u8(5).f64(0).f64(0).bool(false).varuint(0);
    return w.finish();
  }
  function section(box: number[], runs: Array<[number, number[]]>): (w: ByteWriter) => void {
    return (w) => {
      w.varint(box[0]!).varint(box[1]!).varint(box[2]!).varuint(box[3]!).varuint(box[4]!).varuint(box[5]!);
      w.varuint(runs.length);
      for (const [gap, cells] of runs) {
        w.varuint(gap).varuint(cells.length);
        for (const cell of cells) writeCell(w, cell);
      }
    };
  }

  it('a hand-written section with a two-part cell loads exactly (runs of varuint gap, varuint length, Cells)', () => {
    const s = scene();
    s.mgr.deserialize(new ByteReader(shipSave(section([5, 60, 7, 2, 1, 1], [[0, [TWO, SLAB]]]))));
    const g = s.mgr.ships()[0]!.grid;
    expect([getPacked(g, 5, 60, 7), getPacked(g, 6, 60, 7)]).toEqual([TWO, SLAB]);
  });

  it('invalid cells are refused (cellProblem), as SaveFormatError, leaving nothing behind', () => {
    const overlap = canonCell(slab(B.STONE, LOWER), slab(B.DIRT, UPPER)) + 0; // valid, then made overlapping:
    const bad: Array<[string, number]> = [
      ['overlapping parts', overlap - slab(B.DIRT, UPPER) * 2 ** 25 + slab(B.DIRT, UPPER | 0x01) * 2 ** 25],
      ['holes on a helm', slab(B.HELM, LOWER)],
      ['an unregistered id', makeCell(999)],
    ];
    for (const [why, cell] of bad) {
      const s = scene();
      expect(() => s.mgr.deserialize(new ByteReader(shipSave(section([0, 60, 0, 1, 1, 1], [[0, [cell]]])))), why).toThrow(SaveFormatError);
      expect(s.mgr.all(), why).toEqual([]);
    }
  });

  it('a box that is not the tight box of its cells is refused before any storage is allocated', () => {
    const spy = vi.spyOn(StructureGrid.prototype, 'resize');
    try {
      const s = scene();
      // A box of the largest size whose only cells sit in one corner: not tight.
      const side = Math.round(Math.cbrt(STRUCTURE_MAX_BOX_CELLS));
      expect(() => s.mgr.deserialize(new ByteReader(shipSave(section([0, 60, 0, side, side, side], [[0, [TWO, SLAB]]]))))).toThrow(/tight box/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
