import { describe, expect, it } from 'vitest';
import { qfromYaw, qrotate, vec3, vsub } from '../../src/core/math';
import { applyRotorPose } from '../../src/structures/rotor';
import type { Rotor, Ship } from '../../src/structures/structure';
import { MILL_BEARING, millShip, scene, SHIP_HELM, worldCentre } from './helpers';

const [BX, BY, BZ] = MILL_BEARING;

function poseExact(ship: Ship, yaw: number, h: { x: number; y: number; z: number }): void {
  const q = qfromYaw(yaw);
  const off = qrotate(q, vsub(vec3(ship.helmX + 0.5, ship.helmY + 0.5, ship.helmZ + 0.5), ship.grid.pivot));
  ship.grid.setPoseImmediate(vec3(h.x + 0.5 - off.x, h.y + 0.5 - off.y, h.z + 0.5 - off.z), q);
}

describe('explore: docked rotor stop at exact angles lands where the blades are', () => {
  for (const k of [0, 1, 2, 3]) {
    for (const a of [0, 1, 2, 3]) {
      it(`yaw ${k * 90} angle ${a * 90}`, () => {
        const s = scene();
        millShip(s.world, s.host.worldGlue);
        const rr = s.mgr.startRotor(s.world, BX, BY, BZ);
        if (!rr.ok) throw new Error(rr.reason);
        const rotor: Rotor = rr.structure;
        const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
        if (!sr.ok) throw new Error(sr.reason);
        poseExact(sr.structure, (k * Math.PI) / 2, vec3(4, 62, -5));
        expect(s.mgr.dockShip(sr.structure).ok).toBe(true);
        rotor.angle = (a * Math.PI) / 2;
        applyRotorPose(rotor);
        const exp = new Map<string, number>();
        rotor.grid.forEachCell((x, y, z, cell) => {
          const w = worldCentre(rotor.grid, x, y, z);
          exp.set(`${Math.floor(w.x)},${Math.floor(w.y)},${Math.floor(w.z)}`, cell & 0x3ff);
        });
        const rep = s.mgr.stopRotor(rotor);
        expect(rep.placed).toBe(9);
        for (const [key, id] of exp) {
          const [x, y, z] = key.split(',').map(Number) as [number, number, number];
          expect(s.world.getCell(x, y, z) & 0x3ff).toBe(id);
        }
      });
    }
  }
});

describe('explore: ship rotor on a posed ship lands where the blades are (ship-local)', () => {
  for (const yaw of [0, 0.7, Math.PI / 2, 2.3]) {
    for (const a of [0, 1, 2, 3]) {
      it(`ship yaw ${yaw} angle ${a * 90}`, () => {
        const s = scene();
        millShip(s.world, s.host.worldGlue, true);
        const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
        if (!sr.ok) throw new Error(sr.reason);
        const ship = sr.structure;
        const rr = s.mgr.startRotor(ship.grid, BX, BY, BZ);
        if (!rr.ok) throw new Error(rr.reason);
        const rotor = rr.structure;
        ship.grid.setPoseImmediate(vec3(ship.grid.position.x + 3, ship.grid.position.y + 1, ship.grid.position.z - 2), qfromYaw(yaw));
        rotor.angle = (a * Math.PI) / 2;
        applyRotorPose(rotor);
        const exp = new Map<string, number>();
        rotor.grid.forEachCell((x, y, z, cell) => {
          const p = rotor.grid.toParent(vec3(x + 0.5, y + 0.5, z + 0.5));
          exp.set(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`, cell & 0x3ff);
        });
        const rep = s.mgr.stopRotor(rotor);
        expect(rep.placed).toBe(9);
        for (const [key, id] of exp) {
          const [x, y, z] = key.split(',').map(Number) as [number, number, number];
          expect(ship.grid.getCell(x, y, z) & 0x3ff).toBe(id);
        }
      });
    }
  }
});
