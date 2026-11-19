/**
 * UI contract. The UI layer is pure DOM: it renders a UiState snapshot and reports user
 * intent through UiActions. It never touches the simulation or the renderer.
 * The client builds a fresh UiState whenever something changed and calls ui.update(state).
 */

export type GameMode = 'creative' | 'survival';
export type Language = 'zh' | 'en';

/** A stack shown in a slot. null = empty slot. */
export interface SlotView {
  item: number;
  count: number;
}

export type Screen =
  | 'none' // playing: HUD only
  | 'mainMenu'
  | 'loading'
  | 'pause'
  | 'inventory'
  | 'settings'
  | 'death'
  /** "Play together" from the pause menu: hosting (the host) and who is in the world (everyone). */
  | 'room'
  /** "Join a room" from the main menu: a link, a room code or an invitation code. */
  | 'join'
  /** The player's name, asked once before the first world or join. */
  | 'name';

export interface Settings {
  /** View distance in chunks (4..16). */
  renderDistance: number;
  /** Vertical FOV in degrees (50..110). */
  fov: number;
  /** Mouse sensitivity multiplier (0.2..3). */
  sensitivity: number;
  invertY: boolean;
  language: Language;
  /** Master volume 0..1 (reserved; audio arrives in M2). */
  volume: number;
  showDebug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  renderDistance: 8,
  fov: 75,
  sensitivity: 1,
  invertY: false,
  language: 'zh',
  volume: 0.8,
  showDebug: false,
};

export interface WorldSummary {
  id: string;
  name: string;
  seed: string;
  mode: GameMode;
  /** Milliseconds since epoch of the last save, 0 if unknown. */
  lastPlayed: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error';
}

/** Steering HUD while the player holds a helm. */
export interface HelmView {
  /** -1 (full astern) .. 1 (full ahead). */
  throttle: number;
  /** -1 (port/left) .. 1 (starboard/right). */
  rudder: number;
  /** Ship speed in blocks/second. */
  speed: number;
  /** Sail blocks on the ship's working windmills. */
  sails: number;
}

// ------------------------------------------------------------------ playing together (package 11)

/** How guests reach a room: the public signalling service (or the same-browser channel of the tests), or invitation codes copied by hand. */
export type SignalKind = 'cloud' | 'broadcast' | 'manual';

/** The host's room: closed (no new guests), opening (reaching the signalling), open, lost (the signalling service went away; retrying). */
export type RoomStatus = 'closed' | 'opening' | 'open' | 'lost';

export interface RoomView {
  status: RoomStatus;
  signal: SignalKind;
  /** The room code guests dial (service rooms while open), else null. */
  code: string | null;
  /** The invitation link (the game's address with ?join=<code>), else null. */
  link: string | null;
  /** Manual rooms: the invitation code for the next guest, once made; null otherwise. */
  invitation: string | null;
  /** Manual rooms: an invitation is being made (ICE gathering takes a few seconds). */
  inviting: boolean;
  /** Manual rooms: an answer was pasted and its guest is connecting. */
  answered: boolean;
  /** Why the last attempt to open the room failed (localised), or null. */
  error: string | null;
  /**
   * The world's rules as a mode (a new player's mode; survival drops loosened blocks) while the
   * world is online (a room open or guests in); null in single play, where the pause menu's mode
   * switch carries them.
   */
  rules: GameMode | null;
}

export interface PlayerRow {
  entityId: number;
  name: string;
  host: boolean;
  /** This page's own player. */
  you: boolean;
  /** The player's game mode (the replicated player table). */
  mode: GameMode;
  /** The host's view of a guest: what the server last reported of that guest's connection; null otherwise. */
  traffic: GuestLink | null;
}

/** One guest's connection as the host's server measures it (sent per second, waiting to go out, round trip). */
export interface GuestLink {
  bytesPerSec: number;
  backlogBytes: number;
  /** 0 until the guest's client reported one. */
  rttMs: number;
}

/**
 * A guest's way into someone else's world (the loading screen): reaching the signalling service,
 * reaching the host (WebRTC), loading the world; reconnecting after the link died; failed (the
 * message, with "try again" when trying again can help, and "back to the menu").
 */
export type JoinStage = 'service' | 'host' | 'world' | 'reconnecting' | 'failed';

export interface JoinView {
  stage: JoinStage;
  signal: SignalKind;
  /** Manual joins: the answer code to send back to the host, once made. */
  answer: string | null;
  /** stage 'failed': what happened (localised). */
  error: string | null;
  canRetry: boolean;
  /** The guest had been in the world (a lost or ended connection), not a join that never got in. */
  wasIn: boolean;
}

export interface OnlineView {
  /** False in a build that cannot go online (the single-file build): the online entries are replaced by one line. */
  available: boolean;
  /** The name others see (Hello). */
  playerName: string;
  /** This page's part in the open world: the host (its own world, room open or not), a guest, or none. */
  role: 'host' | 'guest' | null;
  /** The pause menu pauses the world: single player (no room open, no guests in). Online worlds never pause. */
  pauses: boolean;
  /** The host's room, null for guests and without a world. */
  room: RoomView | null;
  /** Who is in the world (players of the replica), the host first. */
  players: PlayerRow[];
  /** Players a room holds at most. */
  maxPlayers: number;
  /** A guest's join while connecting, reconnecting or failed; null otherwise. */
  join: JoinView | null;
  /** The last "copy diagnostics" text (shown for copying by hand too), or null. */
  diagnostics: string | null;
  /** Diagnostics are being measured (about a second). */
  diagnosticsBusy: boolean;
}

export const HOTBAR_SIZE = 9;
export const INVENTORY_SIZE = 27;

export interface UiState {
  screen: Screen;
  /** Screen to return to when leaving 'settings' ('mainMenu' or 'pause'). */
  settingsReturn: Screen;
  mode: GameMode;
  /** HOTBAR_SIZE entries. */
  hotbar: Array<SlotView | null>;
  /** Selected hotbar index 0..8. */
  selected: number;
  /** INVENTORY_SIZE entries (backpack). */
  inventory: Array<SlotView | null>;
  /** The off-hand slot (a placement modifier such as glue; DESIGN 副手). */
  offhand: SlotView | null;
  /** Stack currently held by the mouse cursor inside the inventory screen. */
  cursor: SlotView | null;
  health: number;
  maxHealth: number;
  /** Remaining breath; shown only while below maxAir. */
  air: number;
  maxAir: number;
  /** Context hint shown under the crosshair, e.g. "再次右键确认组装（42 格）". */
  hint: string | null;
  /**
   * A status line under the context hint, e.g. a guest's "the host's server is being slowed
   * down" (docs/NETCODE.md section 4). It never takes the context hint's place.
   */
  notice: string | null;
  toasts: Toast[];
  /** Debug overlay lines, or null when hidden. */
  debug: string[] | null;
  helm: HelmView | null;
  /** Saved worlds for the main menu. */
  worlds: WorldSummary[];
  settings: Settings;
  /** Progress while screen === 'loading'. */
  loading: { text: string; progress: number } | null;
  /** False = show the "click to play" prompt over the HUD. */
  pointerLocked: boolean;
  /** True when the host cannot lock the pointer: show drag-to-look instructions instead. */
  dragLook: boolean;
  /**
   * The last "Save & quit" could not write the world, which therefore stayed open: the pause and
   * death screens say so and offer "Quit without saving". Omitted = false.
   */
  quitUnsaved?: boolean;
  /**
   * The world's server failed and the world stopped: the pause screen says so, cannot resume, and
   * offers "Save & quit" and "Quit without saving". Omitted = false.
   */
  worldStopped?: boolean;
  /** Playing together: rooms, joins, the player list, the name. */
  online: OnlineView;
  /** The player list is held open over the HUD (Tab during play). */
  playerList: boolean;
  /** Graphics API line for menus, e.g. "WebGPU" or "WebGL2". */
  renderer: string;
  version: string;
}

export interface NewWorldOptions {
  name: string;
  /** Free text; empty = random. */
  seed: string;
  mode: GameMode;
}

export interface UiActions {
  // ---- menus
  newWorld(opts: NewWorldOptions): void;
  loadWorld(id: string): void;
  deleteWorld(id: string): void;
  resume(): void;
  saveAndQuit(): void;
  /** Close the world without saving; only offered after a failed "Save & quit" (quitUnsaved) or in a stopped world (worldStopped). */
  quitWithoutSaving(): void;
  respawn(): void;
  openSettings(): void;
  closeSettings(): void;
  changeSettings(patch: Partial<Settings>): void;
  /** Toggle creative / survival from the pause menu. */
  setMode(mode: GameMode): void;

  // ---- inventory
  selectHotbar(index: number): void;
  /**
   * Click on a hotbar, backpack or off-hand slot while the inventory screen is open (the
   * off-hand is the one slot of its area: index 0). button 0 left, 2 right.
   */
  slotClick(area: 'hotbar' | 'inventory' | 'offhand', index: number, button: 0 | 2, shift: boolean): void;
  /** Click on an item in the creative palette: puts a stack on the cursor (shift = straight to hotbar). */
  creativePick(item: number, shift: boolean): void;
  /** Click outside any slot while holding a stack: throw it away / drop it. */
  dropCursor(): void;
  /** Close the inventory (or any closable screen) and return to play. */
  closeScreen(): void;

  // ---- playing together
  /** The name screen's "Continue" and the settings field: keep `name` (the client cleans and checks it). */
  setPlayerName(name: string): void;
  /** Pause menu: open the "Play together" screen. */
  openRoomScreen(): void;
  /** Main menu: open the "Join a room" screen. */
  openJoinScreen(): void;
  /** Open the room: through the signalling service, or with invitation codes. */
  openRoom(way: 'service' | 'manual'): void;
  /** No new guests (the ones in stay). */
  closeRoom(): void;
  /** Manual rooms: make an invitation code for the next guest. */
  makeInvitation(): void;
  /** Manual rooms: the guest's answer code. */
  acceptAnswer(code: string): void;
  /** Host: set a guest's game mode. */
  setPlayerMode(entityId: number, mode: GameMode): void;
  /** Host: remove a guest from the room. */
  kickPlayer(entityId: number): void;
  /** Host: the world's rules, set apart from the host's own mode online. */
  setWorldRules(mode: GameMode): void;
  /** Join screen: a pasted invitation link, room code or invitation code. */
  join(text: string): void;
  /** A failed join: try again. */
  retryJoin(): void;
  /** A failed join, or reconnecting: back to the main menu. */
  abandonJoin(): void;
  /** A guest's pause menu: leave the room (in place of "Save & quit"). */
  leaveRoom(): void;
  /** Measure and show the connection diagnostics (the view copies them). */
  copyDiagnostics(): void;
}

/** Handle returned by the UI factory (src/ui/index.ts: createUi(root, actions)). */
export interface UiHandle {
  /** Render the given state. Cheap when nothing changed (the UI diffs internally). */
  update(state: UiState): void;
  /** True while a text input inside the UI has focus (the client then ignores game keys). */
  wantsKeyboard(): boolean;
  dispose(): void;
}
