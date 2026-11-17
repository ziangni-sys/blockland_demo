import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PX, PZ } from '../../src/core/dirs';
import { exportSave, importSave, type SaveBundle } from '../../src/sim/persist';
import { Simulation } from '../../src/sim/simulation';
import { Rotor, Ship, type Structure } from '../../src/structures/structure';
import { FlatGenerator } from '../../src/worldgen/generator';
import { FLAT_TOP, SEA_TOP, click, countId, fill, flatSim, seaGenerator, seaSim } from './helpers';

const T = FLAT_TOP;

function cellsOf(s: Structure): string[] {
  const out: string[] = [];
  s.grid.forEachCell((x, y, z, c) => out.push(`${x},${y},${z}:${c}`));
  return out;
}

/** Copy a bundle through fresh byte arrays, as a storage round trip would. */
function copyBundle(b: SaveBundle): SaveBundle {
  return {
    chunks: b.chunks.map(([k, v]) => [k, Uint8Array.from(v)] as [number, Uint8Array]),
    blobs: b.blobs.map(([k, v]) => [k, Uint8Array.from(v)] as [string, Uint8Array]),
  };
}

/** Sea scene: raft + helm + a plank mast carrying a stopped windmill glued to its bearing. */
function shipWithWindmill(): Simulation {
  const sim = seaSim({ spawn: { x: 2.5, y: SEA_TOP + 12, z: 9.5 } });
  sim.player.flying = true;
  const w = sim.world;
  fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 4, B.PLANKS_OAK);
  w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
  fill(w, 2, SEA_TOP, 2, 2, SEA_TOP + 3, 2, B.PLANKS_OAK);
  w.setCell(2, SEA_TOP + 3, 1, makeCell(B.BEARING, facingState(NZ)));
  const hub = { x: 2, y: SEA_TOP + 3, z: 0 };
  w.setCell(hub.x, hub.y, hub.z, makeCell(B.CANVAS));
  for (const [dx, dy] of [
    [1, 0],
    [2, 0],
    [-1, 0],
    [-2, 0],
    [0, 1],
    [0, 2],
    [0, -1],
    [0, -2],
  ] as const) {
    w.setCell(hub.x + dx, hub.y + dy, hub.z, makeCell(B.CANVAS));
  }
  // hub <-> bearing glue: the stopped windmill rides along when the ship assembles
  sim.worldGlue.add(hub.x, hub.y, hub.z, PZ);
  // a stone glued onto the deck
  w.setCell(0, SEA_TOP, 0, makeCell(B.STONE));
  sim.worldGlue.add(0, SEA_TOP, 0, 3);
  // and some glue that stays in the world
  w.setCell(8, SEA_TOP, 8, makeCell(B.STONE));
  w.setCell(9, SEA_TOP, 8, makeCell(B.STONE));
  fill(w, 8, 20, 8, 9, SEA_TOP - 1, 8, B.STONE);
  sim.worldGlue.add(8, SEA_TOP, 8, PX);
  const sres = sim.structures.assembleShip(2, SEA_TOP, 4);
  if (!sres.ok) throw new Error(`assemble failed: ${sres.reason}`);
  const rres = sim.structures.startRotor(sres.structure.grid, 2, SEA_TOP + 3, 1);
  if (!rres.ok) throw new Error(`rotor failed: ${rres.reason}`);
  return sim;
}

describe('save / load', () => {
  it('structures (nested), glue and rotor angles survive a round trip (ACCEPTANCE 23, 14)', () => {
    const sim = shipWithWindmill();
    sim.advance(40);
    const ship = sim.structures.ships()[0]!;
    const rotor = sim.structures.rotors()[0]!;
    expect(rotor.parent).toBe(ship);
    expect(rotor.angle).not.toBe(0);
    expect(ship.glue.has(2, SEA_TOP + 3, 0, PZ)).toBe(true); // the hub glue, on the ship's bearing
    expect(ship.glue.size).toBeGreaterThan(0);
    sim.setDayTime(0.3);

    const bundle = copyBundle(exportSave(sim));
    const sim2 = new Simulation({ seed: 2, mode: 'creative', generator: seaGenerator(), syncChunks: true, loadRadius: 2, rabbits: false });
    importSave(sim2, bundle);

    const a = sim.structures.all();
    const b = sim2.structures.all();
    expect(b.map((s) => [s.id, s.kind, s.parent?.id ?? 0])).toEqual(a.map((s) => [s.id, s.kind, s.parent?.id ?? 0]));
    for (let i = 0; i < a.length; i++) {
      const sa = a[i]!;
      const sb = b[i]!;
      expect(cellsOf(sb)).toEqual(cellsOf(sa));
      expect(sb.glue.toArray()).toEqual(sa.glue.toArray());
      expect(sb.grid.position).toEqual(sa.grid.position);
      expect(sb.grid.rotation).toEqual(sa.grid.rotation);
      expect(sb.grid.pivot).toEqual(sa.grid.pivot);
    }
    const rotor2 = sim2.structures.rotors()[0]!;
    expect(rotor2.angle).toBe(rotor.angle);
    expect(rotor2.angularSpeed).toBe(rotor.angularSpeed);
    expect(rotor2.sails).toBe(rotor.sails);
    expect(sim2.worldGlue.toArray()).toEqual(sim.worldGlue.toArray());
    expect(sim2.worldGlue.size).toBe(1);
    expect(sim2.dayTime).toBeCloseTo(sim.dayTime, 10);
    expect(sim2.world.time).toBe(sim.world.time);
    expect(sim2.rng.state).toBe(sim.rng.state);

    // Both continue the same way.
    sim.advance(20);
    sim2.advance(20);
    expect(rotor2.angle).toBe(rotor.angle);
    const ship2 = sim2.structures.ships()[0]!;
    expect(ship2.grid.position.x).toBeCloseTo(ship.grid.position.x, 3);
    expect(ship2.grid.position.y).toBeCloseTo(ship.grid.position.y, 3);
    expect(ship2.grid.position.z).toBeCloseTo(ship.grid.position.z, 3);

    // The loaded windmill stops with its hub glued to the bearing again (ACCEPTANCE 14).
    sim2.structures.stopRotor(rotor2);
    expect(rotor2.removed).toBe(true);
    expect(ship2.glue.has(2, SEA_TOP + 3, 0, PZ)).toBe(true);
  });

  it('water saved mid-flow keeps flowing after loading and fills the 113-cell diamond (ACCEPTANCE 23)', () => {
    const gen = new FlatGenerator();
    const make = (): Simulation =>
      new Simulation({ seed: 4, mode: 'creative', generator: gen, syncChunks: true, loadRadius: 2, rabbits: false, spawn: { x: 0.5, y: T, z: 0.5 } });
    const sim = make();
    sim.advance(2);
    sim.hold(I.BUCKET_WATER, 1);
    sim.teleport(10.5, T, 14.5);
    sim.lookAtCell(10, T - 1, 10, 2 /* PY */);
    click(sim);
    expect(sim.world.getCell(10, T, 10) & 1023).toBe(B.WATER);
    sim.advance(7); // 0.4 s after pouring (the pouring tick included)
    const midway = countId(sim.world, B.WATER, 0, T, 0, 20, T, 20);
    expect(midway).toBeGreaterThan(1);
    expect(midway).toBeLessThan(113);
    const bundle = copyBundle(exportSave(sim));

    const sim2 = make();
    importSave(sim2, bundle);
    sim2.advance(300);
    expect(countId(sim2.world, B.WATER, 0, T, 0, 20, T, 20)).toBe(113);
    for (let x = 0; x <= 20; x++) {
      for (let z = 0; z <= 20; z++) {
        const inside = Math.abs(x - 10) + Math.abs(z - 10) <= 7;
        expect((sim2.world.getCell(x, T, z) & 1023) === B.WATER).toBe(inside);
      }
    }
    sim.advance(300);
    expect(countId(sim.world, B.WATER, 0, T, 0, 20, T, 20)).toBe(113);
  });

  it('what the hands were doing is not saved', () => {
    const sim = flatSim({ mode: 'survival', spawn: { x: 0.5, y: T, z: 0.5 } });
    sim.world.setCell(0, T + 1, -2, makeCell(B.STONE));
    sim.hold(I.GLUE, 5);
    sim.lookAtCell(0, T + 1, -2, PZ);
    sim.player.input.use = true;
    click(sim);
    sim.advance(5);
    expect(sim.view.glueProgress).toBeGreaterThan(0); // a timed glue operation is running
    const sim2 = flatSim({ mode: 'survival', spawn: { x: 0.5, y: T, z: 0.5 } });
    importSave(sim2, exportSave(sim));
    expect(sim2.view.glueProgress).toBe(0);
    sim2.player.input.use = true; // still holding the button: nothing resumes
    sim2.lookAtCell(0, T + 1, -2, PZ);
    sim2.advance(60);
    expect(sim2.view.glueProgress).toBe(0);
    expect(sim2.worldGlue.size).toBe(0);
    expect(sim2.player.inventory.selectedStack()).toEqual({ item: I.GLUE, count: 5 });
  });

  it('the off-hand stack is saved with the player', () => {
    const sim = flatSim({ mode: 'survival', spawn: { x: 0.5, y: T, z: 0.5 } });
    sim.hold(I.GLUE, 7);
    sim.swapHands();
    sim.tick();
    expect(sim.player.inventory.offhand).toEqual({ item: I.GLUE, count: 7 });
    const sim2 = flatSim({ mode: 'survival', spawn: { x: 0.5, y: T, z: 0.5 } });
    importSave(sim2, copyBundle(exportSave(sim)));
    expect(sim2.player.inventory.offhand).toEqual({ item: I.GLUE, count: 7 });
    expect(sim2.player.inventory.count(I.GLUE)).toBe(7);
  });

  it('a new simulation with the same seed inherits nothing from the previous one (ACCEPTANCE 24)', () => {
    const first = shipWithWindmill();
    first.advance(10);
    first.entities.spawnRabbit(3.5, SEA_TOP + 1, 9.5);
    first.entities.spawnItem(3.5, SEA_TOP + 1, 9.5, B.DIRT, 3);
    expect(first.worldGlue.size).toBe(1);
    expect(first.structures.all().length).toBe(2);
    const fresh = seaSim({ spawn: { x: 2.5, y: SEA_TOP + 12, z: 9.5 } });
    expect(fresh.worldGlue.size).toBe(0);
    expect(fresh.structures.all().length).toBe(0);
    expect(fresh.entities.all().length).toBe(1);
    // Ids start over in the new world.
    fill(fresh.world, 0, SEA_TOP - 1, 0, 2, SEA_TOP - 1, 2, B.PLANKS_OAK);
    fresh.world.setCell(1, SEA_TOP, 1, makeCell(B.HELM, facingState(NZ)));
    const res = fresh.structures.assembleShip(1, SEA_TOP, 1);
    expect(res.ok && res.structure.id).toBe(1);
    expect(res.ok && res.structure instanceof Ship).toBe(true);
    expect(first.structures.all().some((s) => s instanceof Rotor)).toBe(true); // the old world is untouched
  });

  it('a simulation built for loading (deferInitialLoad) generates nothing itself and ends up the same as the normal path', () => {
    const sim = shipWithWindmill();
    sim.advance(30);
    const bundle = copyBundle(exportSave(sim));
    const opts = { seed: 2, mode: 'creative', generator: seaGenerator(), syncChunks: true, loadRadius: 2, rabbits: false } as const;
    const normal = new Simulation(opts);
    const deferred = new Simulation({ ...opts, deferInitialLoad: true });
    expect(normal.world.chunks.size).toBeGreaterThan(0);
    expect(deferred.world.chunks.size).toBe(0);
    importSave(normal, bundle);
    importSave(deferred, copyBundle(bundle));
    expect([...deferred.world.chunks.keys()].sort()).toEqual([...normal.world.chunks.keys()].sort());
    expect(deferred.ticks).toBe(sim.ticks);
    normal.advance(20);
    deferred.advance(20);
    sim.advance(20);
    for (const other of [normal, deferred]) {
      expect(other.ticks).toBe(sim.ticks);
      expect(other.rng.state).toBe(sim.rng.state);
      expect(other.structures.rotors()[0]!.angle).toBe(sim.structures.rotors()[0]!.angle);
      expect(other.structures.ships()[0]!.grid.position).toEqual(sim.structures.ships()[0]!.grid.position);
      expect(other.player.pos).toEqual(sim.player.pos);
    }
  });
});
