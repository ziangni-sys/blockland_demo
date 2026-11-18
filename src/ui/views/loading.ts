/**
 * Loading screen: small logotype, a ruler-ticked brass progress bar, status text and percent.
 *
 * While a guest joins someone else's room (UiState.online.join, package 11) it also shows the
 * stages as a short list (reaching the signalling service, or reading the invitation for a manual
 * join; reaching the host; loading the world; done ones ticked, the current one lit), and for a
 * manual join the answer code to send back to the host. Every stage has "Back to the menu" (Esc
 * too), which gives the join up: no stage waits without a way out. Reconnecting after the link
 * died: the message and "Give up". A join that failed, or a connection that ended: a title, the
 * message, "Try again" when it can help and "Back to the menu" (the bar and stages are hidden
 * then).
 */
import type { UiContext } from '../context';
import { formatPercent, quantize } from '../format';
import type { StringKey } from '../i18n';
import type { JoinView, UiState } from '../model';
import { h, setHidden, TextSlot } from '../dom';
import type { ScreenView } from './screen';
import { buildLogo, button, CopyField, ICON_BACK, ICON_RESPAWN } from './widgets';

const STEPS = ['service', 'host', 'world'] as const;

export class LoadingView implements ScreenView {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly text: TextSlot;
  private readonly pct: TextSlot;
  private readonly title: HTMLElement;
  private readonly row: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly stepEls: HTMLElement[];
  private readonly serviceStep: HTMLElement;
  private readonly hostStep: HTMLElement;
  private readonly answerBox: HTMLElement;
  private readonly answer: CopyField;
  private readonly failBox: HTMLElement;
  private readonly failTitle: HTMLElement;
  private readonly failText: TextSlot;
  private readonly retryBtn: HTMLButtonElement;
  private readonly menuBtn: HTMLButtonElement;
  private readonly giveUpBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private progress = -1;
  private join: JoinView | null = null;
  /**
   * Esc on a join stage or a failure: back to the menu, as the button (the client's keys do not
   * act outside a world, and focus may be anywhere, so the document is listened to while shown).
   * Not while reconnecting: Esc there is too easily a reflex to give a world up by.
   */
  private readonly onKey = (e: KeyboardEvent): void => {
    const j = this.join;
    if (e.key !== 'Escape' || e.repeat || j === null || j.stage === 'reconnecting') return;
    e.preventDefault();
    this.ctx.actions.abandonJoin();
  };

  constructor(private readonly ctx: UiContext) {
    const d = ctx.doc;
    const a = ctx.actions;
    this.text = new TextSlot(d);
    this.pct = new TextSlot(d);
    this.fill = h(d, 'div', 'bl-progress-fill');
    this.bar = h(d, 'div', 'bl-progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [this.fill, h(d, 'div', 'bl-progress-ticks')]);
    ctx.attr(this.bar, 'aria-label', 'loading.title');
    this.title = ctx.text(h(d, 'div', 'bl-loading-title'), 'loading.title');
    this.row = h(d, 'div', 'bl-loading-row', null, [
      h(d, 'span', 'bl-loading-text', { 'aria-live': 'polite' }, [this.text.node]),
      h(d, 'span', 'bl-loading-pct', null, [this.pct.node]),
    ]);

    // ---- a guest's join (package 11)
    const stepKey: Record<(typeof STEPS)[number], StringKey> = { service: 'join.stepService', host: 'join.stepHost', world: 'join.stepWorld' };
    this.stepEls = STEPS.map((st) => ctx.text(h(d, 'li', 'bl-step', { 'data-step': st, 'data-state': 'todo' }), stepKey[st]));
    this.serviceStep = this.stepEls[0]!;
    this.hostStep = this.stepEls[1]!;
    this.steps = h(d, 'ol', 'bl-steps', { hidden: true }, this.stepEls);
    this.answer = new CopyField(ctx, { labelKey: 'join.answerTitle', act: 'copy-answer', multiline: true, mono: true });
    this.answerBox = h(d, 'div', 'bl-loading-answer', { hidden: true }, [ctx.text(h(d, 'span', 'bl-form-label'), 'join.answerTitle'), this.answer.el]);
    this.failTitle = h(d, 'h2', 'bl-loading-fail-title');
    this.failText = new TextSlot(d);
    this.retryBtn = button(ctx, { variant: 'primary', icon: ICON_RESPAWN, label: 'join.retry', onClick: () => a.retryJoin() });
    this.retryBtn.dataset.act = 'retry';
    this.menuBtn = button(ctx, { variant: 'ghost', icon: ICON_BACK, label: 'join.menu', onClick: () => a.abandonJoin() });
    this.menuBtn.dataset.act = 'menu';
    this.failBox = h(d, 'div', 'bl-loading-fail', { hidden: true, role: 'alert' }, [
      this.failTitle,
      h(d, 'p', 'bl-loading-fail-text', null, [this.failText.node]),
      h(d, 'div', 'bl-actions', null, [this.menuBtn, this.retryBtn]),
    ]);
    this.giveUpBtn = button(ctx, { variant: 'ghost', icon: ICON_BACK, label: 'join.giveUp', onClick: () => a.abandonJoin() });
    this.giveUpBtn.dataset.act = 'give-up';
    setHidden(this.giveUpBtn, true);
    this.cancelBtn = button(ctx, { variant: 'ghost', icon: ICON_BACK, label: 'join.menu', onClick: () => a.abandonJoin() });
    this.cancelBtn.dataset.act = 'cancel';
    setHidden(this.cancelBtn, true);

    this.el = h(d, 'div', 'bl-screen bl-screen--opaque bl-loading', { hidden: true, 'data-screen': 'loading' }, [
      h(d, 'div', 'bl-loading-inner', null, [buildLogo(ctx, true), this.title, this.bar, this.row, this.steps, this.answerBox, this.failBox, this.giveUpBtn, this.cancelBtn]),
    ]);
  }

  update(s: UiState): void {
    const l = s.loading;
    this.text.set(l ? l.text : '');
    const p = quantize(l ? l.progress : 0, 1000);
    if (p !== this.progress) {
      this.progress = p;
      this.fill.style.transform = `scaleX(${p})`;
      this.pct.set(formatPercent(p));
      this.bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    }
    const j = s.online.join;
    if (j !== this.join) {
      this.join = j;
      this.renderJoin();
    }
  }

  onShow(): void {
    this.ctx.doc.addEventListener('keydown', this.onKey);
  }

  onHide(): void {
    this.ctx.doc.removeEventListener('keydown', this.onKey);
  }

  relocalize(): void {
    this.answer.relocalize();
    this.renderJoin();
  }

  dispose(): void {
    this.onHide();
    this.answer.dispose();
    this.el.remove();
  }

  private renderJoin(): void {
    const j = this.join;
    const failed = j !== null && j.stage === 'failed';
    const reconnecting = j !== null && j.stage === 'reconnecting';
    setHidden(this.title, failed);
    setHidden(this.bar, failed);
    setHidden(this.row, failed);
    setHidden(this.steps, j === null || failed || reconnecting);
    if (j !== null && !failed && !reconnecting) {
      const at = STEPS.indexOf(j.stage as (typeof STEPS)[number]);
      this.stepEls.forEach((el, i) => (el.dataset.state = i < at ? 'done' : i === at ? 'now' : 'todo'));
      // A manual join has no service: it reads the invitation, then waits for the host to paste the answer code.
      this.serviceStep.textContent = this.ctx.t(j.signal === 'manual' ? 'join.stepInvitation' : 'join.stepService');
      this.hostStep.textContent = this.ctx.t(j.signal === 'manual' && j.answer !== null ? 'join.stepAnswer' : 'join.stepHost');
    }
    const showAnswer = j !== null && j.answer !== null && j.stage === 'host';
    setHidden(this.answerBox, !showAnswer);
    if (showAnswer) this.answer.set(j.answer!);
    setHidden(this.failBox, !failed);
    if (failed) {
      this.failTitle.textContent = this.ctx.t(j.wasIn ? 'join.endedTitle' : 'join.failedTitle');
      this.failText.set(j.error ?? '');
      setHidden(this.retryBtn, !j.canRetry);
    }
    setHidden(this.giveUpBtn, !reconnecting);
    setHidden(this.cancelBtn, j === null || failed || reconnecting);
  }
}
