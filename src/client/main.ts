/**
 * Browser entry (index.html loads this as the single module script).
 *
 * The page may be served normally or injected into a host's own document skeleton (the
 * single-file artifact build), so this finds — or creates — its canvas and UI root instead of
 * relying on anything in <html>/<head>/<body>.
 */
import { Game } from './game';

declare global {
  interface Window {
    /** Debug / scripting handle (the e2e smoke test drives the game through it). */
    __blocklands?: { game: Game };
  }
}

function element<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const found = document.getElementById(id);
  if (found && found.tagName.toLowerCase() === tag) return found as HTMLElementTagNameMap[K];
  const el = document.createElement(tag);
  el.id = id;
  document.body.appendChild(el);
  return el;
}

function boot(): void {
  const canvas = element('bl-canvas', 'canvas');
  const uiRoot = element('bl-ui', 'div');
  const game = new Game({ win: window, canvas, uiRoot });
  window.__blocklands = { game };
  game.start();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
