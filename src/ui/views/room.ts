/**
 * "Play together" (package 11), opened from the pause menu. Two halves:
 *  - Invite friends (the host only): the room's status in one line (closed / opening / open with
 *    how many are in / the signalling service lost), and what fits it: "Open to friends" (the
 *    public signalling service) with "Use invitation codes" beside it; while open through the
 *    service, the invitation link and the room code, each with a Copy button; while open with
 *    invitation codes, the two steps (make an invitation for one friend, paste the answer they
 *    send back); "Close the room" (no new joins; the friends in stay); the world's rules
 *    (creative or survival: a new friend's mode, whether loosened blocks drop), shown while the
 *    world is online, where they are set here apart from the host's own mode (DESIGN
 *    联机时由房主另外设置); in single play the pause menu's mode switch carries them.
 *  - In this world (everyone): each player's name with Host / You badges; for the host, per
 *    guest, the mode (creative / survival) and Remove, which asks first in the row.
 * Under them the connection diagnostics: one button measures (about a second), and the text is
 * shown selectable and copied.
 */
import type { UiContext } from '../context';
import type { GameMode, OnlineView, PlayerRow, Screen, UiState } from '../model';
import { h, setHidden, svg, TextSlot } from '../dom';
import { isolate } from '../format';
import { focusInto, type ScreenView } from './screen';
import { button, CopyField, ICON_BACK, ICON_CLOSE, ICON_LINK, ICON_PEOPLE } from './widgets';

function playersKey(rows: readonly PlayerRow[]): string {
  return rows.map((r) => `${r.entityId}|${r.name}|${r.host ? 1 : 0}|${r.you ? 1 : 0}|${r.mode ?? '-'}`).join('\n');
}

export class RoomScreenView implements ScreenView {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly inviteSec: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly status: TextSlot;
  private readonly closedBox: HTMLElement;
  private readonly openError: HTMLElement;
  private readonly openError2: TextSlot;
  private readonly serviceBox: HTMLElement;
  private readonly link: CopyField;
  private readonly code: CopyField;
  private readonly manualBox: HTMLElement;
  private readonly makeBtn: HTMLButtonElement;
  private readonly makeLabel: HTMLElement;
  private readonly invitation: CopyField;
  private readonly answerInput: HTMLTextAreaElement;
  private readonly connectBtn: HTMLButtonElement;
  private readonly answeredNote: HTMLElement;
  private readonly closeBox: HTMLElement;
  private readonly rulesSeg: HTMLElement;
  private readonly rulesBox: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly diagBtn: HTMLButtonElement;
  private readonly diagLabel: HTMLElement;
  private readonly diag: CopyField;
  private readonly diagHint: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private online: OnlineView | null = null;
  private listKey: string | null = null;
  private listLang: string | null = null;
  private confirmKick: number | null = null;
  private diagText: string | null = null;

  constructor(private readonly ctx: UiContext) {
    const d = ctx.doc;
    const a = ctx.actions;
    const titleId = ctx.id('room');

    // ---- invite friends (host)
    this.status = new TextSlot(d);
    this.statusEl = h(d, 'p', 'bl-room-status', { 'data-status': 'closed', role: 'status' }, [h(d, 'i', 'bl-room-dot', { 'aria-hidden': 'true' }), h(d, 'span', null, null, [this.status.node])]);
    const openBtn = button(ctx, { variant: 'primary', icon: ICON_LINK, label: 'room.open', cls: 'bl-btn--wide', onClick: () => a.openRoom('service') });
    openBtn.dataset.act = 'open';
    const codesBtn = button(ctx, { variant: 'ghost', label: 'room.useCodes', cls: 'bl-btn--wide', onClick: () => a.openRoom('manual') });
    codesBtn.dataset.act = 'open-manual';
    this.openError2 = new TextSlot(d);
    this.openError = h(d, 'p', 'bl-room-error', { role: 'alert', hidden: true }, [this.openError2.node]);
    this.closedBox = h(d, 'div', 'bl-room-box', null, [
      openBtn,
      ctx.text(h(d, 'p', 'bl-room-hint'), 'room.openHint'),
      this.openError,
      codesBtn,
      ctx.text(h(d, 'p', 'bl-room-hint'), 'room.useCodesHint'),
    ]);

    this.link = new CopyField(ctx, { labelKey: 'room.link', act: 'copy-link' });
    this.code = new CopyField(ctx, { labelKey: 'room.code', act: 'copy-code', mono: true, cls: 'bl-copy--code' });
    this.serviceBox = h(d, 'div', 'bl-room-box', null, [
      ctx.text(h(d, 'span', 'bl-form-label'), 'room.link'),
      this.link.el,
      ctx.text(h(d, 'span', 'bl-form-label'), 'room.code'),
      this.code.el,
    ]);

    this.makeLabel = ctx.text(h(d, 'span', 'bl-btn-label'), 'room.makeInvitation');
    this.makeBtn = h(d, 'button', 'bl-btn bl-btn--primary bl-btn--wide', { type: 'button', 'data-act': 'invite' }, [this.makeLabel]);
    this.makeBtn.addEventListener('click', () => a.makeInvitation());
    this.invitation = new CopyField(ctx, { labelKey: 'room.invitation', act: 'copy-invitation', multiline: true, mono: true });
    const answerId = ctx.id('answer');
    this.answerInput = h(d, 'textarea', 'bl-input bl-mono bl-copy-text', { id: answerId, rows: 3, spellcheck: 'false', autocomplete: 'off', 'data-field': 'answer' });
    ctx.attr(this.answerInput, 'placeholder', 'room.answerPlaceholder');
    this.connectBtn = button(ctx, { variant: 'primary', label: 'room.connect', onClick: () => this.submitAnswer() });
    this.connectBtn.dataset.act = 'accept';
    this.answeredNote = ctx.text(h(d, 'p', 'bl-room-hint', { role: 'status', hidden: true }), 'room.answered');
    this.manualBox = h(d, 'div', 'bl-room-box', null, [
      ctx.text(h(d, 'span', 'bl-form-label'), 'room.step1'),
      this.makeBtn,
      this.invitation.el,
      ctx.text(h(d, 'label', 'bl-form-label', { for: answerId }), 'room.step2'),
      this.answerInput,
      h(d, 'div', 'bl-actions', null, [this.connectBtn]),
      this.answeredNote,
    ]);

    const closeBtn = button(ctx, { variant: 'danger', icon: ICON_CLOSE, label: 'room.close', cls: 'bl-btn--wide', onClick: () => a.closeRoom() });
    closeBtn.dataset.act = 'close';
    this.closeBox = h(d, 'div', 'bl-room-box bl-room-closebox', null, [closeBtn, ctx.text(h(d, 'p', 'bl-room-hint'), 'room.closeHint')]);

    const rulesId = ctx.id('rules');
    this.rulesSeg = h(d, 'div', 'bl-seg-ctl bl-seg-sm', { role: 'radiogroup', 'aria-labelledby': rulesId });
    for (const m of ['creative', 'survival'] as const) {
      const b = h(d, 'button', null, { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-act': 'rules', 'data-mode': m });
      ctx.text(b, m === 'creative' ? 'mode.creative' : 'mode.survival');
      b.addEventListener('click', () => a.setWorldRules(m));
      this.rulesSeg.appendChild(b);
    }
    this.rulesBox = h(d, 'div', 'bl-room-box bl-room-rules', null, [
      h(d, 'div', 'bl-room-rules-row', null, [ctx.text(h(d, 'span', 'bl-form-label', { id: rulesId }), 'room.rules'), this.rulesSeg]),
      ctx.text(h(d, 'p', 'bl-room-hint'), 'room.rulesHint'),
    ]);

    this.inviteSec = h(d, 'section', 'bl-room-sec bl-room-invite', null, [
      ctx.text(h(d, 'h3', 'bl-subtitle'), 'room.invite'),
      this.statusEl,
      this.closedBox,
      this.serviceBox,
      this.manualBox,
      this.closeBox,
      this.rulesBox,
    ]);

    // ---- in this world
    this.countEl = h(d, 'span', 'bl-count');
    this.list = h(d, 'ul', 'bl-player-list');
    this.list.addEventListener('click', (e) => this.onListClick(e));
    const playersSec = h(d, 'section', 'bl-room-sec bl-room-players', null, [
      h(d, 'h3', 'bl-subtitle bl-room-players-title', null, [svg(d, ICON_PEOPLE), ctx.text(h(d, 'span'), 'room.inWorld'), this.countEl]),
      this.list,
    ]);

    // ---- diagnostics
    this.diagLabel = ctx.text(h(d, 'span', 'bl-btn-label'), 'room.copyDiagnostics');
    this.diagBtn = h(d, 'button', 'bl-btn bl-btn--ghost', { type: 'button', 'data-act': 'diagnostics' }, [this.diagLabel]);
    this.diagBtn.addEventListener('click', () => a.copyDiagnostics());
    this.diag = new CopyField(ctx, { labelKey: 'room.diagnostics', act: 'copy-diagnostics', multiline: true, mono: true, cls: 'bl-copy--diag' });
    this.diagHint = ctx.text(h(d, 'p', 'bl-room-hint'), 'room.diagnosticsHint');
    const diagSec = h(d, 'section', 'bl-room-diag', null, [
      h(d, 'div', 'bl-room-diag-head', null, [ctx.text(h(d, 'h3', 'bl-subtitle'), 'room.diagnostics'), this.diagBtn]),
      this.diag.el,
      this.diagHint,
    ]);

    this.backBtn = button(ctx, { variant: 'primary', icon: ICON_BACK, label: 'room.back', onClick: () => a.closeScreen() });
    this.panel = h(d, 'div', 'bl-panel bl-panel-modal bl-room-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      ctx.text(h(d, 'h2', 'bl-panel-title bl-title-lg', { id: titleId }), 'room.title'),
      h(d, 'div', 'bl-room-grid', null, [this.inviteSec, playersSec]),
      diagSec,
      h(d, 'div', 'bl-actions', null, [this.backBtn]),
    ]);
    this.el = h(d, 'div', 'bl-screen bl-screen--overlay bl-room', { hidden: true, 'data-screen': 'room' }, [this.panel]);
  }

  update(s: UiState): void {
    const o = s.online;
    if (o === this.online && this.listLang === this.ctx.lang) return;
    this.online = o;
    const room = o.room;
    setHidden(this.inviteSec, room === null);
    if (room !== null) {
      this.statusEl.dataset.status = room.status;
      this.status.set(
        room.status === 'open'
          ? this.ctx.t('room.statusOpen', { n: o.players.length, max: o.maxPlayers })
          : this.ctx.t(room.status === 'opening' ? 'room.statusOpening' : room.status === 'lost' ? 'room.statusLost' : 'room.statusClosed'),
      );
      const live = room.status !== 'closed';
      setHidden(this.closedBox, live);
      this.openError2.set(room.error ?? '');
      setHidden(this.openError, room.error === null || live);
      const service = live && room.signal !== 'manual';
      setHidden(this.serviceBox, !service || room.code === null);
      this.link.set(room.link ?? '');
      this.code.set(room.code ?? '');
      const manual = live && room.signal === 'manual' && room.status !== 'opening';
      setHidden(this.manualBox, !manual);
      this.makeLabel.textContent = this.ctx.t(room.inviting ? 'room.making' : 'room.makeInvitation');
      this.makeBtn.disabled = room.inviting;
      setHidden(this.invitation.el, room.invitation === null);
      this.invitation.set(room.invitation ?? '');
      setHidden(this.answeredNote, !room.answered);
      if (room.answered) this.answerInput.value = '';
      setHidden(this.closeBox, !live);
      setHidden(this.rulesBox, room.rules === null);
      for (const b of this.rulesSeg.querySelectorAll<HTMLElement>('[data-act="rules"]')) b.setAttribute('aria-checked', b.dataset.mode === room.rules ? 'true' : 'false');
    }
    this.renderList(o);
    // Diagnostics: the button says when it is measuring; a new text is shown and copied.
    this.diagLabel.textContent = this.ctx.t(o.diagnosticsBusy ? 'room.measuring' : 'room.copyDiagnostics');
    this.diagBtn.disabled = o.diagnosticsBusy;
    setHidden(this.diag.el, o.diagnostics === null);
    if (o.diagnostics !== null && o.diagnostics !== this.diagText) {
      this.diagText = o.diagnostics;
      this.diag.set(o.diagnostics);
      void this.diag.copy();
    }
  }

  onShow(_s: UiState, _from: Screen | null): void {
    focusInto(this.panel);
  }

  onHide(): void {
    this.confirmKick = null;
    this.listKey = null;
  }

  relocalize(): void {
    this.link.relocalize();
    this.code.relocalize();
    this.invitation.relocalize();
    this.diag.relocalize();
    this.listLang = null;
  }

  dispose(): void {
    this.link.dispose();
    this.code.dispose();
    this.invitation.dispose();
    this.diag.dispose();
    this.el.remove();
  }

  // ------------------------------------------------------------------ internals

  private submitAnswer(): void {
    const v = this.answerInput.value.trim();
    if (v !== '') this.ctx.actions.acceptAnswer(v);
  }

  private renderList(o: OnlineView): void {
    const key = `${playersKey(o.players)}#${this.confirmKick ?? ''}#${o.role}`;
    if (key === this.listKey && this.listLang === this.ctx.lang) return;
    this.listKey = key;
    this.listLang = this.ctx.lang;
    const ctx = this.ctx;
    const d = ctx.doc;
    this.countEl.textContent = ctx.t('room.count', { n: o.players.length, max: o.maxPlayers });
    this.list.textContent = '';
    if (this.confirmKick !== null && !o.players.some((p) => p.entityId === this.confirmKick)) this.confirmKick = null;
    for (const p of o.players) this.list.appendChild(this.confirmKick === p.entityId ? this.confirmRow(p) : this.row(p, o.role === 'host'));
  }

  private row(p: PlayerRow, hostView: boolean): HTMLElement {
    const ctx = this.ctx;
    const d = ctx.doc;
    const badges = h(d, 'span', 'bl-player-badges', null, [
      p.host ? h(d, 'span', 'bl-badge bl-badge--host', null, [ctx.t('room.host')]) : null,
      p.you ? h(d, 'span', 'bl-badge bl-badge--you', null, [ctx.t('room.you')]) : null,
    ]);
    const controls = hostView && !p.host && !p.you ? this.guestControls(p) : null;
    return h(d, 'li', 'bl-player', { 'data-id': String(p.entityId) }, [h(d, 'span', 'bl-player-name', { title: p.name, dir: 'auto' }, [p.name]), badges, controls]);
  }

  private guestControls(p: PlayerRow): HTMLElement {
    const ctx = this.ctx;
    const d = ctx.doc;
    const seg = h(d, 'div', 'bl-seg-ctl bl-seg-sm', { role: 'radiogroup', 'aria-label': ctx.t('room.modeOf', { name: isolate(p.name) }) });
    for (const m of ['creative', 'survival'] as const) {
      seg.appendChild(
        h(d, 'button', null, { type: 'button', role: 'radio', 'aria-checked': p.mode === m ? 'true' : 'false', 'data-act': 'mode', 'data-mode': m }, [
          ctx.t(m === 'creative' ? 'mode.creative' : 'mode.survival'),
        ]),
      );
    }
    const kick = h(d, 'button', 'bl-btn bl-btn--danger bl-btn--sm', { type: 'button', 'data-act': 'kick', 'aria-label': ctx.t('room.kickLabel', { name: isolate(p.name) }) }, [ctx.t('room.kick')]);
    return h(d, 'span', 'bl-player-controls', null, [seg, kick]);
  }

  private confirmRow(p: PlayerRow): HTMLElement {
    const ctx = this.ctx;
    const d = ctx.doc;
    return h(d, 'li', 'bl-player bl-player--confirm', { 'data-id': String(p.entityId), role: 'alertdialog' }, [
      h(d, 'p', 'bl-player-confirm', null, [ctx.t('room.kickConfirm', { name: isolate(p.name) })]),
      h(d, 'span', 'bl-player-controls', null, [
        h(d, 'button', 'bl-btn bl-btn--solid-danger bl-btn--sm', { type: 'button', 'data-act': 'kick-yes' }, [ctx.t('room.kick')]),
        h(d, 'button', 'bl-btn bl-btn--ghost bl-btn--sm', { type: 'button', 'data-act': 'kick-no' }, [ctx.t('room.cancel')]),
      ]),
    ]);
  }

  private onListClick(e: Event): void {
    const target = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!target) return;
    const id = Number(target.closest<HTMLElement>('[data-id]')?.dataset.id);
    if (!Number.isFinite(id)) return;
    const a = this.ctx.actions;
    switch (target.dataset.act) {
      case 'mode':
        a.setPlayerMode(id, target.dataset.mode as GameMode);
        break;
      case 'kick':
        this.confirmKick = id;
        break;
      case 'kick-yes':
        this.confirmKick = null;
        a.kickPlayer(id);
        break;
      case 'kick-no':
        this.confirmKick = null;
        break;
      default:
        return;
    }
    if (this.online) this.renderList(this.online);
  }
}
