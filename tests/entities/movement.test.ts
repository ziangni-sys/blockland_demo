import { describe, expect, it } from 'vitest';
import { B, Bench, deck, fill, inWorld, makeCell, vec3, qfromYaw } from './harness';
import { JUMP_SPEED, SPRINT_SPEED, SNEAK_SPEED, WALK_SPEED } from '../../src/entities/constants';

/** Stone floor whose top is at y = 61 over the whole test area. */
function flat(): Bench {
  const b = new Bench();
  fill(b.world, -30, 60, -30, 29, 60, 29, B.STONE);
  return b;
}

describe('player movement on land', () => {
  it('walks, sprints and sneaks at the target speeds', () => {
    for (const [mode, target] of [
      ['walk', WALK_SPEED],
      ['sprint', SPRINT_SPEED],
      ['sneak', SNEAK_SPEED],
    ] as const) {
      const b = flat();
      const p = b.entities.createPlayer('survival', 0.5, 61, 20.5);
      p.input.forward = 1;
      p.input.yaw = 0; // toward -Z
      p.input.sprint = mode === 'sprint';
      p.input.sneak = mode === 'sneak';
      b.tick(20);
      const z0 = p.pos.z;
      b.tick(40);
      const speed = (z0 - p.pos.z) / 2;
      expect(speed).toBeGreaterThan(target - 0.08);
      expect(speed).toBeLessThan(target + 0.08);
      expect(p.pos.y).toBe(61);
      expect(p.onGround).toBe(true);
      expect(Math.abs(p.pos.x - 0.5)).toBeLessThan(1e-9);
    }
  });

  it('strafes to the right with D (+strafe) when looking north', () => {
    const b = flat();
    const p = b.entities.createPlayer('survival', 0.5, 61, 0.5);
    p.input.strafe = 1;
    b.tick(20);
    expect(p.pos.x).toBeGreaterThan(2);
    expect(Math.abs(p.pos.z - 0.5)).toBeLessThan(1e-9);
  });

  it('jumps about 1.25 blocks high and lands again', () => {
    const b = flat();
    const p = b.entities.createPlayer('survival', 0.5, 61, 0.5);
    b.tick(2);
    p.input.jump = true;
    b.tick();
    p.input.jump = false;
    let top = p.pos.y;
    let airTicks = 1;
    while (!p.onGround && airTicks < 100) {
      b.tick();
      top = Math.max(top, p.pos.y);
      airTicks++;
    }
    expect(top - 61).toBeGreaterThan(1.2);
    expect(top - 61).toBeLessThan(1.3);
    expect(p.pos.y).toBe(61);
    expect(airTicks).toBeGreaterThan(9);
    expect(airTicks).toBeLessThan(14);
    expect(JUMP_SPEED).toBeGreaterThan(8);
  });

  it('can jump onto a 1-block step', () => {
    const b = flat();
    fill(b.world, -5, 61, -20, 5, 61, -3, B.STONE);
    const p = b.entities.createPlayer('survival', 0.5, 61, 0.5);
    p.input.forward = 1;
    p.input.jump = true;
    b.tickUntil(() => p.pos.z < -3, 60);
    p.input.jump = false;
    b.tick(20);
    expect(p.pos.y).toBe(62);
    expect(p.pos.z).toBeLessThan(-3);
  });

  it('slides along a wall and never enters it', () => {
    const b = flat();
    fill(b.world, -20, 61, -4, 20, 63, -4, B.STONE); // wall face at z = -3
    const p = b.entities.createPlayer('survival', 0.5, 61, 0.5);
    p.input.forward = 1;
    p.input.yaw = Math.PI / 4; // north-west, into the wall
    b.checks.push(() => expect(inWorld(b.world, p)).toBe(false));
    b.tick(60);
    expect(p.pos.z).toBeCloseTo(-3 + 0.3, 6);
    expect(p.pos.x).toBeLessThan(-5); // kept moving west along the wall
  });

  it('slides around an outside corner without snagging, stops in an inside corner', () => {
    const b = flat();
    // Wall along x ending at x = 2 (cells x <= 2), face at z = -3.
    fill(b.world, -20, 61, -4, 2, 63, -4, B.STONE);
    const p = b.entities.createPlayer('survival', -3.5, 61, -2.0);
    p.input.forward = 1;
    p.input.yaw = -Math.PI / 4 - 0.2; // north-east, mostly east
    b.tick(60);
    expect(p.pos.x).toBeGreaterThan(4);
    expect(p.pos.z).toBeLessThan(-4); // went past the end of the wall
    // inside corner: walls at z = -4 and x = 3
    const c = flat();
    fill(c.world, -20, 61, -4, 3, 63, -4, B.STONE);
    fill(c.world, 3, 61, -4, 3, 63, 10, B.STONE);
    const q = c.entities.createPlayer('survival', 0.5, 61, 0.5);
    q.input.forward = 1;
    q.input.yaw = -Math.PI / 4;
    c.tick(60);
    expect(q.pos.x).toBeCloseTo(3 - 0.3, 6);
    expect(q.pos.z).toBeCloseTo(-3 + 0.3, 6);
    const x = q.pos.x;
    c.tick(10);
    expect(q.pos.x).toBe(x);
  });

  it('does not tunnel through a 1-block floor or a 1-cell deck when falling fast', () => {
    const b = new Bench();
    fill(b.world, -5, 40, -5, 5, 40, 5, B.STONE);
    const p = b.entities.createPlayer('creative', 0.5, 120, 0.5);
    p.vel.y = -60;
    b.tickUntil(() => p.onGround, 200);
    expect(p.pos.y).toBe(41);
    // a thin deck high up
    const c = new Bench();
    const ship = c.ship(1, deck(-3, -3, 3, 3, 60));
    const q = c.entities.createPlayer('creative', 0.5, 120, 0.5);
    q.vel.y = -60;
    c.tickUntil(() => q.onGround, 200);
    expect(q.pos.y).toBeCloseTo(61, 5);
    expect(q.carrierId).toBe(ship.id);
  });
});

describe('player in water', () => {
  function pool(): Bench {
    const b = new Bench();
    fill(b.world, -12, 40, -12, 12, 40, 12, B.STONE);
    fill(b.world, -12, 41, -12, 12, 47, 12, makeCell(B.WATER));
    return b;
  }

  it('sinks slowly, swims up with jump and treads water with the head out', () => {
    const b = pool();
    const p = b.entities.createPlayer('survival', 0.5, 44, 0.5);
    b.tick(10);
    expect(p.pos.y).toBeLessThan(44);
    expect(p.vel.y).toBeGreaterThan(-1.2);
    expect(p.headWet).toBe(true);
    p.input.jump = true;
    b.tick(80);
    // Bobbing at the surface (top of water = 48 - 1/9): head out, most of the body in.
    let headOut = 0;
    for (let i = 0; i < 40; i++) {
      b.tick();
      if (!p.headWet) headOut++;
      expect(p.pos.y).toBeLessThan(47.5);
      expect(p.pos.y).toBeGreaterThan(45.5);
    }
    expect(headOut).toBeGreaterThan(30);
    expect(p.air).toBe(p.maxAir);
  });

  it('swims at about 2 blocks per second', () => {
    const b = pool();
    const p = b.entities.createPlayer('survival', 0.5, 44, 8.5);
    p.input.forward = 1;
    p.input.jump = true;
    b.tick(30);
    const z0 = p.pos.z;
    b.tick(40);
    const speed = (z0 - p.pos.z) / 2;
    expect(speed).toBeGreaterThan(1.8);
    expect(speed).toBeLessThan(2.2);
  });

  it('climbs out onto a 1-high ledge holding jump and forward', () => {
    const b = pool();
    fill(b.world, -12, 41, -12, 12, 48, -6, B.STONE); // shore, top at 49
    const p = b.entities.createPlayer('survival', 0.5, 45, 0.5);
    p.input.forward = 1;
    p.input.jump = true;
    const t = b.tickUntil(() => p.onGround && p.pos.y === 49, 200);
    expect(t).toBeLessThan(200);
    expect(p.pos.z).toBeLessThan(-4.6);
  });
});

describe('creative flying', () => {
  it('double-tapping jump toggles flight; jump up, sneak down; landing keeps flying', () => {
    const b = flat();
    const p = b.entities.createPlayer('creative', 0.5, 61, 0.5);
    b.tick(2);
    p.input.jumpPresses = 1;
    b.tick(3);
    expect(p.flying).toBe(false);
    p.input.jumpPresses = 1;
    b.tick();
    expect(p.flying).toBe(true);
    // hovering: no gravity
    b.tick(5);
    const y = p.pos.y;
    b.tick(20);
    expect(p.pos.y).toBeCloseTo(y, 6);
    p.input.jump = true;
    b.tick(20);
    expect(p.pos.y).toBeGreaterThan(y + 4);
    p.input.jump = false;
    p.input.forward = 1;
    b.tick(30);
    const z0 = p.pos.z;
    b.tick(20);
    expect(z0 - p.pos.z).toBeGreaterThan(9);
    p.input.forward = 0;
    p.input.sneak = true;
    b.tick(60);
    expect(p.pos.y).toBe(61);
    expect(p.onGround).toBe(true);
    expect(p.flying).toBe(true);
    // slow taps do not toggle
    p.input.sneak = false;
    p.input.jumpPresses = 1;
    b.tick(8);
    p.input.jumpPresses = 1;
    b.tick();
    expect(p.flying).toBe(true);
    p.input.jumpPresses = 1;
    b.tick(2);
    expect(p.flying).toBe(false);
  });

  it('survival players cannot fly', () => {
    const b = flat();
    const p = b.entities.createPlayer('survival', 0.5, 61, 0.5);
    p.input.jumpPresses = 2;
    b.tick();
    expect(p.flying).toBe(false);
    p.flying = true;
    b.tick();
    expect(p.flying).toBe(false);
  });
});

describe('sneak edge guard', () => {
  it('stops at the edge of a world platform; without sneaking the player walks off', () => {
    const b = new Bench();
    fill(b.world, -2, 60, -2, 2, 60, 2, B.STONE); // 5x5 platform, edge at x = 3
    const p = b.entities.createPlayer('survival', 0.5, 61, 0.5);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = -Math.PI / 2; // east (+X)
    b.tick(100);
    expect(p.pos.y).toBe(61);
    expect(p.pos.x).toBeGreaterThan(2.5);
    expect(p.pos.x).toBeLessThan(3.3);
    p.input.sneak = false;
    b.tick(30);
    expect(p.pos.y).toBeLessThan(55);
  });

  it('stops at the edge of a deck rotated by 30 degrees', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-3, -3, 3, 3, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, () => ({ p: vec3(0.5, 60.5, 0.5), q: qfromYaw(Math.PI / 6) }));
    b.tick();
    for (const yaw of [0, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI / 4, -0.3]) {
      const p = b.entities.createPlayer('survival', 0.5, 61.01, 0.5);
      b.tick(5);
      expect(p.onGround).toBe(true);
      expect(p.carrierId).toBe(ship.id);
      p.input.sneak = true;
      p.input.forward = 1;
      p.input.yaw = yaw;
      for (let i = 0; i < 160; i++) {
        b.tick();
        expect(p.pos.y).toBeCloseTo(61, 5);
        expect(p.carrierId).toBe(ship.id);
      }
      // got to the edge (moved well away from the centre)
      expect(Math.hypot(p.pos.x - 0.5, p.pos.z - 0.5)).toBeGreaterThan(3);
    }
  });
});
