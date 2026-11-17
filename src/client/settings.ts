/**
 * Player settings: validation (pure) and persistence (localStorage, best effort).
 *
 * Storage in the hosting iframe may be missing or throw on access (sandboxed, privacy
 * modes), so every access is guarded and the game simply runs on defaults then. Settings
 * are the ONLY thing kept in localStorage; worlds live in IndexedDB (src/save).
 */
import { DEFAULT_SETTINGS, type Language, type Settings } from '../ui/model';

export const SETTINGS_STORAGE_KEY = 'blocklands.settings.v1';

/** Inclusive ranges of the numeric settings (the settings screen uses the same ones). */
export const SETTING_RANGES = {
  renderDistance: { min: 4, max: 16 },
  fov: { min: 50, max: 110 },
  sensitivity: { min: 0.2, max: 3 },
  volume: { min: 0, max: 1 },
} as const;

function num(v: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const r = integer ? Math.round(v) : v;
  return r < min ? min : r > max ? max : r;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function lang(v: unknown, fallback: Language): Language {
  return v === 'zh' || v === 'en' ? v : fallback;
}

/**
 * A complete, valid Settings object from anything (parsed JSON, a UI patch merged over the
 * current settings ...). Unknown keys are dropped; missing / invalid values take the value
 * from `base` (itself assumed valid).
 */
export function sanitizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const R = SETTING_RANGES;
  return {
    renderDistance: num(r.renderDistance, base.renderDistance, R.renderDistance.min, R.renderDistance.max, true),
    fov: num(r.fov, base.fov, R.fov.min, R.fov.max),
    sensitivity: num(r.sensitivity, base.sensitivity, R.sensitivity.min, R.sensitivity.max),
    invertY: bool(r.invertY, base.invertY),
    language: lang(r.language, base.language),
    volume: num(r.volume, base.volume, R.volume.min, R.volume.max),
    showDebug: bool(r.showDebug, base.showDebug),
  };
}

/** `current` with a (possibly partial / hostile) patch applied. */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (typeof patch !== 'object' || patch === null) return current;
  return sanitizeSettings({ ...current, ...(patch as Record<string, unknown>) }, current);
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return (
    a.renderDistance === b.renderDistance &&
    a.fov === b.fov &&
    a.sensitivity === b.sensitivity &&
    a.invertY === b.invertY &&
    a.language === b.language &&
    a.volume === b.volume &&
    a.showDebug === b.showDebug
  );
}

/** Default UI language for a first start: Chinese for zh-* browsers, English otherwise. */
export function languageFromLocale(locale: string | undefined | null): Language {
  return typeof locale === 'string' && /^zh\b/i.test(locale) ? 'zh' : 'en';
}

/** The subset of the Web Storage API we use (lets tests pass a fake). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Loads and saves settings. A store that throws (or is absent) degrades to "defaults, not
 * remembered" without ever propagating the exception.
 */
export class SettingsStore {
  private readonly store: KeyValueStore | null;

  constructor(store: KeyValueStore | null) {
    this.store = store;
  }

  load(defaults: Settings): Settings {
    if (!this.store) return defaults;
    try {
      const text = this.store.getItem(SETTINGS_STORAGE_KEY);
      if (text === null) return defaults;
      return sanitizeSettings(JSON.parse(text) as unknown, defaults);
    } catch {
      return defaults;
    }
  }

  /** Returns false when the settings could not be written. */
  save(s: Settings): boolean {
    if (!this.store) return false;
    try {
      this.store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
      return true;
    } catch {
      return false;
    }
  }
}
