import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { TICK_DT } from '../../src/core/constants';
import { NZ, PX, PZ } from '../../src/core/dirs';
import { qfromAxisAngle, qmul, vec3, vsub } from '../../src/core/math';
import { SET_EXPLOSION } from '../../src/voxel/grid';
import {
  applyRotorPose,
  rotorAcceleration,
  rotorTargetSpeed,
  ROTOR_SPEED_MAX,
  ROTOR_SPEED_MIN,
  ROTOR_SPINUP_SECONDS,
} from '../../src/structures/rotor';
import { Rotor } from '../../src/structures/structure';
import { c, cellMap, facing, fill, log, rotZ, scene, WATER, windmill, worldCentre } from './helpers';

const BX = 0;
const BY = 64;
const BZ = 0;

/** Windmill on a world bearing at (0,64,0) facing +Z, with a log glued to the tip of the +X arm. */
function millScene(arm = 3) {
  const s = scene();
  const hub = windmill(s.world, BX, BY, BZ, arm);
  s.world.setCell(BX + arm + 1, BY, BZ + 1, log(0)); // log along X at the end of the +X arm
  s.host.worldGlue.add(BX + arm, BY, BZ + 1, PX);
  return { ...s, hub };
}

function started(s: ReturnType<typeof millScene>): Rotor {
  const res = s.mgr.startRotor(s.world, BX, BY, BZ);
  if (!res.ok) throw new Error(res.reason);
  return res.structure;
}

/** Expected world cells of the default mill (arm 3 + log) after k quarter turns about +Z. */
function expectedMill(k: number): Map<string, number> {
  const m = new Map<string, number>();
  const put = (dx: number, dy: number, cell: number): void => {
    const [rx, ry] = rotZ(dx, dy, k);
    m.set(`${BX + rx},${BY + ry},${BZ + 1}`, cell);
  };
  put(0, 0, c(B.CANVAS));
  for (let i = 1; i <= 3; i++) {
    put(i, 0, c(B.WOOL_RED));
    put(-i, 0, c(B.WOOL_BLUE));
    put(0, i, c(B.WOOL_WHITE));
    put(0, -i, c(B.WOOL_YELLOW));
  }
  put(4, 0, log(k % 2 === 0 ? 0 : 1)); // the log's axis turns with it
  return m;
}

function setAngle(rotor: Rotor, angle: number): void {
  rotor.angle = angle;
  applyRotorPose(rotor);
}

describe('rotorTargetSpeed', () => {
  it('grows mildly from 0.5 rad/s at 4 sails to 1.0 rad/s at 40+', () => {
    expect(rotorTargetSpeed(4)).toBeCloseTo(ROTOR_SPEED_MIN, 12);
    expect(rotorTargetSpeed(40)).toBeCloseTo(ROTOR_SPEED_MAX, 12);
    expect(rotorTargetSpeed(400)).toBeCloseTo(ROTOR_SPEED_MAX, 12);
    expect(rotorTargetSpeed(0)).toBe(0);
    expect(rotorTargetSpeed(2)).toBeCloseTo(0.25, 12);
    let prev = 0;
    for (let n = 1; n <= 60; n++) {
      const v = rotorTargetSpeed(n);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(rotorTargetSpeed(13)).toBeGreaterThan(0.6);
    expect(rotorTargetSpeed(13)).toBeLessThan(0.8);
  });
});

describe('startRotor', () => {
  it('moves the rotor cells (not the bearing or its support) and their glue into a new rotor', () => {
    const s = millScene();
    const before = cellMap(s.world, [-5, 60, -2, 5, 68, 2]);
    const res = s.mgr.startRotor(s.world, BX, BY, BZ);
    if (!res.ok) throw new Error(res.reason);
    const r = res.structure;
    expect(r.parent).toBeNull();
    expect(r.grid.parent).toBe(s.world);
    expect(r.grid.count).toBe(14);
    expect(r.sails).toBe(13);
    expect(r.axis).toBe(PZ);
    expect([r.bearingX, r.bearingY, r.bearingZ]).toEqual([BX, BY, BZ]);
    expect(r.grid.pivot).toEqual(vec3(0.5, 64.5, 1.5));
    expect(r.grid.position).toEqual(r.grid.pivot);
    expect(r.grid.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(r.angle).toBe(0);
    expect(r.angularSpeed).toBe(0);
    expect(cellMap(r.grid)).toEqual(expectedMill(0));
    // The bearing and its support stay in the world, everything in front left.
    expect(s.world.getCell(BX, BY, BZ)).toBe(facing(B.BEARING, PZ));
    expect(s.world.getCell(BX, BY, BZ - 1)).toBe(c(B.PLANKS_OAK));
    for (const key of expectedMill(0).keys()) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      expect(s.world.getCell(x, y, z)).toBe(0);
    }
    expect(r.glue.has(BX + 3, BY, BZ + 1, PX)).toBe(true);
    expect(s.host.worldGlue.size).toBe(0);
    expect(s.mgr.rotorAtBearing(s.world, BX, BY, BZ)).toBe(r);
    expect(s.mgr.rotorAtBearing(s.world, BX, BY, BZ + 1)).toBeNull();
    expect(s.host.updateKeys()).toEqual(new Set(expectedMill(0).keys()));
    expect(before.size).toBe(16);
  });

  it('refuses a second rotor on the same bearing, nested rotors and non-bearings', () => {
    const s = millScene();
    const r = started(s);
    expect(s.mgr.startRotor(s.world, BX, BY, BZ)).toEqual({ ok: false, reason: 'has_rotor' });
    expect(s.mgr.startRotor(r.grid, 0, 64, 1)).toEqual({ ok: false, reason: 'nested_rotor' });
    expect(s.mgr.startRotor(s.world, BX, BY, BZ - 1)).toEqual({ ok: false, reason: 'not_a_bearing' });
    const other = scene();
    expect(s.mgr.startRotor(other.world, BX, BY, BZ)).toEqual({ ok: false, reason: 'not_world' });
  });

  it('refuses a rotor with too few sails and leaves the world alone', () => {
    const s = scene();
    windmill(s.world, BX, BY, BZ, 3);
    for (let i = 1; i <= 3; i++) {
      s.world.setCell(BX + i, BY, BZ + 1, c(B.PLANKS_OAK));
      s.world.setCell(BX - i, BY, BZ + 1, c(B.PLANKS_OAK));
      s.world.setCell(BX, BY + i, BZ + 1, c(B.PLANKS_OAK));
      if (i > 1) s.world.setCell(BX, BY - i, BZ + 1, c(B.PLANKS_OAK));
    }
    // canvas hub + 1 yellow felt: planks do not stick to cloth
    expect(s.mgr.startRotor(s.world, BX, BY, BZ)).toEqual({ ok: false, reason: 'not_enough_sails' });
    expect(s.world.getCell(BX, BY, BZ + 1)).toBe(c(B.CANVAS));
  });

  it('a submerged rotor leaves water behind (water wheel)', () => {
    const s = scene();
    fill(s.world, -6, 55, -2, 6, 60, 3, c(B.STONE));
    fill(s.world, -6, 61, -2, 6, 62, 3, WATER);
    windmill(s.world, BX, 64, BZ, 3); // lowest arm cell y = 61
    const r = s.mgr.startRotor(s.world, BX, 64, BZ);
    expect(r.ok).toBe(true);
    expect(s.world.getCell(BX, 61, BZ + 1)).toBe(WATER);
    expect(s.world.getCell(BX, 62, BZ + 1)).toBe(WATER);
    expect(s.world.getCell(BX, 63, BZ + 1)).toBe(0);
  });
});

describe('rotor kinematics', () => {
  it('spins up over ~2 s to the target speed, angle integrates the speed', () => {
    const s = millScene();
    const r = started(s);
    const target = rotorTargetSpeed(13);
    expect(r.editable).toBe(true);
    s.mgr.step();
    expect(r.editable).toBe(false);
    expect(r.angularSpeed).toBeCloseTo(rotorAcceleration(target) * TICK_DT, 12);
    let angle = r.angle;
    const ticks = Math.round(ROTOR_SPINUP_SECONDS / TICK_DT);
    for (let i = 1; i < ticks - 1; i++) {
      s.mgr.step();
      angle += r.angularSpeed * TICK_DT;
    }
    expect(r.angularSpeed).toBeLessThan(target);
    s.mgr.step();
    s.mgr.step();
    expect(r.angularSpeed).toBe(target);
    expect(r.grid.linearVelocity).toEqual(vec3());
    expect(r.grid.angularVelocity.z).toBeCloseTo(target, 12);
    expect(r.grid.position).toEqual(r.grid.pivot);
    // Invariant: rotation == base * axisAngle(axis, angle).
    const q = qmul(r.baseRotation, qfromAxisAngle(vec3(0, 0, 1), r.angle));
    expect(Math.abs(q.x * r.grid.rotation.x + q.y * r.grid.rotation.y + q.z * r.grid.rotation.z + q.w * r.grid.rotation.w)).toBeCloseTo(1, 12);
    expect(angle).toBeGreaterThan(0);
  });

  it('velocityAt at a blade tip matches the finite difference of its positions', () => {
    const s = millScene();
    const r = started(s);
    for (let i = 0; i < 50; i++) s.mgr.step();
    const tip = (): ReturnType<typeof worldCentre> => worldCentre(r.grid, BX + 3, BY, BZ + 1);
    const p0 = tip();
    s.mgr.step();
    const p1 = tip();
    const v = r.grid.velocityAt(p1);
    s.mgr.step();
    const p2 = tip();
    const fd = vsub(p2, p0);
    expect(v.x).toBeCloseTo(fd.x / (2 * TICK_DT), 2);
    expect(v.y).toBeCloseTo(fd.y / (2 * TICK_DT), 2);
    expect(v.z).toBeCloseTo(fd.z / (2 * TICK_DT), 2);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(3 * r.angularSpeed, 1);
  });

  it('a rotor that loses its sails coasts down to an exact stop', () => {
    const s = millScene(1);
    const r = started(s);
    for (let i = 0; i < 40; i++) s.mgr.step();
    expect(r.angularSpeed).toBeGreaterThan(0);
    // Explosion strips every sail but the hub (rotor cells can be destroyed).
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) r.grid.setCell(x, BY + y, BZ + 1, 0, SET_EXPLOSION);
    expect(r.sails).toBe(1);
    for (let i = 0; i < 200; i++) s.mgr.step();
    expect(r.angularSpeed).toBe(rotorTargetSpeed(1));
    r.grid.setCell(0, BY, BZ + 1, c(B.PLANKS_OAK)); // the canvas hub replaced: no sail at all
    expect(r.sails).toBe(0);
    for (let i = 0; i < 200; i++) s.mgr.step();
    expect(r.angularSpeed).toBe(0);
    expect(r.editable).toBe(true);
  });
});

describe('stopRotor (blockify in place, ACCEPTANCE 10)', () => {
  for (const [angle, k] of [
    [Math.PI / 2, 1],
    [Math.PI, 2],
    [-Math.PI / 2, 3],
    [0.3, 0],
    [1.0, 1],
    [2.0, 1],
    [2.5, 2],
    [-1.2, 3],
    [Math.PI / 4 - 0.01, 0],
  ] as const) {
    it(`angle ${angle.toFixed(3)} snaps to ${k} quarter turn(s); cells, log axis and glue rotate`, () => {
      const s = millScene();
      const r = started(s);
      setAngle(r, angle);
      s.host.updates.length = 0;
      const rep = s.mgr.stopRotor(r);
      expect(rep).toEqual({ placed: 14, dropped: 0, overwritten: 0 });
      expect(r.removed).toBe(true);
      expect(s.mgr.rotors()).toEqual([]);
      expect(s.mgr.rotorAtBearing(s.world, BX, BY, BZ)).toBeNull();
      expect(cellMap(s.world, [-6, 58, 1, 6, 70, 2])).toEqual(expectedMill(k));
      // The glue between the arm tip and the log rotated with them.
      const [ax, ay] = rotZ(3, 0, k);
      const [lx, ly] = rotZ(4, 0, k);
      const dir = lx !== ax ? (lx > ax ? 0 : 1) : ly > ay ? 2 : 3;
      expect(s.host.worldGlue.has(BX + ax, BY + ay, BZ + 1, dir as 0 | 1 | 2 | 3)).toBe(true);
      expect(s.host.worldGlue.size).toBe(1);
      expect(s.host.updateKeys()).toEqual(new Set(expectedMill(k).keys()));
      expect(s.host.released).toContain(r);
      expect(s.host.drops).toEqual([]);
    });
  }

  it('hard destinations drop the rotor cell; soft ones are overwritten and drop; liquids just vanish', () => {
    const s = millScene();
    const r = started(s);
    // After a quarter turn the +X arm (red) lands on the column above the hub.
    s.world.setCell(BX, BY + 2, BZ + 1, c(B.STONE)); // hard: red felt at +2 drops
    s.world.setCell(BX, BY + 3, BZ + 1, c(B.FLOWER_RED)); // soft: overwritten, flower drops
    s.world.setCell(BX, BY + 1, BZ + 1, WATER); // liquid: overwritten, no drop
    setAngle(r, Math.PI / 2 + 0.2);
    const rep = s.mgr.stopRotor(r);
    expect(rep).toEqual({ placed: 13, dropped: 1, overwritten: 2 });
    expect(s.world.getCell(BX, BY + 2, BZ + 1)).toBe(c(B.STONE));
    expect(s.world.getCell(BX, BY + 3, BZ + 1)).toBe(c(B.WOOL_RED));
    expect(s.world.getCell(BX, BY + 1, BZ + 1)).toBe(c(B.WOOL_RED));
    const drops = s.host.drops.map((d) => `${d.item}@${d.x},${d.y},${d.z}`).sort();
    expect(drops).toEqual([`${B.FLOWER_RED}@0.5,67.5,1.5`, `${B.WOOL_RED}@0.5,66.5,1.5`].sort());
  });

  it('creative mode: nothing drops', () => {
    const s = millScene();
    s.host.creative = true;
    const r = started(s);
    s.world.setCell(BX, BY + 2, BZ + 1, c(B.STONE));
    s.world.setCell(BX, BY + 3, BZ + 1, c(B.TORCH));
    setAngle(r, Math.PI / 2);
    expect(s.mgr.stopRotor(r)).toEqual({ placed: 13, dropped: 1, overwritten: 1 });
    expect(s.host.drops).toEqual([]);
  });

  it('cells above the build height drop instead of vanishing', () => {
    const s = scene();
    windmill(s.world, BX, 125, BZ, 4); // the top arm would reach y = 129: only 126..127 exist
    const res = s.mgr.startRotor(s.world, BX, 125, BZ);
    if (!res.ok) throw new Error(res.reason);
    const r = res.structure;
    expect(r.grid.count).toBe(1 + 4 * 4 - 2);
    setAngle(r, Math.PI / 2); // the +X arm (x = 1..4) swings up to y = 126..129
    const rep = s.mgr.stopRotor(r);
    expect(rep).toEqual({ placed: 13, dropped: 2, overwritten: 0 });
    expect(s.host.drops.map((d) => d.y).sort()).toEqual([128.5, 129.5]);
    expect(s.host.drops.every((d) => d.item === B.WOOL_RED)).toBe(true);
  });

  it('stopRotor on a removed rotor is a no-op', () => {
    const s = millScene();
    const r = started(s);
    s.mgr.stopRotor(r);
    expect(s.mgr.stopRotor(r)).toEqual({ placed: 0, dropped: 0, overwritten: 0 });
  });
});

describe('hub glue (ACCEPTANCE 14)', () => {
  for (const angle of [0, 1.3, Math.PI, -2.0]) {
    it(`glue between bearing and hub survives a start / stop at angle ${angle}`, () => {
      const s = millScene();
      s.host.worldGlue.add(BX, BY, BZ, PZ);
      const r = started(s);
      expect(r.hubGlue).toBe(true);
      expect(s.host.worldGlue.has(BX, BY, BZ, PZ)).toBe(false);
      for (let i = 0; i < 7; i++) s.mgr.step();
      setAngle(r, angle);
      s.mgr.stopRotor(r);
      expect(s.host.worldGlue.has(BX, BY, BZ, PZ)).toBe(true);
      expect(s.host.worldGlue.size).toBe(2);
    });
  }

  it('no glue is invented when there was none, nor restored when the hub dropped', () => {
    const s = millScene();
    const r = started(s);
    s.mgr.stopRotor(r);
    expect(s.host.worldGlue.has(BX, BY, BZ, PZ)).toBe(false);

    const t = millScene();
    t.host.worldGlue.add(BX, BY, BZ, PZ);
    const r2 = started(t);
    r2.grid.setCell(BX, BY, BZ + 1, 0, SET_EXPLOSION); // hub blown away
    t.mgr.stopRotor(r2);
    expect(t.host.worldGlue.has(BX, BY, BZ, PZ)).toBe(false);
  });
});

describe('bearing lost (ACCEPTANCE 11)', () => {
  it('mining the bearing blockifies the rotor in place immediately', () => {
    const s = millScene();
    const r = started(s);
    for (let i = 0; i < 25; i++) s.mgr.step();
    const k = Math.round(r.angle / (Math.PI / 2));
    s.world.setCell(BX, BY, BZ, 0);
    expect(r.removed).toBe(true);
    expect(s.mgr.rotors().length).toBe(0);
    expect(cellMap(s.world, [-6, 58, 1, 6, 70, 2])).toEqual(expectedMill(k));
  });

  it('an explosion (no batch) and replacing the bearing do the same; rotating it too', () => {
    for (const replacement of [0, c(B.STONE), facing(B.BEARING, NZ)]) {
      const s = millScene();
      const r = started(s);
      s.world.setCell(BX, BY, BZ, replacement, SET_EXPLOSION);
      expect(r.removed).toBe(true);
      expect(s.world.getCell(BX, BY, BZ + 1)).toBe(c(B.CANVAS));
    }
  });

  it('unrelated world changes leave the rotor alone', () => {
    const s = millScene();
    const r = started(s);
    s.world.setCell(BX, BY, BZ - 1, 0); // the support behind the bearing
    s.world.setCell(BX + 5, BY, BZ, facing(B.BEARING, PX));
    s.world.setCell(BX + 5, BY, BZ, 0);
    expect(r.removed).toBe(false);
  });
});
