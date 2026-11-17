/**
 * Package 5: NetClient's connection life cycle (NETCODE section 3) against the test server shim
 * (tests/net/shim.ts): handshake and join, "ready", Refuse, Kick, replacement, reconnection after a
 * lost transport, Bye, protocol errors, and the stall hint of section 4.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { CONNECTION_TIMEOUT_MS } from '../../src/net/protocol';
import { createLoopbackPair, LoopbackNet } from '../../src/net/loopback';
import { NetClient, RECONNECT_RETRY_MS, type NetStatus } from '../../src/net/client/netclient';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { link, ShimServer, ShimWorld, syncSource } from './shim';

const T = 35;

function flatWorld(): ShimWorld {
  const sim = new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 3, spawn: { x: 0.5, y: T, z: 0.5 } });
  return new ShimWorld(new ShimServer(new LoopbackNet(), sim));
}

function statuses(w: ShimWorld, i: number): NetStatus[] {
  const out: NetStatus[] = [];
  w.clients[i]!.net.onStatus = (s) => out.push(s);
  return out;
}

describe('NetClient life cycle (package 5)', () => {
  it('Hello, Welcome, the join batches, ready; the replica matches the server every batch', () => {
    const w = flatWorld();
    const a = w.add({ key: 'a', viewRadius: 3, up: link(30, 5, 0, 1), down: link(30, 5, 0, 2) }, false);
    const seen = statuses(w, 0);
    a.net.start();
    expect(a.net.status).toBe('connecting');
    w.runUntil(() => a.net.status === 'ready', 5000);
    expect(seen).toEqual(['connecting', 'joining', 'ready']);
    const r = a.replica!;
    expect(r.ownEntityId).toBe(w.server.sim.players.get('a')!.entityId);
    expect(r.state.players.get(r.ownEntityId)?.name).toBe('a');
    // Every column of the circle r = 3 is there once ready (the radius is below the 7 x 7 zone).
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx * dx + dz * dz <= 12) expect(r.chunks.present(dx, dz), `${dx},${dz}`).toBe(true);
    // Edits replicate.
    w.server.sim.world.setCell(2, T, 2, makeCell(B.STONE));
    w.run(500);
    expect(r.world.getCell(2, T, 2)).toBe(makeCell(B.STONE));
    expect(a.batchesChecked).toBeGreaterThan(5);
    a.expectClean();
    expect(r.state.tick).toBeGreaterThan(w.server.sim.ticks - 4);
  });

  it('Refuse (build): no reconnection, the reason is kept', () => {
    const w = flatWorld();
    const a = w.add({ key: 'a', build: 'other' });
    w.run(2000);
    expect(a.net.status).toBe('refused');
    expect(a.net.refusal?.reason).toBe('build');
    expect(a.net.connectionCount).toBe(1);
    expect(w.server.sim.players.get('a')).toBeUndefined();
  });

  it('Kick: no reconnection; a lost transport reconnects and joins again from scratch', () => {
    const w = flatWorld();
    const a = w.add({ key: 'a' });
    w.runUntil(() => a.net.status === 'ready');
    const first = a.replica!;
    const seen = statuses(w, 0);
    w.server.drop('a');
    w.run(20);
    expect(a.net.replica).toBeNull();
    w.runUntil(() => a.net.status === 'ready');
    // 'reconnecting' until the new Welcome (the UI shows "connection lost, reconnecting").
    expect(seen).toEqual(['reconnecting', 'joining', 'ready']);
    expect(a.net.connectionCount).toBe(2);
    expect(a.replica).not.toBe(first);
    w.run(300);
    a.expectClean();
    // Now a Kick: the status stays, nothing reconnects.
    w.server.kick('a', 'kicked');
    w.run(3000);
    expect(a.net.status).toBe('kicked');
    expect(a.net.kick?.reason).toBe('kicked');
    expect(a.net.connectionCount).toBe(2);
  });

  it('a second page with the same identity replaces the first, which is kicked (replaced) and stays down', () => {
    const w = flatWorld();
    const a = w.add({ key: 'a' });
    w.runUntil(() => a.net.status === 'ready');
    const entity = w.server.sim.players.get('a')!.entityId;
    const b = w.add({ key: 'a', phase: 3 });
    w.runUntil(() => b.net.status === 'ready');
    w.run(3000);
    expect(a.net.status).toBe('kicked');
    expect(a.net.kick?.reason).toBe('replaced');
    expect(a.net.connectionCount).toBe(1);
    expect(b.net.status).toBe('ready');
    expect(w.server.sim.players.get('a')!.entityId).toBe(entity);
    b.expectClean();
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

  it('Bye: the server lets the player leave; the client is closed', () => {
    const w = flatWorld();
    const a = w.add({ key: 'a', up: link(20), down: link(20) });
    w.runUntil(() => a.net.status === 'ready');
    a.net.leave();
    expect(a.net.status).toBe('closed');
    w.run(200);
    expect(w.server.sim.players.get('a')).toBeUndefined();
    expect(a.net.connectionCount).toBe(1);
  });

  it('a corrupt message ends the connection with the reason; no reconnection, no replica', () => {
    const w = flatWorld();
    const a = w.add({ key: 'a' });
    w.runUntil(() => a.net.status === 'ready');
    // A truncated TickBatch (tick, then half of the section mask).
    const conn = w.server.live('a')!;
    conn.transport.send(0, new Uint8Array([0x85, 0x7f, 0x02]));
    w.run(100);
    expect(a.net.status).toBe('failed');
    expect(a.net.failure).toMatch(/protocol error/);
    expect(a.net.replica).toBeNull();
    w.run(3000);
    expect(a.net.connectionCount).toBe(1);
  });

  it('the stall hint: the host sleeping (Pongs still come) is "host", a dead link is "link", then it clears', () => {
    const w = flatWorld();
    const a = w.add({ key: 'a', up: link(20), down: link(20) });
    w.runUntil(() => a.net.status === 'ready');
    w.run(2000);
    expect(a.net.stall(w.net.now)).toBeNull();
    w.ticking = false;
    w.run(2500);
    expect(a.net.stall(w.net.now)).toBe('host');
    w.ticking = true;
    w.run(500);
    expect(a.net.stall(w.net.now)).toBeNull();
    // Both directions lose everything: no batch, no Pong.
    a.links.down.loss = 1;
    a.links.down.rtoMs = 1e9;
    a.links.up.loss = 1;
    w.run(3000);
    expect(a.net.stall(w.net.now)).toBe('link');
  });
});
