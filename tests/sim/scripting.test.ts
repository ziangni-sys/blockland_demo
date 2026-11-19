import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { isCellFace } from '../../src/blocks/shapes';
import { NZ, PY, PZ } from '../../src/core/dirs';
import { FLAT_TOP, flatSim, idAt } from './helpers';

const T = FLAT_TOP;

describe('scripted control', () => {
  it('lookAt / lookAtCell drive the same look the client would (input yaw / pitch)', () => {
    const sim = flatSim();
    const p = sim.soloPlayer.player;
    sim.soloPlayer.lookAt(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z - 10); // straight north
    expect(p.input.yaw).toBeCloseTo(0, 12);
    expect(p.input.pitch).toBeCloseTo(0, 12);
    sim.soloPlayer.lookAt(p.pos.x + 10, p.pos.y + p.eyeHeight, p.pos.z); // east: yaw grows turning left
    expect(p.input.yaw).toBeCloseTo(-Math.PI / 2, 12);
    sim.world.setCell(0, T, -2, makeCell(B.STONE));
    sim.soloPlayer.lookAtCell(0, T, -2, PY);
    sim.tick();
    expect(sim.soloPlayer.view.target).toEqual({ gridId: 0, x: 0, y: T, z: -2, face: PY });
    expect(sim.soloPlayer.targetCell()).toEqual({ gridId: 0, x: 0, y: T, z: -2, face: PY, octant: expect.any(Number) });
    expect(isCellFace(sim.soloPlayer.targetCell()!.octant, PY), 'the octant hit lies behind the face entered').toBe(true);
  });

  it('useOn places only when the aimed cell is really the one hit; mine holds until it breaks', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, T, -2, makeCell(B.STONE));
    sim.world.setCell(0, T + 1, -1, makeCell(B.GLASS)); // in front of the stone's top
    sim.soloPlayer.hold(B.PLANKS_OAK, 8);
    expect(sim.soloPlayer.useOn(0, T, -2, PY)).toBe(false); // hidden behind the glass
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.AIR);
    sim.world.setCell(0, T + 1, -1, 0);
    expect(sim.soloPlayer.useOn(0, T, -2, PY)).toBe(true);
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.PLANKS_OAK);
    const t0 = sim.world.time;
    expect(sim.soloPlayer.mine(0, T + 1, -2, PZ)).toBe(true);
    expect(sim.world.time - t0).toBe(30); // planks: 1.5 s
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.AIR);
    expect(sim.soloPlayer.player.input.attack).toBe(false);
    sim.world.setCell(0, T + 1, -2, makeCell(B.DEEPROCK));
    expect(sim.soloPlayer.mine(0, T + 1, -2, PZ, 0, 50)).toBe(false);
  });

  it('teleport lets go of everything; hold selects or fills a hotbar slot; setDayTime keeps the clock', () => {
    const sim = flatSim();
    sim.soloPlayer.hold(B.TORCH, 5);
    sim.soloPlayer.hold(B.STONE);
    sim.soloPlayer.hold(B.TORCH);
    const inv = sim.soloPlayer.player.inventory;
    expect(inv.selectedStack()).toEqual({ item: B.TORCH, count: 5 });
    expect(sim.soloPlayer.player.input.slot).toBe(inv.selected);
    expect(sim.soloPlayer.giveItem(B.DIRT, 70)).toBe(0);
    expect(inv.count(B.DIRT)).toBe(70);

    sim.soloPlayer.player.vel.x = 5;
    sim.soloPlayer.teleport(10.5, T + 3, 10.5);
    expect(sim.soloPlayer.player.pos).toMatchObject({ x: 10.5, y: T + 3, z: 10.5 });
    expect(sim.soloPlayer.player.vel.x).toBe(0);
    expect(sim.soloPlayer.player.prevPos).toMatchObject({ x: 10.5, y: T + 3, z: 10.5 });

    const time = sim.world.time;
    sim.setDayTime(0.25);
    expect(sim.dayTime).toBeCloseTo(0.25, 6);
    expect(sim.world.time).toBe(time);
    expect(sim.isDay).toBe(true);
    sim.setDayTime(0.8);
    expect(sim.isDay).toBe(false);
    sim.advance(10);
    expect(sim.dayTime).toBeCloseTo(0.8 + 10 / 24000, 6);
    void NZ;
  });

  it('entities are snapshotted at the start of the tick: taking the wheel interpolates', () => {
    const sim = flatSim();
    const p = sim.soloPlayer.player;
    sim.tick();
    const before = { ...p.pos };
    sim.tick();
    // A standing player: prev == current after a quiet tick.
    expect(p.prevPos.x).toBeCloseTo(p.pos.x, 9);
    expect(before.x).toBeCloseTo(p.pos.x, 9);
  });
});
