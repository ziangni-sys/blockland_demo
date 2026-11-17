/**
 * Applies hudLayout.ts to the live DOM: measures the HUD boxes, computes collision-free spots
 * for the helm instrument, the drag-look banner and the toast column, and writes them.
 *
 * It runs only when geometry can have changed — window resize, or a ResizeObserver report for
 * one of the measured boxes (a widget shown or hidden, a toast added, the hint text changing,
 * the debug overlay growing) — never per frame. ResizeObserver callbacks run after layout and
 * before paint, so reading boxes there is free and a moved widget is never painted in its old
 * spot. Only positions and transforms are written, never sizes, so a pass cannot re-trigger
 * itself.
 */
import { centerZone, layoutHud, type HelmBox, type Rect } from '../hudLayout';

export interface HudLayoutTargets {
  /** The .bl-ui element: reads data-screen / tokens, receives the offset custom properties. */
  root: HTMLElement;
  cluster: HTMLElement;
  crosshair: Element;
  hint: HTMLElement;
  debug: HTMLElement;
  helm: HTMLElement;
  veil: HTMLElement;
  veilCard: HTMLElement;
  toasts: HTMLElement;
  /** Zero-size element whose paddings are the safe-area insets. */
  safeProbe: HTMLElement;
}

/** Clearance between HUD widgets, before --ui-zoom. */
const GAP = 10;
/** Width / height kept free for the context hint under the crosshair, before --ui-zoom. */
const HINT_MIN_W = 300;
const HINT_MIN_H = 34;
/**
 * Smallest helm scale, before --ui-zoom: its 30 px speed figure, lever and needle stay easy to
 * read; only the 10 px notch labels get small. Used only where nothing larger fits.
 */
const HELM_MIN_SCALE = 0.62;

function rectOf(el: Element): Rect | null {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}

/** The bottom cluster's box, grown to include the off-hand socket hanging outside its flow. */
function clusterRect(cluster: HTMLElement): Rect | null {
  const r = rectOf(cluster);
  const off = cluster.querySelector('.bl-offhand');
  const o = off ? rectOf(off) : null;
  if (r === null || o === null) return r ?? o;
  const x = Math.min(r.x, o.x);
  const y = Math.min(r.y, o.y);
  return { x, y, w: Math.max(r.x + r.w, o.x + o.w) - x, h: Math.max(r.y + r.h, o.y + o.h) - y };
}

function px(v: number): string {
  return `${Math.round(v * 10) / 10}px`;
}

export class HudLayoutController {
  private readonly ro: ResizeObserver | null;
  private readonly win: (Window & typeof globalThis) | null;
  private bannerDx = 0;
  private bannerDy = 0;
  private toastsDy = 0;
  private helmStyle = '';
  private readonly onResize = (): void => this.run();

  constructor(private readonly t: HudLayoutTargets) {
    const win = t.root.ownerDocument.defaultView;
    this.win = win;
    this.ro = win && typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => this.run()) : null;
    if (this.ro) for (const el of [t.cluster, t.hint, t.debug, t.helm, t.veilCard, t.toasts]) this.ro.observe(el);
    win?.addEventListener('resize', this.onResize);
  }

  dispose(): void {
    this.ro?.disconnect();
    this.win?.removeEventListener('resize', this.onResize);
  }

  /** Measure and place. Safe to call at any time; does nothing unless the HUD is in play. */
  run(): void {
    const t = this.t;
    const win = this.win;
    if (!win || t.root.dataset.screen !== 'none' || t.root.dataset.ingame !== '1') return;
    const vw = t.root.clientWidth;
    const vh = t.root.clientHeight;
    if (!(vw > 0 && vh > 0)) return;

    const tokens = win.getComputedStyle(t.root);
    const zoom = parseFloat(tokens.getPropertyValue('--ui-zoom')) || 1;
    const helmBase = parseFloat(tokens.getPropertyValue('--helm-base')) || 1;
    const margin = parseFloat(tokens.getPropertyValue('--helm-margin')) || 14;
    const safe = win.getComputedStyle(t.safeProbe);
    const safeTop = parseFloat(safe.paddingTop) || 0;
    const safeBottom = parseFloat(safe.paddingBottom) || 0;
    const gap = GAP * zoom;

    const cross = rectOf(t.crosshair);
    const hintBox = t.hint.getBoundingClientRect();
    const hint: Rect = { x: hintBox.left, y: hintBox.top, w: hintBox.width, h: hintBox.height };
    const center = cross ? centerZone(cross, hint, { w: HINT_MIN_W * zoom, h: HINT_MIN_H * zoom }, vw, gap / 2) : null;

    let helm: HelmBox | null = null;
    if (!t.helm.hidden && t.helm.offsetWidth > 0) {
      helm = {
        // Layout size: unaffected by the transform this pass itself applies.
        w: t.helm.offsetWidth,
        h: t.helm.offsetHeight,
        scale: helmBase * zoom,
        minScale: HELM_MIN_SCALE * zoom,
        right: margin,
        top: margin + safeTop,
        bottom: margin + safeBottom,
      };
    }

    // Banner and toasts are measured where they are and shifted back by the offset this pass
    // applied last time, giving their natural spot.
    let banner: Rect | null = null;
    if (t.veil.dataset.drag === '1') {
      const r = rectOf(t.veilCard);
      if (r) banner = { ...r, x: r.x - this.bannerDx, y: r.y - this.bannerDy };
    }
    const tb = t.toasts.getBoundingClientRect();
    const toasts: Rect | null = tb.width > 0 ? { x: tb.left, y: tb.top - this.toastsDy, w: tb.width, h: tb.height } : null;

    const out = layoutHud({ vw, vh, gap, cluster: clusterRect(t.cluster), center, debug: rectOf(t.debug), helm, banner, toasts });

    if (out.helm) {
      const h = out.helm;
      const key = `${px(h.right)}|${px(h.bottom)}|${h.scale.toFixed(3)}|${h.spot}`;
      if (key !== this.helmStyle) {
        this.helmStyle = key;
        const s = t.helm.style;
        s.right = px(h.right);
        s.bottom = px(h.bottom);
        s.transform = `scale(${h.scale.toFixed(3)})`;
        t.helm.dataset.spot = h.spot;
      }
    }
    if (out.bannerDx !== this.bannerDx) {
      this.bannerDx = out.bannerDx;
      t.root.style.setProperty('--banner-dx', px(out.bannerDx));
    }
    if (out.bannerDy !== this.bannerDy) {
      this.bannerDy = out.bannerDy;
      t.root.style.setProperty('--banner-dy', px(out.bannerDy));
    }
    if (out.toastsDy !== this.toastsDy) {
      this.toastsDy = out.toastsDy;
      t.root.style.setProperty('--toasts-dy', px(out.toastsDy));
    }
  }
}
