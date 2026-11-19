/**
 * Playing together, as the page shows it (package 11): the host's room, a guest's join, the player
 * list, the name, the join and leave toasts and the connection diagnostics. Headless: the page
 * (client/game.ts) passes in the browser's objects through LobbyDeps and drives it; tests drive it
 * with the fakes of package 10 and the harness's server (tests/client/lobby.test.ts).
 *
 * HOSTING. beginHosting(server) when the page's own world is open. openRoom('service') listens on
 * the page's signalling service (the public PeerJS server, or the same-browser channel when the
 * page address says ?signal=broadcast) with a new random room code; once listening, the server's
 * room is open and the view carries the code and the invitation link (the page's own address with
 * ?join=<code>, plus &signal= when not the public service). openRoom('manual') opens it for
 * invitation codes instead: makeInvitation() makes one for the next guest (ICE gathering, a few
 * seconds), acceptAnswer() takes that guest's answer; one guest at a time. closeRoom() stops new
 * joins (the guests in stay: the closed RoomHost is kept until the world ends, its forwarders
 * still carry them); opening again makes a new room with a new code. A failed open leaves the room
 * closed with the reason in the view. While a room is open or any guest is in, the world does not
 * pause (blocksPause).
 *
 * THE PLAYER LIST: the replica's player table, the host first, with who is the host and who is
 * this page, and each player's mode (the table carries it). The host sets a guest's mode
 * (SetPlayerMode) and removes a guest (Kick); next to each guest the host sees what the server
 * reports of that guest's connection (bytes a second, backlog, round trip: the host control
 * `status`, guestTraffic()). A removed guest may come back while the room is open (the host closes
 * the room to keep someone out; reopening makes a new code).
 *
 * JOINING. beginJoin(kind, code) makes the GuestJoin whose openTransport the page's session uses
 * (client/room.ts has the policy: every failure before the first Welcome is final, a lost link is
 * retried for RECONNECT_GIVE_UP_MS). The view's join says the stage (reaching the service, the
 * host, then loading the world), the manual answer code once made, 'reconnecting' while NetClient
 * reconnects, and 'failed' with the message when the join ended: a dial failure, Refuse (each
 * reason), Kick (each reason), a protocol error, a lost link given up. "Try again" is offered
 * except after a Kick or a different build; the page tears the session down and keeps the
 * failure on the loading screen until the player picks.
 *
 * TOASTS. A player joining or leaving (the player table changes of each batch), on every page,
 * never for this page's own player and not for the table a Welcome brings.
 */
import { BUILD_ID, MAX_PLAYERS, type HostCommand, type PlayerEntry, type TickBatchMsg, type WelcomeMsg } from '../net/protocol';
import type { NetStatus } from '../net/client/netclient';
import type { GuestTraffic } from '../net/host/control';
import { cleanName } from '../net/names';
import type { ConnectDeps } from '../net/webrtc/connect';
import { worldRulesFor, type WorldRules } from '../sim/rules';
import { decodeCode, ManualSignaller } from '../net/webrtc/manual';
import { DialError, newRoomCode, parseRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, type Signaller } from '../net/webrtc/signal';
import type { WebRtcTransport } from '../net/webrtc/transport';
import { isolate } from '../ui/format';
import type { GameMode, JoinView, Language, OnlineView, PlayerRow, RoomView } from '../ui/model';
import { diagnosticsText, linkReport, pairFromStats, type GuestReport, type LinkReport, type PairInfo } from './diagnostics';
import type { IntervalTimers } from './forward';
import { storedName, storeName, suggestedName } from './names';
import { dialFailureKey, GuestJoin, kickKey, refuseKey, RoomHost, type JoinStage, type RoomServer, type RoomState, type SignalKind } from './room';
import type { KeyValueStore } from './settings';
import { clientText, type ClientStringKey } from './strings';

/** Diagnostics sample the links twice this far apart, ms (the byte rates). */
export const DIAGNOSTICS_SAMPLE_MS = 1000;

export interface LobbyDeps {
  /** Whether this build can go online (client/room.ts onlineAvailable()). */
  online: boolean;
  lang(): Language;
  /** A signaller of `kind` on the page's objects. */
  signaller(kind: SignalKind): Signaller;
  /** The WebRTC handshake's dependencies (peer connections with `iceServers`, default the public STUN servers; timers). */
  connectDeps(iceServers?: readonly RTCIceServer[]): ConnectDeps;
  intervals: IntervalTimers;
  random(bytes: Uint8Array<ArrayBuffer>): void;
  now(): number;
  /** The page's address without query or fragment (invitation links). */
  baseUrl: string;
  /** The signalling of room codes: the public service, or the same-browser channel (tests, ?signal=broadcast). */
  service: 'cloud' | 'broadcast';
  /** Where the name is kept, the identity's slot and key (client/names.ts). */
  store: KeyValueStore | null;
  slot: string | null;
  playerKey: string;
  toast(text: string, kind: 'info' | 'warn' | 'error'): void;
  /** Console lines (the page: console.info / warn / error). */
  log(level: 'info' | 'warn' | 'error', text: string): void;
}

/** The session the lobby reads and commands (client/session.ts WorldSession; a HeadlessClient in tests). */
export interface LobbySession {
  readonly welcome: WelcomeMsg | null;
  /** The replica's player table (entity id -> entry), or null before Welcome. */
  readonly players: ReadonlyMap<number, PlayerEntry> | null;
  /** The replica's world rules, or null before Welcome. */
  readonly rules: WorldRules | null;
  hostCommand(command: HostCommand): boolean;
}

/** What the page measures for the diagnostics (client/game.ts). */
export interface DiagnosticsNumbers {
  rttMs: number | null;
  loss: number | null;
  delayTicks: number | null;
  serverTps: number | null;
  netStatus: string | null;
  /** Bytes of the game connection so far (the rates are taken over the sampling interval). */
  traffic: { in: number; out: number } | null;
}

/** A join target from pasted text: an invitation link, a room code, or an invitation code. */
export interface JoinTarget {
  kind: SignalKind;
  code: string;
}

const INVITE_PREFIX = 'BL1I.';
const ANSWER_PREFIX = 'BL1A.';
/** Characters a chat program or an editor may slip into pasted text that draw nothing (zero-width spaces, joiners, bidi marks, BOM, soft hyphen). */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const BASE64URL_RUN = /^[A-Za-z0-9_-]+/;

/**
 * What a player pasted to join: an invitation link (an address with ?join=<code>; its &signal=
 * or, by default, the public service), a manual invitation code (BL1I.), or a room code (the page's
 * service). Text around it, as chats and people write it, is ignored: a sentence before or after,
 * brackets or quotes, punctuation after it, a line break inside it, invisible characters. Null when
 * there is none of these, or the link's code is not a code.
 */
export function parseJoinText(text: string, service: 'cloud' | 'broadcast'): JoinTarget | null {
  const t = text.replace(INVISIBLE, '');
  const invitation = findInvitation(t);
  if (invitation !== null) return { kind: 'manual', code: invitation };
  // An answer code is the host's to paste, never a way to join (and its base64 could hold a code-like run).
  if (t.includes(ANSWER_PREFIX)) return null;
  const link = parseJoinLink(t);
  if (link !== null) return link.code === null ? null : { kind: link.kind, code: link.code };
  const code = findRoomCode(t);
  return code === null ? null : { kind: service, code };
}

/**
 * The first invitation link in `text` (its first ?join= or &join=, as in the page address): the
 * signalling (an invitation code: manual; else &signal=, by default the public service) and the
 * code, cut where the code ends (dashes and white space inside a room code are skipped: a link
 * broken across lines; anything after it is not part of it). `code` is null when what follows
 * join= is no code. Null when there is no join= at all.
 */
export function parseJoinLink(text: string): { kind: SignalKind; code: string | null } | null {
  const t = text.replace(INVISIBLE, '');
  const m = /[?&]join=/i.exec(t);
  if (m === null) return null;
  const rest = t.slice(m.index + m[0].length);
  const invitation = findInvitation(rest);
  if (invitation !== null && rest.replace(/\s+/g, '').startsWith(INVITE_PREFIX)) return { kind: 'manual', code: invitation };
  const signal = /[?&]signal=(broadcast|manual|cloud)\b/i.exec(t)?.[1]?.toLowerCase();
  const kind: SignalKind = signal === 'broadcast' || signal === 'manual' ? signal : 'cloud';
  return { kind, code: leadingRoomCode(rest) };
}

/**
 * A room code at the very start of `text`: ROOM_CODE_LENGTH characters of the alphabet (any case),
 * dashes and white space between them skipped, not followed straight away by another letter or
 * digit (then it is longer than a code). Null otherwise.
 */
function leadingRoomCode(text: string): string | null {
  let code = '';
  let i = 0;
  for (; i < text.length && code.length < ROOM_CODE_LENGTH; i++) {
    const ch = text[i]!;
    if (ch === '-' || /\s/.test(ch)) {
      if (code.length === 0) return null;
      continue;
    }
    const up = ch.toUpperCase();
    if (!ROOM_CODE_ALPHABET.includes(up)) return null;
    code += up;
  }
  if (code.length < ROOM_CODE_LENGTH) return null;
  return i < text.length && /[A-Za-z0-9]/.test(text[i]!) ? null : code;
}

/**
 * A room code standing alone in `text`: a word of 8 code characters, or two of 4 joined by a dash
 * (one joined by a space only when that is the whole text, as typed: "abcd efgh"; in a sentence two
 * words of four would be read as a code). Several different candidates: the one written in capitals
 * (codes are shown so), else none.
 */
function findRoomCode(text: string): string | null {
  const whole = parseRoomCode(text.trim());
  if (whole !== null) return whole;
  const found = new Set<string>();
  const capitals = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9_-])([A-Za-z0-9]{8}|[A-Za-z0-9]{4}-[A-Za-z0-9]{4})(?![A-Za-z0-9_-])/g)) {
    const code = parseRoomCode(m[1]!);
    if (code === null) continue;
    found.add(code);
    if (m[1] === m[1]!.toUpperCase()) capitals.add(code);
  }
  if (found.size === 1) return [...found][0]!;
  return capitals.size === 1 ? [...capitals][0]! : null;
}

/**
 * A manual invitation code in `text`: BL1I. and the base64url after it. A code wrapped across lines
 * goes on in the following words; the first length that decodes is the code (a word after it, or
 * punctuation, is not part of it). When no length decodes (a truncated copy), the first run, so the
 * join says the code is not valid. Null when there is no BL1I. in the text.
 */
function findInvitation(text: string): string | null {
  const at = text.indexOf(INVITE_PREFIX);
  if (at < 0) return null;
  let rest = text.slice(at + INVITE_PREFIX.length);
  let code = INVITE_PREFIX;
  const first = BASE64URL_RUN.exec(rest)?.[0] ?? '';
  for (;;) {
    const run = BASE64URL_RUN.exec(rest)?.[0];
    if (run === undefined) break;
    code += run;
    if (decodeCode(INVITE_PREFIX, code) !== null) return code;
    rest = rest.slice(run.length);
    const gap = /^\s+/.exec(rest)?.[0];
    if (gap === undefined) break;
    rest = rest.slice(gap.length);
  }
  return INVITE_PREFIX + first;
}

/** The invitation link to room `code` on signalling `kind` from the page at `baseUrl`. */
export function invitationLink(baseUrl: string, code: string, kind: 'cloud' | 'broadcast'): string {
  return `${baseUrl}?join=${code}${kind === 'cloud' ? '' : `&signal=${kind}`}`;
}

/** A room code as shown: two groups of four (the dash is ignored when typed back). */
export function showRoomCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

interface JoinState {
  target: JoinTarget;
  join: GuestJoin;
  stage: JoinView['stage'];
  answer: string | null;
  /** The failure's message, kept as a key so the view follows the language. */
  error: Message | null;
  canRetry: boolean;
  wasIn: boolean;
}

/** A client string with its parameters (localised when the view is made). */
interface Message {
  key: ClientStringKey;
  params?: Record<string, string>;
}

export class Lobby {
  /** The name others see (stored, else the suggestion). */
  private nameValue: string;
  private nameChosenValue: boolean;
  // ---- hosting
  private server: RoomServer | null = null;
  private room: RoomHost | null = null;
  /** Rooms closed while guests were in: kept (their forwarders carry those guests) until the world ends. */
  private readonly retired: RoomHost[] = [];
  private roomError: Message | string | null = null;
  private roomWasLost = false;
  private invitation: string | null = null;
  private inviting = false;
  private answered = false;
  /** The server's latest report of each guest's connection, by entity id (host control `status`). */
  private traffic = new Map<number, GuestTraffic>();
  // ---- joining
  private joinState: JoinState | null = null;
  /**
   * Invitation codes this page answered: an invitation is one guest's offer, and a second answer
   * to it fails the WebRTC handshake (ICE) after the host pastes it, so it is not tried again.
   */
  private readonly usedInvitations = new Set<string>();
  // ---- the world
  private session: LobbySession | null = null;
  /** Names of the players announced so far (the leave toast names who left). */
  private readonly known = new Map<number, string>();
  /**
   * The last connection error of this world or join, for the diagnostics: a string key and the
   * failure's code only, never its free text (a dial failure's message names the room code).
   */
  private lastErrorValue: string | null = null;
  private diag: string | null = null;
  private diagBusy = false;
  private version = 0;
  /**
   * The last view and what it was made from: besides the version, the session's Welcome, player
   * table and rules by identity (the page's session adopts a new replica at its next frame, after the
   * batch the lobby saw: a view made in between would keep the old, empty table).
   */
  private cached: { version: number; lang: Language; welcome: WelcomeMsg | null; players: ReadonlyMap<number, PlayerEntry> | null; rules: WorldRules | null; view: OnlineView } | null = null;

  constructor(private readonly d: LobbyDeps) {
    const stored = storedName(d.store, d.slot);
    this.nameChosenValue = stored !== null;
    this.nameValue = stored ?? suggestedName(d.playerKey, d.lang());
  }

  // ------------------------------------------------------------------ the name

  get playerName(): string {
    return this.nameChosenValue ? this.nameValue : suggestedName(this.d.playerKey, this.d.lang());
  }

  /** Whether the player chose a name (the page asks once until then). */
  get nameChosen(): boolean {
    return this.nameChosenValue;
  }

  /** Keep `text` as the name; false (nothing changes) when it breaks the rules. */
  setPlayerName(text: string): boolean {
    const name = cleanName(text);
    if (name === null) return false;
    storeName(this.d.store, this.d.slot, name);
    this.nameValue = name;
    this.nameChosenValue = true;
    this.changed();
    return true;
  }

  // ------------------------------------------------------------------ the world

  /** The session of the open world (null when it ends). */
  attach(session: LobbySession | null): void {
    this.session = session;
    this.known.clear();
    this.changed();
  }

  /** The page's own world is open with `server`: this page hosts it. */
  beginHosting(server: RoomServer): void {
    this.server = server;
    this.lastErrorValue = null;
    this.changed();
  }

  /**
   * The world ends (quit, left, failed): rooms end (their forwarders close once the server's
   * Kick(shutdown) went out), the join stops. A failed join's message stays (`keepJoin`) for the
   * loading screen until the player picks.
   */
  endWorld(keepJoin = false): void {
    for (const r of [this.room, ...this.retired]) r?.end();
    this.room = null;
    this.retired.length = 0;
    this.server = null;
    this.roomError = null;
    this.roomWasLost = false;
    this.invitation = null;
    this.inviting = false;
    this.answered = false;
    this.traffic = new Map();
    this.joinState?.join.end();
    if (!keepJoin || this.joinState?.stage !== 'failed') this.joinState = null;
    this.session = null;
    this.known.clear();
    this.diag = null;
    this.changed();
  }

  /** The world's server failed: no new guests (they would wait for a Welcome that never comes); the ones in stay. */
  stopNewGuests(): void {
    this.room?.close();
    this.changed();
  }

  /** A room is open or guests are in: the world does not pause (DESIGN 联机的世界不暂停). */
  get blocksPause(): boolean {
    return [this.room, ...this.retired].some((r) => r !== null && (r.state !== 'closed' || r.guests > 0));
  }

  get role(): 'host' | 'guest' | null {
    return this.joinState !== null ? 'guest' : this.server !== null ? 'host' : null;
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  /** The current room, for the debug helpers. */
  get currentRoom(): RoomHost | null {
    return this.room;
  }

  /** The current join, for the debug helpers. */
  get currentJoin(): GuestJoin | null {
    return this.joinState?.join ?? null;
  }

  /** The current join's target (try again joins it anew). */
  get joinTarget(): JoinTarget | null {
    return this.joinState?.target ?? null;
  }

  // ------------------------------------------------------------------ hosting

  /**
   * Open the room through the page's signalling service ('service') or for invitation codes
   * ('manual'). Resolves with the room code (null for manual rooms) or the failure, whose message
   * is shown. `code` / `iceServers` for tests and the debug helpers.
   */
  async openRoom(way: 'service' | 'manual', opts: { code?: string; signal?: SignalKind; iceServers?: readonly RTCIceServer[] } = {}): Promise<{ ok: boolean; code: string | null; error: string | null }> {
    const lang = this.d.lang();
    if (!this.d.online) {
      this.d.toast(clientText(lang, 'room.offline'), 'error');
      return { ok: false, code: null, error: 'offline' };
    }
    const server = this.server;
    if (server === null) {
      this.d.toast(clientText(lang, 'room.noWorld'), 'error');
      return { ok: false, code: null, error: 'no_world' };
    }
    if (this.room !== null && this.room.state !== 'closed') return { ok: true, code: this.room.signaller.kind === 'manual' ? null : this.room.code, error: null };
    // A closed room keeps its guests: it is retired (ended with the world), not ended now.
    if (this.room !== null && this.room.guests > 0) this.retired.push(this.room);
    else this.room?.end();
    this.room = null;
    const kind: SignalKind = opts.signal ?? (way === 'manual' ? 'manual' : this.d.service);
    const code = opts.code ?? newRoomCode(this.d.random);
    const room: RoomHost = new RoomHost({
      server,
      signaller: this.d.signaller(kind),
      code,
      deps: this.d.connectDeps(opts.iceServers),
      intervals: this.d.intervals,
      onState: (st) => this.onRoomState(room, st),
      onGuestFailed: (e) => {
        this.lastErrorValue = `guest handshake: ${e.code}`;
        this.d.log('warn', `[blocklands] a guest could not connect (${e.code}): ${e.message}`);
      },
    });
    this.room = room;
    this.roomError = null;
    this.invitation = null;
    this.answered = false;
    this.changed();
    try {
      await room.open();
    } catch (e) {
      if (this.room === room) this.room = null;
      const failure = e instanceof DialError ? e.code : e instanceof Error ? e.message : String(e);
      const msg = e instanceof DialError ? clientText(lang, dialFailureKey(e.code)) : failure;
      this.lastErrorValue = `open room: ${e instanceof DialError ? e.code : 'error'}`;
      this.roomError = e instanceof DialError ? { key: dialFailureKey(e.code) } : failure;
      this.d.log('error', `[blocklands] could not open the room: ${failure}`);
      this.d.toast(clientText(lang, 'room.failed', { msg }), 'error');
      this.changed();
      return { ok: false, code: null, error: failure };
    }
    if (this.room !== room || room.state === 'closed') return { ok: false, code: null, error: 'closed' };
    this.d.log('info', `[blocklands] room open (${kind})`);
    this.d.toast(kind === 'manual' ? clientText(lang, 'room.openManual') : clientText(lang, 'room.open', { code: showRoomCode(code) }), 'info');
    this.changed();
    return { ok: true, code: kind === 'manual' ? null : code, error: null };
  }

  /** No new guests (the guests in stay). */
  closeRoom(): void {
    const room = this.room;
    if (room === null || room.state === 'closed') return;
    room.close();
    this.invitation = null;
    this.inviting = false;
    this.answered = false;
    this.d.toast(clientText(this.d.lang(), 'room.closed'), 'info');
    this.changed();
  }

  /** Manual rooms: a new invitation code for the next guest (null when the room is not open for codes). */
  async makeInvitation(): Promise<string | null> {
    const signaller = this.room?.signaller;
    if (!(signaller instanceof ManualSignaller) || this.room?.state === 'closed' || this.inviting) return null;
    this.inviting = true;
    this.answered = false;
    this.changed();
    try {
      const code = await signaller.invite();
      if (this.room?.signaller !== signaller) return null;
      this.invitation = code;
      return code;
    } catch (e) {
      this.lastErrorValue = `invitation: ${e instanceof DialError ? e.code : 'error'}`;
      this.d.log('error', `[blocklands] the invitation could not be made: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      this.inviting = false;
      this.changed();
    }
  }

  /** Manual rooms: the guest's answer code; false (with a message) when it does not answer an open invitation. */
  acceptAnswer(answer: string): boolean {
    const signaller = this.room?.signaller;
    if (!(signaller instanceof ManualSignaller)) return false;
    try {
      signaller.accept(answer);
    } catch (e) {
      this.d.toast(clientText(this.d.lang(), e instanceof DialError ? dialFailureKey(e.code) : 'join.badCode'), 'error');
      return false;
    }
    this.invitation = null;
    this.answered = true;
    this.changed();
    return true;
  }

  /** Host: the server's report of every guest's connection (host control `status`, about once a second while guests are in). */
  guestTraffic(guests: readonly GuestTraffic[]): void {
    this.traffic = new Map(guests.map((g) => [g.entityId, g]));
    this.changed();
  }

  /** Host: set guest `entityId`'s mode. */
  setPlayerMode(entityId: number, mode: GameMode): boolean {
    const s = this.session;
    if (s === null || s.welcome?.isHost !== true || entityId === s.welcome.entityId) return false;
    return s.hostCommand({ kind: 'setPlayerMode', entityId, mode });
  }

  /** Host: the world's rules (a new player's mode, whether loosened blocks drop), set apart from the host's own mode online. */
  setWorldRules(mode: GameMode): boolean {
    const s = this.session;
    if (s === null || s.welcome?.isHost !== true) return false;
    return s.hostCommand({ kind: 'setRules', rules: worldRulesFor(mode) });
  }

  /** Host: remove guest `entityId` from the room. */
  kick(entityId: number): boolean {
    const s = this.session;
    if (s === null || s.welcome?.isHost !== true || entityId === s.welcome.entityId) return false;
    return s.hostCommand({ kind: 'kick', entityId });
  }

  private onRoomState(room: RoomHost, state: RoomState): void {
    if (room !== this.room) return;
    const lang = this.d.lang();
    if (state === 'lost') {
      this.lastErrorValue = 'signalling service lost';
      this.d.toast(clientText(lang, 'room.lost'), 'warn');
    } else if (state === 'open' && this.roomWasLost) this.d.toast(clientText(lang, 'room.back'), 'info');
    this.roomWasLost = state === 'lost';
    this.changed();
  }

  // ------------------------------------------------------------------ joining

  /**
   * A guest's way to the host of `target` (its openTransport goes to the page's session). The page
   * hears `onFinal` when the join ended for good (the view then holds the message).
   */
  beginJoin(target: JoinTarget, onFinal: () => void, opts: { iceServers?: readonly RTCIceServer[] } = {}): GuestJoin {
    this.joinState?.join.end();
    const signaller = this.d.signaller(target.kind);
    const join: GuestJoin = new GuestJoin({
      signaller,
      code: target.code,
      deps: this.d.connectDeps(opts.iceServers),
      now: () => this.d.now(),
      onStage: (stage: JoinStage) => {
        if (this.joinState?.join === join && this.joinState.stage !== 'reconnecting' && this.joinState.stage !== 'failed') {
          this.joinState.stage = stage;
          this.changed();
        }
      },
      onFinal: (key, detail) => {
        if (this.joinState?.join !== join) return;
        this.fail(key, detail, true);
        onFinal();
      },
    });
    if (signaller instanceof ManualSignaller) {
      signaller.onAnswer = (answer) => {
        if (this.joinState?.join !== join) return;
        this.joinState.answer = answer;
        this.usedInvitations.add(target.code);
        this.d.log('info', `[blocklands] answer code ready (${answer.length} characters)`);
        this.changed();
      };
    }
    this.joinState = { target, join, stage: 'service', answer: null, error: null, canRetry: true, wasIn: false };
    this.lastErrorValue = null;
    this.diag = null;
    this.changed();
    return join;
  }

  /** Whether this page already answered invitation `code` (joining with it again cannot work). */
  invitationUsed(code: string): boolean {
    return this.usedInvitations.has(code);
  }

  /** Forget a failed join (the player went back to the menu). */
  clearJoin(): void {
    this.joinState?.join.end();
    this.joinState = null;
    this.changed();
  }

  /**
   * The session's NetClient status changed. For a guest it decides what happens: true when the
   * connection ended for good (the view's join holds the message; the page tears the session down).
   */
  netStatus(status: NetStatus, net: { kick: { reason: Parameters<typeof kickKey>[0]; detail: string } | null; refusal: { reason: Parameters<typeof refuseKey>[0]; detail: string } | null; failure: string | null; welcome: WelcomeMsg | null }): boolean {
    if (status === 'joining') this.welcomed(net.welcome);
    const j = this.joinState;
    if (j === null || j.stage === 'failed') return false;
    if (status === 'joining' || status === 'ready') {
      j.join.connected();
      j.wasIn = true;
      if (j.stage !== 'world') {
        j.stage = 'world';
        this.changed();
      }
      return false;
    }
    if (status === 'reconnecting') {
      j.join.linkLost();
      // linkLost may have ended the join (a link lost before the first Welcome).
      if ((j.stage as JoinView['stage']) !== 'failed' && j.wasIn) {
        j.stage = 'reconnecting';
        this.lastErrorValue = 'link lost';
        this.changed();
      }
      return false;
    }
    if (status === 'kicked') {
      const k = net.kick;
      this.fail(k !== null ? kickKey(k.reason) : 'net.kicked', k?.detail ?? '?', false, k === null ? { reason: '?' } : undefined);
      return true;
    }
    if (status === 'refused') {
      const r = net.refusal;
      this.fail(r !== null ? refuseKey(r.reason) : 'net.refused', r?.detail ?? '?', r?.reason !== 'build', r === null ? { reason: '?' } : undefined);
      return true;
    }
    if (status === 'failed') {
      this.fail('net.failed', net.failure ?? '?', true, { msg: net.failure ?? '?' });
      return true;
    }
    return false;
  }

  private welcomed(w: WelcomeMsg | null): void {
    this.known.clear();
    if (w !== null) for (const p of w.players) this.known.set(p.entityId, p.name);
    this.changed();
  }

  private fail(key: ClientStringKey, detail: string, canRetry: boolean, params?: Record<string, string>): void {
    const j = this.joinState;
    if (j === null) return;
    j.join.end();
    j.stage = 'failed';
    j.error = params === undefined ? { key } : { key, params };
    // An answered invitation cannot be answered again: the host must make a new one.
    j.canRetry = canRetry && !this.usedInvitations.has(j.target.code);
    const code = j.join.failure?.code;
    this.lastErrorValue = code !== undefined ? `${key} (${code})` : key;
    this.d.log('error', `[blocklands] ${clientText(this.d.lang(), key, params)} (${detail})`);
    this.changed();
  }

  // ------------------------------------------------------------------ batches

  /** A batch was applied: toasts for players joining and leaving (a mode change only redraws the list). */
  onBatch(batch: TickBatchMsg): void {
    // The world's rules show on the host's room screen.
    if (batch.globals?.rules !== undefined) this.changed();
    const changes = batch.globals?.players;
    if (changes === undefined || changes.length === 0) return;
    const self = this.session?.welcome?.entityId ?? -1;
    const lang = this.d.lang();
    for (const c of changes) {
      if (c.op === 'join') {
        this.known.set(c.entityId, c.name);
        if (c.entityId !== self) this.d.toast(clientText(lang, 'players.joined', { name: isolate(c.name) }), 'info');
        // The friend whose answer the host pasted is in: "connecting this friend" is over.
        if (c.entityId !== self) this.answered = false;
      } else if (c.op === 'leave') {
        const name = this.known.get(c.entityId);
        this.known.delete(c.entityId);
        if (c.entityId !== self && name !== undefined) this.d.toast(clientText(lang, 'players.left', { name: isolate(name) }), 'info');
      }
    }
    this.changed();
  }

  // ------------------------------------------------------------------ diagnostics

  /** The guest's link to the host, or each guest's link of the host's rooms with the guest's entity id once welcomed. */
  private links(): Array<{ link: WebRtcTransport; entityId: number | null }> {
    if (this.joinState !== null) {
      const t = this.joinState.join.transport;
      return t !== null && t.open ? [{ link: t, entityId: null }] : [];
    }
    return [this.room, ...this.retired].flatMap((r) => (r === null ? [] : r.links()));
  }

  /**
   * Measure and format the connection diagnostics (client/diagnostics.ts): each link's candidate
   * pair twice DIAGNOSTICS_SAMPLE_MS apart, and the page's numbers; on the host, one entry per
   * guest of the player table with its link and the server's latest report of it. The text goes
   * in the view.
   */
  async diagnostics(numbers: () => DiagnosticsNumbers): Promise<string> {
    this.diagBusy = true;
    this.changed();
    const links = this.links();
    const sample = async (): Promise<Array<PairInfo | null>> =>
      Promise.all(
        links.map(async ({ link }) => {
          try {
            const r = await link.stats();
            return r === null ? null : pairFromStats(r);
          } catch {
            return null;
          }
        }),
      );
    const before = await sample();
    const n0 = numbers();
    const t0 = this.d.now();
    await new Promise<void>((resolve) => this.d.connectDeps().timers.set(resolve, DIAGNOSTICS_SAMPLE_MS));
    const after = await sample();
    const n1 = numbers();
    const ms = Math.max(1, this.d.now() - t0);
    const rate = (a: number | undefined, b: number | undefined): number | null => (a === undefined || b === undefined ? null : Math.max(0, ((b - a) * 1000) / ms));
    const reports = links.map((l, i) => ({ entityId: l.entityId, report: linkReport(before[i] ?? null, after[i] ?? null, ms) }));
    const role = this.role;
    const room = this.room;
    const text = diagnosticsText({
      build: BUILD_ID,
      role,
      signal: role === 'guest' ? (this.joinState?.target.kind ?? null) : (room?.signaller.kind ?? null),
      roomOpen: role === 'host' ? room !== null && room.state !== 'closed' : null,
      link: role === 'guest' ? (reports[0]?.report ?? null) : null,
      guests: role === 'host' ? this.guestReports(reports) : [],
      rttMs: n1.rttMs,
      loss: n1.loss,
      delayTicks: n1.delayTicks,
      inPerSec: rate(n0.traffic?.in, n1.traffic?.in),
      outPerSec: rate(n0.traffic?.out, n1.traffic?.out),
      serverTps: n1.serverTps,
      netStatus: n1.netStatus,
      lastError: this.lastErrorValue,
      dialFailure: role === 'guest' && this.joinState?.join.failure != null ? { code: this.joinState.join.failure.code, attempt: this.joinState.join.failure.attempt } : null,
    });
    this.diag = text;
    this.diagBusy = false;
    this.changed();
    return text;
  }

  /**
   * The host's guests for the diagnostics: the other players of the table in its order, each with
   * its link (matched by entity id) and the server's numbers; then links not welcomed yet.
   */
  private guestReports(links: ReadonlyArray<{ entityId: number | null; report: LinkReport }>): GuestReport[] {
    const out: GuestReport[] = [];
    const used = new Set<number>();
    for (const row of this.playerRows()) {
      if (row.you) continue;
      const i = links.findIndex((l) => l.entityId === row.entityId);
      if (i >= 0) used.add(i);
      const t = this.traffic.get(row.entityId);
      out.push({ link: i >= 0 ? links[i]!.report : null, server: t === undefined ? null : { bytesPerSec: t.bytesPerSec, backlogBytes: t.backlogBytes, rttMs: t.rttMs } });
    }
    links.forEach((l, i) => {
      if (!used.has(i)) out.push({ link: l.report, server: null });
    });
    return out;
  }

  // ------------------------------------------------------------------ the view

  private changed(): void {
    this.version++;
  }

  /** The UI's view of all this (the same object while nothing changed). */
  view(): OnlineView {
    const lang = this.d.lang();
    const s = this.session;
    const welcome = s?.welcome ?? null;
    const players = s?.players ?? null;
    const rules = s?.rules ?? null;
    const c = this.cached;
    if (c !== null && c.version === this.version && c.lang === lang && c.welcome === welcome && c.players === players && c.rules === rules) return c.view;
    const view: OnlineView = {
      available: this.d.online,
      playerName: this.playerName,
      role: this.role,
      pauses: this.role !== 'guest' && !this.blocksPause,
      room: this.roomView(),
      players: this.playerRows(),
      maxPlayers: MAX_PLAYERS,
      join: this.joinView(),
      diagnostics: this.diag,
      diagnosticsBusy: this.diagBusy,
    };
    this.cached = { version: this.version, lang, welcome, players, rules, view };
    return view;
  }

  private roomView(): RoomView | null {
    if (this.server === null || this.joinState !== null) return null;
    const r = this.room;
    const state: RoomState = r?.state ?? 'closed';
    const kind = r?.signaller.kind ?? this.d.service;
    const service = kind !== 'manual';
    const live = state !== 'closed';
    return {
      status: state,
      signal: kind,
      code: live && service && r !== null ? showRoomCode(r.code) : null,
      link: live && service && r !== null ? invitationLink(this.d.baseUrl, r.code, kind) : null,
      invitation: live && !service ? this.invitation : null,
      inviting: this.inviting,
      answered: this.answered,
      error: this.roomError === null ? null : typeof this.roomError === 'string' ? this.roomError : clientText(this.d.lang(), this.roomError.key, this.roomError.params),
      // Only online: in single play the pause menu's mode switch carries the rules (and the world may be paused).
      rules: this.blocksPause ? (this.session?.rules?.defaultMode ?? null) : null,
    };
  }

  private playerRows(): PlayerRow[] {
    const s = this.session;
    const table = s?.players ?? null;
    if (s === null || table === null) return [];
    const self = s.welcome?.entityId ?? -1;
    const hostView = s.welcome?.isHost === true;
    const rows: PlayerRow[] = [];
    for (const p of table.values()) {
      const t = hostView && p.entityId !== self ? this.traffic.get(p.entityId) : undefined;
      const traffic = t === undefined ? null : { bytesPerSec: t.bytesPerSec, backlogBytes: t.backlogBytes, rttMs: t.rttMs };
      rows.push({ entityId: p.entityId, name: p.name, host: p.host, you: p.entityId === self, mode: p.mode, traffic });
    }
    rows.sort((a, b) => (a.host !== b.host ? (a.host ? -1 : 1) : a.entityId - b.entityId));
    return rows;
  }

  private joinView(): JoinView | null {
    const j = this.joinState;
    if (j === null) return null;
    const error = j.error === null ? null : clientText(this.d.lang(), j.error.key, j.error.params);
    return { stage: j.stage, signal: j.target.kind, answer: j.answer, error, canRetry: j.canRetry, wasIn: j.wasIn };
  }
}
