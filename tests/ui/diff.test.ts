import { describe, expect, it } from 'vitest';
import { diffKeyed, helmEq, Memo, sameItem, settingsEq, slotEq, slotsEq, stringsEq, worldsEq } from '../../src/ui/diff';
import { DEFAULT_SETTINGS, type WorldSummary } from '../../src/ui/model';

describe('slot equality', () => {
  it('compares by value and treats null/undefined as empty', () => {
    expect(slotEq(null, null)).toBe(true);
    expect(slotEq(null, undefined)).toBe(true);
    expect(slotEq({ item: 1, count: 2 }, { item: 1, count: 2 })).toBe(true);
    expect(slotEq({ item: 1, count: 2 }, { item: 1, count: 3 })).toBe(false);
    expect(slotEq({ item: 1, count: 2 }, { item: 2, count: 2 })).toBe(false);
    expect(slotEq({ item: 1, count: 2 }, null)).toBe(false);
  });

  it('sameItem ignores counts', () => {
    expect(sameItem({ item: 4, count: 1 }, { item: 4, count: 60 })).toBe(true);
    expect(sameItem({ item: 4, count: 1 }, null)).toBe(false);
    expect(sameItem(null, undefined)).toBe(true);
  });

  it('compares slot arrays element-wise', () => {
    const a = [{ item: 1, count: 1 }, null, { item: 3, count: 5 }];
    expect(slotsEq(a, a.map((s) => (s ? { ...s } : null)))).toBe(true);
    expect(slotsEq(a, [a[0]!, null])).toBe(false);
    expect(slotsEq(a, [a[0]!, null, { item: 3, count: 4 }])).toBe(false);
  });

  it('compares string arrays', () => {
    expect(stringsEq(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(stringsEq(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(stringsEq(['a'], null)).toBe(false);
    expect(stringsEq(null, null)).toBe(true);
  });
});

describe('state slice equality', () => {
  it('settings', () => {
    expect(settingsEq(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(true);
    expect(settingsEq(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, fov: 90 })).toBe(false);
    expect(settingsEq(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, language: 'en' })).toBe(false);
  });

  it('worlds', () => {
    const w: WorldSummary[] = [{ id: 'a', name: 'Harbour', seed: '42', mode: 'creative', lastPlayed: 1 }];
    expect(worldsEq(w, [{ ...w[0]! }])).toBe(true);
    expect(worldsEq(w, [{ ...w[0]!, lastPlayed: 2 }])).toBe(false);
    expect(worldsEq(w, [])).toBe(false);
  });

  it('helm', () => {
    const h = { throttle: 0.5, rudder: 0, speed: 3, sails: 8 };
    expect(helmEq(h, { ...h })).toBe(true);
    expect(helmEq(h, { ...h, speed: 3.1 })).toBe(false);
    expect(helmEq(h, null)).toBe(false);
    expect(helmEq(null, null)).toBe(true);
  });
});

describe('keyed diff', () => {
  it('returns null for identical key sequences', () => {
    expect(diffKeyed([], [])).toBeNull();
    expect(diffKeyed([1, 2, 3], [1, 2, 3])).toBeNull();
  });

  it('reports additions and removals in order', () => {
    expect(diffKeyed([1, 2, 3], [2, 3, 4, 5])).toEqual({ added: [4, 5], removed: [1] });
    expect(diffKeyed([1, 2], [])).toEqual({ added: [], removed: [1, 2] });
    expect(diffKeyed([], [7])).toEqual({ added: [7], removed: [] });
  });

  it('a reorder alone adds and removes nothing', () => {
    expect(diffKeyed([1, 2], [2, 1])).toEqual({ added: [], removed: [] });
  });
});

describe('Memo', () => {
  it('reports changes only', () => {
    const m = new Memo<number>();
    expect(m.set(1)).toBe(true);
    expect(m.set(1)).toBe(false);
    expect(m.set(2)).toBe(true);
    expect(m.get()).toBe(2);
    m.reset();
    expect(m.set(2)).toBe(true);
  });

  it('treats NaN as equal to itself (Object.is)', () => {
    const m = new Memo<number>();
    m.set(Number.NaN);
    expect(m.set(Number.NaN)).toBe(false);
  });
});
