/**
 * The three rays as pure functions (src/sim/rays.ts; NETCODE section 10): the plain ray, the glue
 * ray through soft blocks, the bucket ray and the water a hull displaces, cellDisplaced; and that
 * a server-driven player's hands cast exactly these.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PY, PZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { REACH, castRay, cellDisplaced, glueTargetable, isBucket, lookDir, rayKindOf, rayPredicate, type RayScene } from '../../src/sim/rays';
import { analyzeHull } from '../../src/structures/hull';
import type { Ship } from '../../src/structures/structure';
import { targetable, targetableOrLiquidSource } from '../../src/voxel/raycast';
import { FLAT_TOP, SEA_TOP, fill, flatSim, seaSim } from './helpers';

const T = FLAT_TOP;

describe('rays (sim/rays.ts)', () => {
  it('the use ray follows the held item; the predicates', () => {
    expect(rayKindOf(-1)).toBe('plain');
    expect(rayKindOf(B.PLANKS_OAK)).toBe('plain');
    expect(rayKindOf(I.GLUE)).toBe('glue');
    for (const b of [I.BUCKET, I.BUCKET_WATER, I.BUCKET_LAVA]) {
      expect(isBucket(b)).toBe(true);
      expect(rayKindOf(b)).toBe('bucket');
    }
    expect(rayPredicate('plain')).toBe(targetable);
    expect(rayPredicate('glue')).toBe(glueTargetable);
    expect(rayPredicate('bucket')).toBe(targetableOrLiquidSource);
    expect(glueTargetable(makeCell(B.TORCH))).toBe(false);
    expect(glueTargetable(makeCell(B.STONE))).toBe(true);
    expect(REACH).toBe(5);
  });

  it('lookDir: yaw 0 looks toward -Z, yaw grows turning left, pitch > 0 up (ARCHITECTURE 朝向)', () => {
    const d = lookDir(0, 0);
    expect([d.x, d.y, d.z].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-0, 0, -1]);
    const l = lookDir(Math.PI / 2, 0);
    expect(l.x).toBeCloseTo(-1, 12);
    expect(lookDir(0, Math.PI / 2).y).toBeCloseTo(1, 12);
  });

  it('plain stops at the torch in front of a block; glue passes through it to the block; nothing beyond REACH', () => {
    const sim = flatSim();
    sim.world.setCell(0, T, -3, makeCell(B.STONE));
    sim.world.setCell(0, T, -2, makeCell(B.TORCH));
    const scene = sim.interaction.rayScene();
    const eye = vec3(0.5, T + 0.5, 0.5);
    const dir = vec3(0, 0, -1);
    expect(castRay(scene, eye, dir, 'plain')).toMatchObject({ x: 0, y: T, z: -2, face: PZ });
    expect(castRay(scene, eye, dir, 'glue')).toMatchObject({ x: 0, y: T, z: -3, face: PZ });
    expect(castRay(scene, eye, dir, 'glue', 2)).toBeNull(); // its face is 2.5 away
    sim.world.setCell(0, T, -2, makeCell(B.AIR));
    sim.world.setCell(0, T, -3, makeCell(B.AIR));
    sim.world.setCell(0, T, -6, makeCell(B.STONE));
    expect(castRay(scene, eye, dir, 'plain')).toBeNull(); // 6 blocks away
  });

  it('bucket: stops at a world water source, not behind a hull; the water a hull displaces is passed through (cellDisplaced)', () => {
    const sim = seaSim({ spawn: { x: 2.5, y: SEA_TOP + 8, z: 12.5 } });
    const w = sim.world;
    // A 3x3 plank floor with walls, floor at y 28: its hold (y 29) is below the waterline.
    fill(w, 0, SEA_TOP - 2, 0, 4, SEA_TOP - 2, 4, B.PLANKS_OAK);
    for (let y = SEA_TOP - 1; y <= SEA_TOP; y++) {
      for (let i = 0; i <= 4; i++) {
        w.setCell(i, y, 0, makeCell(B.PLANKS_OAK));
        w.setCell(i, y, 4, makeCell(B.PLANKS_OAK));
        w.setCell(0, y, i, makeCell(B.PLANKS_OAK));
        w.setCell(4, y, i, makeCell(B.PLANKS_OAK));
      }
    }
    w.setCell(1, SEA_TOP - 1, 1, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(1, SEA_TOP - 1, 1);
    if (!res.ok) throw new Error(res.reason);
    const ship: Ship = res.structure;
    const scene: RayScene = { grids: sim.grids(), ships: [{ grid: ship.grid, hull: analyzeHull(ship.grid) }] };
    // Straight down into the hold: the hidden world water (y 29) is skipped, the floor is hit.
    const down = vec3(0, -1, 0);
    const hold = castRay(scene, vec3(2.5, SEA_TOP + 1.5, 2.5), down, 'bucket');
    expect(hold).toMatchObject({ y: SEA_TOP - 2 });
    expect(hold!.grid).toBe(ship.grid);
    // Outside the boat the open sea's surface source is hit.
    const sea = castRay(scene, vec3(8.5, SEA_TOP + 1.5, 2.5), down, 'bucket');
    expect(sea).toMatchObject({ x: 8, y: SEA_TOP - 1, z: 2, face: PY });
    expect(sea!.grid.isWorld).toBe(true);
    // The plain ray ignores water: it goes down to the sea floor (out of reach here).
    expect(castRay(scene, vec3(8.5, SEA_TOP + 1.5, 2.5), down, 'plain')).toBeNull();
    // cellDisplaced: the hold cell is all inside the dry hold; the open sea's is not.
    expect(cellDisplaced(scene.ships, 2, SEA_TOP - 1, 2)).toBe(true);
    expect(cellDisplaced(scene.ships, 8, SEA_TOP - 1, 2)).toBe(false);
    expect(cellDisplaced([], 2, SEA_TOP - 1, 2)).toBe(false);
  });

  it('a server-driven player\'s hands cast exactly these rays (use ray of the held item, mining ray plain)', () => {
    const sim = flatSim();
    const me = sim.soloPlayer;
    sim.world.setCell(0, T, -3, makeCell(B.STONE));
    sim.world.setCell(0, T, -2, makeCell(B.TORCH));
    me.lookAtCell(0, T, -3, PZ);
    me.hold(I.GLUE);
    const p = me.player;
    const scene = sim.interaction.rayScene();
    const glue = castRay(scene, p.eyePos(), lookDir(p.yaw, p.pitch), 'glue');
    const plain = castRay(scene, p.eyePos(), lookDir(p.yaw, p.pitch), 'plain');
    expect(me.targetCell()).toEqual({ gridId: 0, x: glue!.x, y: glue!.y, z: glue!.z, face: glue!.face });
    expect(me.mineTargetCell()).toEqual({ gridId: 0, x: plain!.x, y: plain!.y, z: plain!.z, face: plain!.face });
    expect(glue!.z).toBe(-3);
    expect(plain!.z).toBe(-2);
  });
});
