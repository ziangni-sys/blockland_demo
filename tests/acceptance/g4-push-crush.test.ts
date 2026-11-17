import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { NZ, PX, PZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import {
  assemble,
  buildBoat,
  buildWindmill,
  copy,
  depthIn,
  drops,
  extent,
  fill,
  hullCentres,
  hullSamples,
  idAt,
  seaSim,
  shipStats,
  startWindmillByClicks,
  type Cell3,
} from './g4-push-crush-helpers';
describe('explore', () => {
  for (const cfg of ['A', 'B']) it('classic windmill corner ' + cfg, () => {
    const sim = seaSim('survival', vec3(1.5, 32, -2.5));
    fill(sim, 1, 20, -3, 1, 31, -3, B.STONE);
    const helm = buildBoat(sim, -4, -1, -2, 1, 29, NZ);
    if (cfg === 'A') {
      fill(sim, 1, 20, -1, 3, 31, 4, B.STONE); // east wall face x=1
      fill(sim, -7, 20, 2, 0, 31, 3, B.STONE); // south wall face z=2
    } else {
      fill(sim, 1, 20, -1, 3, 31, 4, B.STONE);
      fill(sim, -7, 20, 3, 0, 31, 4, B.STONE); // south wall face z=3 (1 gap)
    }
    sim.advance(2);
    const ship = assemble(sim, helm);
    sim.advance(60);
    const canvas: Cell3[] = [[0, 32, 0]];
    for (let k = 1; k <= 4; k++) canvas.push([k, 32, 0], [-k, 32, 0], [0, 32 + k, 0], [0, 32 - k, 0]);
    const bearing = buildWindmill(sim, [0, 32, -1], PZ, canvas);
    sim.advance(2);
    const rotor = startWindmillByClicks(sim, bearing, PX);
    const n0 = ship.grid.count;
    const solid = (x: number, y: number, z: number) => SOLID[idAt(sim.world, x, y, z)] === 1;
    let maxPen = 0;
    let centreIn = 0;
    for (let i = 0; i < 400 && !ship.removed; i++) {
      const c = ship.grid.count;
      sim.tick();
      if (ship.removed) break;
      const st = shipStats(sim, ship);
      const e = extent(hullSamples(ship));
      for (const p of hullSamples(ship)) maxPen = Math.max(maxPen, depthIn(solid, p));
      for (const p of hullCentres(ship)) if (solid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) centreIn++;
      if (i % 10 === 0 || ship.grid.count !== c) console.log(i, rotor.angle.toFixed(2), ship.grid.count, st.rotorContacts, st.pinned, e.minX.toFixed(2), e.maxX.toFixed(2), e.minY.toFixed(2), e.minZ.toFixed(2), e.maxZ.toFixed(2), maxPen.toFixed(3));
    }
    console.log('end', ship.removed, ship.grid.count, n0, drops(sim), maxPen, centreIn);
  });
});
void expect; void copy;
