/**
 * Toast stack. The client owns toast lifetimes and order; this view reconciles the DOM against
 * state.toasts by id, animating entries in and out, and shows them top to bottom in array
 * order (a client that keeps them newest-first gets newest on top).
 *
 * Placement: top right during play, shifted down past the debug overlay / drag banner / a
 * raised helm by views/layout.ts; top left (clear of the panels' close buttons) while any
 * screen is open.
 */
import type { UiContext } from '../context';
import { diffKeyed } from '../diff';
import type { Toast } from '../model';
import { h } from '../dom';

const GLYPH: Readonly<Record<Toast['kind'], string>> = { info: 'i', warn: '!', error: '×' };
const LEAVE_MS = 220;

interface LiveToast {
  el: HTMLElement;
  textEl: HTMLElement;
  text: string;
  kind: Toast['kind'];
}

export class ToastStack {
  readonly el: HTMLElement;
  private readonly live = new Map<number, LiveToast>();
  private ids: number[] = [];
  private readonly timers = new Set<number>();

  constructor(private readonly ctx: UiContext) {
    this.el = h(ctx.doc, 'div', 'bl-toasts', { role: 'status', 'aria-live': 'polite' });
    ctx.attr(this.el, 'aria-label', 'hud.notifications');
  }

  update(toasts: readonly Toast[]): void {
    if (!this.sameIds(toasts)) {
      const next = toasts.map((t) => t.id);
      const diff = diffKeyed(this.ids, next);
      this.ids = next;
      if (diff) {
        for (const id of diff.removed) this.leave(id);
        for (const id of diff.added) this.create(toasts.find((t) => t.id === id)!);
      }
      this.order(toasts);
    }
    // Same ids: a client may still edit a toast in place (e.g. a counter); cheap to check.
    for (const t of toasts) {
      const live = this.live.get(t.id);
      if (!live) continue;
      if (live.text !== t.text) {
        live.text = t.text;
        live.textEl.textContent = t.text;
      }
      if (live.kind !== t.kind) {
        live.kind = t.kind;
        live.el.className = `bl-toast bl-toast--${t.kind}`;
        (live.el.firstElementChild as HTMLElement).textContent = GLYPH[t.kind];
      }
    }
  }

  private sameIds(toasts: readonly Toast[]): boolean {
    if (toasts.length !== this.ids.length) return false;
    for (let i = 0; i < toasts.length; i++) if (toasts[i]!.id !== this.ids[i]) return false;
    return true;
  }

  private create(t: Toast): void {
    const d = this.ctx.doc;
    const textEl = h(d, 'div', 'bl-toast-text', null, [t.text]);
    const el = h(d, 'div', `bl-toast bl-toast--${t.kind}`, null, [h(d, 'span', 'bl-toast-glyph', { 'aria-hidden': 'true' }, [GLYPH[t.kind]]), textEl]);
    this.live.set(t.id, { el, textEl, text: t.text, kind: t.kind });
  }

  /**
   * Put live toasts in state order, inserting new ones in place. Walks backwards so each
   * toast only needs checking against its successor; elements already in place are not
   * touched (re-inserting would replay their entry animation). Leaving toasts stay where they
   * are until their exit animation ends.
   */
  private order(toasts: readonly Toast[]): void {
    let next: Element | null = null;
    for (let i = toasts.length - 1; i >= 0; i--) {
      const el = this.live.get(toasts[i]!.id)!.el;
      if (!el.isConnected || nextLive(el) !== next) this.el.insertBefore(el, next);
      next = el;
    }
  }

  private leave(id: number): void {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    const win = this.ctx.doc.defaultView;
    if (this.ctx.reducedMotion || !win) {
      live.el.remove();
      return;
    }
    live.el.classList.add('is-leaving');
    const timer = win.setTimeout(() => {
      this.timers.delete(timer);
      live.el.remove();
    }, LEAVE_MS);
    this.timers.add(timer);
  }

  dispose(): void {
    const win = this.ctx.doc.defaultView;
    if (win) for (const t of this.timers) win.clearTimeout(t);
    this.timers.clear();
    this.live.clear();
    this.el.remove();
  }
}

/** Next sibling that is not on its way out. */
function nextLive(el: Element): Element | null {
  let n = el.nextElementSibling;
  while (n && n.classList.contains('is-leaving')) n = n.nextElementSibling;
  return n;
}
