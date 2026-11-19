/**
 * Text of the F3 debug overlay. Pure formatting: the game gathers the numbers (from the render
 * backend, the session's replica and prediction, the network client and the server's reports),
 * this turns them into lines. Technical labels are English in every language, like most games'
 * debug screens.
 */
import { DAY_TICKS } from '../core/constants';
import type { Target } from '../net/protocol';
import type { FaultRecord } from './faults';

export interface DebugInfo {
  version: string;
  rendererDetail: string;
  fps: number;
  frameMs: number;
  workMs: number;
  renderMs: number;
  /** Camera look (radians). */
  yaw: number;
  pitch: number;
  drawCalls: number;
  triangles: number;
  sectionsDrawn: number;
  sectionsMeshed: number;
  meshQueued: number;
  meshJobs: number;
  /** The player as predicted (null before it is). */
  player: { x: number; y: number; z: number; flying: boolean; carrierId: number } | null;
  mode: string;
  /** Columns in the replica, and of them still being generated. */
  columns: number;
  generating: number;
  chunksInFlight: number;
  chunksWaiting: number;
  /** Mean main-thread ms to insert and light a generated column. */
  deliverMs: number;
  structures: number;
  ships: number;
  rotors: number;
  entities: number;
  target: Target | null;
  /** Time of day 0..1 as shown, and the server tick of the newest batch. */
  dayTime: number;
  serverTick: number;
  /** The connection (NetClient status), round trip, interpolation delay D and rotor lead (ticks). */
  netStatus: string;
  rttMs: number | null;
  delayTicks: number | null;
  rotorLead: number | null;
  /** Bytes per second received and sent. */
  inBytesPerSec: number;
  outBytesPerSec: number;
  /** How the server runs, its measured TPS (the batches' globals) and the time its ticks take. */
  server: string;
  serverTps: number | null;
  serverTickMs: number | null;
  serverTickMaxMs: number | null;
  storage: string;
  workers: string;
  faults: readonly FaultRecord[];
}

const FACINGS = ['north', 'west', 'south', 'east'] as const;

/** Compass name of a yaw (yaw 0 looks north, growing turns left). */
export function facingName(yaw: number): string {
  const deg = ((((yaw * 180) / Math.PI) % 360) + 360) % 360;
  return FACINGS[Math.round(deg / 90) % 4]!;
}

/** "hh:mm" clock of a world tick (tick 0 = sunrise = 06:00). */
export function worldClock(time: number): string {
  const day = (((time % DAY_TICKS) + DAY_TICKS) % DAY_TICKS) / DAY_TICKS;
  const minutes = Math.floor(day * 24 * 60 + 6 * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function kb(bytesPerSec: number): string {
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

export function debugLines(d: DebugInfo): string[] {
  const deg = (r: number): string => ((r * 180) / Math.PI).toFixed(1);
  const p = d.player;
  const t = d.target;
  const lines = [
    `Blocklands ${d.version} · ${d.rendererDetail}`,
    `${d.fps.toFixed(0)} fps · frame ${d.frameMs.toFixed(1)} ms · work ${d.workMs.toFixed(1)} ms · render ${d.renderMs.toFixed(1)} ms`,
    p ? `xyz ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)} · chunk ${Math.floor(p.x) >> 4}, ${Math.floor(p.z) >> 4}` : 'xyz —',
    `facing ${facingName(d.yaw)} (yaw ${deg(d.yaw)}°, pitch ${deg(d.pitch)}°)${p?.flying ? ' · flying' : ''}${p?.carrierId ? ` · on #${p.carrierId}` : ''}`,
    `columns ${d.columns} (${d.generating} generating) · gen ${d.chunksInFlight} in flight, ${d.chunksWaiting} waiting · insert ${d.deliverMs.toFixed(1)} ms`,
    `sections ${d.sectionsMeshed} meshed · ${d.meshQueued} queued · ${d.meshJobs} jobs · ${d.sectionsDrawn} drawn`,
    `structures ${d.structures} (${d.ships} ships, ${d.rotors} rotors) · entities ${d.entities}`,
    `draw calls ${d.drawCalls} · triangles ${(d.triangles / 1000).toFixed(0)}k`,
    t ? `target ${t.gridId === 0 ? 'world' : `#${t.gridId}`} ${t.x} ${t.y} ${t.z} face ${t.face}` : 'target —',
    `time ${worldClock(Math.round(d.dayTime * DAY_TICKS))} (server tick ${d.serverTick}) · ${d.mode}`,
    `net ${d.netStatus} · rtt ${d.rttMs === null ? '—' : `${d.rttMs.toFixed(0)} ms`} · delay ${d.delayTicks === null ? '—' : `${d.delayTicks.toFixed(2)} ticks`} · lead ${d.rotorLead === null ? '—' : d.rotorLead.toFixed(2)} · in ${kb(d.inBytesPerSec)} · out ${kb(d.outBytesPerSec)}`,
    `server ${d.server} · ${d.serverTps === null ? '—' : d.serverTps.toFixed(1)} TPS · tick ${d.serverTickMs === null ? '—' : `${d.serverTickMs.toFixed(2)} ms (max ${(d.serverTickMaxMs ?? 0).toFixed(1)})`}`,
    `storage ${d.storage} · workers ${d.workers}`,
  ];
  for (const f of d.faults) lines.push(`! ${f.what}: ${f.message}${f.count > 1 ? ` ×${f.count}` : ''}`);
  return lines;
}
