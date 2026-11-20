/**
 * A structure turned by any angle about a horizontal axis, at rest: a "drum" on a world bearing,
 * the rotor stopped where it is (sails 0, as after a blast took them: rotorTargetSpeed; a stopped
 * rotor is editable, so players walk on it). Flat land (scenes.ts landRun); a stone post x 0,
 * y T..T+7; the bearing at (0, T+8, 0) facing +X; the rotor: an axle cell (1, T+8, 0) and a 5x5x5
 * wool cube x 2..6, y T+6..T+10, z -2..2, with a mast three cells long standing on each of its four
 * side faces (local +Y, -Y, +Z, -Z) at x = 4. Turned by more than 45 degrees the drum stands on
 * what were its walls, whichever face is on top; its mast there leans by the tilt's distance from
 * the nearest quarter turn (drive.ts leanOf).
 */
import { PX } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import type { Rotor } from '../../src/structures/structure';
import { B, facingState, fill, LAND_TOP, landRun, makeCell, type Run } from './scenes';

const T = LAND_TOP;

export interface Drum {
  readonly run: Run;
  readonly rotor: Rotor;
  /** The side face on top at this angle: its outward normal (local, along +-Y or +-Z), and the direction across the axis within it. */
  readonly n: Vec3;
  readonly t: Vec3;
  /** Local point `up` above the surface of the face on top, at local x, `across` along t from the face's middle (0: the mast's middle). */
  onFace(x: number, across: number, up?: number): Vec3;
}

/** The drum turned `deg` degrees about the X axis, at rest (5 ticks after it was set there); the player, server-driven, stands on the ground at (-3.5, T, 0.5). */
export function drum(deg: number): Drum {
  const run = landRun('survival', { x: -3.5, y: T, z: 0.5 }, null);
  const sim = run.sim;
  const w = sim.world;
  fill(w, 0, T, 0, 0, T + 7, 0, B.STONE);
  w.setCell(0, T + 8, 0, makeCell(B.BEARING, facingState(PX)));
  w.setCell(1, T + 8, 0, makeCell(B.WOOL_WHITE));
  fill(w, 2, T + 6, -2, 6, T + 10, 2, B.WOOL_WHITE);
  fill(w, 4, T + 11, 0, 4, T + 13, 0, B.WOOL_WHITE);
  fill(w, 4, T + 3, 0, 4, T + 5, 0, B.WOOL_WHITE);
  fill(w, 4, T + 8, 3, 4, T + 8, 5, B.WOOL_WHITE);
  fill(w, 4, T + 8, -5, 4, T + 8, -3, B.WOOL_WHITE);
  const res = sim.structures.startRotor(w, 0, T + 8, 0);
  if (!res.ok) throw new Error(`startRotor: ${res.reason}`);
  const rotor = res.structure;
  if (rotor.grid.count !== 138) throw new Error(`the drum has ${rotor.grid.count} cells, not 138`);
  rotor.sails = 0;
  rotor.angularSpeed = 0;
  rotor.angle = (deg * Math.PI) / 180;
  for (let i = 0; i < 5; i++) sim.tick();
  // The face on top: the local direction (of +-Y, +-Z) whose world image points up most.
  const g = rotor.grid;
  const o = g.toWorld(vec3(4.5, T + 8.5, 0.5));
  let best = -2;
  let n = vec3(0, 1, 0);
  for (const c of [vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1)]) {
    const p = g.toWorld(vec3(4.5 + c.x, T + 8.5 + c.y, 0.5 + c.z));
    if (p.y - o.y > best) {
      best = p.y - o.y;
      n = c;
    }
  }
  const t = n.y !== 0 ? vec3(0, 0, 1) : vec3(0, 1, 0);
  const onFace = (x: number, across: number, up = 0): Vec3 => vec3(x, T + 8.5 + n.y * (2.5 + up) + t.y * across, 0.5 + n.z * (2.5 + up) + t.z * across);
  return { run, rotor, n, t, onFace };
}
