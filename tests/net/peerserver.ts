/**
 * A local stand-in for the public PeerJS server (tests only, never shipped), on a LoopbackNet's
 * virtual clock. It speaks what the running service was seen to speak on 2026-11-18 (see
 * src/net/webrtc/cloud.ts and the probe log of package 10):
 *  - a socket to /peerjs?key=peerjs&id=&token= gets {"type":"OPEN"}; an id held under another
 *    token gets ID-TAKEN and is closed; a wrong key gets ERROR and is closed;
 *  - HEARTBEAT is accepted;
 *  - CANDIDATE with a PeerJS-shaped payload (candidate.candidate a string, type 'data' or
 *    'media', a connectionId) goes to `dst` with `src` added, or comes back at once as EXPIRE
 *    when nobody holds `dst`;
 *  - any other message (OFFER, ANSWER, LEAVE, EXPIRE, a CANDIDATE of another shape) is not
 *    relayed and the sender's socket is closed 2 s later; a message above MAX_FRAME closes it
 *    (code 1009).
 */
import type { LoopbackNet } from '../../src/net/loopback';
import type { SocketLike } from '../../src/net/webrtc/cloud';

/** The largest socket message relayed (the service relayed 16129 bytes and closed on 20129). */
export const MAX_FRAME = 16_384;
/** Delay of one hop through the server, ms. */
const HOP_MS = 20;

export class StandInSocket implements SocketLike {
  readyState: WebSocket['readyState'] = 0;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  /** Messages the client sent (parsed). */
  readonly sent: Array<Record<string, unknown>> = [];
  closeCode = 0;

  constructor(
    private readonly server: StandInPeerServer,
    readonly url: URL,
  ) {}

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1) throw new DOMException('not open', 'InvalidStateError');
    const text = String(data);
    this.server.fromClient(this, text);
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.server.gone(this);
  }

  /** Server side: deliver a message to the client. */
  push(msg: unknown): void {
    const text = JSON.stringify(msg);
    this.server.loop.schedule(this.server.loop.now + HOP_MS, () => {
      if (this.readyState === 1) this.onmessage?.call(this as unknown as WebSocket, new MessageEvent('message', { data: text }));
    });
  }

  /** Server side: close the socket (the client sees 'close'). */
  drop(code: number): void {
    if (this.readyState >= 2) return;
    this.closeCode = code;
    this.readyState = 3;
    this.server.gone(this);
    this.server.loop.schedule(this.server.loop.now + HOP_MS, () => this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent));
  }

  opened(): void {
    this.readyState = 1;
    this.onopen?.call(this as unknown as WebSocket, new Event('open'));
  }
}

export class StandInPeerServer {
  /** Peer ids held, with their token and socket. */
  readonly clients = new Map<string, { token: string; socket: StandInSocket }>();
  /** Every socket ever opened. */
  readonly sockets: StandInSocket[] = [];
  /** Nobody answers: sockets never open (an unreachable or blocked service). */
  down = false;
  /** openSocket throws (no WebSocket in this page, or a refused URL). */
  refuse = false;
  /** Messages relayed (type, src, dst), in order. */
  readonly relayed: Array<{ type: string; src: string; dst: string }> = [];

  constructor(readonly loop: LoopbackNet) {}

  /** CloudOptions.openSocket. */
  openSocket = (url: string): SocketLike => {
    if (this.refuse) throw new DOMException('refused', 'SecurityError');
    const s = new StandInSocket(this, new URL(url));
    this.sockets.push(s);
    if (!this.down) this.loop.schedule(this.loop.now + HOP_MS, () => this.connect(s));
    return s;
  };

  /** Close the socket that holds `id` (the host's page died; its network went away). */
  kill(id: string): void {
    this.clients.get(id)?.socket.drop(1006);
  }

  private connect(s: StandInSocket): void {
    if (s.readyState !== 0) return;
    s.opened();
    const q = s.url.searchParams;
    const id = q.get('id');
    const token = q.get('token');
    if (s.url.pathname !== '/peerjs' || !id || !token || q.get('key') !== 'peerjs') {
      s.push({ type: 'ERROR', payload: { msg: 'Invalid key provided' } });
      this.loop.schedule(this.loop.now + 2 * HOP_MS, () => s.drop(1000));
      return;
    }
    const held = this.clients.get(id);
    if (held !== undefined && held.token !== token) {
      s.push({ type: 'ID-TAKEN', payload: { msg: 'ID is taken' } });
      this.loop.schedule(this.loop.now + 2 * HOP_MS, () => s.drop(1000));
      return;
    }
    this.clients.set(id, { token, socket: s });
    s.push({ type: 'OPEN' });
  }

  fromClient(s: StandInSocket, text: string): void {
    if (text.length > MAX_FRAME) {
      s.drop(1009);
      return;
    }
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    s.sent.push(m);
    const src = s.url.searchParams.get('id')!;
    if (this.clients.get(src)?.socket !== s) return;
    if (m.type === 'HEARTBEAT') return;
    const p = m.payload as Record<string, unknown> | undefined;
    const c = p?.candidate as Record<string, unknown> | undefined;
    const valid = m.type === 'CANDIDATE' && typeof m.dst === 'string' && typeof c?.candidate === 'string' && (p?.type === 'data' || p?.type === 'media') && typeof p?.connectionId === 'string';
    if (!valid) {
      this.loop.schedule(this.loop.now + 2000, () => s.drop(1000));
      return;
    }
    const dst = m.dst as string;
    const to = this.clients.get(dst);
    if (to === undefined) {
      s.push({ type: 'EXPIRE', src: dst, dst: src });
      return;
    }
    this.relayed.push({ type: 'CANDIDATE', src, dst });
    to.socket.push({ type: 'CANDIDATE', src, dst, payload: p });
  }

  gone(s: StandInSocket): void {
    for (const [id, c] of this.clients) if (c.socket === s) this.clients.delete(id);
  }
}
