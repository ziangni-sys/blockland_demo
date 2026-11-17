/**
 * UI harness: mounts the real UI over a fake scene and drives it with a fake client.
 *
 * URL parameters (all optional):
 *   screen=none|mainMenu|loading|pause|inventory|settings|death   lang=zh|en   mode=creative|survival
 *   helm=1  air=<0..300>  health=<0..20>  hint=<text|1>  toasts=<n>  debug=1  locked=1  drag=1
 *   worlds=<n>  icons=placeholder  panel=1  cursor=<itemId>  from=pause|mainMenu  progress=<0..1>
 *   animate=1 (helm / debug values change every frame, like a running game)
 *   clamp=1   (the fake client caps FOV at 100, to test that the UI shows what the client kept)
 *
 * window.harness: { state(), set(patch), show(screen), log, clearLog(), perf(n), ui }
 * Every UiActions call is appended to window.harness.log as { name, args }.
 */
import { allItems, I, itemDef } from '../../src/blocks/items';
import { B } from '../../src/blocks/defs';
import { createUi } from '../../src/ui/index';
import {
  DEFAULT_SETTINGS,
  INVENTORY_SIZE,
  type GameMode,
  type Screen,
  type SlotView,
  type Toast,
  type UiActions,
  type UiState,
  type WorldSummary,
} from '../../src/ui/model';
import { fakeIconProvider } from './fakeIcons';
import { paintScene } from './scene';

interface LoggedAction {
  name: string;
  args: unknown[];
}

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);
const flag = (k: string): boolean => params.get(k) === '1';

const now = Date.now();
const SAMPLE_WORLDS: WorldSummary[] = [
  { id: 'w1', name: '海湾船坞', seed: '20261117', mode: 'creative', lastPlayed: now - 4 * 60_000 },
  { id: 'w2', name: 'Windmill Ridge', seed: 'sails-and-sawdust', mode: 'survival', lastPlayed: now - 26 * 3600_000 },
  { id: 'w3', name: '北岬灯塔', seed: '-8812374', mode: 'survival', lastPlayed: now - 3 * 86400_000 },
  { id: 'w4', name: 'A very long world name that should be truncated gracefully in the list', seed: '7', mode: 'creative', lastPlayed: now - 40 * 86400_000 },
  { id: 'w5', name: 'Turntable test', seed: '', mode: 'creative', lastPlayed: 0 },
];

function stack(item: number, count: number): SlotView {
  return { item, count };
}

function initialState(): UiState {
  const hotbar: Array<SlotView | null> = [
    stack(B.PLANKS_OAK, 64), stack(B.CANVAS, 32), stack(B.HELM, 1), stack(B.BEARING, 2), stack(I.GLUE, 48),
    stack(B.WOOL_RED, 12), null, stack(B.TORCH, 16), stack(I.BUCKET_WATER, 1),
  ];
  const inventory: Array<SlotView | null> = new Array(INVENTORY_SIZE).fill(null);
  const fill = [B.STONE_BRICKS, B.LOG_OAK, B.GLASS, B.SAND, B.WOOL_BLUE, B.PROPELLER, B.LAMP, B.TNT, B.FLOWER_YELLOW, B.COBBLE, B.IRON_BLOCK];
  fill.forEach((it, i) => (inventory[i * 2 + (i % 3)] = stack(it, ((i * 17) % 63) + 1)));
  const toastCount = num('toasts', 0);
  const toasts: Toast[] = [];
  const samples: Array<[string, Toast['kind']]> = [
    ['世界已保存', 'info'],
    ['转子至少需要 4 块帆布或绒布（当前 2 块）', 'warn'],
    ['停靠失败：3 格被岩石挡住', 'error'],
  ];
  for (let i = 0; i < toastCount; i++) toasts.push({ id: i + 1, text: samples[i % samples.length]![0], kind: samples[i % samples.length]![1] });
  const lang = params.get('lang') === 'en' ? 'en' : 'zh';
  const hintParam = params.get('hint');
  const cursorItem = params.has('cursor') ? Number(params.get('cursor')) : -1;
  return {
    screen: (params.get('screen') as Screen | null) ?? 'none',
    settingsReturn: (params.get('from') as Screen | null) ?? 'pause',
    mode: (params.get('mode') as GameMode | null) ?? 'survival',
    hotbar,
    selected: 2,
    inventory,
    cursor: cursorItem >= 0 ? stack(cursorItem, 24) : null,
    health: num('health', 14),
    maxHealth: 20,
    air: num('air', 300),
    maxAir: 300,
    hint: hintParam === null ? null : hintParam === '1' ? (lang === 'en' ? 'Right-click again to assemble (42 blocks)' : '再次右键确认组装（42 格）') : hintParam,
    toasts,
    debug: flag('debug') ? debugLines(0) : null,
    helm: flag('helm') ? { throttle: 0.62, rudder: -0.35, speed: 4.26, sails: 12 } : null,
    worlds: SAMPLE_WORLDS.slice(0, num('worlds', 4)),
    settings: { ...DEFAULT_SETTINGS, language: lang, showDebug: flag('debug') },
    loading: { text: lang === 'en' ? 'Generating terrain… (chunk 37 / 81)' : '正在生成地形……（区块 37 / 81）', progress: num('progress', 0.46) },
    pointerLocked: flag('locked'),
    dragLook: flag('drag'),
    renderer: 'WebGPU',
    version: '0.1.0',
  };
}

function debugLines(frame: number): string[] {
  return [
    `Blocklands 0.1.0  ${60 - (frame % 3)} fps  (WebGPU)`,
    `XYZ  ${(128.5 + frame * 0.01).toFixed(2)} / 64.00 / ${(-42.25).toFixed(2)}`,
    'Chunk 8 4 -3   facing north (-Z)',
    'Light sky 15 block 0   Biome plains',
    'Structures 3 (ship 214 cells, rotor 36)',
  ];
}

// ------------------------------------------------------------------ fake client

let state = initialState();
const log: LoggedAction[] = [];
const logEl = document.createElement('div');
logEl.className = 'log';
let toastSeq = 100;

function set(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  ui.update(state);
}

function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastSeq;
  set({ toasts: [...state.toasts, { id, text, kind }] });
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), 3500);
}

function record(name: string, args: unknown[]): void {
  log.push({ name, args });
  logEl.textContent = log
    .slice(-30)
    .map((l) => `${l.name}(${l.args.map((a) => JSON.stringify(a)).join(', ')})`)
    .join('\n');
  logEl.scrollTop = logEl.scrollHeight;
  console.info('[ui action]', name, ...args);
}

function maxStack(item: number): number {
  return itemDef(item).maxStack;
}

function startLoading(): void {
  let p = 0;
  set({ screen: 'loading', loading: { text: state.settings.language === 'en' ? 'Generating terrain…' : '正在生成地形……', progress: 0 } });
  const tick = (): void => {
    p += 0.07;
    if (p >= 1) {
      set({ screen: 'none', loading: null, pointerLocked: false });
      return;
    }
    set({ loading: { text: state.loading?.text ?? '', progress: p } });
    setTimeout(tick, 60);
  };
  setTimeout(tick, 60);
}

const actions: UiActions = {
  newWorld(opts) {
    record('newWorld', [opts]);
    startLoading();
  },
  loadWorld(id) {
    record('loadWorld', [id]);
    startLoading();
  },
  deleteWorld(id) {
    record('deleteWorld', [id]);
    set({ worlds: state.worlds.filter((w) => w.id !== id) });
  },
  resume() {
    record('resume', []);
    set({ screen: 'none' });
  },
  saveAndQuit() {
    record('saveAndQuit', []);
    set({ screen: 'mainMenu', helm: null });
    toast(state.settings.language === 'en' ? 'World saved' : '世界已保存');
  },
  respawn() {
    record('respawn', []);
    set({ screen: 'none', health: state.maxHealth, air: state.maxAir });
  },
  openSettings() {
    record('openSettings', []);
    set({ settingsReturn: state.screen === 'mainMenu' ? 'mainMenu' : 'pause', screen: 'settings' });
  },
  closeSettings() {
    record('closeSettings', []);
    set({ screen: state.settingsReturn });
  },
  changeSettings(patch) {
    record('changeSettings', [patch]);
    const settings = { ...state.settings, ...patch };
    // ?clamp=1 simulates a client that refuses part of a change (FOV capped at 100).
    if (flag('clamp')) settings.fov = Math.min(100, settings.fov);
    set({ settings, debug: settings.showDebug ? debugLines(0) : null });
  },
  setMode(mode) {
    record('setMode', [mode]);
    set({ mode });
  },
  selectHotbar(index) {
    record('selectHotbar', [index]);
    set({ selected: index });
  },
  slotClick(area, index, button, shift) {
    record('slotClick', [area, index, button, shift]);
    const hotbar = state.hotbar.slice();
    const inventory = state.inventory.slice();
    const arr = area === 'hotbar' ? hotbar : inventory;
    const slot = arr[index] ?? null;
    let cursor = state.cursor;
    if (shift && slot && !cursor) {
      const other = area === 'hotbar' ? inventory : hotbar;
      const free = other.findIndex((s) => s === null);
      if (free >= 0) {
        other[free] = slot;
        arr[index] = null;
      }
    } else if (button === 0) {
      if (!cursor) {
        cursor = slot;
        arr[index] = null;
      } else if (!slot) {
        arr[index] = cursor;
        cursor = null;
      } else if (slot.item === cursor.item) {
        const room = maxStack(slot.item) - slot.count;
        const moved = Math.min(room, cursor.count);
        arr[index] = stack(slot.item, slot.count + moved);
        cursor = cursor.count - moved > 0 ? stack(cursor.item, cursor.count - moved) : null;
      } else {
        arr[index] = cursor;
        cursor = slot;
      }
    } else {
      if (!cursor && slot) {
        const half = Math.ceil(slot.count / 2);
        cursor = stack(slot.item, half);
        arr[index] = slot.count - half > 0 ? stack(slot.item, slot.count - half) : null;
      } else if (cursor && (!slot || (slot.item === cursor.item && slot.count < maxStack(slot.item)))) {
        arr[index] = stack(cursor.item, (slot ? slot.count : 0) + 1);
        cursor = cursor.count > 1 ? stack(cursor.item, cursor.count - 1) : null;
      }
    }
    set({ hotbar, inventory, cursor });
  },
  creativePick(item, shift) {
    record('creativePick', [item, shift]);
    if (shift) {
      const hotbar = state.hotbar.slice();
      const free = hotbar.findIndex((s) => s === null);
      hotbar[free >= 0 ? free : state.selected] = stack(item, maxStack(item));
      set({ hotbar });
    } else {
      set({ cursor: stack(item, maxStack(item)) });
    }
  },
  dropCursor() {
    record('dropCursor', []);
    set({ cursor: null });
  },
  closeScreen() {
    record('closeScreen', []);
    set({ screen: 'none', cursor: null });
  },
};

// ------------------------------------------------------------------ mount

const sceneCanvas = document.getElementById('scene') as HTMLCanvasElement;
paintScene(sceneCanvas);
window.addEventListener('resize', () => paintScene(sceneCanvas));

const ui = createUi(document.getElementById('ui-root')!, actions, {
  iconProvider: params.get('icons') === 'placeholder' ? undefined : fakeIconProvider,
});
ui.update(state);

// Clicking the "3D view" stands in for pointer lock.
sceneCanvas.addEventListener('click', () => {
  if (state.screen === 'none' && !state.dragLook) set({ pointerLocked: true });
});

// Client-style keyboard handling (the UI itself never binds E / Esc / F3).
window.addEventListener('keydown', (e) => {
  if (ui.wantsKeyboard()) return;
  const inGame = state.screen === 'none' || state.screen === 'inventory' || state.screen === 'pause';
  if (e.key === 'Escape') {
    if (state.screen === 'none') set({ screen: 'pause', pointerLocked: false });
    else if (state.screen === 'pause' || state.screen === 'inventory') set({ screen: 'none', cursor: null });
    else if (state.screen === 'settings') set({ screen: state.settingsReturn });
  } else if (e.key === 'e' || e.key === 'E') {
    if (state.screen === 'none') set({ screen: 'inventory', pointerLocked: false });
    else if (state.screen === 'inventory') set({ screen: 'none', cursor: null });
  } else if (e.key === 'F3' && inGame) {
    e.preventDefault();
    actions.changeSettings({ showDebug: !state.settings.showDebug });
  } else if (state.screen === 'none' && e.key >= '1' && e.key <= '9') {
    set({ selected: Number(e.key) - 1 });
  }
});

// Frame loop: the real client calls update() every frame, so the harness does too.
let frame = 0;
const animate = flag('animate');
function loop(): void {
  frame++;
  if (animate && state.screen === 'none') {
    const t = frame / 60;
    state = {
      ...state,
      helm: state.helm ? { throttle: Math.sin(t * 0.5), rudder: Math.sin(t * 0.9), speed: 5 + 3 * Math.sin(t * 0.3), sails: 12 } : null,
      debug: state.debug ? debugLines(frame) : null,
      air: state.air < state.maxAir ? Math.max(0, state.maxAir * (0.5 + 0.5 * Math.sin(t))) : state.air,
    };
  }
  ui.update(state);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ------------------------------------------------------------------ control panel

const panel = document.getElementById('harness')!;
panel.hidden = !flag('panel');
function addButton(label: string, fn: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  panel.appendChild(b);
}
for (const s of ['none', 'mainMenu', 'loading', 'pause', 'inventory', 'settings', 'death'] as const) addButton(s, () => set({ screen: s }));
addButton('lang', () => actions.changeSettings({ language: state.settings.language === 'zh' ? 'en' : 'zh' }));
addButton('mode', () => set({ mode: state.mode === 'creative' ? 'survival' : 'creative' }));
addButton('helm', () => set({ helm: state.helm ? null : { throttle: 0.5, rudder: 0.2, speed: 3.4, sails: 8 } }));
addButton('hurt', () => set({ health: Math.max(0, state.health - 3) }));
addButton('heal', () => set({ health: state.maxHealth }));
addButton('air-', () => set({ air: Math.max(0, state.air - 60) }));
addButton('air+', () => set({ air: state.maxAir }));
addButton('toast', () => toast(['世界已保存', '找不到可组装的方块', '停靠失败'][toastSeq % 3]!, (['info', 'warn', 'error'] as const)[toastSeq % 3]));
addButton('hint', () => set({ hint: state.hint ? null : '再次右键确认组装（42 格）' }));
addButton('lock', () => set({ pointerLocked: !state.pointerLocked }));
addButton('drag', () => set({ dragLook: !state.dragLook }));
panel.appendChild(logEl);

// ------------------------------------------------------------------ automation API

function perf(n: number): Record<string, number> {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) ui.update(state);
  const t1 = performance.now();
  // Fresh-but-identical snapshots: what a naive client produces every frame.
  for (let i = 0; i < n; i++) ui.update({ ...state, settings: { ...state.settings }, hotbar: state.hotbar.map((s) => (s ? { ...s } : null)) });
  const t2 = performance.now();
  // Live values changing every call (helm instruments, debug text, breath).
  const base = { ...state, helm: state.helm ?? { throttle: 0, rudder: 0, speed: 0, sails: 4 }, debug: debugLines(0) };
  for (let i = 0; i < n; i++) {
    ui.update({
      ...base,
      helm: { throttle: Math.sin(i * 0.01), rudder: Math.cos(i * 0.013), speed: 4 + Math.sin(i * 0.02), sails: 4 },
      debug: debugLines(i),
      air: base.maxAir * (0.5 + 0.4 * Math.sin(i * 0.05)),
    });
  }
  const t3 = performance.now();
  ui.update(state);
  return { sameObjectMs: (t1 - t0) / n, equalCopyMs: (t2 - t1) / n, liveValuesMs: (t3 - t2) / n };
}

declare global {
  interface Window {
    harness: {
      state(): UiState;
      set(patch: Partial<UiState>): void;
      show(screen: Screen): void;
      log: LoggedAction[];
      clearLog(): void;
      perf(n: number): Record<string, number>;
      itemCount: number;
      wantsKeyboard(): boolean;
    };
  }
}

window.harness = {
  state: () => state,
  set,
  show: (screen) => set({ screen }),
  log,
  clearLog: () => {
    log.length = 0;
    logEl.textContent = '';
  },
  perf,
  itemCount: allItems().length,
  wantsKeyboard: () => ui.wantsKeyboard(),
};
