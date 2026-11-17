/**
 * Item icons: RGBA pixels from the injected provider (the client passes the procedural
 * art module's renderItemIcon), painted once per (item, size) into a master canvas and then
 * blitted into each slot's own <canvas>. Missing provider / null result / bad buffer ->
 * a deterministic placeholder tile with the item's initials.
 */
import { itemInitials, placeholderHue } from './palette';

export type IconProvider = (itemId: number, size: number) => Uint8ClampedArray | null;

/** Largest icon edge we will ever request; keeps the numeric cache key collision-free. */
const MAX_ICON_SIZE = 512;

export class IconCache {
  private readonly cache = new Map<number, HTMLCanvasElement>();

  constructor(
    private readonly doc: Document,
    private readonly provider: IconProvider | undefined,
  ) {}

  /** Master canvas for an item at `size` px (created on first use, then cached). */
  get(item: number, size: number): HTMLCanvasElement {
    const s = Math.max(8, Math.min(MAX_ICON_SIZE, Math.round(size)));
    const key = item * (MAX_ICON_SIZE + 1) + s;
    let c = this.cache.get(key);
    if (!c) {
      c = this.render(item, s);
      this.cache.set(key, c);
    }
    return c;
  }

  /** Paint an item into `target`, resizing its backing store to `size`. */
  paint(target: HTMLCanvasElement, item: number, size: number): void {
    const src = this.get(item, size);
    if (target.width !== src.width) target.width = src.width;
    if (target.height !== src.height) target.height = src.height;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(src, 0, 0);
  }

  /** Blank a slot canvas (empty slot). */
  clear(target: HTMLCanvasElement): void {
    const ctx = target.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, target.width, target.height);
  }

  private render(item: number, size: number): HTMLCanvasElement {
    const c = this.doc.createElement('canvas');
    c.width = size;
    c.height = size;
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
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
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
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillText(text, size / 2, size / 2 + Math.max(1, size / 40));
  ctx.fillStyle = 'rgba(255, 250, 238, 0.96)';
  ctx.fillText(text, size / 2, size / 2);
}
