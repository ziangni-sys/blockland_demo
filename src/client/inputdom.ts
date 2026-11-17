/**
 * Browser input binding: keyboard, mouse buttons, wheel, pointer lock and the drag-to-look
 * fallback. Translates DOM events into InputState calls and client commands.
 *
 * The game runs in a sandboxed iframe: keyboard events only arrive after a click focused it,
 * and Pointer Lock may be refused (no allow-pointer-lock) or unsupported. Pointer lock is
 * always tried from the first canvas click, also in a frame with an opaque origin (a host may
 * sandbox without allow-same-origin and still grant allow-pointer-lock). If a request made
 * from a click fails before any lock ever worked, the binder switches to drag-to-look for good
 * (holding a button and moving turns the view; a still click is a normal click). A refusal of
 * a request made without a click (Esc / key resume: no user activation) proves nothing and
 * changes nothing. A later failure after a lock once worked is just "not locked right now"
 * (e.g. Chrome refuses a re-lock right after the user pressed Esc): the click-to-play veil
 * stays up and the next click retries.
 */
import { BUTTON_PICK, DragGesture, isGameKey, type InputCommand, type InputState, type LookSettings } from './input';

/** What the binder needs from the game. */
export interface InputHost {
  readonly input: InputState;
  /** A world is running with no screen open (game controls are live). */
  isPlaying(): boolean;
  /** A world is running (any in-game screen). */
  inWorld(): boolean;
  /** The UI has a text field focused. */
  wantsKeyboard(): boolean;
  lookSettings(): LookSettings;
  command(cmd: InputCommand): void;
  /** Pointer lock ended without the game asking for it (Esc, focus loss). */
  onLockLost(): void;
  /** Lock / drag-look / engagement state changed (the UI veil follows it). */
  onPointerStateChange(): void;
}

/**
 * False when the browser reports that the page has no transient user activation right now (a
 * pointer-lock request would be refused for that reason alone). Unknown = true.
 */
function hasUserActivation(win: Window): boolean {
  try {
    const ua = (win.navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return ua === undefined || ua.isActive !== false;
  } catch {
    return true;
  }
}

/** If neither lock nor error arrives this long after a first request, assume locking does not work. */
const LOCK_SILENCE_MS = 1500;

export class InputBinder {
  private readonly gesture = new DragGesture();
  /** Pointer is locked to the canvas. */
  locked = false;
  /** Drag-to-look mode (pointer lock unavailable). */
  dragLook = false;
  /** The player clicked into the game since it last lost focus (drag mode veil). */
  engaged = false;
  private everLocked = false;
  private expectUnlock = false;
  /** Drop the first movement after locking (see onMouseMove). */
  private skipNextMove = false;
  private pendingSince = -1;
  /** The pending lock request came from a canvas click (its refusal means "unavailable"). */
  private requestFromClick = false;
  /**
   * The current drag-mode press is the one that engaged the game (dismissed the veil): it may
   * turn the view, but it never mines or places (as in pointer-lock mode, where the first
   * click only asks for the lock).
   */
  private engagingPress = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly win: Window,
    private readonly canvas: HTMLCanvasElement,
    private readonly host: InputHost,
  ) {
    const doc = win.document;
    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions): void => {
      t.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on(win, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    on(win, 'keyup', (e: KeyboardEvent) => this.host.input.keyUp(e.code));
    on(win, 'blur', () => this.onBlur());
    on(canvas, 'mousedown', (e: MouseEvent) => this.onMouseDown(e));
    on(win, 'mousemove', (e: MouseEvent) => this.onMouseMove(e));
    on(win, 'mouseup', (e: MouseEvent) => this.onMouseUp(e));
    on(canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
    on(doc, 'pointerlockchange', () => this.onLockChange());
    on(doc, 'pointerlockerror', () => this.onLockError());
    if (typeof canvas.requestPointerLock !== 'function') this.dragLook = true;
  }

  /** Per frame: promotes a still drag-mode press to a held button; detects silent lock refusals. */
  update(now: number): void {
    const ev = this.gesture.update(now);
    if (ev === 'startHold' && !this.engagingPress) this.run(this.host.input.buttonDown(this.gesture.button));
    if (this.pendingSince >= 0 && !this.locked && now - this.pendingSince > LOCK_SILENCE_MS) {
      this.pendingSince = -1;
      if (!this.everLocked && this.requestFromClick) this.enterDragLook(true);
    }
  }

  /**
   * Ask for pointer lock (call from a user gesture). `fromClick`: the request comes from a
   * canvas click, so a refusal means the host does not allow locking. A request without user
   * activation (Esc does not grant it) is not even made: it would be refused and the
   * click-to-play veil asks for the click that can lock.
   */
  requestLock(fromClick = false): void {
    if (this.dragLook || this.locked) return;
    if (!fromClick && !hasUserActivation(this.win)) return;
    const c = this.canvas as HTMLCanvasElement & { requestPointerLock(opts?: unknown): Promise<void> | void };
    this.requestFromClick = fromClick;
    try {
      const r = c.requestPointerLock();
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => this.onLockError());
      this.pendingSince = performance.now();
    } catch {
      this.onLockError();
    }
  }

  /** Release pointer lock (opening a screen). Does not count as the player leaving. */
  exitLock(): void {
    this.cancelGesture();
    if (!this.locked) return;
    this.expectUnlock = true;
    try {
      this.win.document.exitPointerLock();
    } catch {
      // ignore
    }
  }

  /** The drag gesture is aborted and any held button released. */
  cancelGesture(): void {
    const button = this.gesture.button; // cancel() forgets it
    if (this.gesture.cancel() === 'endHold' && !this.engagingPress) this.host.input.buttonUp(button);
    this.engagingPress = false;
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
  }

  // ------------------------------------------------------------------ events

  private onKeyDown(e: KeyboardEvent): void {
    if (this.host.wantsKeyboard()) return;
    const host = this.host;
    if (!host.inWorld()) return;
    const playing = host.isPlaying();
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    // Browser shortcuts (Ctrl+E, Cmd+W ...) are not game commands; Ctrl alone is sprint.
    if (modified && e.code !== 'ControlLeft' && e.code !== 'ControlRight' && !playing) return;
    if (playing && isGameKey(e.code)) e.preventDefault();
    // F3 / F5 are game keys on every in-world screen (F5 would reload the page and lose the world).
    else if (e.code === 'F3' || e.code === 'F5') e.preventDefault();
    if (!playing && e.code !== 'KeyE' && e.code !== 'Escape' && e.code !== 'F3') {
      // In menus only the screen keys act; held movement keys are still tracked so walking
      // resumes naturally when the inventory closes with W still down.
      host.input.keyDown(e.code, e.repeat, e.timeStamp);
      return;
    }
    if (modified && (e.code === 'KeyE' || e.code === 'F3')) return;
    const cmd = host.input.keyDown(e.code, e.repeat, e.timeStamp);
    if (cmd !== 'none') host.command(cmd);
  }

  private onBlur(): void {
    this.host.input.releaseAll();
    this.cancelGesture();
    if (this.engaged) {
      this.engaged = false;
      this.host.onPointerStateChange();
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (!this.host.isPlaying()) return;
    // The middle button picks a block; its browser default (autoscroll) must never start.
    if (e.button === BUTTON_PICK) e.preventDefault();
    // Make sure keyboard events reach this frame (iframe hosts).
    try {
      this.win.focus();
    } catch {
      // ignore
    }
    if (this.locked) {
      this.run(this.host.input.buttonDown(e.button));
      return;
    }
    if (this.dragLook) {
      let engaging = false;
      if (!this.engaged) {
        this.engaged = true;
        engaging = true;
        this.host.onPointerStateChange();
      }
      // The press that dismisses the veil may drag the view but never mines or places.
      if (this.gesture.down(e.button, e.clientX, e.clientY, e.timeStamp)) this.engagingPress = engaging;
      e.preventDefault();
      return;
    }
    // First click only engages: it asks for the lock and does not mine or place.
    this.requestLock(true);
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.locked) {
      if (!this.host.isPlaying()) return;
      // Chrome sometimes reports a bogus jump right after locking (or after a focus change):
      // the distance from the last cursor position to a window corner. No real flick moves
      // half a window in one coalesced event (that would be thousands of degrees per second).
      if (this.skipNextMove || Math.abs(e.movementX) > this.win.innerWidth * 0.45 || Math.abs(e.movementY) > this.win.innerHeight * 0.45) {
        this.skipNextMove = false;
        return;
      }
      this.host.input.look(e.movementX, e.movementY, this.host.lookSettings());
      return;
    }
    if (this.dragLook && this.gesture.state !== 'idle') {
      if (!this.host.isPlaying()) {
        this.cancelGesture();
        return;
      }
      const turned = this.gesture.move(e.clientX, e.clientY);
      // A hold that turned into a real drag was a look after all: let go of the button.
      if (this.gesture.takeHoldCancel() && !this.engagingPress) this.host.input.buttonUp(this.gesture.button);
      if (turned) this.host.input.look(this.gesture.delta.x, this.gesture.delta.y, this.host.lookSettings());
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.locked) {
      this.host.input.buttonUp(e.button);
      return;
    }
    if (this.dragLook) {
      const button = this.gesture.button;
      const engaging = this.engagingPress;
      const ev = this.gesture.up(e.button);
      if (this.gesture.state === 'idle') this.engagingPress = false;
      if (ev === 'click' && this.host.isPlaying() && !engaging) this.run(this.host.input.click(button));
      else if (ev === 'endHold') this.host.input.buttonUp(button);
    }
    // Releases always go through (a button pressed before a screen opened must not stick).
    this.host.input.buttonUp(e.button);
  }

  /** Hand a command from a mouse button (the middle button's pick block) to the game. */
  private run(cmd: InputCommand): void {
    if (cmd !== 'none' && this.host.isPlaying()) this.host.command(cmd);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.host.isPlaying()) return;
    e.preventDefault();
    this.host.input.wheel(e.deltaY, e.deltaMode);
  }

  private onLockChange(): void {
    const locked = this.win.document.pointerLockElement === this.canvas;
    if (locked === this.locked) return;
    this.locked = locked;
    this.pendingSince = -1;
    if (locked) {
      this.everLocked = true;
      this.engaged = true;
      this.skipNextMove = true;
    } else {
      this.host.input.releaseAll();
      const expected = this.expectUnlock;
      this.expectUnlock = false;
      if (!expected) this.host.onLockLost();
    }
    this.host.onPointerStateChange();
  }

  private onLockError(): void {
    this.pendingSince = -1;
    // Never locked and refused although asked from a click: the host does not allow it
    // (sandbox without allow-pointer-lock, no support). A request without a click (key resume)
    // may be refused for lack of user activation alone, and after a successful lock a refusal
    // is transient: keep the click-to-play veil, the next click asks again.
    if (!this.everLocked && this.requestFromClick) this.enterDragLook(true);
  }

  /**
   * Switch to drag-to-look for good. `engaged`: the refused request came from the player's
   * click into the game, which therefore already counts as the engaging click (that click
   * started no gesture, so nothing was mined).
   */
  private enterDragLook(engaged: boolean): void {
    if (this.dragLook) return;
    this.dragLook = true;
    this.engaged = engaged;
    this.host.onPointerStateChange();
  }
}
