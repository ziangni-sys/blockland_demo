/**
 * A structure held at ANY orientation, at rest (for the leaning-wall rules of the movement checks,
 * drive.ts leanOf / underLeaningWalls): a ship, a 5x5x5 planks cube with a mast eight cells long
 * standing on each of its six faces, assembled high above the sea, whose pose is set again after
 * every structure phase: rotation `q` about its centre of mass, no motion. The checks see a ship
 * and a rotor through the same StructRec (pose and grid), and a rotor on a world bearing turns
 * about one horizontal axis only (drum.ts); this one turns about any axis, so each of the three
 * grid axes can be the one nearest the vertical. The player is server-driven and stands on a
 * stone pad at sea level until a test teleports it.
 */
import { NZ } from '../../src/core/dirs';
import { qcopy, qrotate, vec3, type Quat, type Vec3 } from '../../src/core/math';
import type { Ship } from '../../src/structures/structure';
import { assemble, B, facingState, fill, makeCell, SEA_TOP, seaRun, type Run } from './scenes';

const Y0 = SEA_TOP + 12;
const MAST = 8;
/** The cube's centre, local. */
const C = vec3(4.5, Y0 + 2.5, 4.5);
const AXES = [vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1)];

export interface Pinned {
  readonly run: Run;
  readonly ship: Ship;
  /** The cube face on top (the local axis whose world image points up most): its outward normal, and two directions within it. */
  readonly n: Vec3;
  readonly t1: Vec3;
  readonly t2: Vec3;
  /** Tilt (degrees) of that axis from the world's vertical (what leanOf measures). */
  readonly lean: number;
  /** World direction of the mast on the face on top (unit). */
  readonly mast: Vec3;
  /** World point `up` above the face on top, (a, b) along (t1, t2) from the middle of its mast. */
  onFace(a: number, b: number, up?: number): Vec3;
}

export function pinned(q: Quat): Pinned {
  const run = seaRun('survival', vec3(12.5, SEA_TOP, 12.5), null);
  const sim = run.sim;
  const w = sim.world;
  fill(w, 11, SEA_TOP - 1, 11, 13, SEA_TOP - 1, 13, B.STONE);
  fill(w, 2, Y0, 2, 6, Y0 + 4, 6, B.PLANKS_OAK);
  fill(w, 4, Y0 + 5, 4, 4, Y0 + 4 + MAST, 4, B.PLANKS_OAK);
  fill(w, 4, Y0 - MAST, 4, 4, Y0 - 1, 4, B.PLANKS_OAK);
  fill(w, 7, Y0 + 2, 4, 6 + MAST, Y0 + 2, 4, B.PLANKS_OAK);
  fill(w, 2 - MAST, Y0 + 2, 4, 1, Y0 + 2, 4, B.PLANKS_OAK);
  fill(w, 4, Y0 + 2, 7, 4, Y0 + 2, 6 + MAST, B.PLANKS_OAK);
  fill(w, 4, Y0 + 2, 2 - MAST, 4, Y0 + 2, 1, B.PLANKS_OAK);
  // (The helm on a corner of the +Y face, away from its mast.)
  w.setCell(6, Y0 + 5, 6, makeCell(B.HELM, facingState(NZ)));
  const ship = assemble(sim, vec3(6, Y0 + 5, 6));
  if (ship.grid.count !== 125 + 6 * MAST + 1) throw new Error(`the pinned ship has ${ship.grid.count} cells`);
  const g = ship.grid;
  const pos = vec3(g.position.x, g.position.y, g.position.z);
  const rot: Quat = { x: q.x, y: q.y, z: q.z, w: q.w };
  const force = () => {
    qcopy(g.rotation, rot);
    qcopy(g.prevRotation, rot);
    g.position.x = g.prevPosition.x = pos.x;
    g.position.y = g.prevPosition.y = pos.y;
    g.position.z = g.prevPosition.z = pos.z;
    g.linearVelocity.x = g.linearVelocity.y = g.linearVelocity.z = 0;
    g.angularVelocity.x = g.angularVelocity.y = g.angularVelocity.z = 0;
  };
  const step = sim.structures.step.bind(sim.structures);
  sim.structures.step = () => {
    step();
    force();
  };
  force();
  for (let i = 0; i < 3; i++) sim.tick();
  let best = -2;
  let n = AXES[0]!;
  for (const a of AXES) {
    const wy = qrotate(rot, a).y;
    if (wy > best) {
      best = wy;
      n = a;
    }
  }
  const t1 = n.x !== 0 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  const t2 = n.z !== 0 ? vec3(0, 1, 0) : vec3(0, 0, 1);
  const onFace = (a: number, b: number, up = 0): Vec3 =>
    g.toWorld(vec3(C.x + n.x * (2.5 + up) + t1.x * a + t2.x * b, C.y + n.y * (2.5 + up) + t1.y * a + t2.y * b, C.z + n.z * (2.5 + up) + t1.z * a + t2.z * b));
  return { run, ship, n, t1, t2, lean: (Math.acos(Math.min(1, best)) * 180) / Math.PI, mast: qrotate(rot, n), onFace };
}
