/**
 * Text the client itself shows (loading steps, storage / save notices, fault toasts). The
 * simulation's own messages go through src/sim/messages.ts, the UI chrome through src/ui.
 */
import type { Language } from '../ui/model';

const STRINGS = {
  'loading.graphics': { zh: '正在启动图形…', en: 'Starting graphics…' },
  'loading.reading': { zh: '正在读取存档…', en: 'Reading the save…' },
  'loading.preparing': { zh: '正在准备世界…', en: 'Preparing the world…' },
  'loading.terrain': { zh: '正在生成地形 {done}/{total}', en: 'Generating terrain {done}/{total}' },
  'loading.meshing': { zh: '正在构建地形网格 {done}/{total}', en: 'Building terrain meshes {done}/{total}' },
  'loading.finishing': { zh: '即将就绪…', en: 'Almost there…' },
  'storage.memory': {
    zh: '无法使用浏览器存储：本次游戏进度不会被保存',
    en: 'Browser storage is unavailable — progress will not be saved',
  },
  'storage.newer': {
    zh: '存档数据库来自更新版本的游戏：请刷新页面以更新，本次进度不会被保存',
    en: 'The save database belongs to a newer version — reload to update; progress will not be saved',
  },
  'storage.blocked': {
    zh: '另一个打开的方块大陆标签页阻止了存档升级：请关闭它后刷新，本次进度不会被保存',
    en: 'Another open Blocklands tab blocks the save upgrade — close it and reload; progress will not be saved',
  },
  'save.failed': { zh: '保存失败：{msg}', en: 'Saving failed: {msg}' },
  'save.quota': { zh: '浏览器存储空间已满，无法保存', en: 'Browser storage is full — cannot save' },
  'save.newerWorld': {
    zh: '这个世界已被更新版本的游戏保存过，为保护存档不再写入',
    en: 'This world was saved by a newer version; it will not be overwritten',
  },
  'load.failed': { zh: '无法载入世界：{msg}', en: 'Could not load the world: {msg}' },
  'load.missing': { zh: '找不到这个世界的存档', en: 'This world’s save could not be found' },
  'load.newer': {
    zh: '这个世界由更新版本的游戏保存，请刷新页面更新后再载入',
    en: 'This world was saved by a newer version — reload the page to update first',
  },
  'delete.failed': { zh: '删除失败：{msg}', en: 'Could not delete the world: {msg}' },
  'graphics.failed': { zh: '无法启动图形：{msg}', en: 'Could not start graphics: {msg}' },
  'graphics.notReady': { zh: '图形尚未就绪，请稍候', en: 'Graphics are not ready yet' },
  'fault': { zh: '{what} 出错（已跳过，游戏继续）：{msg}', en: '{what} failed (skipped, the game goes on): {msg}' },
} as const;

export type ClientStringKey = keyof typeof STRINGS;

/** Localised client text with `{name}` placeholders filled from `params`. */
export function clientText(lang: Language, key: ClientStringKey, params?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  const template: string = lang === 'en' ? entry.en : entry.zh;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
