/**
 * Text the client itself shows (loading steps, storage / save notices, the connection and the
 * game server, fault toasts). The simulation's own messages go through src/sim/messages.ts, the
 * UI chrome through src/ui.
 */
import type { Language } from '../ui/model';

const STRINGS = {
  'loading.graphics': { zh: '正在启动图形…', en: 'Starting graphics…' },
  'loading.reading': { zh: '正在读取存档…', en: 'Reading the save…' },
  'loading.preparing': { zh: '正在准备世界…', en: 'Preparing the world…' },
  'loading.server': { zh: '正在启动游戏服务器…', en: 'Starting the game server…' },
  'loading.connecting': { zh: '正在连接…', en: 'Connecting…' },
  'loading.reconnecting': { zh: '连接中断，正在重连…', en: 'Connection lost, reconnecting…' },
  'loading.terrain': { zh: '正在生成地形 {done}/{total}', en: 'Generating terrain {done}/{total}' },
  'loading.meshing': { zh: '正在构建地形网格 {done}/{total}', en: 'Building terrain meshes {done}/{total}' },
  'loading.finishing': { zh: '即将就绪…', en: 'Almost there…' },
  'loading.saving': { zh: '正在保存世界…', en: 'Saving the world…' },
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
  'save.quitFailed': {
    zh: '世界没能保存，已保持打开：可以稍后重试，或选择“不保存退出”',
    en: 'The world could not be saved, so it stays open — try again, or choose “Quit without saving”',
  },
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
  'load.older': {
    zh: '这个世界由旧版本的游戏保存，当前版本已无法读取。可以在列表里删除它',
    en: 'This world was saved by an older version of the game and can no longer be opened. You can delete it from the list',
  },
  'net.hostStalled': {
    zh: '房主的服务器运行受限（页面可能在后台）',
    en: 'The host’s server is being slowed down (its page may be in the background)',
  },
  'net.linkUnstable': { zh: '连接不稳定', en: 'The connection is unstable' },
  'net.kicked': { zh: '服务器断开了连接（{reason}）', en: 'The server ended the connection ({reason})' },
  'net.refused': { zh: '服务器拒绝了连接（{reason}）', en: 'The server refused the connection ({reason})' },
  'net.failed': { zh: '连接出错：{msg}', en: 'The connection failed: {msg}' },
  'room.offline': {
    zh: '这个版本不能联机（单文件版没有网络）：请打开在线版',
    en: 'This build cannot go online (the single-file version has no network) — open the online version',
  },
  'room.noWorld': { zh: '先打开一个自己的世界，才能开放房间', en: 'Open a world of your own first to open a room' },
  'room.open': { zh: '房间已开放，房间码：{code}', en: 'The room is open — room code: {code}' },
  'room.openManual': { zh: '房间已开放：为每位朋友生成一个邀请码', en: 'The room is open — make an invitation code for each friend' },
  'room.closed': { zh: '房间已关闭（已在房间里的朋友不受影响）', en: 'The room is closed (friends already in stay)' },
  'room.lost': {
    zh: '与信令服务的连接断开：新朋友暂时无法加入，正在重试',
    en: 'Lost the signalling service — new friends cannot join until it is back (retrying)',
  },
  'room.back': { zh: '信令服务已恢复，朋友可以加入了', en: 'The signalling service is back — friends can join again' },
  'room.failed': { zh: '无法开放房间：{msg}', en: 'Could not open the room: {msg}' },
  'join.connecting': { zh: '正在连接房间…', en: 'Connecting to the room…' },
  'join.detailCloud': { zh: '正在连接公共信令服务（0.peerjs.com）…', en: 'Reaching the public signalling service (0.peerjs.com)…' },
  'join.detailBroadcast': { zh: '正在这个浏览器里寻找房间…', en: 'Looking for the room in this browser…' },
  'join.detailManual': { zh: '正在读取邀请码…', en: 'Reading the invitation code…' },
  'join.detailHost': { zh: '正在和房主建立直连（最多约 15 秒）…', en: 'Making a direct connection to the host (up to about 15 s)…' },
  'join.detailAnswer': {
    zh: '房主粘贴你的应答码后就会连上（最多等 15 分钟）',
    en: 'You connect once the host pastes your answer code (waiting up to 15 minutes)',
  },
  'players.joined': { zh: '{name} 加入了世界', en: '{name} joined the world' },
  'players.left': { zh: '{name} 离开了世界', en: '{name} left the world' },
  'join.unreachable': {
    zh: '连不上信令服务（可能被网络屏蔽）：稍后再试，或改用手动邀请码',
    en: 'Could not reach the signalling service (it may be blocked) — try again later, or use a manual invitation code',
  },
  'join.unknown': { zh: '没有找到这个房间：请检查房间码；房主可能还没开放房间，或者已经关闭了它', en: 'No room has this code — check it; the host may not have opened the room yet, or has closed it' },
  'join.taken': { zh: '这个房间码已被占用，请换一个', en: 'This room code is already in use — pick another' },
  'join.invitationUsed': { zh: '这个邀请码已经用过了：请房主重新生成一个', en: 'This invitation has been used — ask the host for a new one' },
  'join.badCode': { zh: '这个码无效：请完整地重新复制', en: 'This code is not valid — copy it again in full' },
  'join.noAnswer': { zh: '房主在连接过程中没有回应', en: 'The host stopped answering while connecting' },
  'join.left': { zh: '房主在连接过程中离开了', en: 'The host left while connecting' },
  'join.ice': {
    zh: '无法与房主直连：你或房主的网络阻止了点对点连接（暂时没有中继服务器）',
    en: 'No direct connection to the host could be made — your network or theirs blocks peer-to-peer connections (there is no relay server yet)',
  },
  'join.gone': { zh: '与房主的连接断开，房间已不存在（房主可能离开了）', en: 'Lost the connection to the host, and the room is gone (the host may have left)' },
  'join.lost': { zh: '与房主的连接断开，重连失败', en: 'Lost the connection to the host and could not reconnect' },
  'join.dropped': { zh: '房主的游戏没让你进入就断开了连接', en: "The host's game closed the connection before letting you in" },
  'join.noWelcome': { zh: '房主的游戏一直没有回应（它可能已经停住）', en: "The host's game never answered (it may have stopped)" },
  'refuse.build': {
    zh: '房主的游戏版本和你的不同：请双方都刷新页面',
    en: 'The host runs a different version of the game — both of you, reload the page',
  },
  'refuse.badHello': { zh: '房主拒绝了连接', en: 'The host refused the connection' },
  'refuse.full': { zh: '房间已满（最多 4 人）', en: 'The room is full (4 players at most)' },
  'refuse.closed': { zh: '房间已关闭', en: 'The room is closed' },
  'refuse.shuttingDown': { zh: '房主正在关闭世界', en: 'The host is closing the world' },
  'refuse.sameKey': { zh: '你已经在这个世界里了（另一个标签页）', en: 'You are already in this world (in another tab)' },
  'kick.shutdown': { zh: '房主关闭了世界', en: 'The host closed the world' },
  'kick.replaced': { zh: '你在另一个标签页加入了这个世界', en: 'You joined this world from another tab' },
  'kick.kicked': { zh: '房主把你移出了房间', en: 'The host removed you from the room' },
  'kick.tooSlow': { zh: '你的网络太慢，跟不上房主', en: 'Your connection was too slow for the host' },
  'kick.protocolError': { zh: '连接出错（协议错误）', en: 'The connection broke (protocol error)' },
  'kick.timeout': { zh: '房主太久没有收到你的消息', en: 'The host heard nothing from you for too long' },
  'server.failed': { zh: '无法启动游戏服务器：{msg}', en: 'Could not start the game server: {msg}' },
  'server.crashed': { zh: '游戏服务器停止了运行', en: 'The game server stopped' },
  'server.stopped': { zh: '世界的模拟出错，已经停住：{msg}', en: 'The world stopped after an error: {msg}' },
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
