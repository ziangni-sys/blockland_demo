/**
 * Package 8: the handshake (NETCODE sections 3, 13): every Refuse reason, the frozen prefix of
 * Hello, messages before Hello, protocol errors after it, Ping, and the host's connection being
 * marked by the host rather than by the key.
 */
import { describe, expect, it } from 'vitest';
import { encodeClientMessage } from '../../src/net/codec';
import { validKey } from '../../src/net/host/netserver';
import { cleanName } from '../../src/net/names';
import { MAX_PLAYERS, MSG, type IntentMessage } from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE } from '../../src/net/transport';
import { ByteWriter } from '../../src/save/bytes';
import type { PlayerKey } from '../../src/sim/view';
import { defaultSinks } from '../../src/net/host/host';
import { NetHarness, type HeadlessClient, type RawClient } from './harness';

async function world(o: ConstructorParameters<typeof NetHarness>[0] = {}): Promise<NetHarness> {
  const h = new NetHarness(o);
  await h.create();
  return h;
}

function refusedWith(h: NetHarness, c: RawClient | HeadlessClient, reason: string): void {
  h.run(20);
  expect('refuse' in c ? c.refuse?.reason : c.refusal?.reason, `${c.key} refused`).toBe(reason);
  expect(c.welcome).toBeNull();
  expect(c.closed).toBe(true);
  if ('closeReason' in c) expect(c.closeReason).not.toBeNull();
  else expect(c.net.connectionCount).toBe(1); // no reconnection after a Refuse
}

describe('handshake (package 8)', () => {
  it('a Hello of another build is refused with reason build, whatever follows its frozen prefix', async () => {
    const h = await world();
    const a = h.addClient('a', {}, { local: true, build: 'deadbeef1234' });
    refusedWith(h, a, 'build');
    expect(a.refusal!.detail).toContain('test');
    // A later build may change everything after `str build`: still a version refusal.
    const b = h.addRawClient('b', {}, { local: true, hello: false });
    const w = new ByteWriter();
    w.u8(MSG.hello).string('v99').u32(0xffffffff).u8(200).u8(1);
    b.transport.send(RELIABLE, w.finish());
    refusedWith(h, b, 'build');
  });

  it('bad_hello: a message before Hello, a malformed Hello, Hello on the unreliable channel, bad names and keys', async () => {
    const h = await world();
    const cases: Array<[string, (c: RawClient) => void]> = [
      ['ping first', (c) => c.send({ type: 'ping', clientMs: 1 })],
      ['bye first', (c) => c.send({ type: 'bye' })],
      ['intent first', (c) => c.send({ type: 'selectSlot', seq: 1, slot: 0 })],
      ['empty message', (c) => c.transport.send(RELIABLE, new Uint8Array(0))],
      ['truncated Hello', (c) => c.transport.send(RELIABLE, encodeClientMessage({ type: 'hello', build: 'test', playerKey: c.key, name: 'n', viewRadius: 2 }).subarray(0, 9))],
      ['Hello on the unreliable channel', (c) => c.transport.send(UNRELIABLE, encodeClientMessage({ type: 'hello', build: 'test', playerKey: c.key, name: 'n', viewRadius: 2 }))],
      ['empty name', (c) => c.hello({ name: '' })],
      ['control characters only', (c) => c.hello({ name: '\u0001\u0007\u009f' })],
      ['25 characters', (c) => c.hello({ name: 'x'.repeat(25) })],
    ];
    for (const [what, act] of cases) {
      const c = h.addRawClient(`k-${cases.findIndex((x) => x[0] === what)}`, {}, { local: true, hello: false });
      act(c);
      h.run(20);
      expect(c.refuse?.reason, what).toBe('bad_hello');
      expect(c.closed, what).toBe(true);
    }
    for (const key of ['', 'has space', 'x'.repeat(129), 'tab\there', 'ünïcode']) {
      const c = h.addRawClient(key, {}, { local: true, hello: false });
      c.hello({ name: 'n' });
      h.run(20);
      expect(c.refuse?.reason, `key ${JSON.stringify(key)}`).toBe('bad_hello');
    }
    expect(h.sim.players.online()).toHaveLength(0);
  });

  it('names lose their control characters and may have 24 characters; keys are printable ASCII', () => {
    expect(cleanName('Al\u0000ice\u001b')).toBe('Alice');
    expect(cleanName('å'.repeat(24))).toBe('å'.repeat(24));
    expect(cleanName('😀'.repeat(24))).toBe('😀'.repeat(24)); // code points, not UTF-16 units
    expect(cleanName('😀'.repeat(25))).toBeNull();
    expect(validKey('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(validKey('local:slot-2')).toBe(true);
    expect(validKey('x'.repeat(128))).toBe(true);
  });

  it('closed: a guest while the room is closed; opened: accepted', async () => {
    const h = await world();
    const g = h.addClient('guest');
    refusedWith(h, g, 'closed');
    await h.host.control({ type: 'openRoom' });
    const g2 = h.addClient('guest');
    h.run(100);
    expect(g2.welcome).not.toBeNull();
    expect(g2.welcome!.roomOpen).toBe(true);
    expect(g2.welcome!.isHost).toBe(false);
  });

  it('same_key: a guest with the identity of the host connection (a second page of the same browser)', async () => {
    const h = await world();
    const host = h.addClient('me', {}, { local: true });
    h.run(100);
    await h.host.control({ type: 'openRoom' });
    const twin = h.addClient('me');
    refusedWith(h, twin, 'same_key');
    h.run(100);
    expect(host.kick).toBeNull();
    expect(host.closed).toBe(false);
  });

  it('full: MAX_PLAYERS identities, counting accepted connections that have not joined yet; a reconnecting identity is not counted twice', async () => {
    const h = await world();
    h.host.setRoomOpen(true);
    const cs = Array.from({ length: MAX_PLAYERS }, (_, i) => h.addClient(`p${i}`));
    // All four accepted before any tick ran: the fifth is refused already.
    const fifth = h.addClient('p4');
    refusedWith(h, fifth, 'full');
    h.run(200);
    for (const c of cs) expect(c.welcome, c.key).not.toBeNull();
    expect(h.sim.players.online()).toHaveLength(MAX_PLAYERS);
    // The same identity again replaces, it does not count.
    const again = h.addClient('p2');
    h.run(100);
    expect(again.welcome).not.toBeNull();
    expect(cs[2]!.kick?.reason).toBe('replaced');
    // A player that left frees its place at the next tick.
    cs[0]!.leave();
    h.run(100);
    const late = h.addClient('p5');
    h.run(100);
    expect(late.welcome).not.toBeNull();
  });

  it('shutting_down: a Hello while the shutdown save runs', async () => {
    const h = await world();
    h.addClient('a', {}, { local: true });
    h.run(100);
    const done = h.host.shutdown(true);
    const b = h.addClient('b', {}, { local: true });
    h.run(20);
    expect(b.refusal?.reason).toBe('shutting_down');
    // One still in its handshake when the server closes gets the refusal too.
    const c = h.addRawClient('c', {}, { local: true, hello: false });
    expect(await done).toBe(true);
    h.run(20);
    expect(c.refuse?.reason).toBe('shutting_down');
    expect(c.closed).toBe(true);
  });

  it('the host connection is the one the host marks local, not a key: Welcome, player table, intents', async () => {
    const joins: Array<[PlayerKey, boolean]> = [];
    const h = await world({
      sinks: (sim, replicator) => {
        const s = defaultSinks(sim, replicator);
        s.intents.join = (key, host) => joins.push([key, host]);
        return s;
      },
    });
    h.host.setRoomOpen(true);
    const host = h.addClient('zz-host', {}, { local: true, name: 'Hostess' });
    const guest = h.addClient('host', {}, { name: 'Guest' });
    h.run(100);
    expect(host.welcome!.isHost).toBe(true);
    expect(guest.welcome!.isHost).toBe(false);
    expect(joins).toEqual([
      ['zz-host', true],
      ['host', false],
    ]);
    const table = [...guest.state!.players.values()].sort((a, b) => a.entityId - b.entityId);
    expect(table.map((p) => [p.name, p.host])).toEqual([
      ['Hostess', true],
      ['Guest', false],
    ]);
  });

  it('after the handshake: Ping is answered at once with the tick; a second Hello, garbage, an unknown id or a wrong channel kick (protocol_error)', async () => {
    const h = await world();
    h.host.setRoomOpen(true);
    const a = h.addRawClient('a');
    h.run(120);
    a.send({ type: 'ping', clientMs: 4242 });
    h.run(1);
    expect(a.pongs.at(-1)).toEqual({ type: 'pong', clientMs: 4242, tick: h.sim.ticks });
    const acts: Array<[string, (c: RawClient) => void]> = [
      ['second Hello', (c) => c.hello()],
      ['garbage', (c) => c.transport.send(RELIABLE, new Uint8Array([0x21, 0xff]))],
      ['unknown id', (c) => c.transport.send(RELIABLE, new Uint8Array([0x7f]))],
      ['server id', (c) => c.transport.send(RELIABLE, new Uint8Array([0x85, 0, 0, 0]))],
      ['wrong channel', (c) => c.transport.send(UNRELIABLE, encodeClientMessage({ type: 'selectSlot', seq: 1, slot: 0 }))],
      ['too long', (c) => c.transport.send(RELIABLE, new Uint8Array(3000).fill(0x22))],
    ];
    for (const [what, act] of acts) {
      const c = h.addRawClient(`x${acts.findIndex((x) => x[0] === what)}`);
      h.run(120);
      expect(c.welcome, what).not.toBeNull();
      act(c);
      h.run(120);
      expect(c.kick?.reason, what).toBe('protocol_error');
      expect(c.closed, what).toBe(true);
      expect(h.sim.players.get(c.key), `${what}: left at the next tick`).toBeUndefined();
    }
    expect(h.sim.players.get('a')).toBeDefined();
  });

  it('more than INTENT_QUEUE_LIMIT intents between two ticks kick the client; a sink refusing more does too', async () => {
    let refuse = false;
    const received: IntentMessage[] = [];
    const h = await world({
      sinks: (sim, replicator) => {
        const s = defaultSinks(sim, replicator);
        s.intents.receive = (_k, m) => {
          received.push(m);
          return !refuse;
        };
        return s;
      },
    });
    h.host.setRoomOpen(true);
    const a = h.addRawClient('a');
    h.run(120);
    for (let i = 1; i <= 1025; i++) a.send({ type: 'selectSlot', seq: i, slot: 0 });
    h.run(1);
    expect(a.kick?.reason).toBe('protocol_error');
    const b = h.addRawClient('b');
    h.run(120);
    refuse = true;
    b.send({ type: 'swapHands', seq: 1 });
    h.run(60);
    expect(b.kick?.reason).toBe('protocol_error');
    expect(received.at(-1)).toEqual({ type: 'swapHands', seq: 1 });
  });
});
