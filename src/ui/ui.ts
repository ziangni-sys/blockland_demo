/**
 * UI root: owns the DOM tree, the shared context and every view, and routes each UiState
 * snapshot to the views that need it. update() is designed to be called every frame:
 * identical snapshots return immediately, and each view compares against its own memo of
 * what it last rendered, writing the DOM only for real changes.
 */
import { UiContext } from './context';
import { h } from './dom';
import { IconCache, type IconProvider } from './icons';
import type { Screen, UiActions, UiHandle, UiState } from './model';
import { UI_CSS } from './styles';
import { DeathView } from './views/death';
import { Hud } from './views/hud';
import { InventoryView } from './views/inventory';
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

export class UiRoot implements UiHandle {
  private readonly el: HTMLElement;
  private readonly doc: Document;
  private readonly ctx: UiContext;
  private readonly hud: Hud;
  private readonly toasts: ToastStack;
  private readonly screens: Readonly<Record<ModalScreen, ScreenView>>;
  private readonly onContextMenu = (e: Event): void => {
    // The host page's context menu is never useful over the game UI (right click is a game
    // input), except in text fields where copy / paste live.
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    e.preventDefault();
  };
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
    this.hud = new Hud(this.ctx, this.el);
    this.toasts = new ToastStack(this.ctx);
    this.screens = {
      mainMenu: new MainMenuView(this.ctx),
      loading: new LoadingView(this.ctx),
      pause: new PauseView(this.ctx),
      inventory: new InventoryView(this.ctx, this.el),
      settings: new SettingsView(this.ctx),
      death: new DeathView(this.ctx),
    };
    this.el.prepend(this.hud.el);
    for (const v of Object.values(this.screens)) this.el.insertBefore(v.el, this.el.querySelector('.bl-tooltip'));
    this.el.insertBefore(this.toasts.el, this.el.querySelector('.bl-tooltip'));
    this.el.addEventListener('contextmenu', this.onContextMenu);
    root.appendChild(this.el);
  }

  update(s: UiState): void {
    if (this.disposed || s === this.last) return;
    this.last = s;

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
    for (const v of Object.values(this.screens)) v.dispose();
    this.toasts.dispose();
    this.el.remove();
    releaseStyle(this.doc);
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
