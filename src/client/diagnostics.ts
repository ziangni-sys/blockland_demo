/**
 * Connection diagnostics (package 11): a short text block the owner can paste back when a real
 * two-machine test goes wrong. What is in it: the build, the page's role, the signalling, for each
 * WebRTC link the ICE candidate pair in use with its candidate types (host, srflx, prflx, relay)
 * and transport protocol, round-trip times, sample loss, the interpolation delay, bytes per second
 * each way, the server's TPS and the last connection error; on the host, one line per guest
 * ("guest 1", "guest 2" in the order of the player table) with that guest's link and what the
 * server measures of it (bytes sent a second, backlog, the guest's round trip). What is never in
 * it: names, player
 * keys, room or invitation codes, IP addresses or ports (the pair's types say what kind of path it
 * is, which is what matters).
 *
 * A guest whose join failed has no link left: the text then says how far its last dial got (the
 * failure code, the candidate types each side offered, whether the descriptions crossed, the ICE
 * states when it failed).
 *
 * Pure functions: the page gathers RTCStatsReports (WebRtcTransport.stats(), twice one second
 * apart for the rates) and its own numbers, and formats them here.
 */

import type { IceAttempt } from '../net/webrtc/signal';

/** The selected ICE candidate pair of one link, without addresses. */
export interface PairInfo {
  /** Candidate types: 'host' | 'srflx' | 'prflx' | 'relay' (or '?' when the browser does not say). */
  local: string;
  remote: string;
  /** 'udp' / 'tcp', or '?'. */
  protocol: string;
  /** The pair's current round-trip time (ms), or null. */
  rttMs: number | null;
  bytesSent: number;
  bytesReceived: number;
}

/** A stats entry as browsers give them (only the fields read here). */
interface StatsEntry {
  id?: string;
  type?: string;
  selectedCandidatePairId?: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  protocol?: string;
  currentRoundTripTime?: number;
  bytesSent?: number;
  bytesReceived?: number;
}

/** What pairFromStats needs of an RTCStatsReport (a maplike of entries). */
export interface StatsLike {
  forEach(fn: (value: unknown) => void): void;
}

/**
 * The candidate pair in use: the transport's selectedCandidatePairId (Chromium, Safari), else the
 * pair marked `selected` (Firefox), else a nominated succeeded pair. Null when there is none.
 */
export function pairFromStats(report: StatsLike): PairInfo | null {
  const byId = new Map<string, StatsEntry>();
  const entries: StatsEntry[] = [];
  report.forEach((v) => {
    if (v === null || typeof v !== 'object') return;
    const e = v as StatsEntry;
    entries.push(e);
    if (typeof e.id === 'string') byId.set(e.id, e);
  });
  let pair: StatsEntry | undefined;
  for (const e of entries) {
    if (e.type === 'transport' && typeof e.selectedCandidatePairId === 'string') pair = byId.get(e.selectedCandidatePairId);
    if (pair !== undefined) break;
  }
  pair ??= entries.find((e) => e.type === 'candidate-pair' && e.selected === true);
  pair ??= entries.find((e) => e.type === 'candidate-pair' && e.nominated === true && e.state === 'succeeded');
  if (pair === undefined) return null;
  const local = pair.localCandidateId !== undefined ? byId.get(pair.localCandidateId) : undefined;
  const remote = pair.remoteCandidateId !== undefined ? byId.get(pair.remoteCandidateId) : undefined;
  const rtt = pair.currentRoundTripTime;
  return {
    local: kindOf(local?.candidateType),
    remote: kindOf(remote?.candidateType),
    protocol: kindOf(local?.protocol),
    rttMs: typeof rtt === 'number' && Number.isFinite(rtt) ? rtt * 1000 : null,
    bytesSent: finite(pair.bytesSent),
    bytesReceived: finite(pair.bytesReceived),
  };
}

/** Only short lowercase words pass (never an address that a browser put in an odd field). */
function kindOf(v: string | undefined): string {
  return typeof v === 'string' && /^[a-z]{1,8}$/.test(v) ? v : '?';
}

function finite(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** One WebRTC link as measured: the pair now, and the byte rates over the sampling interval. */
export interface LinkReport {
  pair: PairInfo | null;
  /** Bytes per second sent / received over the link (from two samples of the pair), or null. */
  outPerSec: number | null;
  inPerSec: number | null;
}

/** Two samples of a link's pair `ms` apart as a LinkReport. */
export function linkReport(before: PairInfo | null, after: PairInfo | null, ms: number): LinkReport {
  const same = before !== null && after !== null && ms > 0;
  return {
    pair: after,
    outPerSec: same ? Math.max(0, ((after.bytesSent - before.bytesSent) * 1000) / ms) : null,
    inPerSec: same ? Math.max(0, ((after.bytesReceived - before.bytesReceived) * 1000) / ms) : null,
  };
}

/** What the host's server reports of one guest's connection (host control `status`). */
export interface GuestServerReport {
  bytesPerSec: number;
  backlogBytes: number;
  /** 0 until the guest's client reported one. */
  rttMs: number;
}

/** One guest as the host sees it: its WebRTC link (null when it has none, e.g. a dev bot) and the server's numbers (null before the first report). */
export interface GuestReport {
  link: LinkReport | null;
  server: GuestServerReport | null;
}

export interface DiagnosticsInput {
  build: string;
  /** null: no world open. */
  role: 'host' | 'guest' | null;
  /** The signalling of the room or the join, or null (a host whose room was never opened). */
  signal: 'cloud' | 'broadcast' | 'manual' | null;
  /** Host: whether the room takes new guests now; null for a guest. */
  roomOpen: boolean | null;
  /** A guest's one link to the host (null when it has none); unused for a host. */
  link: LinkReport | null;
  /** The host's guests, in the order of the player table; empty for a guest. */
  guests: GuestReport[];
  /** This client's game connection: Ping round trip (ms), sample loss (0..1), interpolation delay D (ticks). */
  rttMs: number | null;
  loss: number | null;
  delayTicks: number | null;
  /** This client's game traffic (bytes per second), or null. */
  inPerSec: number | null;
  outPerSec: number | null;
  serverTps: number | null;
  /** The NetClient's status. */
  netStatus: string | null;
  lastError: string | null;
  /** A guest's last failed dial: its failure code and how far the WebRTC handshake got (null when it failed before one). */
  dialFailure: { code: string; attempt: IceAttempt | null } | null;
}

function num(v: number | null, digits: number, unit = ''): string {
  return v === null || !Number.isFinite(v) ? '-' : `${v.toFixed(digits)}${unit}`;
}

function bytes(v: number): string {
  return v >= 1024 ? `${(v / 1024).toFixed(1)} KB` : `${Math.round(v)} B`;
}

function rate(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '-' : `${bytes(v)}/s`;
}

function linkText(l: LinkReport | null): string {
  if (l === null) return 'no webrtc link';
  const p = l.pair;
  const path = p === null ? 'no candidate pair yet' : `${p.local} -> ${p.remote} (${p.protocol}), rtt ${num(p.rttMs, 0, ' ms')}`;
  return `${path}; out ${rate(l.outPerSec)}, in ${rate(l.inPerSec)}`;
}

function serverText(s: GuestServerReport | null): string {
  if (s === null) return 'server: no report yet';
  return `server sends ${rate(s.bytesPerSec)}, backlog ${bytes(s.backlogBytes)}, rtt ${s.rttMs > 0 ? `${Math.round(s.rttMs)} ms` : '-'}`;
}

/** The text block (English: it is pasted into a bug report, not read in the game). */
export function diagnosticsText(d: DiagnosticsInput): string {
  const lines = ['Blocklands connection diagnostics', `build: ${d.build}`];
  const n = d.guests.length;
  lines.push(`role: ${d.role ?? 'none'}${d.role === 'host' ? ` (room ${d.roomOpen ? 'open' : 'closed'}, ${n} guest${n === 1 ? '' : 's'})` : ''}`);
  lines.push(`signalling: ${d.signal ?? '-'}`);
  if (d.role === 'host') d.guests.forEach((g, i) => lines.push(`guest ${i + 1}: ${linkText(g.link)}; ${serverText(g.server)}`));
  else lines.push(`webrtc host: ${d.link === null ? 'no link' : linkText(d.link)}`);
  lines.push(`game rtt: ${num(d.rttMs, 0, ' ms')}, loss: ${d.loss === null ? '-' : `${(d.loss * 100).toFixed(1)} %`}, interpolation delay: ${num(d.delayTicks, 2, ' ticks')}`);
  lines.push(`game traffic: in ${rate(d.inPerSec)}, out ${rate(d.outPerSec)}`);
  lines.push(`server tps: ${num(d.serverTps, 1)}`);
  lines.push(`connection: ${d.netStatus ?? '-'}`);
  lines.push(`last error: ${d.lastError ?? 'none'}`);
  if (d.dialFailure !== null) lines.push(`last dial: ${word(d.dialFailure.code)}; ${attemptText(d.dialFailure.attempt)}`);
  return lines.join('\n');
}

/** A browser state or failure code: only short lowercase words pass. */
function word(v: string): string {
  return /^[a-z_-]{1,16}$/.test(v) ? v : '?';
}

function attemptText(a: IceAttempt | null): string {
  if (a === null) return 'no webrtc handshake (the signalling failed first)';
  const types = (t: string): string => (/^(none|-|[a-z]{1,8} \d+(, [a-z]{1,8} \d+)*)$/.test(t) ? t : '?');
  return (
    `candidates: ours ${types(a.local)}, theirs ${types(a.remote)}; descriptions: ours ${a.sent ? 'sent' : 'not sent'}, theirs ${a.received ? 'received' : 'not received'}; ` +
    `ice gathering ${word(a.gathering)}, connection ${word(a.connection)}`
  );
}
