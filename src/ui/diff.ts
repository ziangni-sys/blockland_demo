/**
 * Equality and list-diff helpers behind the UI's "touch the DOM only where something
 * changed" rule. Pure; tested in Node.
 *
 * The client may build a brand-new UiState every frame with identical contents, so identity
 * checks alone are not enough: these compare by value, but cheaply (no allocation on the
 * equal path, which is the common one).
 */
import type { HelmView, Settings, SlotView, WorldSummary } from './model';

export function slotEq(a: SlotView | null | undefined, b: SlotView | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.item === b.item && a.count === b.count;
}

export function settingsEq(a: Settings, b: Settings): boolean {
  return (
    a === b ||
    (a.renderDistance === b.renderDistance &&
      a.fov === b.fov &&
      a.sensitivity === b.sensitivity &&
      a.invertY === b.invertY &&
      a.language === b.language &&
      a.volume === b.volume &&
      a.showDebug === b.showDebug)
  );
}

export function worldEq(a: WorldSummary, b: WorldSummary): boolean {
  return a === b || (a.id === b.id && a.name === b.name && a.seed === b.seed && a.mode === b.mode && a.lastPlayed === b.lastPlayed);
}

export function worldsEq(a: readonly WorldSummary[], b: readonly WorldSummary[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!worldEq(a[i]!, b[i]!)) return false;
  return true;
}

export function helmEq(a: HelmView | null, b: HelmView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.throttle === b.throttle && a.rudder === b.rudder && a.speed === b.speed && a.sails === b.sails;
}

export interface KeyedDiff<K> {
  /** Keys in `next` that were not in `prev`, in `next` order. */
  added: K[];
  /** Keys in `prev` that are not in `next`, in `prev` order. */
  removed: K[];
}

/**
 * Reconcile two keyed lists (toast ids). Returns null when the key sequences are identical,
 * which is the per-frame common case and allocates nothing.
 */
export function diffKeyed<K>(prev: readonly K[], next: readonly K[]): KeyedDiff<K> | null {
  if (prev.length === next.length) {
    let same = true;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== next[i]) {
        same = false;
        break;
      }
    }
    if (same) return null;
  }
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const added: K[] = [];
  const removed: K[] = [];
  for (const k of next) if (!prevSet.has(k)) added.push(k);
  for (const k of prev) if (!nextSet.has(k)) removed.push(k);
  return { added, removed };
}
