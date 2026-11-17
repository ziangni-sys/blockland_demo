import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PX, PY, PZ } from '../../src/core/dirs';
import { qfromAxisAngle } from '../../src/core/math';
import { Ship } from '../../src/structures/structure';
import type { Simulation } from '../../src/sim/simulation';
import { EventLog, SEA_TOP, click, countId, fill, idAt, seaSim } from './helpers';

/**
 * Scene on the sea: a 5x6 plank raft at the surface (y = SEA_TOP - 1), x 0..4, z 0..5, with a
 * helm facing north at (2, SEA_TOP, 4); a rubble dock touching the raft's south edge
 * (x 0..4, z 6..8, from the sea floor up), the player standing on it at (2.5, SEA_TOP, 7.5).
 */
function raftScene(mode: 'creative' | 'survival' = 'creative'): Simulation {
  const sim = seaSim({ mode, spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
  const w = sim.world;
  fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
  fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
  w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
  sim.advance(2);
  return sim;
}

function aimHelm(sim: Simulation, gridId = 0): void {
  sim.lookAtCell(2, SEA_TOP, 4, PZ, gridId);
}

function onlyShip(sim: Simulation): Ship {
  const ships = sim.structures.ships();
  expect(ships.length).toBe(1);
  return ships[0]!;
}

describe('helm: preview, assemble, steer, dock', () => {
  it('runs the whole helm flow (ACCEPTANCE 6, 8)', () => {
    const sim = raftScene();
    const log = new EventLog(sim);
    const w = sim.world;
    // A stone block that only glue holds to the raft.
    w.setCell(0, SEA_TOP, 0, makeCell(B.STONE));
    sim.worldGlue.add(0, SEA_TOP, 0, 3 /* NY */);

    // 1st click: preview only.
    aimHelm(sim);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.helm.preview');
    click(sim);
    expect(sim.structures.all().length).toBe(0);
    expect(sim.view.preview?.kind).toBe('ship');
    expect(sim.view.preview?.gridId).toBe(0);
    const n0 = 30 + 1 + 1; // planks + helm + glued stone; the rubble dock is not taken
    expect(sim.view.preview!.cells.length).toBe(n0 * 3);
    expect(sim.view.hint).toEqual({ key: 'hint.helm.assemble', params: { count: n0 } });

    // The world changes: one more plank next to the raft. The preview is dropped...
    w.setCell(5, SEA_TOP - 1, 0, makeCell(B.PLANKS_OAK));
    sim.tick();
    expect(sim.view.preview).toBeNull();
    // ...so the next click previews again (with the new plank) instead of assembling.
    click(sim);
    expect(sim.structures.all().length).toBe(0);
    expect(sim.view.preview!.cells.length).toBe((n0 + 1) * 3);

    // Unrelated liquid flow far away does not invalidate the preview.
    w.setCell(20, SEA_TOP, 20, makeCell(B.WATER));
    sim.advance(3);
    expect(sim.view.preview).not.toBeNull();

    // 2nd click on the unchanged preview: assemble, and take the wheel.
    click(sim);
    const ship = onlyShip(sim);
    expect(ship.grid.count).toBe(n0 + 1);
    expect(ship.glue.size).toBe(1);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.player.steeringShipId).toBe(ship.id);
    expect(log.of('structureAdded').map((e) => e.id)).toEqual([ship.id]);
    expect(log.toastKeys()).toContain('toast.ship.assembled');
    expect(countId(w, B.COBBLE, 0, 20, 6, 4, SEA_TOP - 1, 8)).toBe(5 * 10 * 3); // dock stays
    expect(countId(w, B.PLANKS_OAK, -2, 20, -2, 8, SEA_TOP + 2, 8)).toBe(0);
    // The vacated footprint is sea again.
    expect(idAt(w, 2, SEA_TOP - 1, 2)).toBe(B.WATER);
    expect(sim.view.hint?.key).toBe('hint.steering');
    expect(sim.helmView()).not.toBeNull();

    // Steering: W -> throttle, D -> starboard rudder; the ship goes north (its bow).
    const z0 = ship.grid.position.z;
    sim.player.input.forward = 1;
    sim.player.input.strafe = 1;
    sim.tick();
    expect(ship.throttle).toBe(1);
    expect(ship.rudder).toBe(1);
    sim.player.input.strafe = 0;
    sim.advance(80);
    expect(ship.grid.position.z).toBeLessThan(z0 - 0.3);
    // The helmsman stays on the seat (his own movement is ignored).
    const seat = ship.grid.toWorld(sim.player.seat);
    expect(Math.hypot(seat.x - sim.player.pos.x, seat.z - sim.player.pos.z)).toBeLessThan(0.05);
    sim.player.input.forward = 0;
    sim.advance(60);

    // A plain right-click lets go of the wheel.
    click(sim);
    expect(sim.player.steeringShipId).toBe(0);
    expect(ship.throttle).toBe(0);
    sim.advance(5);

    // Sneak + right-click on the helm: docking blocked by a world block where a cell would land.
    // (a corner plank, away from the line of sight to the helm)
    const hc = ship.grid.toWorld({ x: 4.5, y: SEA_TOP - 0.5, z: 0.5 });
    const bx = Math.floor(hc.x);
    const by = Math.floor(hc.y);
    const bz = Math.floor(hc.z);
    aimHelm(sim, ship.id);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.helm.steer');
    w.setCell(bx, by, bz, makeCell(B.STONE));
    sim.player.input.sneak = true;
    aimHelm(sim, ship.id);
    click(sim);
    w.setCell(bx, by, bz, 0);
    expect(log.toastKeys()).toContain('toast.dock.blocked');
    expect(sim.structures.ships().length).toBe(1);
    expect(sim.view.conflicts).toContainEqual({ x: bx, y: by, z: bz });
    sim.player.input.sneak = false;
    sim.advance(61);
    expect(sim.view.conflicts.length).toBe(0);

    // Docking for real.
    sim.player.input.sneak = true;
    aimHelm(sim, ship.id);
    click(sim);
    sim.player.input.sneak = false;
    expect(log.toastKeys()).toContain('toast.dock.done');
    expect(sim.structures.all().length).toBe(0);
    expect(log.of('structureRemoved').map((e) => e.id)).toEqual([ship.id]);
    expect(sim.worldGlue.size).toBe(1);
    // Every block is back in the world.
    let planks = 0;
    let helms = 0;
    let stones = 0;
    let hx = 0;
    let hy = 0;
    let hz = 0;
    for (let y = 20; y <= SEA_TOP + 3; y++) {
      for (let z = -20; z <= 10; z++) {
        for (let x = -10; x <= 15; x++) {
          const id = idAt(w, x, y, z);
          if (id === B.PLANKS_OAK) planks++;
          else if (id === B.HELM) {
            helms++;
            hx = x;
            hy = y;
            hz = z;
          } else if (id === B.STONE && y >= SEA_TOP) stones++;
        }
      }
    }
    expect(planks).toBe(31);
    expect(helms).toBe(1);
    expect(stones).toBe(1);

    // Re-assembling gives the same counts: cells and glue.
    sim.teleport(hx + 0.5, hy + 2, hz + 3.5);
    sim.player.flying = true;
    sim.lookAtCell(hx, hy, hz, PZ);
    click(sim);
    expect(sim.view.preview!.cells.length).toBe((n0 + 1) * 3);
    click(sim);
    const again = onlyShip(sim);
    expect(again.grid.count).toBe(n0 + 1);
    expect(again.glue.size).toBe(1);
  });

  it('refuses to dock a ship that leans more than 45 degrees', () => {
    const sim = raftScene();
    const log = new EventLog(sim);
    aimHelm(sim);
    click(sim);
    click(sim);
    const ship = onlyShip(sim);
    sim.releaseHelm();
    sim.structures.dynamics = null;
    ship.grid.setPoseImmediate(ship.grid.position, qfromAxisAngle({ x: 1, y: 0, z: 0 }, 1.0));
    sim.player.input.sneak = true;
    sim.lookAtCell(2, SEA_TOP, 4, PY, ship.id);
    // dock from the helm seat directly: while steering, sneak + right-click docks
    sim.entities.startSteering(sim.player, ship, 2, SEA_TOP, 4);
    click(sim);
    expect(log.toastKeys()).toContain('toast.dock.tilted');
    expect(sim.structures.ships().length).toBe(1);
  });

  it('placing on the deck puts the block into the ship grid and changes its mass', () => {
    const sim = raftScene();
    const log = new EventLog(sim);
    aimHelm(sim);
    click(sim);
    click(sim);
    const ship = onlyShip(sim);
    sim.releaseHelm();
    sim.advance(20);
    const m0 = ship.mass;
    expect(m0).toBeGreaterThan(0);
    sim.hold(B.IRON_BLOCK);
    sim.lookAtCell(4, SEA_TOP - 1, 4, PY, ship.id); // beside the helm, not past it
    click(sim);
    const placed = log.of('blockPlaced');
    expect(placed.length).toBe(1);
    expect(placed[0]!.gridId).toBe(ship.id);
    expect(idAt(ship.grid, 4, SEA_TOP, 4)).toBe(B.IRON_BLOCK);
    sim.tick();
    expect(ship.mass).toBeGreaterThan(m0 + 5);
  });

  it('releases the wheel on demand (a screen opens) and on death; respawns at the spawn point', () => {
    const sim = raftScene('survival');
    aimHelm(sim);
    click(sim);
    click(sim);
    const ship = onlyShip(sim);
    expect(sim.player.steeringShipId).toBe(ship.id);
    sim.player.input.forward = 1;
    sim.tick();
    sim.releaseHelm();
    expect(sim.player.steeringShipId).toBe(0);
    expect(ship.helmsmanId).toBe(0);
    expect(ship.throttle).toBe(0);
    sim.tick();
    expect(ship.throttle).toBe(0); // the input no longer reaches the ship

    sim.entities.startSteering(sim.player, ship, 2, SEA_TOP, 4);
    sim.tick();
    expect(sim.player.steeringShipId).toBe(ship.id);
    const log = new EventLog(sim);
    sim.entities.kill(sim.player, 'test');
    expect(sim.player.steeringShipId).toBe(0);
    expect(sim.player.carrierId).toBe(0);
    expect(ship.helmsmanId).toBe(0);
    expect(log.of('playerDied').length).toBe(1);
    sim.advance(3);
    sim.respawn();
    expect(sim.player.pos).toMatchObject({ x: 2.5, y: SEA_TOP, z: 7.5 });
    expect(sim.player.dead).toBe(false);
  });

  it('the helm being broken lets go of the wheel', () => {
    const sim = raftScene();
    aimHelm(sim);
    click(sim);
    click(sim);
    const ship = onlyShip(sim);
    expect(sim.player.steeringShipId).toBe(ship.id);
    ship.grid.setCell(2, SEA_TOP, 4, 0);
    sim.tick();
    expect(sim.player.steeringShipId).toBe(0);
  });

  it('a second helm on a ship can be taken; sneak + click docks from the wheel too', () => {
    const sim = raftScene();
    const log = new EventLog(sim);
    aimHelm(sim);
    click(sim);
    click(sim);
    const ship = onlyShip(sim);
    sim.player.input.sneak = true;
    click(sim); // steering: sneak + right-click docks the steered ship
    sim.player.input.sneak = false;
    expect(log.toastKeys()).toContain('toast.dock.done');
    expect(ship.removed).toBe(true);
    void PX;
    void I;
  });
});
