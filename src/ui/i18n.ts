/**
 * Every UI string, in both languages, in one table. Pure data + a formatter: no DOM, so the
 * completeness tests can import it in Node.
 *
 * Placeholders are written `{name}` and must appear identically in both languages
 * (tests/ui/i18n.test.ts enforces it). Item names do NOT live here: they come from
 * itemDef(id).nameZh / nameEn so the block table stays the single source of truth.
 */
import type { Language } from './model';

interface Entry {
  readonly zh: string;
  readonly en: string;
}

export const STRINGS = {
  // ---- brand
  'brand.name': { zh: 'Blocklands', en: 'Blocklands' },
  'brand.nameZh': { zh: '方块大陆', en: '方块大陆' },
  'brand.tagline': { zh: '造船、立风车——让方块世界动起来', en: 'Raise windmills, launch ships — a block world that moves' },

  // ---- game modes
  'mode.creative': { zh: '创造', en: 'Creative' },
  'mode.survival': { zh: '生存', en: 'Survival' },

  // ---- main menu
  'menu.worlds': { zh: '已存世界', en: 'Saved worlds' },
  'menu.worldCount': { zh: '{n} 个', en: '{n} total' },
  'menu.noWorlds': { zh: '还没有存档。', en: 'No saved worlds yet.' },
  'menu.noWorldsHint': { zh: '在“新世界”里起草第一张图纸吧。', en: 'Draft your first one under “New world”.' },
  'menu.play': { zh: '进入', en: 'Play' },
  'menu.delete': { zh: '删除', en: 'Delete' },
  'menu.deleteWorldLabel': { zh: '删除世界 {name}', en: 'Delete world {name}' },
  'menu.playWorldLabel': { zh: '进入世界 {name}', en: 'Play world {name}' },
  'menu.confirmDelete': { zh: '删除“{name}”？此操作无法撤销。', en: 'Delete “{name}”? This cannot be undone.' },
  'menu.confirmYes': { zh: '确认删除', en: 'Delete forever' },
  'menu.cancel': { zh: '取消', en: 'Cancel' },
  'menu.seed': { zh: '种子', en: 'Seed' },
  'menu.lastPlayed': { zh: '上次游玩', en: 'Last played' },
  'menu.newWorld': { zh: '新世界', en: 'New world' },
  'menu.worldName': { zh: '名称', en: 'Name' },
  'menu.defaultWorldName': { zh: '新世界', en: 'New World' },
  'menu.seedPlaceholder': { zh: '留空则随机', en: 'Leave empty for a random seed' },
  'menu.mode': { zh: '模式', en: 'Mode' },
  'menu.modeCreativeHint': { zh: '材料无限，强力胶无限，不会受伤。', en: 'Unlimited materials and glue; no damage.' },
  'menu.modeSurvivalHint': { zh: '需要挖掘和收集，会受伤、会溺水。', en: 'Mine and gather; you can get hurt and drown.' },
  'menu.create': { zh: '创建并进入', en: 'Create & play' },
  'menu.settings': { zh: '设置', en: 'Settings' },
  'menu.controls': { zh: '操作速查', en: 'Controls' },
  'menu.renderer': { zh: '渲染', en: 'Renderer' },
  'menu.version': { zh: '版本', en: 'Version' },

  // ---- relative time
  'time.justNow': { zh: '刚刚', en: 'just now' },
  'time.minutes': { zh: '{n} 分钟前', en: '{n} min ago' },
  'time.hours': { zh: '{n} 小时前', en: '{n} h ago' },
  'time.yesterday': { zh: '昨天', en: 'yesterday' },
  'time.days': { zh: '{n} 天前', en: '{n} days ago' },
  'time.unknown': { zh: '未知', en: 'unknown' },

  // ---- loading
  'loading.title': { zh: '正在铺设世界', en: 'Laying out the world' },

  // ---- pause
  'pause.title': { zh: '已暂停', en: 'Paused' },
  'pause.resume': { zh: '继续游戏', en: 'Resume' },
  'pause.settings': { zh: '设置', en: 'Settings' },
  'pause.mode': { zh: '游戏模式', en: 'Game mode' },
  'pause.saveQuit': { zh: '保存并退出', en: 'Save & quit' },
  'pause.controls': { zh: '操作说明', en: 'Controls reference' },

  // ---- controls: key captions
  'key.leftClick': { zh: '左键', en: 'Left click' },
  'key.rightClick': { zh: '右键', en: 'Right click' },
  'key.wheel': { zh: '滚轮', en: 'Wheel' },
  'key.space': { zh: '空格', en: 'Space' },
  'key.spaceTwice': { zh: '空格 ×2', en: 'Space ×2' },
  'key.shift': { zh: 'Shift', en: 'Shift' },
  'key.again': { zh: '再次', en: 'again' },
  'key.blockA': { zh: '方块 A', en: 'block A' },
  'key.blockB': { zh: '相邻方块 B', en: 'adjacent block B' },

  // ---- controls: sections
  'ctl.sec.move': { zh: '移动', en: 'Movement' },
  'ctl.sec.build': { zh: '建造', en: 'Building' },
  'ctl.sec.ui': { zh: '界面', en: 'Interface' },
  'ctl.sec.helm': { zh: '舵轮', en: 'Helm' },
  'ctl.sec.bearing': { zh: '轴承', en: 'Bearing' },
  'ctl.sec.glue': { zh: '强力胶', en: 'Superglue' },

  // ---- controls: descriptions
  'ctl.move': { zh: '移动', en: 'Move' },
  'ctl.jump': { zh: '跳跃', en: 'Jump' },
  'ctl.fly': { zh: '切换飞行（创造模式）', en: 'Toggle flying (creative)' },
  'ctl.flyUpDown': { zh: '飞行时上升 / 下降', en: 'Fly up / down' },
  'ctl.sneak': { zh: '潜行', en: 'Sneak' },
  'ctl.mine': { zh: '挖掘', en: 'Mine' },
  'ctl.place': { zh: '放置 / 使用', en: 'Place / use' },
  'ctl.select': { zh: '选择快捷栏格子', en: 'Select hotbar slot' },
  'ctl.inventory': { zh: '物品栏', en: 'Inventory' },
  'ctl.pause': { zh: '暂停', en: 'Pause' },
  'ctl.debug': { zh: '调试信息', en: 'Debug overlay' },
  'ctl.helmPreview': { zh: '预览将要组装的船', en: 'Preview the ship' },
  'ctl.helmAssemble': { zh: '组装船只并掌舵', en: 'Assemble the ship and take the wheel' },
  'ctl.helmThrottle': { zh: '油门', en: 'Throttle' },
  'ctl.helmRudder': { zh: '转舵', en: 'Rudder' },
  'ctl.helmRelease': { zh: '（掌舵时）松开舵轮', en: 'Let go (while steering)' },
  'ctl.helmDock': { zh: '停靠：船还原为方块', en: 'Dock: turn the ship back into blocks' },
  'ctl.bearingPreview': { zh: '预览转子', en: 'Preview the rotor' },
  'ctl.bearingStart': { zh: '启动转子', en: 'Start the rotor' },
  'ctl.bearingStop': { zh: '（运转中）停止转子', en: 'Stop a running bearing' },
  'ctl.glueApply': { zh: '在两块之间涂胶', en: 'Glue the two blocks together' },
  'ctl.glueRemove': { zh: '第二下按住 Shift：拆胶', en: 'Hold Shift on the second click to remove glue' },

  // ---- main-menu cheat-sheet (abridged mechanism lines)
  'cheat.helm': { zh: '舵轮：预览 → 组装并掌舵', en: 'Helm: preview → assemble & steer' },
  'cheat.bearing': { zh: '轴承：预览 → 启动转子', en: 'Bearing: preview → start the rotor' },
  'cheat.glue': { zh: '强力胶：方块 A → 相邻方块 B', en: 'Glue: block A → adjacent block B' },

  // ---- inventory
  'inv.title': { zh: '物品栏', en: 'Inventory' },
  'inv.backpack': { zh: '背包', en: 'Backpack' },
  'inv.hotbar': { zh: '快捷栏', en: 'Hotbar' },
  'inv.palette': { zh: '物料库', en: 'Materials' },
  'inv.search': { zh: '搜索物品', en: 'Search items' },
  'inv.searchPlaceholder': { zh: '搜索中文或英文名…', en: 'Search by name…' },
  'inv.noResults': { zh: '没有匹配的物品', en: 'No matching items' },
  'inv.close': { zh: '关闭', en: 'Close' },
  'inv.dropHint': { zh: '点击面板外丢弃手中物品', en: 'Click outside the panel to drop the held stack' },
  'inv.shiftHint': { zh: 'Shift + 点击：直接放进快捷栏', en: 'Shift-click: straight to the hotbar' },
  'inv.slotEmpty': { zh: '空格位', en: 'Empty slot' },
  'inv.slotLabel': { zh: '{name} ×{n}', en: '{name} ×{n}' },
  'inv.held': { zh: '手持', en: 'Held' },

  // ---- palette groups
  'group.mechanisms': { zh: '机构', en: 'Mechanisms' },
  'group.cloth': { zh: '绒布与帆布', en: 'Felt & canvas' },
  'group.building': { zh: '建材', en: 'Building' },
  'group.terrain': { zh: '地形', en: 'Terrain' },
  'group.nature': { zh: '植物与覆盖', en: 'Plants & cover' },
  'group.utility': { zh: '工具与杂项', en: 'Tools & misc' },

  // ---- settings
  'settings.title': { zh: '设置', en: 'Settings' },
  'settings.secDisplay': { zh: '画面', en: 'Display' },
  'settings.secInput': { zh: '操作', en: 'Input' },
  'settings.secGeneral': { zh: '通用', en: 'General' },
  'settings.renderDistance': { zh: '视距', en: 'Render distance' },
  'settings.chunks': { zh: '{n} 区块', en: '{n} chunks' },
  'settings.fov': { zh: '视野', en: 'Field of view' },
  'settings.sensitivity': { zh: '鼠标灵敏度', en: 'Mouse sensitivity' },
  'settings.invertY': { zh: '反转 Y 轴', en: 'Invert Y axis' },
  'settings.language': { zh: '语言', en: 'Language' },
  'settings.debug': { zh: '调试信息', en: 'Debug overlay' },
  'settings.on': { zh: '开', en: 'On' },
  'settings.off': { zh: '关', en: 'Off' },
  'settings.back': { zh: '返回', en: 'Back' },

  // ---- death
  'death.title': { zh: '你倒下了', en: 'You have fallen' },
  'death.subtitle': { zh: '工坊会把你送回出生点。', en: 'The workshop will carry you back to your spawn point.' },
  'death.respawn': { zh: '重生', en: 'Respawn' },

  // ---- HUD
  'hud.clickToPlay': { zh: '点击画面开始', en: 'Click to play' },
  'hud.clickToPlaySub': { zh: 'Esc 暂停 · E 物品栏 · F3 调试', en: 'Esc pause · E inventory · F3 debug' },
  'hud.dragLook': { zh: '按住并拖动画面来环顾四周', en: 'Press and drag to look around' },
  'hud.dragLookSub': { zh: '无法锁定指针，已切换为拖动视角', en: 'Pointer lock is unavailable — drag-to-look mode' },
  'hud.health': { zh: '生命', en: 'Vitality' },
  'hud.breath': { zh: '气息', en: 'Breath' },
  'hud.hotbar': { zh: '快捷栏', en: 'Hotbar' },
  'hud.notifications': { zh: '通知', en: 'Notifications' },

  // ---- helm instrument
  'helm.title': { zh: '舵位', en: 'Helm' },
  'helm.throttle': { zh: '油门', en: 'Throttle' },
  'helm.rudder': { zh: '舵角', en: 'Rudder' },
  'helm.speed': { zh: '航速', en: 'Speed' },
  'helm.speedUnit': { zh: '格/秒', en: 'blocks/s' },
  'helm.sails': { zh: '帆', en: 'Sails' },
  'helm.full': { zh: '全速', en: 'Full' },
  'helm.half': { zh: '半速', en: 'Half' },
  'helm.stop': { zh: '停', en: 'Stop' },
  'helm.astern': { zh: '倒车', en: 'Astern' },
  'helm.port': { zh: '左舷', en: 'Port' },
  'helm.starboard': { zh: '右舷', en: 'Stbd' },

  // ---- items
  'item.unknown': { zh: '未知物品 #{id}', en: 'Unknown item #{id}' },
} as const satisfies Record<string, Entry>;

export type StringKey = keyof typeof STRINGS;
export type Params = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Translate `key` into `lang`, substituting `{name}` placeholders from `params`.
 * A placeholder without a value is left visible on purpose: a missing parameter should be
 * noticed during development rather than silently produce a half sentence.
 */
export function t(lang: Language, key: StringKey, params?: Params): string {
  const entry: Entry = STRINGS[key];
  const text = lang === 'en' ? entry.en : entry.zh;
  if (!params) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/** Placeholder names used by a template, sorted (for the parity test). */
export function placeholdersOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) out.add(m[1]!);
  return [...out].sort();
}

/** Every key, for completeness checks and the dev harness. */
export function allStringKeys(): StringKey[] {
  return Object.keys(STRINGS) as StringKey[];
}

/** Display names of the languages, always written in their own language. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { zh: '中文', en: 'English' };
