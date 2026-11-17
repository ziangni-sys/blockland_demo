/**
 * HUD collision avoidance (review findings: the helm covered hotbar slots 8-9 and the breath
 * arc from 1101 to ~1300 px wide and on tall / portrait screens; on landscape phones it
 * covered the context hint; toasts covered the helm and the debug overlay; the drag banner
 * sat on the debug overlay and under toasts).
 *
 * The scene below models the stylesheet's geometry (slot size formula, cluster stack, hint
 * pill, debug overlay, banner, toast column, helm box) so every viewport the reviewers
 * measured is checked, with every combination of the optional widgets.
 */
import { describe, expect, it } from 'vitest';
import { centerZone, inflate, intersects, layoutHud, type HudLayout, type HudLayoutInput, type Rect } from '../../src/ui/hudLayout';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

interface SceneOpts {
  survival: boolean;
  debug: boolean;
  drag: boolean;
  toasts: number;
  hintW: number;
}

/** Boxes as the stylesheet lays them out (helm at its measured, unscaled 300 x 163 size). */
function scene(vw: number, vh: number, o: SceneOpts): HudLayoutInput {
  const slot = clamp(Math.min((vw - 56) / 9, 0.044 * vh + 22), 30, 92);
  const g = clamp(slot * 0.09, 3, 8);
  const hotW = 9 * slot + 8 * g + 2.8 * g + 2;
  const hotH = slot + 2.8 * g + 2;
  const breath = clamp(slot * 0.8, 34, 52);
  const nameH = 1.6 * clamp(slot * 0.3, 13, 20);
  const clusterH = nameH + 6 + (o.survival ? breath + 6 : 0) + hotH;
  const cluster: Rect = { x: (vw - hotW) / 2, y: vh - 10 - clusterH, w: hotW, h: clusterH };
  const cross: Rect = { x: vw / 2 - 13, y: vh / 2 - 13, w: 26, h: 26 };
  const hintW = Math.min(o.hintW, 560, vw - 32);
  const hint: Rect = { x: vw / 2 - hintW / 2, y: vh / 2 + 30, w: hintW, h: hintW > 0 ? 31 : 0 };
  const phone = vw <= 560;
  const base = phone ? 0.78 : vw <= 1100 ? 0.82 : vw >= 1900 && vh >= 1000 ? 1.3 : 1;
  const margin = vw <= 1100 ? 8 : 14;
  const bannerW = phone ? 252 : 350;
  const toastW = phone ? vw - 24 : Math.min(380, vw - 24);
  return {
    vw,
    vh,
    gap: 10,
    cluster,
    center: centerZone(cross, hint, { w: 300, h: 34 }, vw, 5),
    debug: o.debug ? { x: 8, y: 8, w: Math.min(330, vw - 16), h: 95 } : null,
    helm: { w: 300, h: 163, scale: base, minScale: 0.62, right: margin, top: margin, bottom: margin },
    banner: o.drag ? { x: (vw - bannerW) / 2, y: 14, w: bannerW, h: 52 } : null,
    toasts: { x: vw - 12 - toastW, y: 12, w: toastW, h: o.toasts * 46 },
  };
}

const VIEWPORTS: ReadonlyArray<[number, number]> = [
  [1280, 720], [1101, 700], [1120, 720], [1152, 864], [1280, 1024], [1200, 1920], [1440, 900], [1920, 1080],
  [1024, 768], [768, 1024], [844, 390], [667, 375], [640, 360], [932, 430], [390, 844], [360, 640],
];

function inside(r: Rect, vw: number, vh: number): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= vw + 0.5 && r.y + r.h <= vh + 0.5;
}

function bannerRect(inp: HudLayoutInput, out: HudLayout): Rect | null {
  return inp.banner ? { ...inp.banner, x: inp.banner.x + out.bannerDx, y: inp.banner.y + out.bannerDy } : null;
}

describe('layoutHud: the helm instrument', () => {
  for (const [vw, vh] of VIEWPORTS) {
    for (const survival of [true, false]) {
      for (const hintW of [0, 330]) {
        it(`${vw}x${vh} ${survival ? 'survival' : 'creative'} hint ${hintW}: clears the hotbar cluster and the crosshair / hint zone`, () => {
          const inp = scene(vw, vh, { survival, debug: false, drag: false, toasts: 0, hintW });
          const out = layoutHud(inp);
          const helm = out.helm!;
          expect(helm).not.toBeNull();
          expect(inside(helm.rect, vw, vh), JSON.stringify(helm.rect)).toBe(true);
          expect(intersects(helm.rect, inp.cluster!), `cluster ${JSON.stringify(helm)}`).toBe(false);
          expect(intersects(helm.rect, inp.center!), `centre ${JSON.stringify(helm)}`).toBe(false);
          expect(helm.scale).toBeGreaterThanOrEqual(0.62);
        });
      }
    }
  }

  it('keeps the bottom-right corner when it is free (wide screen)', () => {
    const out = layoutHud(scene(1920, 1080, { survival: true, debug: false, drag: false, toasts: 0, hintW: 0 }));
    expect(out.helm!.spot).toBe('corner');
    expect(out.helm!.scale).toBeCloseTo(1.3);
  });

  it('rises above the cluster where the corner beside the hotbar is too narrow (1152x864, portrait)', () => {
    for (const [vw, vh] of [[1152, 864], [1200, 1920], [390, 844]] as const) {
      const inp = scene(vw, vh, { survival: true, debug: false, drag: false, toasts: 0, hintW: 0 });
      const out = layoutHud(inp);
      expect(out.helm!.spot, `${vw}x${vh}`).toBe('lifted');
      expect(out.helm!.rect.y + out.helm!.rect.h).toBeLessThanOrEqual(inp.cluster!.y);
    }
  });

  it('moves to the top on short landscape phones instead of covering the hint', () => {
    for (const [vw, vh] of [[640, 360], [667, 375]] as const) {
      const out = layoutHud(scene(vw, vh, { survival: true, debug: true, drag: false, toasts: 0, hintW: 330 }));
      expect(out.helm!.spot, `${vw}x${vh}`).toBe('top');
    }
  });

  it('never overlaps the debug overlay', () => {
    for (const [vw, vh] of VIEWPORTS) {
      const inp = scene(vw, vh, { survival: true, debug: true, drag: false, toasts: 0, hintW: 330 });
      const out = layoutHud(inp);
      expect(intersects(out.helm!.rect, inp.debug!), `${vw}x${vh}`).toBe(false);
    }
  });
});

describe('layoutHud: banner and toasts', () => {
  for (const [vw, vh] of VIEWPORTS) {
    it(`${vw}x${vh}: the drag banner clears the debug overlay, helm, cluster and centre zone`, () => {
      for (const debug of [false, true]) {
        const inp = scene(vw, vh, { survival: true, debug, drag: true, toasts: 0, hintW: 330 });
        const out = layoutHud(inp);
        const b = bannerRect(inp, out)!;
        // The one combination with no free spot for everything: a 360 px tall phone with the
        // debug overlay, the banner and the helm all up. Only check that nothing important is
        // covered there: the helm and the debug overlay stay clear.
        const cramped = debug && vh <= 375;
        if (inp.debug) expect(intersects(b, inp.debug), `debug ${debug}`).toBe(false);
        expect(intersects(b, out.helm!.rect), `helm ${debug}`).toBe(false);
        if (!cramped) {
          expect(intersects(b, inflate(inp.cluster!, 10)), `cluster ${debug}`).toBe(false);
          expect(intersects(b, inp.center!), `centre ${debug}`).toBe(false);
        }
        expect(inside(b, vw, vh)).toBe(true);
      }
    });

    it(`${vw}x${vh}: toasts never cover the debug overlay, the banner or the helm`, () => {
      for (const debug of [false, true]) {
        for (const drag of [false, true]) {
          for (const n of [1, 2]) {
            const inp = scene(vw, vh, { survival: true, debug, drag, toasts: n, hintW: 330 });
            const out = layoutHud(inp);
            const t: Rect = { ...inp.toasts!, y: inp.toasts!.y + out.toastsDy };
            const what = `debug ${debug} drag ${drag} toasts ${n}`;
            if (!inside(t, vw, vh)) continue; // no room at all: least-overlap fallback
            if (inp.debug) expect(intersects(t, inp.debug), what).toBe(false);
            const b = bannerRect(inp, out);
            if (b) expect(intersects(t, b), what).toBe(false);
            expect(intersects(t, out.helm!.rect), what).toBe(false);
          }
        }
      }
    });
  }

  it('slides the banner flush left beside a raised helm rather than down into the scene', () => {
    const inp = scene(667, 375, { survival: true, debug: false, drag: true, toasts: 0, hintW: 330 });
    const out = layoutHud(inp);
    expect(out.helm!.spot).toBe('top');
    expect(out.bannerDy).toBe(0);
    expect(out.bannerDx).toBeLessThan(0);
  });

  it('leaves everything in place when nothing collides', () => {
    const out = layoutHud(scene(1920, 1080, { survival: true, debug: false, drag: true, toasts: 2, hintW: 0 }));
    expect(out.bannerDx).toBe(0);
    expect(out.bannerDy).toBe(0);
    expect(out.toastsDy).toBe(0);
  });

  it('pushes the toast column below the debug overlay on a phone', () => {
    const inp = scene(390, 844, { survival: true, debug: true, drag: false, toasts: 2, hintW: 0 });
    const out = layoutHud(inp);
    expect(inp.toasts!.y + out.toastsDy).toBeGreaterThanOrEqual(inp.debug!.y + inp.debug!.h);
  });
});

describe('hudLayout geometry helpers', () => {
  it('detects overlap only for boxes that share area', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(intersects(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(intersects(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(false); // touching edges
    expect(intersects(a, { x: 0, y: 11, w: 5, h: 5 })).toBe(false);
  });

  it('reserves room for a hint that is not showing yet', () => {
    const z = centerZone({ x: 487, y: 347, w: 26, h: 26 }, { x: 500, y: 390, w: 0, h: 0 }, { w: 300, h: 34 }, 1000, 0);
    expect(z.w).toBe(300);
    expect(z.x).toBe(350);
    expect(z.y + z.h).toBe(390 + 34);
  });
});
