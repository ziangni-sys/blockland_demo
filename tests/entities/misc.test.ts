import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { ItemEntity } from '../../src/entities/entity';
import { ITEM_DESPAWN_TICKS } from '../../src/entities/constants';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { B, Bench, deck, fill, inWorld, vec3 } from './harness';

function floorBench(): Bench {
  const b = new Bench();
  fill(b.world, -30, 60, -30, 29, 60, 29, B.STONE);
  return b;
}

describe('falling blocks', () => {
  it('land on the world as a block when the cell is replaceable', () => {
    const b = floorBench();
    const f = b.entities.spawnFalling(3, 75, -2, makeCell(B.SAND));
    expect(f.pos).toEqual(vec3(3.5, 75, -1.5));
    b.tickUntil(() => f.removed, 200);
    expect(f.removed).toBe(true);
    expect(b.world.getId(3, 61, -2)).toBe(B.SAND);
    expect(b.entities.all().length).toBe(0);
    // onto tall grass: replaces it
    b.world.setCell(5, 61, 5, makeCell(B.TALL_GRASS));
    const g = b.entities.spawnFalling(5, 70, 5, makeCell(B.GRAVEL));
    b.tickUntil(() => g.removed, 200);
    expect(b.world.getId(5, 61, 5)).toBe(B.GRAVEL);
  });

  it('turn into an item drop when the landing cell is not replaceable (a torch)', () => {
    const b = floorBench();
    b.world.setCell(0, 61, 0, makeCell(B.TORCH));
    const f = b.entities.spawnFalling(0, 70, 0, makeCell(B.SAND));
    b.tickUntil(() => f.removed, 200);
    expect(b.world.getId(0, 61, 0)).toBe(B.TORCH);
    const drops = b.entities.all().filter((e): e is ItemEntity => e instanceof ItemEntity);
    expect(drops.length).toBe(1);
    expect(drops[0]!.stack).toEqual({ item: B.SAND, count: 1 });
  });

  it('landing on a structure always yields an item drop, which then rides the deck', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-3, -3, 3, 3, 50), vec3(0.5, 50.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5 + 0.05 * t, 50.5, 0.5), q: { x: 0, y: 0, z: 0, w: 1 } }));
    const f = b.entities.spawnFalling(0, 70, 0, makeCell(B.SAND));
    b.tickUntil(() => f.removed, 200);
    expect(f.removed).toBe(true);
    for (let y = 0; y < 128; y++) expect(b.world.getId(0, y, 0)).not.toBe(B.SAND);
    const drop = b.entities.all().find((e): e is ItemEntity => e instanceof ItemEntity)!;
    expect(drop.stack.item).toBe(B.SAND);
    b.tick(40);
    expect(drop.carrierId).toBe(ship.id);
    expect(drop.pos.y).toBeCloseTo(51, 5);
  });
});

describe('blast crates', () => {
  it('count the fuse down and call host.explode at their centre', () => {
    const b = floorBench();
    const t = b.entities.spawnTnt(2, 61, 2, 30);
    b.tick(29);
    expect(b.host.blasts.length).toBe(0);
    expect(t.removed).toBe(false);
    b.tick();
    expect(b.host.blasts.length).toBe(1);
    const blast = b.host.blasts[0]!;
    expect(blast.power).toBe(4);
    expect(blast.source).toBe(t);
    expect(blast.y).toBeCloseTo(61 + 0.49, 1);
    expect(Math.hypot(blast.x - 2.5, blast.z - 2.5)).toBeLessThan(1);
    expect(t.removed).toBe(true);
    expect(b.entities.all()).not.toContain(t);
    expect(b.entities.spawnTnt(0, 61, 0).fuse).toBe(80);
  });
});

describe('item drops', () => {
  it('are picked up by a living player within reach once the delay is over', () => {
    const b = floorBench();
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 0.5);
    const it = b.entities.spawnItem(1.5, 61.2, 0.5, B.COBBLE, 5, vec3(0, 0, 0));
    b.tick(5);
    expect(it.removed).toBe(false);
    b.tick(10);
    expect(it.removed).toBe(true);
    expect(p.inventory.count(B.COBBLE)).toBe(5);
    const ev = b.host.events.find((e) => e.type === 'pickup')!;
    expect(ev.amount).toBe(5);
    expect(ev.entity).toBe(it);
    // out of reach: stays
    const far = b.entities.spawnItem(4.5, 61.2, 0.5, B.DIRT, 1, vec3(0, 0, 0));
    b.tick(30);
    expect(far.removed).toBe(false);
    // dead players pick nothing up
    b.entities.kill(p, 'test');
    p.pos.x = 4.5;
    b.tick(5);
    expect(far.removed).toBe(false);
  });

  it('a full inventory takes only what fits', () => {
    const b = floorBench();
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 0.5);
    for (let i = 0; i < 9; i++) p.inventory.hotbar[i] = { item: B.STONE, count: 64 };
    for (let i = 0; i < 27; i++) p.inventory.main[i] = { item: B.STONE, count: 64 };
    p.inventory.main[3] = { item: B.COBBLE, count: 60 };
    const it = b.entities.spawnItem(0.5, 61.2, 0.5, B.COBBLE, 10, vec3(0, 0, 0));
    b.tick(15);
    expect(p.inventory.count(B.COBBLE)).toBe(64);
    expect(it.removed).toBe(false);
    expect(it.stack.count).toBe(6);
  });

  it('identical stacks nearby merge; different ones do not', () => {
    const b = floorBench();
    const a = b.entities.spawnItem(0.5, 61.2, 0.5, B.COBBLE, 10, vec3(0, 0, 0));
    const c = b.entities.spawnItem(0.9, 61.2, 0.6, B.COBBLE, 20, vec3(0, 0, 0));
    const d = b.entities.spawnItem(0.7, 61.2, 0.2, B.DIRT, 3, vec3(0, 0, 0));
    b.tick(20);
    const left = [a, c].filter((e) => !e.removed);
    expect(left.length).toBe(1);
    expect(left[0]!.stack.count).toBe(30);
    expect(left[0]).toBe(c); // the bigger stack absorbs
    expect(d.removed).toBe(false);
    // full stacks do not merge beyond the maximum
    const e1 = b.entities.spawnItem(5.5, 61.2, 5.5, B.COBBLE, 64, vec3(0, 0, 0));
    const e2 = b.entities.spawnItem(5.7, 61.2, 5.5, B.COBBLE, 64, vec3(0, 0, 0));
    b.tick(20);
    expect(e1.removed || e2.removed).toBe(false);
  });

  it('despawn after 6000 ticks', () => {
    const b = floorBench();
    const it = b.entities.spawnItem(0.5, 61.2, 0.5, B.COBBLE, 1, vec3(0, 0, 0));
    b.tick(5);
    it.age = ITEM_DESPAWN_TICKS - 2;
    b.tick();
    expect(it.removed).toBe(false);
    b.tick();
    expect(it.removed).toBe(true);
    expect(b.host.events.find((e) => e.type === 'despawn')?.cause).toBe('timeout');
  });

  it('float up in water and burn in lava', () => {
    const b = new Bench();
    fill(b.world, -5, 40, -5, 5, 40, 5, B.STONE);
    fill(b.world, -5, 41, -5, 5, 47, 5, makeCell(B.WATER));
    const it = b.entities.spawnItem(0.5, 41.2, 0.5, B.PLANKS_OAK, 1, vec3(0, 0, 0));
    b.tick(200);
    expect(it.pos.y).toBeGreaterThan(47);
    expect(it.pos.y).toBeLessThan(48.2);
    fill(b.world, 8, 41, 8, 8, 41, 8, makeCell(B.LAVA));
    const burnt = b.entities.spawnItem(8.5, 41.5, 8.5, B.PLANKS_OAK, 1, vec3(0, 0, 0));
    b.tick(2);
    expect(burnt.removed).toBe(true);
  });

  it('spawnItem centres the box and rejects ids that are not items', () => {
    const b = floorBench();
    const it = b.entities.spawnItem(1, 70, 2, B.COBBLE, 1, vec3(0, 0, 0));
    const box = it.box();
    expect((box.minY + box.maxY) / 2).toBeCloseTo(70, 9);
    expect(() => b.entities.spawnItem(0, 70, 0, B.WATER, 1)).toThrow();
  });
});

describe('unloaded chunks', () => {
  it('entities in unloaded chunks are frozen (they do not fall into the void)', () => {
    const world = new World(1);
    world.addChunk(new Chunk(0, 0));
    const b = new Bench(world);
    const p = b.entities.spawnPlayer('survival', 40.5, 70, 40.5); // chunk (2, 2): not loaded
    p.vel.y = -5;
    p.input.forward = 1;
    const it = b.entities.spawnItem(-20, 70, 3, B.COBBLE, 1, vec3(1, 0, 0));
    b.tick(50);
    expect(p.pos).toEqual(vec3(40.5, 70, 40.5));
    expect(p.age).toBe(0);
    expect(it.pos.x).toBe(-20);
    // once the chunk arrives the player falls normally
    world.addChunk(new Chunk(2, 2));
    fill(world, 35, 60, 35, 45, 60, 45, B.STONE);
    p.input.forward = 0;
    b.tick(60);
    expect(p.pos.y).toBe(61);
  });
});

describe('rabbits', () => {
  it('wander with hops on a high platform without falling off', () => {
    const b = new Bench();
    fill(b.world, -4, 60, -4, 4, 60, 4, B.TURF);
    const rabbits = [b.entities.spawnRabbit(0.5, 61, 0.5), b.entities.spawnRabbit(2.5, 61, -1.5), b.entities.spawnRabbit(-2.5, 61, 2.5)];
    let hops = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      b.tick();
      for (const r of rabbits) {
        expect(r.pos.y).toBeGreaterThan(60.99);
        if (r.vel.y > 3) hops++;
        seen.add(`${Math.floor(r.pos.x)},${Math.floor(r.pos.z)}`);
        expect(inWorld(b.world, r)).toBe(false);
      }
    }
    expect(hops).toBeGreaterThan(20);
    expect(seen.size).toBeGreaterThan(10);
    for (const r of rabbits) expect(r.removed).toBe(false);
  });

  it('swim at the surface instead of sinking', () => {
    const b = new Bench();
    fill(b.world, -11, 40, -11, 11, 49, 11, B.STONE);
    fill(b.world, -10, 41, -10, 10, 49, 10, 0);
    fill(b.world, -10, 41, -10, 10, 47, 10, makeCell(B.WATER));
    const r = b.entities.spawnRabbit(0.5, 44, 0.5);
    b.tick(100);
    let minY = Infinity;
    for (let i = 0; i < 200; i++) {
      b.tick();
      minY = Math.min(minY, r.pos.y);
    }
    expect(minY).toBeGreaterThan(46.5);
  });
});

describe('player health', () => {
  it('fall damage beyond 3.5 blocks in survival only; water breaks the fall', () => {
    for (const [mode, h, expected] of [
      ['survival', 3, 20],
      ['survival', 10, 13],
      ['creative', 10, 20],
    ] as const) {
      const b = floorBench();
      const p = b.entities.spawnPlayer(mode, 0.5, 61 + h, 0.5);
      b.tick(60);
      expect(p.pos.y).toBe(61);
      expect(p.health).toBe(expected);
      if (h >= 3) expect(b.host.count('land', p)).toBe(1);
    }
    const b = new Bench();
    fill(b.world, -5, 40, -5, 5, 40, 5, B.STONE);
    fill(b.world, -5, 41, -5, 5, 43, 5, makeCell(B.WATER));
    const p = b.entities.spawnPlayer('survival', 0.5, 70, 0.5);
    b.tick(80);
    expect(p.health).toBe(20);
    expect(b.host.count('splash', p)).toBe(1);
    // one block of water still breaks a fall from high up, even when the body goes from dry to
    // the bottom within a single tick
    for (const startY of [90, 91.3, 92.7, 95.1, 101.9]) {
      const c = new Bench();
      fill(c.world, -5, 40, -5, 5, 40, 5, B.STONE);
      fill(c.world, -5, 41, -5, 5, 41, 5, makeCell(B.WATER));
      const q = c.entities.spawnPlayer('survival', 0.5, startY, 0.5);
      c.tick(100);
      expect(q.pos.y).toBe(41);
      expect(q.health).toBe(20);
    }
  });

  it('lava hurts in survival; creative takes no damage and keeps its breath', () => {
    const b = floorBench();
    fill(b.world, 0, 61, 0, 2, 62, 2, makeCell(B.LAVA));
    const p = b.entities.spawnPlayer('survival', 1.5, 61, 1.5);
    b.tick(25);
    expect(p.health).toBeLessThanOrEqual(8);
    expect(p.inLava).toBe(true);
    const c = floorBench();
    fill(c.world, 0, 61, 0, 2, 62, 2, makeCell(B.LAVA));
    const q = c.entities.spawnPlayer('creative', 1.5, 61, 1.5);
    c.tick(25);
    expect(q.health).toBe(20);
  });

  it('suffocation: a block placed into the body pushes the player to the nearest free spot', () => {
    const b = floorBench();
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 0.5);
    b.tick(2);
    b.world.setCell(0, 62, 0, makeCell(B.STONE));
    b.tick();
    expect(inWorld(b.world, p)).toBe(false);
    expect(p.health).toBe(20);
  });

  it('falling out of the world: items vanish, survival players die', () => {
    const b = new Bench();
    const it = b.entities.spawnItem(0.5, -70, 0.5, B.COBBLE, 1, vec3(0, 0, 0));
    const p = b.entities.spawnPlayer('survival', 0.5, -70, 0.5);
    b.tick();
    expect(it.removed).toBe(true);
    expect(p.dead).toBe(true);
  });
});
