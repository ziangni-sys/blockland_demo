/**
 * Package 10: the three signallers and the handshake on top (NETCODE section 2), on fake WebRTC and
 * a stand-in PeerJS server, on a virtual clock: a guest joins a room through each signaller; every
 * way a join can fail ends in its own DialError within its stage's timeout.
 */
import { describe, expect, it } from 'vitest';
import { LoopbackNet } from '../../src/net/loopback';
import { RELIABLE, type Channel } from '../../src/net/transport';
import { BROADCAST_KNOCK_MS, BROADCAST_PATIENCE_MS, BroadcastSignaller } from '../../src/net/webrtc/broadcast';
import { CLOUD_CONNECT_MS, CLOUD_GUEST_PREFIX, CLOUD_ROOM_PREFIX, CloudSignaller } from '../../src/net/webrtc/cloud';
import { GATHER_QUIET_MS, GATHER_TIMEOUT_MS, ICE_TIMEOUT_MS, joinRoom, MAX_PENDING_HANDSHAKES, RoomListener, type ConnectDeps } from '../../src/net/webrtc/connect';
import { decodeCode, encodeCode, ManualSignaller } from '../../src/net/webrtc/manual';
import { DialError, newRoomCode, parseRoomCode, type DialFailure, type Signaller } from '../../src/net/webrtc/signal';
import type { WebRtcTransport } from '../../src/net/webrtc/transport';
import { counterRandom, FakeBroadcastHub, FakeRtcNet, netTimers } from './fakertc';
import { MAX_FRAME, StandInPeerServer } from './peerserver';

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

type Outcome<T> = { ok: true; value: T; at: number } | { ok: false; error: unknown; at: number };

/** Advance virtual time until `p` settles (or `maxMs`): its outcome and when. */
async function settle<T>(loop: LoopbackNet, p: Promise<T>, maxMs = 20 * 60_000, step = 5): Promise<Outcome<T>> {
  let out: Outcome<T> | null = null;
  p.then(
    (value) => (out = { ok: true, value, at: loop.now }),
    (error: unknown) => (out = { ok: false, error, at: loop.now }),
  );
  const end = loop.now + maxMs;
  await flush();
  while (out === null && loop.now < end) {
    loop.advanceBy(step);
    await flush();
  }
  if (out === null) throw new Error(`still pending after ${maxMs} ms`);
  return out;
}

/** Advance virtual time by `ms`, letting promise chains run between steps. */
async function advance(loop: LoopbackNet, ms: number, step = 5): Promise<void> {
  const end = loop.now + ms;
  await flush();
  while (loop.now < end) {
    loop.advanceBy(Math.min(step, end - loop.now));
    await flush();
  }
}

function failure(o: Outcome<unknown>): DialFailure | 'ok' | 'other' {
  if (o.ok) return 'ok';
  return o.error instanceof DialError ? o.error.code : 'other';
}

interface World {
  loop: LoopbackNet;
  rtc: FakeRtcNet;
  hub: FakeBroadcastHub;
  peers: StandInPeerServer;
  deps: ConnectDeps;
  random: (b: Uint8Array<ArrayBuffer>) => void;
}

function world(): World {
  const loop = new LoopbackNet();
  const rtc = new FakeRtcNet(loop);
  return { loop, rtc, hub: new FakeBroadcastHub(loop), peers: new StandInPeerServer(loop), deps: { createPeer: rtc.createPeer, timers: netTimers(loop) }, random: counterRandom(3) };
}

function broadcast(w: World, seed = 1): BroadcastSignaller {
  return new BroadcastSignaller({ open: w.hub.open, timers: w.deps.timers, random: counterRandom(seed) });
}

function cloud(w: World, seed = 1): CloudSignaller {
  return new CloudSignaller({ openSocket: w.peers.openSocket, timers: w.deps.timers, random: counterRandom(seed), host: 'peers.test', port: 9000, secure: false });
}

/** A host listening on `code` with `signaller`: the transports of the guests it took. */
async function host(w: World, signaller: Signaller, code: string): Promise<{ room: RoomListener; guests: WebRtcTransport[]; failures: DialError[] }> {
  const room = new RoomListener(signaller, w.deps);
  const guests: WebRtcTransport[] = [];
  const failures: DialError[] = [];
  room.onGuest = (t) => guests.push(t);
  room.onGuestFailed = (e) => failures.push(e);
  const o = await settle(w.loop, room.open(code));
  if (!o.ok) throw o.error;
  return { room, guests, failures };
}

/** Both ends carry a message each way. */
function talks(w: World, a: WebRtcTransport, b: WebRtcTransport): boolean {
  const got: Array<[string, Channel, number]> = [];
  a.onMessage = (ch, bytes) => got.push(['a', ch, bytes.length]);
  b.onMessage = (ch, bytes) => got.push(['b', ch, bytes.length]);
  a.send(RELIABLE, new Uint8Array(70_000));
  b.send(RELIABLE, new Uint8Array(3));
  w.loop.advanceBy(500);
  return got.some((g) => g[0] === 'b' && g[2] === 70_000) && got.some((g) => g[0] === 'a' && g[2] === 3);
}

describe('room codes', () => {
  it('8 characters without look-alikes; typed in any case, with spaces or dashes', () => {
    const code = newRoomCode(counterRandom(9));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(parseRoomCode(code.toLowerCase())).toBe(code);
    expect(parseRoomCode(`${code.slice(0, 4)}-${code.slice(4)}`)).toBe(code);
    expect(parseRoomCode('ABCD-EFG')).toBeNull();
    expect(parseRoomCode('ABCDEFG0')).toBeNull(); // 0 is not in the alphabet
    const many = new Set(Array.from({ length: 200 }, (_, i) => newRoomCode(counterRandom(i + 1))));
    expect(many.size).toBe(200);
  });
});

describe('BroadcastSignaller', () => {
  it('a guest joins: knock, offer, answer; both ends get an open transport that carries both ways', async () => {
    const w = world();
    const h = await host(w, broadcast(w, 1), 'RXAMCDEF');
    const t0 = w.loop.now;
    const o = await settle(w.loop, joinRoom(broadcast(w, 2), 'rxamcdef', w.deps));
    expect(o.ok).toBe(true);
    // Gathering on each side, a few hops, the connection: well under a second here.
    expect(o.at - t0).toBeLessThan(2 * GATHER_TIMEOUT_MS);
    await advance(w.loop, 100);
    expect(h.guests).toHaveLength(1);
    expect(talks(w, (o as { value: WebRtcTransport }).value, h.guests[0]!)).toBe(true);
    // Only the host's channel stays (the paths are closed once connected).
    expect(w.hub.size).toBe(1);
    h.room.close();
    expect(w.hub.size).toBe(0);
  });

  it('two guests, one after the other, each with a connection of its own', async () => {
    const w = world();
    const h = await host(w, broadcast(w, 1), 'RXAMCDEF');
    const a = await settle(w.loop, joinRoom(broadcast(w, 2), 'RXAMCDEF', w.deps));
    const b = await settle(w.loop, joinRoom(broadcast(w, 3), 'RXAMCDEF', w.deps));
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(h.guests).toHaveLength(2);
    expect(talks(w, (b as { value: WebRtcTransport }).value, h.guests[1]!)).toBe(true);
  });

  it('no host for the code: unknown, within BROADCAST_KNOCK_MS', async () => {
    const w = world();
    await host(w, broadcast(w, 1), 'RXAMCDEF');
    const t0 = w.loop.now;
    const o = await settle(w.loop, joinRoom(broadcast(w, 2), 'XTHERCDE', w.deps));
    expect(failure(o)).toBe('unknown');
    expect(o.at - t0).toBeLessThanOrEqual(BROADCAST_KNOCK_MS + 10);
    expect(w.hub.size).toBe(1);
  });

  it('a page without BroadcastChannel: unreachable at once; a malformed code: bad_code', async () => {
    const w = world();
    w.hub.unavailable = true;
    expect(failure(await settle(w.loop, joinRoom(broadcast(w), 'RXAMCDEF', w.deps)))).toBe('unreachable');
    expect(failure(await settle(w.loop, broadcast(w).listen('RXAMCDEF', () => undefined)))).toBe('unreachable');
    w.hub.unavailable = false;
    expect(failure(await settle(w.loop, joinRoom(broadcast(w), 'nope', w.deps)))).toBe('bad_code');
  });

  it('the host knocks back but never answers the offer: no_answer, BROADCAST_PATIENCE_MS after the offer', async () => {
    const w = world();
    // A host page that takes the knock and then hangs.
    await settle(w.loop, broadcast(w, 1).listen('RXAMCDEF', () => undefined));
    const t0 = w.loop.now;
    const o = await settle(w.loop, joinRoom(broadcast(w, 2), 'RXAMCDEF', w.deps));
    expect(failure(o)).toBe('no_answer');
    expect(o.at - t0).toBeGreaterThanOrEqual(BROADCAST_PATIENCE_MS);
    expect(o.at - t0).toBeLessThanOrEqual(BROADCAST_PATIENCE_MS + GATHER_TIMEOUT_MS);
  });

  it('a gathering state that never says complete: each description goes out GATHER_QUIET_MS after the last candidate', async () => {
    const w = world();
    w.rtc.gatheringNeverCompletes = true;
    await host(w, broadcast(w, 1), 'RXAMCDEF');
    const t0 = w.loop.now;
    const o = await settle(w.loop, joinRoom(broadcast(w, 2), 'RXAMCDEF', w.deps));
    expect(o.ok).toBe(true);
    // Two descriptions, each held GATHER_QUIET_MS after its candidate; far below the GATHER_TIMEOUT_MS cap of each.
    expect(o.at - t0).toBeGreaterThanOrEqual(2 * GATHER_QUIET_MS);
    expect(o.at - t0).toBeLessThan(2 * GATHER_QUIET_MS + 500);
  });

  it("the host's path closes once its channels opened, before the guest's page got its own setRemoteDescription back: the guest connects", async () => {
    const w = world();
    const h = await host(w, broadcast(w, 1), 'RXAMCDEF');
    // The guest's page is busy: its setRemoteDescription and its channels' open come late, and the
    // host's 'bye' (sent once the host's channels opened) gets there first.
    const busy: ConnectDeps = {
      ...w.deps,
      createPeer: () => {
        const p = w.rtc.createPeer();
        p.busyMs = 200;
        return p;
      },
    };
    const o = await settle(w.loop, joinRoom(broadcast(w, 2), 'RXAMCDEF', busy));
    expect(failure(o)).toBe('ok');
    await advance(w.loop, 300);
    expect(h.guests).toHaveLength(1);
    expect(talks(w, (o as { value: WebRtcTransport }).value, h.guests[0]!)).toBe(true);
  });

  it('the host leaves in the middle of the handshake: left', async () => {
    const w = world();
    await settle(w.loop, broadcast(w, 1).listen('RXAMCDEF', (path) => path.close()));
    const o = await settle(w.loop, joinRoom(broadcast(w, 2), 'RXAMCDEF', w.deps));
    expect(failure(o)).toBe('left');
  });

  it('ICE finds no way through: ice, ICE_TIMEOUT_MS after the answer; earlier when ICE reports failed', async () => {
    const w = world();
    w.rtc.blockIce = true;
    const h = await host(w, broadcast(w, 1), 'RXAMCDEF');
    const t0 = w.loop.now;
    const o = await settle(w.loop, joinRoom(broadcast(w, 2), 'RXAMCDEF', w.deps));
    expect(failure(o)).toBe('ice');
    expect(o.at - t0).toBeGreaterThanOrEqual(ICE_TIMEOUT_MS);
    expect(o.at - t0).toBeLessThanOrEqual(ICE_TIMEOUT_MS + 2 * GATHER_TIMEOUT_MS);
    await advance(w.loop, BROADCAST_PATIENCE_MS + ICE_TIMEOUT_MS);
    expect(h.guests).toHaveLength(0);
    expect(h.failures.map((f) => f.code)).toEqual(['ice']);
    w.rtc.failIceAfterMs = 3000;
    const t1 = w.loop.now;
    const o2 = await settle(w.loop, joinRoom(broadcast(w, 3), 'RXAMCDEF', w.deps));
    expect(failure(o2)).toBe('ice');
    expect(o2.at - t1).toBeLessThan(ICE_TIMEOUT_MS);
  });

  it(`a host runs at most ${MAX_PENDING_HANDSHAKES} handshakes at once; closing the room turns new guests away`, async () => {
    const w = world();
    w.rtc.blockIce = true;
    const h = await host(w, broadcast(w, 1), 'RXAMCDEF');
    const joins = Array.from({ length: MAX_PENDING_HANDSHAKES + 2 }, (_, i) => joinRoom(broadcast(w, 10 + i), 'RXAMCDEF', w.deps));
    await advance(w.loop, 2000);
    expect(h.room.handshakes).toBe(MAX_PENDING_HANDSHAKES);
    const outcomes = await Promise.all(joins.map((p) => settle(w.loop, p)));
    expect(outcomes.filter((o) => failure(o) === 'left')).toHaveLength(2);
    w.rtc.blockIce = false;
    h.room.close();
    expect(failure(await settle(w.loop, joinRoom(broadcast(w, 99), 'RXAMCDEF', w.deps)))).toBe('unknown');
  });
});

describe('ManualSignaller', () => {
  it('invitation code -> answer code -> accepted: both ends connect', async () => {
    const w = world();
    const hostSignal = new ManualSignaller({ random: counterRandom(1) });
    const h = await host(w, hostSignal, 'RXAMCDEF');
    const invite = await settle(w.loop, hostSignal.invite());
    expect(invite.ok).toBe(true);
    const code = (invite as { value: string }).value;
    expect(code.startsWith('BL1I.')).toBe(true);
    const guestSignal = new ManualSignaller({ random: counterRandom(2) });
    let answer: string | null = null;
    guestSignal.onAnswer = (a) => (answer = a);
    const join = joinRoom(guestSignal, `  ${code.slice(0, 40)}\n${code.slice(40)}  `, w.deps);
    // A person takes a minute to copy the answer back.
    await advance(w.loop, 60_000);
    expect(answer).not.toBeNull();
    expect(answer!.startsWith('BL1A.')).toBe(true);
    expect(guestSignal.answer).toBe(answer);
    expect(() => hostSignal.accept(code)).toThrow(DialError); // an invitation is not an answer
    hostSignal.accept(answer!);
    const o = await settle(w.loop, join);
    expect(o.ok).toBe(true);
    await advance(w.loop, 100);
    expect(h.guests).toHaveLength(1);
    expect(talks(w, (o as { value: WebRtcTransport }).value, h.guests[0]!)).toBe(true);
    expect(hostSignal.open).toBe(0);
    // An answer to an invitation that is done: bad_code.
    expect(() => hostSignal.accept(answer!)).toThrow(DialError);
  });

  it('codes that do not decode: bad_code; the format round-trips', async () => {
    const w = world();
    const s = new ManualSignaller({ random: counterRandom(1) });
    expect(failure(await settle(w.loop, joinRoom(s, 'hello', w.deps)))).toBe('bad_code');
    expect(failure(await settle(w.loop, joinRoom(s, 'BL1I.!!!!', w.deps)))).toBe('bad_code');
    expect(failure(await settle(w.loop, joinRoom(s, encodeCode('BL1A.', 'ab', 'fake:x'), w.deps)))).toBe('bad_code');
    // A code that decodes but holds a description the browser rejects: bad_code from the handshake.
    expect(failure(await settle(w.loop, joinRoom(s, encodeCode('BL1I.', 'ab', 'v=0 garbage'), w.deps)))).toBe('bad_code');
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 1 127.0.0.1 5000 typ host\r\n';
    expect(decodeCode('BL1I.', encodeCode('BL1I.', '0a1b', sdp))).toEqual({ i: '0a1b', s: sdp });
    expect(decodeCode('BL1A.', encodeCode('BL1I.', '0a1b', sdp))).toBeNull();
    expect(() => s.accept('BL1A.abcd')).toThrow(DialError);
  });

  it('the host never pastes the answer: the guest gives up after the patience plus ICE_TIMEOUT_MS (ice)', async () => {
    const w = world();
    const hostSignal = new ManualSignaller({ random: counterRandom(1) });
    await host(w, hostSignal, 'RXAMCDEF');
    const code = (await settle(w.loop, hostSignal.invite())) as { value: string };
    const guestSignal = new ManualSignaller({ random: counterRandom(2) });
    const t0 = w.loop.now;
    const o = await settle(w.loop, joinRoom(guestSignal, code.value, w.deps), 40 * 60_000, 1000);
    expect(failure(o)).toBe('ice');
    expect(o.at - t0).toBeLessThanOrEqual(guestSignal.patienceMs + ICE_TIMEOUT_MS + GATHER_TIMEOUT_MS + 1000);
  });
});

describe('CloudSignaller (against the stand-in PeerJS server)', () => {
  it('a guest joins through the server: knock, offer and answer as PeerJS-shaped CANDIDATE messages; ids prefixed', async () => {
    const w = world();
    const h = await host(w, cloud(w, 1), 'RXAMCDEF');
    expect([...w.peers.clients.keys()]).toEqual([`${CLOUD_ROOM_PREFIX}RXAMCDEF`]);
    const o = await settle(w.loop, joinRoom(cloud(w, 2), 'RXAMCDEF', w.deps));
    expect(o.ok).toBe(true);
    await advance(w.loop, 200);
    expect(h.guests).toHaveLength(1);
    expect(talks(w, (o as { value: WebRtcTransport }).value, h.guests[0]!)).toBe(true);
    const guestSocket = w.peers.sockets[1]!;
    expect(guestSocket.url.searchParams.get('id')!.startsWith(CLOUD_GUEST_PREFIX)).toBe(true);
    expect(guestSocket.url.searchParams.get('key')).toBe('peerjs');
    // knock, offer, bye (the path closed once connected); the host: here, answer.
    expect(w.peers.relayed.map((r) => r.type)).toEqual(['CANDIDATE', 'CANDIDATE', 'CANDIDATE', 'CANDIDATE', 'CANDIDATE']);
    for (const s of w.peers.sockets) for (const m of s.sent) expect(JSON.stringify(m).length).toBeLessThan(MAX_FRAME);
    // The guest's socket is closed once connected; the host's stays.
    expect(guestSocket.readyState).toBe(3);
    expect([...w.peers.clients.keys()]).toEqual([`${CLOUD_ROOM_PREFIX}RXAMCDEF`]);
  });

  it('heartbeats keep the host socket (every 5 s)', async () => {
    const w = world();
    await host(w, cloud(w, 1), 'RXAMCDEF');
    await advance(w.loop, 21_000, 100);
    expect(w.peers.sockets[0]!.sent.filter((m) => m.type === 'HEARTBEAT').length).toBe(4);
  });

  it('no host holds the code: the server says EXPIRE and the guest gets unknown within a second', async () => {
    const w = world();
    const t0 = w.loop.now;
    const o = await settle(w.loop, joinRoom(cloud(w, 2), 'RXAMCDEF', w.deps));
    expect(failure(o)).toBe('unknown');
    expect(o.at - t0).toBeLessThan(1000);
  });

  it('the server does not answer: unreachable within CLOUD_CONNECT_MS; no WebSocket at all: unreachable at once', async () => {
    const w = world();
    w.peers.down = true;
    const t0 = w.loop.now;
    const o = await settle(w.loop, joinRoom(cloud(w, 2), 'RXAMCDEF', w.deps));
    expect(failure(o)).toBe('unreachable');
    expect(o.at - t0).toBeGreaterThanOrEqual(CLOUD_CONNECT_MS);
    expect(o.at - t0).toBeLessThanOrEqual(CLOUD_CONNECT_MS + 10);
    expect(failure(await settle(w.loop, cloud(w, 1).listen('RXAMCDEF', () => undefined)))).toBe('unreachable');
    w.peers.down = false;
    w.peers.refuse = true;
    const t1 = w.loop.now;
    const o2 = await settle(w.loop, joinRoom(cloud(w, 3), 'RXAMCDEF', w.deps));
    expect(failure(o2)).toBe('unreachable');
    expect(o2.at - t1).toBeLessThan(50);
  });

  it('close() while the room socket is still connecting: the socket is closed, no id stays held, no heartbeats; listening again works', async () => {
    const w = world();
    const signaller = cloud(w, 1);
    // The socket still connecting; open but before the server's OPEN arrived; OPEN arrived, the listen not yet resumed.
    for (const wait of [0, 25, 40]) {
      const listening = signaller.listen('RXAMCDEF', () => undefined);
      if (wait > 0) w.loop.advanceBy(wait);
      signaller.close();
      expect((await settle(w.loop, listening)).ok).toBe(true);
      await advance(w.loop, 21_000, 100);
      expect([...w.peers.clients.keys()]).toEqual([]);
      expect(w.peers.sockets.every((s) => s.readyState === 3)).toBe(true);
      expect(w.peers.sockets.flatMap((s) => s.sent).filter((m) => m.type === 'HEARTBEAT')).toEqual([]);
    }
    // A listen cancelled by the next one leaves only the next one's id.
    void signaller.listen('RXAMCDEF', () => undefined);
    const second = signaller.listen('RXAMCDEF', () => undefined);
    expect((await settle(w.loop, second)).ok).toBe(true);
    await advance(w.loop, 200);
    expect([...w.peers.clients.keys()]).toEqual([`${CLOUD_ROOM_PREFIX}RXAMCDEF`]);
    expect(w.peers.sockets.filter((s) => s.readyState === 1)).toHaveLength(1);
    // A guest's knock reaches it (the host answers 'here').
    expect((await settle(w.loop, cloud(w, 2).dial('RXAMCDEF'))).ok).toBe(true);
  });

  it('another host holds the code: taken', async () => {
    const w = world();
    await host(w, cloud(w, 1), 'RXAMCDEF');
    expect(failure(await settle(w.loop, cloud(w, 2).listen('RXAMCDEF', () => undefined)))).toBe('taken');
  });

  it("the host's socket dies: onLost; guests already connected are not affected; new guests get unknown until it listens again", async () => {
    const w = world();
    const signaller = cloud(w, 1);
    const h = await host(w, signaller, 'RXAMCDEF');
    const o = await settle(w.loop, joinRoom(cloud(w, 2), 'RXAMCDEF', w.deps));
    expect(o.ok).toBe(true);
    let lost = 0;
    signaller.onLost = () => lost++;
    w.peers.kill(`${CLOUD_ROOM_PREFIX}RXAMCDEF`);
    await advance(w.loop, 200);
    expect(lost).toBe(1);
    expect(talks(w, (o as { value: WebRtcTransport }).value, h.guests[0]!)).toBe(true);
    expect(failure(await settle(w.loop, joinRoom(cloud(w, 3), 'RXAMCDEF', w.deps)))).toBe('unknown');
    // Listening again takes the same id back (same token).
    await settle(w.loop, h.room.open('RXAMCDEF'));
    expect((await settle(w.loop, joinRoom(cloud(w, 4), 'RXAMCDEF', w.deps))).ok).toBe(true);
  });

  it('ICE fails behind the server too: ice', async () => {
    const w = world();
    w.rtc.blockIce = true;
    w.rtc.failIceAfterMs = 4000;
    await host(w, cloud(w, 1), 'RXAMCDEF');
    expect(failure(await settle(w.loop, joinRoom(cloud(w, 2), 'RXAMCDEF', w.deps)))).toBe('ice');
  });
});
