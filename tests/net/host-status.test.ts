/**
 * Package 13: what the host page learns about its guests (docs/NETCODE.md sections 15, 18): the
 * `status` report carries, every second while guests are in, each guest's bytes a second, backlog
 * and round trip (its client measures it and sends it with every Ping).
 */
import { describe, expect, it } from 'vitest';
import type { GuestTraffic, HostToPage } from '../../src/net/host/control';
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
