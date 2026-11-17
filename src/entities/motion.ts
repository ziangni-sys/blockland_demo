/**
 * Controllers: turn input / AI / nothing into the entity's own velocity for this tick and
 * the displacement it wants to make (step a of the entity pipeline).
 *
 * Every controller works on `rel`, the entity's velocity RELATIVE TO ITS CARRIER (world axes;
 * equal to the world velocity when not carried), so walking on a moving deck feels exactly
 * like walking on land. Vertical motion integrates gravity with the average of the old and
 * new speed, which reproduces the exact parabola at tick resolution (jump apex = v0^2 / 2g).
 */
import { TICK_DT } from '../core/constants';
import type { Vec3 } from '../core/math';
import {
  AIR_ACCEL,
  FLY_ACCEL,
  FLY_SPEED,
  FLY_SPRINT_MULTIPLIER,
  FLY_VERTICAL_SPEED,
  GRAVITY,
  GROUND_ACCEL,
  ITEM_AIR_DRAG,
  ITEM_GROUND_FRICTION,
  ITEM_TERMINAL_SPEED,
  ITEM_WATER_DRAG,
  JUMP_SPEED,
  LAVA_ACCEL,
  LAVA_DRAG,
  LAVA_SINK_ACCEL,
  LAVA_SPEED,
  LAVA_SWIM_UP_ACCEL,
  SNEAK_SPEED,
  SPRINT_SPEED,
  SWIM_DOWN_ACCEL,
  SWIM_MIN_WET,
  SWIM_SPEED,
  SWIM_SPRINT_SPEED,
  SWIM_UP_ACCEL,
  TERMINAL_SPEED,
  WALK_SPEED,
  WATER_ACCEL,
  WATER_DRAG,
  WATER_EXIT_SPEED,
  WATER_SINK_ACCEL,
} from './constants';
import type { Entity, Player } from './entity';
import { axisValue } from './input';

const DT = TICK_DT;

/** Horizontal wish direction from look yaw and stick input (length <= 1), written to out.x / out.z. */
export function wishDirection(yaw: number, forward: number, strafe: number, out: Vec3): Vec3 {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  // forward = (-sin, -cos), right = (cos, -sin) (yaw grows turning left, 0 looks toward -Z)
  let x = -s * forward + c * strafe;
  let z = -c * forward - s * strafe;
  const l = Math.sqrt(x * x + z * z);
  if (l > 1) {
    x /= l;
    z /= l;
  }
  out.x = x;
  out.y = 0;
  out.z = z;
  return out;
}

/**
 * Player movement. `fluid` = share of the body in any liquid (water + lava), `lava` = some of it
 * is lava. Writes the wanted displacement to `out` and returns true when the sneak edge guard
 * applies (sneaking on the ground).
 */
export function playerMotion(p: Player, rel: Vec3, fluid: number, lava: boolean, wish: Vec3, out: Vec3): boolean {
  const inp = p.input;
  const fwd = axisValue(inp.forward);
  const str = axisValue(inp.strafe);
  wishDirection(p.yaw, fwd, str, wish);
  const wx = wish.x;
  const wz = wish.z;
  const wl = Math.sqrt(wx * wx + wz * wz);

  if (p.flying) {
    const sp = FLY_SPEED * (p.sprinting ? FLY_SPRINT_MULTIPLIER : 1);
    rel.x += (wx * sp - rel.x) * FLY_ACCEL;
    rel.z += (wz * sp - rel.z) * FLY_ACCEL;
    const vt = (inp.jump ? FLY_VERTICAL_SPEED : 0) - (inp.sneak ? FLY_VERTICAL_SPEED : 0);
    rel.y += (vt - rel.y) * FLY_ACCEL;
    out.x = rel.x * DT;
    out.y = rel.y * DT;
    out.z = rel.z * DT;
    return false;
  }

  const landSpeed = p.sneaking ? SNEAK_SPEED : p.sprinting ? SPRINT_SPEED : WALK_SPEED;
  const landK = p.onGround ? GROUND_ACCEL : AIR_ACCEL;
  let speed = landSpeed;
  let k = landK;
  let vy0 = rel.y;
  let vy1: number;
  if (fluid <= 0) {
    if (inp.jump && p.onGround) vy0 = JUMP_SPEED;
    vy1 = vy0 - GRAVITY * DT;
  } else {
    const w = fluid > 1 ? 1 : fluid;
    let ay = -GRAVITY * (1 - w) - (lava ? LAVA_SINK_ACCEL : WATER_SINK_ACCEL) * w;
    if (inp.jump) {
      if (p.onGround && w < 0.5) vy0 = JUMP_SPEED; // jumping out of shallow water
      else if (w > SWIM_MIN_WET) ay += lava ? LAVA_SWIM_UP_ACCEL : SWIM_UP_ACCEL;
    }
    if (inp.sneak && w > 0.5) ay -= SWIM_DOWN_ACCEL;
    const drag = lava ? LAVA_DRAG : WATER_DRAG;
    vy1 = (vy0 + ay * DT) * (1 + (drag - 1) * w);
    // Climbing out: holding jump while swimming INTO a WORLD wall lifts the swimmer over the
    // ledge. contactNx / contactNz only ever hold world walls: swimming (W + space, the normal
    // way to swim at the surface) toward a hull never lifts the swimmer aboard, at any angle
    // (ACCEPTANCE 19 船转 45° 时在船角附近游泳，不会被拎上船; the brief: a swimmer next to a
    // hull is never attached).
    if (inp.jump && wl > 0.1 && (p.contactNx !== 0 || p.contactNz !== 0)) {
      if (wx * p.contactNx + wz * p.contactNz < -0.3 * wl && vy1 < WATER_EXIT_SPEED) vy1 = WATER_EXIT_SPEED;
    }
    const s = w * 2 > 1 ? 1 : w * 2;
    const swim = lava ? LAVA_SPEED : p.sprinting ? SWIM_SPRINT_SPEED : SWIM_SPEED;
    speed = landSpeed + (swim - landSpeed) * s;
    k = landK + ((lava ? LAVA_ACCEL : WATER_ACCEL) - landK) * s;
  }
  if (vy1 < -TERMINAL_SPEED) vy1 = -TERMINAL_SPEED;
  rel.x += (wx * speed - rel.x) * k;
  rel.z += (wz * speed - rel.z) * k;
  out.x = rel.x * DT;
  out.z = rel.z * DT;
  out.y = (vy0 + vy1) * 0.5 * DT;
  rel.y = vy1;
  return p.sneaking && p.onGround;
}

/**
 * Passive bodies (item drops, falling blocks, blast crates): gravity, drag, ground friction and
 * buoyancy (`buoyancy` = upward acceleration when fully submerged).
 */
export function passiveMotion(e: Entity, rel: Vec3, fluid: number, gravity: number, buoyancy: number, out: Vec3): void {
  const w = fluid > 1 ? 1 : fluid;
  const vy0 = rel.y;
  let vy1 = vy0 + (-gravity + buoyancy * w) * DT;
  vy1 *= w > 0 ? 1 + (ITEM_WATER_DRAG - 1) * w : ITEM_AIR_DRAG;
  if (vy1 < -ITEM_TERMINAL_SPEED) vy1 = -ITEM_TERMINAL_SPEED;
  let hk = e.onGround ? ITEM_GROUND_FRICTION : ITEM_AIR_DRAG;
  if (w > 0) hk *= ITEM_WATER_DRAG;
  rel.x *= hk;
  rel.z *= hk;
  // Settle completely instead of creeping forever by ever smaller amounts.
  if (Math.abs(rel.x) < 1e-3) rel.x = 0;
  if (Math.abs(rel.z) < 1e-3) rel.z = 0;
  out.x = rel.x * DT;
  out.z = rel.z * DT;
  out.y = (vy0 + vy1) * 0.5 * DT;
  rel.y = vy1;
}
