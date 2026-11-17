/** Re-exports for the control tests plus an angle helper. */
export { launch, makeWorld, plankBoat, run, setup } from './helpers';

/** Wrap an angle to (-PI, PI]. */
export function wrap(a: number): number {
  const t = Math.PI * 2;
  a %= t;
  if (a > Math.PI) a -= t;
  else if (a <= -Math.PI) a += t;
  return a;
}
