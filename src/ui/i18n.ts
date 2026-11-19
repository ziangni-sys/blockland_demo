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
  'menu.seedPlaceholder': { zh: '留空则随机', en: 'Random if empty' },
  'menu.mode': { zh: '模式', en: 'Mode' },
  'menu.modeCreativeHint': { zh: '材料无限，强力胶无限，不会受伤。', en: 'Unlimited materials and glue; no damage.' },
  'menu.modeSurvivalHint': { zh: '需要挖掘和收集，会受伤、会溺水。', en: 'Mine and gather; you can get hurt and drown.' },
  'menu.create': { zh: '创建并进入', en: 'Create & play' },
  'menu.settings': { zh: '设置', en: 'Settings' },
  'menu.controls': { zh: '操作速查', en: 'Controls' },
  'menu.renderer': { zh: '渲染', en: 'Renderer' },
  'menu.version': { zh: '版本', en: 'Version' },
  'menu.join': { zh: '加入房间', en: 'Join a room' },
  'menu.offline': { zh: '这个版本不能联机', en: 'This build cannot go online' },

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
  'pause.saveFailed': { zh: '保存失败，世界仍然打开。', en: 'Saving failed; the world is still open.' },
  'pause.stopped': {
    zh: '游戏服务器出错，世界已经停住。可以保存并退出，或者不保存退出。',
    en: 'The game server failed and the world has stopped. Save & quit, or quit without saving.',
  },
  'pause.quitNoSave': { zh: '不保存退出', en: 'Quit without saving' },
  'pause.controls': { zh: '操作说明', en: 'Controls reference' },
  'pause.menuTitle': { zh: '游戏菜单', en: 'Menu' },
  'pause.running': { zh: '联机的世界不暂停：游戏仍在进行', en: 'Online worlds never pause: the game goes on' },
  'pause.together': { zh: '一起玩', en: 'Play together' },
  'pause.players': { zh: '玩家', en: 'Players' },
  'pause.roomOpen': { zh: '房间开放 · {n}/{max}', en: 'Room open · {n}/{max}' },
  'pause.leaveRoom': { zh: '离开房间', en: 'Leave the room' },

  // ---- play together (pause menu -> room screen)
  'room.title': { zh: '一起玩', en: 'Play together' },
  'room.invite': { zh: '邀请朋友', en: 'Invite friends' },
  'room.statusClosed': { zh: '房间未开放：朋友无法加入', en: 'The room is closed: friends cannot join' },
  'room.statusOpening': { zh: '正在开放房间…', en: 'Opening the room…' },
  'room.statusOpen': { zh: '房间已开放 · 世界里有 {n}/{max} 人', en: 'The room is open · {n} of {max} in the world' },
  'room.statusLost': {
    zh: '与信令服务的连接断开，正在重试：新朋友暂时无法加入',
    en: 'Lost the signalling service, retrying: new friends cannot join for now',
  },
  'room.open': { zh: '向朋友开放', en: 'Open to friends' },
  'room.openHint': {
    zh: '公共信令服务替两边的浏览器牵线，之后直接相连。朋友打开邀请链接就能加入，最多 4 人。',
    en: 'A public signalling service introduces the two browsers, which then connect directly. Friends join by opening the link; 4 players at most.',
  },
  'room.useCodes': { zh: '改用邀请码', en: 'Use invitation codes' },
  'room.useCodesHint': {
    zh: '信令服务连不上或被屏蔽时：为每位朋友生成一个邀请码，再粘贴对方发回的应答码。',
    en: 'When the service is unreachable or blocked: make an invitation code for each friend, then paste the answer they send back.',
  },
  'room.link': { zh: '邀请链接', en: 'Invitation link' },
  'room.code': { zh: '房间码', en: 'Room code' },
  'room.copy': { zh: '复制', en: 'Copy' },
  'room.copied': { zh: '已复制', en: 'Copied' },
  'room.close': { zh: '关闭房间', en: 'Close the room' },
  'room.closeHint': { zh: '关闭后新朋友无法加入，已在世界里的朋友不受影响。', en: 'Closing stops new joins; friends already in stay.' },
  'room.step1': { zh: '1 · 生成邀请码，发给一位朋友', en: '1 · Make an invitation code and send it to one friend' },
  'room.makeInvitation': { zh: '生成邀请码', en: 'Make an invitation' },
  'room.making': { zh: '正在生成…', en: 'Making…' },
  'room.invitation': { zh: '邀请码', en: 'Invitation code' },
  'room.step2': { zh: '2 · 粘贴朋友发回的应答码', en: '2 · Paste the answer code your friend sends back' },
  'room.answerPlaceholder': { zh: '以 BL1A. 开头', en: 'Starts with BL1A.' },
  'room.connect': { zh: '连接', en: 'Connect' },
  'room.answered': {
    zh: '正在连接这位朋友。下一位朋友需要一个新的邀请码。',
    en: 'Connecting this friend. The next friend needs a new invitation.',
  },
  'room.inWorld': { zh: '在世界里', en: 'In this world' },
  'room.count': { zh: '{n}/{max}', en: '{n}/{max}' },
  'room.host': { zh: '房主', en: 'Host' },
  'room.you': { zh: '你', en: 'You' },
  'room.rules': { zh: '世界规则', en: 'World rules' },
  'room.rulesHint': { zh: '新来的朋友以这个模式开始；生存模式下被撞掉、炸掉、冲掉的方块会掉落。你自己的模式在菜单里切换。', en: 'New friends start in this mode; in survival, blocks knocked, blown or washed loose drop. Your own mode is switched in the menu.' },
  'room.modeOf': { zh: '{name} 的模式', en: 'Mode of {name}' },
  'room.traffic': { zh: '{rate}/秒 · 积压 {backlog} · 往返 {rtt} 毫秒', en: '{rate}/s · backlog {backlog} · rtt {rtt} ms' },
  'room.trafficHint': {
    zh: '服务器每秒发给这位朋友的数据、还排着没送出的数据、他的游戏量到的往返时间',
    en: 'What the server sends this friend each second, what is still waiting to go out, and the round trip their game measures',
  },
  'room.kick': { zh: '移出', en: 'Remove' },
  'room.kickLabel': { zh: '把 {name} 移出房间', en: 'Remove {name} from the room' },
  'room.kickConfirm': { zh: '把“{name}”移出房间？', en: 'Remove “{name}” from the room?' },
  'room.cancel': { zh: '取消', en: 'Cancel' },
  'room.diagnostics': { zh: '连接诊断', en: 'Connection diagnostics' },
  'room.copyDiagnostics': { zh: '复制诊断信息', en: 'Copy diagnostics' },
  'room.measuring': { zh: '正在测量…', en: 'Measuring…' },
  'room.diagnosticsHint': {
    zh: '联机出问题时，把这段文字发给开发者（里面没有名字、房间码和地址）。',
    en: 'When playing together goes wrong, send this text to the developers (it holds no names, codes or addresses).',
  },
  'room.back': { zh: '返回', en: 'Back' },

  // ---- join (main menu -> join screen; the loading screen while joining)
  'join.title': { zh: '加入房间', en: 'Join a room' },
  'join.field': { zh: '邀请链接、房间码或邀请码', en: 'Invitation link, room code or invitation code' },
  'join.placeholder': { zh: '粘贴朋友发来的内容', en: 'Paste what your friend sent' },
  'join.go': { zh: '加入', en: 'Join' },
  'join.hint': {
    zh: '收到的是邀请码（以 BL1I. 开头）时，开始加入后会得到一个应答码，把它发回给房主。',
    en: 'With an invitation code (it starts with BL1I.), you get an answer code once joining starts: send it back to the host.',
  },
  'join.as': { zh: '别人看到的你：{name}（可在设置里修改）', en: 'Others will see you as {name} (change it in Settings)' },
  'join.invalid': { zh: '这不是邀请链接、房间码或邀请码', en: 'That is not an invitation link, a room code or an invitation code' },
  'join.back': { zh: '返回', en: 'Back' },
  'join.stepService': { zh: '连接信令服务', en: 'Reaching the signalling service' },
  'join.stepInvitation': { zh: '读取邀请码', en: 'Reading the invitation' },
  'join.stepHost': { zh: '连接房主', en: 'Reaching the host' },
  'join.stepAnswer': { zh: '等房主粘贴你的应答码', en: 'Waiting for the host to paste your answer' },
  'join.stepWorld': { zh: '载入世界', en: 'Loading the world' },
  'join.answerTitle': { zh: '把这个应答码发给房主', en: 'Send this answer code to the host' },
  'join.failedTitle': { zh: '无法加入', en: 'Could not join' },
  'join.endedTitle': { zh: '已离开房间', en: 'Out of the room' },
  'join.retry': { zh: '重试', en: 'Try again' },
  'join.menu': { zh: '回到主菜单', en: 'Back to the menu' },
  'join.giveUp': { zh: '放弃，回到主菜单', en: 'Give up, back to the menu' },

  // ---- name
  'name.title': { zh: '你的名字', en: 'Your name' },
  'name.text': { zh: '一起玩时，朋友会在你头顶看到这个名字。以后可以在设置里修改。', en: 'Friends see this name above your head when you play together. You can change it in Settings.' },
  'name.label': { zh: '名字', en: 'Name' },
  'name.continue': { zh: '继续', en: 'Continue' },
  'name.invalid': { zh: '名字要有 1～24 个字符，不能全是空白', en: 'A name has 1 to 24 characters, not all blank' },

  // ---- the player list over the HUD (held Tab)
  'players.title': { zh: '世界里的玩家', en: 'Players in this world' },
  'players.roomOpen': { zh: '房间开放中', en: 'Room open' },
  'players.roomClosed': { zh: '房间未开放', en: 'Room closed' },

  // ---- controls: key captions
  'key.leftClick': { zh: '左键', en: 'Left click' },
  'key.rightClick': { zh: '右键', en: 'Right click' },
  'key.wheel': { zh: '滚轮', en: 'Wheel' },
  'key.middleClick': { zh: '中键', en: 'Middle click' },
  'key.space': { zh: '空格', en: 'Space' },
  'key.spaceTwice': { zh: '空格 ×2', en: 'Space ×2' },
  'key.shift': { zh: 'Shift', en: 'Shift' },
  'key.again': { zh: '再次', en: 'again' },

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
  'ctl.pick': { zh: '拿起瞄准的方块（生存模式只从背包里取）', en: 'Pick the block you look at (survival: only from your inventory)' },
  'ctl.swapHands': { zh: '交换主手与副手的物品', en: 'Swap the items in your main hand and off-hand' },
  'ctl.inventory': { zh: '物品栏', en: 'Inventory' },
  'ctl.pause': { zh: '暂停', en: 'Pause' },
  'ctl.debug': { zh: '调试信息', en: 'Debug overlay' },
  'ctl.players': { zh: '（按住）世界里的玩家', en: 'Players in this world (hold)' },
  'ctl.view': { zh: '切换视角：第一人称 → 越肩 → 正面', en: 'Camera: first person → over the shoulder → front' },
  'ctl.helmPreview': { zh: '预览将要组装的船', en: 'Preview the ship' },
  'ctl.helmAssemble': { zh: '组装船只并掌舵', en: 'Assemble the ship and take the wheel' },
  'ctl.helmThrottle': { zh: '油门', en: 'Throttle' },
  'ctl.helmRudder': { zh: '转舵', en: 'Rudder' },
  'ctl.helmRelease': { zh: '（掌舵时）松开舵轮', en: 'Let go (while steering)' },
  'ctl.helmDock': { zh: '停靠（空手对舵轮，或掌舵时）：船还原为方块', en: 'Dock (empty hand on the helm, or while steering): ship back to blocks' },
  'ctl.bearingPreview': { zh: '预览转子', en: 'Preview the rotor' },
  'ctl.bearingStart': { zh: '启动转子', en: 'Start the rotor' },
  'ctl.bearingStop': { zh: '（运转中）停止转子', en: 'Stop a running bearing' },
  'ctl.glueApply': { zh: '手持强力胶右键方块露出的面：给这个面涂胶', en: 'Glue in hand, right-click a face: glue that face' },
  'ctl.glueRemove': { zh: '去掉露出的面上的胶', en: 'Remove the glue from a face' },
  'ctl.glueOffhand': { zh: '强力胶放进副手：放出的方块自动粘到点击的面上', en: 'Glue in the off-hand: placed blocks stick to the clicked face' },

  // ---- main-menu cheat-sheet (abridged mechanism lines)
  'cheat.helm': { zh: '舵轮：预览 → 组装并掌舵', en: 'Helm: preview → assemble & steer' },
  'cheat.bearing': { zh: '轴承：预览 → 启动转子', en: 'Bearing: preview → start the rotor' },
  'cheat.glue': { zh: '强力胶：右键给一个面涂胶', en: 'Glue: right-click a face to glue it' },

  // ---- inventory
  'inv.title': { zh: '物品栏', en: 'Inventory' },
  'inv.backpack': { zh: '背包', en: 'Backpack' },
  'inv.hotbar': { zh: '快捷栏', en: 'Hotbar' },
  'inv.offhand': { zh: '副手', en: 'Off-hand' },
  'inv.palette': { zh: '物料库', en: 'Materials' },
  'inv.search': { zh: '搜索物品', en: 'Search items' },
  'inv.searchPlaceholder': { zh: '搜索中文或英文名…', en: 'Search by name…' },
  'inv.noResults': { zh: '没有匹配的物品', en: 'No matching items' },
  'inv.close': { zh: '关闭', en: 'Close' },
  'inv.dropHint': { zh: '在格子以外点击：丢弃手中物品', en: 'Click outside the slots to drop the held stack' },
  'inv.shiftHint': { zh: 'Shift + 点击：直接放进快捷栏', en: 'Shift-click: straight to the hotbar' },
  'inv.slotEmpty': { zh: '空格位', en: 'Empty slot' },
  'inv.slotLabel': { zh: '{name} ×{n}', en: '{name} ×{n}' },

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
  'settings.name': { zh: '玩家名字', en: 'Player name' },
  'settings.nameHint': { zh: '下次进入世界时生效', en: 'Used from the next time you enter a world' },

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
  'hud.offhand': { zh: '副手（F 交换）', en: 'Off-hand (F to swap)' },
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
