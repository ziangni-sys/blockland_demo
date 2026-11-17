/**
 * Main menu: logotype, saved-world list (play / delete with an in-page confirm step — the
 * host has no window.confirm), new-world form, settings button, controls cheat-sheet and a
 * renderer / version line, over a blueprint backdrop with a faint construction drawing.
 */
import { CHEAT_SHEET } from '../controls';
import type { UiContext } from '../context';
import { worldsEq } from '../diff';
import { formatLastPlayed } from '../format';
import type { GameMode, Screen, UiState, WorldSummary } from '../model';
import { h, svg, TextSlot } from '../dom';
import { focusInto, type ScreenView } from './screen';
import { buildLogo, button, ICON_SLIDERS, ICON_TRASH, keyTable, Segmented } from './widgets';

/** Side elevation of a raft with a four-sail rotor, drawn like a shipwright's plan. */
function draftMarkup(): string {
  let wave = 'M0 322';
  for (let x = 0; x < 600; x += 30) wave += ` q 7.5 -5 15 0 t 15 0`;
  let deck = '';
  for (let x = 100; x < 530; x += 30) deck += `M${x} 262 V290 `;
  const blade = (deg: number): string =>
    `<g transform="rotate(${deg} 300 112)"><path d="M300 106 V22"/><path d="M302 96 H326 V28 H302 Z M302 73 H326 M302 51 H326"/></g>`;
  return `<svg viewBox="0 0 600 420" preserveAspectRatio="xMaxYMax meet">
    <path class="bl-d-dash" d="M300 0 V400"/>
    <circle class="bl-d-dash" cx="300" cy="112" r="96"/>
    ${blade(18)}${blade(108)}${blade(198)}${blade(288)}
    <circle cx="300" cy="112" r="6"/>
    <path d="M286 98 H314 V126 H286 Z M293 126 V262 M307 126 V262"/>
    <path d="M70 262 H530 V290 H70 Z ${deck}"/>
    <path d="M70 290 H530 L496 338 H104 Z"/>
    <path class="bl-d-dash" d="M88 314 H512"/>
    <path d="M128 262 V232"/><circle cx="128" cy="222" r="11"/><path d="M128 211 V233 M117 222 H139 M120 214 L136 230 M136 214 L120 230"/>
    <path d="${wave}"/>
    <path d="M70 352 V384 M530 352 V384 M70 372 H530 M70 372 l8 -3 M70 372 l8 3 M530 372 l-8 -3 M530 372 l-8 3"/>
    <text x="300" y="366" text-anchor="middle">16</text>
    <path d="M396 112 H452 M452 16 V112 M446 16 H458 M446 112 H458"/>
    <text x="462" y="68">R 3</text>
    <path d="M410 392 H592 V416 H410 Z M470 392 V416 M540 392 V416"/>
    <text x="418" y="409">BL-01</text><text x="478" y="409">1:48</text><text x="548" y="409">A3</text>
  </svg>`;
}

export class MainMenuView implements ScreenView {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly seedInput: HTMLInputElement;
  private readonly modeSeg: Segmented<GameMode>;
  private readonly modeHint: HTMLElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly renderer: TextSlot;
  private readonly version: TextSlot;
  private mode: GameMode = 'creative';
  private worlds: readonly WorldSummary[] | null = null;
  private confirmId: string | null = null;
  private listLang: string | null = null;

  constructor(private readonly ctx: UiContext) {
    const d = ctx.doc;
    const a = ctx.actions;

    // ---- header
    this.settingsBtn = button(ctx, { variant: 'ghost', icon: ICON_SLIDERS, label: 'menu.settings', cls: 'bl-menu-settings', onClick: () => a.openSettings() });
    const head = h(d, 'header', 'bl-menu-head', null, [
      h(d, 'div', 'bl-menu-brand', null, [buildLogo(ctx), ctx.text(h(d, 'p', 'bl-tagline'), 'brand.tagline')]),
      this.settingsBtn,
    ]);

    // ---- saved worlds
    this.countEl = h(d, 'span', 'bl-count');
    this.list = h(d, 'ul', 'bl-world-list');
    this.list.addEventListener('click', (e) => this.onListClick(e));
    this.list.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.confirmId !== null) {
        // Cancel the pending delete instead of letting the client treat Esc as "back".
        e.stopPropagation();
        e.preventDefault();
        this.setConfirm(null, true);
      }
    });
    const worldsTitleId = ctx.id('worlds');
    const worlds = h(d, 'section', 'bl-panel bl-worlds', { 'aria-labelledby': worldsTitleId }, [
      h(d, 'h2', 'bl-panel-title', { id: worldsTitleId }, [ctx.text(h(d, 'span'), 'menu.worlds'), this.countEl]),
      this.list,
    ]);

    // ---- new world form
    const nameId = ctx.id('wname');
    const seedId = ctx.id('wseed');
    const modeLblId = ctx.id('wmode');
    this.nameInput = h(d, 'input', 'bl-input', { id: nameId, type: 'text', maxlength: 48, autocomplete: 'off', spellcheck: 'false' });
    ctx.attr(this.nameInput, 'placeholder', 'menu.defaultWorldName');
    this.seedInput = h(d, 'input', 'bl-input bl-num-input', { id: seedId, type: 'text', maxlength: 64, autocomplete: 'off', spellcheck: 'false' });
    ctx.attr(this.seedInput, 'placeholder', 'menu.seedPlaceholder');
    this.modeSeg = new Segmented<GameMode>(
      ctx,
      [
        { value: 'creative', label: 'mode.creative' },
        { value: 'survival', label: 'mode.survival' },
      ],
      'menu.mode',
      (m) => this.setMode(m),
    );
    this.modeSeg.el.setAttribute('aria-labelledby', modeLblId);
    this.modeHint = h(d, 'p', 'bl-form-hint');
    const submit = h(d, 'button', 'bl-btn bl-btn--primary bl-form-submit', { type: 'submit' });
    ctx.text(submit, 'menu.create');
    const form = h(d, 'form', 'bl-form', { novalidate: true }, [
      ctx.text(h(d, 'label', null, { for: nameId }), 'menu.worldName'),
      this.nameInput,
      ctx.text(h(d, 'label', null, { for: seedId }), 'menu.seed'),
      this.seedInput,
      ctx.text(h(d, 'span', 'bl-form-label', { id: modeLblId }), 'menu.mode'),
      this.modeSeg.el,
      this.modeHint,
      submit,
    ]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.create();
    });
    this.setMode('creative');
    const newTitleId = ctx.id('newworld');
    const newWorld = h(d, 'section', 'bl-panel bl-newworld', { 'aria-labelledby': newTitleId }, [
      ctx.text(h(d, 'h2', 'bl-panel-title', { id: newTitleId }), 'menu.newWorld'),
      form,
    ]);

    // ---- cheat-sheet
    const cheatTitleId = ctx.id('cheats');
    const cheats = h(d, 'section', 'bl-panel bl-cheats', { 'aria-labelledby': cheatTitleId }, [
      ctx.text(h(d, 'h2', 'bl-panel-title', { id: cheatTitleId }), 'menu.controls'),
      keyTable(ctx, CHEAT_SHEET),
    ]);

    // ---- footer
    this.renderer = new TextSlot(d);
    this.version = new TextSlot(d);
    const foot = h(d, 'footer', 'bl-menu-foot', null, [
      h(d, 'div', null, null, [
        h(d, 'span', null, null, [ctx.text(h(d, 'span'), 'menu.renderer'), ' ', h(d, 'b', null, null, [this.renderer.node])]),
        h(d, 'span', null, null, [ctx.text(h(d, 'span'), 'menu.version'), ' ', h(d, 'b', null, null, [this.version.node])]),
      ]),
      h(d, 'div', null, null, ['Blocklands · 方块大陆']),
    ]);

    this.el = h(d, 'div', 'bl-screen bl-screen--opaque bl-menu', { hidden: true, 'data-screen': 'mainMenu' }, [
      h(d, 'div', 'bl-menu-draft', { 'aria-hidden': 'true' }, [svg(d, draftMarkup())]),
      h(d, 'div', 'bl-menu-inner', null, [head, h(d, 'div', 'bl-menu-grid', null, [worlds, newWorld, cheats]), foot]),
    ]);
  }

  update(s: UiState): void {
    if (this.worlds === null || !worldsEq(this.worlds, s.worlds) || this.listLang !== this.ctx.lang) {
      // Copy: the client may mutate and re-send the same array.
      this.worlds = s.worlds.map((w) => ({ ...w }));
      if (this.confirmId !== null && !s.worlds.some((w) => w.id === this.confirmId)) this.confirmId = null;
      this.renderList();
    }
    this.renderer.set(s.renderer);
    this.version.set(s.version);
  }

  onShow(_s: UiState, from: Screen | null): void {
    if (from === 'settings') focusInto(this.settingsBtn);
  }

  onHide(): void {
    this.confirmId = null;
    this.listLang = null; // re-render (and drop any confirm row) next time
  }

  relocalize(): void {
    this.setMode(this.mode);
    this.listLang = null;
  }

  dispose(): void {
    this.el.remove();
  }

  // ------------------------------------------------------------------ internals

  private setMode(m: GameMode): void {
    this.mode = m;
    this.modeSeg.set(m);
    this.modeHint.textContent = this.ctx.t(m === 'creative' ? 'menu.modeCreativeHint' : 'menu.modeSurvivalHint');
  }

  private create(): void {
    const name = this.nameInput.value.trim() || this.ctx.t('menu.defaultWorldName');
    const seed = this.seedInput.value.trim();
    this.nameInput.blur();
    this.seedInput.blur();
    this.nameInput.value = '';
    this.seedInput.value = '';
    this.ctx.actions.newWorld({ name, seed, mode: this.mode });
  }

  private onListClick(e: MouseEvent): void {
    const target = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!target) return;
    const id = target.closest<HTMLElement>('[data-id]')?.dataset.id;
    if (id === undefined) return;
    switch (target.dataset.act) {
      case 'play':
        this.ctx.actions.loadWorld(id);
        break;
      case 'delete':
        this.setConfirm(id, true);
        break;
      case 'confirm':
        this.confirmId = null;
        this.ctx.actions.deleteWorld(id);
        this.renderList();
        break;
      case 'cancel':
        this.setConfirm(null, true);
        break;
    }
  }

  private setConfirm(id: string | null, moveFocus: boolean): void {
    const prev = this.confirmId;
    this.confirmId = id;
    this.renderList();
    if (!moveFocus) return;
    // Focus the safe choice when asking; return focus to the row's delete button on cancel.
    if (id !== null) this.focusRowControl(id, 'cancel');
    else if (prev !== null) this.focusRowControl(prev, 'delete');
  }

  private focusRowControl(id: string, act: string): void {
    for (const el of this.list.querySelectorAll<HTMLElement>(`[data-act="${act}"]`)) {
      if (el.closest<HTMLElement>('[data-id]')?.dataset.id === id) {
        el.focus({ preventScroll: false });
        return;
      }
    }
  }

  private renderList(): void {
    const ctx = this.ctx;
    const d = ctx.doc;
    const worlds = this.worlds ?? [];
    this.listLang = ctx.lang;
    // Remember keyboard focus inside the list across the rebuild.
    const active = d.activeElement as HTMLElement | null;
    let refocus: { id: string; act: string } | null = null;
    if (active && this.list.contains(active) && active.dataset.act) {
      const id = active.closest<HTMLElement>('[data-id]')?.dataset.id;
      if (id !== undefined) refocus = { id, act: active.dataset.act };
    }

    this.countEl.textContent = worlds.length > 0 ? ctx.t('menu.worldCount', { n: worlds.length }) : '';
    this.list.textContent = '';
    if (worlds.length === 0) {
      this.list.appendChild(
        h(d, 'li', 'bl-empty', null, [h(d, 'strong', null, null, [ctx.t('menu.noWorlds')]), h(d, 'span', null, null, [ctx.t('menu.noWorldsHint')])]),
      );
      return;
    }
    const now = Date.now();
    for (const w of worlds) this.list.appendChild(w.id === this.confirmId ? this.confirmRow(w) : this.worldRow(w, now));
    if (refocus) this.focusRowControl(refocus.id, refocus.act);
  }

  private worldRow(w: WorldSummary, now: number): HTMLElement {
    const ctx = this.ctx;
    const d = ctx.doc;
    const lang = ctx.lang;
    const play = h(d, 'button', 'bl-btn bl-btn--primary', { type: 'button', 'data-act': 'play', 'aria-label': ctx.t('menu.playWorldLabel', { name: w.name }) }, [
      ctx.t('menu.play'),
    ]);
    const del = h(d, 'button', 'bl-btn bl-btn--danger bl-btn--icon', {
      type: 'button',
      'data-act': 'delete',
      'aria-label': ctx.t('menu.deleteWorldLabel', { name: w.name }),
      title: ctx.t('menu.delete'),
    });
    del.appendChild(svg(d, ICON_TRASH));
    const modeKey = w.mode === 'survival' ? 'mode.survival' : 'mode.creative';
    return h(d, 'li', 'bl-world', { 'data-id': w.id }, [
      h(d, 'div', 'bl-world-main', null, [
        h(d, 'div', 'bl-world-name', { title: w.name }, [w.name]),
        h(d, 'div', 'bl-world-meta', null, [
          h(d, 'span', `bl-badge bl-badge--${w.mode === 'survival' ? 'survival' : 'creative'}`, null, [ctx.t(modeKey)]),
          h(d, 'span', 'bl-world-seed', { title: w.seed }, [h(d, 'em', null, null, [ctx.t('menu.seed')]), w.seed || '—']),
          h(d, 'span', 'bl-world-time', { title: ctx.t('menu.lastPlayed') }, [formatLastPlayed(w.lastPlayed, now, lang)]),
        ]),
      ]),
      h(d, 'div', 'bl-world-actions', null, [play, del]),
    ]);
  }

  private confirmRow(w: WorldSummary): HTMLElement {
    const ctx = this.ctx;
    const d = ctx.doc;
    const msgId = ctx.id('confirm');
    return h(d, 'li', 'bl-world bl-world--confirm', { 'data-id': w.id, role: 'alertdialog', 'aria-labelledby': msgId }, [
      h(d, 'p', 'bl-world-confirm', { id: msgId }, [ctx.t('menu.confirmDelete', { name: w.name })]),
      h(d, 'div', 'bl-world-actions', null, [
        h(d, 'button', 'bl-btn bl-btn--solid-danger', { type: 'button', 'data-act': 'confirm' }, [ctx.t('menu.confirmYes')]),
        h(d, 'button', 'bl-btn bl-btn--ghost', { type: 'button', 'data-act': 'cancel' }, [ctx.t('menu.cancel')]),
      ]),
    ]);
  }
}
