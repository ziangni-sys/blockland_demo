/**
 * Review (API robustness): smaller footguns for the modules that will call the entities API.
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { B, Bench, deck, fill, qfromYaw, TICK_DT } from './harness';

const DT = TICK_DT;

function sailingBench(): { b: Bench; ship: ReturnType<Bench['ship']> } {
  const b = new Bench();
  const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
  b.drive(ship, (t) => ({ p: vec3(-15 + 5 * t * DT, 60.5, 0.5), q: qfromYaw(0) }));
  b.tick();
  return { b, ship };
}

/** A player standing on the middle of the deck. */
function rider(b: Bench, ship: ReturnType<Bench['ship']>): ReturnType<Bench['entities']['spawnPlayer']> {
  const w = ship.grid.toWorld(vec3(0.5, 61, 0.5));
  return b.entities.spawnPlayer('survival', w.x, w.y, w.z);
}

describe('review: syncCarried is not idempotent', () => {
  it('a second syncCarried() in the same tick does not carry the riders twice', () => {
    const { b, ship } = sailingBench();
    const p = rider(b, ship);
    b.tick(20);
    expect(p.carrierId).toBe(ship.id);
    const l0 = ship.grid.toLocal(p.pos, vec3());
    b.world.time++;
    for (const s of b.host.list) s.grid.snapshotPose();
    for (const m of b.motions) m(++b.ticks);
    b.entities.syncCarried();
    b.entities.syncCarried(); // e.g. a client "re-sync riders" helper, or a duplicated call
    b.entities.update();
    b.tick(5);
    const l1 = ship.grid.toLocal(p.pos, vec3());
    // before the fix the rider was shifted by one extra tick of ship motion (0.25 block), permanently
    expect(Math.abs(l1.x - l0.x)).toBeLessThan(1e-6);
  });

  it('a syncCarried() between two ticks (LESSONS: sync the rider when a screen opens) does not make it lag or fling', () => {
    const { b, ship } = sailingBench();
    const p = rider(b, ship);
    b.tick(20);
    expect(p.carrierId).toBe(ship.id);
    const l0 = ship.grid.toLocal(p.pos, vec3());
    b.entities.syncCarried();
    b.tick(1);
    const l1 = ship.grid.toLocal(p.pos, vec3());
    // before the fix: the rider lagged one tick of ship motion (-0.25) and its carrier velocity doubles (10 b/s)
    expect(Math.abs(l1.x - l0.x)).toBeLessThan(1e-6);
    expect(p.carrierVel.x).toBeCloseTo(5, 6);
  });
});

describe('review: spawnItem accepts garbage counts', () => {
  it('count 0, negative or NaN is rejected instead of creating an item from nothing / a stack that breaks saving', () => {
    const b = new Bench();
    b.entities.spawnPlayer('survival', 0.5, 61, 0.5);
    // before the fix: count 0 and -5 each created a drop of 1; NaN creates a NaN stack after which
    // serialize() throws "varuint out of range" until the drop despawns 5 minutes later.
    expect(() => b.entities.spawnItem(3.5, 61, 0.5, B.STONE, 0, vec3())).toThrow();
    expect(() => b.entities.spawnItem(3.5, 61, 0.5, B.STONE, -5, vec3())).toThrow();
    expect(() => b.entities.spawnItem(3.5, 61, 0.5, B.STONE, Number.NaN, vec3())).toThrow();
    expect(() => b.entities.serialize(new ByteWriter())).not.toThrow();
  });
});

describe('review: deserialize is not atomic', () => {
  it('a corrupt entity blob leaves the current entities untouched', () => {
    const src = new Bench();
    fill(src.world, -10, 59, -10, 10, 59, 10, B.STONE);
    src.entities.spawnPlayer('survival', 0.5, 60, 0.5);
    src.entities.spawnItem(2.5, 60.2, 2.5, B.STONE, 3, vec3());
    src.tick(3);
    const w = new ByteWriter();
    src.entities.serialize(w);
    const bytes = w.finish();
    const corrupt = bytes.slice(0, bytes.length - 5);

    const b = new Bench();
    const keep = b.entities.spawnPlayer('creative', 1.5, 60, 1.5);
    const rabbit = b.entities.spawnRabbit(3.5, 60, 3.5);
    expect(() => b.entities.deserialize(new ByteReader(corrupt))).toThrow();
    // before the fix: everything was cleared first (the player too) and half of the corrupt blob
    // was loaded
    expect(b.entities.get(keep.id)).toBe(keep);
    expect(b.entities.get(rabbit.id)).toBe(rabbit);
    expect(b.entities.all().length).toBe(2);
  });
});
