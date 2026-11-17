/**
 * Player input as the simulation sees it. The client writes it every frame; the simulation
 * reads it once per tick.
 *
 * Held state (forward, strafe, jump ...) is simply the latest value. Short presses that may
 * start and end between two ticks are counted instead: the client increments the *Presses
 * counters on every key / button down, and whoever acts on them consumes (zeroes) them.
 * The entities module consumes `jumpPresses` (double-tap to fly); the interaction code
 * consumes `attackPresses` / `usePresses`.
 */
export interface PlayerInput {
  /** -1..1, W = +1. */
  forward: number;
  /** -1..1, D = +1 = to the right. */
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  /** Absolute look (radians), set by the client every frame. yaw 0 looks toward -Z, grows turning left. */
  yaw: number;
  /** Absolute look (radians), > 0 looks up. */
  pitch: number;
  /** Left button held. */
  attack: boolean;
  /** Right button held. */
  use: boolean;
  /** Edge counters: the client increments, the simulation consumes. */
  attackPresses: number;
  usePresses: number;
  jumpPresses: number;
  /** Selected hotbar slot 0..8. */
  slot: number;
}

export function emptyInput(): PlayerInput {
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    sneak: false,
    sprint: false,
    yaw: 0,
    pitch: 0,
    attack: false,
    use: false,
    attackPresses: 0,
    usePresses: 0,
    jumpPresses: 0,
    slot: 0,
  };
}

/** Clamp to [-1, 1]; NaN and other garbage become 0. */
export function axisValue(v: number): number {
  if (!(v === v) || typeof v !== 'number') return 0;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** A finite angle, or `fallback` for NaN / infinities. */
export function finiteAngle(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
