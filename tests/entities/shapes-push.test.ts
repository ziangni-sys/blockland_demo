/**
 * Pushes by structures through thin walls (docs/SHAPES.md 5.10): a structure that moved into a body
 * pushes it out on the side it came from. A wall half a block thick sweeping into a body faster
 * than (body width + 0.5) / 2 per tick used to push it out of its far side, i.e. through the wall
 * (LESSONS 船被推穿薄墙, the entities' side). A player holding jump, a rabbit and an item drop, in
 * front of a wall (on a ship) and of a blade (on a rotor) at 14 blocks per second, both half a
 * block thick and whole: they always end up in front.
 */
import { describe, expect, it } from 'vitest';
import { PY } from '../../src/core/dirs';
import type { Entity } from '../../src/entities/entity';
import { EAST as EAST_HALF, NORTH, slab } from '../shapes';
import { B, Bench, fill, makeCell, quat, vec3 } from './harness';

type Kind = 'player' | 'rabbit' | 'item';

function spawn(b: Bench, kind: Kind, x: number, y: number, z: number): Entity {
  if (kind === 'player') {
    const p = b.entities.spawnPlayer('survival', x, y, z);
    p.input.jump = true; // in the air most of the time: the case the old bias got wrong
    return p;
  }
  if (kind === 'rabbit') return b.entities.spawnRabbit(x, y, z);
  return b.entities.spawnItem(x, y, z, B.COBBLE, 1, vec3(0, 0, 0));
}

/**
 * A wall on a ship (cells x = 0, y 1..3, z -3..3) moving +X at `speed` blocks per tick toward a
 * body standing `gap` ahead of it. `thin`: only the east half of the wall's cells (0.5 thick, its
 * leading face at x + 1). Returns whether the body ever ended up entirely behind the wall.
 */
function wallRun(kind: Kind, thin: boolean, speed: number, gap: number): boolean {
  const b = new Bench();
  fill(b.world, -40, 0, -8, 39, 0, 8, makeCell(B.STONE));
  const cells: Array<[number, number, number, number]> = [];
  for (let y = 1; y <= 3; y++) for (let z = -3; z <= 3; z++) cells.push([0, y, z, B.STONE]);
  const s = b.ship(1, cells, vec3(0.5, 2.5, 0.5));
  if (thin) for (const [x, y, z] of cells) s.grid.setCell(x, y, z, slab(B.STONE, EAST_HALF));
  const e = spawn(b, kind, 6.5 + gap, 1, 0.5);
  b.drive(s, (t) => ({ p: vec3(0.5 + speed * t, 2.5, 0.5), q: quat() }));
  for (let t = 0; t < Math.ceil(16 / speed); t++) {
    b.tick();
    if (e.removed) return false;
    const front = 1 + speed * b.ticks; // world x of the wall's leading (+X) face
    const back = front - (thin ? 0.5 : 1);
    if (e.pos.x + e.halfWidth < back + 1e-6) return true;
  }
  return false;
}

/**
 * A blade on a rotor turning about +Y (cells x 0..8, y 1..3, z 0; hub at the origin) whose tip
 * moves at `tip` blocks per second, sweeping into a body ahead of it at radius 6.5. `thin`: from
 * x = 2 out, only the leading (north) half of each cell (the blade turns its -Z side first).
 * Returns whether the body ended up behind the blade.
 */
function bladeRun(kind: Kind, thin: boolean, tip: number, phase: number): boolean {
  const b = new Bench();
  fill(b.world, -20, 0, -20, 20, 0, 20, makeCell(B.STONE));
  const cells: Array<[number, number, number, number]> = [];
  for (let y = 1; y <= 3; y++) for (let x = 0; x <= 8; x++) cells.push([x, y, 0, B.PLANKS_OAK]);
  const r = b.rotor(1, null, [0, 1, 0], PY, cells);
  if (thin) for (const [x, y, z] of cells) if (x >= 2) r.grid.setCell(x, y, z, slab(B.PLANKS_OAK, NORTH));
  const R = 6.5;
  const a0 = 0.35 + phase;
  const e = spawn(b, kind, R * Math.cos(a0) + 0.5, 1, -R * Math.sin(a0) + 0.5);
  b.spin(r, tip / 8.5, vec3(0, 1, 0));
  for (let t = 0; t < 80; t++) {
    b.tick();
    if (e.removed) return false;
    if (kind === 'item' && t % 7 === 0 && e.onGround) e.vel.y = 5; // a bouncing drop: in the air at times
    const ex = e.pos.x - 0.5;
    const ez = e.pos.z - 0.5;
    const rad = Math.hypot(ex, ez);
    if (rad > 8.2 || rad < 1.5) break; // sliding off the tip, or at the hub
    let rel = Math.atan2(-ez, ex) - r.angle; // angle of the body ahead of the blade's centre line
    rel = ((((rel + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    if (rel < -0.1 && rel > -1.2) return true;
  }
  return false;
}

const KINDS: readonly Kind[] = ['player', 'rabbit', 'item'];
const GAPS = [0, 0.13, 0.27, 0.41];

describe('5.10 a structure pushes a body out on the side it came from, never through a thin wall', () => {
  for (const kind of KINDS) {
    it(`${kind}: in front of a wall half a block thick moving at 14 blocks/s, and of a whole one: always in front`, () => {
      for (const gap of GAPS) {
        expect(wallRun(kind, true, 0.7, gap), `half-block wall, start ${gap}`).toBe(false);
        expect(wallRun(kind, false, 0.7, gap), `whole wall, start ${gap}`).toBe(false);
      }
    });

    it(`${kind}: in front of a blade half a block thick with its tip at 14 blocks/s, and of a whole one: always in front`, () => {
      for (let k = 0; k < 8; k++) {
        expect(bladeRun(kind, true, 14, k * 0.011), `half-block blade, phase ${k}`).toBe(false);
        expect(bladeRun(kind, false, 14, k * 0.011), `whole blade, phase ${k}`).toBe(false);
      }
    });
  }
});
