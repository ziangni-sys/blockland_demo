import { describe, expect, it } from 'vitest';
import { emptyInput } from '../../src/entities/input';
import {
  clampPitch,
  DRAG_THRESHOLD_PX,
  DragGesture,
  HOLD_DELAY_MS,
  InputState,
  isGameKey,
  LOOK_RADIANS_PER_PIXEL,
  PITCH_LIMIT,
  slotForKey,
  SPRINT_DOUBLE_TAP_MS,
  WHEEL_STEP_PIXELS,
  wrapYaw,
} from '../../src/client/input';

const look = { sensitivity: 1, invertY: false };

function written(s: InputState, playing = true) {
  const inp = emptyInput();
  s.writeTo(inp, playing);
  return inp;
}

describe('InputState keyboard', () => {
  it('maps WASD to forward / strafe with D = +1 and W = +1', () => {
    const s = new InputState();
    s.keyDown('KeyW', false, 0);
    expect(written(s).forward).toBe(1);
    s.keyDown('KeyS', false, 10);
    expect(written(s).forward).toBe(0);
    s.keyUp('KeyW');
    expect(written(s).forward).toBe(-1);
    s.keyUp('KeyS');
    s.keyDown('KeyD', false, 20);
    expect(written(s).strafe).toBe(1);
    s.keyDown('KeyA', false, 30);
    expect(written(s).strafe).toBe(0);
    s.keyUp('KeyD');
    expect(written(s).strafe).toBe(-1);
  });

  it('arrow keys mirror WASD', () => {
    const s = new InputState();
    s.keyDown('ArrowUp', false, 0);
    s.keyDown('ArrowRight', false, 0);
    const i = written(s);
    expect(i.forward).toBe(1);
    expect(i.strafe).toBe(1);
  });

  it('counts a jump press per non-repeated Space keydown and holds jump while down', () => {
    const s = new InputState();
    s.keyDown('Space', false, 0);
    s.keyDown('Space', true, 30);
    s.keyDown('Space', true, 60);
    const i = written(s);
    expect(i.jumpPresses).toBe(1);
    expect(i.jump).toBe(true);
    s.keyUp('Space');
    s.keyDown('Space', false, 200);
    const j = emptyInput();
    j.jumpPresses = 1; // not consumed yet by the simulation
    s.writeTo(j, true);
    expect(j.jumpPresses).toBe(2);
    // pending presses are handed over once
    expect(written(s).jumpPresses).toBe(0);
  });

  it('Shift sneaks, Ctrl sprints', () => {
    const s = new InputState();
    s.keyDown('ShiftLeft', false, 0);
    expect(written(s).sneak).toBe(true);
    s.keyUp('ShiftLeft');
    s.keyDown('ShiftRight', false, 0);
    expect(written(s).sneak).toBe(true);
    s.keyDown('ControlLeft', false, 0);
    expect(written(s).sprint).toBe(true);
    s.keyUp('ControlLeft');
    expect(written(s).sprint).toBe(false);
  });

  it('double-tapping W sprints until W is released', () => {
    const s = new InputState();
    s.keyDown('KeyW', false, 1000);
    s.keyUp('KeyW');
    s.keyDown('KeyW', false, 1000 + SPRINT_DOUBLE_TAP_MS - 1);
    expect(written(s).sprint).toBe(true);
    s.keyDown('KeyW', true, 1500); // auto-repeat keeps it
    expect(written(s).sprint).toBe(true);
    s.keyUp('KeyW');
    expect(written(s).sprint).toBe(false);
  });

  it('a slow second W tap does not sprint', () => {
    const s = new InputState();
    s.keyDown('KeyW', false, 0);
    s.keyUp('KeyW');
    s.keyDown('KeyW', false, SPRINT_DOUBLE_TAP_MS + 50);
    expect(written(s).sprint).toBe(false);
  });

  it('digits select hotbar slots; E / Esc / F3 are commands, auto-repeat ignored', () => {
    const s = new InputState();
    expect(s.keyDown('Digit5', false, 0)).toBe('none');
    expect(s.slot).toBe(4);
    s.keyDown('Numpad9', false, 0);
    expect(s.slot).toBe(8);
    expect(s.keyDown('KeyE', false, 0)).toBe('toggleInventory');
    expect(s.keyDown('KeyE', true, 0)).toBe('none');
    expect(s.keyDown('Escape', false, 0)).toBe('escape');
    expect(s.keyDown('F3', false, 0)).toBe('toggleDebug');
    expect(s.keyDown('F3', true, 0)).toBe('none');
    expect(slotForKey('Digit0')).toBe(-1);
    expect(slotForKey('KeyQ')).toBe(-1);
  });

  it('knows which keys are game keys', () => {
    for (const k of ['KeyW', 'Space', 'ShiftLeft', 'F3', 'Digit1', 'Escape', 'KeyE']) expect(isGameKey(k)).toBe(true);
    for (const k of ['KeyQ', 'Tab', 'F5', 'KeyR']) expect(isGameKey(k)).toBe(false);
  });

  it('releaseAll lets go of keys, buttons and pending presses', () => {
    const s = new InputState();
    s.keyDown('KeyW', false, 0);
    s.keyDown('Space', false, 0);
    s.buttonDown(0);
    s.releaseAll();
    const i = written(s);
    expect(i.forward).toBe(0);
    expect(i.jump).toBe(false);
    expect(i.attack).toBe(false);
    expect(i.attackPresses).toBe(0);
    expect(i.jumpPresses).toBe(0);
  });
});

describe('InputState mouse', () => {
  it('buttons are held and counted; clicks only count', () => {
    const s = new InputState();
    s.buttonDown(0);
    s.buttonDown(2);
    let i = written(s);
    expect(i.attack && i.use).toBe(true);
    expect(i.attackPresses).toBe(1);
    expect(i.usePresses).toBe(1);
    s.buttonUp(0);
    i = written(s);
    expect(i.attack).toBe(false);
    expect(i.use).toBe(true);
    expect(i.attackPresses).toBe(0);
    s.buttonUp(2);
    s.click(2);
    i = written(s);
    expect(i.use).toBe(false);
    expect(i.usePresses).toBe(1);
    s.buttonDown(1); // middle button: ignored
    expect(written(s).attack).toBe(false);
  });

  it('mouse right turns right (yaw decreases), mouse down looks down', () => {
    const s = new InputState();
    s.look(100, 0, look);
    expect(s.yaw).toBeCloseTo(-100 * LOOK_RADIANS_PER_PIXEL);
    s.look(0, 40, look);
    expect(s.pitch).toBeCloseTo(-40 * LOOK_RADIANS_PER_PIXEL);
  });

  it('applies sensitivity and invertY', () => {
    const s = new InputState();
    s.look(0, 10, { sensitivity: 2, invertY: true });
    expect(s.pitch).toBeCloseTo(20 * LOOK_RADIANS_PER_PIXEL);
    const t = new InputState();
    t.look(10, 0, { sensitivity: Number.NaN, invertY: false });
    expect(t.yaw).toBeCloseTo(-10 * LOOK_RADIANS_PER_PIXEL);
  });

  it('clamps pitch just short of straight up / down and wraps yaw', () => {
    const s = new InputState();
    s.look(0, -1e6, look);
    expect(s.pitch).toBe(PITCH_LIMIT);
    expect(s.pitch).toBeLessThan(Math.PI / 2);
    s.look(0, 1e6, look);
    expect(s.pitch).toBe(-PITCH_LIMIT);
    for (let i = 0; i < 1000; i++) s.look(97, 0, look);
    expect(Math.abs(s.yaw)).toBeLessThanOrEqual(Math.PI);
    expect(clampPitch(Number.NaN)).toBe(0);
    expect(wrapYaw(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapYaw(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('ignores non-finite movement', () => {
    const s = new InputState();
    s.look(Number.NaN, 5, look);
    s.look(5, Number.POSITIVE_INFINITY, look);
    expect(s.yaw).toBe(0);
    expect(s.pitch).toBe(0);
  });

  it('wheel: one slot per notch in line mode, wrapping both ways', () => {
    const s = new InputState();
    s.wheel(3, 1);
    expect(s.slot).toBe(1);
    s.wheel(-3, 1);
    s.wheel(-3, 1);
    expect(s.slot).toBe(8);
    s.wheel(3, 1);
    expect(s.slot).toBe(0);
  });

  it('wheel: pixel deltas accumulate into steps and a direction change resets the partial step', () => {
    const s = new InputState();
    s.wheel(WHEEL_STEP_PIXELS * 0.6, 0);
    expect(s.slot).toBe(0);
    s.wheel(WHEEL_STEP_PIXELS * 0.6, 0);
    expect(s.slot).toBe(1);
    s.wheel(WHEEL_STEP_PIXELS * 0.9, 0); // 0.2 + 0.9 = 1.1 steps
    expect(s.slot).toBe(2);
    s.wheel(-WHEEL_STEP_PIXELS * 0.5, 0); // reversal drops the 0.1 left over
    expect(s.slot).toBe(2);
    s.wheel(-WHEEL_STEP_PIXELS * 0.5, 0);
    expect(s.slot).toBe(1);
    s.wheel(WHEEL_STEP_PIXELS * 3, 0);
    expect(s.slot).toBe(4);
  });

  it('addYaw turns with a carrier', () => {
    const s = new InputState();
    s.setLook(3.1, 0.2);
    s.addYaw(0.1);
    expect(s.yaw).toBeCloseTo(3.2 - 2 * Math.PI);
    expect(s.pitch).toBeCloseTo(0.2);
  });
});

describe('InputState.writeTo', () => {
  it('zeroes movement, buttons and presses when not playing but keeps look and slot', () => {
    const s = new InputState();
    s.keyDown('KeyW', false, 0);
    s.keyDown('Space', false, 0);
    s.buttonDown(0);
    s.setLook(1, -0.5);
    s.selectSlot(3);
    const inp = emptyInput();
    inp.attackPresses = 2;
    s.writeTo(inp, false);
    expect(inp.forward).toBe(0);
    expect(inp.jump).toBe(false);
    expect(inp.attack).toBe(false);
    expect(inp.attackPresses).toBe(0);
    expect(inp.jumpPresses).toBe(0);
    expect(inp.yaw).toBeCloseTo(1);
    expect(inp.pitch).toBeCloseTo(-0.5);
    expect(inp.slot).toBe(3);
    // presses made while a screen was open are dropped, held state resumes
    const j = written(s, true);
    expect(j.forward).toBe(1);
    expect(j.jumpPresses).toBe(0);
    expect(j.attackPresses).toBe(0);
    expect(j.attack).toBe(true);
  });

  it('selectSlot rejects bad indices', () => {
    const s = new InputState();
    s.selectSlot(9);
    s.selectSlot(-1);
    s.selectSlot(2.5);
    expect(s.slot).toBe(0);
  });
});

describe('DragGesture', () => {
  it('a quick still press is a click', () => {
    const g = new DragGesture();
    g.down(0, 100, 100, 0);
    expect(g.move(102, 101)).toBe(false);
    expect(g.update(50)).toBe('none');
    expect(g.up(0)).toBe('click');
    expect(g.state).toBe('idle');
  });

  it('moving past the threshold turns the press into a look drag, including the first travel', () => {
    const g = new DragGesture();
    g.down(0, 100, 100, 0);
    expect(g.move(100 + DRAG_THRESHOLD_PX + 1, 100)).toBe(true);
    expect(g.delta.x).toBe(DRAG_THRESHOLD_PX + 1);
    expect(g.state).toBe('drag');
    expect(g.move(110, 103)).toBe(true);
    expect(g.delta.x).toBe(110 - (100 + DRAG_THRESHOLD_PX + 1));
    expect(g.delta.y).toBe(3);
    // a drag never becomes a hold, and releasing it is not a click
    expect(g.update(10_000)).toBe('none');
    expect(g.up(0)).toBe('none');
  });

  it('a press held still becomes a hold; moving then still turns the view', () => {
    const g = new DragGesture();
    g.down(2, 50, 50, 1000);
    expect(g.update(1000 + HOLD_DELAY_MS - 1)).toBe('none');
    expect(g.update(1000 + HOLD_DELAY_MS)).toBe('startHold');
    expect(g.button).toBe(2);
    expect(g.move(60, 50)).toBe(true);
    expect(g.delta.x).toBe(10);
    expect(g.up(2)).toBe('endHold');
  });

  it('ignores other buttons while busy and cancels cleanly', () => {
    const g = new DragGesture();
    expect(g.down(0, 0, 0, 0)).toBe(true);
    expect(g.down(2, 0, 0, 0)).toBe(false);
    expect(g.up(2)).toBe('none');
    g.update(HOLD_DELAY_MS);
    expect(g.cancel()).toBe('endHold');
    expect(g.state).toBe('idle');
    expect(g.cancel()).toBe('none');
    expect(g.move(10, 10)).toBe(false);
  });

  it('a press released after the hold delay without a frame in between is still a click', () => {
    const g = new DragGesture();
    g.down(0, 0, 0, 0);
    expect(g.up(0)).toBe('click');
  });
});
