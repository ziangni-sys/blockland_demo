/**
 * End to end (NETCODE sections 5, 7, 8): a ship and an item that enter a guest's interest lying
 * still, and only move later. Their spawn records are rest samples: the server sends samples only
 * when a pose changes, so the client holds the spawn's pose until the tick before the first sample
 * after it. Interpolating across the whole gap instead would draw the first motion up to the
 * interpolation delay early. On every link, at every frame from the guest's ready on, neither is
 * ever ahead of the server at renderTick along its push; on the 0 ms link both are exactly where
 * the server had them (within the wire's quantisation).
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { quat, vec3 } from '../../src/core/math';
import { Ship } from '../../src/structures/structure';
import { NetHarness, testMeta } from './harness';
import { fill, island, LINKS, loadArea, lossOf, SEA, SEA_TOP, serverShipPose } from './e2e-scenes';

/** The wire's position quantisation (1/512 block), with room for the lerp. */
const TOL = 2 / 512;

describe.each(LINKS)('a still ship and item entering interest over $name (end to end)', ({ make }) => {
  it('are drawn still until the server moves them, never ahead of it', async () => {
    const h = new NetHarness({ history: true });
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    // A raft on the sea east of the spawn, an island with an item west of it.
    loadArea(sim, -24, -16, 16, 16);
    fill(sim, 4, SEA_TOP - 1, 4, 8, SEA_TOP - 1, 10, B.PLANKS_OAK);
    sim.world.setCell(6, SEA_TOP, 10, makeCell(B.HELM, facingState(NZ)));
    island(sim, -20, -12, -8, 0);
    const host = h.addClient('host', {}, { local: true, viewRadius: 3 });
    h.runUntil(() => host.ready);
    const r = sim.structures.assembleShip(6, SEA_TOP, 10);
    if (!r.ok) throw new Error('the raft did not assemble');
    const ship: Ship = r.structure;
    const item = sim.entities.spawnItem(-14.5, SEA_TOP + 0.2, -6.5, B.COBBLE, 1);
    h.run(15_000); // both settle: rest and final state sent, samples stop
    const shipAt = { ...ship.grid.position };
    const itemAt = { ...item.pos };
    h.run(1000);
    expect(ship.grid.position).toEqual(shipAt);
    expect(item.pos).toEqual(itemAt);

    await h.host.control({ type: 'openRoom' });
    const conds = make(41);
    const g = h.addClient('guest', conds, { viewRadius: 3 });
    h.track(g);
    h.runUntil(() => g.ready, 30_000);
    h.run(10_000); // they lie still for 10 s after the guest got their spawn records

    const stats = { frames: 0, exactShip: 0, exactItem: 0, aheadShip: 0, aheadItem: 0 };
    const p = vec3();
    const q = quat();
    g.onFrame = () => {
      const rt = g.net.clock!.renderTick;
      const replica = g.replica!;
      const a = h.history.get(Math.floor(rt))?.entities.get(item.id);
      const b = h.history.get(Math.floor(rt) + 1)?.entities.get(item.id);
      const server = serverShipPose(h, ship.id, rt);
      const view = replica.entities(rt).find((e) => e.id === item.id);
      if (a === undefined || b === undefined || server === null || view === undefined || !replica.shipPoseAt(ship.id, rt, p, q)) return;
      stats.frames++;
      const f = rt - Math.floor(rt);
      const itemX = a.pos.x + (b.pos.x - a.pos.x) * f;
      const itemZ = a.pos.z + (b.pos.z - a.pos.z) * f;
      if (Math.hypot(p.x - server.pos.x, p.z - server.pos.z) <= TOL) stats.exactShip++;
      if (Math.hypot(view.pos.x - itemX, view.pos.z - itemZ) <= TOL) stats.exactItem++;
      // Both are pushed toward +x: being behind is a held lost sample (section 7), being ahead is early.
      if (p.x > server.pos.x + TOL) stats.aheadShip++;
      if (view.pos.x > itemX + TOL) stats.aheadItem++;
    };
    // The ship is pushed (no cells change, so its pivot stays), a blast crate goes off next to the item.
    sim.structures.dynamics!.applyImpulse(ship, { ...ship.grid.position }, { x: 200, y: 0, z: 50 });
    sim.entities.spawnTnt(-15.5, SEA_TOP, -6.5, 5);
    h.run(4000);

    expect(ship.grid.position.x).toBeGreaterThan(shipAt.x + 1);
    expect(item.removed).toBe(false);
    expect(item.pos.x).toBeGreaterThan(itemAt.x + 0.5);
    expect(stats.frames).toBeGreaterThan(200);
    expect(stats.aheadShip).toBe(0);
    expect(stats.aheadItem).toBe(0);
    if (lossOf(conds) === 0) {
      expect(stats.exactShip).toBe(stats.frames);
      expect(stats.exactItem).toBe(stats.frames);
    }
    expect(g.mismatches.slice(0, 5)).toEqual([]);
    h.quiesce();
    expect(h.compareNow(g)).toEqual([]);
  }, 120_000);
});
