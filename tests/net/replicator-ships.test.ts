/**
 * Package 4: the Replicator on a real Simulation, scenes with ships (NETCODE sections 5, 7, 16).
 * Every batch is encoded, decoded and applied to a ReplicaState; digests are compared after every
 * tick; the plank count of the replica (world + structures) never changes while ships assemble
 * and dock (section 5 "为什么方块不会重复或消失").
 */
import { describe, expect, it } from 'vitest';
import { cellState, facingState, makeCell, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PZ, type Dir } from '../../src/core/dirs';
import { BEARING_V, DECK_Y, exampleShipCell, MAST_TOP_Y, placeExampleShip } from '../../src/sim/exampleShip';
import { Simulation } from '../../src/sim/simulation';
import { Rotor, Ship } from '../../src/structures/structure';
import { FlatGenerator, TerrainGenerator } from '../../src/worldgen/generator';
import { countReplica, countServer, Rig, type Box } from './rig';

const SEA_TOP = 30;
const DECK = SEA_TOP - 1;
const HELM_N = makeCell(B.HELM, facingState(NZ));

function seaRig(spawn: { x: number; y: number; z: number }): Rig {
  const sim = new Simulation({
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
    spawn,
  });
  return new Rig(sim);
}

function fill(sim: Simulation, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  const c = makeCell(id);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) sim.world.setCell(x, y, z, c);
}

/** Watch every applied batch of every client: the plank count must stay `n`. */
function conserve(rig: Rig, id: number, box: Box): () => number {
  const n = countServer(rig.sim, id, box);
  let checked = 0;
  for (const c of rig.clients.values()) {
    c.onBatch = () => {
      if (!c.state.ready) return;
      expect(countReplica(c.state, id, box), `${c.key}: planks at tick ${c.state.tick}`).toBe(n);
      checked++;
    };
  }
  return () => checked;
}

function sneakUse(rig: Rig, key: string): void {
  const p = rig.ctrl(key).player;
  p.input.sneak = true;
  rig.ctrl(key).use();
  rig.tick();
  p.input.sneak = false;
}

describe('replication of ships (package 4)', () => {
  it('a raft assembled, sailed and docked: digests agree every tick, planks are conserved in every batch', () => {
    const rig = seaRig({ x: 2.5, y: SEA_TOP, z: 7.5 });
    const sim = rig.sim;
    rig.join('a', { viewRadius: 3 });
    rig.join('b', { viewRadius: 2 });
    rig.ctrl('b').teleport(20.5, SEA_TOP + 3, 20.5);
    fill(sim, 0, 20, 6, 4, DECK, 8, B.COBBLE); // pier
    fill(sim, 0, DECK, 0, 4, DECK, 5, B.PLANKS_OAK);
    sim.world.setCell(2, SEA_TOP, 4, HELM_N);
    sim.worldGlue.add(0, DECK, 0, PZ);
    rig.tick(30);
    expect(rig.rep.clientView('a')!.ready).toBe(true);
    const box: Box = [-40, 0, -60, 40, 60, 40];
    const checked = conserve(rig, B.PLANKS_OAK, box);
    rig.ctrl('a').emptyHand();
    rig.useOn('a', 2, SEA_TOP, 4, PZ); // preview
    expect(rig.clients.get('a')!.state.private.view.preview?.kind).toBe('ship');
    rig.useOn('a', 2, SEA_TOP, 4, PZ); // assemble, take the wheel
    const ship = sim.structures.ships()[0]!;
    expect(ship).toBeInstanceOf(Ship);
    for (const c of rig.clients.values()) expect(c.state.structures.has(ship.id), c.key).toBe(true);
    const p = rig.ctrl('a').player;
    p.input.forward = 1;
    rig.tick(60);
    p.input.forward = 0;
    rig.tick(40);
    expect(ship.grid.position.z).toBeLessThan(-1);
    sneakUse(rig, 'a'); // dock
    expect(ship.removed).toBe(true);
    for (const c of rig.clients.values()) expect(c.state.structures.size, c.key).toBe(0);
    rig.tick(20);
    rig.check('full');
    expect(checked()).toBeGreaterThan(200);
  });
});

/** Size of the batch a client received for a tick. */
function batchBytes(rig: Rig, key: string, tick: number): number {
  return rig.clients.get(key)!.batches.find((b) => b.tick === tick)?.bytes ?? -1;
}

describe('replication of large and nested structures (package 4)', () => {
  it('a 3700-cell ship assembled next to two players and docked again: one batch carries both sides, conserved', () => {
    const rig = seaRig({ x: 18.5, y: SEA_TOP, z: 47.5 });
    const sim = rig.sim;
    rig.join('a', { viewRadius: 4 });
    rig.join('b', { viewRadius: 4 });
    rig.ctrl('b').teleport(10.5, SEA_TOP, 20.5);
    rig.tick(20); // the chunks load
    fill(sim, 0, DECK - 1, 0, 36, DECK, 49, B.PLANKS_OAK);
    sim.world.setCell(18, SEA_TOP, 45, HELM_N);
    rig.ctrl('a').teleport(18.5, SEA_TOP, 47.5);
    rig.tick(20);
    expect(countServer(sim, B.PLANKS_OAK, [-60, 0, -60, 100, 60, 110] as Box)).toBe(3700);
    const box: Box = [-60, 0, -80, 100, 60, 110];
    const checked = conserve(rig, B.PLANKS_OAK, box);
    rig.ctrl('a').emptyHand();
    rig.useOn('a', 18, SEA_TOP, 45, PZ);
    const t0 = sim.ticks + 1;
    rig.useOn('a', 18, SEA_TOP, 45, PZ);
    const ship = sim.structures.ships()[0]!;
    expect(ship.grid.count).toBe(3701);
    const sizes = { a: batchBytes(rig, 'a', t0), b: batchBytes(rig, 'b', t0) };
    console.log(`[sizes] 3700-cell ship, assembly tick: ${JSON.stringify(sizes)} bytes`);
    for (const k of ['a', 'b'] as const) {
      const b = rig.clients.get(k)!.batches.find((x) => x.tick === t0)!.batch;
      expect(b.structureSpawns.length).toBe(1);
      expect(b.chunkDeltas.length).toBeGreaterThan(0);
      expect(sizes[k]).toBeLessThan(18 * 1024); // section 13: 7-9 KB measured, 18 KB at the upper bound
    }
    const p = rig.ctrl('a').player;
    p.input.forward = 1;
    rig.tick(40);
    p.input.forward = 0;
    rig.tick(20);
    sneakUse(rig, 'a');
    expect(ship.removed).toBe(true);
    rig.tick(10);
    rig.check('full');
    expect(checked()).toBeGreaterThan(100);
  });

  it('a windmill boat: world rotor, assembled onto the ship (re-parented), stopped and restarted on the ship, docked (back to the world), stopped and restarted in the world', () => {
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: new TerrainGenerator(1), syncChunks: true, loadRadius: 3, rabbits: false });
    const rig = new Rig(sim);
    rig.join('a', { viewRadius: 4 });
    const helm = placeExampleShip(sim)!;
    expect(helm).not.toBeNull();
    const bow = stateFacing(cellState(sim.world.getCell(helm.x, helm.y, helm.z))) as Dir;
    const at = (u: number, v: number, y: number): { x: number; y: number; z: number } => exampleShipCell(helm, bow, u, v, y);
    rig.join('b', { viewRadius: 3 });
    const sb = at(-1, 3, DECK_Y);
    rig.ctrl('b').teleport(sb.x + 0.5, DECK_Y, sb.z + 0.5);
    rig.tick(20);
    const box: Box = [helm.x - 48, 40, helm.z - 48, helm.x + 48, 60, helm.z + 48];
    const planks = conserve(rig, B.PLANKS_OAK, box);
    // Start the windmill (world rotor).
    const stand = at(1, BEARING_V, DECK_Y);
    rig.ctrl('a').teleport(stand.x + 0.5, DECK_Y, stand.z + 0.5);
    rig.ctrl('a').emptyHand();
    rig.tick(2);
    const b = at(0, BEARING_V, MAST_TOP_Y);
    rig.useOn('a', b.x, b.y, b.z);
    rig.useOn('a', b.x, b.y, b.z);
    const rotor = sim.structures.rotors()[0]!;
    expect(rotor.parent).toBeNull();
    rig.tick(40);
    // Assemble at the helm: the running rotor rides along.
    const front = at(0, 2, DECK_Y);
    rig.ctrl('a').teleport(front.x + 0.5, DECK_Y, front.z + 0.5);
    rig.tick(2);
    rig.useOn('a', helm.x, helm.y, helm.z);
    const tAssemble = sim.ticks + 1;
    rig.useOn('a', helm.x, helm.y, helm.z);
    const ship = sim.structures.ships()[0]!;
    expect(rotor.parent).toBe(ship);
    for (const c of rig.clients.values()) {
      const batch = c.batches.find((x) => x.tick === tAssemble)!.batch;
      expect(batch.structureSpawns.map((s) => s.id), c.key).toEqual([ship.id, rotor.id]); // parent first, the rotor resent
      expect(c.state.structures.get(rotor.id)!.structure.parent, c.key).toBe(c.state.structures.get(ship.id)!.structure);
    }
    const p = rig.ctrl('a').player;
    p.input.forward = 1;
    rig.tick(60);
    p.input.forward = 0;
    rig.tick(20);
    // Stop the windmill on the ship (blockify into the ship) and start it again.
    sim.structures.stopRotor(rotor);
    rig.tick(5);
    const r2 = sim.structures.startRotor(ship.grid, b.x, b.y, b.z);
    expect(r2.ok).toBe(true);
    const rotor2 = (r2 as { structure: Rotor }).structure;
    rig.tick(60);
    for (const c of rig.clients.values()) expect(c.state.structures.get(rotor2.id)?.structure.parent?.id, c.key).toBe(ship.id);
    // Dock from the wheel: the rotor keeps running, mounted on the world.
    sneakUse(rig, 'a');
    expect(ship.removed).toBe(true);
    expect(rotor2.parent).toBeNull();
    expect(rotor2.removed).toBe(false);
    for (const c of rig.clients.values()) {
      expect(c.state.structures.has(ship.id), c.key).toBe(false);
      expect(c.state.structures.get(rotor2.id)!.structure.parent, c.key).toBeNull();
    }
    rig.tick(40);
    sim.structures.stopRotor(rotor2);
    rig.tick(5);
    const r3 = sim.structures.startRotor(sim.world, rotor2.bearingX, rotor2.bearingY, rotor2.bearingZ);
    expect(r3.ok).toBe(true);
    rig.tick(150); // past a ROTOR_RESYNC_TICKS resync
    rig.check('full');
    console.log(rig.ms);
    expect(planks()).toBeGreaterThan(300);
  }, 300_000);
});
