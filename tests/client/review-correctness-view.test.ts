/**
 * Adversarial review (correctness lens) of the client's view / overlay / debug code against a
 * real headless Simulation. Each test names the defect it demonstrates.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { facingState, makeCell } from '../../src/blocks/cell';
import { DAY_TICKS } from '../../src/core/constants';
import { NZ } from '../../src/core/dirs';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { ViewBuilder } from '../../src/client/view';
import { debugLines, worldClock, type DebugInfo } from '../../src/client/debug';
import { soloSim } from '../solo';

function flatSim(radius = 2): Simulation {
  return soloSim({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, loadRadius: radius, rabbits: false });
}

const dbg: DebugInfo = {
  version: 't',
  rendererDetail: 'x',
  fps: 0,
  frameMs: 0,
  tickMs: 0,
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
  chunksInFlight: 0,
  chunksWaiting: 0,
  provideMs: 0,
  storage: '',
  workers: '',
  faults: [],
};

describe('review: time of day', () => {
  it('EnvironmentState.dayTime follows sim.dayTime (world.time + dayOffset), not world.time alone', () => {
    const sim = flatSim(1);
    sim.tick();
    // The simulation's official way to change the time of day (and what a save with a
    // non-zero dayOffset restores): the world clock itself does not move.
    sim.setDayTime(0.75);
    expect(sim.dayTime).toBeCloseTo(0.75, 3);
    const v = new ViewBuilder();
    v.updateCamera(sim, sim.soloPlayer, 1, 0, 0, 70, 1 / 60);
    const env = v.updateEnvironment(sim, 1, 0, 4);
    // Midnight in the simulation (rabbits, isDay) must be midnight on screen.
    expect(env.dayTime).toBeCloseTo(sim.dayTime, 2);
  });

  it('the F3 clock shows the simulation time of day', () => {
    const sim = flatSim(1);
    sim.tick();
    sim.setDayTime(0.25); // noon
    const lines = debugLines(sim, sim.soloPlayer, dbg);
    const timeLine = lines.find((l) => l.startsWith('time '))!;
    expect(timeLine).toContain(worldClock(Math.round(0.25 * DAY_TICKS))); // "12:00"
  });
});

describe('review: assembly preview overlay caching', () => {
  it('does not rebuild the preview cell list every tick while the preview is unchanged', () => {
    const sim = flatSim(2);
    sim.tick();
    const y = 35;
    for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) sim.world.setCell(x, y, z, makeCell(B.PLANKS_OAK));
    sim.world.setCell(4, y + 1, 4, makeCell(B.HELM, facingState(NZ)));
    sim.soloPlayer.teleport(4.5, y + 1, 7.5);
    sim.tick();
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.useOn(4, y + 1, 4)).toBe(true); // first right-click: preview
    expect(sim.soloPlayer.view.preview).not.toBeNull();
    const cells = sim.soloPlayer.view.preview!.cells;
    const v = new ViewBuilder();
    const first = v.updateOverlays(sim, sim.soloPlayer, 0).preview;
    expect(first.length).toBeGreaterThan(20);
    sim.tick(); // nothing changed in the world: same preview, same cells array
    expect(sim.soloPlayer.view.preview).not.toBeNull();
    expect(sim.soloPlayer.view.preview!.cells).toBe(cells);
    const second = v.updateOverlays(sim, sim.soloPlayer, 50).preview;
    // The client claims (and its own test asserts with a hand-made view) that the list is
    // cached; with the real simulation, which publishes a fresh `preview` wrapper every tick,
    // it allocates a new OverlayCell per cell every tick (up to 4000 for a ship).
    expect(second).toBe(first);
  });
});
