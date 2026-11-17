import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/ui/model';
import {
  applySettingsPatch,
  languageFromLocale,
  sanitizeSettings,
  settingsEqual,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  type KeyValueStore,
} from '../../src/client/settings';

class MapStore implements KeyValueStore {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

const throwing: KeyValueStore = {
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('quota', 'QuotaExceededError');
  },
};

describe('sanitizeSettings', () => {
  it('returns the defaults for garbage', () => {
    for (const raw of [null, undefined, 42, 'x', [], {}]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps numbers into the UI ranges and rounds the render distance', () => {
    const s = sanitizeSettings({ renderDistance: 99.4, fov: 10, sensitivity: 50, volume: -1 });
    expect(s.renderDistance).toBe(16);
    expect(s.fov).toBe(50);
    expect(s.sensitivity).toBe(3);
    expect(s.volume).toBe(0);
    expect(sanitizeSettings({ renderDistance: 6.6 }).renderDistance).toBe(7);
    expect(sanitizeSettings({ renderDistance: 1 }).renderDistance).toBe(4);
  });

  it('rejects wrong types and non-finite numbers field by field', () => {
    const s = sanitizeSettings({ fov: Number.NaN, sensitivity: '2', invertY: 'yes', language: 'fr', showDebug: 1, renderDistance: Infinity });
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and drops unknown keys', () => {
    const s = sanitizeSettings({ fov: 90, invertY: true, language: 'en', showDebug: true, extra: 'x' });
    expect(s.fov).toBe(90);
    expect(s.invertY).toBe(true);
    expect(s.language).toBe('en');
    expect(s.showDebug).toBe(true);
    expect('extra' in s).toBe(false);
  });
});

describe('applySettingsPatch', () => {
  it('merges a partial patch and validates it against the current settings', () => {
    const cur = { ...DEFAULT_SETTINGS, fov: 90 };
    const next = applySettingsPatch(cur, { sensitivity: 2, fov: 'wide' });
    expect(next.sensitivity).toBe(2);
    expect(next.fov).toBe(90); // invalid field keeps the current value, not the default
    expect(applySettingsPatch(cur, null)).toBe(cur);
    expect(settingsEqual(applySettingsPatch(cur, {}), cur)).toBe(true);
    expect(settingsEqual(next, cur)).toBe(false);
  });
});

describe('SettingsStore', () => {
  it('round-trips through a key-value store', () => {
    const m = new MapStore();
    const store = new SettingsStore(m);
    expect(store.load(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS);
    const s = { ...DEFAULT_SETTINGS, renderDistance: 12, language: 'en' as const };
    expect(store.save(s)).toBe(true);
    expect(m.m.has(SETTINGS_STORAGE_KEY)).toBe(true);
    expect(new SettingsStore(m).load(DEFAULT_SETTINGS)).toEqual(s);
  });

  it('survives corrupt JSON and storage that throws or is missing', () => {
    const m = new MapStore();
    m.setItem(SETTINGS_STORAGE_KEY, '{not json');
    expect(new SettingsStore(m).load(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    const t = new SettingsStore(throwing);
    expect(t.load(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(t.save(DEFAULT_SETTINGS)).toBe(false);
    const none = new SettingsStore(null);
    expect(none.load(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(none.save(DEFAULT_SETTINGS)).toBe(false);
  });
});

describe('languageFromLocale', () => {
  it('picks Chinese for zh locales only', () => {
    expect(languageFromLocale('zh-CN')).toBe('zh');
    expect(languageFromLocale('zh')).toBe('zh');
    expect(languageFromLocale('ZH-tw')).toBe('zh');
    expect(languageFromLocale('en-US')).toBe('en');
    expect(languageFromLocale('zhx')).toBe('en');
    expect(languageFromLocale(undefined)).toBe('en');
  });
});
