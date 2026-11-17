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
  | 'death';

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
  /** Close the world without saving; only offered after a failed "Save & quit" (quitUnsaved). */
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
}

/** Handle returned by the UI factory (src/ui/index.ts: createUi(root, actions)). */
export interface UiHandle {
  /** Render the given state. Cheap when nothing changed (the UI diffs internally). */
  update(state: UiState): void;
  /** True while a text input inside the UI has focus (the client then ignores game keys). */
  wantsKeyboard(): boolean;
  dispose(): void;
}
