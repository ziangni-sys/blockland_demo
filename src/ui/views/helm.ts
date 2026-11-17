/**
 * Helm instrument, shown while the player holds a ship's wheel: an engine-telegraph style
 * throttle lever, a rudder-angle dial (port red / starboard green, the nautical convention),
 * a speed log in blocks per second and the sail count. Browser-only.
 */
import type { UiContext } from '../context';
import { helmEq } from '../diff';
import { finite, formatSpeed, formatThrottle, RUDDER_MAX_DEG, rudderAngle, throttleLever, throttleNotch, type ThrottleNotch } from '../format';
import type { StringKey } from '../i18n';
import type { HelmView } from '../model';
import { h, setHidden, svg, TextSlot } from '../dom';

/**
 * Lever notches, top (full ahead) to bottom (full astern). Symmetric like a real engine
 * telegraph: the astern side has its own Half, told apart from the ahead one by its side of
 * Stop and its colour, as on a brass telegraph dial.
 */
const NOTCHES: ReadonlyArray<{ at: number; id: ThrottleNotch; key: StringKey }> = [
  { at: 1, id: 'full', key: 'helm.full' },
  { at: 0.5, id: 'half', key: 'helm.half' },
  { at: 0, id: 'stop', key: 'helm.stop' },
  { at: -0.5, id: 'halfAstern', key: 'helm.half' },
  { at: -1, id: 'astern', key: 'helm.astern' },
];

const DIAL_CX = 60;
const DIAL_CY = 62;

/** Point on the dial at `deg` from vertical (clockwise positive) and radius r. */
function dialPt(deg: number, r: number): string {
  const a = (deg * Math.PI) / 180;
  return `${(DIAL_CX + r * Math.sin(a)).toFixed(2)} ${(DIAL_CY - r * Math.cos(a)).toFixed(2)}`;
}

function dialMarkup(): string {
  const ticks: string[] = [];
  for (let deg = -RUDDER_MAX_DEG; deg <= RUDDER_MAX_DEG; deg += 10) {
    const major = deg % 20 === 0;
    ticks.push(`<path class="bl-dial-tick${major ? ' is-major' : ''}" d="M${dialPt(deg, major ? 37 : 40)} L${dialPt(deg, 45)}"/>`);
  }
  const m = RUDDER_MAX_DEG;
  return `<svg viewBox="0 0 120 70">
    <path class="bl-dial-face" d="M4 ${DIAL_CY} A56 56 0 0 1 116 ${DIAL_CY} Z"/>
    <path class="bl-dial-port" d="M${dialPt(-m, 50)} A50 50 0 0 1 ${dialPt(-4, 50)}"/>
    <path class="bl-dial-stbd" d="M${dialPt(4, 50)} A50 50 0 0 1 ${dialPt(m, 50)}"/>
    ${ticks.join('')}
    <g class="bl-dial-needle" style="transform-box: view-box; transform-origin: ${DIAL_CX}px ${DIAL_CY}px">
      <path d="M${DIAL_CX} 16 L${DIAL_CX + 3.2} ${DIAL_CY} L${DIAL_CX - 3.2} ${DIAL_CY} Z"/>
    </g>
    <circle class="bl-dial-hub" cx="${DIAL_CX}" cy="${DIAL_CY}" r="5"/>
  </svg>`;
}

const SAIL_GLYPH = '<svg viewBox="0 0 16 16"><path d="M7 1.5v12.5H2.5L7 1.5zM8.5 3.5c3 2.5 4.5 6 4.5 10.5H8.5V3.5zM1.5 15h13v.8h-13z"/></svg>';

export class HelmInstrument {
  readonly el: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly lever: HTMLElement;
  private readonly needle: SVGGElement;
  private readonly notchEls: HTMLElement[] = [];
  private readonly thr: TextSlot;
  private readonly speed: TextSlot;
  private readonly sails: TextSlot;
  private last: HelmView | null = null;
  private leverPos = -1;
  private angle = NaN;
  private near = -1;

  constructor(ctx: UiContext) {
    const d = ctx.doc;
    this.thr = new TextSlot(d);
    this.speed = new TextSlot(d);
    this.sails = new TextSlot(d);

    const scale = h(d, 'div', 'bl-lever-scale', { 'aria-hidden': 'true' });
    for (const n of NOTCHES) {
      const span = ctx.text(h(d, 'span', n.at < 0 ? 'is-astern' : n.at > 0 ? 'is-ahead' : null), n.key);
      span.style.top = `${((1 - (n.at + 1) / 2) * 100).toFixed(1)}%`;
      this.notchEls.push(span);
      scale.appendChild(span);
    }
    this.knob = h(d, 'div', 'bl-lever-knob');
    this.lever = h(d, 'div', 'bl-lever', { role: 'meter', 'aria-valuemin': '-100', 'aria-valuemax': '100' }, [scale, h(d, 'div', 'bl-lever-track', null, [this.knob])]);
    ctx.attr(this.lever, 'aria-label', 'helm.throttle');

    const dialSvg = svg(d, dialMarkup());
    this.needle = dialSvg.querySelector('.bl-dial-needle') as SVGGElement;
    const dial = h(d, 'div', 'bl-dial', null, [
      dialSvg,
      h(d, 'div', 'bl-dial-labels', { 'aria-hidden': 'true' }, [ctx.text(h(d, 'span', 'bl-port'), 'helm.port'), ctx.text(h(d, 'span', 'bl-stbd'), 'helm.starboard')]),
      ctx.text(h(d, 'div', 'bl-dial-cap'), 'helm.rudder'),
    ]);

    const speedEl = h(d, 'div', 'bl-helm-speed');
    speedEl.appendChild(this.speed.node);
    const sailsB = h(d, 'b');
    sailsB.appendChild(this.sails.node);
    const read = h(d, 'div', 'bl-helm-read', null, [
      ctx.text(h(d, 'div', 'bl-helm-label'), 'helm.speed'),
      speedEl,
      ctx.text(h(d, 'div', 'bl-helm-unit'), 'helm.speedUnit'),
      h(d, 'div', 'bl-helm-sails', null, [svg(d, SAIL_GLYPH), ctx.text(h(d, 'span'), 'helm.sails'), sailsB]),
    ]);

    const thrEl = h(d, 'span', 'bl-helm-thr');
    thrEl.appendChild(this.thr.node);
    this.el = h(d, 'div', 'bl-helm bl-play', { hidden: true, role: 'group' }, [
      h(d, 'div', 'bl-helm-head', null, [ctx.text(h(d, 'span', 'bl-helm-title'), 'helm.title'), thrEl]),
      h(d, 'div', 'bl-helm-body', null, [this.lever, dial, read]),
    ]);
    ctx.attr(this.el, 'aria-label', 'helm.title');
  }

  update(raw: HelmView | null): void {
    // Sanitize before the memo so a NaN field (0/0 upstream) does not defeat it every frame.
    const v = raw ? { throttle: finite(raw.throttle), rudder: finite(raw.rudder), speed: finite(raw.speed), sails: finite(raw.sails) } : null;
    if (helmEq(v, this.last)) return;
    this.last = v;
    setHidden(this.el, !v);
    if (!v) return;

    const pos = throttleLever(v.throttle);
    if (pos !== this.leverPos) {
      this.leverPos = pos;
      this.knob.style.setProperty('--t', pos.toFixed(3));
      this.lever.setAttribute('aria-valuenow', String(Math.round(Math.max(-1, Math.min(1, v.throttle)) * 100)));
    }
    const notch = throttleNotch(v.throttle);
    const near = NOTCHES.findIndex((n) => n.id === notch);
    if (near !== this.near) {
      if (this.near >= 0) this.notchEls[this.near]!.classList.remove('is-near');
      this.notchEls[near]!.classList.add('is-near');
      this.near = near;
    }
    this.thr.set(formatThrottle(v.throttle));

    const angle = rudderAngle(v.rudder);
    if (angle !== this.angle) {
      this.angle = angle;
      this.needle.style.transform = `rotate(${angle}deg)`;
    }
    this.speed.set(formatSpeed(v.speed));
    this.sails.set(String(Math.max(0, Math.round(v.sails))));
  }
}
