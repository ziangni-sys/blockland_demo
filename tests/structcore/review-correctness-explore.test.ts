import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../../src/core/dirs';
import { qfromAxisAngle, qfromYaw, qmul, vec3 } from '../../src/core/math';
import { applyRotorPose } from '../../src/structures/rotor';
import type { Rotor } from '../../src/structures/structure';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { c, cellMap, facing, fill, loadArea, scene, worldCentre } from './helpers';

/** Rotate integer vector v about axis direction `a` by k quarter turns (right-handed). */
function rotAbout(a: Dir, k: number, v: [number, number, number]): [number, number, number] {
  let [x, y, z] = v;
  const q = ((k % 4) + 4) % 4;
  const ax = DIR_X[a]!;
  const ay = DIR_Y[a]!;
  const az = DIR_Z[a]!;
  for (let i = 0; i < q; i++) {
    // v' = a (a.v) + a x v  (90 deg: cos=0, sin=1)
    const d = ax * x + ay * y + az * z;
    const cx = ay * z - az * y;
    const cy = az * x - ax * z;
    const cz = ax * y - ay * x;
    [x, y, z] = [ax * d + cx, ay * d + cy, az * d + cz];
  }
  return [x, y, z];
}

describe('explore: rotors of every facing at negative coords across chunk borders', () => {
  const facings: Dir[] = [0, 1, 2, 3, 4, 5];
  for (const f of facings) {
    for (const angle of [0.2, 1.4, 2.9, -1.7, -0.9]) {
      it(`facing ${f} angle ${angle}`, () => {
        const s = scene();
        const bx = -16;
        const by = 64;
        const bz = -1;
        // support behind
        s.world.setCell(bx - DIR_X[f]!, by - DIR_Y[f]!, bz - DIR_Z[f]!, c(B.PLANKS_OAK));
        s.world.setCell(bx, by, bz, facing(B.BEARING, f));
        const hx = bx + DIR_X[f]!;
        const hy = by + DIR_Y[f]!;
        const hz = bz + DIR_Z[f]!;
        // two perpendicular directions
        const perp: Dir[] = ([0, 1, 2, 3, 4, 5] as Dir[]).filter((d) => d >> 1 !== f >> 1);
        s.world.setCell(hx, hy, hz, c(B.CANVAS));
        const expected = new Map<string, number>();
        expected.set('0,0,0', c(B.CANVAS));
        for (const p of perp) {
          for (let i = 1; i <= 3; i++) {
            const cell = c(B.WOOL_RED + p);
            s.world.setCell(hx + DIR_X[p]! * i, hy + DIR_Y[p]! * i, hz + DIR_Z[p]! * i, cell);
            expected.set(`${DIR_X[p]! * i},${DIR_Y[p]! * i},${DIR_Z[p]! * i}`, cell);
          }
        }
        // a log sticking forward from the +perp[0] tip, glued
        const p0 = perp[0]!;
        const tip: [number, number, number] = [hx + DIR_X[p0]! * 3, hy + DIR_Y[p0]! * 3, hz + DIR_Z[p0]! * 3];
        const res = s.mgr.startRotor(s.world, bx, by, bz);
        if (!res.ok) throw new Error(res.reason);
        const r = res.structure;
        r.angle = angle;
        applyRotorPose(r);
        // record world centres before stop
        const before = new Map<string, ReturnType<typeof worldCentre>>();
        r.grid.forEachCell((x, y, z) => before.set(`${x},${y},${z}`, worldCentre(r.grid, x, y, z)));
        const k = Math.round(angle / (Math.PI / 2));
        const rep = s.mgr.stopRotor(r);
        expect(rep.placed).toBe(13);
        for (const [key, cell] of expected) {
          const v = key.split(',').map(Number) as [number, number, number];
          const [rx, ry, rz] = rotAbout(f, k, v);
          expect(s.world.getCell(hx + rx, hy + ry, hz + rz)).toBe(cell);
        }
        void tip;
      });
    }
  }
});

describe('explore: dock -> serialize -> deserialize -> stop', () => {
  it('works', () => {
    const s = scene();
    fill(s.world, -3, 60, -3, 3, 60, 3, c(B.PLANKS_OAK));
    s.world.setCell(0, 61, 2, facing(B.HELM, 5));
    fill(s.world, 0, 61, -3, 0, 65, -3, c(B.PLANKS_PINE));
    s.world.setCell(0, 65, -2, facing(B.BEARING, 4));
    s.world.setCell(0, 65, -1, c(B.CANVAS));
    for (let i = 1; i <= 2; i++) {
      s.world.setCell(i, 65, -1, c(B.WOOL_RED));
      s.world.setCell(-i, 65, -1, c(B.WOOL_RED));
      s.world.setCell(0, 65 + i, -1, c(B.WOOL_RED));
      s.world.setCell(0, 65 - i, -1, c(B.WOOL_RED));
    }
    s.host.worldGlue.add(0, 65, -2, 4);
    const rr = s.mgr.startRotor(s.world, 0, 65, -2);
    if (!rr.ok) throw new Error(rr.reason);
    for (let i = 0; i < 13; i++) s.mgr.step();
    const sr = s.mgr.assembleShip(0, 61, 2);
    if (!sr.ok) throw new Error(sr.reason);
    const ship = sr.structure;
    ship.grid.setPoseImmediate(vec3(ship.grid.position.x + 5.3, ship.grid.position.y, ship.grid.position.z - 2.2), qfromYaw(Math.PI / 2 + 0.02));
    for (let i = 0; i < 5; i++) s.mgr.step();
    const d = s.mgr.dockShip(ship);
    expect(d.ok).toBe(true);
    const w = new ByteWriter();
    s.mgr.serialize(w);
    const t = scene();
    // copy world
    for (const [k, ch] of s.world.chunks) void k, t.world.getChunk(ch.cx, ch.cz)!.cells.set(ch.cells);
    for (let i = 0; i < 1; i++) void 0;
    t.mgr.deserialize(new ByteReader(w.finish()));
    const ra = rr.structure;
    const rb = t.mgr.get(ra.id) as Rotor;
    expect(rb).toBeDefined();
    for (let i = 0; i < 7; i++) {
      s.mgr.step();
      t.mgr.step();
    }
    expect(rb.angle).toBe(ra.angle);
    const repA = s.mgr.stopRotor(ra);
    const repB = t.mgr.stopRotor(rb);
    expect(repB).toEqual(repA);
    expect(cellMap(t.world, [-20, 55, -20, 20, 75, 20])).toEqual(cellMap(s.world, [-20, 55, -20, 20, 75, 20]));
    void loadArea;
    void qmul;
    void qfromAxisAngle;
  });
});
