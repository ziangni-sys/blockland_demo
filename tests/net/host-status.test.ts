/**
 * Package 13: what the host page learns about its guests (docs/NETCODE.md sections 15, 18): the
 * `status` report carries, every second while guests are in, each guest's bytes a second, backlog
 * and round trip (its client measures it and sends it with every Ping).
 */
import { describe, expect, it } from 'vitest';
import { parsePageMessage, type GuestTraffic, type HostToPage } from '../../src/net/host/control';
import { chunkKey } from '../../src/voxel/chunk';
import { columnHash, gridHash } from '../../src/voxel/fingerprint';
import { link, NetHarness } from './harness';

function statuses(h: NetHarness): Array<Extract<HostToPage, { type: 'status' }>> {
  return h.reports.filter((r): r is Extract<HostToPage, { type: 'status' }> => r.type === 'status');
}

describe('the host page sees its guests (package 13)', () => {
  it('status: every second while a guest is in, its entity, name, bytes a second, backlog and round trip; the host itself is not listed', async () => {
    const h = new NetHarness();
    await h.create();
    const host = h.addClient('host', {}, { local: true });
    h.runUntil(() => host.ready);
    await h.host.control({ type: 'openRoom' });
    const before = statuses(h).length;
    const g = h.addClient('g', { up: link(60), down: link(60) }, { name: 'Guest' });
    h.runUntil(() => g.ready);
    h.run(6000);
    const all = statuses(h).slice(before);
    const withGuest = all.filter((s) => s.guests.length === 1);
    // About one a second (the clock reports at most once a second).
    expect(withGuest.length).toBeGreaterThanOrEqual(5);
    const last: GuestTraffic = withGuest.at(-1)!.guests[0]!;
    expect(last.entityId).toBe(g.welcome!.entityId);
    expect(last.name).toBe('Guest');
    // Its batches and samples: an idle guest still gets a batch every tick (about 20 x 6 bytes).
    expect(last.bytesPerSec).toBeGreaterThan(50);
    expect(last.bytesPerSec).toBeLessThan(5000);
    expect(last.backlogBytes).toBeGreaterThanOrEqual(0);
    // 60 ms each way, as the guest's client measured it.
    expect(last.rttMs).toBeGreaterThanOrEqual(120);
    expect(last.rttMs).toBeLessThan(140);
    expect(withGuest.at(-1)!.players).toBe(2);
    // The guest leaves: one more report without it, then only on change again.
    g.leave();
    h.run(3000);
    const after = statuses(h).slice(before + all.length);
    expect(after.at(-1)!.guests).toEqual([]);
    expect(after.filter((s) => s.guests.length === 0).length).toBe(1);
  });
});

describe('the server probe (debug tooling for the browser tests)', () => {
  it("answers with the players where the server has them and fingerprints that equal a settled client's replica", async () => {
    const h = new NetHarness();
    await h.create();
    const host = h.addClient('host', {}, { local: true, viewRadius: 3 });
    h.runUntil(() => host.ready && host.own !== null);
    h.run(2000);
    h.quiesce();
    const before = h.reports.length;
    await h.host.control({ type: 'probe', id: 7, radius: 1 });
    const answer = h.reports.slice(before).find((r) => r.type === 'probe');
    expect(answer).toMatchObject({ type: 'probe', id: 7 });
    const probe = (answer as Extract<HostToPage, { type: 'probe' }>).probe!;
    expect(probe.tick).toBe(h.sim.ticks);
    const me = probe.players.find((p) => p.entityId === host.welcome!.entityId)!;
    const p = h.sim.players.get('host')!.player;
    expect(me).toMatchObject({ carrierId: 0, x: p.pos.x, y: p.pos.y, z: p.pos.z, lx: p.pos.x, ly: p.pos.y, lz: p.pos.z });
    // 3 x 3 columns about the player, each hashed as the page's debug digest hashes its replica.
    expect(Object.keys(probe.columns)).toHaveLength(9);
    const replica = host.net.replica!;
    for (const [key, hash] of Object.entries(probe.columns)) {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      expect(columnHash(replica.world.chunks.get(chunkKey(cx, cz))!), key).toBe(hash);
    }
    // Every structure, as the replica has it (e2e-room compares them on a real raft).
    expect(probe.structures.length).toBe(h.sim.structures.all().length);
    for (const s of probe.structures) expect(gridHash(replica.state.structures.get(s.id)!.structure.grid)).toBe(s.hash);
    // Nothing else is probed: a bad radius is not a control message.
    expect(parsePageMessage({ type: 'probe', id: 1, radius: 99 })).toBeNull();
  });
});
