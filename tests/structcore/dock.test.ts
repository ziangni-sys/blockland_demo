import { describe, expect, it } from 'vitest';
import { cellState, stateAxis, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { DIR_X, DIR_Z, nearestDir, PZ, type Dir } from '../../src/core/dirs';
import { qfromAxisAngle, qfromYaw, qmul, qrotate, vec3, vsub, type Vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import {
  c,
  cellMap,
  facing,
  fill,
  MILL_BEARING,
  millShip,
  rotY,
  scene,
  SHIP_CELLS,
  SHIP_HELM,
  snapshotBox,
  WATER,
  worldCentre,
  type Scene,
} from './helpers';

const [BX, BY, BZ] = MILL_BEARING;
const [HX, HY, HZ] = SHIP_HELM;

function shipWithRunningMill(s: Scene): { ship: Ship; rotor: Rotor } {
  millShip(s.world, s.host.worldGlue);
  const rr = s.mgr.startRotor(s.world, BX, BY, BZ);
  if (!rr.ok) throw new Error(rr.reason);
  for (let i = 0; i < 9; i++) s.mgr.step();
  const sr = s.mgr.assembleShip(HX, HY, HZ);
  if (!sr.ok) throw new Error(sr.reason);
  return { ship: sr.structure, rotor: rr.structure };
}

/** World centres of every rotor cell, keyed by local cell. */
function rotorWorld(r: Rotor): Map<string, Vec3> {
  const m = new Map<string, Vec3>();
  r.grid.forEachCell((x, y, z) => m.set(`${x},${y},${z}`, worldCentre(r.grid, x, y, z)));
  return m;
}

/** Place the ship so that its helm centre lands exactly on world cell `h` (centre) with yaw `yaw`. */
function poseExact(ship: Ship, yaw: number, h: Vec3): void {
  const q = qfromYaw(yaw);
  const off = qrotate(q, vsub(vec3(ship.helmX + 0.5, ship.helmY + 0.5, ship.helmZ + 0.5), ship.grid.pivot));
  ship.grid.setPoseImmediate(vec3(h.x + 0.5 - off.x, h.y + 0.5 - off.y, h.z + 0.5 - off.z), q);
}

function dirOfVec(dx: number, dz: number): Dir {
  return nearestDir(dx, 0, dz);
}

/** Rotate a horizontal facing by k quarter yaw turns. */
function yawDir(d: Dir, k: number): Dir {
  const [x, z] = rotY(DIR_X[d]!, DIR_Z[d]!, k);
  return dirOfVec(x, z);
}

const CASES: Array<{ k: number; exact: boolean; wobble: number; off: Vec3 }> = [
  { k: 0, exact: true, wobble: 0, off: vec3(0, 0, 0) },
  { k: 1, exact: true, wobble: 0, off: vec3(0, 0, 0) },
  { k: 2, exact: true, wobble: 0, off: vec3(0, 0, 0) },
  { k: 3, exact: true, wobble: 0, off: vec3(0, 0, 0) },
  // |offset| + wobble * (largest horizontal lever arm, ~5 cells) stays below half a cell, so
  // "the world cell holding the centre now" is an unambiguous expectation.
  { k: 1, exact: false, wobble: 0.03, off: vec3(0.21, 0.1, -0.17) },
  { k: 2, exact: false, wobble: -0.03, off: vec3(-0.2, -0.12, 0.15) },
  { k: 3, exact: false, wobble: 0.02, off: vec3(0.25, 0.05, 0.24) },
  { k: 0, exact: false, wobble: -0.03, off: vec3(-0.2, 0.2, 0.2) },
];

describe('dockShip (ACCEPTANCE 8)', () => {
  for (const cs of CASES) {
    it(`yaw ${cs.k * 90}${cs.exact ? ' (exact)' : ` + ${cs.wobble} rad, offset`}: blocks, glue and the windmill return to the world`, () => {
      const s = scene();
      const { ship, rotor } = shipWithRunningMill(s);
      const local = cellMap(ship.grid);
      const glueBefore = ship.glue.size;
      const target = vec3(9, 62, -6);
      poseExact(ship, cs.k * (Math.PI / 2) + cs.wobble, target);
      ship.grid.position.x += cs.off.x;
      ship.grid.position.y += cs.off.y;
      ship.grid.position.z += cs.off.z;
      ship.grid.snapshotPose();
      s.mgr.step(); // the windmill keeps turning on the posed ship
      // Expected destination of every ship cell: the world cell holding its centre now.
      const dest = new Map<string, Vec3>();
      for (const key of local.keys()) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        const w = worldCentre(ship.grid, x, y, z);
        dest.set(key, vec3(Math.floor(w.x), Math.floor(w.y), Math.floor(w.z)));
      }
      const helmW = dest.get(`${HX},${HY},${HZ}`)!;
      expect(helmW).toEqual(target);
      const rotorBefore = rotorWorld(rotor);
      expect(s.mgr.dockConflicts(ship).ok).toBe(true);

      const res = s.mgr.dockShip(ship);
      expect(res).toEqual({ ok: true, report: { placed: SHIP_CELLS, dropped: 0, overwritten: 0 } });
      expect(ship.removed).toBe(true);
      expect(s.mgr.ships()).toEqual([]);
      expect(s.host.released).toContain(ship);
      expect(s.host.released).toContain(rotor);

      // Blocks: rigid rotation by k quarter turns about the helm, states rotated.
      for (const [key, cell] of local) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        const d = dest.get(key)!;
        const [rx, rz] = rotY(x - HX, z - HZ, cs.k);
        expect(d).toEqual(vec3(helmW.x + rx, helmW.y + y - HY, helmW.z + rz));
        const placed = s.world.getCell(d.x, d.y, d.z);
        expect(placed & 0x3ff).toBe(cell & 0x3ff);
        if ((cell & 0x3ff) === B.LOG_OAK) expect(stateAxis(cellState(placed))).toBe(cs.k % 2 === 0 ? 0 : 2);
        if ((cell & 0x3ff) === B.HELM) expect(stateFacing(cellState(placed))).toBe(yawDir(5, cs.k));
        if ((cell & 0x3ff) === B.BEARING) expect(stateFacing(cellState(placed))).toBe(yawDir(4, cs.k));
      }
      expect(new Set(s.host.updates.slice(-SHIP_CELLS).map(([x, y, z]) => `${x},${y},${z}`))).toEqual(
        new Set([...dest.values()].map((v) => `${v.x},${v.y},${v.z}`)),
      );

      // Glue: same faces, re-keyed through the rotation.
      expect(s.host.worldGlue.size).toBe(glueBefore);
      const logW = dest.get('2,61,0')!;
      const deckW = dest.get('2,60,0')!;
      expect(s.host.worldGlue.has(logW.x, logW.y, logW.z, 3)).toBe(true);
      expect(deckW.y).toBe(logW.y - 1);
      const a = dest.get('-3,60,-3')!;
      const b = dest.get('-3,60,-2')!;
      expect(s.host.worldGlue.has(a.x, a.y, a.z, nearestDir(b.x - a.x, b.y - a.y, b.z - a.z))).toBe(true);

      // The running windmill is re-mounted on the world, still running.
      const bearingW = dest.get(`${BX},${BY},${BZ}`)!;
      expect(rotor.removed).toBe(false);
      expect(rotor.parent).toBeNull();
      expect(rotor.grid.parent).toBe(s.world);
      expect([rotor.bearingX, rotor.bearingY, rotor.bearingZ]).toEqual([bearingW.x, bearingW.y, bearingW.z]);
      expect(s.mgr.rotorAtBearing(s.world, bearingW.x, bearingW.y, bearingW.z)).toBe(rotor);
      const axisW = rotor.grid.dirToWorld(vec3(0, 0, 1));
      const f = yawDir(4, cs.k);
      expect(axisW.x).toBeCloseTo(DIR_X[f]!, 9);
      expect(axisW.z).toBeCloseTo(DIR_Z[f]!, 9);
      const after = rotorWorld(rotor);
      for (const [key, p] of rotorBefore) {
        const q = after.get(key)!;
        const eps = cs.exact ? 1e-9 : 0.5 + 3 * Math.abs(cs.wobble) * 4;
        expect(Math.abs(q.x - p.x)).toBeLessThan(eps);
        expect(Math.abs(q.y - p.y)).toBeLessThan(eps);
        expect(Math.abs(q.z - p.z)).toBeLessThan(eps);
      }
      expect(rotor.grid.prevPosition).toEqual(rotor.grid.position);
      const angle = rotor.angle;
      s.mgr.step();
      expect(rotor.angle).not.toBe(angle);

      // Stopping it now puts the windmill in front of the docked bearing.
      rotor.angle = 0;
      s.mgr.stopRotor(rotor);
      const hub = vec3(bearingW.x + DIR_X[f]!, bearingW.y, bearingW.z + DIR_Z[f]!);
      expect(s.world.getCell(hub.x, hub.y, hub.z)).toBe(c(B.CANVAS));
    });
  }

  it('re-assembling after docking gives the same cell and glue counts; the windmill re-parents', () => {
    const s = scene();
    const { ship, rotor } = shipWithRunningMill(s);
    const cells = ship.grid.count;
    const glue = ship.glue.size;
    poseExact(ship, Math.PI / 2, vec3(-7, 63, 5));
    expect(s.mgr.dockShip(ship).ok).toBe(true);
    const again = s.mgr.assembleShip(-7, 63, 5);
    if (!again.ok) throw new Error(again.reason);
    expect(again.structure.grid.count).toBe(cells);
    expect(again.structure.glue.size).toBe(glue);
    expect(again.structure.children).toEqual([rotor]);
    expect(again.structure.forward).toBe(yawDir(5, 1));
    expect(s.host.worldGlue.size).toBe(0);
    // And a second dock / assemble cycle keeps it all.
    poseExact(again.structure, Math.PI, vec3(4, 61, 4));
    expect(s.mgr.dockShip(again.structure).ok).toBe(true);
    const third = s.mgr.assembleShip(4, 61, 4);
    expect(third.ok && third.structure.grid.count).toBe(cells);
    expect(third.ok && third.structure.glue.size).toBe(glue);
  });

  it('the hub glue of a windmill running on a docking ship travels with the bearing into the WORLD and holds the hub when it stops', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue, true);
    const sr = s.mgr.assembleShip(HX, HY, HZ);
    if (!sr.ok) throw new Error(sr.reason);
    const ship = sr.structure;
    const rr = s.mgr.startRotor(ship.grid, BX, BY, BZ);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    // The face stays on the ship's bearing (a glueable block left behind) while the hub spins.
    expect(ship.glue.has(BX, BY, BZ, PZ)).toBe(true);
    expect(rotor.glue.size).toBe(0);
    for (let i = 0; i < 11; i++) s.mgr.step();
    poseExact(ship, -Math.PI / 2, vec3(3, 62, 7));
    expect(s.mgr.dockShip(ship).ok).toBe(true);
    const b = vec3(rotor.bearingX, rotor.bearingY, rotor.bearingZ);
    expect(s.mgr.startRotor(s.world, b.x, b.y, b.z)).toEqual({ ok: false, reason: 'has_rotor' });
    // Its other side (the hub's cell of the ship) was empty, so it travelled, turned with the bearing.
    const f = yawDir(4, 3);
    expect(s.host.worldGlue.has(b.x, b.y, b.z, f)).toBe(true);
    const glueBefore = s.host.worldGlue.size;
    s.mgr.stopRotor(rotor);
    expect(s.host.worldGlue.has(b.x, b.y, b.z, f)).toBe(true);
    expect(s.host.worldGlue.size).toBe(glueBefore);
    expect(s.world.getCell(b.x + DIR_X[f]!, b.y, b.z + DIR_Z[f]!)).toBe(c(B.CANVAS));
  });

  it('refuses a ship leaning more than 45 degrees', () => {
    const s = scene();
    const { ship } = shipWithRunningMill(s);
    const roll = (deg: number): void => {
      const q = qmul(qfromYaw(0.4), qfromAxisAngle(vec3(1, 0, 0), (deg * Math.PI) / 180));
      ship.grid.setPoseImmediate(ship.grid.position, q);
    };
    roll(50);
    expect(s.mgr.dockShip(ship)).toEqual({ ok: false, reason: 'tilted', conflicts: [] });
    expect(ship.removed).toBe(false);
    roll(-46);
    expect(s.mgr.dockConflicts(ship)).toEqual({ ok: false, reason: 'tilted', conflicts: [] });
    roll(44);
    expect(s.mgr.dockConflicts(ship).ok).toBe(true);
  });

  it('refuses when blocked and reports exactly the conflicting world cells; nothing changes', () => {
    const s = scene();
    const { ship, rotor } = shipWithRunningMill(s);
    poseExact(ship, Math.PI / 2, vec3(0, 62, 0));
    const deck = worldCentre(ship.grid, -3, 60, -3);
    const mast = worldCentre(ship.grid, 0, 63, -3);
    const rocks = [deck, mast].map((p) => vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    for (const r of rocks) s.world.setCell(r.x, r.y, r.z, c(B.STONE));
    const soft = worldCentre(ship.grid, -2, 60, -3);
    s.world.setCell(Math.floor(soft.x), Math.floor(soft.y), Math.floor(soft.z), c(B.FLOWER_RED)); // soft: no conflict
    const before = snapshotBox(s.world, -12, 55, -12, 12, 70, 12);
    const check = s.mgr.dockConflicts(ship);
    const res = s.mgr.dockShip(ship);
    expect(res).toEqual(check);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('blocked');
    expect(new Set(res.conflicts.map((p) => `${p.x},${p.y},${p.z}`))).toEqual(new Set(rocks.map((p) => `${p.x},${p.y},${p.z}`)));
    expect(snapshotBox(s.world, -12, 55, -12, 12, 70, 12)).toEqual(before);
    expect(ship.removed).toBe(false);
    expect(rotor.parent).toBe(ship);
    expect(s.host.released).toEqual([]);
  });

  it('ships that are not live report blocked without conflicts', () => {
    const s = scene();
    const { ship } = shipWithRunningMill(s);
    expect(s.mgr.dockShip(ship).ok).toBe(true);
    expect(s.mgr.dockShip(ship)).toEqual({ ok: false, reason: 'blocked', conflicts: [] });
    expect(s.mgr.dockConflicts(ship)).toEqual({ ok: false, reason: 'blocked', conflicts: [] });
  });
});

describe('dockShip liquids and soft blocks', () => {
  function openBoat(s: Scene): Ship {
    fill(s.world, -2, 44, -2, 2, 46, 2, c(B.PLANKS_OAK));
    fill(s.world, -1, 45, -1, 1, 46, 1, 0);
    s.world.setCell(0, 47, -2, facing(B.HELM, 5));
    const res = s.mgr.assembleShip(0, 47, -2);
    if (!res.ok) throw new Error(res.reason);
    return res.structure;
  }

  it('overwrites liquids and soft blocks (which drop), and drains the dry hold', () => {
    const s = scene();
    const ship = openBoat(s);
    expect(ship.grid.count).toBe(58);
    fill(s.world, -4, 44, -4, 4, 46, 4, WATER); // the boat docks back into a flooded dock
    s.world.setCell(2, 45, 0, c(B.FLOWER_RED));
    s.host.updates.length = 0;
    const res = s.mgr.dockShip(ship);
    expect(res).toEqual({ ok: true, report: { placed: 58, dropped: 0, overwritten: 57 } });
    expect(s.host.drops.map((d) => d.item)).toEqual([B.FLOWER_RED]);
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 45; y <= 46; y++) expect(s.world.getCell(x, y, z)).toBe(0);
    expect(s.world.getCell(3, 45, 0)).toBe(WATER); // outside the hull: untouched
    expect(s.world.getCell(2, 45, 0)).toBe(c(B.PLANKS_OAK));
    expect(s.host.updateKeys().size).toBe(58 + 18);
    expect(s.host.updateKeys().has('0,45,0')).toBe(true);
  });

  it('drops off (a creative world): overwritten soft blocks do not drop', () => {
    const s = scene();
    s.host.dropsEnabled = false;
    const ship = openBoat(s);
    s.world.setCell(2, 45, 0, c(B.TORCH));
    const res = s.mgr.dockShip(ship);
    expect(res.ok && res.report.overwritten).toBe(1);
    expect(s.host.drops).toEqual([]);
  });
});
