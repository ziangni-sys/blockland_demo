/**
 * Package 5: NetClient's connection life cycle (NETCODE section 3) against the real server
 * (ServerHost through tests/net/harness.ts): handshake and join, "ready", Refuse, Kick,
 * replacement, reconnection after a failed link, Bye, protocol errors, and the stall hint of
 * section 4. Servers that misbehave (drop every transport, never answer) are bare loopback ends.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { CONNECTION_TIMEOUT_MS } from '../../src/net/protocol';
import { createLoopbackPair, LoopbackNet } from '../../src/net/loopback';
import { NetClient, RECONNECT_RETRY_MS, type NetStatus } from '../../src/net/client/netclient';
import { FlatGenerator } from '../../src/worldgen/generator';
import { link, NetHarness, syncSource } from './harness';

/** First air above the harness's flat ground. */
const T = 5;

async function flatWorld(): Promise<NetHarness> {
  const h = new NetHarness();
  await h.create();
  h.host.setRoomOpen(true);
  return h;
}

describe('NetClient life cycle (package 5)', () => {
  it('Hello, Welcome, the join batches, ready; the replica matches the server every batch', async () => {
    const h = await flatWorld();
    const a = h.addClient('a', { up: link(30, 5, 0, 1), down: link(30, 5, 0, 2) }, { viewRadius: 3, start: false });
    h.track(a);
    a.net.start();
    expect(a.status).toBe('connecting');
    h.runUntil(() => a.ready, 5000);
    expect(a.statuses).toEqual(['connecting', 'joining', 'ready']);
    const r = a.replica!;
    expect(r.ownEntityId).toBe(h.sim.players.get('a')!.entityId);
    expect(r.state.players.get(r.ownEntityId)?.name).toBe('a');
    // Every column of the circle r = 3 is there once ready (the radius is below the 7 x 7 zone).
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx * dx + dz * dz <= 12) expect(r.chunks.present(dx, dz), `${dx},${dz}`).toBe(true);
    // Edits replicate.
    h.sim.world.setCell(2, T, 2, makeCell(B.STONE));
    h.run(500);
    expect(r.world.getCell(2, T, 2)).toBe(makeCell(B.STONE));
    expect(a.checked).toBeGreaterThan(5);
    expect(a.mismatches).toEqual([]);
    expect(r.state.tick).toBeGreaterThan(h.sim.ticks - 4);
  });

  it('Refuse (build): no reconnection, the reason is kept', async () => {
    const h = await flatWorld();
    const a = h.addClient('a', {}, { build: 'other' });
    h.run(5000);
    expect(a.status).toBe('refused');
    expect(a.refusal?.reason).toBe('build');
    expect(a.net.connectionCount).toBe(1);
    expect(h.sim.players.get('a')).toBeUndefined();
  });

  it('Kick: no reconnection; a failed link reconnects and joins again from scratch', async () => {
    const h = await flatWorld();
    const a = h.addClient('a');
    h.track(a);
    h.runUntil(() => a.ready);
    const first = a.replica!;
    a.statuses.length = 0;
    h.sever(a);
    expect(a.replica).toBeNull();
    h.runUntil(() => a.ready);
    // 'reconnecting' until the new Welcome (the UI shows "connection lost, reconnecting").
    expect(a.statuses).toEqual(['reconnecting', 'joining', 'ready']);
    expect(a.net.connectionCount).toBe(2);
    expect(a.replica).not.toBe(first);
    h.run(300);
    expect(a.mismatches).toEqual([]);
    // Now a Kick (a protocol error the server sees: a second Hello): the status stays, nothing reconnects.
    a.net.send({ type: 'hello', build: 'test', playerKey: 'a', name: 'a', viewRadius: 2 });
    h.run(3000);
    expect(a.status).toBe('kicked');
    expect(a.kick?.reason).toBe('protocol_error');
    expect(a.net.connectionCount).toBe(2);
    expect(h.sim.players.get('a')).toBeUndefined();
  });

  it('a second page with the same identity replaces the first, which is kicked (replaced) and stays down', async () => {
    const h = await flatWorld();
    const a = h.addClient('a');
    h.runUntil(() => a.ready);
    const entity = h.sim.players.get('a')!.entityId;
    const b = h.addClient('a');
    h.track(b);
    h.runUntil(() => b.ready);
    h.run(3000);
    expect(a.status).toBe('kicked');
    expect(a.kick?.reason).toBe('replaced');
    expect(a.net.connectionCount).toBe(1);
    expect(b.status).toBe('ready');
    expect(h.sim.players.get('a')!.entityId).toBe(entity);
    expect(b.mismatches).toEqual([]);
  });

  /** A NetClient on a bare loopback whose server end does `serve` with each transport; heartbeat every second. */
  function bareClient(serve: (server: ReturnType<typeof createLoopbackPair>['server']) => void): { net: LoopbackNet; nc: NetClient; opened: number[]; run(ms: number): void } {
    const net = new LoopbackNet();
    const opened: number[] = [];
    const nc = new NetClient({
      openTransport: (ready) => {
        opened.push(net.now);
        const { client, server } = createLoopbackPair(net, link(20), link(20));
        serve(server);
        ready(client);
      },
      now: () => net.now,
      chunkSource: () => syncSource(new FlatGenerator()),
      playerKey: 'k',
      name: 'k',
      viewRadius: 3,
      build: 'test',
    });
    const run = (ms: number): void => {
      const end = net.now + ms;
      for (let t = Math.ceil(net.now / 10) * 10; t <= end; t += 10) {
        net.advanceTo(t);
        if (t % 1000 === 0) nc.heartbeat(t);
      }
    };
    return { net, nc, opened, run };
  }

  it('reconnection is paced: a server that drops every transport on Hello gets one at most every RECONNECT_RETRY_MS', () => {
    const c = bareClient((server) => {
      server.onMessage = () => server.close('nope');
    });
    const seen: NetStatus[] = [];
    c.nc.onStatus = (s) => seen.push(s);
    c.nc.start();
    c.run(10_000);
    // At 0, then on the heartbeats at 2, 4, 6, 8 and 10 s.
    expect(c.opened.length).toBeLessThanOrEqual(1 + 10_000 / RECONNECT_RETRY_MS);
    expect(c.opened.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < c.opened.length; i++) expect(c.opened[i]! - c.opened[i - 1]!).toBeGreaterThanOrEqual(RECONNECT_RETRY_MS);
    expect(seen).toEqual(['connecting', 'reconnecting']);
  });

  it('a server that never answers Hello: the client gives up after CONNECTION_TIMEOUT_MS and reconnects', () => {
    let closed = 0;
    const c = bareClient((server) => {
      server.onClose = () => closed++;
    });
    c.nc.start();
    c.run(CONNECTION_TIMEOUT_MS - 1000);
    expect(c.opened.length).toBe(1);
    expect(c.nc.status).toBe('connecting');
    c.run(2000);
    expect(closed).toBe(1);
    expect(c.opened.length).toBe(2);
    expect(c.nc.status).toBe('reconnecting');
  });

  it('Bye: the server lets the player leave; the client is closed', async () => {
    const h = await flatWorld();
    const a = h.addClient('a', { up: link(20), down: link(20) });
    h.runUntil(() => a.ready);
    a.leave();
    expect(a.status).toBe('closed');
    h.run(200);
    expect(h.sim.players.get('a')).toBeUndefined();
    expect(h.sim.players.keys()).toContain('a');
    expect(a.net.connectionCount).toBe(1);
  });

  it('a corrupt message ends the connection with the reason; no reconnection, no replica; the server sees the close', async () => {
    const h = await flatWorld();
    const a = h.addClient('a');
    h.runUntil(() => a.ready);
    // A truncated TickBatch (tick, then half of the section mask), from the server end of the link.
    h.inject(a, 0, new Uint8Array([0x85, 0x7f, 0x02]));
    h.run(100);
    expect(a.status).toBe('failed');
    expect(a.net.failure).toMatch(/protocol error/);
    expect(a.replica).toBeNull();
    h.run(3000);
    expect(a.net.connectionCount).toBe(1);
    expect(h.sim.players.get('a')).toBeUndefined();
  });

  it('the stall hint: the host sleeping (Pongs still come) is "host", a dead link is "link", then it clears', async () => {
    const h = await flatWorld();
    const up = link(20);
    const down = link(20);
    const a = h.addClient('a', { up, down });
    h.runUntil(() => a.ready);
    h.run(2000);
    expect(a.net.stall(h.net.now)).toBeNull();
    h.stallServer(2500);
    expect(a.net.stall(h.net.now)).toBe('host');
    // Batches come again at once, but the measured TPS (2 s of wall time) is low until the window refills.
    h.run(500);
    expect(a.state!.tps).toBeLessThan(15);
    expect(a.net.stall(h.net.now)).toBe('host');
    h.runUntil(() => a.net.stall(h.net.now) === null, 3000);
    expect(a.state!.tps).toBeGreaterThanOrEqual(15);
    // Both directions lose everything: no batch, no Pong.
    down.loss = 1;
    down.rtoMs = 1e9;
    up.loss = 1;
    h.run(3000);
    expect(a.net.stall(h.net.now)).toBe('link');
  });
});
