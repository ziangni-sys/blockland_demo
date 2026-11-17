import { describe, expect, it } from 'vitest';
import { diffKeyed, helmEq, settingsEq, slotEq, worldsEq } from '../../src/ui/diff';
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
