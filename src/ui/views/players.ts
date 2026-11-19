/**
 * The player list over the HUD (package 11), held open with Tab during play: who is in the world
 * (name, Host and You badges, mode) and, for the host, whether the room takes new friends and in
 * small print each guest's connection as the server measures it. Read only: the host's controls
 * (mode, remove) are on the room screen from the pause menu.
 */
import type { UiContext } from '../context';
import type { OnlineView } from '../model';
import { h, setHidden, TextSlot } from '../dom';
import { formatGuestLink } from '../format';

export class PlayerListOverlay {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly count: TextSlot;
  private readonly roomLine: HTMLElement;
  private online: OnlineView | null = null;
  private lang: string | null = null;
  private shown = false;

  constructor(private readonly ctx: UiContext) {
    const d = ctx.doc;
    this.count = new TextSlot(d);
    this.list = h(d, 'ul', 'bl-plist-rows');
    this.roomLine = h(d, 'p', 'bl-plist-room');
    this.el = h(d, 'div', 'bl-plist bl-play', { hidden: true, 'aria-live': 'polite' }, [
      h(d, 'div', 'bl-plist-head', null, [ctx.text(h(d, 'span'), 'players.title'), h(d, 'span', 'bl-count', null, [this.count.node])]),
      this.list,
      this.roomLine,
    ]);
  }

  update(show: boolean, o: OnlineView): void {
    const visible = show && o.available && o.role !== null;
    if (visible !== this.shown) {
      this.shown = visible;
      setHidden(this.el, !visible);
    }
    if (!visible || (o === this.online && this.lang === this.ctx.lang)) return;
    this.online = o;
    this.lang = this.ctx.lang;
    const ctx = this.ctx;
    const d = ctx.doc;
    this.count.set(ctx.t('room.count', { n: o.players.length, max: o.maxPlayers }));
    this.list.textContent = '';
    for (const p of o.players) {
      this.list.appendChild(
        h(d, 'li', 'bl-plist-row', null, [
          h(d, 'span', 'bl-player-name', { dir: 'auto' }, [p.name]),
          p.host ? h(d, 'span', 'bl-badge bl-badge--host', null, [ctx.t('room.host')]) : null,
          p.you ? h(d, 'span', 'bl-badge bl-badge--you', null, [ctx.t('room.you')]) : null,
          h(d, 'span', `bl-badge bl-badge--${p.mode}`, null, [ctx.t(p.mode === 'creative' ? 'mode.creative' : 'mode.survival')]),
          p.traffic !== null ? h(d, 'span', 'bl-plist-link', null, [formatGuestLink(p.traffic, ctx.lang)]) : null,
        ]),
      );
    }
    const room = o.room;
    setHidden(this.roomLine, room === null);
    if (room !== null) {
      this.roomLine.dataset.status = room.status;
      this.roomLine.textContent = ctx.t(room.status === 'closed' ? 'players.roomClosed' : 'players.roomOpen');
    }
  }
}
