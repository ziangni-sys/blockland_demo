/**
 * ManualSignaller (signal.ts): no service at all. The person copies the codes: the host's page
 * makes an invitation code (its offer, every candidate inside), the guest pastes it and gets an
 * answer code, the host pastes that back. The fallback when the public service is down or
 * blocked. One invitation is one guest.
 *
 * CODES. `BL1I.` (invitation) or `BL1A.` (answer), then base64url of the JSON { i, s }: `i` is the
 * invitation's random id (an answer goes back to its own invitation), `s` the description. About
 * 1.5 to 5 KB of text. A code that does not decode, or an answer to no open invitation:
 * DialError 'bad_code'.
 *
 * Host: listen() takes guests as usual; invite() starts one (the page's RoomListener makes the
 * offer over the path) and resolves with the invitation code; accept(answer) finishes it.
 * Guest: dial(invitation) gives the path that holds the host's offer; the answer code comes out
 * through onAnswer once the guest's page has made it. A person takes minutes: patienceMs is long.
 */
import { DialError, MAX_SDP_LENGTH, randomHex, RelayPath, type SignalMessage, type SignalPath, type Signaller } from './signal';

/** One side waits this long for the other's code, ms. */
export const MANUAL_PATIENCE_MS = 15 * 60_000;
const INVITE_PREFIX = 'BL1I.';
const ANSWER_PREFIX = 'BL1A.';

export interface ManualOptions {
  random(bytes: Uint8Array<ArrayBuffer>): void;
}

interface Invitation {
  path: RelayPath;
  /** Resolves invite() with the code once the offer is made. */
  resolve: (code: string) => void;
  reject: (e: DialError) => void;
  coded: boolean;
}

export class ManualSignaller implements Signaller {
  readonly kind = 'manual';
  readonly patienceMs = MANUAL_PATIENCE_MS;
  onLost: (() => void) | null = null;
  /** Guest: the answer code to give the host. */
  onAnswer: ((code: string) => void) | null = null;
  /** The last answer code made (guest). */
  answer: string | null = null;
  private onGuest: ((path: SignalPath) => void) | null = null;
  private readonly invitations = new Map<string, Invitation>();

  constructor(private readonly o: ManualOptions) {}

  listen(_code: string, onGuest: (path: SignalPath) => void): Promise<void> {
    this.onGuest = onGuest;
    return Promise.resolve();
  }

  /** Host: a new invitation; resolves with its code (rejects when the handshake fails before the offer is made). */
  invite(): Promise<string> {
    const onGuest = this.onGuest;
    if (onGuest === null) return Promise.reject(new DialError('unreachable', 'the room is not open'));
    const id = randomHex(this.o.random, 6);
    return new Promise((resolve, reject) => {
      const inv: Invitation = {
        resolve,
        reject,
        coded: false,
        path: new RelayPath(
          'host',
          (m) => {
            if (m.t !== 'offer' || inv.coded) return;
            inv.coded = true;
            resolve(encodeCode(INVITE_PREFIX, id, m.sdp));
          },
          () => {
            this.invitations.delete(id);
            if (!inv.coded) reject(new DialError('ice', 'the invitation could not be made'));
          },
        ),
      };
      this.invitations.set(id, inv);
      onGuest(inv.path);
    });
  }

  /** Host: the guest's answer code to the invitation it belongs to. Throws DialError('bad_code'). */
  accept(code: string): void {
    const d = decodeCode(ANSWER_PREFIX, code);
    const inv = d === null ? undefined : this.invitations.get(d.i);
    if (d === null || inv === undefined || !inv.coded) throw new DialError('bad_code', 'not an answer to an open invitation');
    inv.path.deliver({ t: 'answer', sdp: d.s });
  }

  /** Invitations made and not answered yet. */
  get open(): number {
    return this.invitations.size;
  }

  dial(code: string): Promise<SignalPath> {
    const d = decodeCode(INVITE_PREFIX, code);
    if (d === null) return Promise.reject(new DialError('bad_code', 'not an invitation code'));
    const path = new RelayPath(
      'host',
      (m: SignalMessage) => {
        if (m.t !== 'answer') return;
        const answer = encodeCode(ANSWER_PREFIX, d.i, m.sdp);
        this.answer = answer;
        this.onAnswer?.(answer);
      },
      () => undefined,
    );
    path.deliver({ t: 'offer', sdp: d.s });
    return Promise.resolve(path);
  }

  /** Stop: open invitations end. */
  close(): void {
    this.onGuest = null;
    for (const inv of [...this.invitations.values()]) inv.path.end('left');
  }
}

/** A code: prefix + base64url(JSON {i, s}). */
export function encodeCode(prefix: string, id: string, sdp: string): string {
  return prefix + base64url(new TextEncoder().encode(JSON.stringify({ i: id, s: sdp })));
}

/** The id and description of a code with `prefix` (whitespace ignored), or null. */
export function decodeCode(prefix: string, code: string): { i: string; s: string } | null {
  const text = code.replace(/\s+/g, '');
  if (!text.startsWith(prefix) || text.length > prefix.length + 2 * MAX_SDP_LENGTH) return null;
  const bytes = unbase64url(text.slice(prefix.length));
  if (bytes === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.i !== 'string' || !/^[0-9a-f]{1,32}$/.test(o.i) || typeof o.s !== 'string' || o.s.length === 0 || o.s.length > MAX_SDP_LENGTH) return null;
  return { i: o.i, s: o.s };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) s += B64[n & 63]!;
  }
  return s;
}

function unbase64url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    const k = Math.min(4, s.length - i);
    for (let j = 0; j < 4; j++) {
      const c = j < k ? B64.indexOf(s[i + j]!) : 0;
      if (c < 0) return null;
      n = (n << 6) | c;
    }
    out[o++] = (n >> 16) & 255;
    if (k > 2) out[o++] = (n >> 8) & 255;
    if (k > 3) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}
