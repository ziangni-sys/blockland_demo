/**
 * Builds the UiState snapshot the UI renders. Called every frame; it returns the SAME object
 * when nothing changed (the UI then returns immediately) and otherwise a new object that
 * reuses every unchanged part (slot arrays, toasts, worlds, settings), so a frame costs a few
 * comparisons and no garbage while the player just walks around.
 */
import type { ItemStack } from '../blocks/items';
import type { Inventory } from '../entities/inventory';
import {
  HOTBAR_SIZE,
  INVENTORY_SIZE,
  type GameMode,
  type HelmView,
  type Screen,
  type Settings,
  type SlotView,
  type Toast,
  type UiState,
  type WorldSummary,
} from '../ui/model';

/** Everything the UiState is made of, gathered by the game each frame. */
export interface UiInputs {
  screen: Screen;
  settingsReturn: Screen;
  mode: GameMode;
  /** null when no world is running. */
  inventory: Inventory | null;
  selected: number;
  health: number;
  maxHealth: number;
  air: number;
  maxAir: number;
  hint: string | null;
  toasts: readonly Toast[];
  debug: string[] | null;
  helm: HelmView | null;
  worlds: WorldSummary[];
  settings: Settings;
  loading: { text: string; progress: number } | null;
  pointerLocked: boolean;
  dragLook: boolean;
  /** The last "Save & quit" failed: offer "Quit without saving". Omitted = false. */
  quitUnsaved?: boolean;
  renderer: string;
  version: string;
}

function emptySlots(n: number): Array<SlotView | null> {
  return new Array<SlotView | null>(n).fill(null);
}

function sameSlot(view: SlotView | null, stack: ItemStack | null | undefined): boolean {
  if (!stack || stack.count <= 0) return view === null;
  return view !== null && view.item === stack.item && view.count === stack.count;
}

function toView(stack: ItemStack | null | undefined): SlotView | null {
  return stack && stack.count > 0 ? { item: stack.item, count: stack.count } : null;
}

/** Copy `stacks` into `views` if any slot differs; returns the (possibly new) array. */
function syncSlots(views: Array<SlotView | null>, stacks: ReadonlyArray<ItemStack | null> | null, n: number): Array<SlotView | null> {
  let differs = false;
  for (let i = 0; i < n; i++) {
    if (!sameSlot(views[i] ?? null, stacks ? stacks[i] : null)) {
      differs = true;
      break;
    }
  }
  if (!differs) return views;
  const out = emptySlots(n);
  for (let i = 0; i < n; i++) {
    const cur = views[i] ?? null;
    const st = stacks ? stacks[i] : null;
    out[i] = sameSlot(cur, st) ? cur : toView(st);
  }
  return out;
}

function debugEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function helmEqual(a: HelmView | null, b: HelmView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // Rounded: the instrument cannot show sub-percent changes, so they need no re-render.
  const r = (v: number): number => Math.round(v * 100);
  return r(a.throttle) === r(b.throttle) && r(a.rudder) === r(b.rudder) && r(a.speed) === r(b.speed) && a.sails === b.sails;
}

export class UiStateBuilder {
  private state: UiState | null = null;
  private hotbar: Array<SlotView | null> = emptySlots(HOTBAR_SIZE);
  private backpack: Array<SlotView | null> = emptySlots(INVENTORY_SIZE);
  private cursor: SlotView | null = null;

  build(x: UiInputs): UiState {
    const inv = x.inventory;
    const hotbar = syncSlots(this.hotbar, inv ? inv.hotbar : null, HOTBAR_SIZE);
    const backpack = syncSlots(this.backpack, inv ? inv.main : null, INVENTORY_SIZE);
    const curStack = inv ? inv.cursor : null;
    const cursor = sameSlot(this.cursor, curStack) ? this.cursor : toView(curStack);
    this.hotbar = hotbar;
    this.backpack = backpack;
    this.cursor = cursor;

    const prev = this.state;
    const loadingSame =
      prev !== null &&
      (prev.loading === x.loading ||
        (prev.loading !== null && x.loading !== null && prev.loading.text === x.loading.text && Math.abs(prev.loading.progress - x.loading.progress) < 0.002));
    if (
      prev !== null &&
      prev.screen === x.screen &&
      prev.settingsReturn === x.settingsReturn &&
      prev.mode === x.mode &&
      prev.hotbar === hotbar &&
      prev.inventory === backpack &&
      prev.cursor === cursor &&
      prev.selected === x.selected &&
      prev.health === x.health &&
      prev.maxHealth === x.maxHealth &&
      prev.air === x.air &&
      prev.maxAir === x.maxAir &&
      prev.hint === x.hint &&
      prev.toasts === x.toasts &&
      debugEqual(prev.debug, x.debug) &&
      helmEqual(prev.helm, x.helm) &&
      prev.worlds === x.worlds &&
      prev.settings === x.settings &&
      loadingSame &&
      prev.pointerLocked === x.pointerLocked &&
      prev.dragLook === x.dragLook &&
      prev.quitUnsaved === (x.quitUnsaved === true) &&
      prev.renderer === x.renderer &&
      prev.version === x.version
    ) {
      return prev;
    }
    const next: UiState = {
      screen: x.screen,
      settingsReturn: x.settingsReturn,
      mode: x.mode,
      hotbar,
      selected: x.selected,
      inventory: backpack,
      cursor,
      health: x.health,
      maxHealth: x.maxHealth,
      air: x.air,
      maxAir: x.maxAir,
      hint: x.hint,
      toasts: x.toasts as Toast[],
      debug: prev !== null && debugEqual(prev.debug, x.debug) ? prev.debug : x.debug,
      helm: prev !== null && helmEqual(prev.helm, x.helm) ? prev.helm : x.helm,
      worlds: x.worlds,
      settings: x.settings,
      loading: loadingSame && prev ? prev.loading : x.loading,
      pointerLocked: x.pointerLocked,
      dragLook: x.dragLook,
      quitUnsaved: x.quitUnsaved === true,
      renderer: x.renderer,
      version: x.version,
    };
    this.state = next;
    return next;
  }
}
