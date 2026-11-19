/**
 * Number / time formatting and gauge geometry for the UI. Pure functions (no DOM, no clock:
 * "now" is always a parameter) so they are unit-tested in Node.
 */
import { t } from './i18n';
import type { GuestLink, Language } from './model';

/**
 * `text` (a player's name) isolated from the sentence around it (FSI ... PDI): a name in a
 * right-to-left script, or ending in neutral characters, keeps the sentence's order.
 */
export function isolate(text: string): string {
  return `\u2068${text}\u2069`;
}

/** U+2212 MINUS SIGN: same width as digits in most fonts, unlike the hyphen. */
const MINUS = String.fromCharCode(0x2212);

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Non-finite values (NaN from a 0/0 upstream) become 0 so the UI never prints "NaN". */
export function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** 0..1 ratio of value/max, safe for max <= 0. */
export function ratio(value: number, max: number): number {
  if (!(max > 0)) return 0;
  return clamp(finite(value) / max, 0, 1);
}

/**
 * Fixed-decimal number with a typographic minus, and without "-0.0" (which toFixed produces
 * for tiny negatives and which flickers on an instrument that hovers around zero).
 */
export function formatFixed(v: number, decimals: number): string {
  const s = finite(v).toFixed(decimals);
  if (/^-0(\.0+)?$/.test(s)) return s.slice(1);
  return s.startsWith('-') ? MINUS + s.slice(1) : s;
}

/** Ship speed in blocks/second, one decimal. */
export function formatSpeed(v: number): string {
  return formatFixed(v, 1);
}

/** Stack count badge: blank for single items and empty stacks. */
export function formatCount(n: number): string {
  return n > 1 ? String(Math.floor(n)) : '';
}

/** 0..1 -> "0%".."100%". */
export function formatPercent(p: number): string {
  return `${Math.round(clamp(finite(p), 0, 1) * 100)}%`;
}

export function formatFov(deg: number): string {
  return `${Math.round(finite(deg))}°`;
}

export function formatSensitivity(x: number): string {
  return `${finite(x).toFixed(2)}×`;
}

/** Throttle -1..1 -> signed percent, e.g. "+75%", "0%", "−50%". */
export function formatThrottle(throttle: number): string {
  const p = Math.round(clamp(finite(throttle), -1, 1) * 100);
  if (p === 0) return '0%';
  return p > 0 ? `+${p}%` : `${MINUS}${-p}%`;
}

/** Health shown as an integer: partial points round up so "alive" never reads 0. */
export function formatHealth(health: number, max: number): string {
  const h = Math.max(0, Math.ceil(finite(health) - 1e-6));
  return `${h}/${Math.max(0, Math.round(finite(max)))}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar date YYYY-MM-DD. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Local midnight of the calendar day that contains `ms`. */
function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Whole local calendar days from `from` to `to` (0 = same day, 1 = `from` was yesterday).
 * Rounded because a local day is 23 or 25 hours long across a DST change.
 */
export function calendarDaysBetween(from: number, to: number): number {
  return Math.round((localDayStart(to) - localDayStart(from)) / DAY);
}

/**
 * "Last played" label. Saves under a day old read as minutes / hours (even across midnight:
 * "2 h ago" at 01:00 says more than "yesterday"); older ones by calendar day ("yesterday"
 * really means the previous local date), then as a date after a week.
 * `lastPlayed` 0 (unknown) gives the localized "unknown". Timestamps slightly in the future
 * (clock skew between tabs) count as "just now".
 */
export function formatLastPlayed(lastPlayed: number, now: number, lang: Language): string {
  if (!(lastPlayed > 0)) return t(lang, 'time.unknown');
  const age = now - lastPlayed;
  if (age < MINUTE) return t(lang, 'time.justNow');
  if (age < HOUR) return t(lang, 'time.minutes', { n: Math.floor(age / MINUTE) });
  const days = calendarDaysBetween(lastPlayed, now);
  // days <= 0 with age >= 24 h only happens inside a 25-hour DST day.
  if (age < DAY || days <= 0) return t(lang, 'time.hours', { n: Math.floor(age / HOUR) });
  if (days === 1) return t(lang, 'time.yesterday');
  if (days < 7) return t(lang, 'time.days', { n: days });
  return formatDate(lastPlayed);
}

/** Number of segments of the vitality bar: one per 2 points, kept readable for odd maxima. */
export function healthSegments(maxHealth: number): number {
  return clamp(Math.round(finite(maxHealth) / 2), 4, 20);
}

/**
 * Fill fraction (0..1) of each segment of a segmented gauge. Written into `out` (reused by
 * the caller between frames) and returned.
 */
export function segmentFills(value: number, max: number, segments: number, out: number[] = []): number[] {
  const n = Math.max(0, Math.floor(segments));
  out.length = n;
  const filled = ratio(value, max) * n;
  for (let i = 0; i < n; i++) out[i] = clamp(filled - i, 0, 1);
  return out;
}

/**
 * Quantize a 0..1 fraction to `steps` levels. The HUD only touches the DOM when the quantized
 * value changes, so an instrument fed a slowly drifting float does not restyle every frame.
 */
export function quantize(v: number, steps: number): number {
  return Math.round(clamp(finite(v), 0, 1) * steps) / steps;
}

/** Rudder -1..1 -> needle angle in degrees (port negative). */
export const RUDDER_MAX_DEG = 40;
export function rudderAngle(rudder: number): number {
  return Math.round(clamp(finite(rudder), -1, 1) * RUDDER_MAX_DEG * 2) / 2;
}

/** Throttle -1..1 -> lever position 0 (bottom, full astern) .. 1 (top, full ahead). */
export function throttleLever(throttle: number): number {
  return quantize((clamp(finite(throttle), -1, 1) + 1) / 2, 200);
}

/** Engine-telegraph notch the lever reads as, top to bottom. */
export type ThrottleNotch = 'full' | 'half' | 'stop' | 'halfAstern' | 'astern';

/** |throttle| below this reads as Stop: the screw is effectively idle. */
export const THROTTLE_STOP_BAND = 0.05;

/**
 * Notch to emphasise on the telegraph. Direction comes first: any real astern throttle lights
 * an astern notch (a nearest-notch rule would show "Stop" while the ship is backing at 40 %),
 * then magnitude picks half or full.
 */
export function throttleNotch(throttle: number): ThrottleNotch {
  const v = clamp(finite(throttle), -1, 1);
  if (Math.abs(v) < THROTTLE_STOP_BAND) return 'stop';
  if (v > 0) return v >= 0.75 ? 'full' : 'half';
  return v <= -0.75 ? 'astern' : 'halfAstern';
}

/**
 * SVG stroke-dasharray for an arc gauge of total sweep `sweep` (fraction of the full circle)
 * filled to `fill` (0..1), on a circle of circumference `circ`.
 */
export function arcDash(fill: number, sweep: number, circ: number): string {
  const len = clamp(finite(fill), 0, 1) * sweep * circ;
  return `${len.toFixed(2)} ${circ.toFixed(2)}`;
}

/** A byte count, short: "820 B", "4.3 KB", "1.2 MB". */
export function formatBytes(n: number): string {
  const v = Math.max(0, finite(n));
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/** A guest's connection on the host's list: what the server sends a second, the backlog, the round trip. */
export function formatGuestLink(g: GuestLink, lang: Language): string {
  return t(lang, 'room.traffic', { rate: formatBytes(g.bytesPerSec), backlog: formatBytes(g.backlogBytes), rtt: g.rttMs > 0 ? `${Math.round(g.rttMs)}` : '–' });
}
