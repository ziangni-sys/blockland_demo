// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { ID_MASK } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { NX, NZ, PX, PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import { bigShip, fillWorld, finite, hullSamplePoints, launch, makeSea, newRotor, plankBoat, setup, terrainPenetration, tick } from './helpers';

function blade(world: Parameters<typeof newRotor>[0], hx: number, hz: number, startAngle: number, len = 7): Rotor {
  const cells: Array<[number, number, number]> = [[hx, 47, hz]];
  for (let x = hx + 1; x <= hx + len; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, hz]);
  const r = newRotor(world, 100, hx, 47, hz, PY, cells);
  r.angle = startAngle;
  qfromAxisAngle(vec3(0, 1, 0), startAngle, r.grid.rotation);
  r.grid.snapshotPose();
  return r;
}

/** Deepest point of ship a's sample points inside ship b's hard cells (cell-depth approx). */
function shipOverlap(a: Ship, b: Ship): number {
  let worst = 0;
  const w = vec3();
  const l = vec3();
  for (const p of hullSamplePoints(a)) {
    a.grid.toWorld(p, w);
    b.grid.toLocal(w, l);
    const cx = Math.floor(l.x);
    const cy = Math.floor(l.y);
    const cz = Math.floor(l.z);
    if (SOLID[b.grid.getCell(cx, cy, cz) & ID_MASK] !== 1) continue;
    // distance to the nearest non-solid neighbour face along the 6 axes
    let best = 3;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      for (let k = 1; k <= 3; k++) {
        if (SOLID[b.grid.getCell(cx + dx * k, cy + dy * k, cz + dz * k) & ID_MASK] !== 1) {
          const f = dx > 0 ? cx + 1 - l.x : dx < 0 ? l.x - cx : dy > 0 ? cy + 1 - l.y : dy < 0 ? l.y - cy : dz > 0 ? cz + 1 - l.z : l.z - cz;
          best = Math.min(best, f + (k - 1));
          break;
        }
      }
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('explore4', () => {
  it('blade pushes an outer boat against an inner boat moored at a wall', () => {
    const world = makeSea();
    fillWorld(world, -12, 36, -20, -10, 52, 20, B.STONE); // west wall face x = -9
    const { dyn, host } = setup(world);
    const inner = launch(plankBoat(world, 1, -9, 46, -4, 3, 4, NZ), dyn); // x in [-9,-6)
    const outer = launch(plankBoat(world, 2, -6, 46, -4, 3, 4, NZ), dyn); // x in [-6,-3)
    // hub east; blade sweeps west at angle ~180 (pointing west, moving south)... choose a blade that pushes due west
    // vertical-axis rotor with hub at (0,47,-10): at angle 270 the blade points +Z (south) and moves -X (west).
    const rotor = blade(world, 0, 7, (60 * Math.PI) / 180, 10);
    let worst = 0;
    let pinned = 0;
    let wallPen = 0;
    for (let t = 0; t < 60; t++) {
      tick(dyn, [inner, outer], [rotor], 1);
      worst = Math.max(worst, shipOverlap(outer, inner), shipOverlap(inner, outer));
      pinned += dyn.getStats(outer)!.pinned;
      if (t >= 16 && t <= 30) console.log(`  t=${t} ter=${dyn.getStats(outer)!.terrainContacts} v=(${outer.grid.linearVelocity.x.toFixed(2)},${outer.grid.linearVelocity.z.toFixed(2)}) wy=${outer.grid.angularVelocity.y.toFixed(2)} destroyed=${dyn.getStats(outer)!.destroyed} ang=${(rotor.angle*180/Math.PI).toFixed(0)} inner=(${inner.grid.position.x.toFixed(2)},${inner.grid.position.z.toFixed(2)}) outer=(${outer.grid.position.x.toFixed(2)},${outer.grid.position.z.toFixed(2)}) rot=${dyn.getStats(outer)!.rotorContacts} ship=${dyn.getStats(outer)!.shipContacts} pinned=${dyn.getStats(outer)!.pinned} ov=${Math.max(shipOverlap(outer, inner), shipOverlap(inner, outer)).toFixed(3)} counts=${inner.grid.count},${outer.grid.count}`);
      wallPen = Math.max(wallPen, terrainPenetration(world, inner), terrainPenetration(world, outer));
    }
    console.log(
      `two boats: ship overlap max=${worst.toFixed(3)} pinned(outer)=${pinned}  drops=${host.drops.length} wallPen=${wallPen.toFixed(3)} innerX=${inner.grid.position.x.toFixed(2)} outerX=${outer.grid.position.x.toFixed(2)} finite=${finite(inner) && finite(outer)} counts=${inner.grid.count},${outer.grid.count}`,
    );
  });

  it('small boat squeezed between a big ship under throttle and a wall', () => {
    const world = makeSea();
    fillWorld(world, -40, 36, -40, 40, 52, -38, B.STONE); // north wall, face z = -37
    const { dyn } = setup(world);
    const small = launch(plankBoat(world, 2, -1, 46, -37, 3, 3, PX), dyn); // z in [-37,-34)
    const big = launch(bigShip(world, 1, 30, 10, 6, 1000, 46, -33), dyn); // bow at z = -33, heading -Z
    big.throttle = 1;
    big.sails = 40;
    let worst = 0;
    let wallPen = 0;
    for (let t = 0; t < 200; t++) {
      tick(dyn, [big, small], []);
      worst = Math.max(worst, shipOverlap(big, small), shipOverlap(small, big));
      wallPen = Math.max(wallPen, terrainPenetration(world, small));
    }
    console.log(`squeeze: ship overlap max=${worst.toFixed(3)} small wallPen=${wallPen.toFixed(3)} finite=${finite(big) && finite(small)} bigZ=${big.grid.position.z.toFixed(2)}`);
  });

  it('two boats ramming head on at full speed', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const a = launch(plankBoat(world, 1, -2, 47, 10, 3, 5, NZ), dyn); // heading -Z
    const b = launch(plankBoat(world, 2, -2, 47, -16, 3, 5, NX), dyn);
    // b heads +Z: rotate 180 about Y
    b.grid.rotation.x = 0; b.grid.rotation.y = 1; b.grid.rotation.z = 0; b.grid.rotation.w = 0;
    b.grid.snapshotPose();
    a.throttle = 1; a.sails = 40;
    b.throttle = 1; b.sails = 40; b.forward = 5;
    let worst = 0;
    for (let t = 0; t < 200; t++) {
      tick(dyn, [a, b], []);
      worst = Math.max(worst, shipOverlap(a, b), shipOverlap(b, a));
    }
    console.log(`ram: overlap max=${worst.toFixed(3)} finite=${finite(a) && finite(b)}`);
  });
});

void NX;

describe('explore4b', () => {
  it('blade pushes outer boat into inner boat sitting in a corner', () => {
    for (const start of [95, 100, 105, 110]) {
      const world = makeSea();
      fillWorld(world, -12, 36, -20, -10, 52, 20, B.STONE); // west wall face x = -9
      fillWorld(world, -12, 36, 0, 4, 52, 2, B.STONE); // south wall face z = 0 (z in [0,2])
      const { dyn, host } = setup(world);
      const inner = launch(plankBoat(world, 1, -9, 46, -4, 3, 4, NZ), dyn); // x in [-9,-6), z in [-4,0)
      const outer = launch(plankBoat(world, 2, -6, 46, -4, 3, 4, NZ), dyn); // x in [-6,-3), z in [-4,0)
      const rotor = blade(world, 2, 6, (start * Math.PI) / 180, 13); // hub north; blade pointing south sweeps west at angle 270..
      void rotor;
      // hub north at z=-12... at angle 270 the blade points +Z (south) and moves (-sin, -cos) = (1, 0): east. Use negative speed instead.
      let worst = 0;
      let pinned = 0;
      let contacts = 0;
      const a0 = rotor.angle;
      for (let t = 0; t < 70; t++) {
        tick(dyn, [inner, outer], [rotor], 1);
        worst = Math.max(worst, shipOverlap(outer, inner), shipOverlap(inner, outer));
        pinned += dyn.getStats(outer)!.pinned;
        contacts += dyn.getStats(outer)!.rotorContacts;
      }
      console.log(`corner start=${start} (a0=${(a0*180/Math.PI).toFixed(0)}) overlap max=${worst.toFixed(3)} contacts=${contacts} pinned=${pinned} counts=${inner.grid.count},${outer.grid.count} drops=${host.drops.length} inner=(${inner.grid.position.x.toFixed(2)},${inner.grid.position.z.toFixed(2)}) outer=(${outer.grid.position.x.toFixed(2)},${outer.grid.position.z.toFixed(2)})`);
    }
  });
});
