/**
 * Settings: render distance, FOV, mouse sensitivity, invert Y, language, debug overlay.
 * Sliders report live (on 'input') so FOV and distance can be previewed while dragging.
 */
import type { UiContext } from '../context';
import { clamp, formatFov, formatSensitivity } from '../format';
import { LANGUAGE_NAMES, type StringKey } from '../i18n';
import type { Language, Settings, UiState } from '../model';
import { h } from '../dom';
import { focusInto, type ScreenView } from './screen';
import { button, ICON_BACK, Segmented, Switch } from './widgets';

type NumericKey = 'renderDistance' | 'fov' | 'sensitivity';

interface SliderSpec {
  key: NumericKey;
  label: StringKey;
  min: number;
  max: number;
  step: number;
  format: (ctx: UiContext, v: number) => string;
}

const SLIDERS: Readonly<Record<NumericKey, SliderSpec>> = {
  renderDistance: { key: 'renderDistance', label: 'settings.renderDistance', min: 4, max: 16, step: 1, format: (c, v) => c.t('settings.chunks', { n: Math.round(v) }) },
  fov: { key: 'fov', label: 'settings.fov', min: 50, max: 110, step: 1, format: (_c, v) => formatFov(v) },
  sensitivity: { key: 'sensitivity', label: 'settings.sensitivity', min: 0.2, max: 3, step: 0.05, format: (_c, v) => formatSensitivity(v) },
};

class Slider {
  readonly row: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly out: HTMLOutputElement;
  private value = NaN;

  constructor(
    private readonly ctx: UiContext,
    private readonly spec: SliderSpec,
    onChange: (v: number) => void,
  ) {
    const d = ctx.doc;
    const id = ctx.id(spec.key);
    this.input = h(d, 'input', 'bl-range', { id, type: 'range', min: spec.min, max: spec.max, step: spec.step });
    this.out = h(d, 'output', 'bl-field-val', { for: id });
    this.input.addEventListener('input', () => {
      const v = clamp(Number(this.input.value), spec.min, spec.max);
      this.show(v);
      onChange(v);
    });
    this.row = h(d, 'div', 'bl-field', null, [ctx.text(h(d, 'label', 'bl-field-label', { for: id }), spec.label), this.input, this.out]);
  }

  set(v: number, force = false): void {
    if (v === this.value && !force) return;
    // Don't fight the thumb while it is being dragged: the client echoes what we sent.
    if (this.ctx.doc.activeElement !== this.input || Number(this.input.value) !== v) this.input.value = String(v);
    this.show(v);
  }

  private show(v: number): void {
    this.value = v;
    const s = this.spec;
    this.input.style.setProperty('--p', `${(((clamp(v, s.min, s.max) - s.min) / (s.max - s.min)) * 100).toFixed(1)}%`);
    const text = s.format(this.ctx, v);
    if (this.out.value !== text) this.out.value = text;
    this.input.setAttribute('aria-valuetext', text);
  }

  relocalize(): void {
    if (!Number.isNaN(this.value)) this.set(this.value, true);
  }
}

export class SettingsView implements ScreenView {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly sliders: Slider[];
  private readonly invert: Switch;
  private readonly debug: Switch;
  private readonly lang: Segmented<Language>;
  private last: Settings | null = null;

  constructor(private readonly ctx: UiContext) {
    const d = ctx.doc;
    const a = ctx.actions;
    const titleId = ctx.id('settings');
    const mk = (key: NumericKey): Slider => new Slider(ctx, SLIDERS[key], (v) => a.changeSettings({ [key]: v }));
    const dist = mk('renderDistance');
    const fov = mk('fov');
    const sens = mk('sensitivity');
    this.sliders = [dist, fov, sens];

    const invertLbl = ctx.id('invert');
    this.invert = new Switch(ctx, invertLbl, (v) => a.changeSettings({ invertY: v }));
    const debugLbl = ctx.id('debug');
    this.debug = new Switch(ctx, debugLbl, (v) => a.changeSettings({ showDebug: v }));
    const langLbl = ctx.id('lang');
    this.lang = new Segmented<Language>(
      ctx,
      [
        { value: 'zh', label: { literal: LANGUAGE_NAMES.zh } },
        { value: 'en', label: { literal: LANGUAGE_NAMES.en } },
      ],
      'settings.language',
      (l) => a.changeSettings({ language: l }),
    );
    this.lang.el.setAttribute('aria-labelledby', langLbl);
    this.lang.el.classList.add('bl-field-ctl');

    const field = (labelId: string, key: StringKey, ctl: HTMLElement): HTMLElement =>
      h(d, 'div', 'bl-field', null, [ctx.text(h(d, 'span', 'bl-field-label', { id: labelId }), key), ctl]);

    const back = button(ctx, { variant: 'primary', icon: ICON_BACK, label: 'settings.back', onClick: () => a.closeSettings() });
    this.panel = h(d, 'div', 'bl-panel bl-panel-modal bl-settings-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      ctx.text(h(d, 'h2', 'bl-panel-title bl-title-lg', { id: titleId }), 'settings.title'),
      h(d, 'section', 'bl-settings-sec', null, [ctx.text(h(d, 'h3', 'bl-subtitle'), 'settings.secDisplay'), dist.row, fov.row]),
      h(d, 'section', 'bl-settings-sec', null, [ctx.text(h(d, 'h3', 'bl-subtitle'), 'settings.secInput'), sens.row, field(invertLbl, 'settings.invertY', this.invert.el)]),
      h(d, 'section', 'bl-settings-sec', null, [
        ctx.text(h(d, 'h3', 'bl-subtitle'), 'settings.secGeneral'),
        field(langLbl, 'settings.language', this.lang.el),
        field(debugLbl, 'settings.debug', this.debug.el),
      ]),
      h(d, 'div', 'bl-actions', null, [back]),
    ]);
    this.el = h(d, 'div', 'bl-screen bl-screen--overlay bl-settings', { hidden: true, 'data-screen': 'settings' }, [this.panel]);
  }

  update(s: UiState): void {
    const st = s.settings;
    if (this.last === st) return;
    this.last = st;
    this.sliders[0]!.set(st.renderDistance);
    this.sliders[1]!.set(st.fov);
    this.sliders[2]!.set(st.sensitivity);
    this.invert.set(st.invertY);
    this.debug.set(st.showDebug);
    this.lang.set(st.language);
  }

  onShow(): void {
    focusInto(this.panel);
  }
  onHide(): void {}

  relocalize(): void {
    for (const s of this.sliders) s.relocalize();
    this.invert.relocalize();
    this.debug.relocalize();
  }

  dispose(): void {
    this.el.remove();
  }
}
