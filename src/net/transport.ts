/**
 * The transport under the multiplayer protocol (docs/NETCODE.md section 2).
 *
 * One transport message is one protocol message: the first byte is the message id, the rest the
 * payload, no length prefix (the transport keeps message boundaries). Two channels share one
 * connection: RELIABLE (nothing lost, in order) and UNRELIABLE (may be lost or reordered; a
 * transport may deliver it reliably, the protocol never depends on loss).
 *
 * Implementations: LoopbackNet (loopback.ts, tests), PortTransport (package 8, a MessagePort to the
 * server Worker), WebRtcTransport (package 10).
 */

/** Reliable, ordered. */
export const RELIABLE = 0;
/** Unreliable, may arrive out of order. */
export const UNRELIABLE = 1;
export type Channel = typeof RELIABLE | typeof UNRELIABLE;

export interface Transport {
  /** True until either end closes the connection (or it fails). */
  readonly open: boolean;
  /**
   * Send one message. `bytes` is copied or transferred: the caller may reuse it once this returns.
   * Throws a RangeError when an UNRELIABLE message is longer than MAX_UNRELIABLE_BYTES or a
   * RELIABLE one longer than MAX_RELIABLE_BYTES (a caller bug). Does nothing once closed.
   */
  send(channel: Channel, bytes: Uint8Array): void;
  /** Bytes handed to send() on `channel` that have not gone out into the network yet (backpressure). */
  bufferedBytes(channel: Channel): number;
  /**
   * Close the connection. The other end's onClose receives `reason` once the reliable messages
   * already sent have reached it; this end's onClose is not called (the caller knows).
   */
  close(reason?: string): void;
  /** A message arrived. The receiver owns `bytes`. */
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null;
  /** The other end closed the connection, or the connection failed. Called at most once. */
  onClose: ((reason: string) => void) | null;
}
