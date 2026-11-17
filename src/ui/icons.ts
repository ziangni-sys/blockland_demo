/**
 * Item icons: RGBA pixels from the injected provider (the client passes the procedural
 * art module's renderItemIcon), rendered once per (item, size) into a master canvas and then
 * blitted into each slot's own <canvas>. Missing provider / null result / bad buffer ->
 * a deterministic placeholder tile with the item's initials.
 *
 * The provider is expensive (one to several ms per icon for procedural art, more on a cold
 * page), so rendering is budgeted and never allowed to stall a frame: within one UI update
 * paint() renders synchronously only until SYNC_BUDGET_MS of provider time is spent (the
 * root calls beginFrame() at the start of each update); after that the slot stays blank and
 * is filled from a requestAnimationFrame queue a frame or two later. prewarm() renders icons
 * ahead of need in idle time (the client sits on the main menu long before the first
 * creative palette opens), so in practice paints are plain blits.
 */
import { itemInitials, placeholderHue } from './palette';

export type IconProvider = (itemId: number, size: number) => Uint8ClampedArray | null;

/** Largest icon edge we will ever request; keeps the numeric cache key collision-free. */
const MAX_ICON_SIZE = 512;
/** Provider time one UI update may spend rendering icons synchronously. */
const SYNC_BUDGET_MS = 3;
/** Provider time one animation frame of the deferred queue may spend. */
const FLUSH_BUDGET_MS = 4;
/** Longest stretch of one idle-time prewarm slice. */
const IDLE_SLICE_MS = 8;

function sizeOf(size: number): number {
  return Math.max(8, Math.min(MAX_ICON_SIZE, Math.round(size)));
}

function keyOf(item: number, size: number): number {
  return item * (MAX_ICON_SIZE + 1) + size;
}

export class IconCache {
  private readonly cache = new Map<number, HTMLCanvasElement>();
  /** Slot canvases waiting for an icon that has not been rendered yet: target -> cache key. */
  private readonly waiting = new Map<HTMLCanvasElement, number>();
  /** Keys to render ahead of need, in order. */
  private readonly warmQueue: number[] = [];
  private readonly win: (Window & typeof globalThis) | null;
  /** Provider time spent synchronously since the last beginFrame(). */
  private spent = 0;
  private rafId = 0;
  private idleId = 0;
  private idleIsTimeout = false;
  private disposed = false;

  constructor(
    private readonly doc: Document,
    private readonly provider: IconProvider | undefined,
  ) {
    this.win = doc.defaultView;
  }

  /** Start a new synchronous budget (called at the start of every UI update). */
  beginFrame(): void {
    this.spent = 0;
  }

  /**
   * Paint an item into `target` (resizing its backing store to `size`): now if the icon is
   * cached or the update's budget allows rendering it, otherwise within a few frames.
   * `deferOnly` never renders synchronously (for work done ahead of need, in idle time).
   */
  paint(target: HTMLCanvasElement, item: number, size: number, deferOnly = false): void {
    const s = sizeOf(size);
    const key = keyOf(item, s);
    this.waiting.delete(target);
    let src = this.cache.get(key);
    if (!src && !deferOnly && this.spent < SYNC_BUDGET_MS) src = this.renderTimed(key);
    if (src) {
      blit(target, src);
      return;
    }
    if (target.width !== s) target.width = s;
    if (target.height !== s) target.height = s;
    clearCanvas(target);
    this.waiting.set(target, key);
    this.scheduleFrame();
  }

  /** Blank a slot canvas (empty slot) and cancel any icon still on its way to it. */
  clear(target: HTMLCanvasElement): void {
    this.waiting.delete(target);
    clearCanvas(target);
  }

  /** Render these items' icons at `size` in idle time, so later paints are plain blits. */
  prewarm(items: readonly number[], size: number): void {
    const s = sizeOf(size);
    for (const item of items) {
      const key = keyOf(item, s);
      if (!this.cache.has(key)) this.warmQueue.push(key);
    }
    this.scheduleIdle();
  }

  dispose(): void {
    this.disposed = true;
    const win = this.win;
    if (win) {
      if (this.rafId) win.cancelAnimationFrame(this.rafId);
      if (this.idleId) {
        if (this.idleIsTimeout) win.clearTimeout(this.idleId);
        else win.cancelIdleCallback(this.idleId);
      }
    }
    this.rafId = 0;
    this.idleId = 0;
    this.waiting.clear();
    this.warmQueue.length = 0;
    this.cache.clear();
  }

  // ------------------------------------------------------------------ budget & scheduling

  private now(): number {
    return this.win ? this.win.performance.now() : 0;
  }

  private renderTimed(key: number): HTMLCanvasElement {
    const t0 = this.now();
    const c = this.render(key);
    this.spent += this.now() - t0;
    return c;
  }

  private scheduleFrame(): void {
    if (this.rafId || this.disposed) return;
    const win = this.win;
    if (!win) {
      this.flushWaiting();
      return;
    }
    this.rafId = win.requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (): void => {
    this.rafId = 0;
    this.flushWaiting();
  };

  private flushWaiting(): void {
    const start = this.now();
    for (const [target, key] of this.waiting) {
      let src = this.cache.get(key);
      if (!src) {
        if (this.now() - start >= FLUSH_BUDGET_MS) break;
        src = this.render(key);
      }
      this.waiting.delete(target);
      blit(target, src);
    }
    if (this.waiting.size > 0) this.scheduleFrame();
  }

  private scheduleIdle(): void {
    const win = this.win;
    if (this.idleId || this.disposed || !win || this.warmQueue.length === 0) return;
    if (typeof win.requestIdleCallback === 'function') {
      this.idleIsTimeout = false;
      this.idleId = win.requestIdleCallback(this.onIdle, { timeout: 1500 });
    } else {
      this.idleIsTimeout = true;
      this.idleId = win.setTimeout(() => this.onIdle(null), 100);
    }
  }

  private readonly onIdle = (deadline: IdleDeadline | null): void => {
    this.idleId = 0;
    const start = this.now();
    // Always make progress (a timed-out idle callback reports 0 ms remaining), then keep going
    // while the browser says it is idle, in short slices so input is never kept waiting.
    do {
      const key = this.warmQueue.shift();
      if (key === undefined) break;
      if (!this.cache.has(key)) this.render(key);
    } while (this.warmQueue.length > 0 && this.now() - start < IDLE_SLICE_MS && (deadline === null || deadline.timeRemaining() > 2));
    this.scheduleIdle();
  };

  // ------------------------------------------------------------------ rendering

  private render(key: number): HTMLCanvasElement {
    const size = key % (MAX_ICON_SIZE + 1);
    const item = (key - size) / (MAX_ICON_SIZE + 1);
    const c = this.doc.createElement('canvas');
    c.width = size;
    c.height = size;
    this.cache.set(key, c);
    const ctx = c.getContext('2d');
    if (!ctx) return c;
    const pixels = this.fromProvider(item, size);
    if (pixels) {
      // createImageData + set works for any Uint8ClampedArray backing buffer (the
      // ImageData constructor rejects SharedArrayBuffer-backed views).
      const img = ctx.createImageData(size, size);
      img.data.set(pixels);
      ctx.putImageData(img, 0, 0);
    } else {
      drawPlaceholder(ctx, item, size);
    }
    return c;
  }

  private fromProvider(item: number, size: number): Uint8ClampedArray | null {
    if (!this.provider) return null;
    try {
      const px = this.provider(item, size);
      return px && px.length === size * size * 4 ? px : null;
    } catch {
      // A broken icon must never take the whole UI down; the placeholder is a fine fallback.
      return null;
    }
  }
}

function blit(target: HTMLCanvasElement, src: HTMLCanvasElement): void {
  if (target.width !== src.width) target.width = src.width;
  if (target.height !== src.height) target.height = src.height;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(src, 0, 0);
}

function clearCanvas(target: HTMLCanvasElement): void {
  const ctx = target.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, target.width, target.height);
}

/*
 * Placeholder tile. Its colours are raster image content (like the procedural item art the
 * provider normally supplies), not interface styling, so they are generated here from the
 * item's hue rather than taken from the stylesheet's tokens.
 */
function drawPlaceholder(ctx: CanvasRenderingContext2D, item: number, size: number): void {
  const hue = placeholderHue(item);
  const inset = Math.max(1, Math.round(size * 0.1));
  const w = size - inset * 2;
  const r = size * 0.18;
  ctx.beginPath();
  ctx.roundRect(inset, inset, w, w, r);
  const g = ctx.createLinearGradient(0, inset, 0, inset + w);
  g.addColorStop(0, `hsl(${hue} 46% 56%)`);
  g.addColorStop(1, `hsl(${hue} 50% 32%)`);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size / 32);
  ctx.strokeStyle = `hsl(${hue} 60% 80% / 0.55)`;
  ctx.stroke();
  // Diagonal sheen so the tile does not read as a flat swatch.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'hsl(0 0% 100% / 0.12)';
  ctx.beginPath();
  ctx.moveTo(inset, inset);
  ctx.lineTo(inset + w * 0.62, inset);
  ctx.lineTo(inset, inset + w * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const text = itemInitials(item);
  ctx.font = `700 ${Math.round(size * 0.36)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'hsl(0 0% 0% / 0.35)';
  ctx.fillText(text, size / 2, size / 2 + Math.max(1, size / 40));
  ctx.fillStyle = 'hsl(43 100% 97% / 0.96)';
  ctx.fillText(text, size / 2, size / 2);
}
