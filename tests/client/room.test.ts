/**
 * Package 10, the page's side of rooms (client/room.ts): the address parameters, a message in both
 * languages for every way a connection ends, and RoomHost's order of things (listen before the
 * server's openRoom, closeRoom on close, listening again after the service was lost, the
 * forwarders ended with the world).
 */
import { describe, expect, it } from 'vitest';
import { END_GRACE_MS, dialFailureKey, joinFromSearch, kickKey, refuseKey, RELISTEN_MS, RoomHost, signalFromSearch, type RoomServer, type RoomState } from '../../src/client/room';
import { clientText } from '../../src/client/strings';
import { LoopbackNet } from '../../src/net/loopback';
import { KICK_REASONS, REFUSE_REASONS } from '../../src/net/protocol';
import { joinRoom } from '../../src/net/webrtc/connect';
import { BroadcastSignaller } from '../../src/net/webrtc/broadcast';
import { CloudSignaller } from '../../src/net/webrtc/cloud';
import { DialError, type DialFailure } from '../../src/net/webrtc/signal';
import type { PortLike } from '../../src/net/host/port';
import { counterRandom, FakeBroadcastHub, FakeRtcNet, netTimers } from '../net/fakertc';
import { StandInPeerServer } from '../net/peerserver';

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function advance(loop: LoopbackNet, ms: number): Promise<void> {
  const end = loop.now + ms;
  await flush();
  while (loop.now < end) {
    loop.advanceBy(Math.min(5, end - loop.now));
    await flush();
  }
}

describe('address parameters', () => {
  it('?join=<code>&signal=<kind>, cloud by default; anything else is no join', () => {
    expect(joinFromSearch('?join=ABCD-EFGH')).toEqual({ code: 'ABCD-EFGH', signal: 'cloud' });
    expect(joinFromSearch('?slot=b&join=XYZXYZXY&signal=broadcast')).toEqual({ code: 'XYZXYZXY', signal: 'broadcast' });
    expect(joinFromSearch('?join=BL1I.abc&signal=manual')).toEqual({ code: 'BL1I.abc', signal: 'manual' });
    expect(joinFromSearch('?join=ABCDEFGH&signal=carrier-pigeon')).toEqual({ code: 'ABCDEFGH', signal: 'cloud' });
    expect(joinFromSearch('?join=')).toBeNull();
    expect(joinFromSearch('?slot=b')).toBeNull();
    expect(joinFromSearch('')).toBeNull();
    expect(signalFromSearch('?signal=manual')).toBe('manual');
    expect(signalFromSearch('?signal=x')).toBeNull();
  });
});

describe('a message for every way a connection ends, in zh and en', () => {
  it('each DialFailure, Refuse reason and Kick reason has its own text', () => {
    const failures: DialFailure[] = ['unreachable', 'unknown', 'taken', 'bad_code', 'no_answer', 'left', 'ice'];
    const keys = [...failures.map(dialFailureKey), ...REFUSE_REASONS.map(refuseKey), ...KICK_REASONS.map(kickKey), 'join.gone' as const, 'join.lost' as const, 'join.dropped' as const, 'join.noWelcome' as const, 'room.offline' as const];
    expect(new Set(keys).size).toBe(keys.length);
    for (const lang of ['zh', 'en'] as const) {
      const texts = keys.map((k) => clientText(lang, k));
      expect(new Set(texts).size).toBe(texts.length);
      for (const t of texts) expect(t.length).toBeGreaterThan(4);
    }
  });
});

interface Rig {
  loop: LoopbackNet;
  calls: string[];
  ports: number;
  server: RoomServer;
}

function rig(): Rig {
  const loop = new LoopbackNet();
  const r: Rig = {
    loop,
    calls: [],
    ports: 0,
    server: {
      connectGuest: (): PortLike => {
        r.ports++;
        r.calls.push('connectGuest');
        return { postMessage: () => undefined, onmessage: null, close: () => undefined };
      },
      openRoom: () => r.calls.push('openRoom'),
      closeRoom: () => r.calls.push('closeRoom'),
    },
  };
  return r;
}

describe('RoomHost', () => {
  it("listens first, then opens the server's room; a guest becomes a forwarded connection; close() closes the room, guests stay", async () => {
    const r = rig();
    const rtc = new FakeRtcNet(r.loop);
    const hub = new FakeBroadcastHub(r.loop);
    const timers = netTimers(r.loop);
    const deps = { createPeer: rtc.createPeer, timers };
    const states: RoomState[] = [];
    const room = new RoomHost({ server: r.server, signaller: new BroadcastSignaller({ open: hub.open, timers, random: counterRandom(1) }), code: 'RXAMCDEF', deps, intervals: timers, onState: (s) => states.push(s) });
    const opening = room.open();
    expect(r.calls).toEqual([]);
    await opening;
    expect(r.calls).toEqual(['openRoom']);
    let joined = false;
    joinRoom(new BroadcastSignaller({ open: hub.open, timers, random: counterRandom(2) }), 'RXAMCDEF', deps).then(() => (joined = true), () => undefined);
    await advance(r.loop, 1000);
    expect(joined).toBe(true);
    expect(r.calls).toEqual(['openRoom', 'connectGuest']);
    expect(room.guests).toBe(1);
    room.close();
    expect(r.calls.at(-1)).toBe('closeRoom');
    expect(room.guests).toBe(1);
    expect(states).toEqual(['opening', 'open', 'closed']);
    // end(): the forwarders still open are closed after the grace period.
    room.end();
    await advance(r.loop, END_GRACE_MS + 100);
    expect(room.guests).toBe(0);
  });

  it('a signaller that cannot listen: open() rejects with its DialError and the server room stays closed', async () => {
    const r = rig();
    const hub = new FakeBroadcastHub(r.loop);
    hub.unavailable = true;
    const timers = netTimers(r.loop);
    const room = new RoomHost({ server: r.server, signaller: new BroadcastSignaller({ open: hub.open, timers, random: counterRandom(1) }), code: 'RXAMCDEF', deps: { createPeer: new FakeRtcNet(r.loop).createPeer, timers }, intervals: timers });
    await expect(room.open()).rejects.toBeInstanceOf(DialError);
    expect(r.calls).toEqual([]);
    expect(room.state).toBe('closed');
  });

  it('the world closes (end) or the room closes while it still connects to the public service: no room id stays held, the server room never opens', async () => {
    for (const how of ['end', 'close'] as const) {
      const r = rig();
      const peers = new StandInPeerServer(r.loop);
      const timers = netTimers(r.loop);
      const room = new RoomHost({
        server: r.server,
        signaller: new CloudSignaller({ openSocket: peers.openSocket, timers, random: counterRandom(1), host: 'peers.test', port: 9000, secure: false }),
        code: 'RXAMCDEF',
        deps: { createPeer: new FakeRtcNet(r.loop).createPeer, timers },
        intervals: timers,
      });
      const opened = room.open();
      room[how]();
      await advance(r.loop, 30_000);
      await opened;
      expect(room.state).toBe('closed');
      expect([...peers.clients.keys()]).toEqual([]);
      expect(peers.sockets.every((s) => s.readyState === 3)).toBe(true);
      expect(r.calls.filter((c) => c === 'openRoom')).toEqual([]);
    }
  });

  it(`the signalling service lost: state 'lost', listened on again every ${RELISTEN_MS / 1000} s until it works`, async () => {
    const r = rig();
    const peers = new StandInPeerServer(r.loop);
    const timers = netTimers(r.loop);
    const states: RoomState[] = [];
    const room = new RoomHost({
      server: r.server,
      signaller: new CloudSignaller({ openSocket: peers.openSocket, timers, random: counterRandom(1), host: 'peers.test', port: 9000, secure: false }),
      code: 'RXAMCDEF',
      deps: { createPeer: new FakeRtcNet(r.loop).createPeer, timers },
      intervals: timers,
      onState: (s) => states.push(s),
    });
    const opened = room.open();
    await advance(r.loop, 200);
    await opened;
    peers.down = true;
    peers.kill('blocklands-room-RXAMCDEF');
    await advance(r.loop, 200);
    expect(room.state).toBe('lost');
    // The service is still down at the first retry (it times out), back for a later one.
    await advance(r.loop, RELISTEN_MS + 1000);
    expect(room.state).toBe('lost');
    peers.down = false;
    await advance(r.loop, 30_000);
    expect(room.state).toBe('open');
    expect(states).toEqual(['opening', 'open', 'lost', 'open']);
    expect(r.calls).toEqual(['openRoom']);
  });
});
