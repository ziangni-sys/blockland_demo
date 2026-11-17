/**
 * The body mover (src/entities/body.ts) is usable outside the simulation — a client will run it
 * against its own copy of the world and the structures: it is built and stepped here with a host
 * that is not a Simulation (no simulation, no random numbers, no events), and its module graph
 * imports nothing from src/sim (nor from the client, render or ui layers).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { qfromYaw, quat, vec3 } from '../../src/core/math';
import { BodyMover, sanitizeInput, takeJumpPresses, type BodyHost, type BodyStructure } from '../../src/entities/body';
import { Player } from '../../src/entities/entity';
import { Chunk } from '../../src/voxel/chunk';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';

const SRC = resolve(__dirname, '..', '..', 'src');

/** Every module reachable from `entry` through static imports and re-exports (type-only ones too). */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue;
      todo.push(resolve(dirname(file), spec + '.ts'));
    }
  }
  return [...seen].map((f) => relative(SRC, f).replace(/\\/g, '/')).sort();
}

class PlainHost implements BodyHost {
  readonly world: World;
  readonly list: BodyStructure[] = [];
  constructor(world: World) {
    this.world = world;
  }
  structures(): readonly BodyStructure[] {
    return this.list;
  }
}

/** A deck: a structure built from plain parts (no Ship / Rotor class, no structure manager). */
function deck(world: World, id: number): BodyStructure & { grid: StructureGrid } {
  const grid = new StructureGrid(id, world);
  for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) grid.setCell(x, 40, z, makeCell(B.PLANKS_OAK));
  grid.pivot.x = 3;
  grid.pivot.y = 40.5;
  grid.pivot.z = 3;
  grid.setPoseImmediate(vec3(3, 40.5, 3), quat());
  return { id, grid, parent: null, children: [], removed: false, hull: null };
}

describe('the body mover runs without a simulation', () => {
  it('its module graph imports nothing from src/sim, client, render or ui', () => {
    const graph = moduleGraph(join(SRC, 'entities', 'body.ts'));
    expect(graph).toContain('entities/body.ts');
    expect(graph).toContain('entities/physics.ts');
    const upper = graph.filter((f) => /^(sim|client|render|ui|net)\//.test(f));
    expect(upper).toEqual([]);
    // Nor anything that draws random numbers.
    expect(graph).not.toContain('core/rng.ts');
  });

  it('built with a plain host and stepped: carries a player on a moving, turning deck and lets it walk off', () => {
    const world = new World(1);
    for (let cx = -2; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) world.addChunk(new Chunk(cx, cz));
    // A floor far below to land on.
    for (let x = -20; x < 20; x++) for (let z = -20; z < 20; z++) world.setCell(x, 30, z, makeCell(B.STONE));
    const host = new PlainHost(world);
    const d = deck(world, 7);
    host.list.push(d);
    const mover = new BodyMover(host, { relocate: false });
    const p = new Player(1, 'survival');
    p.setPosition(3.5, 41, 3.5);
    let carriedTicks = 0;
    const startYaw = p.yaw;
    for (let t = 1; t <= 120; t++) {
      // The deck moves: east 2 blocks/s, turning 0.5 rad/s.
      world.time++;
      d.grid.snapshotPose();
      d.grid.position.x = 3 + 0.1 * t;
      const q = qfromYaw(0.025 * t);
      d.grid.rotation.x = q.x;
      d.grid.rotation.y = q.y;
      d.grid.rotation.z = q.z;
      d.grid.rotation.w = q.w;
      // The client's tick for its own player: carry, then its own step.
      mover.beginCarry();
      if (p.carrierId !== 0) mover.carryRider(p);
      mover.beginStep(p);
      p.input.forward = t > 80 ? 1 : 0;
      sanitizeInput(p);
      mover.stepPlayer(p, takeJumpPresses(p), false);
      mover.endTick();
      if (p.carrierId === d.id) carriedTicks++;
    }
    // Carried while standing (and turned with the deck), then walked off the deck onto the floor.
    expect(carriedTicks).toBeGreaterThan(70);
    expect(p.yaw - startYaw).toBeGreaterThan(1.5);
    expect(p.carrierId).toBe(0);
    expect(p.onWorldGround).toBe(true);
    expect(p.pos.y).toBeCloseTo(31, 6);
  });

  it('the world alone (no structures) is enough', () => {
    const world = new World(2);
    for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) world.addChunk(new Chunk(cx, cz));
    for (let x = -16; x < 16; x++) for (let z = -16; z < 16; z++) world.setCell(x, 10, z, makeCell(B.STONE));
    const mover = new BodyMover({ world, structures: () => [] });
    const p = new Player(1, 'survival');
    p.setPosition(0.5, 11, 0.5);
    p.input.forward = 1;
    for (let t = 0; t < 40; t++) {
      mover.beginCarry();
      mover.beginStep(p);
      sanitizeInput(p);
      mover.stepPlayer(p, takeJumpPresses(p), false);
      mover.endTick();
    }
    expect(p.pos.z).toBeLessThan(-5);
    expect(p.pos.y).toBe(11);
  });
});
