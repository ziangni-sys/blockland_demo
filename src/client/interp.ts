/**
 * Smoothing for what is drawn. Pure. (Interpolating poses between ticks is the replica's job:
 * net/client/replica.ts places entities in their carrier's frame at renderTick; the own player is
 * shown by net/client/predict.ts OwnPlayer.displayPos.)
 */

/**
 * Frame-rate independent exponential approach of `current` toward `target`: after `dt`
 * seconds the remaining gap shrinks by exp(-rate * dt).
 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  if (!(dt > 0)) return current;
  return target + (current - target) * Math.exp(-rate * dt);
}
