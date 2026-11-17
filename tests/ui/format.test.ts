import { describe, expect, it } from 'vitest';
import {
  arcDash,
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
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);

  it('uses relative times for recent saves in both languages', () => {
    expect(formatLastPlayed(now - 10_000, now, 'zh')).toBe('刚刚');
    expect(formatLastPlayed(now - 10_000, now, 'en')).toBe('just now');
    expect(formatLastPlayed(now - 5 * MIN, now, 'zh')).toBe('5 分钟前');
    expect(formatLastPlayed(now - 5 * MIN, now, 'en')).toBe('5 min ago');
    expect(formatLastPlayed(now - 3 * HOUR - 59 * MIN, now, 'en')).toBe('3 h ago');
    expect(formatLastPlayed(now - DAY - HOUR, now, 'zh')).toBe('昨天');
    expect(formatLastPlayed(now - 3 * DAY, now, 'en')).toBe('3 days ago');
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
