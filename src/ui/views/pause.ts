/**
 * Pause menu: resume, settings, play together, creative/survival toggle, save & quit, full
 * controls reference. When the world's server failed (worldStopped) it says so under the title and
 * cannot resume or switch modes; "Quit without saving" is offered beside "Save & quit".
 *
 * Playing together (package 11): a world open to friends, or a guest's, does not pause: the title
 * is "Menu" with a line saying the game goes on. "Play together" (the host; "Players" for a guest)
 * opens the room screen and shows "Room open · n/4" while the room is open. A guest has no mode
 * switch (only the host changes modes) and "Leave the room" in place of "Save & quit". A build
 * that cannot go online has no "Play together".
 */
import type { UiContext } from '../context';
import type { GameMode, Screen, UiState } from '../model';
import { h, setHidden, TextSlot } from '../dom';
import { focusInto, type ScreenView } from './screen';
import { button, controlsReference, ICON_CLOSE, ICON_LEAVE, ICON_PEOPLE, ICON_RESUME, ICON_SAVE, ICON_SLIDERS, Segmented } from './widgets';

export class PauseView implements ScreenView {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly togetherBtn: HTMLButtonElement;
  private readonly togetherLabel: HTMLElement;
  private readonly togetherBadge: HTMLElement;
  private readonly togetherBadgeText: TextSlot;
  private readonly modeSeg: Segmented<GameMode>;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly modeEl: HTMLElement;
  private readonly title: HTMLElement;
  private readonly runningNote: HTMLElement;
  /** Shown only in a stopped world. */
  private readonly stoppedNote: HTMLElement;
  /** Shown after a failed "Save & quit" (with its notice) and in a stopped world: the explicit unsaved exit. */
  private readonly unsaved: HTMLElement;
  private readonly saveFailedNote: HTMLElement;
  private readonly quitBtn: HTMLButtonElement;
  private readonly leaveBtn: HTMLButtonElement;
  private role: 'host' | 'guest' | null = null;
  private room: { n: number; max: number } | null = null;

  constructor(private readonly ctx: UiContext) {
    const d = ctx.doc;
    const a = ctx.actions;
    const titleId = ctx.id('pause');
    const modeLbl = ctx.id('pmode');
    this.resumeBtn = button(ctx, { variant: 'primary', icon: ICON_RESUME, label: 'pause.resume', cls: 'bl-btn--wide', onClick: () => a.resume() });
    this.settingsBtn = button(ctx, { icon: ICON_SLIDERS, label: 'pause.settings', cls: 'bl-btn--wide', onClick: () => a.openSettings() });
    this.togetherBadgeText = new TextSlot(d);
    this.togetherBadge = h(d, 'span', 'bl-badge bl-badge--live', { hidden: true }, [this.togetherBadgeText.node]);
    this.togetherLabel = ctx.text(h(d, 'span', 'bl-btn-label'), 'pause.together');
    this.togetherBtn = button(ctx, { icon: ICON_PEOPLE, cls: 'bl-btn--wide bl-pause-together', onClick: () => a.openRoomScreen() });
    this.togetherBtn.classList.remove('bl-btn--icon');
    this.togetherBtn.dataset.act = 'together';
    this.togetherBtn.append(this.togetherLabel, this.togetherBadge);
    this.modeSeg = new Segmented<GameMode>(
      ctx,
      [
        { value: 'creative', label: 'mode.creative' },
        { value: 'survival', label: 'mode.survival' },
      ],
      'pause.mode',
      (m) => a.setMode(m),
      true, // the mode is the client's: show what it applied, not what was clicked
    );
    this.modeSeg.el.setAttribute('aria-labelledby', modeLbl);
    this.quitBtn = button(ctx, { variant: 'danger', icon: ICON_SAVE, label: 'pause.saveQuit', cls: 'bl-btn--wide', onClick: () => a.saveAndQuit() });
    this.leaveBtn = button(ctx, { variant: 'danger', icon: ICON_LEAVE, label: 'pause.leaveRoom', cls: 'bl-btn--wide', onClick: () => a.leaveRoom() });
    this.leaveBtn.dataset.act = 'leave';
    const noSave = button(ctx, { variant: 'ghost', icon: ICON_CLOSE, label: 'pause.quitNoSave', cls: 'bl-btn--wide', onClick: () => a.quitWithoutSaving() });
    this.saveFailedNote = ctx.text(h(d, 'p', 'bl-subtitle', { role: 'alert' }), 'pause.saveFailed');
    this.unsaved = h(d, 'div', 'bl-pause-unsaved', { hidden: true }, [this.saveFailedNote, noSave]);
    this.stoppedNote = ctx.text(h(d, 'p', 'bl-subtitle bl-pause-stopped', { role: 'alert', hidden: true }), 'pause.stopped');
    this.runningNote = ctx.text(h(d, 'p', 'bl-subtitle bl-pause-running', { hidden: true }), 'pause.running');
    this.modeEl = h(d, 'div', 'bl-pause-mode', null, [ctx.text(h(d, 'span', 'bl-subtitle', { id: modeLbl }), 'pause.mode'), this.modeSeg.el]);
    this.title = ctx.text(h(d, 'h2', 'bl-panel-title bl-title-lg', { id: titleId }), 'pause.title');

    this.panel = h(d, 'div', 'bl-panel bl-panel-modal bl-pause-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      h(d, 'div', 'bl-pause-main', null, [
        this.title,
        this.runningNote,
        this.stoppedNote,
        this.resumeBtn,
        this.settingsBtn,
        this.togetherBtn,
        this.modeEl,
        h(d, 'div', 'bl-pause-quit', null, [this.quitBtn, this.leaveBtn, this.unsaved]),
      ]),
      h(d, 'div', 'bl-pause-ref', null, [ctx.text(h(d, 'h3', 'bl-subtitle'), 'pause.controls'), controlsReference(ctx)]),
    ]);
    this.el = h(d, 'div', 'bl-screen bl-screen--overlay bl-pause', { hidden: true, 'data-screen': 'pause' }, [this.panel]);
  }

  update(s: UiState): void {
    this.modeSeg.set(s.mode);
    const o = s.online;
    const stopped = s.worldStopped === true;
    const failed = s.quitUnsaved === true;
    const guest = o.role === 'guest';
    this.title.textContent = this.ctx.t(o.pauses || stopped ? 'pause.title' : 'pause.menuTitle');
    setHidden(this.runningNote, o.pauses || stopped);
    setHidden(this.stoppedNote, !stopped);
    setHidden(this.resumeBtn, stopped);
    setHidden(this.modeEl, stopped || guest);
    setHidden(this.saveFailedNote, !failed);
    setHidden(this.unsaved, !stopped && !failed);
    setHidden(this.quitBtn, guest);
    setHidden(this.leaveBtn, !guest);
    setHidden(this.togetherBtn, !o.available || o.role === null || stopped);
    if (o.role !== this.role) {
      this.role = o.role;
      this.togetherLabel.textContent = this.ctx.t(guest ? 'pause.players' : 'pause.together');
    }
    const live = o.room !== null && o.room.status !== 'closed';
    this.room = live ? { n: o.players.length, max: o.maxPlayers } : null;
    setHidden(this.togetherBadge, !live);
    this.togetherBtn.classList.toggle('has-badge', live);
    if (this.room) this.togetherBadgeText.set(this.ctx.t('pause.roomOpen', this.room));
  }

  onShow(_s: UiState, from: Screen | null): void {
    // Back from settings or the room screen: return focus to the button that opened it (the
    // root's key guard keeps a held Enter from re-opening it). Otherwise focus the dialog itself
    // so Tab starts at the top without painting a focus ring on open.
    focusInto(from === 'settings' ? this.settingsBtn : from === 'room' ? this.togetherBtn : this.panel);
  }

  onHide(): void {}

  relocalize(): void {
    this.togetherLabel.textContent = this.ctx.t(this.role === 'guest' ? 'pause.players' : 'pause.together');
    if (this.room) this.togetherBadgeText.set(this.ctx.t('pause.roomOpen', this.room));
  }

  dispose(): void {
    this.el.remove();
  }
}
