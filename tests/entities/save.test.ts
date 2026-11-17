import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { I } from '../../src/blocks/items';
import { FallingBlockEntity, ItemEntity, Player, Rabbit, TntEntity } from '../../src/entities/entity';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';
import { B, Bench, deck, fill, qfromYaw, TICK_DT, vec3 } from './harness';

const DT = TICK_DT;

/** A busy scene: floor, pond, a moving ship with a rider and a rabbit, items, a crate. */
function scene(seed = 99): Bench {
  const b = new Bench(undefined, seed);
  fill(b.world, -30, 40, -30, 29, 40, 29, B.STONE);
  fill(b.world, 5, 41, 5, 15, 43, 15, makeCell(B.WATER));
  const ship = b.ship(1, deck(-4, -4, 4, 4, 50), vec3(0.5, 50.5, 0.5));
  b.drive(ship, (t) => ({ p: vec3(0.5 + 0.8 * t * DT, 50.5 + 0.1 * Math.sin(t * 0.2), 0.5), q: qfromYaw(0.2 * t * DT) }));
  const p = b.entities.createPlayer('survival', 1.5, 51, 1.5);
  p.inventory.add(B.COBBLE, 70);
  p.inventory.add(I.GLUE, 3);
  b.entities.spawnRabbit(-2.5, 51, -1.5);
  b.entities.spawnRabbit(-10.5, 41, 3.5);
  for (let i = 0; i < 6; i++) b.entities.spawnItem(-6 + i, 45, -8, i % 2 === 0 ? B.COBBLE : B.SAND, 1 + i);
  b.entities.spawnTnt(-12, 41, -12, 500);
  b.entities.spawnFalling(20, 60, 20, makeCell(B.GRAVEL));
  return b;
}

/** Scripted input for the local player at tick t. */
function script(b: Bench, t: number): void {
  const p = b.entities.player!;
  const inp = p.input;
  inp.forward = t % 120 < 60 ? 1 : -0.5;
  inp.strafe = t % 90 < 30 ? 0.6 : 0;
  inp.jump = t % 47 === 0;
  inp.sneak = t % 200 > 170;
  inp.sprint = t % 300 < 100;
  if (t % 20 === 0) inp.yaw += 0.4;
  inp.pitch = Math.sin(t * 0.05) * 0.5;
  if (t === 150) inp.jumpPresses = 1;
}

function save(b: Bench): Uint8Array {
  const w = new ByteWriter();
  b.entities.serialize(w);
  return w.finish();
}

describe('entity save', () => {
  it('round-trips every entity kind with its state', () => {
    const b = scene();
    b.tick(40);
    const bytes = save(b);
    const c = scene();
    c.entities.clear();
    c.entities.deserialize(new ByteReader(bytes, 'entities'));
    const a1 = b.entities.all();
    const a2 = c.entities.all();
    expect(a2.length).toBe(a1.length);
    for (let i = 0; i < a1.length; i++) {
      const x = a1[i]!;
      const y = a2[i]!;
      expect(y.kind).toBe(x.kind);
      expect(y.id).toBe(x.id);
      expect(y.pos).toEqual(x.pos);
      expect(y.vel).toEqual(x.vel);
      expect(y.yaw).toBe(x.yaw);
      expect(y.carrierId).toBe(x.carrierId);
      expect(y.age).toBe(x.age);
      if (x instanceof Player) {
        const yp = y as Player;
        expect(yp.mode).toBe(x.mode);
        expect(yp.health).toBe(x.health);
        expect(yp.air).toBe(x.air);
        expect(yp.spawn).toEqual(x.spawn);
        expect(yp.inventory.hotbar).toEqual(x.inventory.hotbar);
        expect(yp.flying).toBe(x.flying);
      } else if (x instanceof ItemEntity) {
        expect((y as ItemEntity).stack).toEqual(x.stack);
        expect((y as ItemEntity).pickupDelay).toBe(x.pickupDelay);
      } else if (x instanceof TntEntity) {
        expect((y as TntEntity).fuse).toBe(x.fuse);
      } else if (x instanceof FallingBlockEntity) {
        expect((y as FallingBlockEntity).cell).toBe(x.cell);
      } else if (x instanceof Rabbit) {
        expect((y as Rabbit).wanderYaw).toBe(x.wanderYaw);
      }
    }
    expect(c.entities.player).toBe(a2.find((e) => e.kind === 'player'));
    expect((c.entities.player as Player).input.yaw).toBe(b.entities.player!.yaw);
    // the bytes are stable
    expect(save(c)).toEqual(bytes);
    // a fresh id never collides with a loaded one
    expect(a2.some((e) => e.id === c.entities.allocateId())).toBe(false);
  });

  it('a loaded world continues exactly like the original', () => {
    const b = scene();
    for (let t = 1; t <= 120; t++) {
      script(b, t);
      b.tick();
    }
    const bytes = save(b);
    // c: same structures / world at the same tick, entities from the save
    const c = scene();
    for (let t = 1; t <= 120; t++) c.tick(); // advance structures (and junk entities) to the same tick
    c.entities.deserialize(new ByteReader(bytes, 'entities'));
    c.host.rng.state = b.host.rng.state;
    c.world.time = b.world.time;
    // the worlds were changed identically (falling gravel landed in both)
    for (let t = 121; t <= 300; t++) {
      script(b, t);
      script(c, t);
      b.tick();
      c.tick();
    }
    expect(save(c)).toEqual(save(b));
  });

  it('rejects corrupt data', () => {
    const b = scene();
    b.tick(5);
    const bytes = save(b);
    const c = scene();
    expect(() => c.entities.deserialize(new ByteReader(bytes.slice(0, bytes.length - 7), 'entities'))).toThrow(SaveFormatError);
    const bad = bytes.slice();
    bad[0] = 77;
    expect(() => c.entities.deserialize(new ByteReader(bad, 'entities'))).toThrow(SaveFormatError);
  });
});

describe('determinism', () => {
  it('a scripted 600-tick session is bit-identical across runs', () => {
    const run = (): { bytes: Uint8Array; events: string } => {
      const b = scene(4242);
      for (let t = 1; t <= 600; t++) {
        script(b, t);
        b.tick();
      }
      return { bytes: save(b), events: b.host.events.map((e) => `${e.type}:${e.entity.id}:${e.amount ?? ''}:${e.cause ?? ''}`).join(',') };
    };
    const r1 = run();
    const r2 = run();
    expect(r1.bytes.length).toBeGreaterThan(100);
    expect(r2.bytes).toEqual(r1.bytes);
    expect(r2.events).toBe(r1.events);
    expect(r1.events.length).toBeGreaterThan(0);
  });
});
