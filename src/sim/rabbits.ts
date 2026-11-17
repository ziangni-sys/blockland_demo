/**
 * Ambient rabbits: a few rabbits appear on turf in loaded chunks around the player by day and
 * vanish again once the player is far away. Deterministic: every random choice comes from
 * sim.rng, and attempts happen on fixed world ticks, so the same world and the same inputs
 * give the same rabbits.
 */
import { AIR, ID_MASK } from '../blocks/cell';
import { B } from '../blocks/defs';
import { LIQUID, SOLID } from '../blocks/registry';
import { WORLD_HEIGHT } from '../core/constants';
import { Rabbit } from '../entities/entity';
import type { Simulation } from './simulation';

/** World ticks between two spawn attempts (and despawn sweeps). */
export const RABBIT_SPAWN_INTERVAL = 40;
/** At most this many rabbits within RABBIT_DESPAWN_DISTANCE of the player. */
export const RABBIT_CAP = 6;
/** Spawn ring around the player (horizontal blocks): never in sight right next to them. */
export const RABBIT_SPAWN_MIN = 16;
export const RABBIT_SPAWN_MAX = 40;
/** Rabbits farther than this (horizontally) from the player are removed. */
export const RABBIT_DESPAWN_DISTANCE = 96;
/** Columns tried per attempt. */
const TRIES = 4;

export class RabbitSpawner {
  /** Set false to keep the world free of ambient rabbits (tests, tools). */
  enabled: boolean;

  constructor(
    private readonly sim: Simulation,
    enabled = true,
  ) {
    this.enabled = enabled;
  }

  tick(): void {
    const sim = this.sim;
    if (sim.world.time % RABBIT_SPAWN_INTERVAL !== 0) return;
    const p = sim.entities.player;
    if (p === null || p.removed) return;
    let near = 0;
    for (const e of sim.entities.all()) {
      if (!(e instanceof Rabbit) || e.removed) continue;
      const dx = e.pos.x - p.pos.x;
      const dz = e.pos.z - p.pos.z;
      if (dx * dx + dz * dz > RABBIT_DESPAWN_DISTANCE * RABBIT_DESPAWN_DISTANCE) sim.entities.remove(e);
      else near++;
    }
    if (!this.enabled || near >= RABBIT_CAP || p.dead) return;
    const t = sim.dayTime;
    if (t >= 0.5) return; // night: 0.5 sunset .. 1.0 sunrise
    const rng = sim.rng;
    for (let i = 0; i < TRIES; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(RABBIT_SPAWN_MIN, RABBIT_SPAWN_MAX);
      const x = Math.floor(p.pos.x + Math.cos(a) * d);
      const z = Math.floor(p.pos.z + Math.sin(a) * d);
      const y = this.turfTop(x, z);
      if (y < 0) continue;
      sim.entities.spawnRabbit(x + 0.5, y + 1, z + 0.5);
      return;
    }
  }

  /** y of a turf cell with two free cells above it, the top of its column; -1 when there is none. */
  private turfTop(x: number, z: number): number {
    const world = this.sim.world;
    // The whole neighbourhood must be loaded: a rabbit must not hop into the unknown.
    if (!world.isAreaLoaded(x - 1, z - 1, x + 1, z + 1)) return -1;
    for (let y = WORLD_HEIGHT - 2; y > 0; y--) {
      const id = world.getCell(x, y, z) & ID_MASK;
      // Air and soft cover (grass tufts, flowers, snow) are looked through.
      if (id === AIR || (SOLID[id] === 0 && LIQUID[id] === 0)) continue;
      if (id !== B.TURF) return -1;
      const a1 = world.getCell(x, y + 1, z) & ID_MASK;
      const a2 = world.getCell(x, y + 2, z) & ID_MASK;
      if (SOLID[a1] === 1 || LIQUID[a1] !== 0 || SOLID[a2] === 1 || LIQUID[a2] !== 0) return -1;
      return y;
    }
    return -1;
  }
}
