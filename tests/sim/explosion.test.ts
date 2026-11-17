import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PX, PY } from '../../src/core/dirs';
import { CHAIN_FUSE_MAX, CHAIN_FUSE_MIN, explode } from '../../src/sim/explosion';
import type { Simulation } from '../../src/sim/simulation';
import type { TntEntity } from '../../src/entities/entity';
import { EventLog, FLAT_TOP, SEA_TOP, countId, fill, flatSim, idAt, items, seaSim } from './helpers';

const T = FLAT_TOP;

/** Every non-air cell of the world in a box, as "x,y,z:id" strings. */
function snapshot(sim: Simulation, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string[] {
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push(`${x},${y},${z}:${idAt(sim.world, x, y, z)}`);
  return out;
}

describe('explosions', () => {
  it('the crater is deterministic, irregular and bounded', () => {
    const craters: string[][] = [];
    for (let k = 0; k < 2; k++) {
      const sim = flatSim({ seed: 77 });
      sim.teleport(20.5, T, 20.5);
      sim.advance(3);
      explode(sim, 0.5, T - 2.5, -5.5, 4, null);
      craters.push(snapshot(sim, -9, T - 12, -15, 10, T, 4));
    }
    expect(craters[0]).toEqual(craters[1]);
    const removed = craters[0]!.filter((s) => s.endsWith(':0') && Number(s.split(',')[1]) < T).length;
    expect(removed).toBeGreaterThan(10);
    // Nothing beyond the longest possible ray.
    const sim = flatSim({ seed: 78 });
    sim.teleport(20.5, T, 20.5);
    explode(sim, 0.5, T - 2.5, -5.5, 4, null);
    for (let y = T - 12; y < T; y++) {
      for (let z = -15; z <= 4; z++) {
        for (let x = -9; x <= 10; x++) {
          if (idAt(sim.world, x, y, z) !== B.AIR) continue;
          const d = Math.hypot(x + 0.5 - 0.5, y + 0.5 - (T - 2.5), z + 0.5 + 5.5);
          expect(d).toBeLessThan(8);
        }
      }
    }
  });

  it('blast resistance is respected: obsidian stands and shields what is behind it', () => {
    const sim = flatSim({ seed: 5 });
    sim.teleport(20.5, T, 20.5);
    const w = sim.world;
    // Blast at (0.5, T+1.5, 0.5); obsidian wall at z = -2; two dirt blocks at the same distance.
    fill(w, -3, T, -2, 3, T + 4, -2, B.OBSIDIAN);
    w.setCell(0, T + 1, -3, makeCell(B.DIRT)); // behind the wall
    w.setCell(0, T + 1, 3, makeCell(B.DIRT)); // in the open
    explode(sim, 0.5, T + 1.5, 0.5, 4, null);
    expect(countId(w, B.OBSIDIAN, -3, T, -2, 3, T + 4, -2)).toBe(7 * 5);
    expect(idAt(w, 0, T + 1, -3)).toBe(B.DIRT);
    expect(idAt(w, 0, T + 1, 3)).toBe(B.AIR);
  });

  it('blast crates caught in a blast are primed with a short fuse (chain reaction); items drop only in survival', () => {
    const sim = flatSim({ seed: 9, mode: 'survival' });
    sim.teleport(20.5, T, 20.5);
    const w = sim.world;
    w.setCell(2, T, 0, makeCell(B.TNT));
    const log = new EventLog(sim);
    explode(sim, 0.5, T + 0.5, 0.5, 4, null);
    expect(idAt(w, 2, T, 0)).toBe(B.AIR);
    const primed = sim.entities.all().filter((e) => e.kind === 'tnt') as TntEntity[];
    expect(primed.length).toBe(1);
    expect(primed[0]!.fuse).toBeGreaterThanOrEqual(CHAIN_FUSE_MIN);
    expect(primed[0]!.fuse).toBeLessThanOrEqual(CHAIN_FUSE_MAX);
    expect(items(sim).entities).toBeGreaterThan(0); // some turf / dirt dropped
    expect(items(sim, B.TNT).entities).toBe(0); // the crate did not drop as an item
    sim.advance(CHAIN_FUSE_MAX + 1);
    expect(log.of('explosion').length).toBe(2);
    expect(sim.entities.all().filter((e) => e.kind === 'tnt').length).toBe(0);

    const c = flatSim({ seed: 9, mode: 'creative' });
    c.teleport(40.5, T, 40.5);
    explode(c, 0.5, T + 0.5, 0.5, 4, null);
    expect(items(c).entities).toBe(0);
  });

  it('right-clicking a blast crate lights it; it explodes after its fuse', () => {
    const sim = flatSim({ seed: 9 });
    sim.world.setCell(0, T, -2, makeCell(B.TNT));
    const log = new EventLog(sim);
    sim.hold(B.TORCH); // a block item: right-click places instead
    sim.lookAtCell(0, T, -2, PY);
    sim.tick();
    expect(sim.view.hint).toBeNull();
    sim.player.inventory.hotbar[sim.player.inventory.selected] = null;
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.tnt.ignite');
    sim.use();
    sim.tick();
    expect(idAt(sim.world, 0, T, -2)).toBe(B.AIR);
    expect(sim.entities.all().filter((e) => e.kind === 'tnt').length).toBe(1);
    sim.teleport(30.5, T, 30.5);
    sim.advance(85);
    expect(log.of('explosion').length).toBe(1);
  });

  it('a bearing destroyed by a blast: the surviving blades blockify after the wave (world, ACCEPTANCE 11)', () => {
    const sim = flatSim({ seed: 11 });
    sim.teleport(30.5, T, 30.5);
    const w = sim.world;
    fill(w, -1, T, -4, -1, T + 6, -4, B.STONE_BRICKS);
    w.setCell(0, T + 6, -4, makeCell(B.BEARING, facingState(PX)));
    // a long arm of canvas: blades near the bearing go, the far ones survive
    for (let dy = -4; dy <= 4; dy++) w.setCell(1, T + 6 + dy, -4, makeCell(B.CANVAS));
    const res = sim.structures.startRotor(w, 0, T + 6, -4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rotor = res.structure;
    sim.advance(3);
    explode(sim, 0.5, T + 6.5, -3.5, 3, null);
    expect(idAt(w, 0, T + 6, -4)).toBe(B.AIR);
    expect(rotor.removed).toBe(true);
    expect(sim.structures.all().length).toBe(0);
    const survivors = rotor.grid.count; // blockify reads the rotor; what survived the wave
    expect(survivors).toBeGreaterThan(0);
    expect(survivors).toBeLessThan(9);
    expect(countId(w, B.CANVAS, -6, T, -10, 8, T + 12, 2)).toBe(survivors);
  });

  it('a small ship blown away entirely keeps its windmill remains on the (empty) ship (ACCEPTANCE 13)', () => {
    const sim = flatSim({ seed: 13 });
    sim.teleport(20.5, T, 20.5);
    const w = sim.world;
    w.setCell(0, T, 0, makeCell(B.PLANKS_OAK));
    w.setCell(1, T, 0, makeCell(B.PLANKS_OAK));
    w.setCell(0, T + 1, 0, makeCell(B.HELM, facingState(NZ)));
    w.setCell(1, T + 1, 0, makeCell(B.BEARING, facingState(PY)));
    for (let y = T + 2; y <= T + 9; y++) w.setCell(1, y, 0, makeCell(B.CANVAS)); // a tall vertical blade
    // Start the windmill, then assemble the ship around its bearing: the rotor rides on the ship.
    const rres = sim.structures.startRotor(w, 1, T + 1, 0);
    expect(rres.ok).toBe(true);
    const sres = sim.structures.assembleShip(0, T + 1, 0);
    expect(sres.ok).toBe(true);
    if (!rres.ok || !sres.ok) return;
    const rotor = rres.structure;
    const ship = sres.structure;
    expect(rotor.parent).toBe(ship);
    expect(ship.grid.count).toBe(4);
    sim.advance(10);
    // A blast right where the four hull cells meet.
    const c = ship.grid.toWorld({ x: 1, y: T + 1, z: 0.5 });
    explode(sim, c.x, c.y, c.z, 4, null);
    expect(rotor.removed).toBe(true);
    expect(sim.structures.rotors().length).toBe(0);
    expect(ship.removed).toBe(false);
    const survivors = rotor.grid.count;
    expect(survivors).toBeGreaterThan(0);
    expect(survivors).toBeLessThan(8);
    // The ship now holds exactly the blade remains: no hull cell survived.
    expect(ship.grid.count).toBe(survivors);
    let canvas = 0;
    ship.grid.forEachCell((_x, _y, _z, cell) => {
      if ((cell & 1023) === B.CANVAS) canvas++;
    });
    expect(canvas).toBe(survivors);
    sim.advance(40); // and it lives on as a structure (falls to the ground)
    expect(ship.removed).toBe(false);
  });

  it('ships are pushed by a blast, rotors are not (compared with the same scene without the blast)', () => {
    /**
     * A raft on the sea and a windmill on a pillar west of it, a blast in the air between them
     * (or none). explode() itself moves nothing — motion happens in the following ticks — so the
     * two runs are compared over the ticks AFTER the blast: the raft's motion must differ, the
     * rotor's angle, speed and pose must not differ at all.
     */
    const run = (blast: boolean) => {
      const sim = seaSim({ seed: 15, spawn: { x: 10.5, y: SEA_TOP + 20, z: 10.5 } });
      sim.player.flying = true;
      const w = sim.world;
      fill(w, 0, SEA_TOP - 1, 0, 2, SEA_TOP - 1, 2, B.PLANKS_OAK);
      w.setCell(1, SEA_TOP, 1, makeCell(B.HELM, facingState(NZ)));
      const sres = sim.structures.assembleShip(1, SEA_TOP, 1);
      expect(sres.ok).toBe(true);
      if (!sres.ok) throw new Error('assembly failed');
      const ship = sres.structure;
      fill(w, -6, 20, 1, -6, SEA_TOP + 2, 1, B.STONE_BRICKS);
      w.setCell(-6, SEA_TOP + 3, 1, makeCell(B.BEARING, facingState(PY)));
      for (let dx = -2; dx <= 2; dx++) w.setCell(-6 + dx, SEA_TOP + 4, 1, makeCell(B.CANVAS));
      w.setCell(-6, SEA_TOP + 4, 0, makeCell(B.CANVAS));
      w.setCell(-6, SEA_TOP + 4, 2, makeCell(B.CANVAS));
      const rres = sim.structures.startRotor(w, -6, SEA_TOP + 3, 1);
      expect(rres.ok).toBe(true);
      if (!rres.ok) throw new Error('rotor failed');
      const rotor = rres.structure;
      sim.advance(60);
      const rotorCells = rotor.grid.count;
      if (blast) explode(sim, -1.5, SEA_TOP + 1.5, 1.5, 3, null);
      // The blast must not have reached the rotor's cells: any difference below is a push.
      expect(rotor.grid.count).toBe(rotorCells);
      const rotorTrace: number[] = [];
      const shipTrace: number[] = [];
      for (let i = 0; i < 20; i++) {
        sim.tick();
        const g = rotor.grid;
        rotorTrace.push(rotor.angle, rotor.angularSpeed, g.position.x, g.position.y, g.position.z, g.rotation.x, g.rotation.y, g.rotation.z, g.rotation.w);
        shipTrace.push(ship.grid.position.x, ship.grid.position.z);
      }
      expect(rotor.removed).toBe(false);
      return { rotorTrace, shipTrace, shipX: ship.grid.position.x };
    };
    const quiet = run(false);
    const blasted = run(true);
    expect(blasted.rotorTrace).toEqual(quiet.rotorTrace);
    expect(blasted.shipTrace).not.toEqual(quiet.shipTrace);
    expect(blasted.shipX - quiet.shipX).toBeGreaterThan(0.1); // pushed away from the blast (east)
  });

  it('survival damage falls off with distance and is blocked by walls; creative takes none', () => {
    const lost = (d: number, wall = false, mode: 'survival' | 'creative' = 'survival'): number => {
      const sim = flatSim({ seed: 21, mode });
      sim.teleport(0.5 + d, T, 0.5);
      sim.advance(2);
      if (wall) fill(sim.world, 1, T, -2, 1, T + 3, 3, B.OBSIDIAN);
      const h0 = sim.player.health;
      explode(sim, 0.5 - 0.5, T + 0.5, 0.5, 4, null);
      return h0 - sim.player.health;
    };
    const near = lost(2);
    const mid = lost(4.5);
    const far = lost(9);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
    expect(far).toBe(0);
    expect(lost(4.5, true)).toBe(0);
    expect(lost(2, false, 'creative')).toBe(0);
  });

  it('knocks entities back; item drops are only pushed, never destroyed', () => {
    const sim = flatSim({ seed: 22, mode: 'survival' });
    sim.teleport(30.5, T, 30.5);
    const drop = sim.entities.spawnItem(3.5, T + 0.2, 0.5, B.DIRT, 1, { x: 0, y: 0, z: 0 });
    sim.advance(5);
    explode(sim, 0.5, T + 0.5, 0.5, 4, null);
    expect(drop.removed).toBe(false);
    expect(drop.vel.x).toBeGreaterThan(1);
  });
});
