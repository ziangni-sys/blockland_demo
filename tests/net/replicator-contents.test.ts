/**
 * Package 4: each kind of content the Replicator sends about what a client already has (NETCODE
 * sections 5, 7, 8), in a scene where the replica would be wrong without it: structure glue,
 * pivot changes with samples lost, rests and final states with samples lost, resends above the
 * 1024-cell lines, the helm, a fuse that leaves its countdown, merging drops, the rotor resync.
 * The rig compares digests after every tick (rig.ts).
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PX, PY, PZ } from '../../src/core/dirs';
import { ROTOR_RESYNC_TICKS } from '../../src/net/protocol';
import { Simulation } from '../../src/sim/simulation';
import { Rotor, Ship } from '../../src/structures/structure';
import { chunkKey } from '../../src/voxel/chunk';
import { FlatGenerator } from '../../src/worldgen/generator';
import { Rig } from './rig';

/** Flat world: first air y = 35. */
const T = 35;

function flatRig(loadRadius = 3): Rig {
  return new Rig(new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius, spawn: { x: 0.5, y: T, z: -4.5 } }));
}

const SEA_TOP = 30;
const DECK = SEA_TOP - 1;

function seaRig(): Rig {
  return new Rig(
    new Simulation({
      seed: 2,
      mode: 'creative',
      generator: new FlatGenerator([
        { id: B.DEEPROCK, thickness: 1 },
        { id: B.STONE, thickness: 19 },
        { id: B.WATER, thickness: 10 },
      ]),
      syncChunks: true,
      rabbits: false,
      loadRadius: 3,
      spawn: { x: 2.5, y: SEA_TOP, z: 7.5 },
    }),
  );
}

function set(sim: Simulation, x: number, y: number, z: number, id: number, state = 0): void {
  sim.world.setCell(x, y, z, makeCell(id, state));
}

/** A plank deck of n x n at (x0..x0+n-1, T, z0..) with a helm in its middle: assembled at once (it rests on the ground). */
function landShip(rig: Rig, x0: number, z0: number, n = 3): Ship {
  const sim = rig.sim;
  for (let dx = 0; dx < n; dx++) for (let dz = 0; dz < n; dz++) set(sim, x0 + dx, T, z0 + dz, B.PLANKS_OAK);
  const h = Math.floor(n / 2);
  set(sim, x0 + h, T + 1, z0 + h, B.HELM, facingState(PX));
  const r = sim.structures.assembleShip(x0 + h, T + 1, z0 + h);
  expect(r.ok ? 'ok' : r.reason).toBe('ok');
  return (r as { structure: Ship }).structure;
}

const last = (rig: Rig, key: string) => rig.clients.get(key)!.batches.at(-1)!.batch;

describe('contents about what a client has (package 4)', () => {
  it('structure glue added and removed on a ship the client has', () => {
    const rig = flatRig();
    rig.join('a', { viewRadius: 2 });
    rig.tick(5);
    const ship = landShip(rig, 2, 2);
    rig.tick(10);
    ship.glue.add(2, T, 2, PX);
    ship.glue.add(3, T, 3, PZ);
    rig.tick();
    expect(last(rig, 'a').structureDeltas.find((d) => d.id === ship.id)?.glue?.length).toBe(2);
    ship.glue.remove(2, T, 2, PX);
    rig.tick();
    expect(last(rig, 'a').structureDeltas.find((d) => d.id === ship.id)?.glue).toEqual([[2, T, 2, 0, false]]);
    expect(rig.clients.get('a')!.state.structures.get(ship.id)!.structure.glue.size).toBe(1);
    rig.check('full');
  });

  it('a block placed on a resting ship moves its pivot: with every sample lost the replica pose still agrees', () => {
    const rig = flatRig();
    const a = rig.join('a', { viewRadius: 2 });
    rig.tick(5);
    const ship = landShip(rig, 2, 2);
    rig.tick(40); // it settles on the ground
    a.dropSamples = true;
    const before = { ...ship.grid.pivot };
    rig.ctrl('a').teleport(2.5, T, 0.5);
    rig.tick();
    rig.ctrl('a').hold(B.STONE);
    rig.useOn('a', 2, T, 2, PY, ship.id); // checked with poses in the same tick
    expect(ship.grid.count).toBe(11);
    const d = last(rig, 'a').structureDeltas.find((x) => x.id === ship.id)!;
    expect(d.cells?.length).toBe(1);
    expect(d.pivot).toBeDefined();
    expect(ship.grid.pivot).not.toEqual(before);
    rig.tick(40);
    rig.check('full');
  });

  it('samples lost while a raft sails and a drop flies: the rests and final states bring the poses back', () => {
    const rig = seaRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 3 });
    const b = rig.join('b', { viewRadius: 3 });
    rig.ctrl('b').teleport(6.5, SEA_TOP + 2, 9.5);
    for (let y = 20; y <= DECK; y++) for (let x = 0; x <= 8; x++) for (let z = 6; z <= 10; z++) set(sim, x, y, z, B.COBBLE); // pier
    for (let x = 0; x <= 4; x++) for (let z = 0; z <= 5; z++) if (z < 6) set(sim, x, DECK, z, B.PLANKS_OAK);
    sim.world.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    rig.tick(30);
    rig.ctrl('a').emptyHand();
    rig.useOn('a', 2, SEA_TOP, 4, PZ);
    rig.useOn('a', 2, SEA_TOP, 4, PZ);
    const ship = sim.structures.ships()[0]!;
    rig.tick(5);
    // From here 'b' loses every sample.
    b.dropSamples = true;
    rig.checkPoses = false;
    const p = rig.ctrl('a').player;
    p.input.forward = 1;
    sim.entities.spawnItem(5.5, SEA_TOP + 6, 8.5, B.STONE, 1, { x: 1, y: 4, z: 0 });
    rig.tick(50);
    p.input.forward = 0;
    rig.tick(350); // the raft coasts to a stop, the drop lands on the pier
    expect(ship.grid.position.z).toBeLessThan(0);
    rig.checkPoses = true;
    const rests = b.batches.filter((x) => x.batch.structureRests.some((r) => r.id === ship.id)).length;
    const finals = b.batches.filter((x) => x.batch.entityUpdates.some((u) => u.final !== undefined)).length;
    expect(rests).toBeGreaterThan(0);
    expect(finals).toBeGreaterThan(0);
    rig.check('full'); // poses included: only the reliable channel carried them to 'b'
  });

  it('more than 1024 cells in one tick: a column the client has is resent; so is a ship', () => {
    const rig = flatRig(5);
    const sim = rig.sim;
    rig.join('a', { viewRadius: 2 });
    rig.tick(40);
    const ship = landShip(rig, 20, -20, 33); // 1089 planks
    rig.tick(5);
    // 11 x 11 x 9 = 1089 cells of column (0, 1) in one tick.
    for (let x = 2; x <= 12; x++) for (let z = 18; z <= 28; z++) for (let y = T; y < T + 9; y++) set(sim, x, y, z, B.GLASS);
    rig.tick();
    let batch = last(rig, 'a');
    expect(batch.snapshots.map((s) => chunkKey(s.cx, s.cz))).toEqual([chunkKey(0, 1)]);
    expect(batch.chunkDeltas.some((d) => d.cx === 0 && d.cz === 1)).toBe(false);
    // 1089 cells of a ship the client has change in one tick.
    expect(rig.clients.get('a')!.state.structures.has(ship.id)).toBe(true);
    ship.grid.forEachCell((x, y, z, c) => {
      if (c === makeCell(B.PLANKS_OAK)) ship.grid.setCell(x, y, z, makeCell(B.PLANKS_PINE));
    });
    rig.tick();
    batch = last(rig, 'a');
    expect(batch.structureSpawns.map((s) => s.id)).toEqual([ship.id]);
    expect(batch.structureDeltas.some((d) => d.id === ship.id && d.cells !== undefined)).toBe(false);
    rig.check('full');
  });

  it('the helm: taking and leaving the wheel of a ship the client has', () => {
    const rig = flatRig();
    rig.join('a', { viewRadius: 2 });
    rig.join('b', { viewRadius: 2 });
    rig.tick(5);
    const ship = landShip(rig, 2, 2);
    rig.ctrl('b').teleport(3.5, T + 1, 1.5);
    rig.tick(10);
    rig.ctrl('b').emptyHand();
    rig.useOn('b', 3, T + 1, 3, undefined, ship.id);
    expect(ship.helmsmanId).toBe(rig.ctrl('b').entityId);
    expect(last(rig, 'a').structureDeltas.find((d) => d.id === ship.id)?.helm?.helmsmanId).toBe(ship.helmsmanId);
    rig.ctrl('b').releaseHelm();
    rig.tick();
    expect(ship.removed).toBe(false);
    expect(ship.helmsmanId).toBe(0);
    expect(last(rig, 'a').structureDeltas.find((d) => d.id === ship.id)?.helm?.helmsmanId).toBe(0);
    rig.tick(5);
    rig.check('full');
  });

  it('a fuse that leaves its countdown is sent; one that counts down is not', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 2 });
    rig.tick(5);
    const tnt = sim.entities.spawnTnt(6.5, T, 6.5, 300);
    rig.tick(20);
    expect(a.batches.slice(-19).some((x) => x.batch.entityUpdates.some((u) => u.fuse !== undefined))).toBe(false);
    tnt.fuse = 9; // shortened (the spec's case of another blast; set directly here)
    rig.tick();
    expect(last(rig, 'a').entityUpdates.find((u) => u.id === tnt.id)?.fuse).toBe(8);
    rig.tick(5);
    rig.check('full');
  });

  it('two drops merge: the survivor\'s stack is updated, the other despawns', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 2 });
    rig.tick(5);
    const d1 = sim.entities.spawnItem(6.5, T, 6.5, B.COBBLE, 3);
    const d2 = sim.entities.spawnItem(6.8, T, 6.6, B.COBBLE, 2);
    rig.tick(60);
    const survivor = d1.removed ? d2 : d1;
    expect(survivor.removed).toBe(false);
    expect(survivor.stack.count).toBe(5);
    expect(a.batches.some((x) => x.batch.entityUpdates.some((u) => u.id === survivor.id && u.stack?.count === 5))).toBe(true);
    expect(a.state.entities.get(survivor.id)!.count).toBe(5);
    expect(a.state.entities.has((survivor === d1 ? d2 : d1).id)).toBe(false);
    // A stack that changes while the drop lies still.
    survivor.stack.count = 9;
    rig.tick();
    expect(last(rig, 'a').entityUpdates).toEqual([{ id: survivor.id, stack: { item: B.COBBLE, count: 9 } }]);
    rig.check('full');
  });

  it(`a running rotor is resynchronised every ${ROTOR_RESYNC_TICKS} ticks and otherwise not mentioned`, () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 2 });
    rig.tick(5);
    const bx = 0;
    const by = T + 5;
    const bz = 4;
    for (let y = T; y < by; y++) set(sim, bx, y, bz, B.STONE);
    set(sim, bx, by, bz, B.BEARING, facingState(PZ));
    set(sim, bx, by, bz + 1, B.WOOL_YELLOW);
    for (const [du, dy] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ] as const) {
      set(sim, bx + du, by + dy, bz + 1, B.WOOL_WHITE);
      set(sim, bx + 2 * du, by + 2 * dy, bz + 1, B.WOOL_RED);
      set(sim, bx + 2 * du + dy, by + 2 * dy - du, bz + 1, B.WOOL_RED);
    }
    sim.worldGlue.add(bx, by, bz, PZ);
    rig.tick();
    const r = sim.structures.startRotor(sim.world, bx, by, bz);
    expect(r.ok).toBe(true);
    const rotor = (r as { structure: Rotor }).structure;
    rig.tick(3 * ROTOR_RESYNC_TICKS + 5);
    const ticks = a.batches.filter((x) => x.batch.structureDeltas.some((d) => d.id === rotor.id && d.rotor !== undefined)).map((x) => x.tick);
    expect(ticks.length).toBe(3);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBe(ROTOR_RESYNC_TICKS);
    expect(rotor.angularSpeed).not.toBe(0);
    rig.check('full');
  });

  it('more moving entities than four Samples messages hold: the ones left out go first in the next tick', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 2 });
    rig.tick(5);
    rig.checkPoses = false; // the poses left out of a tick's samples lag by a tick
    const drops = [];
    for (let i = 0; i < 300; i++) drops.push(sim.entities.spawnItem(-12.5 + (i % 20) * 1.5, T + 60 + Math.floor(i / 20) * 2, -12.5 + (i % 7) * 3, B.COBBLE, 1));
    rig.tick(2);
    const from = sim.ticks;
    rig.tick(20); // all of them fall the whole time
    const seen = new Map<number, number[]>();
    for (const s of a.samples) {
      if (s.msg.tick <= from) continue;
      for (const e of s.msg.entities) {
        let l = seen.get(e.id);
        if (l === undefined) seen.set(e.id, (l = []));
        l.push(s.msg.tick);
      }
    }
    const messages = new Map<number, number>();
    const sampled = new Map<number, number>();
    for (const s of a.samples) {
      if (s.msg.tick <= from) continue;
      messages.set(s.msg.tick, (messages.get(s.msg.tick) ?? 0) + 1);
      sampled.set(s.msg.tick, (sampled.get(s.msg.tick) ?? 0) + s.msg.entities.length);
    }
    expect(Math.max(...messages.values())).toBeLessThanOrEqual(4);
    expect(Math.max(...sampled.values())).toBeLessThan(250); // some are left out every tick
    for (const d of drops) {
      const ticks = seen.get(d.id) ?? [];
      expect(ticks.length, `drop ${d.id}`).toBeGreaterThanOrEqual(9);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!, `drop ${d.id}`).toBeLessThanOrEqual(2);
    }
    rig.tick(200); // they land: the final states bring every pose
    rig.checkPoses = true;
    rig.check('full');
  }, 60_000);
});
