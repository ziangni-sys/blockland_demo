/**
 * Connection diagnostics (package 11): a short text block the owner can paste back when a real
 * two-machine test goes wrong. What is in it: the build, the page's role, the signalling, for each
 * WebRTC link the ICE candidate pair in use with its candidate types (host, srflx, prflx, relay)
 * and transport protocol, round-trip times, sample loss, the interpolation delay, bytes per second
 * each way, the server's TPS and the last connection error. What is never in it: names, player
 * keys, room or invitation codes, IP addresses or ports (the pair's types say what kind of path it
 * is, which is what matters).
 *
 * Pure functions: the page gathers RTCStatsReports (WebRtcTransport.stats(), twice one second
 * apart for the rates) and its own numbers, and formats them here.
 */

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

export interface DiagnosticsInput {
  build: string;
  /** null: no world open. */
  role: 'host' | 'guest' | null;
  /** The signalling of the room or the join, or null (a host whose room was never opened). */
  signal: 'cloud' | 'broadcast' | 'manual' | null;
  /** Host: whether the room takes new guests now; null for a guest. */
  roomOpen: boolean | null;
  /** The WebRTC links: the guest's one link to the host, or the host's link to each guest. */
  links: LinkReport[];
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
}

function num(v: number | null, digits: number, unit = ''): string {
  return v === null || !Number.isFinite(v) ? '-' : `${v.toFixed(digits)}${unit}`;
}

function rate(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '-';
  return v >= 1024 ? `${(v / 1024).toFixed(1)} KB/s` : `${Math.round(v)} B/s`;
}

/** The text block (English: it is pasted into a bug report, not read in the game). */
export function diagnosticsText(d: DiagnosticsInput): string {
  const lines = ['Blocklands connection diagnostics', `build: ${d.build}`];
  lines.push(`role: ${d.role ?? 'none'}${d.role === 'host' ? ` (room ${d.roomOpen ? 'open' : 'closed'}, ${d.links.length} guest link${d.links.length === 1 ? '' : 's'})` : ''}`);
  lines.push(`signalling: ${d.signal ?? '-'}`);
  if (d.links.length === 0) lines.push('webrtc: no link');
  d.links.forEach((l, i) => {
    const name = d.role === 'host' ? `guest ${i + 1}` : 'host';
    const p = l.pair;
    const path = p === null ? 'no candidate pair yet' : `${p.local} -> ${p.remote} (${p.protocol}), rtt ${num(p.rttMs, 0, ' ms')}`;
    lines.push(`webrtc ${name}: ${path}; out ${rate(l.outPerSec)}, in ${rate(l.inPerSec)}`);
  });
  lines.push(`game rtt: ${num(d.rttMs, 0, ' ms')}, loss: ${d.loss === null ? '-' : `${(d.loss * 100).toFixed(1)} %`}, interpolation delay: ${num(d.delayTicks, 2, ' ticks')}`);
  lines.push(`game traffic: in ${rate(d.inPerSec)}, out ${rate(d.outPerSec)}`);
  lines.push(`server tps: ${num(d.serverTps, 1)}`);
  lines.push(`connection: ${d.netStatus ?? '-'}`);
  lines.push(`last error: ${d.lastError ?? 'none'}`);
  return lines.join('\n');
}
