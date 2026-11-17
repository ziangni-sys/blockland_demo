/**
 * Directions and axes. Coordinate system: +X east, +Y up, +Z south (right-handed).
 * A cell (x,y,z) occupies the cube [x,x+1) x [y,y+1) x [z,z+1).
 */

export type Dir = 0 | 1 | 2 | 3 | 4 | 5;
export type Axis = 0 | 1 | 2;

export const PX: Dir = 0; // east
export const NX: Dir = 1; // west
export const PY: Dir = 2; // up
export const NY: Dir = 3; // down
export const PZ: Dir = 4; // south
export const NZ: Dir = 5; // north

export const AXIS_X: Axis = 0;
export const AXIS_Y: Axis = 1;
export const AXIS_Z: Axis = 2;

export const ALL_DIRS: readonly Dir[] = [0, 1, 2, 3, 4, 5];
export const HORIZONTAL_DIRS: readonly Dir[] = [PX, NX, PZ, NZ];

export const DIR_X: readonly number[] = [1, -1, 0, 0, 0, 0];
export const DIR_Y: readonly number[] = [0, 0, 1, -1, 0, 0];
export const DIR_Z: readonly number[] = [0, 0, 0, 0, 1, -1];

/** Opposite direction: dir ^ 1. */
export function opposite(d: Dir): Dir {
  return (d ^ 1) as Dir;
}
/** Axis of a direction (0 x, 1 y, 2 z): dir >> 1. */
export function dirAxis(d: Dir): Axis {
  return (d >> 1) as Axis;
}
/** +1 for PX/PY/PZ, -1 for NX/NY/NZ. */
export function dirSign(d: Dir): 1 | -1 {
  return (d & 1) === 0 ? 1 : -1;
}
/** Direction from an axis and a sign. */
export function dirOf(axis: Axis, positive: boolean): Dir {
  return ((axis << 1) | (positive ? 0 : 1)) as Dir;
}
export const DIR_NAMES: readonly string[] = ['east', 'west', 'up', 'down', 'south', 'north'];

/**
 * Closest axis direction to a vector (largest absolute component).
 * Ties resolve in x, y, z order.
 */
export function nearestDir(x: number, y: number, z: number): Dir {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? PX : NX;
  if (ay >= az) return y >= 0 ? PY : NY;
  return z >= 0 ? PZ : NZ;
}

/**
 * Horizontal direction a viewer with the given yaw is looking toward.
 * Yaw convention (whole game): yaw 0 looks toward -Z (north); yaw grows turning LEFT
 * (counter-clockwise seen from above). Forward = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)).
 */
export function horizontalDirFromYaw(yaw: number): Dir {
  return nearestDir(-Math.sin(yaw), 0, -Math.cos(yaw));
}
