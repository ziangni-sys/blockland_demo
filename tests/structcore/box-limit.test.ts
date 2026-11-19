/**
 * The structure box limit (docs/DESIGN.md 组装与方块化): the tight bounding box of a ship or a
 * rotor holds at most STRUCTURE_MAX_BOX_CELLS = 2^21 cells. Assembly and its preview refuse a
 * structure spread wider ('too_spread'), and a rotor stopping on a ship never spreads the ship's
 * box past it. The shapes are thin frames: a few hundred cells spanning about 2 million.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { STRUCTURE_MAX_BOX_CELLS } from '../../src/core/constants';
import { PX, PY } from '../../src/core/dirs';
import { collectRotor, collectShip } from '../../src/structures/collect';
import { StructureManager } from '../../src/structures/manager';
import type { CellBounds } from '../../src/voxel/grid';
import { World } from '../../src/voxel/world';
import { c, facing, FakeHost, fill, loadArea, scene, snapshotBox } from './helpers';

const P = c(B.PLANKS_OAK);
const CANVAS = c(B.CANVAS);

function volume(b: CellBounds | null): number {
  return b === null ? 0 : (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ);
}

/**
 * A world of empty chunks around a frame corner at (0,0,0): arms of `cell` along +X (lx cells),
 * +Y (ly cells, the whole build height at 128) and +Z (lz cells); every chunk a face neighbour
 * could lie in is loaded, so the frame is complete.
 */
function frameWorld(lx: number, ly: number, lz: number, cell: number): { world: World; host: FakeHost; mgr: StructureManager } {
  const world = new World(1);
  loadArea(world, -2, -2, lx + 1, lz + 1);
  fill(world, 0, 0, 0, lx - 1, 0, 0, cell);
  fill(world, 0, 0, 0, 0, ly - 1, 0, cell);
  fill(world, 0, 0, 0, 0, 0, lz - 1, cell);
  const host = new FakeHost(world);
  return { world, host, mgr: new StructureManager(host, null) };
}

/** A plank frame with a helm on the X arm at (1,1,0): its box is lx x ly x lz. */
function shipFrame(lx: number, ly: number, lz: number) {
  const s = frameWorld(lx, ly, lz, P);
  s.world.setCell(1, 1, 0, facing(B.HELM, 5));
  return s;
}

/** A canvas frame in front of a bearing at (-1,0,0) facing +X (all sails): its box is lx x ly x lz. */
function rotorFrame(lx: number, ly: number, lz: number) {
  const s = frameWorld(lx, ly, lz, CANVAS);
  s.world.setCell(-1, 0, 0, facing(B.BEARING, PX));
  return s;
}

describe('structure box limit: assembly and preview (DESIGN 组装与方块化)', () => {
  it('is 2^21 cells', () => {
    expect(STRUCTURE_MAX_BOX_CELLS).toBe(2 ** 21);
    expect(128 * 128 * 128).toBe(STRUCTURE_MAX_BOX_CELLS);
  });

  it('a ship just over the limit is refused by the preview and by the assembly, which change nothing', () => {
    const { world, mgr } = shipFrame(129, 128, 128); // 383 planks + helm, box 2 113 536 cells
    const before = snapshotBox(world, -1, 0, -1, 129, 2, 1);
    const p = mgr.previewShip(1, 1, 0);
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('too_spread');
    // The fill stopped at the first cell that took the box past the limit (it is included).
    expect(volume(p.bounds)).toBeGreaterThan(STRUCTURE_MAX_BOX_CELLS);
    expect(p.count).toBeLessThanOrEqual(384);
    const r = mgr.assembleShip(1, 1, 0);
    expect(r.ok ? 'ok' : r.reason).toBe('too_spread');
    expect(mgr.all()).toEqual([]);
    expect(snapshotBox(world, -1, 0, -1, 129, 2, 1)).toEqual(before);
    expect(world.getCell(0, 127, 0)).toBe(P);
    expect(world.getCell(0, 0, 127)).toBe(P);
  });

  it('a ship whose box is exactly the limit is previewed and assembled', () => {
    const { world, mgr } = shipFrame(128, 128, 128);
    const p = mgr.previewShip(1, 1, 0);
    expect(p.ok ? 'ok' : p.reason).toBe('ok');
    expect(p.count).toBe(128 + 127 + 127 + 1);
    expect(volume(p.bounds)).toBe(STRUCTURE_MAX_BOX_CELLS);
    const r = mgr.assembleShip(1, 1, 0);
    expect(r.ok ? 'ok' : r.reason).toBe('ok');
    if (!r.ok) return;
    expect(volume(r.structure.grid.cellBounds())).toBe(STRUCTURE_MAX_BOX_CELLS);
    expect(world.getCell(127, 0, 0)).toBe(0);
  });

  it('a rotor just over the limit is refused by the preview and by the start; exactly at the limit it starts', () => {
    const over = rotorFrame(129, 128, 128); // 383 canvas, box 2 113 536 cells
    const p = over.mgr.previewRotor(over.world, -1, 0, 0);
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('too_spread');
    const r = over.mgr.startRotor(over.world, -1, 0, 0);
    expect(r.ok ? 'ok' : r.reason).toBe('too_spread');
    expect(over.mgr.all()).toEqual([]);
    expect(over.world.getCell(128, 0, 0)).toBe(CANVAS);

    const at = rotorFrame(128, 128, 128);
    const q = at.mgr.previewRotor(at.world, -1, 0, 0);
    expect(q.ok ? 'ok' : q.reason).toBe('ok');
    expect(q.count).toBe(382);
    const s = at.mgr.startRotor(at.world, -1, 0, 0);
    expect(s.ok ? 'ok' : s.reason).toBe('ok');
    if (!s.ok) return;
    expect(volume(s.structure.grid.cellBounds())).toBe(STRUCTURE_MAX_BOX_CELLS);
  });

  it('too_big and too_spread: the limit the fill breaks first; both beat unloaded and missing sails', () => {
    const { world, host } = rotorFrame(129, 128, 128);
    // With a cell limit below the frame's size the count is broken first ...
    expect(collectRotor(world, host.worldGlue, -1, 0, 0, 100).reason).toBe('too_big');
    // ... with a box limit of a single layer the box is.
    expect(collectRotor(world, host.worldGlue, -1, 0, 0, 400, 4, 128).reason).toBe('too_spread');
    // Too few sails (10^4 required), but spread too wide: too_spread.
    expect(collectRotor(world, host.worldGlue, -1, 0, 0, 400, 1e4).reason).toBe('too_spread');
    // An unloaded neighbour does not hide the box limit either.
    const w2 = shipFrame(129, 128, 128);
    w2.world.removeChunk(-1, 0);
    expect(collectShip(w2.world, w2.host.worldGlue, 1, 1, 0).reason).toBe('too_spread');
    expect(() => collectShip(w2.world, w2.host.worldGlue, 1, 1, 0, 4000, -1)).toThrow(RangeError);
  });
});

describe('structure box limit: a rotor stopping on a ship', () => {
  /**
   * A 7 x 7 raft (x,z 0..6, y 60) with a helm, a bearing at (3,61,3) facing up and a canvas rotor
   * on it (hub glued to the bearing): hub (3,62,3), a cross of 4 at y 62 and an arm (3, 63..65, 3),
   * started on the ship once it is assembled. Then the ship is edited
   * directly (test setup) so that its tight box spans x 0..sx-1, y 60..63, z 0..1023.
   */
  function shipWithRotor(sx: number) {
    const s = scene();
    fill(s.world, 0, 60, 0, 6, 60, 6, P);
    s.world.setCell(1, 61, 1, facing(B.HELM, 5));
    s.world.setCell(3, 61, 3, facing(B.BEARING, PY));
    for (const [x, y, z] of [[3, 62, 3], [2, 62, 3], [4, 62, 3], [3, 62, 2], [3, 62, 4], [3, 63, 3], [3, 64, 3], [3, 65, 3]] as const) {
      s.world.setCell(x, y, z, CANVAS);
    }
    s.host.worldGlue.add(3, 61, 3, PY); // hub glued to the bearing: the stopped rotor comes with the ship
    const sr = s.mgr.assembleShip(1, 61, 1);
    if (!sr.ok) throw new Error(sr.reason);
    const ship = sr.structure;
    const rr = s.mgr.startRotor(ship.grid, 3, 61, 3);
    if (!rr.ok) throw new Error(rr.reason);
    ship.grid.setCell(sx - 1, 60, 0, P);
    ship.grid.setCell(0, 60, 1023, P);
    ship.grid.setCell(0, 63, 0, P);
    expect(ship.grid.cellBounds()).toEqual({ minX: 0, minY: 60, minZ: 0, maxX: sx, maxY: 64, maxZ: 1024 });
    return { ...s, ship, rotor: rr.structure };
  }

  it('cells that would spread the ship past the limit drop; the rest land and the box stays', () => {
    // Ship box 512 x 4 x 1024 = 2^21 already; the arm's top two cells (y 64, 65) would make it 6 high.
    const { mgr, host, ship, rotor } = shipWithRotor(512);
    const rep = mgr.stopRotor(rotor);
    expect(rep).toEqual({ placed: 6, dropped: 2, overwritten: 0 });
    for (const [x, y, z] of [[3, 62, 3], [2, 62, 3], [4, 62, 3], [3, 62, 2], [3, 62, 4], [3, 63, 3]] as const) {
      expect(ship.grid.getCell(x, y, z)).toBe(CANVAS);
    }
    expect(ship.grid.getCell(3, 64, 3)).toBe(0);
    expect(ship.grid.getCell(3, 65, 3)).toBe(0);
    expect(host.drops.map((d) => d.item)).toEqual([B.CANVAS, B.CANVAS]);
    expect(volume(ship.grid.cellBounds())).toBe(STRUCTURE_MAX_BOX_CELLS);
  });

  it('below the limit every cell lands, even where it grows the ship box', () => {
    // 256 x 6 x 1024 = 1 572 864 cells after the stop: within the limit.
    const { mgr, host, ship, rotor } = shipWithRotor(256);
    expect(mgr.stopRotor(rotor)).toEqual({ placed: 8, dropped: 0, overwritten: 0 });
    expect(ship.grid.getCell(3, 65, 3)).toBe(CANVAS);
    expect(host.drops).toEqual([]);
    expect(ship.grid.cellBounds()).toEqual({ minX: 0, minY: 60, minZ: 0, maxX: 256, maxY: 66, maxZ: 1024 });
  });
});
