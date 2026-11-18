/**
 * Input mapping: keyboard / mouse state -> what the client sends. DOM-free (the listeners live in
 * inputdom.ts) so the state machine is unit-tested in Node.
 *
 * Held keys are plain state, written every frame into the prediction's held input (writeHeld:
 * net/client/predict.ts HeldInput, which OwnPlayer reads at every client tick). The look is
 * absolute (yaw / pitch), turned by mouse movement here and by a turning carrier there (the page
 * copies it back after each frame). Jump presses are counted (a double tap toggles flight) and
 * handed over with the held input. The mouse buttons and the off-hand swap key are EVENTS, kept in
 * order (takeEvents): the page turns each into an intent (net/client/intents.ts: Use / UseRelease,
 * Attack / AttackRelease, SwapHands), so a click that starts and ends between two frames still
 * reaches the server as a press and a release. A hotbar selection (digit keys, wheel, a click on
 * the hotbar) is reported once (takeSlotChange) and becomes a SelectSlot intent.
 *
 * Key names are KeyboardEvent.code values (physical positions), so WASD stays WASD on
 * AZERTY and other layouts.
 */
import type { HeldInput } from '../net/client/predict';
import { HOTBAR_SIZE } from '../ui/model';

/** What a key press asks the client (not the simulation) to do. */
export type InputCommand = 'none' | 'toggleInventory' | 'escape' | 'toggleDebug' | 'cycleView' | 'pickBlock';

export interface LookSettings {
  /** Multiplier, 0.2..3. */
  sensitivity: number;
  invertY: boolean;
}

/** View rotation per mouse pixel at sensitivity 1 (about 0.14 degrees). */
export const LOOK_RADIANS_PER_PIXEL = 0.0025;
/** Pitch stays just short of straight up / down so the view basis never degenerates. */
export const PITCH_LIMIT = Math.PI / 2 - 0.001;
/** Two W presses within this many ms start sprinting. */
export const SPRINT_DOUBLE_TAP_MS = 300;
/** Pixel-mode wheel delta that counts as one hotbar step (trackpads send many small deltas). */
export const WHEEL_STEP_PIXELS = 50;

export const BUTTON_ATTACK = 0;
/** Middle button: pick block (a command, never a held button). */
export const BUTTON_PICK = 1;
export const BUTTON_USE = 2;

/**
 * What a button or the off-hand key did, in order (takeEvents): presses and releases of the use
 * (right) and attack (left) buttons, and a press of the off-hand swap key (SWAP_KEY).
 */
export type InputEvent = 'useDown' | 'useUp' | 'attackDown' | 'attackUp' | 'swap';

const FORWARD_KEYS = ['KeyW', 'ArrowUp'];
const BACK_KEYS = ['KeyS', 'ArrowDown'];
const LEFT_KEYS = ['KeyA', 'ArrowLeft'];
const RIGHT_KEYS = ['KeyD', 'ArrowRight'];
/** Swaps the selected hotbar stack with the off-hand stack (DESIGN 副手). */
export const SWAP_KEY = 'KeyF';

/** Keys whose browser default (scrolling, find bar, ...) must be suppressed during play. */
const GAME_KEYS = new Set([
  ...FORWARD_KEYS,
  ...BACK_KEYS,
  ...LEFT_KEYS,
  ...RIGHT_KEYS,
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'KeyE',
  SWAP_KEY,
  'Escape',
  'F3',
  'F5',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
]);

/** True for keys the game uses (the DOM layer calls preventDefault on them during play). */
export function isGameKey(code: string): boolean {
  return GAME_KEYS.has(code);
}

/** Hotbar index for Digit1..Digit9 (also numpad), or -1. */
export function slotForKey(code: string): number {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) - 1 : -1;
}

function wrapSlot(i: number): number {
  return ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
}

/** Clamp pitch to the allowed range; NaN becomes 0. */
export function clampPitch(p: number): number {
  if (!(p === p)) return 0;
  return p < -PITCH_LIMIT ? -PITCH_LIMIT : p > PITCH_LIMIT ? PITCH_LIMIT : p;
}

/** Wrap yaw to (-PI, PI] so it never loses precision over a long session. */
export function wrapYaw(y: number): number {
  if (!Number.isFinite(y)) return 0;
  const t = Math.PI * 2;
  let r = y % t;
  if (r > Math.PI) r -= t;
  else if (r <= -Math.PI) r += t;
  return r;
}

export class InputState {
  /** Absolute look direction (radians); the camera and the held input both read it. */
  yaw = 0;
  pitch = 0;
  /** Selected hotbar slot 0..8 (the page keeps it in step with the inventory as shown). */
  slot = 0;

  private readonly keys = new Set<string>();
  /** Held mouse buttons, bit = 1 << button. */
  private buttons = 0;
  /** Button and swap events since the last takeEvents(), in order. */
  private events: InputEvent[] = [];
  private jumpPresses = 0;
  /** The player chose a slot since the last takeSlotChange(). */
  private slotChanged = false;
  private lastForwardTap = -Infinity;
  private sprintLatch = false;
  private wheelAcc = 0;

  // ------------------------------------------------------------ keyboard

  /**
   * A key went down. `repeat` = auto-repeat; `now` = ms timestamp (double-tap detection).
   * Returns the client-level command the key stands for, if any.
   */
  keyDown(code: string, repeat: boolean, now: number): InputCommand {
    switch (code) {
      case 'KeyE':
        return repeat ? 'none' : 'toggleInventory';
      case 'Escape':
        return repeat ? 'none' : 'escape';
      case 'F3':
        return repeat ? 'none' : 'toggleDebug';
      case 'F5':
        return repeat ? 'none' : 'cycleView';
      default:
        break;
    }
    const slot = slotForKey(code);
    if (slot >= 0) {
      this.selectSlot(slot);
      return 'none';
    }
    if (!repeat) {
      if (code === 'Space') this.jumpPresses++;
      if (code === SWAP_KEY) this.events.push('swap');
      if (code === 'KeyW' || code === 'ArrowUp') {
        // Double-tap forward sprints until the key is released.
        if (now - this.lastForwardTap <= SPRINT_DOUBLE_TAP_MS) this.sprintLatch = true;
        this.lastForwardTap = now;
      }
    }
    this.keys.add(code);
    return 'none';
  }

  keyUp(code: string): void {
    this.keys.delete(code);
    if ((code === 'KeyW' || code === 'ArrowUp') && !this.anyHeld(FORWARD_KEYS)) this.sprintLatch = false;
  }

  isHeld(code: string): boolean {
    return this.keys.has(code);
  }

  private anyHeld(codes: readonly string[]): boolean {
    for (let i = 0; i < codes.length; i++) if (this.keys.has(codes[i]!)) return true;
    return false;
  }

  // ------------------------------------------------------------ mouse

  /**
   * A button went down and is held (attack = 0, use = 2): a press event. The middle button is
   * not held: it returns the 'pickBlock' command. Other buttons are ignored.
   */
  buttonDown(button: number): InputCommand {
    if (button === BUTTON_PICK) return 'pickBlock';
    if (button !== BUTTON_ATTACK && button !== BUTTON_USE) return 'none';
    const bit = 1 << button;
    if ((this.buttons & bit) !== 0) this.events.push(button === BUTTON_USE ? 'useUp' : 'attackUp');
    this.buttons |= bit;
    this.events.push(button === BUTTON_USE ? 'useDown' : 'attackDown');
    return 'none';
  }

  /** A held button went up: a release event (nothing when it was not held). */
  buttonUp(button: number): void {
    if (button !== BUTTON_ATTACK && button !== BUTTON_USE) return;
    const bit = 1 << button;
    if ((this.buttons & bit) === 0) return;
    this.buttons &= ~bit;
    this.events.push(button === BUTTON_USE ? 'useUp' : 'attackUp');
  }

  /** A click that was never "held" (drag-to-look tap): a press and its release; middle = 'pickBlock'. */
  click(button: number): InputCommand {
    if (button === BUTTON_PICK) return 'pickBlock';
    if (button !== BUTTON_ATTACK && button !== BUTTON_USE) return 'none';
    this.buttonDown(button);
    this.buttonUp(button);
    return 'none';
  }

  /** The use (right) button is held. */
  get useHeld(): boolean {
    return (this.buttons & (1 << BUTTON_USE)) !== 0;
  }

  /** The attack (left) button is held. */
  get attackHeld(): boolean {
    return (this.buttons & (1 << BUTTON_ATTACK)) !== 0;
  }

  /** Rotate the view by a mouse movement in pixels. Moving right turns right (yaw decreases). */
  look(dx: number, dy: number, s: LookSettings): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const k = LOOK_RADIANS_PER_PIXEL * (Number.isFinite(s.sensitivity) && s.sensitivity > 0 ? s.sensitivity : 1);
    this.yaw = wrapYaw(this.yaw - dx * k);
    this.pitch = clampPitch(this.pitch - dy * k * (s.invertY ? -1 : 1));
  }

  setLook(yaw: number, pitch: number): void {
    this.yaw = wrapYaw(yaw);
    this.pitch = clampPitch(pitch);
  }

  /**
   * Mouse wheel: one hotbar step per notch (line / page mode) or per WHEEL_STEP_PIXELS of
   * pixel-mode delta (smooth trackpads). Down / towards the user = next slot.
   * deltaMode: 0 pixels, 1 lines, 2 pages (WheelEvent).
   */
  wheel(deltaY: number, deltaMode: number): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    if (deltaMode !== 0) {
      this.selectSlot(wrapSlot(this.slot + (deltaY > 0 ? 1 : -1)));
      this.wheelAcc = 0;
      return;
    }
    // A direction change discards the partial step in the other direction.
    if (this.wheelAcc !== 0 && Math.sign(this.wheelAcc) !== Math.sign(deltaY)) this.wheelAcc = 0;
    this.wheelAcc += deltaY;
    while (Math.abs(this.wheelAcc) >= WHEEL_STEP_PIXELS) {
      const dir = this.wheelAcc > 0 ? 1 : -1;
      this.selectSlot(wrapSlot(this.slot + dir));
      this.wheelAcc -= dir * WHEEL_STEP_PIXELS;
    }
  }

  /** The player chooses hotbar slot `i` (reported by takeSlotChange). */
  selectSlot(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= HOTBAR_SIZE) return;
    this.slot = i;
    this.slotChanged = true;
  }

  /** The slot the player chose since the last call, or -1. */
  takeSlotChange(): number {
    if (!this.slotChanged) return -1;
    this.slotChanged = false;
    return this.slot;
  }

  /**
   * Follow a selection made elsewhere (pick block, the server's inventory): no change is
   * reported, unless the player chose a slot that is not taken yet (that one wins).
   */
  followSlot(i: number): void {
    if (!this.slotChanged && Number.isInteger(i) && i >= 0 && i < HOTBAR_SIZE) this.slot = i;
  }

  /**
   * Let go of everything (window blur, screen change): nothing stays stuck down. The buttons go
   * up without release events: the page releases the intents of buttons that are no longer
   * held (useHeld / attackHeld).
   */
  releaseAll(): void {
    this.keys.clear();
    this.buttons = 0;
    this.sprintLatch = false;
    this.events = [];
    this.jumpPresses = 0;
    this.wheelAcc = 0;
  }

  // ------------------------------------------------------------ output

  get forward(): number {
    return (this.anyHeld(FORWARD_KEYS) ? 1 : 0) - (this.anyHeld(BACK_KEYS) ? 1 : 0);
  }
  get strafe(): number {
    return (this.anyHeld(RIGHT_KEYS) ? 1 : 0) - (this.anyHeld(LEFT_KEYS) ? 1 : 0);
  }
  get sprinting(): boolean {
    return this.sprintLatch || this.keys.has('ControlLeft') || this.keys.has('ControlRight');
  }
  get sneaking(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /**
   * Write the held keys and the look into `held` (the prediction's held input). With `playing`
   * false (a screen such as the inventory is open) the keys are zeroed but the look is still
   * written. Pending jump presses are added to `held.jumpPresses` (OwnPlayer takes them) or,
   * when not playing, discarded.
   */
  writeHeld(held: HeldInput, playing: boolean): void {
    held.yaw = this.yaw;
    held.pitch = this.pitch;
    if (!playing) {
      held.forward = 0;
      held.strafe = 0;
      held.jump = false;
      held.sneak = false;
      held.sprint = false;
      this.jumpPresses = 0;
      return;
    }
    held.forward = this.forward;
    held.strafe = this.strafe;
    held.jump = this.keys.has('Space');
    held.sneak = this.sneaking;
    held.sprint = this.sprinting;
    held.jumpPresses += this.jumpPresses;
    this.jumpPresses = 0;
  }

  /**
   * The button and swap events since the last call, in order. With `playing` false they are
   * discarded (an empty list): a screen is open, so nothing reaches the world.
   */
  takeEvents(playing: boolean): InputEvent[] {
    const out = this.events;
    this.events = [];
    return playing ? out : [];
  }
}

// ------------------------------------------------------------ drag-to-look

/** Pointer travel (px) after which a press becomes a drag (look) instead of a click. */
export const DRAG_THRESHOLD_PX = 5;
/**
 * A press held still this long becomes a held button (mining / using) instead of a click: the
 * usual long-press time. Long enough that the natural hesitation before starting a look drag
 * (~0.3 s, plus input lag on a slow frame) is not taken for a hold — in creative mode one held
 * frame already breaks the block under the crosshair.
 */
export const HOLD_DELAY_MS = 500;
/**
 * A hold whose pointer then travels this far (px) from where the hold started was a look drag
 * after all: the held button is released (survival mining stops before the block breaks) and
 * the rest of the press only turns the view. Small aiming moves while mining stay a hold.
 */
export const HOLD_CANCEL_PX = 16;

export type GestureEvent = 'none' | 'click' | 'startHold' | 'endHold';

/**
 * Drag-to-look gesture, used when the host refuses pointer lock. One button at a time:
 *  - press + move beyond DRAG_THRESHOLD_PX before HOLD_DELAY_MS -> a pure look drag;
 *  - press held still for HOLD_DELAY_MS                          -> a held button (moving
 *    afterwards still turns the view, like aiming while mining; travelling beyond
 *    HOLD_CANCEL_PX releases the button and makes it a look drag, see takeHoldCancel);
 *  - press released quickly without moving                       -> a click.
 */
export class DragGesture {
  state: 'idle' | 'pending' | 'drag' | 'hold' = 'idle';
  button = -1;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private startT = 0;
  private holdX = 0;
  private holdY = 0;
  private holdCancelled = false;
  /** Rotation delta of the last move() (pixels). */
  readonly delta = { x: 0, y: 0 };

  down(button: number, x: number, y: number, t: number): boolean {
    if (this.state !== 'idle') return false;
    this.state = 'pending';
    this.button = button;
    this.startX = this.lastX = x;
    this.startY = this.lastY = y;
    this.startT = t;
    this.holdCancelled = false;
    return true;
  }

  /** Pointer moved; returns true and fills `delta` when the view should turn. */
  move(x: number, y: number): boolean {
    this.delta.x = 0;
    this.delta.y = 0;
    if (this.state === 'idle') return false;
    if (this.state === 'pending') {
      const dx = x - this.startX;
      const dy = y - this.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return false;
      this.state = 'drag';
      // Include the travel below the threshold so the view does not lag behind the pointer.
      this.delta.x = dx;
      this.delta.y = dy;
    } else {
      this.delta.x = x - this.lastX;
      this.delta.y = y - this.lastY;
      if (this.state === 'hold') {
        const hx = x - this.holdX;
        const hy = y - this.holdY;
        if (hx * hx + hy * hy > HOLD_CANCEL_PX * HOLD_CANCEL_PX) {
          this.state = 'drag';
          this.holdCancelled = true;
        }
      }
    }
    this.lastX = x;
    this.lastY = y;
    return this.delta.x !== 0 || this.delta.y !== 0;
  }

  /** Called every frame: promotes a still press to a hold. */
  update(t: number): GestureEvent {
    if (this.state === 'pending' && t - this.startT >= HOLD_DELAY_MS) {
      this.state = 'hold';
      this.holdX = this.lastX;
      this.holdY = this.lastY;
      return 'startHold';
    }
    return 'none';
  }

  /**
   * True once after move() turned a hold into a look drag: the caller releases the held button
   * (the gesture's button stays readable until the press ends).
   */
  takeHoldCancel(): boolean {
    const c = this.holdCancelled;
    this.holdCancelled = false;
    return c;
  }

  up(button: number): GestureEvent {
    if (this.state === 'idle' || button !== this.button) return 'none';
    const s = this.state;
    this.state = 'idle';
    this.button = -1;
    // Still pending (no frame promoted it to a hold): it was a click, however long it took.
    if (s === 'pending') return 'click';
    return s === 'hold' ? 'endHold' : 'none';
  }

  /** Abort (blur, screen opened). Returns 'endHold' when a held button must be released. */
  cancel(): GestureEvent {
    const s = this.state;
    this.state = 'idle';
    this.button = -1;
    this.holdCancelled = false;
    return s === 'hold' ? 'endHold' : 'none';
  }
}
