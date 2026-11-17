/**
 * UI root: owns the DOM tree, the shared context and every view, and routes each UiState
 * snapshot to the views that need it. update() is designed to be called every frame:
 * identical snapshots return immediately, and each view compares against its own memo of
 * what it last rendered, writing the DOM only for real changes.
 */
import { allItems } from '../blocks/items';
import { UiContext } from './context';
import { h } from './dom';
import { IconCache, type IconProvider } from './icons';
import { ACTIVATOR_ROLES, blocksRepeatActivation, type KeyTargetKind } from './keys';
import type { Screen, UiActions, UiHandle, UiState } from './model';
import { UI_CSS } from './styles';
import { DeathView } from './views/death';
import { Hud } from './views/hud';
import { InventoryView } from './views/inventory';
import { HudLayoutController } from './views/layout';
import { LoadingView } from './views/loading';
import { MainMenuView } from './views/mainMenu';
import { PauseView } from './views/pause';
import type { ScreenView } from './views/screen';
import { SettingsView } from './views/settings';
import { ToastStack } from './views/toasts';

const STYLE_ID = 'bl-ui-style';
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export interface UiOptions {
  /** RGBA pixels (size*size*4, row 0 = top) for an item icon, or null for the placeholder. */
  iconProvider?: IconProvider;
}

type ModalScreen = Exclude<Screen, 'none'>;

/** Icon backing-store edge: 64 px at 1x, rounded up to a multiple of 32 for denser screens. */
function iconSizeFor(dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(128, Math.max(64, Math.ceil((d * 64) / 32) * 32));
}

/** Screens shown over a running world (the HUD and debug overlay stay mounted beneath). */
function isInGame(s: UiState): boolean {
  if (s.screen === 'mainMenu' || s.screen === 'loading') return false;
  if (s.screen === 'settings') return s.settingsReturn !== 'mainMenu';
  return true;
}

/** How the focused element treats Enter / Space (see keys.ts). */
function keyTargetKind(t: EventTarget | null): KeyTargetKind {
  if (t instanceof HTMLTextAreaElement) return 'multiline';
  if (t instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(t.type) ? 'field' : 'activator';
  if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement || t instanceof HTMLSelectElement) return 'activator';
  if (t instanceof HTMLElement) {
    if (t.isContentEditable) return 'multiline';
    const role = t.getAttribute('role');
    if (role !== null && ACTIVATOR_ROLES.has(role)) return 'activator';
  }
  return 'other';
}

export class UiRoot implements UiHandle {
  private readonly el: HTMLElement;
  private readonly doc: Document;
  private readonly ctx: UiContext;
  private readonly hud: Hud;
  private readonly toasts: ToastStack;
  private readonly inventory: InventoryView;
  private readonly screens: Readonly<Record<ModalScreen, ScreenView>>;
  private readonly layout: HudLayoutController;
  private readonly onContextMenu = (e: Event): void => {
    // The host page's context menu is never useful over the game UI (right click is a game
    // input), except in text fields where copy / paste live.
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    e.preventDefault();
  };
  /** Capture phase: cancel auto-repeated Enter / Space activations before any control sees them. */
  private readonly onKeyGuard = (e: KeyboardEvent): void => {
    if (blocksRepeatActivation(e.key, e.repeat, e.isComposing, keyTargetKind(e.target))) e.preventDefault();
  };
  private dprQuery: MediaQueryList | null = null;
  private dpr = 0;
  private readonly onDprChange = (): void => this.watchPixelRatio();
  private last: UiState | null = null;
  private screen: Screen | null = null;
  private inGame: boolean | null = null;
  private disposed = false;

  constructor(root: HTMLElement, actions: UiActions, opts: UiOptions = {}) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    this.doc = doc;
    acquireStyle(doc);

    const reduced = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const iconSize = iconSizeFor(win ? win.devicePixelRatio : 1);
    this.ctx = new UiContext(doc, actions, new IconCache(doc, opts.iconProvider), iconSize, reduced);

    this.el = h(doc, 'div', 'bl-ui', { 'data-screen': '', 'data-ingame': '0', lang: 'zh-CN' });
    this.hud = new Hud(this.ctx);
    this.toasts = new ToastStack(this.ctx);
    this.inventory = new InventoryView(this.ctx, this.el);
    this.screens = {
      mainMenu: new MainMenuView(this.ctx),
      loading: new LoadingView(this.ctx),
      pause: new PauseView(this.ctx),
      inventory: this.inventory,
      settings: new SettingsView(this.ctx),
      death: new DeathView(this.ctx),
    };
    const safeProbe = h(doc, 'div', 'bl-safe-probe', { 'aria-hidden': 'true' });
    this.el.prepend(this.hud.el, safeProbe);
    for (const v of Object.values(this.screens)) this.el.insertBefore(v.el, this.el.querySelector('.bl-tooltip'));
    this.el.insertBefore(this.toasts.el, this.el.querySelector('.bl-tooltip'));
    this.el.addEventListener('contextmenu', this.onContextMenu);
    this.el.addEventListener('keydown', this.onKeyGuard, true);
    root.appendChild(this.el);

    const hud = this.hud;
    this.layout = new HudLayoutController({
      root: this.el,
      cluster: hud.cluster,
      crosshair: hud.crosshair,
      hint: hud.hintEl,
      debug: hud.debugEl,
      helm: hud.helmEl,
      veil: hud.veil,
      veilCard: hud.veilCard,
      toasts: this.toasts.el,
      safeProbe,
    });
    this.watchPixelRatio();
    // Render every item icon in idle time while the player is still on the menus, so the
    // first creative palette (every item at once) opens without a stall.
    this.ctx.icons.prewarm(
      allItems().map((it) => it.id),
      this.ctx.iconSize,
    );
  }

  update(s: UiState): void {
    if (this.disposed || s === this.last) return;
    this.last = s;
    this.ctx.icons.beginFrame();
    // Fallback for hosts whose resolution media query never reports a change (seen with
    // emulated pixel ratios): a property read per changed snapshot.
    const win = this.doc.defaultView;
    if (win && win.devicePixelRatio !== this.dpr) this.watchPixelRatio();

    const lang = s.settings.language === 'en' ? 'en' : 'zh';
    if (lang !== this.ctx.lang) {
      this.ctx.lang = lang;
      this.el.lang = lang === 'en' ? 'en' : 'zh-CN';
      this.ctx.relocalize();
      this.hud.relocalize();
      for (const v of Object.values(this.screens)) v.relocalize();
    }

    const inGame = isInGame(s);
    if (inGame !== this.inGame) {
      this.inGame = inGame;
      this.el.dataset.ingame = inGame ? '1' : '0';
    }

    const from = this.screen;
    const changed = s.screen !== from;
    if (changed) {
      const old = from && from !== 'none' ? this.screens[from] : undefined;
      if (old) {
        // Blur first: a focused text field in a hidden screen would keep wantsKeyboard() true.
        const a = this.doc.activeElement;
        if (a instanceof HTMLElement && old.el.contains(a)) a.blur();
        old.onHide();
        old.el.hidden = true;
      }
      this.screen = s.screen;
      this.el.dataset.screen = s.screen;
    }

    const view = s.screen !== 'none' ? this.screens[s.screen] : undefined;
    // Render before revealing so the first visible frame is already correct.
    if (view) view.update(s);
    if (changed) {
      if (view) {
        view.el.hidden = false;
        view.onShow(s, from);
      } else {
        // Back to play: drop focus from any UI control so Space / Enter reach the game.
        const a = this.doc.activeElement;
        if (a instanceof HTMLElement && this.el.contains(a)) a.blur();
      }
    }

    this.hud.update(s, inGame, s.screen === 'none');
    this.toasts.update(s.toasts);
  }

  wantsKeyboard(): boolean {
    const a = this.doc.activeElement;
    if (!a || !this.el.contains(a)) return false;
    if (a instanceof HTMLTextAreaElement) return true;
    if (a instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(a.type);
    return a instanceof HTMLElement && a.isContentEditable;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.el.removeEventListener('contextmenu', this.onContextMenu);
    this.el.removeEventListener('keydown', this.onKeyGuard, true);
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.layout.dispose();
    for (const v of Object.values(this.screens)) v.dispose();
    this.toasts.dispose();
    this.ctx.icons.dispose();
    this.el.remove();
    releaseStyle(this.doc);
  }

  /**
   * Keep icon resolution matched to devicePixelRatio, which changes with browser zoom or when
   * the window moves to another monitor. A resolution media query for the current ratio fires
   * 'change' once the ratio leaves it; then re-arm for the new ratio and repaint if the icon
   * backing size moved.
   */
  private watchPixelRatio(): void {
    const win = this.doc.defaultView;
    if (!win) return;
    this.dpr = win.devicePixelRatio;
    if (typeof win.matchMedia === 'function') {
      this.dprQuery?.removeEventListener('change', this.onDprChange);
      this.dprQuery = win.matchMedia(`(resolution: ${this.dpr || 1}dppx)`);
      this.dprQuery.addEventListener('change', this.onDprChange);
    }
    const size = iconSizeFor(this.dpr);
    if (size === this.ctx.iconSize) return;
    this.ctx.iconSize = size;
    this.hud.repaintIcons();
    this.inventory.repaintIcons();
    this.ctx.icons.prewarm(
      allItems().map((it) => it.id),
      size,
    );
  }
}

/** Inject the stylesheet once per document, reference-counted across UI instances. */
function acquireStyle(doc: Document): void {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = UI_CSS;
    style.dataset.users = '0';
    doc.head.appendChild(style);
  }
  style.dataset.users = String(Number(style.dataset.users ?? '0') + 1);
}

function releaseStyle(doc: Document): void {
  const style = doc.getElementById(STYLE_ID);
  if (!style) return;
  const users = Number(style.dataset.users ?? '1') - 1;
  if (users <= 0) style.remove();
  else style.dataset.users = String(users);
}
