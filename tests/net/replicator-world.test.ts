/**
 * Package 4: the Replicator on a real Simulation, world scenes (NETCODE sections 5, 6, 8, 11, 16):
 * rotors started and stopped, an explosion that destroys a bearing, a dam break, falling sand,
 * glue, two players building in one chunk, chunks and structures leaving and re-entering the
 * interest of a player who flies away and back, a client joining in the middle of it all.
 * Digests are compared after every tick (rig.ts).
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NY, PX, PY, PZ } from '../../src/core/dirs';
import { Simulation, type GameMode } from '../../src/sim/simulation';
import { Rotor } from '../../src/structures/structure';
import { chunkKey } from '../../src/voxel/chunk';
import { FlatGenerator } from '../../src/worldgen/generator';
import { countReplica, countServer, Rig, type Box } from './rig';

/** Flat world: deeprock y=0, stone 1..30, dirt 31..33, turf 34; first air y = 35. */
const T = 35;

function flatRig(mode: GameMode = 'creative', spawn = { x: 0.5, y: T, z: 4.5 }): Rig {
  return new Rig(new Simulation({ seed: 1, mode, generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 3, spawn }));
}

function set(sim: Simulation, x: number, y: number, z: number, id: number, state = 0): void {
  sim.world.setCell(x, y, z, makeCell(id, state));
}

/** A windmill on a stone pillar at (x, T..T+4, z): bearing on top facing +Z, 13 wool cells in the plane z + 1. */
function windmill(sim: Simulation, x: number, z: number): { bx: number; by: number; bz: number } {
  const by = T + 5;
  for (let y = T; y < by; y++) set(sim, x, y, z, B.STONE);
  set(sim, x, by, z, B.BEARING, facingState(PZ));
  set(sim, x, by, z + 1, B.WOOL_YELLOW);
  for (const [du, dy] of [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ] as const) {
    set(sim, x + du, by + dy, z + 1, B.WOOL_WHITE);
    set(sim, x + 2 * du, by + 2 * dy, z + 1, B.WOOL_RED);
    set(sim, x + 2 * du + dy, by + 2 * dy - du, z + 1, B.WOOL_RED);
  }
  sim.worldGlue.add(x, by, z, PZ);
  return { bx: x, by, bz: z };
}

function startRotor(rig: Rig, bx: number, by: number, bz: number): Rotor {
  const r = rig.sim.structures.startRotor(rig.sim.world, bx, by, bz);
  expect(r.ok).toBe(true);
  return (r as { structure: Rotor }).structure;
}

describe('replication of world scenes (package 4)', () => {
  it('a world rotor started and stopped, then an explosion destroys its bearing: removal, world cells and drops arrive in one batch', () => {
    const rig = flatRig('survival');
    const sim = rig.sim;
    rig.join('a', { viewRadius: 3 });
    rig.join('b', { viewRadius: 2 });
    rig.ctrl('b').teleport(8.5, T, 8.5);
    rig.tick(10);
    const { bx, by, bz } = windmill(sim, 0, 0);
    rig.tick(2);
    let rotor = startRotor(rig, bx, by, bz);
    rig.tick(60);
    sim.structures.stopRotor(rotor);
    rig.tick(10);
    rotor = startRotor(rig, bx, by, bz);
    rig.tick(80);
    for (const c of rig.clients.values()) expect(c.state.structures.has(rotor.id), c.key).toBe(true);
    const box: Box = [-20, 0, -20, 20, 60, 20];
    const wool = countServer(sim, B.WOOL_WHITE, box);
    sim.entities.spawnTnt(bx + 1.5, by, bz + 0.5, 4);
    let blastTick = -1;
    for (let i = 0; i < 20 && !rotor.removed; i++) {
      rig.tick();
      if (rotor.removed) blastTick = sim.ticks;
    }
    expect(rotor.removed).toBe(true);
    for (const c of rig.clients.values()) {
      const b = c.batches.find((x) => x.tick === blastTick)!.batch;
      expect(b.structureRemoves, c.key).toContain(rotor.id);
      expect(b.chunkDeltas.length, c.key).toBeGreaterThan(0);
      expect(b.events.some((e) => e.type === 'explosion'), c.key).toBe(true);
      expect(c.state.structures.size, c.key).toBe(0);
      // Survival: the destroyed cells drop items in the same batch.
      expect(b.entitySpawns.some((e) => e.kind === 'item'), c.key).toBe(true);
    }
    // White wool now lies in the world or was dropped: never in two places on a client.
    for (const c of rig.clients.values()) expect(countReplica(c.state, B.WOOL_WHITE, box), c.key).toBe(countServer(sim, B.WOOL_WHITE, box));
    expect(countServer(sim, B.WOOL_WHITE, box)).toBeLessThanOrEqual(wool);
    rig.tick(60); // the drops settle (final states)
    rig.check('full');
  });

  it('a dam break: liquid flows for many ticks, every tick agrees; a client joining mid-way catches up', () => {
    const rig = flatRig('creative', { x: 4.5, y: T + 6, z: -6.5 });
    const sim = rig.sim;
    rig.join('a', { viewRadius: 3 });
    rig.tick(10);
    // A basin of glass 12 x 12 inside, 4 deep, full of water sources, its east wall of stone.
    for (let x = -1; x <= 12; x++) {
      for (let z = -1; z <= 12; z++) {
        for (let y = T; y <= T + 3; y++) {
          const wall = x === -1 || x === 12 || z === -1 || z === 12;
          if (wall) set(sim, x, y, z, x === 12 ? B.STONE : B.GLASS);
          else set(sim, x, y, z, B.WATER);
        }
      }
    }
    rig.ctrl('a').player.flying = true;
    rig.tick(40);
    for (let z = -1; z <= 12; z++) for (let y = T; y <= T + 3; y++) set(sim, 12, y, z, B.AIR); // the dam breaks
    let changes = 0;
    for (let i = 0; i < 200; i++) {
      rig.tick();
      changes += rig.clients.get('a')!.batches.at(-1)!.batch.chunkDeltas.reduce((n, d) => n + d.cells.length, 0);
    }
    expect(changes).toBeGreaterThan(300);
    const b = rig.join('b', { viewRadius: 3 });
    rig.tick(100);
    expect(b.state.ready).toBe(true);
    rig.check('full');
  });

  it('falling sand: the falling entities and the world cells they leave and land in agree tick by tick', () => {
    const rig = flatRig();
    const sim = rig.sim;
    rig.join('a', { viewRadius: 2 });
    rig.join('b', { viewRadius: 2 });
    rig.ctrl('b').teleport(-6.5, T, -6.5);
    rig.tick(10);
    for (let y = T + 6; y <= T + 12; y++) set(sim, 4, y, 4, B.SAND);
    let sawFalling = false;
    for (let i = 0; i < 80; i++) {
      rig.tick();
      for (const c of rig.clients.values()) if ([...c.state.entities.values()].some((e) => e.kind === 'falling')) sawFalling = true;
      // A sand block is never both falling and in the world on a client.
      for (const c of rig.clients.values()) {
        const falling = [...c.state.entities.values()].filter((e) => e.kind === 'falling').length;
        expect(countReplica(c.state, B.SAND, [0, T, 0, 8, T + 13, 8]) + falling, c.key).toBe(7);
      }
    }
    expect(sawFalling).toBe(true);
    rig.check('full');
  });

  it('glue applied, removed and moved by assembly: world and structure glue agree', () => {
    const rig = flatRig();
    const sim = rig.sim;
    rig.join('a', { viewRadius: 2 });
    rig.tick(10);
    set(sim, 2, T, 2, B.PLANKS_OAK);
    set(sim, 3, T, 2, B.PLANKS_OAK);
    set(sim, 2, T + 1, 2, B.STONE);
    rig.tick();
    sim.worldGlue.add(2, T, 2, PX);
    sim.worldGlue.add(2, T, 2, PY);
    rig.tick();
    sim.worldGlue.add(2, T, 2, NY); // on the turf below
    sim.worldGlue.remove(2, T, 2, PY);
    rig.tick();
    // Glue on pristine stone does not modify the column: the snapshot carries it anyway.
    const c = rig.join('c', { viewRadius: 2 });
    rig.tick(5);
    expect(c.state.worldGlue.size).toBe(sim.worldGlue.size);
    // A windmill whose hub is glued to the bearing: starting moves no glue off the bearing face;
    // stopping brings the rotor's glue back into the world.
    const { bx, by, bz } = windmill(sim, -6, -6);
    sim.worldGlue.add(-6, by + 1, -5, PY); // arm to arm, inside the rotor
    rig.tick(2);
    const rotor = startRotor(rig, bx, by, bz);
    rig.tick(30);
    expect(rotor.glue.size).toBe(1);
    for (const cl of rig.clients.values()) expect(cl.state.structures.get(rotor.id)!.structure.glue.size, cl.key).toBe(1);
    rig.sim.structures.stopRotor(rotor);
    rig.tick(5);
    rig.check('full');
    for (const cl of rig.clients.values()) expect(cl.state.worldGlue.size, cl.key).toBe(sim.worldGlue.size);
  });

  it('two players place and mine blocks in the same chunk: both replicas follow every tick', () => {
    const rig = flatRig('creative', { x: 3.5, y: T, z: 3.5 });
    const sim = rig.sim;
    rig.join('a', { viewRadius: 2 });
    rig.join('b', { viewRadius: 2 });
    rig.ctrl('b').teleport(10.5, T, 10.5);
    rig.tick(10);
    rig.ctrl('a').hold(B.PLANKS_OAK);
    rig.ctrl('b').hold(B.COBBLE);
    // Ground cells around each player, farthest first (a placed block never hides the next target).
    const ring = (cx: number, cz: number): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (Math.abs(dx) + Math.abs(dz) >= 2) out.push([cx + dx, cz + dz]);
      return out.sort((p, q) => Math.hypot(q[0] - cx, q[1] - cz) - Math.hypot(p[0] - cx, p[1] - cz));
    };
    const ra = ring(3, 3);
    const rb = ring(10, 10);
    let placed = 0;
    for (let i = 0; i < 16; i++) {
      // Both click in the same tick, in the same chunk.
      const a = rig.ctrl('a');
      const b = rig.ctrl('b');
      const ta = a.aimAt(ra[i]![0], T - 1, ra[i]![1], PY, 0);
      const tb = b.aimAt(rb[i]![0], T - 1, rb[i]![1], PY, 0);
      if (ta) a.use();
      if (tb) b.use();
      rig.tick();
      placed += (ta ? 1 : 0) + (tb ? 1 : 0);
    }
    expect(placed).toBeGreaterThan(12);
    rig.mine('a', ra[0]![0], T, ra[0]![1], PY);
    rig.mine('b', rb[0]![0], T, rb[0]![1], PY);
    rig.mine('a', 3, T - 1, 5, PY);
    rig.tick(5);
    // Both see every change of the chunk (the deltas went to both).
    const key = chunkKey(0, 0);
    for (const c of rig.clients.values()) expect(rig.rep.clientView(c.key)!.columns.has(key), c.key).toBe(true);
    rig.check('full');
    expect(sim.world.getCell(ra[0]![0], T, ra[0]![1])).toBe(0);
  });

  it('a player flies away and back: columns, a ship and a world rotor leave and re-enter its interest', () => {
    const rig = flatRig('creative', { x: 0.5, y: T, z: 4.5 });
    const sim = rig.sim;
    rig.join('a', { viewRadius: 2 });
    rig.join('b', { viewRadius: 2 }); // stays: keeps the scene loaded and running
    rig.tick(10);
    const { bx, by, bz } = windmill(sim, 0, -6);
    rig.tick(2);
    const rotor = startRotor(rig, bx, by, bz);
    // A small "ship" on land (it rests on the ground): planks and a helm.
    for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) set(sim, x, T, z, B.PLANKS_OAK);
    set(sim, 5, T + 1, 5, B.HELM, facingState(PX));
    rig.tick(2);
    const ship = sim.structures.assembleShip(5, T + 1, 5);
    expect(ship.ok).toBe(true);
    const shipId = (ship as { structure: { id: number } }).structure.id;
    // Drops that lie still the whole time: despawned with their column, spawned again with it.
    const drops = [sim.entities.spawnItem(9.5, T, 1.5, B.COBBLE, 2), sim.entities.spawnItem(-3.5, T, 9.5, B.GLASS, 1)];
    rig.tick(20);
    const a = rig.clients.get('a')!;
    expect(a.state.structures.has(rotor.id)).toBe(true);
    expect(a.state.structures.has(shipId)).toBe(true);
    for (const d of drops) expect(a.state.entities.has(d.id)).toBe(true);
    const p = rig.ctrl('a').player;
    p.flying = true;
    let left = -1;
    for (let i = 0; i < 260; i++) {
      rig.ctrl('a').teleport(0.5 + (i + 1) * 0.9, T + 10, 4.5);
      rig.tick();
      if (left < 0 && !a.state.structures.has(rotor.id)) left = i;
    }
    expect(left).toBeGreaterThan(0);
    expect(a.state.structures.size).toBe(0);
    expect(a.state.world.getChunk(0, 0)).toBeUndefined();
    for (const d of drops) expect(a.state.entities.has(d.id)).toBe(false);
    const unsub = a.batches.reduce((n, b) => n + b.batch.unsubscribe.length, 0);
    expect(unsub).toBeGreaterThan(20);
    for (let i = 259; i >= 0; i--) {
      rig.ctrl('a').teleport(0.5 + i * 0.9, T + 10, 4.5);
      rig.tick();
    }
    rig.tick(20);
    expect(a.state.structures.has(rotor.id)).toBe(true);
    expect(a.state.structures.has(shipId)).toBe(true);
    expect(a.state.world.getChunk(0, 0)).toBeDefined();
    for (const d of drops) expect(a.state.entities.has(d.id)).toBe(true);
    rig.check('full');
  }, 120_000);
});
