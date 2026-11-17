/**
 * Short-lived notifications for the UI's toast stack. Pure (time is passed in).
 * The visible list is an immutable array that is replaced only when its content changes, so
 * the UI can compare by reference.
 */
import type { Toast } from '../ui/model';

export const TOAST_LIFE_MS = 4500;
export const TOAST_LIFE_ERROR_MS = 8000;
export const MAX_TOASTS = 5;

interface Entry {
  toast: Toast;
  expires: number;
}

export class ToastList {
  private entries: Entry[] = [];
  private nextId = 1;
  private shown: Toast[] = [];

  /**
   * Show a message. The same text already on screen is refreshed instead of stacked twice
   * (a fault that repeats every frame, a hint toast emitted by every tick ...).
   */
  push(text: string, kind: Toast['kind'], now: number, lifeMs?: number): void {
    const life = lifeMs ?? (kind === 'error' ? TOAST_LIFE_ERROR_MS : TOAST_LIFE_MS);
    for (const e of this.entries) {
      if (e.toast.text === text && e.toast.kind === kind) {
        e.expires = Math.max(e.expires, now + life);
        return;
      }
    }
    this.entries.push({ toast: { id: this.nextId++, text, kind }, expires: now + life });
    while (this.entries.length > MAX_TOASTS) this.entries.shift();
    this.publish();
  }

  /** Drop expired toasts. Returns true when the visible list changed. */
  update(now: number): boolean {
    let removed = false;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.expires <= now) {
        this.entries.splice(i, 1);
        removed = true;
      }
    }
    if (removed) this.publish();
    return removed;
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.publish();
  }

  /** Current toasts, oldest first. Same array object until something changes. */
  get list(): readonly Toast[] {
    return this.shown;
  }

  private publish(): void {
    this.shown = this.entries.map((e) => e.toast);
  }
}
