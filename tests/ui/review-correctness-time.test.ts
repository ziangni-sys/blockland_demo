/**
 * Review (correctness lens): formatLastPlayed labels any save 24–48 h old as "yesterday" /
 * "昨天", which is a calendar statement. A save from 09:00 two days ago, viewed at 08:00
 * today, is 47 h old and was NOT played yesterday.
 */
import { describe, expect, it } from 'vitest';
import { formatLastPlayed } from '../../src/ui/format';

describe('review: "yesterday" means the previous calendar day', () => {
  it('a save from the day before yesterday is not labelled "yesterday"', () => {
    const now = new Date(2026, 10, 18, 8, 0, 0).getTime(); // Wed 18 Nov, 08:00 local
    const played = new Date(2026, 10, 16, 9, 0, 0).getTime(); // Mon 16 Nov, 09:00 local (47 h earlier)
    expect(formatLastPlayed(played, now, 'en')).not.toBe('yesterday');
    expect(formatLastPlayed(played, now, 'zh')).not.toBe('昨天');
  });

  it('guard for the fix: a save 46 h old that WAS on the previous calendar day stays "yesterday"', () => {
    const now = new Date(2026, 10, 18, 23, 0, 0).getTime(); // Wed 23:00
    const yesterdayMorning = new Date(2026, 10, 17, 1, 0, 0).getTime(); // Tue 01:00 (46 h earlier, still yesterday)
    expect(formatLastPlayed(yesterdayMorning, now, 'en')).toBe('yesterday');
  });
});
