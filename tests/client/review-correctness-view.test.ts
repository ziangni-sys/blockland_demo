/**
 * Adversarial review (correctness lens) of what the client shows, against a real server
 * (rig.ts). Each test names the defect it guards against.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { facingState, makeCell } from '../../src/blocks/cell';
import { DAY_TICKS } from '../../src/core/constants';
import { NZ } from '../../src/core/dirs';
import { debugLines, worldClock, type DebugInfo } from '../../src/client/debug';
import { FLAT_TOP, SessionRig } from './rig';

const dbg: DebugInfo = {
  version: 't',
  rendererDetail: 'x',
  fps: 0,
  frameMs: 0,
  workMs: 0,
  renderMs: 0,
  yaw: 0,
  pitch: 0,
  drawCalls: 0,
  triangles: 0,
  sectionsDrawn: 0,
  sectionsMeshed: 0,
  meshQueued: 0,
  meshJobs: 0,
  player: null,
  mode: 'creative',
  columns: 0,
  generating: 0,
  chunksInFlight: 0,
  chunksWaiting: 0,
  deliverMs: 0,
  structures: 0,
  ships: 0,
  rotors: 0,
  entities: 0,
  target: null,
  dayTime: 0,
  serverTick: 0,
  netStatus: 'ready',
  rttMs: null,
  delayTicks: null,
  rotorLead: null,
  inBytesPerSec: 0,
  outBytesPerSec: 0,
  server: 'worker',
  serverTps: null,
  serverTickMs: null,
  serverTickMaxMs: null,
  storage: '',
  workers: '',
  faults: [],
};

describe('review: time of day', () => {
  it('EnvironmentState.dayTime follows the server\'s time of day (world time + day offset), set by the host command', async () => {
    const rig = await SessionRig.create();
    rig.playUntilReady();
    // The time of day changes through a host command (section 10): the server moves its day
    // offset, never the world clock, and the client shows what the server says.
    const clock = rig.sim.world.time;
    expect(rig.session.hostCommand({ kind: 'setDayTime', t: 0.75 })).toBe(true);
    rig.waitAck();
    rig.run(200);
    expect(rig.sim.dayTime).toBeCloseTo(0.75, 1);
    expect(rig.sim.world.time - clock).toBeGreaterThan(0); // the clock went on, it was not set
    const env = rig.backend.env!;
    // Midnight on the server (rabbits, isDay) is midnight on screen (within the display delay).
    expect(Math.abs(env.dayTime - rig.sim.dayTime)).toBeLessThan((rig.session.net.clock!.D + 2) / DAY_TICKS);
  });

  it('the F3 clock shows the time of day it is given', () => {
    const lines = debugLines({ ...dbg, dayTime: 0.25, serverTick: 1234 }); // noon
    const timeLine = lines.find((l) => l.startsWith('time '))!;
    expect(timeLine).toContain(worldClock(Math.round(0.25 * DAY_TICKS))); // "12:00"
    expect(timeLine).toContain('server tick 1234');
  });

  it('the F3 overlay has the network lines: round trip, interpolation delay, server TPS, bytes per second', () => {
    const lines = debugLines({ ...dbg, rttMs: 12.4, delayTicks: 1.42, rotorLead: 2.5, serverTps: 19.5, serverTickMs: 0.83, serverTickMaxMs: 3.2, inBytesPerSec: 2048, outBytesPerSec: 1536 });
    const net = lines.find((l) => l.startsWith('net '))!;
    expect(net).toContain('rtt 12 ms');
    expect(net).toContain('delay 1.42 ticks');
    expect(net).toContain('in 2.0 KB/s');
    expect(net).toContain('out 1.5 KB/s');
    const server = lines.find((l) => l.startsWith('server '))!;
    expect(server).toContain('19.5 TPS');
    expect(server).toContain('tick 0.83 ms');
  });
});

describe('review: assembly preview overlay caching', () => {
  it('does not rebuild the preview cell list every frame while the preview is unchanged', async () => {
    const y = FLAT_TOP;
    const rig = await SessionRig.create({
      setup: (sim) => {
        for (let x = 1; x <= 5; x++) for (let z = -5; z <= -1; z++) sim.world.setCell(x, y, z, makeCell(B.PLANKS_OAK));
        sim.world.setCell(3, y + 1, -3, makeCell(B.HELM, facingState(NZ)));
      },
    });
    rig.playUntilReady();
    rig.lookAt(3.5, y + 1.5, -2.5);
    rig.run(100);
    expect(rig.session.intents!.useTarget).toMatchObject({ gridId: 0, x: 3, y: y + 1, z: -3 });
    rig.session.pressUse(false); // first right-click: preview
    rig.session.releaseUse();
    rig.waitAck();
    rig.run(100);
    const view = rig.session.replica!.state.private.view;
    expect(view.preview).not.toBeNull();
    const preview = view.preview;
    const first = rig.backend.overlays!.preview;
    expect(first.length).toBeGreaterThan(20);
    rig.run(500); // nothing changed in the world: the server sends no new preview
    expect(view.preview).toBe(preview);
    // The cached list is kept (a ship's preview is up to 4000 cells: no new OverlayCell per cell per frame).
    expect(rig.backend.overlays!.preview).toBe(first);
  });
});
