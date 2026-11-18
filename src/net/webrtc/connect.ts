/**
 * Making a WebRTC connection over a SignalPath (docs/NETCODE.md section 2, package 10), and the
 * two ends of a room on top: RoomListener (the host takes guests) and joinRoom (a guest dials).
 *
 * THE HANDSHAKE (connectPeer). Both sides make one RTCPeerConnection with the page's ICE servers
 * (STUN only: no relay, so some networks cannot connect; that ends in 'ice' with its own message)
 * and the two negotiated data channels of section 2. The offerer of the path creates its offer,
 * waits until ICE gathering is complete (or no new candidate came for GATHER_QUIET_MS, or
 * GATHER_TIMEOUT_MS passed: browsers often leave the state at 'gathering' for tens of seconds when
 * one interface or STUN server does not answer) and sends the description with every candidate
 * found in it; the other side answers the same way. No
 * candidates trickle: each side sends one blob, which a person can copy (ManualSignaller), and
 * the relays carry two messages per guest. Then the connection must open within ICE_TIMEOUT_MS
 * (or ICE reports 'failed' earlier); the transport is a WebRtcTransport on the two open channels.
 *
 * TIMEOUTS of a join (each stage its own failure, see signal.ts DialFailure): reaching the
 * signalling service and finding the room (the signaller's own: CloudSignaller CONNECT_TIMEOUT_MS
 * and KNOCK_TIMEOUT_MS, BroadcastSignaller KNOCK_TIMEOUT_MS) -> the other side's description
 * (Signaller.patienceMs after ours went out, or after the path opened for the answerer):
 * 'no_answer' -> the connection opens (ICE_TIMEOUT_MS): 'ice'. The game protocol's own handshake
 * (Hello -> Welcome or Refuse) follows on the transport (NetClient).
 *
 * No globals: the peer connection comes from `createPeer` (the page: new RTCPeerConnection with
 * its ICE servers), timers from `timers`.
 */
import { DialError, type DialFailure, type SignalMessage, type SignalPath, type Signaller } from './signal';
import { RELIABLE_ID, RELIABLE_LABEL, UNRELIABLE_ID, UNRELIABLE_LABEL, WebRtcTransport, type Timers } from './transport';

/** Longest wait for ICE gathering before the description goes out with the candidates found so far, ms. */
export const GATHER_TIMEOUT_MS = 5000;
/** Gathering counts as done this long after the last new candidate, ms (see sendDescription). */
export const GATHER_QUIET_MS = 1500;
/** Longest wait for the connection to open once both descriptions are set, ms. */
export const ICE_TIMEOUT_MS = 15_000;
/** Handshakes a host runs at once; guests knocking beyond that are turned away (their paths closed). */
export const MAX_PENDING_HANDSHAKES = 8;
/** The public STUN servers (Google's). No TURN: some networks cannot connect (failure 'ice'). */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = Object.freeze([{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]);

/** The part of an RTCPeerConnection a handshake uses (tests pass a fake). */
export type RtcPeer = Pick<
  RTCPeerConnection,
  | 'connectionState'
  | 'iceGatheringState'
  | 'localDescription'
  | 'createDataChannel'
  | 'setLocalDescription'
  | 'setRemoteDescription'
  | 'close'
  | 'onconnectionstatechange'
  | 'onicegatheringstatechange'
  | 'onicecandidate'
> & {
  // Without the legacy callback overloads.
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
};

export interface ConnectDeps {
  /** A new peer connection (the page: new RTCPeerConnection({ iceServers })). */
  createPeer(): RtcPeer;
  timers: Timers;
  /** Override the timeouts (tests). */
  gatherMs?: number;
  iceMs?: number;
}

/**
 * Connect over `path` as `side`: resolves with the open transport, rejects with a DialError
 * ('no_answer', 'left', 'unreachable', 'bad_code', 'ice'). The path is closed either way.
 * `patienceMs`: how long to wait for the other side's description.
 */
export function connectPeer(path: SignalPath, side: 'host' | 'guest', patienceMs: number, deps: ConnectDeps): Promise<WebRtcTransport> {
  return new Promise((resolve, reject) => {
    const timers = deps.timers;
    const offering = path.offerer === side;
    let pc: RtcPeer;
    try {
      pc = deps.createPeer();
    } catch (e) {
      path.close();
      reject(new DialError('ice', `this browser cannot make a peer connection: ${describe(e)}`));
      return;
    }
    let r: RTCDataChannel;
    let u: RTCDataChannel;
    try {
      r = pc.createDataChannel(RELIABLE_LABEL, { negotiated: true, id: RELIABLE_ID, ordered: true });
      u = pc.createDataChannel(UNRELIABLE_LABEL, { negotiated: true, id: UNRELIABLE_ID, ordered: false, maxRetransmits: 0 });
    } catch (e) {
      path.close();
      safely(() => pc.close());
      reject(new DialError('ice', `cannot make the data channels: ${describe(e)}`));
      return;
    }
    r.binaryType = 'arraybuffer';
    u.binaryType = 'arraybuffer';
    let done = false;
    /** Our description went out and theirs is set: the path is no longer needed. */
    let exchanged = false;
    let sent = false;
    let received = false;
    let timer: unknown = null;

    const clearTimer = (): void => {
      if (timer !== null) timers.clear(timer);
      timer = null;
    };
    const detach = (): void => {
      r.onopen = null;
      u.onopen = null;
      r.onclose = null;
      u.onclose = null;
      pc.onconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.onicecandidate = null;
      path.onMessage = null;
      path.onEnd = null;
    };
    const fail = (code: DialFailure, message: string): void => {
      if (done) return;
      done = true;
      clearTimer();
      detach();
      path.close();
      safely(() => r.close());
      safely(() => u.close());
      safely(() => pc.close());
      reject(new DialError(code, message));
    };
    const wait = (ms: number, code: DialFailure, message: string): void => {
      clearTimer();
      timer = timers.set(() => fail(code, message), ms);
    };
    const opened = (): void => {
      if (done || r.readyState !== 'open' || u.readyState !== 'open') return;
      done = true;
      clearTimer();
      detach();
      path.close();
      resolve(new WebRtcTransport(pc, r, u, timers));
    };
    const settled = (): void => {
      if (!sent || !received) return;
      exchanged = true;
      // The answerer's description still has to reach the offerer (a person pastes a manual
      // answer code): it waits that long on top.
      wait((offering ? 0 : patienceMs) + (deps.iceMs ?? ICE_TIMEOUT_MS), 'ice', 'no direct connection could be made in time');
      opened();
    };
    /** Our description, once gathering is complete (or GATHER_TIMEOUT_MS passed). */
    const sendDescription = (t: 'offer' | 'answer'): void => {
      let gatherTimer: unknown = null;
      let quietTimer: unknown = null;
      const go = (): void => {
        if (done || sent) return;
        if (gatherTimer !== null) timers.clear(gatherTimer);
        if (quietTimer !== null) timers.clear(quietTimer);
        pc.onicegatheringstatechange = null;
        pc.onicecandidate = null;
        const sdp = pc.localDescription?.sdp ?? '';
        if (sdp === '') return fail('ice', 'no local description');
        sent = true;
        path.send({ t, sdp });
        if (!received) wait(patienceMs, 'no_answer', 'the other side did not answer');
        settled();
      };
      if (pc.iceGatheringState === 'complete') return go();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') go();
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate === null) return go();
        // Candidates come in a burst (host at once, server-reflexive one STUN round trip later);
        // a gathering state that never says 'complete' (an interface or STUN server that does not
        // answer) is not waited for longer than GATHER_QUIET_MS after the last one.
        if (quietTimer !== null) timers.clear(quietTimer);
        quietTimer = timers.set(go, GATHER_QUIET_MS);
      };
      gatherTimer = timers.set(go, deps.gatherMs ?? GATHER_TIMEOUT_MS);
    };
    const theirs = async (m: SignalMessage): Promise<void> => {
      if (m.t === 'bye') return fail('left', 'the other side left');
      const expected = offering ? 'answer' : 'offer';
      if (m.t !== expected || received) return; // out of place: ignored
      received = true;
      clearTimer();
      try {
        await pc.setRemoteDescription({ type: m.t, sdp: m.sdp });
      } catch (e) {
        return fail('bad_code', `the other side's description cannot be used: ${describe(e)}`);
      }
      if (done) return;
      if (!offering) {
        try {
          await pc.setLocalDescription(await pc.createAnswer());
        } catch (e) {
          return fail('ice', `cannot answer: ${describe(e)}`);
        }
        if (done) return;
        sendDescription('answer');
        return;
      }
      settled();
    };

    r.onopen = opened;
    u.onopen = opened;
    r.onclose = () => fail('ice', 'the connection closed while opening');
    u.onclose = () => fail('ice', 'the connection closed while opening');
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') fail('ice', 'ICE failed');
    };
    path.onEnd = (reason) => {
      if (!exchanged) fail(reason, reason === 'left' ? 'the other side left' : 'the signalling service went away');
    };
    path.onMessage = (m) => void theirs(m);
    if (done) return;
    if (offering) {
      void (async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
        } catch (e) {
          return fail('ice', `cannot make an offer: ${describe(e)}`);
        }
        if (!done) sendDescription('offer');
      })();
    } else if (!received) {
      wait(patienceMs, 'no_answer', 'the other side sent nothing');
    }
  });
}

/**
 * A guest's connection to the host of room `code`: rejects with a DialError. `onDialled` is called
 * when the signalling found the room and the handshake with the host starts (the page shows the stage).
 */
export async function joinRoom(signaller: Signaller, code: string, deps: ConnectDeps, onDialled?: () => void): Promise<WebRtcTransport> {
  const path = await signaller.dial(code);
  onDialled?.();
  return connectPeer(path, 'guest', signaller.patienceMs, deps);
}

/**
 * The host's end of a room: listens on a signaller and makes a connection for every guest that
 * knocks; each open one goes to onGuest (the page forwards it to its server Worker). At most
 * MAX_PENDING_HANDSHAKES at once; more are turned away (their paths closed).
 */
export class RoomListener {
  /** A guest's connection opened. */
  onGuest: ((t: WebRtcTransport) => void) | null = null;
  /** A guest's handshake failed (for the page's log). */
  onGuestFailed: ((e: DialError) => void) | null = null;
  private pending = 0;
  private closed = false;

  constructor(
    readonly signaller: Signaller,
    private readonly deps: ConnectDeps,
  ) {}

  /** Handshakes under way. */
  get handshakes(): number {
    return this.pending;
  }

  /** Listen on `code`: rejects with the signaller's DialError. */
  open(code: string): Promise<void> {
    this.closed = false;
    return this.signaller.listen(code, (path) => this.accept(path));
  }

  /** Stop taking guests (connections already open are not affected; a handshake under way ends with its connection closed). */
  close(): void {
    this.closed = true;
    this.signaller.close();
  }

  private accept(path: SignalPath): void {
    if (this.closed || this.pending >= MAX_PENDING_HANDSHAKES) {
      path.close();
      return;
    }
    this.pending++;
    connectPeer(path, 'host', this.signaller.patienceMs, this.deps).then(
      (t) => {
        this.pending--;
        if (this.closed) t.close('room closed');
        else if (this.onGuest !== null) this.onGuest(t);
        else t.close('nobody takes guests');
      },
      (e: unknown) => {
        this.pending--;
        this.onGuestFailed?.(e instanceof DialError ? e : new DialError('ice', describe(e)));
      },
    );
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // already closed
  }
}
