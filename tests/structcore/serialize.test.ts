import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { PX } from '../../src/core/dirs';
import { qfromAxisAngle, qfromYaw, qmul, qrotate, vec3, vsub } from '../../src/core/math';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';
import { Rotor, Ship, type Structure } from '../../src/structures/structure';
import type { StructureManager } from '../../src/structures/manager';
import { c, facing, fill, MILL_BEARING, millShip, scene, SHIP_HELM, windmill, type Scene } from './helpers';

const [BX, BY, BZ] = MILL_BEARING;

/** A plain, comparable description of every structure of a manager. */
function describeAll(mgr: StructureManager): unknown[] {
  return mgr.all().map((s: Structure) => {
    const g = s.grid;
    const cells: Array<[string, number]> = [];
    g.forEachCell((x, y, z, cell) => cells.push([`${x},${y},${z}`, cell]));
    const base = {
      kind: s.kind,
      id: s.id,
      parent: s.parent?.id ?? 0,
      gridParent: g.parent.gridId,
      children: s.children.map((r) => r.id),
      cells,
      glue: Array.from(s.glue.toArray()),
      pose: [g.pivot, g.position, g.rotation, g.prevPosition, g.prevRotation, g.linearVelocity, g.angularVelocity].map((v) => ({ ...v })),
    };
    if (s instanceof Rotor) {
      return {
        ...base,
        rotor: [s.bearingX, s.bearingY, s.bearingZ, s.axis, { ...s.baseRotation }, s.angle, s.angularSpeed, s.sails, s.hubGlue],
      };
    }
    const sh = s as Ship;
    return { ...base, ship: [sh.helmX, sh.helmY, sh.helmZ, sh.forward, sh.throttle, sh.rudder, sh.asleep, sh.restTicks] };
  });
}

/** World rotor + ship carrying a running windmill (re-gridded once by a dock / re-assemble) + glue everywhere. */
function busyScene(): Scene & { ship: Ship; shipRotor: Rotor; worldRotor: Rotor } {
  const s = scene();
  windmill(s.world, 15, 64, 15, 2);
  s.host.worldGlue.add(16, 64, 16, PX); // between two felt cells of the world windmill
  millShip(s.world, s.host.worldGlue, true); // hub glued: the stopped windmill joins the ship
  const wr = s.mgr.startRotor(s.world, 15, 64, 15);
  const sr0 = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
  if (!wr.ok || !sr0.ok) throw new Error('setup');
  const rr = s.mgr.startRotor(sr0.structure.grid, BX, BY, BZ);
  if (!rr.ok) throw new Error(rr.reason);
  for (let i = 0; i < 17; i++) s.mgr.step();
  // Dock rotated (helm centre exactly on cell (5,61,5)) and re-assemble, so the ship rotor
  // gets a non-trivial base rotation.
  const ship0 = sr0.structure;
  const q = qfromYaw(Math.PI / 2);
  const off = qrotate(q, vsub(vec3(SHIP_HELM[0] + 0.5, SHIP_HELM[1] + 0.5, SHIP_HELM[2] + 0.5), ship0.grid.pivot));
  ship0.grid.setPoseImmediate(vec3(5.5 - off.x, 61.5 - off.y, 5.5 - off.z), q);
  const d = s.mgr.dockShip(ship0);
  if (!d.ok) throw new Error('dock');
  const sr = s.mgr.assembleShip(5, 61, 5);
  if (!sr.ok) throw new Error(sr.reason);
  const ship = sr.structure;
  for (let i = 0; i < 6; i++) s.mgr.step();
  // Arbitrary ship state, prev pose different from the current one.
  ship.grid.snapshotPose();
  ship.grid.position.x += 0.37;
  ship.grid.position.y -= 0.21;
  qmul(qfromAxisAngle(vec3(0, 1, 0), 0.31), ship.grid.rotation, ship.grid.rotation);
  ship.grid.linearVelocity.x = 1.25;
  ship.grid.angularVelocity.y = -0.4;
  ship.throttle = 0.6;
  ship.rudder = -0.3;
  ship.helmsmanId = 5;
  ship.asleep = true;
  ship.restTicks = 12;
  return { ...s, ship, shipRotor: rr.structure, worldRotor: wr.structure };
}

function save(mgr: StructureManager): Uint8Array {
  const w = new ByteWriter();
  mgr.serialize(w);
  return w.finish();
}

describe('serialize / deserialize (ACCEPTANCE 23)', () => {
  it('a round trip restores every structure exactly, nesting, glue and angles included', () => {
    const a = busyScene();
    expect(a.shipRotor.parent).toBe(a.ship);
    expect(a.shipRotor.baseRotation.w).not.toBeCloseTo(1, 3);
    const bytes = save(a.mgr);
    const b = scene();
    const r = new ByteReader(bytes, 'structures');
    b.mgr.deserialize(r);
    expect(r.eof()).toBe(true);
    expect(describeAll(b.mgr)).toEqual(describeAll(a.mgr));
    // helmsman is not restored
    const ship = b.mgr.ships()[0]!;
    expect(ship.helmsmanId).toBe(0);
    // parent links and indexes rebuilt
    const rotorB = b.mgr.get(a.shipRotor.id) as Rotor;
    expect(rotorB.parent).toBe(ship);
    expect(rotorB.grid.parent).toBe(ship.grid);
    expect(ship.children).toEqual([rotorB]);
    expect(b.mgr.rotorAtBearing(ship.grid, rotorB.bearingX, rotorB.bearingY, rotorB.bearingZ)).toBe(rotorB);
    const worldB = b.mgr.get(a.worldRotor.id) as Rotor;
    expect(b.mgr.rotorAtBearing(b.world, 15, 64, 15)).toBe(worldB);
    // Same future: both managers step identically (and new ids continue the counter).
    for (let i = 0; i < 20; i++) {
      a.mgr.step();
      b.mgr.step();
    }
    expect(describeAll(b.mgr)).toEqual(describeAll(a.mgr));
    windmill(a.world, -20, 64, -20, 1);
    windmill(b.world, -20, 64, -20, 1);
    const na = a.mgr.startRotor(a.world, -20, 64, -20);
    const nb = b.mgr.startRotor(b.world, -20, 64, -20);
    expect(na.ok && nb.ok && na.structure.id === nb.structure.id).toBe(true);
    expect(save(b.mgr)).toEqual(save(a.mgr));
  });

  it('hooks work after loading: mining the loaded ship bearing stops its rotor', () => {
    const a = busyScene();
    const b = scene();
    b.mgr.deserialize(new ByteReader(save(a.mgr)));
    const rotor = b.mgr.get(a.shipRotor.id) as Rotor;
    const ship = rotor.parent as Ship;
    ship.grid.setCell(rotor.bearingX, rotor.bearingY, rotor.bearingZ, 0);
    expect(rotor.removed).toBe(true);
    expect(ship.children).toEqual([]);
  });

  it('loading replaces the current structures; an empty manager round-trips too', () => {
    const a = busyScene();
    const bytes = save(a.mgr);
    const empty = save(scene().mgr);
    a.mgr.deserialize(new ByteReader(empty));
    expect(a.mgr.all()).toEqual([]);
    expect(a.ship.removed).toBe(true);
    a.mgr.deserialize(new ByteReader(bytes));
    expect(a.mgr.all().length).toBe(3);
    expect(a.ship.removed).toBe(true); // the old objects stay dead; new ones replaced them
  });

  it('malformed data throws SaveFormatError and keeps the current structures', () => {
    const a = busyScene();
    const bytes = save(a.mgr);
    const b = busyScene();
    const before = describeAll(b.mgr);
    for (let n = 0; n < bytes.length; n += 13) {
      expect(() => b.mgr.deserialize(new ByteReader(bytes.subarray(0, n)))).toThrow(SaveFormatError);
    }
    const bad = bytes.slice();
    bad[0] = 9; // format
    expect(() => b.mgr.deserialize(new ByteReader(bad))).toThrow(SaveFormatError);
    expect(describeAll(b.mgr)).toEqual(before);
    expect(b.mgr.ships()[0]).toBe(b.ship);
  });
});

describe('independent managers (ACCEPTANCE 24, LESSONS 同种子开新世界)', () => {
  it('two managers on two worlds never see each other', () => {
    const build = (s: Scene): void => {
      fill(s.world, 0, 60, 0, 3, 60, 3, c(B.PLANKS_OAK));
      s.world.setCell(1, 61, 1, facing(B.HELM, 5));
      s.host.worldGlue.add(0, 60, 0, PX);
      windmill(s.world, 10, 64, 10, 1);
    };
    const a = scene({ seed: 5 });
    const b = scene({ seed: 5 });
    build(a);
    build(b);
    expect(a.mgr.assembleShip(1, 61, 1).ok).toBe(true);
    expect(a.mgr.startRotor(a.world, 10, 64, 10).ok).toBe(true);
    expect(b.mgr.all()).toEqual([]);
    expect(b.world.getCell(0, 60, 0)).toBe(c(B.PLANKS_OAK));
    expect(b.host.worldGlue.size).toBe(1);
    // B's world changes do not reach A's hooks, and vice versa.
    b.world.setCell(10, 64, 10, 0);
    expect(a.mgr.rotors()[0]!.removed).toBe(false);
    expect(b.mgr.startRotor(b.world, 10, 64, 10)).toEqual({ ok: false, reason: 'not_a_bearing' });
    expect(b.mgr.assembleShip(1, 61, 1).ok).toBe(true);
    expect(b.mgr.ships()[0]!.id).toBe(1);
  });

  it('a new world created afterwards starts clean; a disposed manager stops listening', () => {
    const a = busyScene();
    a.mgr.dispose();
    const rotor = a.worldRotor;
    a.world.setCell(15, 64, 15, 0); // the bearing: nobody listens any more
    expect(rotor.removed).toBe(false);
    const fresh = scene({ seed: 1 });
    expect(fresh.mgr.all()).toEqual([]);
    expect(fresh.host.worldGlue.size).toBe(0);
    fill(fresh.world, 0, 60, 0, 3, 60, 3, c(B.PLANKS_OAK));
    fresh.world.setCell(1, 61, 1, facing(B.HELM, 5));
    const res = fresh.mgr.assembleShip(1, 61, 1);
    expect(res.ok && res.structure.id).toBe(1);
  });

  it('clear() forgets everything and restarts ids', () => {
    const a = busyScene();
    a.mgr.clear();
    expect(a.mgr.all()).toEqual([]);
    expect(a.worldRotor.removed).toBe(true);
    windmill(a.world, -20, 64, -20, 1);
    const r = a.mgr.startRotor(a.world, -20, 64, -20);
    expect(r.ok && r.structure.id).toBe(1);
  });
});
