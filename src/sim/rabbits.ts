/**
 * Ambient rabbits: a few rabbits appear on turf in loaded chunks around every joined player by
 * day and vanish again once no player is near. Deterministic: every random choice comes from
 * sim.rng, attempts happen on fixed world ticks and players are served in ascending entity id
 * order (sim.players.online()), so the same world, the same players and the same inputs give the
 * same rabbits. The rng is consumed per player, so the rabbits depend on the join order when
 * several players are in the world.
 */
import { AIR, ID_MASK, makeCell } from '../blocks/cell';
import { B } from '../blocks/defs';
import { LIQUID, SOLID } from '../blocks/registry';
import { WORLD_HEIGHT } from '../core/constants';
import { Rabbit } from '../entities/entity';
import type { Simulation } from './simulation';

/** World ticks between two spawn attempts (and despawn sweeps). */
export const RABBIT_SPAWN_INTERVAL = 40;
/** A spawn attempt around a player is made only while fewer rabbits than this are within RABBIT_DESPAWN_DISTANCE of it. */
export const RABBIT_CAP = 6;
/** Spawn ring around a player (horizontal blocks); never closer than the inner radius to any other player either. */
export const RABBIT_SPAWN_MIN = 16;
export const RABBIT_SPAWN_MAX = 40;
/** Rabbits farther than this (horizontally) from every joined player are removed. */
export const RABBIT_DESPAWN_DISTANCE = 96;
/** Columns tried per attempt. */
const TRIES = 4;
/** The only cell a rabbit spawns on: a whole turf block, alone in its cell. */
const TURF = makeCell(B.TURF);

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
    const players = sim.players.online();
    if (players.length === 0) return;
    const far2 = RABBIT_DESPAWN_DISTANCE * RABBIT_DESPAWN_DISTANCE;
    const rabbits: Rabbit[] = [];
    const far: Rabbit[] = [];
    for (const e of sim.entities.all()) {
      if (!(e instanceof Rabbit) || e.removed) continue;
      let near = false;
      for (const c of players) {
        const p = c.player;
        const dx = e.pos.x - p.pos.x;
        const dz = e.pos.z - p.pos.z;
        if (dx * dx + dz * dz <= far2) {
          near = true;
          break;
        }
      }
      if (near) rabbits.push(e);
      else far.push(e);
    }
    // Removed after the scan: outside the entity update, remove() splices the live list.
    for (const e of far) sim.entities.remove(e);
    if (!this.enabled) return;
    const t = sim.dayTime;
    if (t >= 0.5) return; // night: 0.5 sunset .. 1.0 sunrise
    const rng = sim.rng;
    for (const c of players) {
      const p = c.player;
      if (p.dead) continue;
      let near = 0;
      for (const r of rabbits) {
        const dx = r.pos.x - p.pos.x;
        const dz = r.pos.z - p.pos.z;
        if (dx * dx + dz * dz <= far2) near++;
      }
      if (near >= RABBIT_CAP) continue;
      for (let i = 0; i < TRIES; i++) {
        const a = rng.range(0, Math.PI * 2);
        const d = rng.range(RABBIT_SPAWN_MIN, RABBIT_SPAWN_MAX);
        const x = Math.floor(p.pos.x + Math.cos(a) * d);
        const z = Math.floor(p.pos.z + Math.sin(a) * d);
        // The ring keeps it out of this player's sight; no other player may stand right next to it either.
        if (this.nearOtherPlayer(c.player, x + 0.5, z + 0.5)) continue;
        const y = this.turfTop(x, z);
        if (y < 0) continue;
        rabbits.push(sim.entities.spawnRabbit(x + 0.5, y + 1, z + 0.5));
        break;
      }
    }
  }

  /** Is a column centre closer than RABBIT_SPAWN_MIN (horizontally) to a joined player other than `self`? */
  private nearOtherPlayer(self: object, x: number, z: number): boolean {
    const min2 = RABBIT_SPAWN_MIN * RABBIT_SPAWN_MIN;
    for (const c of this.sim.players.online()) {
      const p = c.player;
      if (p === self) continue;
      const dx = x - p.pos.x;
      const dz = z - p.pos.z;
      if (dx * dx + dz * dz < min2) return true;
    }
    return false;
  }

  /**
   * y of a turf cell with two free cells above it, the top of its column; -1 when there is none.
   * The top must be a whole turf block on its own (docs/SHAPES.md section 9.6): a turf slab, a
   * carved turf block or a turf part sharing its cell is no spawning ground. The two cells above
   * are not hard and not liquid; a cell with any part is hard (invariant I7), so it blocks.
   */
  private turfTop(x: number, z: number): number {
    const world = this.sim.world;
    // The whole neighbourhood must be loaded: a rabbit must not hop into the unknown.
    if (!world.isAreaLoaded(x - 1, z - 1, x + 1, z + 1)) return -1;
    for (let y = WORLD_HEIGHT - 2; y > 0; y--) {
      const c = world.getCell(x, y, z);
      const id = c & ID_MASK;
      // Air and soft cover (grass tufts, flowers, snow) are looked through.
      if (id === AIR || (SOLID[id] === 0 && LIQUID[id] === 0)) continue;
      if (c !== TURF) return -1;
      const a1 = world.getCell(x, y + 1, z) & ID_MASK;
      const a2 = world.getCell(x, y + 2, z) & ID_MASK;
      if (SOLID[a1] === 1 || LIQUID[a1] !== 0 || SOLID[a2] === 1 || LIQUID[a2] !== 0) return -1;
      return y;
    }
    return -1;
  }
}
