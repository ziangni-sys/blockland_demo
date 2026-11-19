/**
 * Package 11's screens and panels rendered from state, in zh and en, on a small fake DOM
 * (tests/ui/fakedom.ts): the room screen (closed, opening, open with 1 to 4 players, the service
 * lost, a failed open, the manual codes; a guest's view; the host's mode and remove controls), the
 * join screen, the name screen, the loading screen while joining (each stage, the manual answer,
 * each failure, reconnecting), the pause menu (single player, room open, guest, offline), the main
 * menu's join entry, the settings name field and the player list over the HUD. The real DOM and the
 * stylesheet are checked in a browser (scripts/e2e-room.mjs takes screenshots of each).
 */
import { describe, expect, it } from 'vitest';
import { UiContext } from '../../src/ui/context';
import type { IconCache } from '../../src/ui/icons';
import { t } from '../../src/ui/i18n';
import { DEFAULT_SETTINGS, type JoinView, type Language, type OnlineView, type PlayerRow, type RoomView, type UiActions, type UiState } from '../../src/ui/model';
import { JoinScreenView } from '../../src/ui/views/join';
import { LoadingView } from '../../src/ui/views/loading';
import { MainMenuView } from '../../src/ui/views/mainMenu';
import { NameView } from '../../src/ui/views/name';
import { PauseView } from '../../src/ui/views/pause';
import { PlayerListOverlay } from '../../src/ui/views/players';
import { RoomScreenView } from '../../src/ui/views/room';
import { SettingsView } from '../../src/ui/views/settings';
import { FakeDocument, FakeElement, FakeEvent, shown, visibleText } from './fakedom';
import { cleanName } from '../../src/net/names';

type Call = [string, ...unknown[]];

function actions(calls: Call[]): UiActions {
  return new Proxy({} as UiActions, {
    get:
      (_t, name: string) =>
      (...args: unknown[]) =>
        calls.push([name, ...args]),
  });
}

function setup(lang: Language): { doc: FakeDocument; ctx: UiContext; calls: Call[] } {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const ctx = new UiContext(doc as unknown as Document, actions(calls), {} as IconCache, 64, null);
  ctx.lang = lang;
  return { doc, ctx, calls };
}

const NAMES = ['Hester', 'Ann', 'Bob', 'Cy'];

function players(n: number, you = 0, modes: Array<PlayerRow['mode']> = [], traffic: Array<PlayerRow['traffic']> = []): PlayerRow[] {
  return NAMES.slice(0, n).map((name, i) => ({ entityId: i + 1, name, host: i === 0, you: i === you, mode: modes[i] ?? 'creative', traffic: traffic[i] ?? null }));
}

function room(over: Partial<RoomView> = {}): RoomView {
  return { status: 'closed', signal: 'cloud', code: null, link: null, invitation: null, inviting: false, answered: false, error: null, rules: 'creative', ...over };
}

function online(over: Partial<OnlineView> = {}): OnlineView {
  return { available: true, playerName: 'Hester', role: 'host', pauses: true, room: room(), players: players(1), maxPlayers: 4, join: null, diagnostics: null, diagnosticsBusy: false, ...over };
}

function state(lang: Language, o: OnlineView, over: Partial<UiState> = {}): UiState {
  return {
    screen: 'none',
    settingsReturn: 'pause',
    mode: 'creative',
    hotbar: new Array(9).fill(null),
    selected: 0,
    inventory: new Array(27).fill(null),
    offhand: null,
    cursor: null,
    health: 20,
    maxHealth: 20,
    air: 300,
    maxAir: 300,
    hint: null,
    notice: null,
    toasts: [],
    debug: null,
    helm: null,
    worlds: [],
    settings: { ...DEFAULT_SETTINGS, language: lang },
    loading: { text: '', progress: 0.02 },
    pointerLocked: true,
    dragLook: false,
    online: o,
    playerList: false,
    renderer: 'WebGL2',
    version: '0.1.0',
    ...over,
  };
}

const el = (x: unknown): FakeElement => x as FakeElement;
const act = (root: FakeElement, name: string): FakeElement => {
  const b = root.querySelector(`[data-act="${name}"]`);
  if (b === null) throw new Error(`no [data-act="${name}"]`);
  return b;
};

const LANGS: Language[] = ['zh', 'en'];

describe.each(LANGS)('the room screen (%s)', (lang) => {
  const tr = (k: Parameters<typeof t>[1], p?: Parameters<typeof t>[2]): string => t(lang, k, p);

  it('closed: the status, "Open to friends" and "Use invitation codes" with their lines; no link, no close', () => {
    const { ctx, calls } = setup(lang);
    const v = new RoomScreenView(ctx);
    v.update(state(lang, online()));
    const root = el(v.el);
    const text = visibleText(root);
    expect(text).toContain(tr('room.title'));
    expect(text).toContain(tr('room.statusClosed'));
    expect(text).toContain(tr('room.open'));
    expect(text).toContain(tr('room.openHint'));
    expect(text).toContain(tr('room.useCodes'));
    expect(text).not.toContain(tr('room.close'));
    expect(shown(act(root, 'copy-link'), root)).toBe(false);
    expect(root.querySelector('.bl-room-status')!.dataset.status).toBe('closed');
    act(root, 'open').click();
    act(root, 'open-manual').click();
    expect(calls).toEqual([
      ['openRoom', 'service'],
      ['openRoom', 'manual'],
    ]);
  });

  it('opening: only the status says so; a failed open: closed again with the reason', () => {
    const { ctx } = setup(lang);
    const v = new RoomScreenView(ctx);
    v.update(state(lang, online({ pauses: false, room: room({ status: 'opening' }) })));
    const root = el(v.el);
    expect(visibleText(root)).toContain(tr('room.statusOpening'));
    expect(shown(act(root, 'open'), root)).toBe(false);
    expect(shown(act(root, 'close'), root)).toBe(true);
    v.update(state(lang, online({ room: room({ error: 'NO SERVICE HERE' }) })));
    expect(visibleText(root)).toContain('NO SERVICE HERE');
    expect(shown(act(root, 'open'), root)).toBe(true);
  });

  it.each([1, 2, 3, 4])('open through the service with %i in the world: status with the count, link and code with Copy, close', (n) => {
    const { ctx, calls, doc } = setup(lang);
    const v = new RoomScreenView(ctx);
    const link = 'https://example.org/blocklands/?join=RXAMCDEF';
    v.update(state(lang, online({ pauses: false, players: players(n), room: room({ status: 'open', code: 'RXAM-CDEF', link }) })));
    const root = el(v.el);
    const text = visibleText(root);
    expect(text).toContain(tr('room.statusOpen', { n, max: 4 }));
    expect(text).toContain(`[${link}]`);
    expect(text).toContain('[RXAM-CDEF]');
    expect(text).toContain(tr('room.close'));
    expect(text).toContain(tr('room.closeHint'));
    expect(text).not.toContain(tr('room.open'));
    expect(text).toContain(tr('room.count', { n, max: 4 }));
    for (const name of NAMES.slice(0, n)) expect(text).toContain(name);
    expect(root.querySelectorAll('.bl-player')).toHaveLength(n);
    expect(root.querySelector('.bl-room-status')!.dataset.status).toBe('open');
    act(root, 'copy-link').click();
    return Promise.resolve().then(() => {
      expect(doc.copied).toEqual([link]);
      act(root, 'close').click();
      expect(calls).toEqual([['closeRoom']]);
    });
  });

  it('the signalling service lost: says new friends cannot join for now; the link stays', () => {
    const { ctx } = setup(lang);
    const v = new RoomScreenView(ctx);
    v.update(state(lang, online({ pauses: false, room: room({ status: 'lost', code: 'RXAM-CDEF', link: 'L' }) })));
    const root = el(v.el);
    expect(visibleText(root)).toContain(tr('room.statusLost'));
    expect(root.querySelector('.bl-room-status')!.dataset.status).toBe('lost');
    expect(visibleText(root)).toContain('[L]');
  });

  it("the world's rules online: the host sets them here (apart from its own mode); the current one lit; none in single play", () => {
    const { ctx, calls } = setup(lang);
    const v = new RoomScreenView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ room: room({ status: 'open', code: 'RXAM-CDEF', link: 'L', rules: 'creative' }) })));
    expect(visibleText(root)).toContain(tr('room.rules'));
    expect(visibleText(root)).toContain(tr('room.rulesHint'));
    const seg = root.querySelectorAll('[data-act="rules"]');
    expect(seg.map((b) => `${b.dataset.mode}:${b.getAttribute('aria-checked')}`)).toEqual(['creative:true', 'survival:false']);
    expect(seg.map((b) => b.textContent)).toEqual([tr('mode.creative'), tr('mode.survival')]);
    seg[1]!.click();
    expect(calls).toEqual([['setWorldRules', 'survival']]);
    v.update(state(lang, online({ room: room({ status: 'closed', rules: 'survival' }) })));
    expect(seg.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(shown(seg[0]!, root)).toBe(true);
    // Single play (no room, no guests): the pause menu's mode switch carries the rules; none here.
    v.update(state(lang, online({ room: room({ status: 'closed', rules: null }) })));
    expect(shown(seg[0]!, root)).toBe(false);
    expect(visibleText(root)).not.toContain(tr('room.rulesHint'));
    // A guest has no room section, so no rules.
    v.update(state(lang, online({ role: 'guest', room: null, players: players(2, 1) })));
    expect(shown(seg[0]!, root)).toBe(false);
  });

  it('manual codes: step 1 makes an invitation (busy while making), shows it with Copy; step 2 takes the answer; then "connecting"', () => {
    const { ctx, calls } = setup(lang);
    const v = new RoomScreenView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ pauses: false, room: room({ status: 'open', signal: 'manual' }) })));
    let text = visibleText(root);
    expect(text).toContain(tr('room.step1'));
    expect(text).toContain(tr('room.step2'));
    expect(text).not.toContain(tr('room.link'));
    expect(shown(act(root, 'copy-invitation'), root)).toBe(false);
    act(root, 'invite').click();
    v.update(state(lang, online({ pauses: false, room: room({ status: 'open', signal: 'manual', inviting: true }) })));
    expect(visibleText(root)).toContain(tr('room.making'));
    expect(act(root, 'invite').disabled).toBe(true);
    v.update(state(lang, online({ pauses: false, room: room({ status: 'open', signal: 'manual', invitation: 'BL1I.xyz' }) })));
    text = visibleText(root);
    expect(text).toContain('[BL1I.xyz]');
    expect(shown(act(root, 'copy-invitation'), root)).toBe(true);
    const answer = root.querySelector('[data-field="answer"]')!;
    answer.type('  BL1A.answer  ');
    act(root, 'accept').click();
    v.update(state(lang, online({ pauses: false, room: room({ status: 'open', signal: 'manual', answered: true }) })));
    expect(visibleText(root)).toContain(tr('room.answered'));
    expect(answer.value).toBe('');
    expect(calls).toEqual([['makeInvitation'], ['acceptAnswer', 'BL1A.answer']]);
  });

  it("the host's controls per guest: the guest's mode lit, Remove asks first in the row; never for the host itself", () => {
    const { ctx, calls } = setup(lang);
    const v = new RoomScreenView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ players: players(3, 0, ['survival', 'survival', 'creative']) })));
    const rows = root.querySelectorAll('.bl-player');
    expect(rows[0]!.querySelector('[data-act="kick"]')).toBeNull();
    expect(visibleText(rows[0]!)).toContain(tr('room.host'));
    expect(visibleText(rows[0]!)).toContain(tr('room.you'));
    // The host's own mode is a badge (it switches it in the pause menu).
    expect(rows[0]!.querySelector('[data-act="mode"]')).toBeNull();
    expect(visibleText(rows[0]!)).toContain(tr('mode.survival'));
    const annModes = rows[1]!.querySelectorAll('[data-act="mode"]');
    expect(annModes.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(rows[2]!.querySelectorAll('[data-act="mode"]').map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    annModes[0]!.click();
    act(rows[2]!, 'kick').click();
    expect(visibleText(root)).toContain(tr('room.kickConfirm', { name: '\u2068Bob\u2069' }));
    act(root, 'kick-no').click();
    expect(visibleText(root)).not.toContain(tr('room.kickConfirm', { name: '\u2068Bob\u2069' }));
    act(root.querySelectorAll('.bl-player')[2]!, 'kick').click();
    act(root, 'kick-yes').click();
    expect(calls).toEqual([
      ['setPlayerMode', 2, 'creative'],
      ['kickPlayer', 3],
    ]);
  });

  it("the host sees each guest's connection in small print, updated in place (the row is not rebuilt)", () => {
    const { ctx } = setup(lang);
    const v = new RoomScreenView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ players: players(2) })));
    const link = root.querySelectorAll('.bl-player')[1]!.querySelector('.bl-player-link')!;
    expect(shown(link, root)).toBe(false);
    v.update(state(lang, online({ players: players(2, 0, [], [null, { bytesPerSec: 4400, backlogBytes: 2600, rttMs: 61 }]) })));
    const row = root.querySelectorAll('.bl-player')[1]!;
    expect(row.querySelector('.bl-player-link')).toBe(link);
    expect(shown(link, root)).toBe(true);
    expect(link.textContent).toBe(tr('room.traffic', { rate: '4.3 KB', backlog: '2.5 KB', rtt: '61' }));
    expect(link.getAttribute('title')).toBe(tr('room.trafficHint'));
    v.update(state(lang, online({ players: players(2, 0, [], [null, { bytesPerSec: 900, backlogBytes: 0, rttMs: 0 }]) })));
    expect(root.querySelectorAll('.bl-player')[1]).toBe(row);
    expect(link.textContent).toBe(tr('room.traffic', { rate: '900 B', backlog: '0 B', rtt: '–' }));
    // Never on the host's own row.
    expect(root.querySelectorAll('.bl-player')[0]!.querySelector('.bl-player-link')).toBeNull();
  });

  it("a guest's view: no invite section, no controls; the diagnostics button, then the text shown and copied", async () => {
    const { ctx, calls, doc } = setup(lang);
    const v = new RoomScreenView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ role: 'guest', pauses: false, room: null, players: players(2, 1) })));
    let text = visibleText(root);
    expect(text).not.toContain(tr('room.invite'));
    expect(root.querySelector('[data-act="kick"]')).toBeNull();
    expect(root.querySelector('[data-act="mode"]')).toBeNull();
    expect(root.querySelector('.bl-player-link')).toBeNull();
    expect(text).toContain(tr('room.copyDiagnostics'));
    act(root, 'diagnostics').click();
    v.update(state(lang, online({ role: 'guest', pauses: false, room: null, players: players(2, 1), diagnosticsBusy: true })));
    expect(visibleText(root)).toContain(tr('room.measuring'));
    v.update(state(lang, online({ role: 'guest', pauses: false, room: null, players: players(2, 1), diagnostics: 'Blocklands connection diagnostics\nbuild: x' })));
    await Promise.resolve();
    text = visibleText(root);
    expect(text).toContain('Blocklands connection diagnostics');
    expect(text).toContain(tr('room.diagnosticsHint'));
    expect(doc.copied).toEqual(['Blocklands connection diagnostics\nbuild: x']);
    act(root, 'diagnostics');
    expect(calls).toEqual([['copyDiagnostics']]);
  });
});

describe.each(LANGS)('the join and name screens (%s)', (lang) => {
  const tr = (k: Parameters<typeof t>[1], p?: Parameters<typeof t>[2]): string => t(lang, k, p);

  it('join: one field, the line on invitation codes, the name others see; a text the client cannot read is refused here', () => {
    const { ctx, calls } = setup(lang);
    const v = new JoinScreenView(ctx, (text) => text.startsWith('ok'));
    v.update(state(lang, online({ role: null, room: null, playerName: 'Ann' }), { screen: 'join' }));
    v.onShow(state(lang, online()), 'mainMenu');
    const root = el(v.el);
    const text = visibleText(root);
    expect(text).toContain(tr('join.title'));
    expect(text).toContain(tr('join.field'));
    expect(text).toContain(tr('join.hint'));
    expect(text).toContain(tr('join.as', { name: '\u2068Ann\u2069' }));
    expect(text).not.toContain(tr('join.invalid'));
    const field = root.querySelector('[data-field="join"]')!;
    field.type('nonsense');
    act(root, 'join').click();
    expect(visibleText(root)).toContain(tr('join.invalid'));
    field.type('ok RXAMCDEF');
    expect(visibleText(root)).not.toContain(tr('join.invalid'));
    field.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', shiftKey: false, isComposing: false }));
    expect(calls).toEqual([['join', 'ok RXAMCDEF']]);
  });

  it('name: the field starts with the suggestion; a refused name says the rule; Continue keeps it', () => {
    const { ctx, calls, doc } = setup(lang);
    const v = new NameView(ctx, (text) => text.trim().length > 0);
    const root = el(v.el);
    v.update(state(lang, online({ playerName: 'Brass Helmsman' })));
    v.onShow(state(lang, online({ playerName: 'Brass Helmsman' })), null);
    const field = root.querySelector('[data-field="name"]')!;
    expect(field.value).toBe('Brass Helmsman');
    expect(doc.activeElement).toBe(field);
    const text = visibleText(root);
    expect(text).toContain(tr('name.title'));
    expect(text).toContain(tr('name.text'));
    field.type('   ');
    act(root, 'name').click();
    expect(visibleText(root)).toContain(tr('name.invalid'));
    field.type('Ada');
    act(root, 'name').click();
    expect(calls).toEqual([['setPlayerName', 'Ada']]);
  });

  it('name: the rule of the server (invisible-only refused; 24 code points, so no maxlength)', () => {
    const { ctx, calls } = setup(lang);
    const v = new NameView(ctx, (text) => cleanName(text) !== null);
    const root = el(v.el);
    v.onShow(state(lang, online({ playerName: 'Brass Helmsman' })), null);
    const field = root.querySelector('[data-field="name"]')!;
    expect(field.getAttribute('maxlength')).toBeNull();
    field.type('\u200B \u2067');
    act(root, 'name').click();
    expect(visibleText(root)).toContain(tr('name.invalid'));
    const emoji = '\u{1F6A2}'.repeat(24);
    field.type(emoji);
    act(root, 'name').click();
    expect(calls).toEqual([['setPlayerName', emoji]]);
  });
});

describe.each(LANGS)('the loading screen while joining (%s)', (lang) => {
  const tr = (k: Parameters<typeof t>[1], p?: Parameters<typeof t>[2]): string => t(lang, k, p);
  const join = (over: Partial<JoinView>): JoinView => ({ stage: 'service', signal: 'cloud', answer: null, error: null, canRetry: true, wasIn: false, ...over });
  const steps = (root: FakeElement): string[] => root.querySelectorAll('.bl-step').map((s) => `${s.dataset.step}:${s.dataset.state}`);

  it('each stage lit in turn, the earlier ones done; "Back to the menu" (and Esc) at every stage', () => {
    const { ctx, doc, calls } = setup(lang);
    const v = new LoadingView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ role: 'guest', room: null, join: join({ stage: 'service' }) }), { screen: 'loading', loading: { text: 'X', progress: 0.02 } }));
    expect(steps(root)).toEqual(['service:now', 'host:todo', 'world:todo']);
    expect(visibleText(root)).toContain(tr('join.stepService'));
    expect(visibleText(root)).toContain(tr('join.stepHost'));
    expect(visibleText(root)).toContain(tr('join.stepWorld'));
    v.update(state(lang, online({ join: join({ stage: 'host' }) }), { screen: 'loading' }));
    expect(steps(root)).toEqual(['service:done', 'host:now', 'world:todo']);
    v.update(state(lang, online({ join: join({ stage: 'world' }) }), { screen: 'loading' }));
    expect(steps(root)).toEqual(['service:done', 'host:done', 'world:now']);
    for (const a of ['retry', 'menu', 'give-up']) expect(shown(act(root, a), root)).toBe(false);
    v.onShow();
    for (const stage of ['service', 'host', 'world'] as const) {
      v.update(state(lang, online({ join: join({ stage }) }), { screen: 'loading' }));
      expect(shown(act(root, 'cancel'), root), stage).toBe(true);
      expect(act(root, 'cancel').textContent).toBe(tr('join.menu'));
      act(root, 'cancel').click();
      expect(doc.key('Escape').defaultPrevented).toBe(true);
    }
    expect(calls).toEqual(new Array(6).fill(['abandonJoin']));
    expect(doc.key('Escape', { repeat: true }).defaultPrevented).toBe(false);
    // Not joining (the host's own world loading): no stage list, no way back, Esc does nothing.
    v.update(state(lang, online({ join: null }), { screen: 'loading' }));
    expect(shown(root.querySelector('.bl-steps')!, root)).toBe(false);
    expect(shown(act(root, 'cancel'), root)).toBe(false);
    expect(doc.key('Escape').defaultPrevented).toBe(false);
    // Hidden, the screen hears no key.
    v.update(state(lang, online({ join: join({ stage: 'host' }) }), { screen: 'loading' }));
    v.onHide();
    expect(doc.key('Escape').defaultPrevented).toBe(false);
    expect(calls).toHaveLength(6);
  });

  it('a manual join reads the invitation, not the signalling service', () => {
    const { ctx } = setup(lang);
    const v = new LoadingView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ join: join({ stage: 'host', signal: 'manual' }) }), { screen: 'loading' }));
    const text = visibleText(root);
    expect(text).toContain(tr('join.stepInvitation'));
    expect(text).not.toContain(tr('join.stepService'));
    expect(shown(act(root, 'cancel'), root)).toBe(true);
  });

  it('a manual join: the answer code with Copy and "waiting for the host to paste your answer"', () => {
    const { ctx } = setup(lang);
    const v = new LoadingView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ join: join({ stage: 'host', signal: 'manual', answer: 'BL1A.abc' }) }), { screen: 'loading' }));
    const text = visibleText(root);
    expect(text).toContain(tr('join.answerTitle'));
    expect(text).toContain('[BL1A.abc]');
    expect(text).toContain(tr('join.stepAnswer'));
    expect(text).not.toContain(tr('join.stepHost'));
    // The host may take long to paste it: the guest can always go back.
    expect(shown(act(root, 'cancel'), root)).toBe(true);
  });

  it('failed: the title (could not join / out of the room), the message, "Try again" only when it can help, "Back to the menu" (Esc too)', () => {
    const { ctx, calls, doc } = setup(lang);
    const v = new LoadingView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ join: join({ stage: 'failed', error: 'NO SUCH ROOM', canRetry: true }) }), { screen: 'loading' }));
    let text = visibleText(root);
    expect(text).toContain(tr('join.failedTitle'));
    expect(text).toContain('NO SUCH ROOM');
    expect(shown(act(root, 'retry'), root)).toBe(true);
    expect(shown(act(root, 'menu'), root)).toBe(true);
    expect(shown(root.querySelector('.bl-steps')!, root)).toBe(false);
    expect(shown(root.querySelector('.bl-progress')!, root)).toBe(false);
    act(root, 'retry').click();
    act(root, 'menu').click();
    v.update(state(lang, online({ join: join({ stage: 'failed', error: 'REMOVED', canRetry: false, wasIn: true }) }), { screen: 'loading' }));
    text = visibleText(root);
    expect(text).toContain(tr('join.endedTitle'));
    expect(text).toContain('REMOVED');
    expect(shown(act(root, 'retry'), root)).toBe(false);
    expect(shown(act(root, 'cancel'), root)).toBe(false);
    v.onShow();
    doc.key('Escape');
    expect(calls).toEqual([['retryJoin'], ['abandonJoin'], ['abandonJoin']]);
  });

  it('reconnecting: the bar and the text, and "Give up" (Esc does not give up)', () => {
    const { ctx, calls, doc } = setup(lang);
    const v = new LoadingView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ join: join({ stage: 'reconnecting', wasIn: true }) }), { screen: 'loading', loading: { text: 'RECONNECTING', progress: 0.05 } }));
    expect(visibleText(root)).toContain('RECONNECTING');
    expect(visibleText(root)).toContain(tr('join.giveUp'));
    expect(shown(root.querySelector('.bl-steps')!, root)).toBe(false);
    expect(shown(act(root, 'cancel'), root)).toBe(false);
    v.onShow();
    expect(doc.key('Escape').defaultPrevented).toBe(false);
    act(root, 'give-up').click();
    expect(calls).toEqual([['abandonJoin']]);
  });
});

describe.each(LANGS)('the pause menu, the main menu, the settings and the HUD list (%s)', (lang) => {
  const tr = (k: Parameters<typeof t>[1], p?: Parameters<typeof t>[2]): string => t(lang, k, p);

  it('single player: "Paused", Play together, the mode switch, Save & quit', () => {
    const { ctx, calls } = setup(lang);
    const v = new PauseView(ctx);
    const root = el(v.el);
    v.update(state(lang, online(), { screen: 'pause' }));
    const text = visibleText(root);
    expect(text).toContain(tr('pause.title'));
    expect(text).not.toContain(tr('pause.running'));
    expect(text).toContain(tr('pause.together'));
    expect(text).toContain(tr('pause.mode'));
    expect(text).toContain(tr('pause.saveQuit'));
    expect(text).not.toContain(tr('pause.leaveRoom'));
    act(root, 'together').click();
    expect(calls).toEqual([['openRoomScreen']]);
  });

  it('the room open: "Menu", the game goes on, "Room open · n/4" on Play together', () => {
    const { ctx } = setup(lang);
    const v = new PauseView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ pauses: false, players: players(3), room: room({ status: 'open', code: 'C', link: 'L' }) }), { screen: 'pause' }));
    const text = visibleText(root);
    expect(text).toContain(tr('pause.menuTitle'));
    expect(text).toContain(tr('pause.running'));
    expect(text).toContain(tr('pause.roomOpen', { n: 3, max: 4 }));
    expect(text).toContain(tr('pause.saveQuit'));
  });

  it('a guest: "Players", no mode switch, "Leave the room" in place of "Save & quit"; offline: no Play together', () => {
    const { ctx, calls } = setup(lang);
    const v = new PauseView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ role: 'guest', pauses: false, room: null, players: players(2, 1) }), { screen: 'pause' }));
    let text = visibleText(root);
    expect(text).toContain(tr('pause.menuTitle'));
    expect(text).toContain(tr('pause.players'));
    expect(text).not.toContain(tr('pause.together'));
    expect(text).not.toContain(tr('pause.mode'));
    expect(text).not.toContain(tr('pause.saveQuit'));
    expect(text).toContain(tr('pause.leaveRoom'));
    act(root, 'leave').click();
    expect(calls).toEqual([['leaveRoom']]);
    v.update(state(lang, online({ available: false }), { screen: 'pause' }));
    text = visibleText(root);
    expect(text).not.toContain(tr('pause.together'));
    expect(text).toContain(tr('pause.saveQuit'));
  });

  it('the main menu: "Join a room", or one line saying this build cannot go online', () => {
    const { ctx, calls } = setup(lang);
    const v = new MainMenuView(ctx);
    const root = el(v.el);
    v.update(state(lang, online({ role: null, room: null, players: [] }), { screen: 'mainMenu' }));
    expect(visibleText(root)).toContain(tr('menu.join'));
    expect(visibleText(root)).not.toContain(tr('menu.offline'));
    act(root, 'join-room').click();
    expect(calls).toEqual([['openJoinScreen']]);
    v.update(state(lang, online({ available: false, role: null, room: null, players: [] }), { screen: 'mainMenu' }));
    expect(visibleText(root)).not.toContain(tr('menu.join'));
    expect(visibleText(root)).toContain(tr('menu.offline'));
  });

  it("the settings: the player's name, kept when the field is left; a refused one goes back", () => {
    const { ctx, calls } = setup(lang);
    const v = new SettingsView(ctx, (text) => text.trim().length > 0);
    const root = el(v.el);
    v.update(state(lang, online({ playerName: 'Ann' }), { screen: 'settings' }));
    expect(visibleText(root)).toContain(tr('settings.name'));
    expect(visibleText(root)).toContain(tr('settings.nameHint'));
    const field = root.querySelector('[data-field="settings-name"]')!;
    expect(field.value).toBe('Ann');
    field.value = '  ';
    field.dispatchEvent(new FakeEvent('change'));
    expect(field.value).toBe('Ann');
    field.value = 'Annabel';
    field.dispatchEvent(new FakeEvent('change'));
    expect(calls).toEqual([['setPlayerName', 'Annabel']]);
  });

  it('the settings name field counts code points (no maxlength), says the rule while broken, and is absent offline', () => {
    const { ctx, calls } = setup(lang);
    const v = new SettingsView(ctx, (text) => cleanName(text) !== null);
    const root = el(v.el);
    v.update(state(lang, online({ playerName: 'Ann' }), { screen: 'settings' }));
    const field = root.querySelector('[data-field="settings-name"]')!;
    expect(field.getAttribute('maxlength')).toBeNull();
    const emoji = '\u{1F600}'.repeat(20); // 40 UTF-16 units, 20 code points
    field.type(emoji);
    expect(visibleText(root)).not.toContain(tr('name.invalid'));
    field.dispatchEvent(new FakeEvent('change'));
    expect(calls).toEqual([['setPlayerName', emoji]]);
    field.type('x'.repeat(25));
    expect(visibleText(root)).toContain(tr('name.invalid'));
    expect(visibleText(root)).not.toContain(tr('settings.nameHint'));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    field.dispatchEvent(new FakeEvent('change'));
    expect(field.value).toBe('Ann');
    expect(visibleText(root)).toContain(tr('settings.nameHint'));
    expect(visibleText(root)).not.toContain(tr('name.invalid'));
    v.update(state(lang, online({ available: false, playerName: 'Ann' }), { screen: 'settings' }));
    expect(visibleText(root)).not.toContain(tr('settings.name'));
    expect(shown(field, root)).toBe(false);
  });

  it('the player list over the HUD: only while held; names with Host / You, the count, whether the room takes friends', () => {
    const { ctx } = setup(lang);
    const v = new PlayerListOverlay(ctx);
    const root = el(v.el);
    v.update(false, online({ players: players(3) }));
    expect(root.hidden).toBe(true);
    v.update(true, online({ players: players(3), room: room({ status: 'open' }) }));
    expect(root.hidden).toBe(false);
    const text = visibleText(root);
    expect(text).toContain(tr('players.title'));
    expect(text).toContain(tr('room.count', { n: 3, max: 4 }));
    for (const name of NAMES.slice(0, 3)) expect(text).toContain(name);
    expect(text).toContain(tr('room.host'));
    expect(text).toContain(tr('room.you'));
    expect(text).toContain(tr('players.roomOpen'));
    v.update(true, online({ role: 'guest', room: null, players: players(2, 1, ['creative', 'survival']) }));
    expect(visibleText(root)).not.toContain(tr('players.roomOpen'));
    // Everyone's mode, for guests too.
    const modes = root.querySelectorAll('.bl-plist-row').map((r) => visibleText(r));
    expect(modes[0]).toContain(tr('mode.creative'));
    expect(modes[1]).toContain(tr('mode.survival'));
    expect(root.querySelector('.bl-plist-link')).toBeNull();
    // The host sees each guest's connection in small print.
    v.update(true, online({ players: players(2, 0, [], [null, { bytesPerSec: 4400, backlogBytes: 0, rttMs: 61 }]), room: room({ status: 'open' }) }));
    const rows = root.querySelectorAll('.bl-plist-row');
    expect(rows[0]!.querySelector('.bl-plist-link')).toBeNull();
    expect(visibleText(rows[1]!)).toContain(t(lang, 'room.traffic', { rate: '4.3 KB', backlog: '0 B', rtt: '61' }));
    expect(root.querySelectorAll('.bl-player-name').every((n) => n.getAttribute('dir') === 'auto')).toBe(true);
    // No world: nothing to show.
    v.update(true, online({ role: null, room: null, players: [] }));
    expect(root.hidden).toBe(true);
    // The build that cannot go online: single play has no list.
    v.update(true, online({ available: false, players: players(1) }));
    expect(root.hidden).toBe(true);
  });
});
