import { describe, expect, it } from 'vitest';
import {
  arcDash,
  calendarDaysBetween,
  clamp,
  formatCount,
  formatDate,
  formatFixed,
  formatFov,
  formatHealth,
  formatLastPlayed,
  formatPercent,
  formatSensitivity,
  formatSpeed,
  formatThrottle,
  healthSegments,
  quantize,
  ratio,
  RUDDER_MAX_DEG,
  rudderAngle,
  segmentFills,
  throttleLever,
  throttleNotch,
} from '../../src/ui/format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('number formatting', () => {
  it('formats fixed decimals with a typographic minus and no negative zero', () => {
    expect(formatFixed(3.14159, 1)).toBe('3.1');
    expect(formatFixed(-2.5, 1)).toBe('−2.5');
    expect(formatFixed(-0.04, 1)).toBe('0.0');
    expect(formatFixed(-0.0001, 2)).toBe('0.00');
    expect(formatFixed(-0, 0)).toBe('0');
    expect(formatFixed(Number.NaN, 1)).toBe('0.0');
    expect(formatFixed(Number.POSITIVE_INFINITY, 1)).toBe('0.0');
  });

  it('formats ship speed with one decimal', () => {
    expect(formatSpeed(0)).toBe('0.0');
    expect(formatSpeed(4.26)).toBe('4.3');
    expect(formatSpeed(-1.5)).toBe('−1.5');
    expect(formatSpeed(-0.01)).toBe('0.0');
  });

  it('hides counts of single items and empty stacks', () => {
    expect(formatCount(0)).toBe('');
    expect(formatCount(1)).toBe('');
    expect(formatCount(2)).toBe('2');
    expect(formatCount(64)).toBe('64');
    expect(formatCount(-3)).toBe('');
  });

  it('formats percentages, clamped', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.425)).toBe('43%');
    expect(formatPercent(1.7)).toBe('100%');
    expect(formatPercent(-1)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });

  it('formats settings readouts', () => {
    expect(formatFov(75.4)).toBe('75°');
    expect(formatSensitivity(1)).toBe('1.00×');
    expect(formatSensitivity(0.25)).toBe('0.25×');
  });

  it('formats throttle as a signed percentage', () => {
    expect(formatThrottle(0)).toBe('0%');
    expect(formatThrottle(0.004)).toBe('0%');
    expect(formatThrottle(0.75)).toBe('+75%');
    expect(formatThrottle(-0.5)).toBe('−50%');
    expect(formatThrottle(3)).toBe('+100%');
  });

  it('formats health so a living player never reads 0', () => {
    expect(formatHealth(20, 20)).toBe('20/20');
    expect(formatHealth(13.5, 20)).toBe('14/20');
    expect(formatHealth(0.2, 20)).toBe('1/20');
    expect(formatHealth(0, 20)).toBe('0/20');
    expect(formatHealth(-4, 20)).toBe('0/20');
    // Floating-point noise just above an integer does not round up.
    expect(formatHealth(14 + 1e-9, 20)).toBe('14/20');
  });

  it('clamp and ratio are safe', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(ratio(5, 10)).toBe(0.5);
    expect(ratio(5, 0)).toBe(0);
    expect(ratio(20, 10)).toBe(1);
    expect(ratio(Number.NaN, 10)).toBe(0);
  });
});

describe('last-played labels', () => {
  // Built from local time so the calendar-day rules hold in any test-runner time zone.
  const local = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m, 0).getTime();
  const now = local(17, 12); // Tue 17 Nov, 12:00 local

  it('uses relative times for recent saves in both languages', () => {
    expect(formatLastPlayed(now - 10_000, now, 'zh')).toBe('刚刚');
    expect(formatLastPlayed(now - 10_000, now, 'en')).toBe('just now');
    expect(formatLastPlayed(now - 5 * MIN, now, 'zh')).toBe('5 分钟前');
    expect(formatLastPlayed(now - 5 * MIN, now, 'en')).toBe('5 min ago');
    expect(formatLastPlayed(now - 3 * HOUR - 59 * MIN, now, 'en')).toBe('3 h ago');
    expect(formatLastPlayed(now - DAY - HOUR, now, 'zh')).toBe('昨天');
    expect(formatLastPlayed(now - 3 * DAY, now, 'en')).toBe('3 days ago');
  });

  it('says "yesterday" only for the previous calendar day', () => {
    // 47 h old but from the day before yesterday (review finding): two days ago.
    expect(formatLastPlayed(local(16, 9), local(18, 8), 'en')).toBe('2 days ago');
    expect(formatLastPlayed(local(16, 9), local(18, 8), 'zh')).toBe('2 天前');
    // 46 h old and still on the previous calendar day: yesterday.
    expect(formatLastPlayed(local(17, 1), local(18, 23), 'en')).toBe('yesterday');
    // 27 h old across two midnights: Monday seen on Wednesday.
    expect(formatLastPlayed(local(16, 22), local(18, 1), 'en')).toBe('2 days ago');
    // Under 24 h reads as hours even across midnight.
    expect(formatLastPlayed(local(16, 23), local(17, 1, 30), 'en')).toBe('2 h ago');
    expect(formatLastPlayed(local(16, 20), local(17, 19), 'en')).toBe('23 h ago');
  });

  it('counts calendar days for older saves', () => {
    expect(calendarDaysBetween(local(10, 23), local(17, 0, 30))).toBe(7);
    expect(formatLastPlayed(local(11, 23), local(17, 1), 'en')).toBe('6 days ago');
    expect(formatLastPlayed(local(10, 23), local(17, 1), 'en')).toBe(formatDate(local(10, 23)));
    expect(calendarDaysBetween(local(17, 0), local(17, 23, 59))).toBe(0);
  });

  it('uses a calendar date after a week', () => {
    const t = now - 30 * DAY;
    expect(formatLastPlayed(t, now, 'en')).toBe(formatDate(t));
    expect(formatDate(t)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('handles unknown and future timestamps', () => {
    expect(formatLastPlayed(0, now, 'zh')).toBe('未知');
    expect(formatLastPlayed(0, now, 'en')).toBe('unknown');
    expect(formatLastPlayed(now + 5000, now, 'en')).toBe('just now');
  });

  it('pads calendar dates', () => {
    const d = new Date(2026, 0, 5, 10, 0, 0).getTime();
    expect(formatDate(d)).toBe('2026-01-05');
  });
});

describe('gauge geometry', () => {
  it('derives a readable segment count from max health', () => {
    expect(healthSegments(20)).toBe(10);
    expect(healthSegments(10)).toBe(5);
    expect(healthSegments(2)).toBe(4);
    expect(healthSegments(100)).toBe(20);
    expect(healthSegments(Number.NaN)).toBe(4);
  });

  it('fills segments proportionally, partial segment included', () => {
    expect(segmentFills(20, 20, 10)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(segmentFills(14, 20, 10)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
    const f = segmentFills(13, 20, 10);
    expect(f.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(f[6]).toBeCloseTo(0.5);
    expect(f[7]).toBe(0);
    expect(segmentFills(0, 20, 10).every((v) => v === 0)).toBe(true);
    expect(segmentFills(5, 0, 3)).toEqual([0, 0, 0]);
  });

  it('reuses the output array', () => {
    const out = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
    const r = segmentFills(10, 20, 4, out);
    expect(r).toBe(out);
    expect(r).toEqual([1, 1, 0, 0]);
  });

  it('quantizes to the requested number of steps', () => {
    expect(quantize(0.333, 10)).toBeCloseTo(0.3);
    expect(quantize(0.36, 10)).toBeCloseTo(0.4);
    expect(quantize(1.4, 10)).toBe(1);
    expect(quantize(-1, 10)).toBe(0);
  });

  it('maps rudder to a needle angle in half-degree steps', () => {
    expect(rudderAngle(0)).toBe(0);
    expect(rudderAngle(1)).toBe(RUDDER_MAX_DEG);
    expect(rudderAngle(-1)).toBe(-RUDDER_MAX_DEG);
    expect(rudderAngle(5)).toBe(RUDDER_MAX_DEG);
    expect((rudderAngle(0.123) * 2) % 1).toBe(0);
  });

  it('reads the telegraph notch by direction first, then magnitude', () => {
    // Backing at 40 % must not read "Stop" (review finding), nor at 6 %.
    expect(throttleNotch(-0.4)).toBe('halfAstern');
    expect(throttleNotch(-0.06)).toBe('halfAstern');
    expect(throttleNotch(-0.75)).toBe('astern');
    expect(throttleNotch(-1)).toBe('astern');
    expect(throttleNotch(-0.03)).toBe('stop');
    expect(throttleNotch(0)).toBe('stop');
    expect(throttleNotch(0.04)).toBe('stop');
    expect(throttleNotch(0.2)).toBe('half');
    expect(throttleNotch(0.74)).toBe('half');
    expect(throttleNotch(0.75)).toBe('full');
    expect(throttleNotch(3)).toBe('full');
    expect(throttleNotch(Number.NaN)).toBe('stop');
  });

  it('maps throttle to a lever position (top = full ahead)', () => {
    expect(throttleLever(1)).toBe(1);
    expect(throttleLever(0)).toBe(0.5);
    expect(throttleLever(-1)).toBe(0);
    expect(throttleLever(0.5)).toBe(0.75);
  });

  it('builds arc dash arrays', () => {
    const circ = 100;
    expect(arcDash(1, 0.75, circ)).toBe('75.00 100.00');
    expect(arcDash(0.5, 0.75, circ)).toBe('37.50 100.00');
    expect(arcDash(2, 0.75, circ)).toBe('75.00 100.00');
    expect(arcDash(-1, 0.75, circ)).toBe('0.00 100.00');
  });
});
