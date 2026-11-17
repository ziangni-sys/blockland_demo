/**
 * Survival gauges: a segmented vitality bar (skewed segments with a lagging "damage trail")
 * and a breath arc that appears only while the player is short of air. No hearts, no
 * bubbles. Browser-only.
 */
import type { UiContext } from '../context';
import { arcDash, formatHealth, healthSegments, quantize, ratio, segmentFills } from '../format';
import { h, restartAnimation, svg, TextSlot } from '../dom';

const PULSE_GLYPH = '<svg viewBox="0 0 18 14"><path d="M1 7.5h3.6l1.8-4.6 2.9 9 2.2-6.2 1.3 1.8H17"/></svg>';

export class VitalGauge {
  readonly el: HTMLElement;
  private readonly segsEl: HTMLElement;
  private fills: HTMLElement[] = [];
  private trails: HTMLElement[] = [];
  private readonly num: TextSlot;
  private readonly fillBuf: number[] = [];
  private segCount = -1;
  private health = NaN;
  private max = NaN;
  private low: boolean | null = null;

  constructor(private readonly ctx: UiContext) {
    const d = ctx.doc;
    this.num = new TextSlot(d);
    this.segsEl = h(d, 'div', 'bl-vital-segs');
    const numEl = h(d, 'span', 'bl-vital-num', { 'aria-hidden': 'true' });
    numEl.appendChild(this.num.node);
    this.el = h(d, 'div', 'bl-vital', { role: 'meter', 'aria-valuemin': '0' }, [svg(d, PULSE_GLYPH, 'bl-vital-glyph'), this.segsEl, numEl]);
    ctx.attr(this.el, 'aria-label', 'hud.health');
  }

  update(health: number, max: number): void {
    if (health === this.health && max === this.max) return;
    const wasHealth = this.health;
    this.health = health;
    this.max = max;
    const n = healthSegments(max);
    if (n !== this.segCount) this.buildSegments(n);
    segmentFills(health, max, n, this.fillBuf);
    for (let i = 0; i < n; i++) {
      const tr = `scaleX(${this.fillBuf[i]!.toFixed(3)})`;
      this.fills[i]!.style.transform = tr;
      this.trails[i]!.style.transform = tr;
    }
    this.num.set(formatHealth(health, max));
    this.el.setAttribute('aria-valuemax', String(Math.round(max)));
    this.el.setAttribute('aria-valuenow', String(Math.ceil(Math.max(0, health))));
    const low = ratio(health, max) <= 0.25;
    if (low !== this.low) {
      this.low = low;
      this.el.dataset.low = low ? '1' : '0';
    }
    // Flash on damage (not on the first render, not on healing).
    if (health < wasHealth && !this.ctx.reducedMotion) restartAnimation(this.el, 'is-hit');
  }

  private buildSegments(n: number): void {
    const d = this.ctx.doc;
    this.segCount = n;
    this.segsEl.textContent = '';
    this.fills = [];
    this.trails = [];
    for (let i = 0; i < n; i++) {
      const trail = h(d, 'b', 'bl-seg-trail');
      const fill = h(d, 'b', 'bl-seg-fill');
      this.trails.push(trail);
      this.fills.push(fill);
      this.segsEl.appendChild(h(d, 'i', 'bl-seg', null, [trail, fill]));
    }
  }
}

/** Fraction of the circle the breath arc sweeps; the gap sits at the bottom. */
const BREATH_SWEEP = 300 / 360;
const BREATH_R = 15.5;
const BREATH_CIRC = 2 * Math.PI * BREATH_R;

export class BreathGauge {
  readonly el: HTMLElement;
  private readonly fill: SVGCircleElement;
  private shown: boolean | null = null;
  private level = -1;
  private low: boolean | null = null;

  constructor(ctx: UiContext) {
    const d = ctx.doc;
    // Rotated 120° so the 300° arc starts bottom-left and its gap is centred at the bottom.
    const markup = `<svg viewBox="0 0 40 40">
      <circle class="bl-breath-disc" cx="20" cy="20" r="19"/>
      <g transform="rotate(120 20 20)">
        <circle class="bl-breath-track" cx="20" cy="20" r="${BREATH_R}" stroke-dasharray="${arcDash(1, BREATH_SWEEP, BREATH_CIRC)}"/>
        <circle class="bl-breath-fill" cx="20" cy="20" r="${BREATH_R}" stroke-dasharray="${arcDash(1, BREATH_SWEEP, BREATH_CIRC)}"/>
      </g>
      <path class="bl-breath-glyph" d="M12.5 17.5c1.6-1.4 3.1-1.4 4.6 0s3.1 1.4 4.6 0 3.1-1.4 4.6 0M12.5 22.5c1.6-1.4 3.1-1.4 4.6 0s3.1 1.4 4.6 0 3.1-1.4 4.6 0"/>
    </svg>`;
    const s = svg(d, markup);
    this.fill = s.querySelector('.bl-breath-fill') as SVGCircleElement;
    this.el = h(d, 'div', 'bl-breath', { 'data-show': '0', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [s]);
    ctx.attr(this.el, 'aria-label', 'hud.breath');
  }

  update(air: number, maxAir: number): void {
    const show = maxAir > 0 && air < maxAir;
    if (show !== this.shown) {
      this.shown = show;
      this.el.dataset.show = show ? '1' : '0';
      this.el.setAttribute('aria-hidden', show ? 'false' : 'true');
    }
    if (!show) return;
    // 120 levels is finer than the eye can tell on a ~40 px arc and keeps DOM writes rare.
    const level = quantize(ratio(air, maxAir), 120);
    if (level !== this.level) {
      this.level = level;
      this.fill.setAttribute('stroke-dasharray', arcDash(level, BREATH_SWEEP, BREATH_CIRC));
      this.el.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    }
    const low = level <= 0.2;
    if (low !== this.low) {
      this.low = low;
      this.el.dataset.low = low ? '1' : '0';
    }
  }
}
