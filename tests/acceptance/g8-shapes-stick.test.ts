/**
 * Acceptance scenarios 42 and 43 (docs/ACCEPTANCE.md "形状与凿子"; docs/SHAPES.md 10, 11, 16.4),
 * headless, whole simulation, in both modes (direct, and through the protocol):
 *  - 42: two cells only stick where both have material on the shared face: an upper slab and the
 *    upper slab in the cell above are not connected; chiselling away the material on a glued face
 *    removes the glue there.
 *  - 43, the part of package P7: a ship of slabs and stairs assembles with every part; docked back
 *    unrotated its shapes are unchanged, and re-assembling takes the same number of cells; docked
 *    after a quarter turn every shape (second parts included) is turned with it. (Floating and
 *    draft belong to P9: tests/acceptance/g8-shapes-ship.test.ts.)
 *
 * Scenes are written on the server (w.sim): the tools that make partial blocks come in M2.4, and
 * "chiselling" is a direct cell write (docs/SHAPES.md 14.1, 16.4). The player assembles, glues,
 * places and docks through w.me.
 */
import { describe, expect, it } from 'vitest';
import { facingState, ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, withoutOctant } from '../../src/blocks/shapes';
import { NX, NZ, PX, PZ, type Dir } from '../../src/core/dirs';
import { qfromYaw, qrotate, vec3, vsub } from '../../src/core/math';
import { I } from '../../src/blocks/items';
import { dockSnap, snapCell } from '../../src/structures/assembly';
import { HULL_MIXED, hullCavityCells, hullKindAt, isDryCell } from '../../src/structures/hull';
import { rotCell } from '../../src/structures/orient';
import type { Ship } from '../../src/structures/structure';
import { getPacked } from '../../src/voxel/parts';
import { EAST, LOWER, NORTH, slab, SOUTH, stairFill, UPPER, WEST } from '../shapes';
import { assembleShipByHand, makeWorld, T } from './g1-stick-glue-helpers';
import { onlyShip, SEA_TOP, seaWorld } from './g2-assemble-dock-helpers';
import { structureLabels, worldLabels } from './g8-shapes-helpers';
import type { TestWorld } from './world';

const HELM_N = makeCell(B.HELM, facingState(NZ));

/** A 3 x 2 planks deck at y = T (x 0..2, z -4..-3) with a helm on (1, T + 1, -3). */
function smallDeck(w: TestWorld): void {
  for (let x = 0; x <= 2; x++) for (let z = -4; z <= -3; z++) w.sim.world.setCell(x, T, z, makeCell(B.PLANKS_OAK));
  w.sim.world.setCell(1, T + 1, -3, HELM_N);
}

/** "x,y,z" keys of the highlighted preview (cells of the world). */
function previewKeys(w: TestWorld): string[] {
  const pv = w.me.view.preview;
  if (pv === null) return [];
  const out: string[] = [];
  for (let i = 0; i < pv.cells.length; i += 3) out.push(`${pv.cells[i]},${pv.cells[i + 1]},${pv.cells[i + 2]}`);
  return out.sort();
}

describe('42. 两格只有在共享面上都有材质时才粘连：一格的上半砖和它上方那格的上半砖不相连。凿掉接触面上的材质后，那个面上的胶消失。', () => {
  it('一格的上半砖和它上方那格的上半砖不相连: the ship takes the upper slab beside the deck, not the upper slab above it; a lower slab above it comes along', () => {
    const w = makeWorld();
    const { sim } = w;
    smallDeck(w);
    // Column A: an upper slab beside the deck, and an upper slab in the cell above it.
    sim.world.setCell(3, T, -4, slab(B.PLANKS_OAK, UPPER));
    sim.world.setCell(3, T + 1, -4, slab(B.PLANKS_OAK, UPPER));
    // Column B: the same, but a lower slab above (it rests on the upper slab's top face).
    sim.world.setCell(3, T, -3, slab(B.PLANKS_OAK, UPPER));
    sim.world.setCell(3, T + 1, -3, slab(B.PLANKS_OAK, LOWER));
    const a = assembleShipByHand(w, 1, T + 1, -3);
    const deck: string[] = [];
    for (let x = 0; x <= 2; x++) for (let z = -4; z <= -3; z++) deck.push(`${x},${T},${z}`);
    const want = [...deck, `1,${T + 1},-3`, `3,${T},-4`, `3,${T},-3`, `3,${T + 1},-3`].sort();
    expect(a.structure.grid.count).toBe(want.length);
    expect(structureLabels(a.structure).map((l) => l.split(':')[0]!).sort()).toEqual(want);
    expect(structureLabels(a.structure)).toContain(`3,${T + 1},-3:planks_oak[33]`);
    // The upper slab above column A stays in the world, unchanged.
    expect(worldLabels(sim, 3, T + 1, -4, 3, T + 1, -4)).toEqual([`3,${T + 1},-4:planks_oak[cc]`]);
    expect(getPacked(sim.world, 3, T, -4)).toBe(0);
  });

  it('凿掉接触面上的材质后，那个面上的胶消失: glue the deck\'s face, place bricks against it (glued in); chisel the touching half: the glue is gone and the ship leaves the bricks', () => {
    const w = makeWorld('creative', { x: 4.5, y: T, z: -1.5 }); // east of the deck: its east faces are in sight
    const { sim, me } = w;
    smallDeck(w);
    // The player glues the east face of a deck plank and puts bricks against it.
    me.hold(I.GLUE);
    expect(me.useOn(2, T, -3, PX)).toBe(true);
    expect(sim.worldGlue.has(2, T, -3, PX)).toBe(true);
    me.hold(B.BRICKS);
    expect(me.useOn(2, T, -3, PX)).toBe(true);
    expect(getPacked(sim.world, 3, T, -3)).toBe(makeCell(B.BRICKS));
    // Preview: the bricks are glued in.
    me.emptyHand();
    expect(me.useOn(1, T + 1, -3, PZ)).toBe(true);
    expect(previewKeys(w)).toContain(`3,${T},-3`);
    // Chiselling one octant of the glued face: the two still touch, the glue stays.
    sim.world.setCell(3, T, -3, withoutOctant(makeCell(B.BRICKS), 0));
    w.tick();
    expect(sim.worldGlue.has(2, T, -3, PX)).toBe(true);
    // Chiselling the rest of that half: the bricks no longer touch the plank; the glue is gone.
    for (const o of [2, 4, 6]) sim.world.setCell(3, T, -3, withoutOctant(getPacked(sim.world, 3, T, -3), o));
    expect(getPacked(sim.world, 3, T, -3)).toBe(slab(B.BRICKS, EAST));
    w.tick();
    expect(sim.worldGlue.has(2, T, -3, PX)).toBe(false);
    expect(sim.worldGlue.size).toBe(0);
    // The player assembles: the bricks slab stays behind.
    const a = assembleShipByHand(w, 1, T + 1, -3);
    expect(a.structure.grid.count).toBe(7);
    expect(worldLabels(sim, 3, T, -3, 3, T, -3)).toEqual([`3,${T},-3:bricks[aa]`]);
  });
});

// ==================================================================== scenario 43

/** The raft of scenario 43: a 5 x 5 planks deck at y = T (x -2..2, z -6..-2), the helm at its centre. */
const HELM: readonly [number, number, number] = [0, T + 1, -4];

/** Partial cells on the deck (each sticks to the deck, or to the cell below it, through planks). */
const PARTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-2, T + 1, -6, slab(B.PLANKS_OAK, LOWER)],
  [-1, T + 1, -6, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST))],
  [0, T + 1, -6, canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_PINE, UPPER))],
  [1, T + 1, -6, slab(B.PLANKS_OAK, stairFill(PX))],
  [1, T + 2, -6, slab(B.PLANKS_OAK, LOWER)], // on the stair's high side
  [2, T + 1, -6, slab(B.PLANKS_OAK, 0x01)],
  [-2, T + 1, -2, canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.WOOL_RED, SOUTH))],
  [2, T + 1, -2, slab(B.PLANKS_OAK, 0x7f)],
];
const RAFT_CELLS = 25 + 1 + PARTS.length;

function raft(w: TestWorld): void {
  for (let x = -2; x <= 2; x++) for (let z = -6; z <= -2; z++) w.sim.world.setCell(x, T, z, makeCell(B.PLANKS_OAK));
  w.sim.world.setCell(HELM[0], HELM[1], HELM[2], HELM_N);
  for (const [x, y, z, p] of PARTS) w.sim.world.setCell(x, y, z, p);
}

/** Part labels of the raft's box in the world. */
function raftLabels(w: TestWorld): string[] {
  return worldLabels(w.sim, -2, T, -6, 2, T + 2, -2);
}

/** The player assembles the raft (two right-clicks on the helm), lets go of the wheel and steps back south of the raft. */
function assemble(w: TestWorld): Ship {
  const a = assembleShipByHand(w, HELM[0], HELM[1], HELM[2]);
  w.me.use(); // let go of the wheel
  w.tick(5);
  w.me.teleport(0.5, T, 0.5);
  w.tick(2);
  return a.structure;
}

/**
 * The player docks the ship: sneak + right-click on its helm (ship-local cell = where it was
 * built), on the local face `face` that looks towards the player.
 */
function dock(w: TestWorld, ship: Ship, face: Dir = PZ): void {
  w.me.input.sneak = true;
  expect(w.me.useOn(HELM[0], HELM[1], HELM[2], face, ship.id)).toBe(true);
  w.me.input.sneak = false;
}

/** Turn a ship a quarter turn to the left (yaw +90 degrees) about the centre of its helm cell. */
function quarterTurn(ship: Ship): void {
  const q = qfromYaw(Math.PI / 2);
  const c = vec3(HELM[0] + 0.5, HELM[1] + 0.5, HELM[2] + 0.5);
  const off = qrotate(q, vsub(c, ship.grid.pivot));
  ship.grid.setPoseImmediate(vec3(c.x - off.x, c.y - off.y, c.z - off.z), q);
}

describe('43. 用半砖和楼梯造的船能组装；停靠后形状不变，再次组装格数一致；转 90° 停靠后形状跟着转。（组装、停靠、旋转部分）', () => {
  it('组装: the player assembles the raft and every part of every cell goes along, two-part cells whole', () => {
    const w = makeWorld();
    raft(w);
    const before = raftLabels(w);
    expect(before).toHaveLength(RAFT_CELLS);
    const ship = assemble(w);
    expect(ship.grid.count).toBe(RAFT_CELLS);
    expect(structureLabels(ship)).toEqual(before);
    expect(raftLabels(w)).toEqual([]);
  });

  it('停靠后形状不变，再次组装格数一致: docked unrotated, every part is back as it was; assembling again takes the same cells', () => {
    const w = makeWorld();
    const { sim } = w;
    raft(w);
    const before = raftLabels(w);
    const ship = assemble(w);
    expect(dockSnap(ship.grid).r).toEqual({ ax: 0, ay: 2, az: 4 });
    dock(w, ship);
    expect(ship.removed).toBe(true);
    expect(sim.structures.ships()).toHaveLength(0);
    expect(raftLabels(w)).toEqual(before);
    const again = assemble(w);
    expect(again.grid.count).toBe(RAFT_CELLS);
    expect(structureLabels(again)).toEqual(before);
  });

  it('转 90° 停靠后形状跟着转: docked after a quarter turn, each cell is its rotation (shapes, second parts, states); assembling again takes the same number of cells', () => {
    const w = makeWorld();
    const { sim } = w;
    raft(w);
    const ship = assemble(w);
    const cells = new Map<string, number>();
    ship.grid.forEachCell((x, y, z, p) => cells.set(`${x},${y},${z}`, p));
    quarterTurn(ship);
    w.tick(10);
    const t = dockSnap(ship.grid);
    expect(t.r).toEqual({ ax: 5, ay: 2, az: 0 }); // +X -> -Z: a quarter turn to the left
    expect(sim.structures.dockConflicts(ship).ok).toBe(true);
    dock(w, ship, NX); // the helm's local -X face looks south (towards the player) now
    expect(ship.removed).toBe(true);
    const d = vec3();
    for (const [k, p] of cells) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      snapCell(t, x, y, z, d);
      expect(getPacked(sim.world, d.x, d.y, d.z), k).toBe(rotCell(t.r, p));
    }
    // The helm turned with it (it faced north, now west), and around it the deck is where it was.
    expect(getPacked(sim.world, HELM[0], HELM[1], HELM[2])).toBe(makeCell(B.HELM, facingState(1 as Dir)));
    // The west/east two-part cell (planks west, stone east) lies north/south now: stone north, planks south.
    const two = snapCell(t, -1, T + 1, -6);
    expect(worldLabels(sim, two.x, two.y, two.z, two.x, two.y, two.z)).toEqual([`${two.x},${two.y},${two.z}:stone[0f]+planks_oak[f0]`]);
    // The stair rises towards -Z now, and the slab on it is still on its high side.
    const stair = snapCell(t, 1, T + 1, -6);
    expect(worldLabels(sim, stair.x, stair.y, stair.z, stair.x, stair.y + 1, stair.z)).toEqual(
      [`${stair.x},${stair.y},${stair.z}:planks_oak[${stairFill(NZ).toString(16)}]`, `${stair.x},${stair.y + 1},${stair.z}:planks_oak[33]`].sort(),
    );
    const again = assemble(w);
    expect(again.grid.count).toBe(RAFT_CELLS);
  });

  // The hold of a boat in the sea, built dry, with its rim (the top water layer) made of LOWER
  // slabs: the cells inside the rim layer are half dry (their lower half is bilge, the spill line
  // runs through their middle). Assembling refills water under every cavity cell (hullCavityCells);
  // docking where it was built must take all of it out again, or the water enclosed by the slab
  // rim (a wall for liquids in the world) drains into the hold. A rim of full planks is the M1 case.
  for (const [name, rim] of [
    ['full plank rim', makeCell(B.PLANKS_OAK)],
    ['lower slab rim', slab(B.PLANKS_OAK, LOWER)],
  ] as const) {
    it(`停靠后船舱保持干燥 (${name}): assembled in the sea and docked where it was built, no water is left inside the hull, and none drains in later`, () => {
      const top = SEA_TOP - 1; // the top water layer
      const w = seaWorld({ spawn: { x: 2.5, y: SEA_TOP + 1, z: 6.5 } });
      const { sim } = w;
      for (let x = 1; x <= 3; x++) sim.world.setCell(x, SEA_TOP, 6, makeCell(B.STONE)); // a pier
      for (let z = 0; z <= 4; z++) {
        for (let x = 0; x <= 4; x++) {
          const edge = x === 0 || x === 4 || z === 0 || z === 4;
          sim.world.setCell(x, top - 2, z, makeCell(B.PLANKS_OAK)); // floor
          sim.world.setCell(x, top - 1, z, edge ? makeCell(B.PLANKS_OAK) : 0); // wall, hold
          sim.world.setCell(x, top, z, edge ? rim : 0); // rim, the space inside it
        }
      }
      sim.world.setCell(2, top - 1, 3, HELM_N);
      w.tick(20);
      const waterInside = (y: number): number => {
        let n = 0;
        for (let z = 1; z <= 3; z++) for (let x = 1; x <= 3; x++) if ((sim.world.getCell(x, y, z) & ID_MASK) === B.WATER) n++;
        return n;
      };
      expect(waterInside(top - 1) + waterInside(top)).toBe(0);
      const a = sim.structures.assembleShip(2, top - 1, 3);
      expect(a.ok).toBe(true);
      const ship = onlyShip(sim);
      const h = ship.hull!;
      expect(h.floats).toBe(true);
      // The sea closed over the footprint: sources under the hold and under the rim layer.
      expect(waterInside(top - 1)).toBe(9);
      expect(waterInside(top)).toBe(9);
      const cav = hullCavityCells(h);
      let cavRim = 0;
      for (let i = 0; i < cav.length; i += 3) if (cav[i + 1] === top) cavRim++;
      expect(cavRim).toBe(9);
      if (rim !== makeCell(B.PLANKS_OAK)) {
        // The case under test: the rim layer is half dry, not dry as a whole cell.
        expect(hullKindAt(h, 2, top, 2)).toBe(HULL_MIXED);
        expect(isDryCell(h, 2, top, 2)).toBe(false);
      }
      const res = sim.structures.dockShip(ship); // at once: the ship has not moved
      expect(res.ok).toBe(true);
      expect(waterInside(top - 1)).toBe(0);
      expect(waterInside(top)).toBe(0);
      w.tick(200);
      expect(waterInside(top - 1)).toBe(0);
      expect(waterInside(top)).toBe(0);
    });
  }
});
