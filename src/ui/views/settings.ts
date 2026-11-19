/**
 * Settings: render distance, FOV, mouse sensitivity, invert Y, language, debug overlay, and the
 * player's name (package 11: kept when the field is left or Enter pressed, if the client's rule
 * accepts it; otherwise the field goes back to the stored name).
 * Sliders report live (on 'input') so FOV and distance can be previewed while dragging.
 *
 * Every control shows the stored setting from UiState, never just the player's click: the
 * switches and the language group are controlled (they move when the client's next state
 * says so), and a slider the player is holding re-syncs to the stored value once released.
 * That is also why update() may skip on settingsEq: what is on screen is always `last`.
 */
import type { UiContext } from '../context';
import { settingsEq } from '../diff';
import { clamp, formatFov, formatSensitivity } from '../format';
import { LANGUAGE_NAMES, type StringKey } from '../i18n';
import type { Language, Settings, UiState } from '../model';
import { h, setHidden } from '../dom';
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

  /**
   * Reflect the stored value. While the slider has focus the player owns it (a drag or arrow
   * key in progress), so a lagging echo from the client must not yank the thumb back; the
   * view re-syncs once focus leaves.
   */
  set(v: number, force = false): void {
    if (v === this.value && !force) return;
    if (!force && this.ctx.doc.activeElement === this.input) return;
    if (Number(this.input.value) !== v) this.input.value = String(v);
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
  private readonly nameInput: HTMLInputElement;
  private readonly nameRow: HTMLElement;
  private playerName = '';
  private last: Settings | null = null;
  /** Settings of the most recent update (reference, not a copy), for the focus-out re-sync. */
  private latest: Settings | null = null;

  /** `nameOk`: the client's rule for names (client/names.ts, given by the root). */
  constructor(
    private readonly ctx: UiContext,
    nameOk: (text: string) => boolean,
  ) {
    const d = ctx.doc;
    const a = ctx.actions;
    const titleId = ctx.id('settings');
    const mk = (key: NumericKey): Slider =>
      new Slider(ctx, SLIDERS[key], (v) => a.changeSettings({ [key]: v }));
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
      true,
    );
    this.lang.el.setAttribute('aria-labelledby', langLbl);
    this.lang.el.classList.add('bl-field-ctl');

    const field = (labelId: string, key: StringKey, ctl: HTMLElement): HTMLElement =>
      h(d, 'div', 'bl-field', null, [ctx.text(h(d, 'span', 'bl-field-label', { id: labelId }), key), ctl]);

    const nameId = ctx.id('pname');
    this.nameInput = h(d, 'input', 'bl-input bl-field-ctl bl-settings-name', { id: nameId, type: 'text', autocomplete: 'off', spellcheck: 'false', 'data-field': 'settings-name' });
    // The rule counts code points (no maxlength: it counts UTF-16 units); while the text breaks
    // it, the note under the field says the rule instead of when the name is used.
    const nameNote = ctx.text(h(d, 'span', 'bl-field-note'), 'settings.nameHint');
    const nameBad = ctx.text(h(d, 'span', 'bl-field-note bl-field-note--bad', { role: 'alert', hidden: true }), 'name.invalid');
    const showNameOk = (ok: boolean): void => {
      setHidden(nameNote, !ok);
      setHidden(nameBad, ok);
      this.nameInput.setAttribute('aria-invalid', ok ? 'false' : 'true');
    };
    const commitName = (): void => {
      const v = this.nameInput.value;
      if (v.trim() !== this.playerName && nameOk(v)) a.setPlayerName(v);
      else this.nameInput.value = this.playerName;
      showNameOk(true);
    };
    this.nameInput.addEventListener('input', () => showNameOk(nameOk(this.nameInput.value)));
    this.nameInput.addEventListener('change', commitName);
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nameInput.blur();
    });
    // Only a build that can go online uses the name (UiState.online.available).
    this.nameRow = h(d, 'div', 'bl-field bl-field--name', null, [ctx.text(h(d, 'label', 'bl-field-label', { for: nameId }), 'settings.name'), this.nameInput, nameNote, nameBad]);

    const back = button(ctx, { variant: 'primary', icon: ICON_BACK, label: 'settings.back', onClick: () => a.closeSettings() });
    this.panel = h(d, 'div', 'bl-panel bl-panel-modal bl-settings-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      ctx.text(h(d, 'h2', 'bl-panel-title bl-title-lg', { id: titleId }), 'settings.title'),
      h(d, 'section', 'bl-settings-sec', null, [ctx.text(h(d, 'h3', 'bl-subtitle'), 'settings.secDisplay'), dist.row, fov.row]),
      h(d, 'section', 'bl-settings-sec', null, [ctx.text(h(d, 'h3', 'bl-subtitle'), 'settings.secInput'), sens.row, field(invertLbl, 'settings.invertY', this.invert.el)]),
      h(d, 'section', 'bl-settings-sec', null, [
        ctx.text(h(d, 'h3', 'bl-subtitle'), 'settings.secGeneral'),
        this.nameRow,
        field(langLbl, 'settings.language', this.lang.el),
        field(debugLbl, 'settings.debug', this.debug.el),
      ]),
      h(d, 'div', 'bl-actions', null, [back]),
    ]);
    this.el = h(d, 'div', 'bl-screen bl-screen--overlay bl-settings', { hidden: true, 'data-screen': 'settings' }, [this.panel]);
    // A slider the player was holding may show a value the client clamped or refused; once it
    // lets go, snap it to the stored setting. (Done here rather than in update(): the client
    // may keep passing the very same state object, which the root skips.)
    this.panel.addEventListener('focusout', (e) => {
      const st = this.latest;
      if (!st) return;
      if (e.target === dist.input) dist.set(st.renderDistance, true);
      else if (e.target === fov.input) fov.set(st.fov, true);
      else if (e.target === sens.input) sens.set(st.sensitivity, true);
    });
  }

  update(s: UiState): void {
    setHidden(this.nameRow, !s.online.available);
    if (s.online.playerName !== this.playerName) {
      this.playerName = s.online.playerName;
      if (this.ctx.doc.activeElement !== this.nameInput) this.nameInput.value = this.playerName;
    }
    const st = s.settings;
    this.latest = st;
    if (this.last && settingsEq(this.last, st)) return;
    this.last = { ...st };
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
