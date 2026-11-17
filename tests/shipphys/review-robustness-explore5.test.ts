// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import * as CR from '../../src/structures/physics/contacts';
import type { Rotor } from '../../src/structures/structure';
import { fillWorld, launch, makeSea, newRotor, plankBoat, setup, tick } from './helpers';

function blade(world: Parameters<typeof newRotor>[0], hx: number, hz: number, startAngle: number, len = 7): Rotor {
  const cells: Array<[number, number, number]> = [[hx, 47, hz]];
  for (let x = hx + 1; x <= hx + len; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, hz]);
  const r = newRotor(world, 100, hx, 47, hz, PY, cells);
  r.angle = startAngle;
  qfromAxisAngle(vec3(0, 1, 0), startAngle, r.grid.rotation);
  r.grid.snapshotPose();
  return r;
}

describe('explore5', () => {
  it('why pinned while sliding', () => {
    const world = makeSea();
    fillWorld(world, -9, 36, -40, -7, 52, 40, B.STONE);
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -6, 46, -6, 3, 3), dyn);
    const rotor = blade(world, 0, 0, (120 * Math.PI) / 180, 8);
    const d = dyn as any;
    const orig = d.pins.detect.bind(d.pins);
    let tickNo = 0;
    let printed = 0;
    d.pins.detect = (kin: any, ter: any, bodies: any, o: any) => {
      const n = orig(kin, ter, bodies, o);
      if (n > 0 && tickNo >= 3 && tickNo <= 5 && printed < 6) {
        printed++;
        const A = bodies[0];
        const f = kin.f;
        const lines: string[] = [];
        for (let i = 0; i < kin.count; i++) {
          const c = i * CR.STRIDE;
          if (f[c + CR.F_PIN] === 0) continue;
          lines.push(`n=(${f[c+CR.F_NX].toFixed(2)},${f[c+CR.F_NX+1].toFixed(2)},${f[c+CR.F_NX+2].toFixed(2)}) vo=(${f[c+CR.F_VO].toFixed(2)},${f[c+CR.F_VO+2].toFixed(2)}) depth=${f[c+CR.F_DEPTH].toFixed(3)} hascell=${f[c+CR.F_HASCELL]}`);
        }
        const tn: string[] = [];
        for (let i = A.terStart; i < A.terEnd; i++) {
          const c = i * CR.STRIDE;
          tn.push(`(${ter.f[c+CR.F_NX]},${ter.f[c+CR.F_NX+2]}) ln=${ter.f[c+CR.F_LN].toFixed(3)}`);
        }
        console.log(`tick ${tickNo}: boat v=(${A.vx.toFixed(2)},${A.vz.toFixed(2)}) w=${A.wy.toFixed(2)} pinned=${n}\n   ${lines.slice(0, 6).join('\n   ')}\n   terrain: ${tn.slice(0,6).join(' ')}`);
      }
      return n;
    };
    for (let t = 0; t < 8; t++) {
      tickNo = t;
      tick(dyn, [boat], [rotor], 1);
    }
  });
});
