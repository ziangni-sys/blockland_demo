/**
 * Package 5: ClientReplica's sample rings and derived data on crafted messages (NETCODE sections
 * 5, 7, 8): poses from batches as samples of their tick, samples waiting for a spawn and the ones a
 * spawn drops, the pivot conversion, interpolation in the carrier's frame, removal of a carrier
 * (ship and rotor on a ship), rotors extrapolated with advanceRotor, the helm readings and the time
 * of day.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { DAY_TICKS, TICK_DT } from '../../src/core/constants';
import { qfromAxisAngle, qrotate, quat, vec3, wrapAngle, type Quat, type Vec3 } from '../../src/core/math';
import { ClientReplica } from '../../src/net/client/replica';
import { decodeServerMessage, encodeServerMessage } from '../../src/net/codec';
import { emptyTickBatch, type EntitySample, type SamplesMsg, type StructureRecord, type TickBatchMsg } from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE } from '../../src/net/transport';
import { advanceRotor } from '../../src/structures/rotor';
import { Rotor } from '../../src/structures/structure';
import { World } from '../../src/voxel/world';
import { FlatGenerator } from '../../src/worldgen/generator';
import { syncSource } from './harness';

const STONE = makeCell(B.STONE);
const WOOL = makeCell(B.STONE);
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

function replica(): ClientReplica {
  const r = new ClientReplica(syncSource(new FlatGenerator()));
  r.applyWelcome({ type: 'welcome', entityId: 99, generator: { kind: 'void', seed: 0 }, worldTime: 0, dayOffset: 0, rules: { defaultMode: 'creative', dropsEnabled: false }, isHost: false, roomOpen: false, players: [] });
  return r;
}

function batch(tick: number, fill: (b: TickBatchMsg) => void = () => {}): TickBatchMsg {
  const b = emptyTickBatch(tick);
  fill(b);
  const m = decodeServerMessage(encodeServerMessage(b), RELIABLE);
  if (m.type !== 'tickBatch') throw new Error('not a batch');
  return m;
}

function samples(tick: number, seq: number, ships: Array<[number, Vec3, Quat]>, entities: EntitySample[] = []): SamplesMsg {
  const m = decodeServerMessage(encodeServerMessage({ type: 'samples', tick, seq, ships: ships.map(([id, pos, rot]) => ({ id, pose: { pos, rot } })), entities }), UNRELIABLE);
  if (m.type !== 'samples') throw new Error('not samples');
  return m;
}

function shipRecord(id: number, pos: Vec3, rot: Quat = IDENTITY, pivot: Vec3 = { x: 1.5, y: 0.5, z: 0.5 }): StructureRecord {
  return {
    kind: 'ship',
    id,
    parentId: 0,
    minX: 0,
    minY: 0,
    minZ: 0,
    sx: 3,
    sy: 1,
    sz: 1,
    cells: new Uint16Array([STONE, STONE, STONE]),
    pivot,
    position: pos,
    rotation: rot,
    glue: new Int32Array(0),
    helm: { x: 1, y: 0, z: 0 },
    forward: 5,
    throttle: 0.5,
    rudder: -0.25,
    helmsmanId: 0,
  };
}

function rotorRecord(id: number, parentId: number, o: { angle: number; speed: number; sails: number; frozen?: boolean }): StructureRecord {
  return {
    kind: 'rotor',
    id,
    parentId,
    minX: 0,
    minY: 1,
    minZ: 0,
    sx: 1,
    sy: 4,
    sz: 1,
    cells: new Uint16Array([WOOL, WOOL, WOOL, WOOL]),
    pivot: { x: 0.5, y: 1.5, z: 0.5 },
    position: { x: 0.5, y: 1.5, z: 0.5 },
    rotation: qfromAxisAngle(vec3(0, 0, 1), o.angle),
    glue: new Int32Array(0),
    bearing: { x: 0, y: 0, z: 0 },
    axis: 4,
    baseRotation: IDENTITY,
    angle: o.angle,
    angularSpeed: o.speed,
    sails: o.sails,
    frozen: o.frozen ?? false,
  };
}

const yawQ = (a: number): Quat => qfromAxisAngle(vec3(0, 1, 0), a);
const rabbitSample = (id: number, carrierId: number, pos: Vec3, yaw = 0): EntitySample => ({ id, kind: 'rabbit', carrierId, pos, yaw, look: null });

function near(a: Vec3, b: Vec3, tol = 2 / 512): void {
  expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBeLessThan(tol);
}

function shipAt(r: ClientReplica, id: number, tick: number): Vec3 {
  const p = vec3();
  expect(r.shipPoseAt(id, tick, p, quat())).toBe(true);
  return p;
}

describe('ClientReplica sample rings (package 5)', () => {
  it('poses of the batch are samples of its tick; samples interpolate at renderTick and hold at the ends', () => {
    const r = replica();
    r.applyBatch(batch(10, (b) => b.structureSpawns.push(shipRecord(1, { x: 0, y: 40, z: 0 }))));
    r.applySamples(samples(11, 0, [[1, { x: 1, y: 40, z: 0 }, IDENTITY]]));
    r.applySamples(samples(12, 1, [[1, { x: 2, y: 40, z: 0 }, IDENTITY]]));
    r.applyBatch(batch(11));
    r.applyBatch(batch(12));
    // Helm speed while moving: between the two newest samples.
    expect(r.helm(1)!.speed).toBeCloseTo(1 / TICK_DT, 3);
    r.applyBatch(batch(13, (b) => b.structureRests.push({ id: 1, pose: { pos: { x: 2.5, y: 40, z: 0 }, rot: IDENTITY } })));
    near(shipAt(r, 1, 9), { x: 0, y: 40, z: 0 });
    near(shipAt(r, 1, 10.5), { x: 0.5, y: 40, z: 0 });
    near(shipAt(r, 1, 12.5), { x: 2.25, y: 40, z: 0 });
    near(shipAt(r, 1, 20), { x: 2.5, y: 40, z: 0 });
    // setPoses writes the display pose into the grid; the latest server pose stays in state.
    r.setPoses(11.5, 11.5);
    const g = r.state.structures.get(1)!.structure.grid;
    near(g.position, { x: 1.5, y: 40, z: 0 });
    expect(g.linearVelocity.x).toBeCloseTo(1 / TICK_DT, 6);
    near(r.state.structures.get(1)!.pose.pos, { x: 2.5, y: 40, z: 0 });
    // Helm readings: fields; the newest sample is a rest, so the speed reads 0.
    const h = r.helm(1)!;
    expect(h.throttle).toBe(0.5);
    expect(h.rudder).toBe(-0.25);
    expect(h.speed).toBe(0);
  });

  it('helm speed is 0 after a rest even when the last moving sample before it was lost', () => {
    const r = replica();
    r.applyBatch(batch(10, (b) => b.structureSpawns.push(shipRecord(1, { x: 100, y: 10, z: 0 }))));
    r.applySamples(samples(11, 1, [[1, { x: 100.4, y: 10, z: 0 }, IDENTITY]]));
    // Sample 12 (x = 100.8) is lost; batch 13 carries the rest with the pose of tick 12.
    r.applyBatch(batch(11));
    r.applyBatch(batch(12));
    // Positions are quantised to 1/512 of a block.
    expect(Math.abs(r.helm(1)!.speed - 0.4 / TICK_DT)).toBeLessThan(2 / 512 / TICK_DT);
    r.applyBatch(batch(13, (b) => b.structureRests.push({ id: 1, pose: { pos: { x: 100.8, y: 10, z: 0 }, rot: IDENTITY } })));
    for (let t = 14; t < 60; t++) r.applyBatch(batch(t));
    expect(r.helm(1)!.speed).toBe(0);
    // Moving again: the speed comes back from the samples (the ship lay still at the rest's pose until tick 59).
    r.applySamples(samples(60, 2, [[1, { x: 101.3, y: 10, z: 0 }, IDENTITY]]));
    expect(Math.abs(r.helm(1)!.speed - 0.5 / TICK_DT)).toBeLessThan(2 / 512 / TICK_DT);
  });

  it('after a rest the motion starts in the tick before the next sample, not stretched over the pause (ships and entities)', () => {
    const r = replica();
    r.applyBatch(
      batch(10, (b) => {
        b.structureSpawns.push(shipRecord(1, { x: 0, y: 40, z: 0 }));
        b.entitySpawns.push({ id: 7, kind: 'rabbit', carrierId: 0, pos: { x: 50, y: 40, z: 0 }, yaw: 0 });
      }),
    );
    r.applySamples(samples(11, 0, [[1, { x: 1, y: 40, z: 0 }, IDENTITY]], [rabbitSample(7, 0, { x: 51, y: 40, z: 0 }, 0.5)]));
    // Both stop in tick 12: the final poses come in the batch (rest / final state).
    r.applyBatch(batch(11));
    r.applyBatch(
      batch(12, (b) => {
        b.structureRests.push({ id: 1, pose: { pos: { x: 2, y: 40, z: 0 }, rot: IDENTITY } });
        b.entityUpdates.push({ id: 7, final: { kind: 'rabbit', carrierId: 0, pos: { x: 52, y: 40, z: 0 }, yaw: 1, look: null } });
      }),
    );
    for (let t = 13; t <= 30; t++) r.applyBatch(batch(t));
    // They move again in tick 30 (the rabbit turns): nothing moved in ticks 12..29.
    r.applySamples(samples(30, 1, [[1, { x: 3, y: 40, z: 0 }, yawQ(0.2)]], [rabbitSample(7, 0, { x: 53, y: 40, z: 0 }, 2)]));
    const v = (tick: number): { pos: Vec3; yaw: number } => {
      r.setPoses(tick, tick);
      const e = r.entities(tick).find((x) => x.id === 7)!;
      return { pos: e.pos, yaw: e.yaw };
    };
    near(shipAt(r, 1, 12), { x: 2, y: 40, z: 0 });
    near(shipAt(r, 1, 20), { x: 2, y: 40, z: 0 });
    near(shipAt(r, 1, 29), { x: 2, y: 40, z: 0 });
    near(shipAt(r, 1, 29.5), { x: 2.5, y: 40, z: 0 });
    near(shipAt(r, 1, 30), { x: 3, y: 40, z: 0 });
    near(v(20).pos, { x: 52, y: 40, z: 0 });
    expect(v(20).yaw).toBeCloseTo(1, 3);
    expect(v(29).yaw).toBeCloseTo(1, 3);
    near(v(29.5).pos, { x: 52.5, y: 40, z: 0 });
    expect(v(29.5).yaw).toBeCloseTo(1.5, 3);
    // Without a rest (a lost sample, not a pause) the lerp still spans the gap.
    r.applySamples(samples(32, 2, [[1, { x: 5, y: 40, z: 0 }, yawQ(0.2)]]));
    for (let t = 31; t <= 32; t++) r.applyBatch(batch(t));
    near(shipAt(r, 1, 31), { x: 4, y: 40, z: 0 });
  });

  it('samples of an unknown id wait for its spawn, which drops those not later than its tick; they expire after SAMPLE_BUFFER_TICKS', () => {
    const r = replica();
    r.applyBatch(batch(1));
    for (const t of [5, 8, 10, 12]) r.applySamples(samples(t, t, [[1, { x: 100 + t, y: 40, z: 0 }, IDENTITY]], [rabbitSample(7, 0, { x: 200 + t, y: 40, z: 0 })]));
    expect(r.sampleCounts().pendingShips).toBe(4);
    r.applyBatch(
      batch(10, (b) => {
        b.structureSpawns.push(shipRecord(1, { x: 10, y: 40, z: 0 }));
        b.entitySpawns.push({ id: 7, kind: 'rabbit', carrierId: 0, pos: { x: 20, y: 40, z: 0 }, yaw: 0 });
      }),
    );
    // The ring: the record at 10 and the sample at 12 (5 and 8 are older than the spawn, the old 10 is replaced).
    near(shipAt(r, 1, 9), { x: 10, y: 40, z: 0 });
    near(shipAt(r, 1, 10), { x: 10, y: 40, z: 0 });
    // Sample 12 is not used before batch 12 is applied (it could carry a pivot not known yet).
    near(shipAt(r, 1, 12), { x: 10, y: 40, z: 0 });
    r.applyBatch(batch(11));
    r.applyBatch(batch(12));
    near(shipAt(r, 1, 12), { x: 112, y: 40, z: 0 });
    expect(r.sampleCounts()).toEqual({ ships: 2, entities: 2, pendingShips: 0, pendingEntities: 0 });
    const rabbit = r.entities(10.5).find((e) => e.id === 7)!;
    near(rabbit.pos, { x: 20 + (212 - 20) / 4, y: 40, z: 0 });
    // Late samples of an id that left (despawned) wait, then expire.
    r.applyBatch(batch(13, (b) => b.entityDespawns.push(7)));
    r.applySamples(samples(13, 20, [], [rabbitSample(7, 0, { x: 0, y: 40, z: 0 })]));
    expect(r.sampleCounts().pendingEntities).toBe(1);
    r.applyBatch(batch(13 + 33));
    expect(r.sampleCounts().pendingEntities).toBe(0);
  });

  it('a pivot change moves the older samples to the new pivot; older samples arriving later are dropped', () => {
    const r = replica();
    const rot = yawQ(Math.PI / 2);
    r.applyBatch(batch(10, (b) => b.structureSpawns.push(shipRecord(1, { x: 0, y: 40, z: 0 }, rot))));
    r.applySamples(samples(11, 0, [[1, { x: 1, y: 40, z: 0 }, rot]]));
    // Tick 13 arrives early with the new pivot (2.5, 0.5, 0.5): +1 along local x = -1 along world z under the yaw.
    r.applySamples(samples(13, 2, [[1, { x: 3, y: 40, z: -1 }, rot]]));
    r.applyBatch(batch(11));
    r.applyBatch(batch(12));
    r.applyBatch(batch(13, (b) => b.structureDeltas.push({ id: 1, pivot: { x: 2.5, y: 0.5, z: 0.5 } })));
    // Sample 12 was lost and arrives now, with the old pivot: dropped.
    r.applySamples(samples(12, 1, [[1, { x: 2, y: 40, z: 0 }, rot]]));
    near(shipAt(r, 1, 10), { x: 0, y: 40, z: -1 });
    near(shipAt(r, 1, 11), { x: 1, y: 40, z: -1 });
    near(shipAt(r, 1, 12), { x: 2, y: 40, z: -1 });
    near(shipAt(r, 1, 13), { x: 3, y: 40, z: -1 });
    // A cell keeps its world position through the change: local (0.5, 0.5, 0.5) at tick 11 was at
    // (1, 40, 0) + R * (-1, 0, 0) = (1, 40, 1) with the old pivot.
    r.setPoses(11, 11);
    near(r.state.structures.get(1)!.structure.grid.toWorld(vec3(0.5, 0.5, 0.5)), { x: 1, y: 40, z: 1 });
    // A resend of the same ship with yet another pivot converts the same way.
    r.applyBatch(batch(14, (b) => b.structureSpawns.push(shipRecord(1, { x: 4, y: 40, z: -2 }, rot, { x: 3.5, y: 0.5, z: 0.5 }))));
    near(shipAt(r, 1, 13), { x: 3, y: 40, z: -2 });
    near(shipAt(r, 1, 14), { x: 4, y: 40, z: -2 });
  });

  it('a pivot change is never drawn with the wrong pivot, also when the sample just before it is lost', () => {
    const r = replica();
    const rot = yawQ(Math.PI / 2);
    const p0 = { x: 1.5, y: 0.5, z: 0.5 };
    const p1 = { x: 2.5, y: 0.5, z: 0.5 };
    // The server: sailing +x at 0.5 per tick; at 15 the pivot moves to p1 (position jumps by R * (p1 - p0)).
    const posOld = (t: number): Vec3 => ({ x: 100 + 0.5 * t, y: 10, z: 0 });
    const shift = qrotate(rot, vec3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z));
    const posNew = (t: number): Vec3 => ({ x: posOld(t).x + shift.x, y: 10, z: shift.z });
    // The world position of local cell (0.5, 0.5, 0.5) on the server at (fractional) tick t.
    const cellAt = (t: number): Vec3 => {
      const rel = qrotate(rot, vec3(0.5 - p0.x, 0, 0));
      return { x: posOld(t).x + rel.x, y: 10 + rel.y, z: rel.z };
    };
    r.applyBatch(batch(10, (b) => b.structureSpawns.push(shipRecord(1, posOld(10), rot, p0))));
    for (let t = 11; t <= 14; t++) r.applyBatch(batch(t));
    for (let t = 11; t <= 13; t++) r.applySamples(samples(t, t, [[1, posOld(t), rot]]));
    // Sample 14 is lost; sample 15 (new pivot) arrives before batch 15.
    r.applySamples(samples(15, 15, [[1, posNew(15), rot]]));
    const cell = vec3(0.5, 0.5, 0.5);
    for (let t = 10; t <= 14; t += 0.125) {
      r.setPoses(t, t);
      const shown = r.state.structures.get(1)!.structure.grid.toWorld(cell);
      // On the server's track (never off to the side), at most one tick behind (held at 13 past it).
      expect(Math.abs(shown.z - cellAt(t).z)).toBeLessThan(1e-9);
      near(shown, cellAt(Math.min(t, 13)));
    }
    // Batch 15 brings the pivot: from then on 13 -> 15 interpolates with the new pivot, exactly on the track.
    r.applyBatch(batch(15, (b) => b.structureDeltas.push({ id: 1, pivot: p1 })));
    for (let t = 13; t <= 15; t += 0.125) {
      r.setPoses(t, t);
      near(r.state.structures.get(1)!.structure.grid.toWorld(cell), cellAt(t));
    }
  });

  it('a long reliable stall with samples arriving keeps the newest sample at or before the applied batches', () => {
    const r = replica();
    r.applyBatch(batch(10, (b) => b.structureSpawns.push(shipRecord(1, { x: 0, y: 40, z: 0 }))));
    r.applySamples(samples(11, 11, [[1, { x: 1, y: 40, z: 0 }, IDENTITY]]));
    r.applySamples(samples(12, 12, [[1, { x: 2, y: 40, z: 0 }, IDENTITY]]));
    r.applyBatch(batch(11));
    r.applyBatch(batch(12));
    // Batch 13 is stuck behind a retransmission; samples keep coming for 3 s (past SAMPLE_BUFFER_TICKS).
    for (let t = 13; t <= 72; t++) r.applySamples(samples(t, t, [[1, { x: t, y: 40, z: 0 }, IDENTITY]]));
    // renderTick stays at 12 at most: the ship is shown where it was at 12, not at the oldest sample kept.
    near(shipAt(r, 1, 12), { x: 2, y: 40, z: 0 });
    // The window behind the newest sample plus that anchor, nothing in between.
    expect(r.sampleCounts().ships).toBeLessThan(40);
    for (let t = 13; t <= 72; t++) r.applyBatch(batch(t));
    near(shipAt(r, 1, 70.5), { x: 70.5, y: 40, z: 0 });
  });

  it('entities interpolate in their carrier frame; across a carrier change in the world', () => {
    const r = replica();
    r.applyBatch(
      batch(10, (b) => {
        b.structureSpawns.push(shipRecord(1, { x: 0, y: 40, z: 0 }));
        b.entitySpawns.push({ id: 7, kind: 'rabbit', carrierId: 1, pos: { x: 1.5, y: 1, z: 0.5 }, yaw: 0 });
      }),
    );
    // The ship turns about its pivot; the rabbit stands still on it (no samples).
    for (let t = 11; t <= 14; t++) r.applySamples(samples(t, t, [[1, { x: 0, y: 40, z: 0 }, yawQ((t - 10) * 0.2)]]));
    for (let t = 11; t <= 14; t++) r.applyBatch(batch(t));
    r.setPoses(12.5, 12.5);
    const v = r.entities(12.5).find((e) => e.id === 7)!;
    // Local (1.5, 1, 0.5) with pivot (1.5, 0.5, 0.5): straight above the pivot, half a block up.
    near(v.pos, { x: 0, y: 40.5, z: 0 });
    expect(v.yaw).toBeCloseTo(0.5, 3);
    expect(v.carrierId).toBe(1);
    // It jumps off into the world at 15: between 14 and 15 it interpolates in world coordinates.
    r.applySamples(samples(15, 15, [[1, { x: 0, y: 40, z: 0 }, yawQ(1.0)]], [rabbitSample(7, 0, { x: 3, y: 40.5, z: 0 }, 1)]));
    r.applyBatch(batch(15));
    const at14 = r.entities(14).find((e) => e.id === 7)!;
    const mid = r.entities(14.5).find((e) => e.id === 7)!;
    near(mid.pos, { x: (at14.pos.x + 3) / 2, y: 40.5, z: (at14.pos.z + 0) / 2 });
  });

  it('removing a carrier moves its riders\' samples into the parent frame at each sample\'s pose: positions and yaw continuous', () => {
    const r = replica();
    // Ship 1 sailing +x and turning; rotor 2 on it; rabbit 7 on the ship, rabbit 8 on the rotor.
    r.applyBatch(
      batch(10, (b) => {
        b.structureSpawns.push(shipRecord(1, { x: 0, y: 40, z: 0 }), rotorRecord(2, 1, { angle: 0, speed: 1, sails: 8 }));
        b.entitySpawns.push({ id: 7, kind: 'rabbit', carrierId: 1, pos: { x: 0.5, y: 1, z: 0.5 }, yaw: 0.25 });
        b.entitySpawns.push({ id: 8, kind: 'rabbit', carrierId: 2, pos: { x: 0.5, y: 3.5, z: 0.5 }, yaw: 0 });
      }),
    );
    const pose = (t: number): [Vec3, Quat] => [{ x: (t - 10) * 0.3, y: 40, z: 0 }, yawQ((t - 10) * 0.05)];
    for (let t = 11; t <= 20; t++) {
      const [p, q] = pose(t);
      r.applySamples(samples(t, t, [[1, p, q]]));
      if (t < 20) r.applyBatch(batch(t));
    }
    // Before: where every rabbit is shown at a few renderTicks.
    const before = new Map<number, Array<{ pos: Vec3; yaw: number }>>();
    const ticks = [16, 17.5, 18, 19, 19.5];
    for (const t of ticks) {
      r.setPoses(t, t);
      for (const e of r.entities(t)) {
        const list = before.get(e.id) ?? [];
        list.push({ pos: e.pos, yaw: e.yaw });
        before.set(e.id, list);
      }
    }
    // Tick 20: the rotor stops (removed, child first), then the ship docks (removed); both rabbits stay.
    r.applyBatch(batch(20, (b) => b.structureRemoves.push(2, 1)));
    expect(r.state.entities.get(7)!.carrierId).toBe(0);
    expect(r.state.entities.get(8)!.carrierId).toBe(0);
    // Exact at the ticks; between them the world chord of the converted samples differs from the arc
    // the carrier swept by a second-order amount.
    for (const [k, t] of ticks.entries()) {
      r.setPoses(t, t);
      for (const e of r.entities(t)) {
        const b = before.get(e.id)![k]!;
        expect(e.carrierId).toBe(0);
        near(e.pos, b.pos, Number.isInteger(t) ? 1e-9 : 3e-3);
        expect(Math.abs(wrapAngle(e.yaw - b.yaw))).toBeLessThan(Number.isInteger(t) ? 1e-9 : 3e-3);
      }
    }
  });

  it('a rotor carrier removed while its ship stays: the rider moves into the ship frame', () => {
    const r = replica();
    r.applyBatch(
      batch(10, (b) => {
        b.structureSpawns.push(shipRecord(1, { x: 5, y: 40, z: 5 }, yawQ(0.7)), rotorRecord(2, 1, { angle: 0.3, speed: 0.5, sails: 8 }));
        b.entitySpawns.push({ id: 8, kind: 'rabbit', carrierId: 2, pos: { x: 0.5, y: 3.5, z: 0.5 }, yaw: 0.1 });
      }),
    );
    r.applyBatch(batch(11));
    r.setPoses(11, 11);
    const was = r.entities(11).find((e) => e.id === 8)!;
    r.applyBatch(batch(12, (b) => b.structureRemoves.push(2)));
    expect(r.state.entities.get(8)!.carrierId).toBe(1);
    r.setPoses(11, 11);
    const now = r.entities(11).find((e) => e.id === 8)!;
    expect(now.carrierId).toBe(1);
    near(now.pos, was.pos, 1e-6);
    expect(Math.abs(wrapAngle(now.yaw - was.yaw))).toBeLessThan(1e-6);
  });

  it('rotors: advanceRotor from the last state to any tick, the fraction interpolated, frozen held; resync restarts', () => {
    const r = replica();
    r.applyBatch(batch(100, (b) => b.structureSpawns.push(rotorRecord(5, 0, { angle: 1, speed: 0.1, sails: 30 }))));
    const ref = new Rotor(1, new World());
    ref.axis = 4;
    ref.sails = 30;
    ref.angle = 1;
    ref.angularSpeed = 0.1;
    const angles = [ref.angle];
    for (let i = 0; i < 150; i++) {
      advanceRotor(ref, TICK_DT);
      angles.push(ref.angle);
    }
    for (const k of [0, 1, 7, 40, 150, 3, 0]) expect(r.rotorAngleAt(5, 100 + k)).toBe(angles[k]);
    expect(r.rotorAngleAt(5, 120.25)).toBeCloseTo(wrapAngle(angles[20]! + wrapAngle(angles[21]! - angles[20]!) * 0.25), 12);
    expect(r.rotorAngleAt(5, 90)).toBe(1);
    // setPoses shows it at rotorTick.
    r.setPoses(0, 140);
    const g = r.state.structures.get(5)!.structure.grid;
    const q = qfromAxisAngle(vec3(0, 0, 1), angles[40]!);
    expect(Math.abs(g.rotation.z * q.w - g.rotation.w * q.z)).toBeLessThan(1e-12);
    // A resync (rotor state at 200) restarts from it; frozen holds.
    r.applyBatch(batch(200, (b) => b.structureDeltas.push({ id: 5, rotor: { angle: -2, angularSpeed: 0.7, sails: 30, frozen: true } })));
    expect(r.rotorAngleAt(5, 260)).toBe(-2);
    r.applyBatch(batch(201, (b) => b.structureDeltas.push({ id: 5, rotor: { angle: -2, angularSpeed: 0.7, sails: 30, frozen: false } })));
    ref.angle = -2;
    ref.angularSpeed = 0.7;
    for (let i = 0; i < 9; i++) advanceRotor(ref, TICK_DT);
    expect(r.rotorAngleAt(5, 210)).toBe(ref.angle);
  });

  it('the time of day follows renderTick and the day offset', () => {
    const r = replica();
    r.applyBatch(batch(5000, (b) => (b.globals = { dayOffset: 1000 })));
    expect(r.dayTime).toBeCloseTo(6000 / DAY_TICKS, 9);
    r.setPoses(4990.5, 4991);
    expect(r.dayTime).toBeCloseTo(5990.5 / DAY_TICKS, 9);
  });
});
