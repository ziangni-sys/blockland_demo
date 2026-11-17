import { describe, expect, it } from 'vitest';
import { cellState, ID_MASK, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SEA_LEVEL } from '../../src/core/constants';
import { DIR_X, DIR_Z, NY, type Dir } from '../../src/core/dirs';
import { qrotate, vec3 } from '../../src/core/math';
import {
  BEARING_V,
  DECK_Y,
  exampleShipCell,
  exampleShipParts,
  FLOOR_Y,
  HUB_V,
  MAST_TOP_Y,
  MAST_V,
  MAX_DISTANCE,
  MIN_DISTANCE,
  placeExampleShip,
} from '../../src/sim/exampleShip';
import { Simulation } from '../../src/sim/simulation';
import { Rotor, Ship } from '../../src/structures/structure';
import { FlatGenerator, TerrainGenerator, VoidGenerator } from '../../src/worldgen/generator';
import { flatSim } from './helpers';
import { soloSim } from '../solo';

const SEEDS = [1, 2, 3, 4, 5, 6];

function terrainSim(seed: number): Simulation {
  return soloSim({ seed, mode: 'creative', generator: new TerrainGenerator(seed), syncChunks: true, loadRadius: 3, rabbits: false });
}

interface Placed {
  sim: Simulation;
  helm: { x: number; y: number; z: number };
  bow: Dir;
  at: (u: number, v: number, y: number) => { x: number; y: number; z: number };
}

function placed(seed: number): Placed {
  const sim = terrainSim(seed);
  const helm = placeExampleShip(sim);
  expect(helm, `seed ${seed}`).not.toBeNull();
  const bow = stateFacing(cellState(sim.world.getCell(helm!.x, helm!.y, helm!.z))) as Dir;
  return { sim, helm: helm!, bow, at: (u, v, y) => exampleShipCell(helm!, bow, u, v, y) };
}

/** Largest tilt (radians) of a ship's local up axis from world up. */
function tilt(ship: Ship): number {
  const up = qrotate(ship.grid.rotation, vec3(0, 1, 0), vec3());
  return Math.acos(Math.min(1, Math.max(-1, up.y)));
}

/** Click the bearing twice from the starboard side of the deck next to the mast. */
function startWindmill(p: Placed): void {
  const { sim, at } = p;
  const stand = at(1, BEARING_V, DECK_Y);
  sim.soloPlayer.teleport(stand.x + 0.5, DECK_Y, stand.z + 0.5);
  sim.soloPlayer.emptyHand();
  sim.advance(2);
  const b = at(0, BEARING_V, MAST_TOP_Y);
  expect(sim.soloPlayer.useOn(b.x, b.y, b.z)).toBe(true); // preview
  expect(sim.structures.rotors().length).toBe(0);
  expect(sim.soloPlayer.view.preview?.kind).toBe('rotor');
  expect(sim.soloPlayer.useOn(b.x, b.y, b.z)).toBe(true); // start
}

/** Click the helm twice from the deck just in front of it: assemble and take the wheel. */
function assembleAtHelm(p: Placed): Ship {
  const { sim, at, helm } = p;
  const stand = at(0, 2, DECK_Y);
  sim.soloPlayer.teleport(stand.x + 0.5, DECK_Y, stand.z + 0.5);
  sim.soloPlayer.emptyHand();
  sim.advance(2);
  expect(sim.soloPlayer.useOn(helm.x, helm.y, helm.z)).toBe(true); // preview
  expect(sim.structures.ships().length).toBe(0);
  expect(sim.soloPlayer.useOn(helm.x, helm.y, helm.z)).toBe(true); // assemble
  const ships = sim.structures.ships();
  expect(ships.length).toBe(1);
  expect(sim.soloPlayer.player.steeringShipId).toBe(ships[0]!.id);
  return ships[0]!;
}

/** 600 ticks afloat: upright, not sinking; then full throttle moves it toward the bow. */
function sailsWell(p: Placed, ship: Ship): void {
  const { sim, bow } = p;
  const y0 = ship.grid.position.y;
  let maxTilt = 0;
  let minY = y0;
  for (let i = 0; i < 600; i++) {
    sim.tick();
    maxTilt = Math.max(maxTilt, tilt(ship));
    minY = Math.min(minY, ship.grid.position.y);
  }
  expect(ship.removed).toBe(false);
  expect(ship.hull?.floats).toBe(true);
  expect(maxTilt).toBeLessThan((10 * Math.PI) / 180);
  expect(minY).toBeGreaterThan(y0 - 0.5);
  expect(ship.grid.position.y).toBeGreaterThan(SEA_LEVEL - 1.5);
  const p0 = { x: ship.grid.position.x, z: ship.grid.position.z };
  sim.soloPlayer.player.input.forward = 1;
  sim.advance(60);
  expect(ship.throttle).toBe(1);
  const dx = ship.grid.position.x - p0.x;
  const dz = ship.grid.position.z - p0.z;
  // Mostly along the bow, a few blocks in three seconds.
  expect(dx * DIR_X[bow]! + dz * DIR_Z[bow]!).toBeGreaterThan(2);
}

describe('example windmill boat (new worlds)', () => {
  it('is stamped as blocks on open water near the spawn, within range, for every seed', () => {
    for (const seed of SEEDS) {
      const { sim, at } = placed(seed);
      const w = sim.world;
      const spawn = sim.soloPlayer.player.spawn;
      for (const part of exampleShipParts()) {
        const c = at(part.u, part.v, part.y);
        const id = w.getCell(c.x, c.y, c.z) & ID_MASK;
        expect(id, `seed ${seed} part ${JSON.stringify(part)}`).toBe(part.cell & ID_MASK);
        const d = Math.hypot(c.x + 0.5 - spawn.x, c.z + 0.5 - spawn.z);
        expect(d).toBeGreaterThanOrEqual(MIN_DISTANCE);
        expect(d).toBeLessThanOrEqual(MAX_DISTANCE);
        // Floor cells sit in the top water layer, on water.
        if (part.y === FLOOR_Y) expect(w.getCell(c.x, FLOOR_Y - 1, c.z) & ID_MASK).toBe(B.WATER);
      }
      // Open water around it: two cells beyond the gunwale on both sides, at the bow and stern.
      for (const [u, v] of [[-4, 4], [4, 4], [0, -2], [0, 10]] as const) {
        const c = at(u, v, FLOOR_Y);
        expect(w.getCell(c.x, FLOOR_Y, c.z) & ID_MASK).toBe(B.WATER);
        expect(w.getCell(c.x, DECK_Y, c.z) & ID_MASK).toBe(B.AIR);
      }
      // The bow faces open water: a clear stretch ahead of it.
      for (let k = 1; k <= 12; k++) {
        const c = at(0, 8 + k, FLOOR_Y);
        expect(w.getCell(c.x, FLOOR_Y, c.z) & ID_MASK, `seed ${seed}: ${k} ahead of the bow`).toBe(B.WATER);
      }
      // The two glued faces: mast foot to the floor, hub to the bearing.
      const foot = at(0, MAST_V, DECK_Y);
      expect(sim.worldGlue.has(foot.x, foot.y, foot.z, NY)).toBe(true);
      expect(sim.worldGlue.size).toBe(2);
    }
  });

  it('is deterministic for a seed', () => {
    expect(placeExampleShip(terrainSim(3))).toEqual(placeExampleShip(terrainSim(3)));
  });

  it('obeys the game rules: the bearing previews a startable rotor, the helm a ship with everything', () => {
    for (const seed of SEEDS) {
      const { sim, helm, at } = placed(seed);
      const b = at(0, BEARING_V, MAST_TOP_Y);
      const rotor = sim.structures.previewRotor(sim.world, b.x, b.y, b.z);
      expect(rotor.ok, `seed ${seed}: ${rotor.reason}`).toBe(true);
      expect(rotor.sails).toBeGreaterThanOrEqual(sim.rotorMinSails);
      expect(rotor.count).toBe(13);
      const ship = sim.structures.previewShip(helm.x, helm.y, helm.z);
      expect(ship.ok, `seed ${seed}: ${ship.reason}`).toBe(true);
      expect(ship.count).toBe(exampleShipParts().length);
    }
  });

  it('player flow: start the windmill with two clicks, assemble at the helm, the boat carries the running rotor and sails', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const p = placed(seed);
      const { sim, at } = p;
      startWindmill(p);
      const rotors = sim.structures.rotors();
      expect(rotors.length).toBe(1);
      expect(rotors[0]!.sails).toBe(13);
      sim.advance(40); // spin up; its sweep must clear the boat (nothing breaks)
      expect(sim.structures.rotors().length).toBe(1);
      const ship = assembleAtHelm(p);
      // Mast and bearing came along; the running windmill rides as the ship's child rotor.
      const mast = at(0, MAST_V, MAST_TOP_Y);
      const b = at(0, BEARING_V, MAST_TOP_Y);
      expect(ship.grid.getCell(mast.x, mast.y, mast.z) & ID_MASK).toBe(B.LOG_OAK);
      expect(ship.grid.getCell(b.x, b.y, b.z) & ID_MASK).toBe(B.BEARING);
      expect(ship.children.length).toBe(1);
      expect(ship.children[0]).toBeInstanceOf(Rotor);
      expect(ship.children[0]!.removed).toBe(false);
      expect(ship.sails).toBe(13);
      expect(ship.grid.count).toBe(exampleShipParts().length - 13);
      // Nothing of the boat is left in the world.
      expect(sim.world.getCell(b.x, b.y, b.z) & ID_MASK).toBe(B.AIR);
      sailsWell(p, ship);
      expect(ship.children[0]!.removed).toBe(false);
    }
  });

  it('player flow: assembling with the windmill stopped takes it along (hub glued to the bearing)', () => {
    for (const seed of SEEDS.slice(3)) {
      const p = placed(seed);
      const { sim, at } = p;
      const ship = assembleAtHelm(p);
      expect(ship.grid.count).toBe(exampleShipParts().length);
      const hub = at(0, HUB_V, MAST_TOP_Y);
      expect(ship.grid.getCell(hub.x, hub.y, hub.z) & ID_MASK).toBe(B.WOOL_YELLOW);
      expect(ship.children.length).toBe(0);
      expect(sim.worldGlue.size).toBe(0);
      expect(ship.glue.size).toBe(2);
      sailsWell(p, ship);
    }
  });

  it('returns null and writes nothing where there is no water', () => {
    const flat = flatSim();
    const before = [...flat.world.chunks.values()].map((c) => c.modified);
    expect(placeExampleShip(flat)).toBeNull();
    expect(flat.worldGlue.size).toBe(0);
    expect([...flat.world.chunks.values()].every((c) => !c.modified)).toBe(true);
    expect(before.every((m) => !m)).toBe(true);
    // The search stays bounded: at most 7 x 7 chunk columns around the spawn are generated.
    expect(flat.world.chunks.size).toBeLessThanOrEqual(49);

    const empty = soloSim({ seed: 9, mode: 'creative', generator: new VoidGenerator(), syncChunks: true, rabbits: false });
    expect(placeExampleShip(empty)).toBeNull();
    expect(empty.worldGlue.size).toBe(0);

    const flatAgain = soloSim({ seed: 9, mode: 'survival', generator: new FlatGenerator(), syncChunks: true, rabbits: false });
    expect(() => placeExampleShip(flatAgain)).not.toThrow();
  });
});
