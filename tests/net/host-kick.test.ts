/**
 * Package 11: the Kick host command end to end on the server (net/server/intents.ts hands the
 * request to NetServer, which ends the guest's connection with Kick('kicked')): the guest gets the
 * reason and does not reconnect, its player leaves at the next tick (its record stays), everyone
 * else's player table loses it; a guest's Kick is refused with the host-only toast; the host's own
 * player and unknown ids are ignored; a removed guest may come back while the room is open.
 */
import { describe, expect, it } from 'vitest';
import { FLAT, NetHarness, testMeta, type HeadlessClient } from './harness';

async function room(): Promise<{ h: NetHarness; host: HeadlessClient; a: HeadlessClient; b: HeadlessClient }> {
  const h = new NetHarness();
  await h.create(testMeta('k'), { generator: FLAT, exampleShip: false });
  const host = h.addClient('host', {}, { local: true, name: 'Host', viewRadius: 2 });
  h.runUntil(() => host.ready, 30_000);
  await h.host.control({ type: 'openRoom' });
  const a = h.addClient('ann', {}, { name: 'Ann', viewRadius: 2 });
  const b = h.addClient('bob', {}, { name: 'Bob', viewRadius: 2 });
  h.runUntil(() => a.ready && b.ready, 30_000);
  return { h, host, a, b };
}

function names(c: HeadlessClient): string[] {
  return [...c.state!.players.values()].map((p) => p.name).sort();
}

describe('the Kick host command (package 11)', () => {
  it("the host removes a guest: Kick('kicked') reaches it, no reconnection; it leaves the world at the next tick; the others' tables drop it", async () => {
    const { h, host, a, b } = await room();
    const annId = a.welcome!.entityId;
    expect(names(host)).toEqual(['Ann', 'Bob', 'Host']);
    host.hostCommand({ kind: 'kick', entityId: annId });
    h.runUntil(() => a.status === 'kicked', 5000);
    expect(a.kick).toMatchObject({ reason: 'kicked' });
    h.run(500);
    expect(h.sim.players.online().map((p) => p.key).sort()).toEqual(['bob', 'host']);
    // The record stays (a returning guest gets its place and inventory back).
    expect(h.sim.players.keys()).toContain('ann');
    expect(names(host)).toEqual(['Bob', 'Host']);
    expect(names(b)).toEqual(['Bob', 'Host']);
    // Kicked: NetClient never reconnects.
    h.run(10_000);
    expect(a.status).toBe('kicked');
    expect(a.net.connectionCount).toBe(1);
  });

  it("a guest's Kick is refused with the host-only toast; the host's own player and unknown ids are ignored", async () => {
    const { h, host, a, b } = await room();
    const toasts: string[] = [];
    a.net.onBatch = ((prev) => (batch, replica) => {
      prev?.(batch, replica);
      for (const ev of batch.private?.events ?? []) if (ev.type === 'toast') toasts.push(ev.message.key);
    })(a.net.onBatch);
    a.hostCommand({ kind: 'kick', entityId: b.welcome!.entityId });
    a.hostCommand({ kind: 'kick', entityId: host.welcome!.entityId });
    host.hostCommand({ kind: 'kick', entityId: host.welcome!.entityId });
    host.hostCommand({ kind: 'kick', entityId: 0 });
    host.hostCommand({ kind: 'kick', entityId: 9999 });
    h.run(1500);
    expect(toasts.filter((k) => k === 'toast.host.only')).toHaveLength(2);
    for (const c of [host, a, b]) expect(c.status).toBe('ready');
    expect(h.sim.players.online()).toHaveLength(3);
  });

  it('a removed guest may come back while the room is open (rejoining is allowed); a closed room refuses it', async () => {
    const { h, host, a } = await room();
    host.hostCommand({ kind: 'kick', entityId: a.welcome!.entityId });
    h.runUntil(() => a.status === 'kicked', 5000);
    h.run(200);
    const again = h.addClient('ann', {}, { name: 'Ann', viewRadius: 2 });
    h.runUntil(() => again.ready, 30_000);
    expect(names(host)).toEqual(['Ann', 'Bob', 'Host']);
    host.hostCommand({ kind: 'kick', entityId: again.welcome!.entityId });
    h.runUntil(() => again.status === 'kicked', 5000);
    await h.host.control({ type: 'closeRoom' });
    const third = h.addClient('ann', {}, { name: 'Ann', viewRadius: 2 });
    h.runUntil(() => third.status === 'refused', 5000);
    expect(third.refusal).toMatchObject({ reason: 'closed' });
  });
});
