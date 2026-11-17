/**
 * Text of the F3 debug overlay. Pure formatting: the game gathers the numbers, this turns
 * them (and a few simulation facts) into lines. Technical labels are English in every
 * language, like most games' debug screens.
 */
import { DAY_TICKS } from '../core/constants';
import type { Simulation } from '../sim/simulation';
import type { FaultRecord } from './faults';

export interface DebugInfo {
  version: string;
  rendererDetail: string;
  fps: number;
  frameMs: number;
  tickMs: number;
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
  chunksInFlight: number;
  chunksWaiting: number;
  provideMs: number;
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

export function debugLines(sim: Simulation, d: DebugInfo): string[] {
  const p = sim.player;
  const deg = (r: number): string => ((r * 180) / Math.PI).toFixed(1);
  const t = sim.view.target;
  const structures = sim.structures;
  const lines = [
    `Blocklands ${d.version} · ${d.rendererDetail}`,
    `${d.fps.toFixed(0)} fps · frame ${d.frameMs.toFixed(1)} ms · tick ${d.tickMs.toFixed(2)} ms · work ${d.workMs.toFixed(1)} ms · render ${d.renderMs.toFixed(1)} ms`,
    `xyz ${p.pos.x.toFixed(2)} / ${p.pos.y.toFixed(2)} / ${p.pos.z.toFixed(2)} · chunk ${Math.floor(p.pos.x) >> 4}, ${Math.floor(p.pos.z) >> 4}`,
    `facing ${facingName(d.yaw)} (yaw ${deg(d.yaw)}°, pitch ${deg(d.pitch)}°)${p.flying ? ' · flying' : ''}${p.carrierId ? ` · on #${p.carrierId}` : ''}`,
    `chunks ${sim.world.chunks.size} · gen ${d.chunksInFlight} in flight, ${d.chunksWaiting} waiting · provide ${d.provideMs.toFixed(1)} ms`,
    `sections ${d.sectionsMeshed} meshed · ${d.meshQueued} queued · ${d.meshJobs} jobs · ${d.sectionsDrawn} drawn`,
    `structures ${structures.all().length} (${structures.ships().length} ships, ${structures.rotors().length} rotors) · entities ${sim.entities.all().length}`,
    `draw calls ${d.drawCalls} · triangles ${(d.triangles / 1000).toFixed(0)}k`,
    t ? `target ${t.gridId === 0 ? 'world' : `#${t.gridId}`} ${t.x} ${t.y} ${t.z} face ${t.face}` : 'target —',
    `time ${worldClock(Math.round(sim.dayTime * DAY_TICKS))} (tick ${sim.world.time}) · ${sim.mode}`,
    `storage ${d.storage} · workers ${d.workers}`,
  ];
  for (const f of d.faults) lines.push(`! ${f.what}: ${f.message}${f.count > 1 ? ` ×${f.count}` : ''}`);
  return lines;
}
