/**
 * The UI stylesheet, injected once as a <style> element by createUi. Kept as a plain string
 * (no DOM) so Node tests can check it: every var(--x) is a token declared on the root, and no
 * colour literal appears outside the token block.
 *
 * Visual identity: a shipwright's drafting table. Deep ink-navy translucent panels, warm
 * canvas-coloured text, brass accents and thin technical linework (registration marks,
 * dimension lines), slots like stamped brass plates, a faint blueprint grid behind menus.
 * Every colour is a custom property on .bl-ui; there is exactly one (dark) theme.
 */

/**
 * The same keyframes under two names. Retrigger (dom.ts) replays a one-shot animation by
 * swapping between the `-a` and `-b` classes, which needs two distinct animation names.
 */
function twin(name: string, body: string): string {
  return `@keyframes ${name}-a { ${body} }\n@keyframes ${name}-b { ${body} }`;
}

const NAME_FLASH = '0% { opacity: 0; transform: translateY(5px); } 8% { opacity: 1; transform: translateY(0); } 72% { opacity: 1; } 100% { opacity: 0; }';
const NAME_STILL = '0%, 80% { opacity: 1; } 100% { opacity: 0; }';
const HIT = '0% { box-shadow: 0 0 0 2px var(--vital-400), 0 0 18px var(--vital-600); } 100% { box-shadow: 0 0 0 0 transparent; }';

export const UI_CSS = String.raw`
.bl-ui {
  --ink-950: #050b16;
  --ink-900: #08121f;
  --ink-850: #0c182a;
  --ink-800: #102036;
  --ink-700: #172b47;
  --ink-600: #213a5e;
  --panel-bg: rgba(10, 20, 37, 0.9);
  --panel-bg-soft: rgba(10, 20, 37, 0.74);
  --panel-edge: rgba(214, 170, 88, 0.34);
  --scrim: rgba(3, 8, 16, 0.6);
  --canvas-50: #fdf7ea;
  --canvas-100: #f2e7cf;
  --canvas-300: #d9caa9;
  --canvas-500: #a6987a;
  --canvas-700: #6e6450;
  --brass-100: #fff1c9;
  --brass-200: #f6dea1;
  --brass-300: #ebc77a;
  --brass-400: #d5a957;
  --brass-500: #b4893b;
  --brass-600: #8c6829;
  --brass-700: #5b431a;
  --brass-ink: #1d1508;
  --line: rgba(214, 170, 88, 0.36);
  --line-strong: rgba(235, 199, 122, 0.72);
  --line-faint: rgba(214, 170, 88, 0.15);
  --grid-minor: rgba(118, 168, 224, 0.065);
  --grid-major: rgba(118, 168, 224, 0.12);
  --blueprint-hi: #173559;
  --blueprint-mid: #0d1d33;
  --blueprint-lo: #060e1b;
  --draft-line: #9cc8f0;
  --vital-200: #ffc2ac;
  --vital-400: #f47a5c;
  --vital-600: #c43f2c;
  --vital-trail: rgba(255, 214, 190, 0.55);
  --vital-empty: rgba(255, 255, 255, 0.07);
  --vital-rim: rgba(255, 190, 160, 0.12);
  --breath-300: #a3f1e6;
  --breath-500: #3dbfae;
  --breath-low: #f08a6a;
  --breath-track: rgba(163, 241, 230, 0.16);
  --port: #f0725f;
  --starboard: #62d394;
  --ahead: #5fc8b8;
  --ahead-08: rgba(95, 200, 184, 0.08);
  --ahead-35: rgba(95, 200, 184, 0.35);
  --astern: #e9876c;
  --astern-08: rgba(233, 135, 108, 0.08);
  --astern-35: rgba(233, 135, 108, 0.35);
  --info: #ebc77a;
  --warn: #f2b34e;
  --error: #f06a5a;
  --danger: #e9705f;
  --danger-bg: rgba(233, 112, 95, 0.12);
  --danger-edge: rgba(233, 112, 95, 0.45);
  --danger-edge-strong: rgba(233, 112, 95, 0.55);
  --danger-ink: #fff6f2;
  --danger-hi: #ef8473;
  --danger-lo: #c4483a;
  --danger-hi-hover: #f39383;
  --danger-lo-hover: #cc5143;
  --danger-row: rgba(80, 26, 22, 0.45);
  --danger-row-hover: rgba(80, 26, 22, 0.5);
  --death-in: rgba(70, 14, 10, 0.35);
  --death-out: rgba(30, 4, 4, 0.82);
  --death-glow: rgba(196, 63, 44, 0.55);
  --focus: #8fd8ff;
  --rim-hi: #e3c47f;
  --rim-mid: #a67e36;
  --rim-lo: #4d3815;
  --rim-empty-hi: rgba(227, 196, 127, 0.55);
  --rim-empty-mid: rgba(166, 126, 54, 0.42);
  --rim-empty-lo: rgba(77, 56, 21, 0.5);
  --rim-sel-hi: #fff3cf;
  --rim-sel-mid: #e7bd62;
  --rim-sel-lo: #8f6524;
  --well-hi: #1f3a5e;
  --well-mid: #0f1e35;
  --well-lo: #091427;
  --well-hover: #29497a;
  --hotbar-hi: rgba(16, 32, 56, 0.72);
  --hotbar-lo: rgba(7, 15, 28, 0.86);
  --btn-bg: rgba(18, 34, 58, 0.75);
  --btn-bg-hover: rgba(33, 58, 94, 0.85);
  --item-hover: rgba(33, 58, 94, 0.7);
  --row-bg: rgba(16, 32, 54, 0.62);
  --row-bg-hover: rgba(24, 44, 72, 0.7);
  --helm-glow: rgba(33, 58, 94, 0.55);
  --debug-edge: rgba(118, 168, 224, 0.18);
  --debug-text: #d7e6f5;
  --ink-a20: rgba(5, 11, 22, 0.2);
  --ink-a45: rgba(5, 11, 22, 0.45);
  --ink-a55: rgba(5, 11, 22, 0.55);
  --ink-a60: rgba(5, 11, 22, 0.6);
  --ink-a62: rgba(5, 11, 22, 0.62);
  --ink-a66: rgba(5, 11, 22, 0.66);
  --ink-a70: rgba(5, 11, 22, 0.7);
  --ink-a75: rgba(5, 11, 22, 0.75);
  --ink-a95: rgba(5, 11, 22, 0.95);
  --glint-06: rgba(255, 238, 204, 0.06);
  --glint-08: rgba(255, 236, 190, 0.08);
  --glint-12: rgba(255, 226, 170, 0.12);
  --glint-45: rgba(255, 245, 215, 0.45);
  --glint-55: rgba(255, 250, 230, 0.55);
  --glint-60: rgba(255, 250, 230, 0.6);
  --hover-wash: rgba(255, 255, 255, 0.05);
  --brass-glow-25: rgba(235, 199, 122, 0.25);
  --brass-glow-60: rgba(235, 199, 122, 0.6);
  --brass-glow-80: rgba(235, 199, 122, 0.8);
  --brass-wash-18: rgba(213, 169, 87, 0.18);
  --brass-wash-30: rgba(213, 169, 87, 0.3);
  --brass-shade: rgba(90, 60, 15, 0.35);
  --brass-groove: rgba(29, 21, 8, 0.45);
  --shade-25: rgba(0, 0, 0, 0.25);
  --shade-30: rgba(0, 0, 0, 0.3);
  --shade-35: rgba(0, 0, 0, 0.35);
  --shade-40: rgba(0, 0, 0, 0.4);
  --shade-45: rgba(0, 0, 0, 0.45);
  --shade-50: rgba(0, 0, 0, 0.5);
  --shade-55: rgba(0, 0, 0, 0.55);
  --shade-60: rgba(0, 0, 0, 0.6);
  --shade-70: rgba(0, 0, 0, 0.7);
  --shade-90: rgba(0, 0, 0, 0.9);
  --shade-95: rgba(0, 0, 0, 0.95);
  --shade-full: #000;
  --logo-top-hi: #fff1c9;
  --logo-top-lo: #e2bb6b;
  --logo-left-hi: #c99a45;
  --logo-left-lo: #8c6829;
  --logo-right-hi: #3a5d8c;
  --logo-right-lo: #172b47;
  /* Only the alpha channel of a mask matters. */
  --mask-opaque: #000;
  --shadow-md: 0 6px 18px rgba(0, 0, 0, 0.38);
  --shadow-lg: 0 26px 70px rgba(0, 0, 0, 0.55);
  --text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Zen Hei", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", monospace;
  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Noto Serif SC", "Songti SC", "STSong", serif;
  --slot: clamp(30px, min(calc((100vw - 56px) / 13.4), calc(4.4vh + 22px)), calc(92px * var(--ui-zoom)));
  --gap: clamp(3px, calc(var(--slot) * 0.09), 8px);
  --islot: clamp(31px, min(calc((100vw - 84px) / 9), calc(4.2vh + 18px)), 54px);
  --igap: clamp(3px, calc(var(--islot) * 0.1), 6px);
  --safe-b: env(safe-area-inset-bottom, 0px);
  /* Extra scale for very large CSS viewports (a 4K screen at 100 %); see the media queries. */
  --ui-zoom: 1;
  /* Helm instrument: preferred scale and edge margin per viewport. views/layout.ts reads both
     and places the instrument where it collides with nothing. */
  --helm-base: 1;
  --helm-margin: 14px;

  position: fixed;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  color: var(--canvas-100);
  font-family: var(--font-ui);
  font-size: 15px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  -webkit-user-select: none;
  text-rendering: optimizeLegibility;
}
.bl-ui *, .bl-ui *::before, .bl-ui *::after { box-sizing: border-box; }
.bl-ui [hidden] { display: none !important; }
/* Element resets use :where() so they never outrank a component class. */
:where(.bl-ui) button { font: inherit; color: inherit; }
.bl-ui :focus { outline: none; }
.bl-ui :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
/* Dialog containers take focus programmatically (so Tab starts inside them): no ring. */
.bl-ui [tabindex="-1"]:focus, .bl-ui [tabindex="-1"]:focus-visible { outline: none; }
:where(.bl-ui) :where(h1, h2, h3, h4, p, ul, dl, dd) { margin: 0; padding: 0; }
:where(.bl-ui) ul { list-style: none; }
:where(.bl-ui) kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.9em; height: 1.75em; padding: 0 0.5em;
  font: 600 0.78em/1 var(--font-mono); color: var(--canvas-50);
  background: linear-gradient(180deg, var(--ink-600), var(--ink-800));
  border: 1px solid var(--line); border-bottom-color: var(--brass-600);
  border-radius: 5px; box-shadow: 0 1px 0 var(--shade-50); white-space: nowrap;
}
.bl-ui .bl-kbd-mouse { min-width: 1.75em; padding: 0 0.3em; }
.bl-kbd-mouse svg { width: 1.12em; height: 1.45em; overflow: visible; }
.bl-m-body { fill: none; stroke: var(--canvas-100); stroke-width: 1.2; stroke-linecap: round; }
.bl-m-btn { fill: transparent; }
.bl-m-btn.is-on, .bl-m-wheel { fill: var(--brass-200); }
.bl-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* Reports the safe-area insets to the layout pass through its computed paddings. */
.bl-safe-probe {
  position: absolute; left: 0; top: 0; width: 0; height: 0; visibility: hidden; pointer-events: none;
  padding: env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px);
}

/* ------------------------------------------------------------------ HUD */
.bl-hud { position: absolute; inset: 0; }
/* The debug text changes every frame; keep its relayout to itself. (No paint containment
   on HUD widgets: it would clip their drop shadows.) */
.bl-debug { contain: layout style; }
.bl-ui[data-ingame="0"] .bl-hud { display: none; }
.bl-hud[data-play="0"] .bl-play { display: none; }

.bl-crosshair {
  position: absolute; left: 50%; top: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px;
  overflow: visible; filter: drop-shadow(0 0 1.5px var(--shade-90));
}
.bl-crosshair .bl-cross-tick { stroke: var(--canvas-50); stroke-width: 1.6; stroke-linecap: round; }
.bl-crosshair .bl-cross-dot { fill: var(--brass-200); }

.bl-hint {
  position: absolute; left: 50%; top: calc(50% + 30px); transform: translate(-50%, 4px);
  /* max-content: an abs-positioned box at left:50% would otherwise shrink to half the viewport. */
  width: max-content; max-width: min(560px, calc(100vw - 32px));
  padding: 6px 14px 6px 12px; border-radius: 999px;
  background: var(--panel-bg-soft); border: 1px solid var(--line-faint);
  border-left: 2px solid var(--brass-400);
  font-size: 14px; color: var(--canvas-50); text-align: center; text-shadow: var(--text-shadow);
  opacity: 0; transition: opacity 0.18s ease, transform 0.18s ease; white-space: normal;
}
.bl-hint[data-show="1"] { opacity: 1; transform: translate(-50%, 0); }

.bl-bottom {
  position: absolute; left: 50%; bottom: calc(10px + var(--safe-b)); transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: stretch; gap: 6px;
}
.bl-itemname {
  align-self: center; height: 1.6em; display: flex; align-items: flex-end;
  font-size: clamp(13px, calc(var(--slot) * 0.3), 20px); font-weight: 600; letter-spacing: 0.02em;
  color: var(--canvas-50); text-shadow: 0 1px 3px var(--shade-90), 0 0 12px var(--shade-50);
  opacity: 0; white-space: nowrap;
}
.bl-itemname.is-flash-a, .bl-itemname.is-flash-b { animation-duration: 2.6s; animation-timing-function: ease-out; animation-fill-mode: both; }
.bl-itemname.is-flash-a { animation-name: bl-name-flash-a; }
.bl-itemname.is-flash-b { animation-name: bl-name-flash-b; }
${twin('bl-name-flash', NAME_FLASH)}
${twin('bl-name-still', NAME_STILL)}

.bl-gauges { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; min-height: 0; padding: 0 2px; }
.bl-gauges:empty { display: none; }
.bl-vital {
  display: flex; align-items: center; gap: 7px; width: min(58%, 300px);
  padding: 4px 9px 4px 7px; border-radius: 8px;
  background: var(--panel-bg-soft); border: 1px solid var(--line-faint);
}
.bl-vital-glyph { width: 18px; height: 14px; flex: none; overflow: visible; }
.bl-vital-glyph path { fill: none; stroke: var(--vital-400); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.bl-vital-segs { flex: 1; display: flex; gap: 3px; height: clamp(8px, calc(var(--slot) * 0.2), 14px); padding: 0 3px; }
.bl-seg {
  position: relative; flex: 1; border-radius: 2px; overflow: hidden; transform: skewX(-20deg);
  background: var(--vital-empty); box-shadow: inset 0 0 0 1px var(--vital-rim);
}
.bl-seg b { position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(0); }
.bl-seg-trail { background: var(--vital-trail); transition: transform 0.5s ease 0.35s; }
.bl-seg-fill {
  background: linear-gradient(180deg, var(--vital-200) 0%, var(--vital-400) 45%, var(--vital-600) 100%);
  transition: transform 0.16s ease;
}
.bl-vital-num { font: 600 12px/1 var(--font-mono); color: var(--canvas-300); min-width: 3.6em; text-align: right; font-variant-numeric: tabular-nums; }
.bl-vital[data-low="1"] .bl-seg-fill { animation: bl-pulse 0.9s ease-in-out infinite; }
.bl-vital.is-hit-a { animation: bl-hit-a 0.35s ease-out; }
.bl-vital.is-hit-b { animation: bl-hit-b 0.35s ease-out; }
@keyframes bl-pulse { 50% { filter: brightness(1.55); } }
${twin('bl-hit', HIT)}

.bl-breath {
  position: relative; width: clamp(34px, calc(var(--slot) * 0.8), 52px); height: clamp(34px, calc(var(--slot) * 0.8), 52px);
  opacity: 0; transform: scale(0.85); transition: opacity 0.25s ease, transform 0.25s ease;
}
.bl-breath[data-show="1"] { opacity: 1; transform: none; }
.bl-breath svg { width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 1px 2px var(--shade-70)); }
.bl-breath-disc { fill: var(--panel-bg-soft); stroke: var(--line-faint); }
.bl-breath-track { fill: none; stroke: var(--breath-track); stroke-width: 3.2; stroke-linecap: round; }
.bl-breath-fill { fill: none; stroke: var(--breath-500); stroke-width: 3.2; stroke-linecap: round; transition: stroke-dasharray 0.2s linear; }
.bl-breath-glyph { fill: none; stroke: var(--breath-300); stroke-width: 1.6; stroke-linecap: round; }
.bl-breath[data-low="1"] .bl-breath-fill { stroke: var(--breath-low); animation: bl-pulse 0.7s ease-in-out infinite; }

.bl-hotbar {
  display: flex; gap: var(--gap); padding: calc(var(--gap) * 1.4);
  border-radius: calc(var(--slot) * 0.28 + var(--gap));
  background: linear-gradient(180deg, var(--hotbar-hi), var(--hotbar-lo));
  border: 1px solid var(--line); box-shadow: var(--shadow-md), inset 0 1px 0 var(--glint-08);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
}
.bl-hud[data-drag="1"] .bl-hotbar .bl-slot { pointer-events: auto; }

/* The off-hand socket: hangs left of the hotbar (the hotbar stays centred), a round well in a
   darker steel collar, the swap key engraved on a tab above it. */
.bl-hands { position: relative; }
.bl-offhand {
  position: absolute; right: calc(100% + var(--gap) * 2.5); bottom: 0;
  padding: calc(var(--gap) * 1.4); border-radius: 50%;
  background: radial-gradient(120% 120% at 30% 20%, var(--hotbar-hi), var(--hotbar-lo));
  border: 1px dashed var(--brass-400); box-shadow: var(--shadow-md), inset 0 1px 0 var(--glint-08);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
}
.bl-offhand .bl-slot { --s: calc(var(--slot) * 0.9); border-radius: 50%; cursor: default; }
.bl-offhand .bl-slot-well { border-radius: 50%; }
.bl-offhand-key {
  position: absolute; left: 50%; top: 0; transform: translate(-50%, -55%);
  min-width: 1.6em; padding: 2px 5px; border-radius: 4px; text-align: center;
  font: 700 clamp(9px, calc(var(--slot) * 0.2), calc(14px * var(--ui-zoom)))/1 var(--font-mono);
  color: var(--brass-100); background: var(--panel-bg-soft); border: 1px solid var(--brass-400);
  box-shadow: 0 1px 2px var(--shade-55);
}

/* ------------------------------------------------------------------ slots (stamped brass plates) */
.bl-slot {
  --s: var(--slot);
  position: relative; flex: none; width: var(--s); height: var(--s);
  padding: 0; margin: 0; border: 0; border-radius: calc(var(--s) * 0.22);
  background: linear-gradient(150deg, var(--rim-hi) 0%, var(--rim-mid) 42%, var(--rim-lo) 100%);
  box-shadow: 0 1px 0 var(--shade-55), 0 2px 5px var(--shade-30);
  cursor: pointer; transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.bl-slot-well {
  position: absolute; inset: max(2px, calc(var(--s) * 0.055)); border-radius: calc(var(--s) * 0.17);
  background: radial-gradient(130% 130% at 28% 18%, var(--well-hi) 0%, var(--well-mid) 55%, var(--well-lo) 100%);
  box-shadow: inset 0 2px 6px var(--shade-70), inset 0 -1px 0 var(--glint-12);
  display: flex; align-items: center; justify-content: center;
}
.bl-slot canvas, .bl-cursor canvas, .bl-pitem canvas {
  display: block; width: 72%; height: 72%;
  filter: drop-shadow(0 2px 2px var(--shade-50));
}
.bl-slot[data-empty="1"] canvas { visibility: hidden; }
.bl-slot[data-empty="1"]:not(.is-selected) {
  background: linear-gradient(150deg, var(--rim-empty-hi) 0%, var(--rim-empty-mid) 42%, var(--rim-empty-lo) 100%);
}
.bl-slot-num {
  position: absolute; top: max(2px, calc(var(--s) * 0.07)); left: max(4px, calc(var(--s) * 0.12));
  font: 600 clamp(8px, calc(var(--s) * 0.19), calc(14px * var(--ui-zoom)))/1 var(--font-mono); color: var(--brass-300); opacity: 0.62;
}
.bl-slot-count {
  position: absolute; right: max(4px, calc(var(--s) * 0.1)); bottom: max(3px, calc(var(--s) * 0.07));
  font: 700 clamp(10px, calc(var(--s) * 0.27), calc(20px * var(--ui-zoom)))/1 var(--font-mono); color: var(--canvas-50);
  text-shadow: 0 1px 0 var(--shade-full), 0 0 3px var(--shade-95); font-variant-numeric: tabular-nums;
}
.bl-slot.is-selected {
  background: linear-gradient(150deg, var(--rim-sel-hi) 0%, var(--rim-sel-mid) 45%, var(--rim-sel-lo) 100%);
  box-shadow: 0 0 0 1px var(--brass-100), 0 0 14px var(--brass-glow-60), 0 3px 8px var(--shade-45);
  transform: translateY(calc(var(--s) * -0.07));
}
.bl-slot.is-selected .bl-slot-num { opacity: 1; color: var(--brass-100); }
.bl-slot.is-selected::after {
  content: ""; position: absolute; left: 50%; bottom: calc(var(--s) * -0.16); width: 6px; height: 6px; margin-left: -3px;
  background: var(--brass-200); transform: rotate(45deg); border-radius: 1px; box-shadow: 0 0 6px var(--brass-glow-80);
}
.bl-inv .bl-slot { --s: var(--islot); }
.bl-inv .bl-slot:hover { box-shadow: 0 0 0 1px var(--brass-200), 0 2px 8px var(--shade-45); }
.bl-inv .bl-slot:hover .bl-slot-well { background: radial-gradient(130% 130% at 28% 18%, var(--well-hover) 0%, var(--well-mid) 60%, var(--well-lo) 100%); }
.bl-inv .bl-slot.is-selected { transform: none; }
.bl-inv .bl-slot.is-selected::after { display: none; }

/* ------------------------------------------------------------------ debug overlay */
.bl-debug {
  position: absolute; left: 8px; top: 8px; max-width: calc(100vw - 16px);
  padding: 6px 9px; border-radius: 6px; background: var(--ink-a66); border: 1px solid var(--debug-edge);
  font: 12px/1.45 var(--font-mono); color: var(--debug-text); white-space: pre; overflow: hidden; text-shadow: 0 1px 0 var(--shade-full);
}
.bl-debug-line:first-child { color: var(--brass-200); }

/* ------------------------------------------------------------------ click-to-play veil */
.bl-veil {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, var(--ink-a20) 0%, var(--ink-a62) 100%);
  transition: opacity 0.2s ease;
}
.bl-veil[data-show="0"] { opacity: 0; visibility: hidden; transition: opacity 0.2s ease, visibility 0s 0.2s; }
.bl-veil-card {
  position: relative; display: flex; align-items: center; gap: 16px; padding: 18px 26px 18px 20px; border-radius: 14px;
  background: var(--panel-bg); border: 1px solid var(--line); box-shadow: var(--shadow-lg);
  transform: translateY(calc(-1 * clamp(40px, 12vh, 120px)));
}
.bl-veil-icon { width: 42px; height: 42px; flex: none; }
.bl-veil-icon * { fill: none; stroke: var(--brass-300); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.bl-veil-icon .bl-fill { fill: var(--brass-300); stroke: none; }
.bl-veil-title { font-size: 20px; font-weight: 700; letter-spacing: 0.03em; color: var(--canvas-50); }
.bl-veil-sub { margin-top: 3px; font-size: 13px; color: var(--canvas-500); }
/* Drag-to-look hosts can never lock the pointer, so there the veil is a compact standing
   banner; the layout pass moves it (via the unzoomed veil) below the debug overlay or a
   raised helm. Hidden outright (not faded) so the layout pass sees it go. */
.bl-veil[data-drag="1"] { align-items: flex-start; background: none; translate: var(--banner-dx, 0px) var(--banner-dy, 0px); }
.bl-veil[data-drag="1"][data-show="0"] { display: none; }
.bl-veil[data-drag="1"] .bl-veil-card {
  transform: none; margin-top: max(14px, env(safe-area-inset-top, 0px)); padding: 10px 16px 10px 12px; gap: 12px;
  animation: bl-veil-settle 7s ease forwards;
}
.bl-veil[data-drag="1"] .bl-veil-icon { width: 30px; height: 30px; }
.bl-veil[data-drag="1"] .bl-veil-title { font-size: 15px; }
.bl-veil[data-drag="1"] .bl-veil-sub { font-size: 12px; }
@keyframes bl-veil-settle { 0%, 70% { opacity: 1; } 100% { opacity: 0.42; } }

/* ------------------------------------------------------------------ helm instrument */
/* Natural spot: bottom-right corner at the preferred scale. views/layout.ts overrides right,
   bottom and transform inline with a spot that clears the hotbar cluster, the crosshair / hint
   zone and the debug overlay. Scaled with a transform (not zoom) so those offsets stay plain
   viewport px. */
.bl-helm {
  position: absolute; right: var(--helm-margin); bottom: calc(var(--helm-margin) + var(--safe-b));
  transform: scale(calc(var(--helm-base) * var(--ui-zoom))); transform-origin: 100% 100%;
  width: 300px; padding: 10px 14px 12px; border-radius: 16px;
  background:
    radial-gradient(120% 90% at 50% 0%, var(--helm-glow), transparent 70%),
    var(--panel-bg);
  border: 1px solid var(--line); box-shadow: var(--shadow-lg), inset 0 0 0 3px var(--ink-a60), inset 0 0 0 4px var(--line-faint);
}
.bl-helm-head { display: flex; justify-content: space-between; align-items: baseline; padding: 0 2px 6px; border-bottom: 1px solid var(--line-faint); }
.bl-helm-title { font: 700 11px/1 var(--font-ui); letter-spacing: 0.24em; text-transform: uppercase; color: var(--brass-300); }
.bl-helm-thr { font: 600 12px/1 var(--font-mono); color: var(--canvas-300); }
.bl-helm-body { display: grid; grid-template-columns: 66px 1fr 74px; gap: 8px; align-items: center; padding-top: 8px; }
.bl-lever { position: relative; height: 112px; display: flex; gap: 6px; }
.bl-lever-scale { position: relative; flex: 1; font-size: 10px; color: var(--canvas-500); }
.bl-lever-scale span { position: absolute; right: 0; transform: translateY(-50%); white-space: nowrap; line-height: 1; }
.bl-lever-scale span::after { content: ""; display: inline-block; width: 4px; height: 1px; margin-left: 3px; vertical-align: middle; background: var(--line-strong); }
.bl-lever-scale .is-astern::after { background: var(--astern); }
.bl-lever-scale .is-ahead::after { background: var(--ahead); }
.bl-lever-scale .is-near { color: var(--canvas-50); font-weight: 600; }
.bl-lever-scale .is-astern.is-near { color: var(--astern); }
.bl-lever-track {
  position: relative; width: 12px; border-radius: 6px;
  background: linear-gradient(180deg, var(--ahead-35) 0%, var(--ahead-08) 50%, var(--astern-08) 50%, var(--astern-35) 100%);
  box-shadow: inset 0 0 0 1px var(--line), inset 0 2px 4px var(--shade-60);
}
.bl-lever-track::before { content: ""; position: absolute; left: -3px; right: -3px; top: 50%; height: 1px; background: var(--line-strong); }
.bl-lever-knob {
  position: absolute; left: 50%; top: calc((1 - var(--t, 0.5)) * 100%); width: 26px; height: 12px; margin: -6px 0 0 -13px;
  border-radius: 4px; background: linear-gradient(180deg, var(--brass-100), var(--brass-400) 55%, var(--brass-600));
  box-shadow: 0 2px 4px var(--shade-60), inset 0 -1px 0 var(--shade-25);
  transition: top 0.12s linear;
}
.bl-lever-knob::after { content: ""; position: absolute; left: 4px; right: 4px; top: 5px; height: 2px; border-radius: 1px; background: var(--brass-groove); }
.bl-dial { position: relative; text-align: center; }
.bl-dial svg { display: block; width: 100%; height: auto; overflow: visible; }
.bl-dial-face { fill: var(--ink-a55); stroke: var(--line); stroke-width: 1; }
.bl-dial-port { fill: none; stroke: var(--port); stroke-width: 3; opacity: 0.85; }
.bl-dial-stbd { fill: none; stroke: var(--starboard); stroke-width: 3; opacity: 0.85; }
.bl-dial-tick { stroke: var(--canvas-500); stroke-width: 1; }
.bl-dial-tick.is-major { stroke: var(--canvas-100); stroke-width: 1.4; }
.bl-dial-needle { transition: transform 0.12s linear; }
.bl-dial-needle path { fill: var(--brass-200); stroke: var(--brass-700); stroke-width: 0.6; }
.bl-dial-hub { fill: var(--brass-400); stroke: var(--brass-700); stroke-width: 0.8; }
.bl-dial-labels { display: flex; justify-content: space-between; margin-top: 2px; font-size: 10px; letter-spacing: 0.04em; }
.bl-dial-labels .bl-port { color: var(--port); }
.bl-dial-labels .bl-stbd { color: var(--starboard); }
.bl-dial-cap { font-size: 10px; color: var(--canvas-500); letter-spacing: 0.08em; margin-top: 1px; }
.bl-helm-read { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.bl-helm-label { font-size: 10px; letter-spacing: 0.08em; color: var(--canvas-500); }
.bl-helm-speed { font: 600 30px/1 var(--font-mono); color: var(--canvas-50); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; text-shadow: 0 0 14px var(--brass-glow-25); }
.bl-helm-unit { font-size: 10px; color: var(--brass-300); }
.bl-helm-sails {
  display: flex; align-items: center; gap: 4px; margin-top: 8px; padding: 3px 7px; border-radius: 6px;
  border: 1px solid var(--line-faint); font-size: 11px; color: var(--canvas-300);
}
.bl-helm-sails svg { width: 13px; height: 13px; }
.bl-helm-sails svg path { fill: var(--canvas-300); }
.bl-helm-sails b { font: 700 13px/1 var(--font-mono); color: var(--canvas-50); }

/* ------------------------------------------------------------------ toasts */
/* The column itself is never zoomed (each toast is), so the layout pass can shift it in
   plain viewport px. */
.bl-toasts {
  --toast-dx: 16px;
  position: absolute; top: max(12px, env(safe-area-inset-top, 0px)); right: 12px; z-index: 3;
  display: flex; flex-direction: column; align-items: flex-end; gap: calc(8px * var(--ui-zoom));
  width: min(calc(380px * var(--ui-zoom)), calc(100vw - 24px));
}
/* In play: top right, moved down past the debug overlay, drag banner or a raised helm. */
.bl-ui[data-screen="none"] .bl-toasts { translate: 0 var(--toasts-dy, 0px); }
/* Over any screen: top left, keeping the panels' top-right corner (close buttons, the menu's
   settings button) clear. */
.bl-ui:not([data-screen="none"]) .bl-toasts {
  --toast-dx: -16px;
  left: 12px; right: auto; align-items: flex-start; width: min(calc(380px * var(--ui-zoom)), calc(100vw - 84px));
}
.bl-toast {
  --k: var(--info);
  display: flex; align-items: flex-start; gap: 10px; max-width: 100%;
  padding: 9px 14px 9px 10px; border-radius: 10px;
  background: var(--panel-bg); border: 1px solid var(--line-faint); border-left: 3px solid var(--k);
  box-shadow: var(--shadow-md); font-size: 14px; color: var(--canvas-50);
  animation: bl-toast-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.bl-toast--warn { --k: var(--warn); }
.bl-toast--error { --k: var(--error); }
.bl-toast.is-leaving { animation: bl-toast-out 0.2s ease-in both; }
.bl-toast-glyph {
  flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; border: 1.5px solid var(--k);
  color: var(--k); display: flex; align-items: center; justify-content: center; font: 700 11px/1 var(--font-mono);
}
.bl-toast-text { overflow-wrap: anywhere; }
@keyframes bl-toast-in { from { opacity: 0; transform: translateX(var(--toast-dx)); } to { opacity: 1; transform: none; } }
@keyframes bl-toast-out { to { opacity: 0; transform: translateX(calc(var(--toast-dx) * 0.6)); } }

/* ------------------------------------------------------------------ screens, panels, controls */
.bl-screen {
  position: absolute; inset: 0; z-index: 2; pointer-events: auto; overflow: auto; overscroll-behavior: contain;
  display: flex; padding: max(16px, env(safe-area-inset-top, 0px)) 16px max(16px, env(safe-area-inset-bottom, 0px));
  animation: bl-screen-in 0.2s ease-out both;
}
.bl-screen--overlay { background: var(--scrim); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
.bl-screen--opaque, .bl-ui[data-ingame="0"] .bl-settings {
  background:
    linear-gradient(var(--grid-minor) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(90deg, var(--grid-minor) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(var(--grid-major) 1px, transparent 1px) 0 0 / 120px 120px,
    linear-gradient(90deg, var(--grid-major) 1px, transparent 1px) 0 0 / 120px 120px,
    radial-gradient(ellipse 90% 80% at 28% 18%, var(--blueprint-hi) 0%, var(--blueprint-mid) 55%, var(--blueprint-lo) 100%);
  background-color: var(--blueprint-lo);
  -webkit-backdrop-filter: none; backdrop-filter: none;
}
@keyframes bl-screen-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes bl-panel-in { from { opacity: 0; transform: translateY(10px) scale(0.985); } to { opacity: 1; transform: none; } }

.bl-panel {
  position: relative; border-radius: 16px; padding: 20px 22px;
  background:
    linear-gradient(var(--grid-minor) 1px, transparent 1px) 0 0 / 20px 20px,
    linear-gradient(90deg, var(--grid-minor) 1px, transparent 1px) 0 0 / 20px 20px,
    var(--panel-bg);
  border: 1px solid var(--panel-edge);
  box-shadow: var(--shadow-lg), inset 0 1px 0 var(--glint-06);
}
.bl-panel::before {
  /* drafting registration marks in the four corners */
  content: ""; position: absolute; inset: 7px; pointer-events: none; opacity: 0.75;
  background:
    linear-gradient(var(--brass-400), var(--brass-400)) left top / 12px 1px no-repeat,
    linear-gradient(var(--brass-400), var(--brass-400)) left top / 1px 12px no-repeat,
    linear-gradient(var(--brass-400), var(--brass-400)) right top / 12px 1px no-repeat,
    linear-gradient(var(--brass-400), var(--brass-400)) right top / 1px 12px no-repeat,
    linear-gradient(var(--brass-400), var(--brass-400)) left bottom / 12px 1px no-repeat,
    linear-gradient(var(--brass-400), var(--brass-400)) left bottom / 1px 12px no-repeat,
    linear-gradient(var(--brass-400), var(--brass-400)) right bottom / 12px 1px no-repeat,
    linear-gradient(var(--brass-400), var(--brass-400)) right bottom / 1px 12px no-repeat;
}
.bl-panel-modal { margin: auto; animation: bl-panel-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.bl-panel-title {
  display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
  font: 700 13px/1.2 var(--font-ui); letter-spacing: 0.2em; text-transform: uppercase; color: var(--brass-300);
}
.bl-panel-title::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--line), transparent); }
.bl-panel-title .bl-count { order: 2; font: 500 12px/1 var(--font-mono); letter-spacing: 0; text-transform: none; color: var(--canvas-500); }
.bl-title-lg { font: 600 28px/1.15 var(--font-display); letter-spacing: 0.04em; text-transform: none; color: var(--canvas-50); }
.bl-title-lg::after { margin-left: 4px; }
.bl-subtitle {
  margin: 0 0 8px; font: 600 11px/1.2 var(--font-ui); letter-spacing: 0.16em; text-transform: uppercase; color: var(--canvas-500);
}

.bl-btn {
  position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 40px; padding: 8px 18px; border-radius: 9px; cursor: pointer;
  font-size: 15px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; text-decoration: none;
  border: 1px solid var(--line); background: var(--btn-bg); color: var(--canvas-100);
  transition: background-color 0.12s ease, border-color 0.12s ease, transform 0.08s ease, filter 0.12s ease, opacity 0.12s ease;
}
.bl-btn:hover { background: var(--btn-bg-hover); border-color: var(--line-strong); }
.bl-btn:active { transform: translateY(1px); }
.bl-btn--primary {
  color: var(--brass-ink); border-color: var(--brass-200);
  background: linear-gradient(180deg, var(--brass-200) 0%, var(--brass-400) 55%, var(--brass-500) 100%);
  box-shadow: inset 0 1px 0 var(--glint-60), inset 0 -2px 0 var(--brass-shade), 0 2px 8px var(--shade-35);
  text-shadow: 0 1px 0 var(--glint-45);
}
.bl-btn--primary:hover { background: linear-gradient(180deg, var(--brass-100) 0%, var(--brass-300) 55%, var(--brass-500) 100%); border-color: var(--brass-100); }
.bl-btn--ghost { background: transparent; }
.bl-btn--danger { color: var(--danger); border-color: var(--danger-edge); background: transparent; }
.bl-btn--danger:hover { background: var(--danger-bg); border-color: var(--danger); }
.bl-btn--solid-danger { color: var(--danger-ink); border-color: var(--danger); background: linear-gradient(180deg, var(--danger-hi), var(--danger-lo)); }
.bl-btn--solid-danger:hover { filter: brightness(1.08); background: linear-gradient(180deg, var(--danger-hi-hover), var(--danger-lo-hover)); }
.bl-btn--icon { min-width: 40px; padding: 8px; }
.bl-btn--wide { width: 100%; }
.bl-btn svg { width: 18px; height: 18px; flex: none; }
.bl-btn svg * { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }

.bl-seg-ctl {
  display: inline-flex; padding: 3px; gap: 3px; border-radius: 10px;
  background: var(--ink-a55); border: 1px solid var(--line-faint);
}
.bl-seg-ctl button {
  min-height: 34px; min-width: 76px; padding: 6px 14px; border: 0; border-radius: 7px; cursor: pointer;
  background: transparent; color: var(--canvas-300); font-size: 14px; font-weight: 600;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.bl-seg-ctl button:hover { color: var(--canvas-50); background: var(--hover-wash); }
.bl-seg-ctl button[aria-checked="true"] {
  color: var(--brass-ink); background: linear-gradient(180deg, var(--brass-200), var(--brass-400));
  box-shadow: inset 0 1px 0 var(--glint-55), 0 1px 3px var(--shade-40);
}

.bl-switch {
  position: relative; display: inline-flex; align-items: center; gap: 10px; min-height: 34px; padding: 0; border: 0;
  background: none; cursor: pointer; color: var(--canvas-300); font-size: 13px;
}
.bl-switch-track {
  position: relative; width: 44px; height: 24px; border-radius: 12px; flex: none;
  background: var(--ink-a70); border: 1px solid var(--line); transition: background-color 0.15s ease, border-color 0.15s ease;
}
.bl-switch-track::after {
  content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 5px;
  background: var(--canvas-500); transition: transform 0.15s ease, background-color 0.15s ease;
}
.bl-switch[aria-checked="true"] .bl-switch-track { background: var(--brass-wash-30); border-color: var(--brass-300); }
.bl-switch[aria-checked="true"] .bl-switch-track::after { transform: translateX(20px); background: var(--brass-200); }
.bl-switch-text { min-width: 2em; text-align: left; }

.bl-input {
  width: 100%; min-height: 40px; padding: 8px 12px; border-radius: 9px;
  background: var(--ink-a60); border: 1px solid var(--line); color: var(--canvas-50);
  font: 500 15px/1.3 var(--font-ui); user-select: text; -webkit-user-select: text;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.bl-input::placeholder { color: var(--canvas-700); }
.bl-input:focus { border-color: var(--brass-300); box-shadow: 0 0 0 3px var(--brass-wash-18); outline: none; }
.bl-input.bl-num-input { font-family: var(--font-mono); }
.bl-input.bl-num-input::placeholder { font-family: var(--font-ui); }

.bl-range { -webkit-appearance: none; appearance: none; width: 100%; height: 28px; margin: 0; background: transparent; cursor: pointer; }
.bl-range::-webkit-slider-runnable-track {
  height: 6px; border-radius: 3px;
  background:
    linear-gradient(90deg, var(--brass-400) 0 var(--p, 50%), transparent var(--p, 50%)),
    repeating-linear-gradient(90deg, var(--line) 0 1px, transparent 1px 10%),
    var(--ink-a75);
  box-shadow: inset 0 0 0 1px var(--line-faint);
}
.bl-range::-moz-range-track { height: 6px; border-radius: 3px; background: var(--ink-a75); box-shadow: inset 0 0 0 1px var(--line-faint); }
.bl-range::-moz-range-progress { height: 6px; border-radius: 3px; background: var(--brass-400); }
.bl-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 14px; height: 22px; margin-top: -8px; border-radius: 4px;
  background: linear-gradient(180deg, var(--brass-100), var(--brass-400) 60%, var(--brass-600));
  border: 1px solid var(--brass-700); box-shadow: 0 2px 4px var(--shade-50);
}
.bl-range::-moz-range-thumb {
  width: 14px; height: 22px; border-radius: 4px;
  background: linear-gradient(180deg, var(--brass-100), var(--brass-400) 60%, var(--brass-600));
  border: 1px solid var(--brass-700); box-shadow: 0 2px 4px var(--shade-50);
}
.bl-range:focus-visible { outline: none; }
.bl-range:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--focus); outline-offset: 2px; }
.bl-range:focus-visible::-moz-range-thumb { outline: 2px solid var(--focus); outline-offset: 2px; }

.bl-keys { display: grid; grid-template-columns: auto 1fr; column-gap: 12px; row-gap: 7px; align-items: center; }
.bl-key-row { display: contents; }
.bl-key-row dt { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; justify-self: start; }
.bl-key-row dd { font-size: 13px; color: var(--canvas-300); }
.bl-key-sep { font: 600 11px/1 var(--font-mono); color: var(--brass-400); padding: 0 1px; }
.bl-key-word { font-size: 12px; color: var(--canvas-500); }

/* ------------------------------------------------------------------ logotype */
.bl-logo { display: flex; align-items: center; gap: clamp(12px, 2vw, 20px); }
.bl-logo-mark { width: clamp(56px, 8vw, 84px); height: auto; flex: none; overflow: visible; filter: drop-shadow(0 6px 14px var(--shade-45)); }
.bl-lg-top-hi { stop-color: var(--logo-top-hi); }
.bl-lg-top-lo { stop-color: var(--logo-top-lo); }
.bl-lg-left-hi { stop-color: var(--logo-left-hi); }
.bl-lg-left-lo { stop-color: var(--logo-left-lo); }
.bl-lg-right-hi { stop-color: var(--logo-right-hi); }
.bl-lg-right-lo { stop-color: var(--logo-right-lo); }
.bl-lg-construct { fill: none; stroke: var(--draft-line); }
.bl-lg-edge { fill: none; stroke: var(--brass-100); }
.bl-lg-shade { fill: none; stroke: var(--brass-700); }
.bl-lg-sail { fill: var(--canvas-100); stroke: var(--brass-400); }
.bl-lg-hub { fill: var(--brass-300); stroke: var(--brass-700); }
.bl-logo-text { display: flex; flex-direction: column; align-items: stretch; }
.bl-logo-word {
  font: 700 clamp(30px, 5.6vw, 58px)/1 var(--font-display); letter-spacing: 0.16em; margin-right: -0.16em; text-transform: uppercase;
  background: linear-gradient(180deg, var(--brass-100) 0%, var(--brass-300) 46%, var(--brass-500) 54%, var(--brass-300) 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 2px 0 var(--shade-45));
}
.bl-logo-dim { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.bl-logo-dim i { position: relative; flex: 1; height: 1px; background: var(--line-strong); }
.bl-logo-dim i::before { content: ""; position: absolute; top: -4px; width: 1px; height: 9px; background: var(--line-strong); }
.bl-logo-dim i:first-child::before { left: 0; }
.bl-logo-dim i:last-child::before { right: 0; }
.bl-logo-dim i::after { content: ""; position: absolute; top: -3px; width: 6px; height: 6px; border: solid var(--line-strong); border-width: 0 0 1px 1px; }
.bl-logo-dim i:first-child::after { left: 1px; transform: rotate(45deg); }
.bl-logo-dim i:last-child::after { right: 1px; transform: rotate(-135deg); }
.bl-logo-dim span { font: 500 clamp(14px, 1.9vw, 19px)/1 var(--font-ui); letter-spacing: 0.6em; margin-right: -0.6em; color: var(--canvas-100); }
.bl-logo--sm .bl-logo-mark { width: 46px; }
.bl-logo--sm .bl-logo-word { font-size: 28px; }
.bl-logo--sm .bl-logo-dim span { font-size: 13px; }

/* ------------------------------------------------------------------ main menu */
.bl-menu { padding: 0; overflow-x: hidden; }
.bl-menu-draft { position: absolute; right: 0; bottom: 40px; width: min(760px, 70vw); opacity: 0.16; pointer-events: none; }
.bl-menu-draft * { fill: none; stroke: var(--draft-line); stroke-width: 1.1; vector-effect: non-scaling-stroke; }
.bl-menu-draft .bl-d-dash { stroke-dasharray: 4 5; }
.bl-menu-draft text { fill: var(--draft-line); stroke: none; font: 12px var(--font-mono); }
.bl-menu-inner {
  position: relative; width: min(1180px, 100%); margin: 0 auto; min-height: 100%;
  display: flex; flex-direction: column; gap: clamp(14px, 2.6vh, 26px);
  padding: clamp(18px, 4vh, 44px) clamp(16px, 3vw, 40px) clamp(14px, 2vh, 22px);
}
.bl-menu-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.bl-menu-brand { display: flex; flex-direction: column; gap: 10px; }
.bl-tagline { font-size: 14px; color: var(--canvas-500); letter-spacing: 0.04em; }
.bl-menu-grid { flex: 1 0 auto; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: clamp(14px, 1.8vw, 22px); align-items: start; }
.bl-worlds { display: flex; flex-direction: column; grid-row: span 2; }
@media (min-width: 1100px) {
  .bl-menu-grid { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 0.92fr); }
  .bl-worlds { grid-row: auto; }
}
.bl-world-list { display: flex; flex-direction: column; gap: 8px; max-height: max(220px, calc(100vh - 330px)); overflow-y: auto; margin: 0 -6px; padding: 2px 6px; scrollbar-width: thin; scrollbar-color: var(--brass-600) transparent; }
.bl-world {
  display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 10px 10px 10px 14px; border-radius: 11px;
  background: var(--row-bg); border: 1px solid var(--line-faint);
  transition: border-color 0.12s ease, background-color 0.12s ease;
}
.bl-world:hover { border-color: var(--line); background: var(--row-bg-hover); }
.bl-world-main { flex: 1; min-width: 0; }
.bl-world-name { font-size: 16px; font-weight: 650; color: var(--canvas-50); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bl-world-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 12px; color: var(--canvas-500); }
.bl-world-seed { font-family: var(--font-mono); max-width: 11em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bl-world-seed em { font-style: normal; font-family: var(--font-ui); color: var(--canvas-700); margin-right: 4px; }
.bl-world-actions { display: flex; gap: 8px; flex: none; }
/* The confirm row shows the full world name (the player must see exactly what goes): the
   message wraps anywhere, and the buttons drop below it when the row is too narrow for both. */
.bl-world--confirm { flex-wrap: wrap; row-gap: 10px; border-color: var(--danger-edge-strong); background: var(--danger-row); }
.bl-world--confirm:hover { border-color: var(--danger); background: var(--danger-row-hover); }
.bl-world--confirm .bl-world-actions { margin-left: auto; }
.bl-world-confirm { flex: 1 1 14em; min-width: 0; font-size: 14px; color: var(--canvas-50); overflow-wrap: anywhere; }
.bl-world-confirm::before { content: "!"; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin-right: 8px; border-radius: 50%; border: 1.5px solid var(--danger); color: var(--danger); font: 700 11px/1 var(--font-mono); vertical-align: 1px; }
/* A world request is in flight (see MainMenuView.busy): actions look and feel inert. */
.bl-menu[data-busy="1"] .bl-world-actions .bl-btn, .bl-menu[data-busy="1"] .bl-form-submit { opacity: 0.55; cursor: progress; }
.bl-badge {
  display: inline-flex; align-items: center; height: 19px; padding: 0 8px; border-radius: 5px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.06em; border: 1px solid currentColor;
}
.bl-badge--creative { color: var(--brass-300); }
.bl-badge--survival { color: var(--ahead); }
.bl-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-height: 160px; padding: 20px;
  border: 1px dashed var(--line); border-radius: 12px; text-align: center; color: var(--canvas-500); font-size: 14px;
}
.bl-empty strong { color: var(--canvas-100); font-weight: 600; font-size: 15px; }
.bl-form { display: grid; grid-template-columns: auto 1fr; gap: 12px 14px; align-items: center; }
.bl-form label, .bl-form .bl-form-label { font-size: 13px; color: var(--canvas-300); letter-spacing: 0.04em; }
.bl-form-hint { grid-column: 2; margin-top: -4px; font-size: 12px; color: var(--canvas-500); min-height: 1.4em; }
.bl-form-submit { grid-column: 1 / -1; margin-top: 4px; }
.bl-menu-foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 10px; border-top: 1px solid var(--line-faint); font-size: 12px; color: var(--canvas-500); }
.bl-menu-foot b { font: 600 12px/1 var(--font-mono); color: var(--canvas-300); }
.bl-menu-foot span + span::before { content: "·"; margin: 0 10px; color: var(--canvas-700); }
.bl-cheats .bl-keys { row-gap: 6px; }
.bl-cheats .bl-key-row dd { font-size: 12.5px; }

/* ------------------------------------------------------------------ loading */
.bl-loading { align-items: center; justify-content: center; }
.bl-loading-inner { width: min(520px, 100%); display: flex; flex-direction: column; align-items: stretch; gap: 22px; }
.bl-loading .bl-logo { justify-content: center; }
.bl-loading-title { text-align: center; font: 600 13px/1 var(--font-ui); letter-spacing: 0.3em; text-transform: uppercase; color: var(--brass-300); }
.bl-progress {
  position: relative; height: 14px; border-radius: 7px; overflow: hidden;
  background: var(--ink-a75); box-shadow: inset 0 0 0 1px var(--line), inset 0 2px 4px var(--shade-60);
}
.bl-progress-fill {
  position: absolute; inset: 2px; border-radius: 5px; transform-origin: 0 50%; transform: scaleX(0);
  background: linear-gradient(180deg, var(--brass-200), var(--brass-400) 60%, var(--brass-600));
  transition: transform 0.25s ease;
}
.bl-progress-ticks {
  position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), var(--ink-a55) calc(10% - 1px) 10%);
}
.bl-loading-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 13px; color: var(--canvas-300); }
.bl-loading-pct { font: 600 13px/1 var(--font-mono); color: var(--canvas-50); }

/* ------------------------------------------------------------------ pause */
.bl-pause-panel { width: min(960px, 100%); display: grid; grid-template-columns: minmax(230px, 280px) 1fr; gap: 26px; padding: 26px 28px; align-items: start; }
.bl-pause-main { display: flex; flex-direction: column; gap: 10px; }
.bl-pause-main .bl-title-lg { margin-bottom: 10px; }
.bl-pause-mode { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
.bl-pause-mode .bl-seg-ctl { width: 100%; }
.bl-pause-mode .bl-seg-ctl button { flex: 1; }
.bl-pause-quit { margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--line-faint); display: flex; flex-direction: column; gap: 10px; }
.bl-pause-unsaved, .bl-death-unsaved { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.bl-pause-ref { min-width: 0; padding-left: 26px; border-left: 1px solid var(--line-faint); }
.bl-pause-ref > .bl-subtitle { margin-bottom: 14px; }
.bl-ref-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 24px; }
.bl-ref-sec h4 {
  margin-bottom: 8px; padding-bottom: 5px; border-bottom: 1px solid var(--line-faint);
  font-size: 12px; font-weight: 700; letter-spacing: 0.14em; color: var(--brass-300);
}
.bl-ref-sec .bl-keys { row-gap: 6px; column-gap: 10px; }
.bl-ref-sec .bl-key-row dd { font-size: 12.5px; }

/* ------------------------------------------------------------------ inventory */
.bl-inv-panel { display: flex; flex-direction: column; gap: 12px; max-width: 100%; padding: 16px 20px 18px; }
.bl-inv-head { display: flex; align-items: center; gap: 12px; }
.bl-inv-head .bl-panel-title { flex: 1; margin: 0; }
.bl-inv-body { display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: stretch; min-height: 0; }
.bl-palette { display: flex; flex-direction: column; gap: 10px; width: calc(var(--islot) * 9 + var(--igap) * 8 + 14px); min-height: 0; }
.bl-inv[data-creative="0"] .bl-palette { display: none; }
.bl-search { position: relative; display: block; }
.bl-search svg { position: absolute; left: 11px; top: 50%; width: 16px; height: 16px; margin-top: -8px; pointer-events: none; }
.bl-search svg * { fill: none; stroke: var(--canvas-500); stroke-width: 1.8; stroke-linecap: round; }
.bl-search .bl-input { padding-left: 34px; min-height: 36px; font-size: 14px; }
.bl-search .bl-input::-webkit-search-cancel-button { filter: invert(0.8) sepia(0.4); cursor: pointer; }
.bl-palette-scroll {
  flex: 1; min-height: 0; max-height: calc(var(--islot) * 7.6 + 60px); overflow-y: auto; padding: 2px 8px 6px 2px; margin-right: -8px;
  scrollbar-width: thin; scrollbar-color: var(--brass-600) transparent;
  /* Fade the bottom edge so it reads as "more below". */
  -webkit-mask-image: linear-gradient(180deg, var(--mask-opaque) calc(100% - 26px), transparent);
  mask-image: linear-gradient(180deg, var(--mask-opaque) calc(100% - 26px), transparent);
  padding-bottom: 22px;
}
.bl-pgroup + .bl-pgroup { margin-top: 12px; }
.bl-pgroup h3 { margin-bottom: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; color: var(--canvas-500); }
.bl-pgrid { display: grid; grid-template-columns: repeat(auto-fill, var(--islot)); gap: var(--igap); }
.bl-pitem {
  position: relative; width: var(--islot); height: var(--islot); padding: 0; border-radius: calc(var(--islot) * 0.2); cursor: pointer;
  border: 1px solid var(--line-faint); background: var(--ink-a45);
  display: flex; align-items: center; justify-content: center; transition: border-color 0.1s ease, background-color 0.1s ease;
}
.bl-pitem:hover { border-color: var(--brass-300); background: var(--item-hover); }
.bl-palette-empty { padding: 26px 0; text-align: center; font-size: 13px; color: var(--canvas-500); }
.bl-inv-slots { display: flex; flex-direction: column; justify-content: flex-start; }
.bl-slotgrid { display: grid; grid-template-columns: repeat(9, var(--islot)); gap: var(--igap); }
.bl-slotgrid--hot { padding-top: 10px; margin-top: 4px; border-top: 1px dashed var(--line); }
.bl-inv-slots .bl-subtitle { margin-top: 2px; }
.bl-inv-slots .bl-subtitle + .bl-slotgrid { margin-bottom: 12px; }
.bl-inv-offhand { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.bl-inv-offhand .bl-slot, .bl-inv-offhand .bl-slot-well { border-radius: 50%; }
.bl-inv-offhand .bl-slot { box-shadow: 0 0 0 1px var(--brass-400), 0 2px 5px var(--shade-30); }
.bl-inv-offhand-label { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--canvas-300); }
.bl-inv-hint { margin-top: auto; padding-top: 10px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--canvas-500); }
.bl-inv-close { min-height: 34px; min-width: 34px; padding: 6px; border-radius: 8px; }

.bl-cursor {
  --cs: calc(var(--islot) * var(--ui-zoom));
  position: fixed; left: 0; top: 0; z-index: 5; width: var(--cs); height: var(--cs); margin: calc(var(--cs) * -0.5) 0 0 calc(var(--cs) * -0.5);
  display: flex; align-items: center; justify-content: center; pointer-events: none; will-change: transform;
  filter: drop-shadow(0 6px 8px var(--shade-55));
}
.bl-cursor canvas { width: 82%; height: 82%; }
.bl-cursor .bl-slot-count { --s: var(--cs); }

.bl-tooltip {
  position: fixed; left: 0; top: 0; z-index: 4; max-width: 260px; padding: 7px 11px; border-radius: 8px; pointer-events: none;
  background: var(--ink-a95); border: 1px solid var(--line); box-shadow: var(--shadow-md); will-change: transform;
}
.bl-tooltip-name { font-size: 14px; font-weight: 650; color: var(--canvas-50); white-space: nowrap; }
.bl-tooltip-alt { margin-top: 1px; font-size: 11.5px; color: var(--canvas-500); white-space: nowrap; }

/* ------------------------------------------------------------------ settings */
.bl-settings-panel { width: min(600px, 100%); display: flex; flex-direction: column; gap: 18px; padding: 24px 26px; }
.bl-settings-panel .bl-title-lg { margin-bottom: 0; }
.bl-settings-sec { display: flex; flex-direction: column; gap: 10px; }
.bl-field { display: grid; grid-template-columns: minmax(110px, 160px) 1fr 84px; align-items: center; gap: 14px; min-height: 36px; }
.bl-field-label { font-size: 14px; color: var(--canvas-100); }
.bl-field-val { font: 600 13px/1 var(--font-mono); color: var(--brass-200); text-align: right; white-space: nowrap; }
.bl-field-ctl { grid-column: 2 / 4; justify-self: start; }
.bl-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
.bl-settings-panel .bl-actions { padding-top: 6px; border-top: 1px solid var(--line-faint); }

/* ------------------------------------------------------------------ death */
.bl-death {
  background:
    radial-gradient(ellipse at center, var(--death-in) 0%, var(--death-out) 100%),
    var(--scrim);
}
.bl-death-card { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; padding: 30px 34px; max-width: 460px; }
.bl-death-mark { width: 84px; height: 84px; margin-bottom: -4px; }
.bl-death-mark * { fill: none; stroke: var(--vital-400); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.bl-death-title { font: 600 clamp(30px, 6vw, 44px)/1.1 var(--font-display); letter-spacing: 0.06em; color: var(--canvas-50); text-shadow: 0 2px 18px var(--death-glow); }
.bl-death-sub { font-size: 15px; color: var(--canvas-300); }
.bl-death .bl-actions { justify-content: center; margin-top: 8px; }
.bl-death .bl-btn { min-width: 150px; }

/* ------------------------------------------------------------------ responsive */
@media (max-width: 860px) {
  .bl-menu-grid { grid-template-columns: minmax(0, 1fr); }
  .bl-worlds { grid-row: auto; }
  .bl-world-list { max-height: none; }
  .bl-pause-panel { grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 22px 18px; }
  .bl-pause-ref { padding-left: 0; padding-top: 16px; border-left: 0; border-top: 1px solid var(--line-faint); }
  .bl-palette-scroll { max-height: calc(var(--islot) * 4.6 + 40px); }
  .bl-pgrid { grid-template-columns: repeat(9, var(--islot)); }
}
@media (max-width: 1100px) {
  .bl-ui { --helm-base: 0.82; --helm-margin: 8px; }
}
@media (max-width: 560px) {
  .bl-ui { font-size: 14px; --helm-base: 0.78; }
  .bl-panel { padding: 16px 14px; border-radius: 14px; }
  .bl-menu-head { align-items: flex-start; }
  .bl-menu-settings { position: absolute; top: clamp(18px, 4vh, 44px); right: 14px; min-width: 40px; padding: 8px; }
  .bl-menu-settings .bl-btn-label { display: none; }
  .bl-menu-brand { padding-right: 46px; }
  .bl-logo { gap: 10px; }
  .bl-logo-mark { width: 44px; }
  .bl-logo-word { font-size: clamp(20px, 6.4vw, 30px); letter-spacing: 0.12em; margin-right: -0.12em; }
  .bl-logo-dim { margin-top: 5px; gap: 6px; }
  .bl-logo-dim span { font-size: 12px; letter-spacing: 0.45em; margin-right: -0.45em; }
  .bl-ref-grid { grid-template-columns: minmax(0, 1fr); }
  .bl-world { gap: 8px; padding: 10px 8px 10px 12px; }
  .bl-world-actions { gap: 6px; }
  .bl-world-actions .bl-btn--primary { padding: 8px 12px; }
  .bl-world--confirm .bl-world-actions { width: 100%; }
  .bl-world--confirm .bl-world-actions .bl-btn { flex: 1; }
  .bl-field { grid-template-columns: 1fr auto; gap: 6px 12px; }
  .bl-field .bl-range { grid-column: 1 / -1; grid-row: 2; }
  .bl-field-ctl { grid-column: 2; justify-self: end; }
  .bl-settings-panel, .bl-inv-panel { padding: 16px 12px; }
  .bl-inv-panel { gap: 10px; }
  .bl-ui[data-screen="none"] .bl-toasts { left: 12px; width: auto; align-items: stretch; }
  .bl-ui:not([data-screen="none"]) .bl-toasts { right: 72px; width: auto; align-items: stretch; }
  .bl-title-lg { font-size: 24px; }
  .bl-death-card { padding: 24px 18px; }
}
@media (min-width: 1900px) and (min-height: 1000px) {
  .bl-ui { font-size: 17px; --helm-base: 1.3; }
  .bl-debug { font-size: 14px; }
}
@media (min-width: 2400px) and (min-height: 1300px) { .bl-ui { --ui-zoom: 1.5; --helm-base: 1; } }
@media (min-width: 3200px) and (min-height: 1800px) { .bl-ui { --ui-zoom: 2; } }
/* Panels and text blocks scale as a unit; elements positioned from pointer coordinates
   (held stack, tooltip box) or by the layout pass (toast column, helm, drag banner's veil)
   scale their size only, so their placement stays in plain viewport px. */
.bl-menu-inner, .bl-loading-inner, .bl-panel-modal, .bl-toast, .bl-veil-card, .bl-debug, .bl-hint, .bl-crosshair,
.bl-gauges, .bl-itemname, .bl-tooltip > * { zoom: var(--ui-zoom); }

/* ------------------------------------------------------------------ reduced motion */
@media (prefers-reduced-motion: reduce) {
  .bl-ui *, .bl-ui *::before, .bl-ui *::after {
    animation-duration: 0s !important; animation-iteration-count: 1 !important;
    transition-duration: 0s !important; transition-delay: 0s !important;
  }
  /* The held item's name must still appear (and fade) without moving. */
  .bl-ui .bl-itemname.is-flash-a { animation: bl-name-still-a 2.6s linear both !important; }
  .bl-ui .bl-itemname.is-flash-b { animation: bl-name-still-b 2.6s linear both !important; }
}
`;
