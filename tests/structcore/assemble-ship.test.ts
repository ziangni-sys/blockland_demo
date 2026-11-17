import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NZ, PX } from '../../src/core/dirs';
import { analyzeHull } from '../../src/structures/hull';
import { Ship } from '../../src/structures/structure';
import { c, cellMap, facing, fill, log, scene, snapshotBox, WATER, worldCentre } from './helpers';

/** Raft of planks on dry ground plus a cobble pier, a torch, sand, a flower and a glued log. */
function raftScene(dynamics = false) {
  const s = scene({ dynamics });
  const { world, host } = s;
  fill(world, -6, 59, -6, 10, 59, 8, c(B.STONE)); // ground
  fill(world, 0, 60, 0, 4, 60, 3, c(B.PLANKS_OAK)); // raft 5 x 4
  world.setCell(2, 61, 1, facing(B.HELM, NZ));
  world.setCell(0, 61, 0, c(B.TORCH)); // mounted on the deck: comes along
  world.setCell(2, 61, 3, log(1)); // vertical log, glued to the deck below
  host.worldGlue.add(2, 61, 3, 3 /* down */);
  host.worldGlue.add(0, 60, 0, PX); // redundant glue inside the raft: must move too
  host.worldGlue.add(1, 60, 1, 4 /* +Z */);
  world.setCell(4, 61, 3, c(B.SAND)); // loose sand: terrain never sticks
  world.setCell(3, 61, 3, c(B.FLOWER_RED)); // plants never connect
  fill(world, 5, 60, 0, 7, 60, 3, c(B.COBBLE)); // pier right next to the raft
  return s;
}

describe('assembleShip (ACCEPTANCE 6, 9)', () => {
  it('preview is pure and follows world changes', () => {
    const { world, mgr } = raftScene();
    const before = snapshotBox(world, -1, 59, -1, 8, 62, 5);
    const p = mgr.previewShip(2, 61, 1);
    expect(p.ok).toBe(true);
    expect(p.count).toBe(20 + 3);
    expect(snapshotBox(world, -1, 59, -1, 8, 62, 5)).toEqual(before);
    expect(mgr.all().length).toBe(0);
    world.setCell(0, 60, 4, c(B.PLANKS_PINE)); // the world changed: the preview must be re-run
    expect(mgr.previewShip(2, 61, 1).count).toBe(24);
  });

  it('moves the connected cells and their glue; the pier, sand and flower stay', () => {
    const { world, host, mgr } = raftScene();
    const expected = new Map<string, number>();
    for (let x = 0; x <= 4; x++) for (let z = 0; z <= 3; z++) expected.set(`${x},60,${z}`, c(B.PLANKS_OAK));
    expected.set('2,61,1', facing(B.HELM, NZ));
    expected.set('0,61,0', c(B.TORCH));
    expected.set('2,61,3', log(1));

    const res = mgr.assembleShip(2, 61, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    expect(ship).toBeInstanceOf(Ship);
    expect(ship.id).toBe(1);
    expect(mgr.ships()).toEqual([ship]);
    expect(mgr.get(1)).toBe(ship);
    expect(mgr.gridById(1)).toBe(ship.grid);
    expect(mgr.structureOf(ship.grid)).toBe(ship);
    expect(mgr.structureOf(world)).toBeNull();

    // Cells keep their coordinates.
    expect(cellMap(ship.grid)).toEqual(expected);
    for (const key of expected.keys()) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      expect(world.getCell(x, y, z)).toBe(0);
    }
    // Pier, sand, flower untouched.
    for (let x = 5; x <= 7; x++) for (let z = 0; z <= 3; z++) expect(world.getCell(x, 60, z)).toBe(c(B.COBBLE));
    expect(world.getCell(4, 61, 3)).toBe(c(B.SAND));
    expect(world.getCell(3, 61, 3)).toBe(c(B.FLOWER_RED));

    // Glue moved with the cells, same keys.
    expect(host.worldGlue.size).toBe(0);
    expect(ship.glue.size).toBe(3);
    expect(ship.glue.has(2, 61, 3, 3)).toBe(true);
    expect(ship.glue.has(0, 60, 0, PX)).toBe(true);
    expect(ship.glue.has(1, 60, 1, 4)).toBe(true);

    // Helm and pose: identity right after assembly, pivot at the centre of mass.
    expect([ship.helmX, ship.helmY, ship.helmZ]).toEqual([2, 61, 1]);
    expect(ship.forward).toBe(NZ);
    const com = analyzeHull(ship.grid)!.com;
    expect(ship.grid.pivot.x).toBeCloseTo(com.x, 12);
    expect(ship.grid.pivot.y).toBeCloseTo(com.y, 12);
    expect(ship.grid.pivot.z).toBeCloseTo(com.z, 12);
    expect(ship.grid.position).toEqual(ship.grid.pivot);
    expect(ship.grid.prevPosition).toEqual(ship.grid.pivot);
    expect(ship.grid.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const p = worldCentre(ship.grid, 4, 60, 3);
    expect(p.x).toBeCloseTo(4.5, 12);
    expect(p.y).toBeCloseTo(60.5, 12);
    expect(p.z).toBeCloseTo(3.5, 12);

    // ACCEPTANCE 9: every vacated cell gets a block update (sand above falls, plants pop).
    expect(host.updateKeys()).toEqual(new Set(expected.keys()));
    expect(host.updateKeys().has('4,60,3')).toBe(true); // under the sand
    expect(host.updateKeys().has('3,60,3')).toBe(true); // under the flower
    expect(host.drops).toEqual([]);
  });

  it('glue to the pier brings exactly the glued pier block along (rubble never auto-sticks)', () => {
    const { world, host, mgr } = raftScene();
    host.worldGlue.add(4, 60, 0, PX);
    const res = mgr.assembleShip(2, 61, 1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.structure.grid.count).toBe(24);
    expect(res.structure.grid.getCell(5, 60, 0)).toBe(c(B.COBBLE));
    expect(res.structure.glue.has(4, 60, 0, PX)).toBe(true);
    expect(world.getCell(5, 60, 0)).toBe(0);
    expect(world.getCell(5, 60, 1)).toBe(c(B.COBBLE));
  });

  it('uses the dynamics to place the pivot when present', () => {
    const { mgr, dyn } = raftScene(true);
    const res = mgr.assembleShip(2, 61, 1);
    if (!res.ok) throw new Error(res.reason);
    const ship = res.structure;
    expect(dyn!.refreshed).toContain(ship);
    const com = analyzeHull(ship.grid)!.com;
    expect(ship.grid.pivot.x).toBeCloseTo(com.x, 12);
    expect(ship.grid.position.x).toBeCloseTo(com.x, 12);
    expect(worldCentre(ship.grid, 0, 60, 0).x).toBeCloseTo(0.5, 12);
  });

  it('refuses non-helms, oversized ships and ships touching unloaded chunks', () => {
    const { world, mgr } = raftScene();
    expect(mgr.assembleShip(0, 60, 0)).toEqual({ ok: false, reason: 'not_a_helm' });
    // A raft reaching the last loaded column (x = 31; chunk x = 2 is not loaded).
    fill(world, 27, 60, 10, 31, 60, 12, c(B.PLANKS_OAK));
    world.setCell(28, 61, 11, facing(B.HELM, NZ));
    const before = snapshotBox(world, 26, 59, 9, 31, 62, 13);
    expect(mgr.assembleShip(28, 61, 11)).toEqual({ ok: false, reason: 'unloaded' });
    expect(snapshotBox(world, 26, 59, 9, 31, 62, 13)).toEqual(before);
    expect(mgr.all().length).toBe(0);
  });
});

describe('assembleShip water refill (DESIGN 水的处理)', () => {
  function sea(world: import('../../src/voxel/world').World): void {
    fill(world, -12, 39, -12, 12, 39, 12, c(B.STONE));
    fill(world, -12, 40, -12, 12, 47, 12, WATER);
  }

  it('a raft at sea: the vacated footprint becomes water, the helm cell above stays air', () => {
    const { world, mgr } = scene();
    sea(world);
    fill(world, -2, 47, -2, 2, 47, 2, c(B.PLANKS_OAK));
    world.setCell(0, 48, 0, facing(B.HELM, NZ));
    expect(mgr.assembleShip(0, 48, 0).ok).toBe(true);
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) expect(world.getCell(x, 47, z)).toBe(WATER);
    expect(world.getCell(0, 48, 0)).toBe(0);
  });

  it('a dry dock: nothing is filled', () => {
    const { world, mgr } = scene();
    fill(world, -12, 46, -12, 12, 46, 12, c(B.STONE));
    fill(world, 8, 47, 8, 12, 47, 12, WATER); // a pond nearby, not adjacent
    fill(world, -2, 47, -2, 2, 47, 2, c(B.PLANKS_OAK));
    world.setCell(0, 48, 0, facing(B.HELM, NZ));
    expect(mgr.assembleShip(0, 48, 0).ok).toBe(true);
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) expect(world.getCell(x, 47, z)).toBe(0);
  });

  it('flowing water does not count as a source', () => {
    const { world, mgr } = scene();
    fill(world, -12, 46, -12, 12, 46, 12, c(B.STONE));
    fill(world, -3, 47, -3, 3, 47, 3, c(B.WATER, 2));
    fill(world, -2, 47, -2, 2, 47, 2, c(B.PLANKS_OAK));
    world.setCell(0, 48, 0, facing(B.HELM, NZ));
    expect(mgr.assembleShip(0, 48, 0).ok).toBe(true);
    expect(world.getCell(0, 47, 0)).toBe(0);
  });

  /** Open boat (or closed box when `lid`) at sea: floor y=44, walls y=44..48, interior air. */
  function boat(lid: boolean) {
    const s = scene();
    const { world } = s;
    sea(world);
    fill(world, -2, 44, -2, 2, 48, 2, c(B.PLANKS_OAK));
    fill(world, -1, 45, -1, 1, 48, 1, 0); // the hold, pumped dry by the builder
    if (lid) {
      fill(world, -2, 49, -2, 2, 49, 2, c(B.PLANKS_OAK));
      world.setCell(0, 50, 0, facing(B.HELM, NZ));
    } else {
      world.setCell(0, 49, -2, facing(B.HELM, NZ));
    }
    return s;
  }

  for (const lid of [false, true]) {
    it(`${lid ? 'sealed cabin' : 'open bilge'}: hull cavities below the sea level are filled to a fixpoint`, () => {
      const { world, host, mgr } = boat(lid);
      const res = mgr.assembleShip(0, lid ? 50 : 49, lid ? 0 : -2);
      if (!res.ok) throw new Error(res.reason);
      const h = analyzeHull(res.structure.grid)!;
      expect(lid ? h.sealedCount : h.bilgeCount).toBe(9 * 4);
      for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
          for (let y = 44; y <= 50; y++) expect(world.getCell(x, y, z)).toBe(y <= 47 ? WATER : 0);
        }
      }
      // Block updates go to the vacated cells only (the hold was never a ship cell).
      expect(host.updateKeys().has('0,46,0')).toBe(false);
      expect(host.updateKeys().size).toBe(res.structure.grid.count);
    });
  }
});

describe('assembleShip keeps attached soft blocks', () => {
  it('a torch on the deck is copied before its base is cleared', () => {
    const { world, mgr } = raftScene();
    const removedOrder: string[] = [];
    world.onCellChange((x, y, z, _o, n) => {
      if (n === 0) removedOrder.push(`${x},${y},${z}`);
    });
    const res = mgr.assembleShip(2, 61, 1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.structure.grid.getCell(0, 61, 0)).toBe(c(B.TORCH));
    expect(removedOrder.length).toBe(23);
    expect(world.getCell(0, 61, 0)).toBe(0);
    expect(res.structure.grid.getCell(2, 61, 1)).toBe(facing(B.HELM, NZ));
  });
});
