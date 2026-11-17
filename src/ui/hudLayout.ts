/**
 * Collision-free placement of the movable HUD widgets. Pure geometry (no DOM) so every
 * viewport the reviewers measured is a unit test; views/layout.ts measures the real boxes and
 * applies the result. All values are viewport CSS px.
 *
 * Fixed: the bottom cluster (item name, gauges, hotbar), the centre zone (crosshair plus the
 * space the context hint appears in) and the debug overlay (top left). Movable, in priority
 * order: the helm instrument, the drag-look banner, the toast column. Each movable widget
 * takes the first candidate spot that collides with nothing placed before it; if none is free
 * it takes the spot with the least overlap.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/**
 * The centre zone: crosshair plus the context hint below it. The hint is reserved at least
 * `minHint` wide/tall even while hidden or short, because hints come and go during play (the
 * helm itself shows them) and widgets must not jump each time one appears.
 */
export function centerZone(crosshair: Rect, hint: Rect, minHint: { w: number; h: number }, vw: number, pad: number): Rect {
  const w = Math.max(crosshair.w, hint.w, minHint.w);
  const top = Math.min(crosshair.y, hint.y);
  const bottom = Math.max(crosshair.y + crosshair.h, hint.y + Math.max(hint.h, minHint.h));
  return inflate({ x: vw / 2 - w / 2, y: top, w, h: bottom - top }, pad);
}

export interface HelmBox {
  /** Unscaled box size (the instrument is scaled with a transform from its bottom-right corner). */
  w: number;
  h: number;
  /** Preferred scale for this viewport, and the smallest that stays legible. */
  scale: number;
  minScale: number;
  /** Distance to the right edge. */
  right: number;
  /** Smallest distance to the top / bottom edge (safe-area insets included). */
  top: number;
  bottom: number;
}

export interface HudLayoutInput {
  vw: number;
  vh: number;
  /** Clearance kept between widgets. */
  gap: number;
  cluster: Rect | null;
  center: Rect | null;
  debug: Rect | null;
  helm: HelmBox | null;
  /** Drag-look banner at its natural spot (top centre), or null when not shown. */
  banner: Rect | null;
  /** Toast column at its natural spot (top right); its height may be 0. */
  toasts: Rect | null;
}

export type HelmSpot = 'corner' | 'lifted' | 'top';

export interface HelmPlacement {
  spot: HelmSpot;
  scale: number;
  /** Offsets of the scaled box's bottom-right corner from the viewport's bottom-right. */
  right: number;
  bottom: number;
  rect: Rect;
}

export interface HudLayout {
  helm: HelmPlacement | null;
  /** Vertical shift of the banner / toast column from their natural spot. */
  bannerDy: number;
  toastsDy: number;
}

interface Candidate {
  rect: Rect;
  spot: HelmSpot;
  scale: number;
}

function insideViewport(r: Rect, vw: number, vh: number): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= vw + 0.5 && r.y + r.h <= vh + 0.5;
}

/** Overlap with obstacles plus the area that falls off screen: the fallback's cost. */
function cost(r: Rect, obstacles: readonly Rect[], vw: number, vh: number): number {
  let c = 0;
  for (const o of obstacles) c += overlapArea(r, o);
  return c + (r.w * r.h - overlapArea(r, { x: 0, y: 0, w: vw, h: vh }));
}

function pick(cands: readonly Candidate[], obstacles: readonly Rect[], vw: number, vh: number): Candidate | null {
  let best: Candidate | null = null;
  let bestCost = Infinity;
  for (const c of cands) {
    if (insideViewport(c.rect, vw, vh) && !obstacles.some((o) => intersects(c.rect, o))) return c;
    const k = cost(c.rect, obstacles, vw, vh);
    if (k < bestCost) {
      bestCost = k;
      best = c;
    }
  }
  return best;
}

function placeHelm(inp: HudLayoutInput, obstacles: readonly Rect[]): HelmPlacement | null {
  const hb = inp.helm;
  if (!hb || !(hb.w > 0) || !(hb.h > 0)) return null;
  const { vw, vh, gap, cluster, center } = inp;
  const s0 = hb.scale;
  const at = (scale: number, y: number, spot: HelmSpot): Candidate => {
    const w = hb.w * scale;
    const h = hb.h * scale;
    return { rect: { x: vw - hb.right - w, y, w, h }, spot, scale };
  };
  const onFloor = (scale: number): number => vh - hb.bottom - hb.h * scale;
  const fits = (scale: number): boolean => scale >= hb.minScale;
  const cands: Candidate[] = [at(s0, onFloor(s0), 'corner')];
  if (cluster) {
    // Above the cluster, still right-aligned: where it goes when the corner beside the hotbar
    // is too narrow (portrait, tall or mid-width screens).
    cands.push(at(s0, cluster.y - gap - hb.h * s0, 'lifted'));
    const sideScale = Math.min(s0, (vw - hb.right - (cluster.x + cluster.w) - gap) / hb.w);
    if (fits(sideScale)) cands.push(at(sideScale, onFloor(sideScale), 'corner'));
  }
  cands.push(at(s0, hb.top, 'top'));
  if (cluster && center) {
    const s = Math.min(s0, (cluster.y - gap - (center.y + center.h) - gap) / hb.h);
    if (fits(s)) cands.push(at(s, cluster.y - gap - hb.h * s, 'lifted'));
  }
  if (center) {
    const s = Math.min(s0, (center.y - gap - hb.top) / hb.h);
    if (fits(s)) cands.push(at(s, hb.top, 'top'));
  }
  const c = pick(cands, obstacles, vw, vh);
  if (!c) return null;
  return { spot: c.spot, scale: c.scale, right: hb.right, bottom: vh - (c.rect.y + c.rect.h), rect: c.rect };
}

/**
 * Vertical shift that moves `r` down past the obstacles it would cover: tries its natural
 * spot, then just below each obstacle, top to bottom; falls back to the least overlap.
 */
function shiftDown(r: Rect, obstacles: readonly Rect[], gap: number, vw: number, vh: number): number {
  const ys = [r.y];
  for (const o of obstacles) if (o.y + o.h + gap > r.y) ys.push(o.y + o.h + gap);
  ys.sort((a, b) => a - b);
  const cands: Candidate[] = ys.map((y) => ({ rect: { ...r, y }, spot: 'top', scale: 1 }));
  const c = pick(cands, obstacles, vw, vh);
  return c ? c.rect.y - r.y : 0;
}

export function layoutHud(inp: HudLayoutInput): HudLayout {
  const { gap, vw, vh } = inp;
  const fixed: Rect[] = [];
  if (inp.cluster) fixed.push(inflate(inp.cluster, gap));
  if (inp.center) fixed.push(inp.center);
  if (inp.debug) fixed.push(inflate(inp.debug, gap / 2));

  const helm = placeHelm(inp, fixed);

  // Top-of-screen widgets only need to clear what sits at the top: the debug overlay and a
  // helm moved up there. (Long toast stacks may run down over the scene; they are brief.)
  const top: Rect[] = [];
  if (inp.debug) top.push(inp.debug);
  if (helm) top.push(helm.rect);

  let bannerDy = 0;
  if (inp.banner) {
    bannerDy = shiftDown(inp.banner, top, gap, vw, vh);
    top.push({ ...inp.banner, y: inp.banner.y + bannerDy });
  }

  let toastsDy = 0;
  if (inp.toasts) {
    // An empty column still gets a lane (1 px tall) so the first toast lands in the right spot.
    const t = { ...inp.toasts, h: Math.max(1, inp.toasts.h) };
    toastsDy = shiftDown(t, top, gap, vw, vh);
  }
  return { helm, bannerDy, toastsDy };
}
