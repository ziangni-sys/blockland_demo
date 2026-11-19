/**
 * Fakes of the browser's connection objects for package 10's tests (RTCPeerConnection and its data
 * channels, BroadcastChannel, and the timers), all on a LoopbackNet's virtual clock. Node has no
 * WebRTC; the real thing is tested in a browser (scripts/e2e-room.mjs).
 *
 * FakeRtcNet: peers find each other through the description: an offer or answer is
 * `fake:<peer id>` plus a candidate line. Once both sides have set both descriptions the
 * connection opens after `iceDelayMs` (both negotiated channel pairs open, connectionState
 * 'connected'), unless `blockIce` (it stays 'connecting'; with `failIceAfterMs` it becomes
 * 'failed'). Gathering completes `gatherDelayMs` after setLocalDescription.
 *
 * FakeChannel: send() queues a copy of the bytes; with `bandwidth` (bytes/s, one queue per channel)
 * bufferedAmount is what has not left yet, and 'bufferedamountlow' fires when it falls to the
 * threshold. A message arrives `latencyMs` after it left. close(): the far end gets its
 * pending messages, then 'close'; both ends end up 'closed'.
 */
import type { LoopbackNet } from '../../src/net/loopback';
import type { BroadcastLike } from '../../src/net/webrtc/broadcast';
import type { RtcPeer } from '../../src/net/webrtc/connect';
import type { Timers } from '../../src/net/webrtc/transport';

/** Timers on the net's virtual clock. */
export function netTimers(net: LoopbackNet): Timers & { every(fn: () => void, ms: number): unknown; stop(h: unknown): void } {
  return {
    set(fn, ms) {
      const h = { cancelled: false };
      net.schedule(net.now + Math.max(0, ms), () => {
        if (!h.cancelled) fn();
      });
      return h;
    },
    clear(h) {
      if (h !== null && typeof h === 'object') (h as { cancelled: boolean }).cancelled = true;
    },
    every(fn, ms) {
      const h = { cancelled: false };
      const tick = (): void => {
        if (h.cancelled) return;
        fn();
        net.schedule(net.now + ms, tick);
      };
      net.schedule(net.now + ms, tick);
      return h;
    },
    stop(h) {
      if (h !== null && typeof h === 'object') (h as { cancelled: boolean }).cancelled = true;
    },
  };
}

/** Deterministic "random" bytes. */
export function counterRandom(seed = 1): (bytes: Uint8Array<ArrayBuffer>) => void {
  let x = seed >>> 0 || 1;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      bytes[i] = x & 255;
    }
  };
}

export class FakeChannel {
  readonly label: string;
  readonly id: number;
  readonly ordered: boolean;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  onopen: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onmessage: ((this: RTCDataChannel, ev: MessageEvent) => unknown) | null = null;
  onclose: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onerror: ((this: RTCDataChannel, ev: RTCErrorEvent) => unknown) | null = null;
  onbufferedamountlow: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  peer: FakeChannel | null = null;
  /** Everything sent (copies), for the tests to look at. */
  readonly sent: Uint8Array[] = [];
  /** When the last queued byte leaves (bandwidth). */
  private freeAt = 0;
  /** Messages on the way to the far end, not delivered yet. */
  private inFlight = 0;
  private closeWaiting = false;
  /** send() throws (the browser refuses: a full buffer). */
  refuseSends = false;

  constructor(
    private readonly net: FakeRtcNet,
    label: string,
    init: RTCDataChannelInit,
  ) {
    this.label = label;
    this.id = init.id ?? -1;
    this.ordered = init.ordered ?? true;
  }

  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new DOMException('not open', 'InvalidStateError');
    if (this.refuseSends) throw new DOMException('send queue is full', 'OperationError');
    let bytes: Uint8Array;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data.slice(0));
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    else throw new TypeError('blobs are not faked');
    const text = typeof data === 'string';
    this.sent.push(bytes);
    this.bufferedAmount += bytes.length;
    const net = this.net;
    const leave = net.bandwidth > 0 ? Math.max(net.loop.now, this.freeAt) + (bytes.length * 1000) / net.bandwidth : net.loop.now;
    this.freeAt = leave;
    this.inFlight++;
    net.loop.schedule(leave, () => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= bytes.length;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.fire('onbufferedamountlow', new Event('bufferedamountlow'));
      net.loop.schedule(net.loop.now + net.latencyMs, () => {
        this.inFlight--;
        const far = this.peer;
        if (far !== null && (far.readyState === 'open' || far.readyState === 'closing')) {
          far.fire('onmessage', new MessageEvent('message', { data: text ? new TextDecoder().decode(bytes) : bytes.buffer }));
        }
        if (this.closeWaiting && this.inFlight === 0) this.finishClose();
      });
    });
  }

  close(): void {
    if (this.readyState === 'closed' || this.readyState === 'closing') return;
    this.readyState = 'closing';
    this.closeWaiting = true;
    if (this.inFlight === 0) this.net.loop.schedule(this.net.loop.now + this.net.latencyMs, () => this.finishClose());
  }

  /** Deliver raw bytes to this channel as if the far end had sent them (bypasses the far end's checks). */
  inject(data: ArrayBuffer | string): void {
    this.net.loop.schedule(this.net.loop.now, () => {
      if (this.readyState === 'open') this.fire('onmessage', new MessageEvent('message', { data }));
    });
  }

  /** Open (the connection came up). */
  openNow(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.fire('onopen', new Event('open'));
  }

  /** The connection died: closed at once, no flushing. */
  abort(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.fire('onclose', new Event('close'));
  }

  private finishClose(): void {
    if (!this.closeWaiting) return;
    this.closeWaiting = false;
    for (const ch of [this, this.peer]) {
      if (ch === null || ch.readyState === 'closed') continue;
      ch.readyState = 'closed';
      ch.fire('onclose', new Event('close'));
    }
  }

  fire(name: 'onopen' | 'onmessage' | 'onclose' | 'onbufferedamountlow' | 'onerror', ev: Event): void {
    const f = this[name] as ((this: RTCDataChannel, ev: Event) => unknown) | null;
    f?.call(this as unknown as RTCDataChannel, ev);
  }
}

export class FakePeer implements RtcPeer {
  connectionState: RTCPeerConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => unknown) | null = null;
  onicegatheringstatechange: ((this: RTCPeerConnection, ev: Event) => unknown) | null = null;
  onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => unknown) | null = null;
  readonly channels: FakeChannel[] = [];
  closed = false;
  /**
   * This peer's page is busy: what the browser does takes effect at once, but its events
   * (setRemoteDescription resolving, the channels' open) reach the page this much later, ms.
   * Messages from elsewhere (a BroadcastChannel) are not held up.
   */
  busyMs = 0;

  constructor(
    private readonly net: FakeRtcNet,
    readonly id: string,
  ) {}

  createDataChannel(label: string, init: RTCDataChannelInit = {}): RTCDataChannel {
    const ch = new FakeChannel(this.net, label, init);
    this.channels.push(ch);
    return ch as unknown as RTCDataChannel;
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: `fake:${this.id}` });
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.remoteDescription === null) return Promise.reject(new Error('no remote description'));
    return Promise.resolve({ type: 'answer', sdp: `fake:${this.id}` });
  }

  setLocalDescription(d?: RTCLocalSessionDescriptionInit): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    const sdp = `${d?.sdp ?? `fake:${this.id}`}\r\na=candidate:${this.id} 1 udp 2122260223 10.0.0.1 5000 typ host`;
    this.localDescription = { type: d?.type ?? 'offer', sdp, toJSON: () => ({}) } as RTCSessionDescription;
    this.iceGatheringState = 'gathering';
    if (this.net.gatheringNeverCompletes) {
      // One candidate, and the state stays 'gathering' (an interface or STUN server that never answers).
      this.net.loop.schedule(this.net.loop.now + this.net.gatherDelayMs, () => {
        if (!this.closed) this.onicecandidate?.call(this as unknown as RTCPeerConnection, { candidate: { candidate: `candidate:${this.id}` } } as RTCPeerConnectionIceEvent);
      });
      this.net.tryConnect(this);
      return Promise.resolve();
    }
    this.net.loop.schedule(this.net.loop.now + this.net.gatherDelayMs, () => {
      if (this.closed) return;
      this.iceGatheringState = 'complete';
      this.onicegatheringstatechange?.call(this as unknown as RTCPeerConnection, new Event('icegatheringstatechange'));
      this.onicecandidate?.call(this as unknown as RTCPeerConnection, { candidate: null } as RTCPeerConnectionIceEvent);
    });
    this.net.tryConnect(this);
    return Promise.resolve();
  }

  setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    const m = /^fake:([\w:-]+)/.exec(d.sdp ?? '');
    if (m === null || !this.net.peers.has(m[1]!)) return Promise.reject(new DOMException('cannot parse the description', 'OperationError'));
    this.remoteDescription = { type: d.type ?? 'offer', sdp: d.sdp! };
    this.net.tryConnect(this);
    if (this.busyMs === 0) return Promise.resolve();
    return new Promise((resolve) => this.net.loop.schedule(this.net.loop.now + this.busyMs, () => resolve()));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    for (const ch of this.channels) {
      ch.readyState = 'closed';
      // The far end's channel dies with the association.
      const far = ch.peer;
      if (far !== null && far.readyState !== 'closed') this.net.loop.schedule(this.net.loop.now + this.net.latencyMs, () => far.abort());
    }
  }

  /** Change the connection state (and tell the page). */
  setState(s: RTCPeerConnectionState): void {
    if (this.closed) return;
    this.connectionState = s;
    this.onconnectionstatechange?.call(this as unknown as RTCPeerConnection, new Event('connectionstatechange'));
  }

  /** The peer this one's remote description names. */
  remoteId(): string | null {
    const m = /^fake:([\w:-]+)/.exec(this.remoteDescription?.sdp ?? '');
    return m === null ? null : m[1]!;
  }
}

export class FakeRtcNet {
  readonly peers = new Map<string, FakePeer>();
  latencyMs = 5;
  /** Bytes per second leaving each channel (0 = at once). */
  bandwidth = 0;
  gatherDelayMs = 20;
  iceDelayMs = 30;
  /** The connection never comes up. */
  blockIce = false;
  /** Gathering finds one candidate and never says 'complete'. */
  gatheringNeverCompletes = false;
  /** With blockIce: the state becomes 'failed' this long after both descriptions are set (0 = never). */
  failIceAfterMs = 0;
  private seq = 0;

  constructor(readonly loop: LoopbackNet) {}

  /** A new peer connection (connect.ts ConnectDeps.createPeer). */
  createPeer = (): FakePeer => {
    const p = new FakePeer(this, `p${++this.seq}`);
    this.peers.set(p.id, p);
    return p;
  };

  tryConnect(p: FakePeer): void {
    const q = this.peers.get(p.remoteId() ?? '');
    if (q === undefined || q.remoteId() !== p.id || p.localDescription === null || q.localDescription === null) return;
    if (p.connectionState !== 'new' || q.connectionState !== 'new') return;
    p.setState('connecting');
    q.setState('connecting');
    if (this.blockIce) {
      if (this.failIceAfterMs > 0) {
        this.loop.schedule(this.loop.now + this.failIceAfterMs, () => {
          p.setState('failed');
          q.setState('failed');
        });
      }
      return;
    }
    this.loop.schedule(this.loop.now + this.iceDelayMs, () => {
      if (p.closed || q.closed) return;
      for (const a of p.channels) {
        const b = q.channels.find((c) => c.id === a.id);
        if (b === undefined) continue;
        a.peer = b;
        b.peer = a;
      }
      for (const peer of [p, q]) {
        const open = (): void => {
          if (peer.closed) return;
          peer.setState('connected');
          for (const ch of peer.channels) if (ch.peer !== null) ch.openNow();
        };
        if (peer.busyMs === 0) open();
        else this.loop.schedule(this.loop.now + peer.busyMs, open);
      }
    });
  }
}

/** BroadcastChannels of one "browser" on the virtual clock: a message reaches every other channel of its name. */
export class FakeBroadcastHub {
  private readonly channels = new Set<{ name: string; ch: BroadcastLike & { closed: boolean } }>();
  /** open() throws (a page without BroadcastChannel). */
  unavailable = false;

  constructor(private readonly loop: LoopbackNet) {}

  open = (name: string): BroadcastLike => {
    if (this.unavailable) throw new ReferenceError('BroadcastChannel is not defined');
    const hub = this;
    const entry = {
      name,
      ch: {
        closed: false,
        onmessage: null as BroadcastChannel['onmessage'],
        postMessage(message: unknown): void {
          if (this.closed) throw new DOMException('closed', 'InvalidStateError');
          const data = structuredClone(message);
          for (const other of hub.channels) {
            if (other === entry || other.name !== name) continue;
            hub.loop.schedule(hub.loop.now + 1, () => {
              if (!other.ch.closed) other.ch.onmessage?.call(other.ch as unknown as BroadcastChannel, new MessageEvent('message', { data }));
            });
          }
        },
        close(): void {
          this.closed = true;
          hub.channels.delete(entry);
        },
      },
    };
    this.channels.add(entry);
    return entry.ch;
  };

  /** Channels open now. */
  get size(): number {
    return this.channels.size;
  }
}
