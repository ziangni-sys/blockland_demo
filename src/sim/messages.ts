/**
 * Localised text for messages the simulation emits (hints under the crosshair, toasts).
 * The simulation only ever produces a Message { key, params }; the client renders it with
 * formatMessage(). Every key exists in both languages: the English table defines the key set
 * (MessageKey) and the Chinese table is typed against it, so a missing or extra key is a
 * compile error; tests/sim/messages.test.ts checks the same at runtime and also scans the
 * simulation sources for emitted keys.
 *
 * Placeholders are `{name}`, filled from Message.params.
 */
import type { Message } from './view';

export type Lang = 'zh' | 'en';

const EN = {
  'generic.unknown': '{key}',

  // ---- hints: helm
  'hint.helm.preview': 'Right-click to preview the ship',
  'hint.helm.assemble': 'Right-click again to assemble ({count} blocks)',
  'hint.helm.steer': 'Right-click to steer · Sneak + right-click to dock',
  'hint.helm.steerPlace': 'Right-click to steer · To dock, sneak + right-click with an empty hand',
  'hint.steering': 'W/S throttle · A/D rudder · Right-click to let go · Sneak + right-click to dock',
  // ---- hints: bearing
  'hint.bearing.preview': 'Right-click to preview the rotor',
  'hint.bearing.start': 'Right-click again to start ({count} blocks, {sails} sails)',
  'hint.bearing.stop': 'Right-click to stop the rotor',
  'hint.rotor.spinning': 'A spinning rotor cannot be edited',
  // ---- hints: glue
  'hint.glue.first': 'Right-click a block to start gluing',
  'hint.glue.apply': 'Right-click to glue this face',
  'hint.glue.remove': 'Right-click to remove the glue on this face',
  'hint.glue.already': 'Already glued · Sneak + right-click to remove',
  'hint.glue.notGlued': 'This face has no glue',
  'hint.glue.move': 'Right-click to pick this block instead',
  'hint.glue.working': 'Gluing… keep holding right-click',
  'hint.glue.unglueWorking': 'Removing glue… keep holding right-click',
  'hint.glue.cannot': 'Glue does not hold on this block',
  // ---- hints: misc
  'hint.tnt.ignite': 'Right-click to light the fuse',
  'hint.bucket.structure': 'Buckets cannot be used on structures',
  'hint.unbreakable': 'This block cannot be mined',

  // ---- toasts: structures
  'toast.ship.assembled': 'Ship assembled: {count} blocks',
  'toast.rotor.started': 'Rotor started: {count} blocks, {sails} sails',
  'toast.rotor.stopped': 'Rotor stopped',
  'toast.dock.done': 'Docked: {count} blocks back in the world',
  'toast.dock.tilted': 'The ship leans too far to dock',
  'toast.dock.blocked': 'Docking blocked by {count} blocks (marked red)',
  'toast.helm.taken': 'Someone else is at the wheel',
  // ---- toasts: placement
  'toast.place.support': 'This needs a supporting block below',
  'toast.place.occupied': 'Something is in the way',
  'toast.place.spinning': 'A spinning rotor cannot be edited',
  // ---- toasts: glue
  'toast.glue.none': 'You need superglue',
  'toast.glue.added': 'Glued',
  'toast.glue.removed': 'Glue removed',
  'toast.glue.already': 'This face is already glued',
  'toast.glue.notGlued': 'This face has no glue',
  'toast.glue.cannot': 'Glue does not hold on this block',
  'toast.glue.spinning': 'A spinning rotor cannot be glued',
  // ---- toasts: buckets
  'toast.bucket.structure': 'Buckets cannot be used on structures',

  // ---- assembly failures (fail.<kind>.<reason>)
  'fail.ship.not_a_helm': 'That is not a helm',
  'fail.ship.too_big': 'Too big: a ship can have at most {max} blocks',
  'fail.ship.unloaded': 'Part of the ship is in an area that is not loaded yet',
  'fail.ship.other': 'The ship cannot be assembled ({reason})',
  'fail.rotor.not_a_bearing': 'That is not a bearing',
  'fail.rotor.no_hub': 'Nothing that can turn in front of the bearing',
  'fail.rotor.too_big': 'Too big: a rotor can have at most {max} blocks',
  'fail.rotor.not_enough_sails': 'Not enough sails: {sails} of {min} felt or canvas blocks',
  'fail.rotor.unloaded': 'Part of the rotor is in an area that is not loaded yet',
  'fail.rotor.has_rotor': 'A rotor already turns on this bearing',
  'fail.rotor.nested_rotor': 'A rotor cannot carry another rotor',
  'fail.rotor.not_world': 'Rotors can only be built in the world or on a ship',
  'fail.rotor.other': 'The rotor cannot be started ({reason})',
} as const;

export type MessageKey = keyof typeof EN;

const ZH: Record<MessageKey, string> = {
  'generic.unknown': '{key}',

  'hint.helm.preview': '右键预览要组装的船',
  'hint.helm.assemble': '再次右键确认组装（{count} 格）',
  'hint.helm.steer': '右键掌舵 · 潜行右键停靠',
  'hint.helm.steerPlace': '右键掌舵 · 空手潜行右键停靠',
  'hint.steering': 'W/S 油门 · A/D 转向 · 右键松开舵 · 潜行右键停靠',
  'hint.bearing.preview': '右键预览转子',
  'hint.bearing.start': '再次右键启动（{count} 格，{sails} 块帆）',
  'hint.bearing.stop': '右键停止转子',
  'hint.rotor.spinning': '转动中的转子不能编辑',
  'hint.glue.first': '右键选择要粘的第一个方块',
  'hint.glue.apply': '右键粘合这个面',
  'hint.glue.remove': '右键拆掉这个面的胶',
  'hint.glue.already': '这个面已经粘好了 · 潜行右键拆胶',
  'hint.glue.notGlued': '这个面没有胶',
  'hint.glue.move': '右键改选这个方块',
  'hint.glue.working': '涂胶中……按住右键',
  'hint.glue.unglueWorking': '拆胶中……按住右键',
  'hint.glue.cannot': '这个方块不能涂胶',
  'hint.tnt.ignite': '右键点燃引信',
  'hint.bucket.structure': '桶不能用在结构体上',
  'hint.unbreakable': '这个方块挖不动',

  'toast.ship.assembled': '船已组装：{count} 格',
  'toast.rotor.started': '转子已启动：{count} 格，{sails} 块帆',
  'toast.rotor.stopped': '转子已停止',
  'toast.dock.done': '已停靠：{count} 格回到世界',
  'toast.dock.tilted': '船倾斜太大，无法停靠',
  'toast.dock.blocked': '停靠位置被 {count} 个方块挡住（已标红）',
  'toast.helm.taken': '有人正在掌舵',
  'toast.place.support': '下方需要有支撑的方块',
  'toast.place.occupied': '有东西挡着',
  'toast.place.spinning': '转动中的转子不能编辑',
  'toast.glue.none': '需要强力胶',
  'toast.glue.added': '已粘合',
  'toast.glue.removed': '已拆胶',
  'toast.glue.already': '这个面已经粘好了',
  'toast.glue.notGlued': '这个面没有胶',
  'toast.glue.cannot': '这个方块不能涂胶',
  'toast.glue.spinning': '转动中的转子不能涂胶',
  'toast.bucket.structure': '桶不能用在结构体上',

  'fail.ship.not_a_helm': '这不是舵轮',
  'fail.ship.too_big': '太大了：船最多 {max} 格',
  'fail.ship.unloaded': '船有一部分在还没加载的区域',
  'fail.ship.other': '无法组装船（{reason}）',
  'fail.rotor.not_a_bearing': '这不是轴承',
  'fail.rotor.no_hub': '轴承正前方没有能转动的方块',
  'fail.rotor.too_big': '太大了：转子最多 {max} 格',
  'fail.rotor.not_enough_sails': '帆不够：{sails} / {min} 块绒布或帆布',
  'fail.rotor.unloaded': '转子有一部分在还没加载的区域',
  'fail.rotor.has_rotor': '这个轴承上已经有转子在转',
  'fail.rotor.nested_rotor': '转子上不能再装转子',
  'fail.rotor.not_world': '转子只能装在世界或船上',
  'fail.rotor.other': '无法启动转子（{reason}）',
};

export const MESSAGES: Record<Lang, Record<string, string>> = { zh: ZH, en: EN };

/** Every key of the message table (the English one defines the set). */
export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(EN) as MessageKey[];

/** Build a Message with a key that is known to exist (checked at compile time). */
export function msg(key: MessageKey, params?: Record<string, number | string>): Message {
  return params === undefined ? { key } : { key, params };
}

/** True when `key` names a message of the table. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(EN, key);
}

/**
 * Message for a refused assembly: `fail.<kind>.<reason>` when the table has it, else the
 * kind's generic 'other' message carrying the raw reason (a reason added to the structures
 * module later still produces readable text instead of a bare key).
 */
export function failMessage(kind: 'ship' | 'rotor', reason: string, params: Record<string, number | string> = {}): Message {
  const key = `fail.${kind}.${reason}`;
  if (isMessageKey(key)) return { key, params };
  return { key: kind === 'ship' ? 'fail.ship.other' : 'fail.rotor.other', params: { ...params, reason } };
}

/** Render a message in a language; unknown keys render as the key itself. `{name}` placeholders are filled from params. */
export function formatMessage(lang: Lang, message: Message): string {
  const template = MESSAGES[lang][message.key] ?? MESSAGES.en[message.key] ?? message.key;
  const params = message.params;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
