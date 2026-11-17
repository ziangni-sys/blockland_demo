import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { TICK_DT } from '../../src/core/constants';
import { PZ } from '../../src/core/dirs';
import { qclone, qfromYaw, vclone, vec3, vsub, type Vec3 } from '../../src/core/math';
import { applyRotorPose } from '../../src/structures/rotor';
import type { Rotor, Ship } from '../../src/structures/structure';
import {
  c,
  cellMap,
  MILL_BEARING,
  MILL_CELLS,
  millShip,
  rotZ,
  scene,
  SHIP_CELLS,
  SHIP_HELM,
  worldCentre,
  type Scene,
} from './helpers';

const [BX, BY, BZ] = MILL_BEARING;

/** World centres of every rotor cell (sorted by local key). */
function rotorWorld(r: Rotor): Vec3[] {
  const out: Array<[string, Vec3]> = [];
  r.grid.forEachCell((x, y, z) => out.push([`${x},${y},${z}`, worldCentre(r.grid, x, y, z)]));
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
}

function expectClose(a: Vec3[], b: Vec3[], eps: number): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(Math.abs(a[i]!.x - b[i]!.x)).toBeLessThan(eps);
    expect(Math.abs(a[i]!.y - b[i]!.y)).toBeLessThan(eps);
    expect(Math.abs(a[i]!.z - b[i]!.z)).toBeLessThan(eps);
  }
}

/** Ship assembled from the millShip with its windmill already running in the world. */
function shipWithRunningMill(s: Scene, ticks = 12): { ship: Ship; rotor: Rotor } {
  millShip(s.world, s.host.worldGlue);
  const rr = s.mgr.startRotor(s.world, BX, BY, BZ);
  if (!rr.ok) throw new Error(rr.reason);
  for (let i = 0; i < ticks; i++) s.mgr.step();
  const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
  if (!sr.ok) throw new Error(sr.reason);
  return { ship: sr.structure, rotor: rr.structure };
}

/** Ship assembled with a STOPPED windmill (hub glued to the bearing), rotor then started on the ship. */
function shipThenMill(s: Scene): { ship: Ship; rotor: Rotor } {
  millShip(s.world, s.host.worldGlue, true);
  const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
  if (!sr.ok) throw new Error(sr.reason);
  const ship = sr.structure;
  expect(ship.grid.count).toBe(SHIP_CELLS + MILL_CELLS);
  const rr = s.mgr.startRotor(ship.grid, BX, BY, BZ);
  if (!rr.ok) throw new Error(rr.reason);
  return { ship, rotor: rr.structure };
}

/** Move a ship by hand: yaw about +Y and a translation of its pivot. */
function poseShip(ship: Ship, yaw: number, d: Vec3): void {
  const p = vclone(ship.grid.position);
  p.x += d.x;
  p.y += d.y;
  p.z += d.z;
  ship.grid.setPoseImmediate(p, qfromYaw(yaw));
}

describe('rotors on ships', () => {
  it('assembling a ship re-parents its running windmill with a continuous world pose', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue);
    const rr = s.mgr.startRotor(s.world, BX, BY, BZ);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    for (let i = 0; i < 12; i++) s.mgr.step();
    const before = rotorWorld(rotor);
    const tip = worldCentre(rotor.grid, BX + 2, BY, BZ + 1);
    const vBefore = rotor.grid.velocityAt(tip);
    const angle = rotor.angle;

    const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
    if (!sr.ok) throw new Error(sr.reason);
    const ship = sr.structure;
    expect(ship.grid.count).toBe(SHIP_CELLS); // the windmill is not part of the hull
    expect(rotor.parent).toBe(ship);
    expect(rotor.grid.parent).toBe(ship.grid);
    expect(ship.children).toEqual([rotor]);
    expect([rotor.bearingX, rotor.bearingY, rotor.bearingZ]).toEqual([BX, BY, BZ]);
    expect(s.mgr.rotorAtBearing(ship.grid, BX, BY, BZ)).toBe(rotor);
    expect(s.mgr.rotorAtBearing(s.world, BX, BY, BZ)).toBeNull();
    expect(ship.grid.getCell(BX, BY, BZ) & 0x3ff).toBe(B.BEARING);
    expectClose(rotorWorld(rotor), before, 1e-9);
    const vAfter = rotor.grid.velocityAt(tip);
    expectClose([vAfter], [vBefore], 1e-9);
    expect(rotor.angle).toBe(angle);

    // The world bearing cell left with the ship: that must not count as "bearing lost".
    expect(rotor.removed).toBe(false);
    s.mgr.step();
    expect(rotor.angle).toBeGreaterThan(angle);
    expect(ship.sails).toBe(rotor.sails);
  });

  it('the windmill follows its ship; velocityAt adds the ship velocity', () => {
    const s = scene();
    const { ship, rotor } = shipWithRunningMill(s, 50);
    const v = vec3(1.5, 0, -0.5);
    poseShip(ship, 0.7, vec3(5, 0, 3));
    ship.grid.linearVelocity.x = v.x;
    ship.grid.linearVelocity.z = v.z;
    const tipAt = (): Vec3 => worldCentre(rotor.grid, BX + 2, BY, BZ + 1);
    const advance = (): void => {
      s.mgr.step();
      // No dynamics here: integrate the ship by hand after the manager's step.
      ship.grid.position.x += v.x * TICK_DT;
      ship.grid.position.z += v.z * TICK_DT;
    };
    advance();
    const p0 = tipAt();
    advance();
    const p1 = tipAt();
    const vel = rotor.grid.velocityAt(p1);
    advance();
    const p2 = tipAt();
    const fd = vsub(p2, p0);
    expect(vel.x).toBeCloseTo(fd.x / (2 * TICK_DT), 2);
    expect(vel.y).toBeCloseTo(fd.y / (2 * TICK_DT), 2);
    expect(vel.z).toBeCloseTo(fd.z / (2 * TICK_DT), 2);
    // The rotor's axis in the world turned with the ship (bearing faces +Z locally).
    const axisWorld = rotor.grid.dirToWorld(vec3(0, 0, 1));
    expect(axisWorld.x).toBeCloseTo(Math.sin(0.7), 9);
    expect(axisWorld.z).toBeCloseTo(Math.cos(0.7), 9);
  });

  it('a rotor started on a ship takes its cells from the ship and returns them on stop', () => {
    const s = scene({ dynamics: true });
    const { ship, rotor } = shipThenMill(s);
    expect(rotor.parent).toBe(ship);
    expect(rotor.hubGlue).toBe(true);
    expect(ship.glue.has(BX, BY, BZ, PZ)).toBe(false);
    expect(ship.grid.count).toBe(SHIP_CELLS);
    expect(rotor.grid.count).toBe(MILL_CELLS);
    expect(s.dyn!.woken).toContain(ship);
    poseShip(ship, 1.1, vec3(-4, 2, 6)); // the ship sails away; the rotor stays mounted
    for (let i = 0; i < 30; i++) s.mgr.step();
    rotor.angle = Math.PI / 2 + 0.3;
    applyRotorPose(rotor);
    const shipPose = [vclone(ship.grid.position), qclone(ship.grid.rotation)];
    s.dyn!.woken.length = 0;
    const nUpdates = s.host.updates.length;
    const rep = s.mgr.stopRotor(rotor);
    expect(rep).toEqual({ placed: MILL_CELLS, dropped: 0, overwritten: 0 });
    expect(ship.grid.count).toBe(SHIP_CELLS + MILL_CELLS);
    expect(ship.children).toEqual([]);
    expect(ship.glue.has(BX, BY, BZ, PZ)).toBe(true); // hub glue restored in the SHIP's store
    // Quarter turn about +Z in ship-local coordinates.
    const [x2, y2] = rotZ(2, 0, 1);
    expect(ship.grid.getCell(BX + x2, BY + y2, BZ + 1)).toBe(c(B.WOOL_RED));
    expect(ship.grid.getCell(BX, BY, BZ + 1)).toBe(c(B.CANVAS));
    expect([vclone(ship.grid.position), qclone(ship.grid.rotation)]).toEqual(shipPose);
    expect(s.dyn!.woken).toContain(ship);
    expect(s.host.updates.length).toBe(nUpdates); // ship cells are not world cells: no block updates
    // It can be started again from the ship.
    expect(s.mgr.startRotor(ship.grid, BX, BY, BZ).ok).toBe(true);
  });

  it('ACCEPTANCE 12: rotor cells landing inside world rock drop; the ship is not disturbed', () => {
    const s = scene();
    const { ship, rotor } = shipThenMill(s);
    poseShip(ship, Math.PI / 2, vec3(6, 1, -4));
    rotor.angle = Math.PI / 2;
    applyRotorPose(rotor);
    // Where would the +X arm tip land (ship cell), and which WORLD cell holds its centre?
    const [tx, ty] = rotZ(2, 0, 1);
    const dest = vec3(BX + tx, BY + ty, BZ + 1);
    const w = worldCentre(ship.grid, dest.x, dest.y, dest.z);
    const rock = vec3(Math.floor(w.x), Math.floor(w.y), Math.floor(w.z));
    s.world.setCell(rock.x, rock.y, rock.z, c(B.STONE));
    const pose = [vclone(ship.grid.position), qclone(ship.grid.rotation), vclone(ship.grid.linearVelocity)];
    const rep = s.mgr.stopRotor(rotor);
    expect(rep).toEqual({ placed: MILL_CELLS - 1, dropped: 1, overwritten: 0 });
    expect(ship.grid.getCell(dest.x, dest.y, dest.z)).toBe(0);
    expect(s.world.getCell(rock.x, rock.y, rock.z)).toBe(c(B.STONE));
    expect(s.host.drops.length).toBe(1);
    expect(s.host.drops[0]!.item).toBe(B.WOOL_RED);
    expect(s.host.drops[0]!.x).toBeCloseTo(w.x, 9);
    expect(s.host.drops[0]!.y).toBeCloseTo(w.y, 9);
    expect(s.host.drops[0]!.z).toBeCloseTo(w.z, 9);
    expect([vclone(ship.grid.position), qclone(ship.grid.rotation), vclone(ship.grid.linearVelocity)]).toEqual(pose);
    // A hard SHIP cell is a conflict too.
    const t = scene();
    const pair = shipThenMill(t);
    pair.ship.grid.setCell(BX + 1, BY, BZ + 1, c(B.PLANKS_OAK)); // a plank where the arm returns
    expect(t.mgr.stopRotor(pair.rotor)).toEqual({ placed: MILL_CELLS - 1, dropped: 1, overwritten: 0 });
    expect(cellMap(pair.ship.grid).get(`${BX + 1},${BY},${BZ + 1}`)).toBe(c(B.PLANKS_OAK));
  });

  it('mining a ship bearing blockifies its rotor onto the ship immediately', () => {
    const s = scene();
    const { ship, rotor } = shipThenMill(s);
    for (let i = 0; i < 5; i++) s.mgr.step();
    ship.grid.setCell(BX, BY, BZ, 0);
    expect(rotor.removed).toBe(true);
    expect(ship.grid.getCell(BX, BY, BZ + 1)).toBe(c(B.CANVAS));
    expect(ship.children).toEqual([]);
  });
});
