/**
 * The page's WorldSession against a real server (tests/client/rig.ts): what the settings, a far
 * teleport and the camera views do through the network client (docs/NETCODE.md sections 9, 10,
 * package 9).
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NZ, PZ } from '../../src/core/dirs';
import { FLAT_TOP, SessionRig } from './rig';

/** Columns of the subscription circle of radius r (dx² + dz² <= r² + r). */
function circle(r: number): number {
  let n = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r + r) n++;
  return n;
}

describe('WorldSession flows (against a real server)', () => {
  it('a new render distance goes to the server (SetViewRadius): it subscribes the new circle; the next Hello carries it too', async () => {
    const rig = await SessionRig.create({ viewRadius: 3 });
    rig.playUntilReady();
    const key = 'p'.repeat(32);
    const view = () => rig.host.replicator.clientView(key)!;
    rig.runUntil(() => view().columns.size === circle(3) && view().pendingColumns === 0);
    rig.session.setViewRadius(5);
    expect(rig.session.net.viewRadius).toBe(5);
    rig.runUntil(() => view().columns.size === circle(5) && view().pendingColumns === 0);
    rig.runUntil(() => rig.session.replica!.chunks.size === circle(5));
    rig.session.setViewRadius(2);
    // Leaving the circle by more than the hysteresis (r + 2) unsubscribes at once.
    rig.runUntil(() => view().columns.size <= circle(4));
    expect(rig.errors).toEqual([]);
  });

  it('until the prediction adopted the join\'s correction, the player is shown where the server has it (never at the origin)', async () => {
    const rig = await SessionRig.create({ viewRadius: 3 });
    const s = rig.session;
    // Loading ends while the client does not step (a paused page): the OwnPlayer exists, unplaced.
    rig.paused = true;
    rig.runUntil(() => s.state === 'ready');
    rig.run(200);
    const own = s.own!;
    expect(own.placed).toBe(false);
    const corr = s.replica!.ownState.correction!;
    expect(corr.carrierId).toBe(0);
    expect(s.shown.feet.x).toBeCloseTo(corr.pos.x, 6);
    expect(s.shown.feet.z).toBeCloseTo(corr.pos.z, 6);
    expect(Math.hypot(s.shown.feet.x, s.shown.feet.y, s.shown.feet.z)).toBeGreaterThan(1);
    rig.paused = false;
    rig.runUntil(() => own.placed);
    expect(own.player.pos.x).toBeCloseTo(corr.pos.x, 6);
    expect(s.shown.feet.x).toBeCloseTo(corr.pos.x, 3);
    expect(rig.errors).toEqual([]);
  });

  it('a far teleport reloads: loading again until the new place is in the replica and meshed, then playing there', async () => {
    const rig = await SessionRig.create({ viewRadius: 3 });
    rig.playUntilReady();
    const s = rig.session;
    const own = s.own!;
    const epoch = own.epoch;
    expect(s.hostCommand({ kind: 'teleport', x: 300.5, y: FLAT_TOP, z: 0.5 })).toBe(true);
    // The server subscribes the new place in the batch of the correction, and the columns of this
    // flat world are made at once: the prediction's own wait (OwnPlayer.reloading, the ready zone in
    // the replica) can end in the very client tick that adopts the correction. The session still
    // goes back to loading for the meshes around the new place.
    rig.runUntil(() => s.state === 'loading', 2000, 1);
    expect(own.epoch).toBeGreaterThan(epoch);
    expect(own.player.pos.x).toBeCloseTo(300.5, 6);
    rig.runUntil(() => s.state === 'ready');
    expect(own.reloading).toBe(false);
    expect(own.player.pos.x).toBeCloseTo(300.5, 1);
    expect(own.player.pos.y).toBeCloseTo(FLAT_TOP, 1);
    const progress = s.loadingProgress();
    expect(progress.done).toBe(true);
    expect(progress.sectionsReady).toBe(progress.sectionsNeeded);
    // It plays on there: a step forward moves it.
    s.held.forward = 1;
    rig.run(500);
    s.held.forward = 0;
    expect(Math.hypot(own.player.pos.x - 300.5, own.player.pos.z - 0.5)).toBeGreaterThan(0.5);
    expect(rig.errors).toEqual([]);
  });

  it('targets: the eye ray in first person, the camera ray in the front view (it looks back past the player)', async () => {
    const rig = await SessionRig.create({
      viewRadius: 3,
      setup: (sim) => {
        // Spawn (0.5, FLAT_TOP, 0.5); the eyes at FLAT_TOP + 1.62: one block in front (north) and
        // one behind, both at eye height.
        sim.world.setCell(0, FLAT_TOP + 1, -2, B.STONE);
        sim.world.setCell(0, FLAT_TOP + 1, 3, B.STONE);
      },
    });
    rig.playUntilReady();
    const s = rig.session;
    s.held.yaw = 0; // north (-Z)
    s.held.pitch = 0;
    rig.run(100);
    const t1 = s.intents!.useTarget;
    expect(t1 && { x: t1.x, y: t1.y, z: t1.z, face: t1.face }).toEqual({ x: 0, y: FLAT_TOP + 1, z: -2, face: PZ });
    rig.viewMode = 'front';
    rig.run(100);
    const t2 = s.intents!.useTarget;
    expect(t2 && { x: t2.x, y: t2.y, z: t2.z, face: t2.face }).toEqual({ x: 0, y: FLAT_TOP + 1, z: 3, face: NZ });
    rig.viewMode = 'first';
    rig.run(100);
    expect(s.intents!.useTarget?.z).toBe(-2);
    expect(rig.errors).toEqual([]);
  });
  it('the server reports how long its ticks take about once a second while its clock runs (the debug overlay\'s tick time), none while paused', async () => {
    const rig = await SessionRig.create({ viewRadius: 3 });
    rig.playUntilReady();
    const reports = () => rig.reports.filter((m) => m.type === 'tickTime');
    const before = reports().length;
    rig.run(3000);
    const got = reports().slice(before);
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(got.length).toBeLessThanOrEqual(4);
    for (const m of got) {
      if (m.type !== 'tickTime') continue;
      expect(Number.isFinite(m.meanMs) && m.meanMs >= 0).toBe(true);
      expect(m.maxMs).toBeGreaterThanOrEqual(m.meanMs);
    }
    await rig.host.control({ type: 'pause', paused: true });
    rig.run(200);
    const paused = reports().length;
    rig.run(3000);
    expect(reports().length).toBe(paused);
    expect(rig.errors).toEqual([]);
  });
});
