import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PX, PY, PZ } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { Simulation } from '../../src/sim/simulation';
import { TerrainGenerator } from '../../src/worldgen/generator';
import { fill } from './helpers';
import { soloSim } from '../solo';

/** Every input the random walk may have left set. */
function releaseInput(sim: Simulation): void {
  const inp = sim.soloPlayer.player.input;
  inp.forward = 0;
  inp.strafe = 0;
  inp.jump = false;
  inp.sneak = false;
  inp.sprint = false;
  inp.attack = false;
  inp.use = false;
}

/**
 * One scripted round of the core gameplay, built in a cleared box of air above the player and
 * driven only through the public surface (useOn, hold, input): glue two planks, pour and scoop
 * water, light a blast crate, assemble a raft at its helm and steer it, start / run / stop a
 * windmill, blow a crate up next to the raft, try to dock it with an empty hand. The scene does
 * not depend on the terrain under it; what the random walk did before may still interfere, and
 * that is the point of a soak.
 */
function playRound(sim: Simulation): void {
  releaseInput(sim);
  if (sim.soloPlayer.player.dead) sim.soloPlayer.respawn();
  const mode = sim.soloPlayer.player.mode;
  sim.soloPlayer.setMode('creative');
  const p = sim.soloPlayer.player;
  const w = sim.world;
  const bx = Math.floor(p.pos.x);
  const bz = Math.floor(p.pos.z);
  const by = Math.min(100, Math.floor(p.pos.y) + 8);
  fill(w, bx - 7, by - 1, bz - 8, bx + 8, by + 9, bz + 7, B.AIR);
  fill(w, bx - 2, by - 1, bz - 2, bx + 2, by - 1, bz + 2, B.STONE);
  sim.soloPlayer.teleport(bx + 0.5, by, bz + 0.5);
  p.flying = false;
  sim.advance(2);

  // glue: anchor, then the neighbour
  w.setCell(bx, by, bz - 3, makeCell(B.PLANKS_OAK));
  w.setCell(bx + 1, by, bz - 3, makeCell(B.PLANKS_OAK));
  sim.soloPlayer.hold(I.GLUE, 8);
  sim.soloPlayer.useOn(bx, by, bz - 3, PY);
  sim.soloPlayer.useOn(bx + 1, by, bz - 3, PY);

  // bucket: pour onto a stone, scoop the source back
  w.setCell(bx - 2, by, bz - 3, makeCell(B.STONE));
  sim.soloPlayer.hold(I.BUCKET_WATER, 1);
  sim.soloPlayer.useOn(bx - 2, by, bz - 3, PY);
  sim.soloPlayer.hold(I.BUCKET, 1);
  sim.soloPlayer.useOn(bx - 2, by + 1, bz - 3);

  // blast crate: light it with an empty hand, back off, wait for the bang
  w.setCell(bx + 3, by, bz - 3, makeCell(B.TNT));
  sim.soloPlayer.emptyHand();
  sim.soloPlayer.useOn(bx + 3, by, bz - 3, PY);
  sim.soloPlayer.teleport(bx - 5, by + 6, bz + 6);
  p.flying = true;
  sim.advance(85);

  // raft: preview, assemble (takes the wheel), steer, let go
  const ry = by + 4;
  fill(w, bx - 2, ry, bz - 4, bx + 1, ry, bz - 1, B.PLANKS_OAK);
  w.setCell(bx - 1, ry + 1, bz - 1, makeCell(B.HELM, facingState(NZ)));
  sim.soloPlayer.teleport(bx - 0.5, ry + 1, bz + 1.5);
  p.flying = true;
  sim.tick();
  sim.soloPlayer.useOn(bx - 1, ry + 1, bz - 1, PZ);
  sim.soloPlayer.useOn(bx - 1, ry + 1, bz - 1, PZ);
  p.input.forward = 1;
  p.input.strafe = 1;
  sim.advance(20);
  p.input.forward = 0;
  p.input.strafe = 0;
  sim.soloPlayer.use();
  sim.tick();

  // windmill on the world: preview, start, run, stop
  const wy = by + 2;
  fill(w, bx + 4, by, bz + 3, bx + 4, wy, bz + 3, B.STONE);
  w.setCell(bx + 5, wy, bz + 3, makeCell(B.BEARING, facingState(PX)));
  for (const [dy, dz] of [[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, -1]] as const) {
    w.setCell(bx + 6, wy + dy, bz + 3 + dz, makeCell(B.CANVAS));
  }
  sim.soloPlayer.teleport(bx + 5.5, wy - 1, bz + 6.5);
  p.flying = true;
  sim.tick();
  sim.soloPlayer.useOn(bx + 5, wy, bz + 3, PZ);
  sim.soloPlayer.useOn(bx + 5, wy, bz + 3, PZ);
  sim.advance(40);
  sim.soloPlayer.useOn(bx + 5, wy, bz + 3, PZ);

  // a blast off the raft's bow (pushes it, may tear off its front), then a docking attempt from
  // above its helm at the stern
  const ship = sim.structures.ships()[0];
  if (ship !== undefined) {
    const c = ship.grid.toWorld({ x: ship.helmX + 0.5, y: ship.helmY + 0.5, z: ship.helmZ - 5.5 });
    sim.entities.spawnTnt(c.x, c.y, c.z, 5);
    sim.advance(10);
    if (!ship.removed) {
      const h = ship.grid.toWorld({ x: ship.helmX + 0.5, y: ship.helmY + 0.5, z: ship.helmZ + 0.5 });
      sim.soloPlayer.teleport(h.x, h.y + 1.5, h.z);
      p.flying = true;
      sim.soloPlayer.emptyHand();
      p.input.sneak = true;
      sim.soloPlayer.lookAtCell(ship.helmX, ship.helmY, ship.helmZ, PY, ship.id);
      sim.soloPlayer.use();
      sim.tick();
      p.input.sneak = false;
    }
  }
  sim.soloPlayer.setMode(mode);
  if (mode === 'survival') p.flying = false;
}

/**
 * 2000 ticks on generated terrain: random-walk input (walking, jumping, sneaking, looking
 * around, clicking with blocks, glue, buckets, blast crates and an empty hand) with three
 * scripted rounds of the core gameplay mixed in. Must never throw; every kind of gameplay
 * event must have happened; reports the average tick time (chunk generation is synchronous
 * here and included).
 */
describe('soak', () => {
  it('2000 ticks of random and scripted play on generated terrain', () => {
    const seed = 424242;
    const sim = soloSim({ seed, mode: 'survival', generator: new TerrainGenerator(seed), syncChunks: true, loadRadius: 3 });
    const rng = new Rng(99);
    const p = sim.soloPlayer.player;
    const kit: Array<number | null> = [B.PLANKS_OAK, B.STONE, B.TORCH, B.SAND, I.GLUE, I.BUCKET_WATER, B.TNT, null, B.CANVAS];
    for (let i = 0; i < kit.length; i++) {
      const it = kit[i];
      p.inventory.hotbar[i] = it === null || it === undefined ? null : { item: it, count: 64 };
    }
    const kinds = new Map<string, number>();
    const sounds = new Map<string, number>();
    const toasts = new Map<string, number>();
    sim.events.on((e) => {
      kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
      if (e.type === 'sound') sounds.set(e.name, (sounds.get(e.name) ?? 0) + 1);
      if (e.type === 'toast') toasts.set(e.message.key, (toasts.get(e.message.key) ?? 0) + 1);
    });
    const rounds = new Set([300, 1000, 1700]);
    let worst = 0;
    const ticks0 = sim.ticks;
    const t0 = performance.now();
    for (let tick = 0; tick < 2000; tick++) {
      if (rounds.has(tick)) playRound(sim);
      const inp = sim.soloPlayer.player.input;
      if (tick % 10 === 0) {
        inp.forward = rng.int(-1, 1);
        inp.strafe = rng.int(-1, 1);
        inp.sneak = rng.chance(0.15);
        inp.sprint = rng.chance(0.3);
        inp.slot = rng.int(0, 8);
      }
      inp.jump = rng.chance(0.05);
      // Part of every 100 ticks the view holds still, so survival mining and gluing can finish.
      if (tick % 100 >= 40) {
        inp.yaw += rng.range(-0.15, 0.15);
        inp.pitch = Math.max(-1.4, Math.min(1.2, inp.pitch + rng.range(-0.1, 0.1)));
      }
      inp.attack = rng.chance(0.3);
      inp.use = rng.chance(0.2);
      if (rng.chance(0.08)) inp.usePresses++;
      if (rng.chance(0.08)) inp.attackPresses++;
      if (tick % 500 === 499) sim.soloPlayer.setMode(sim.soloPlayer.player.mode === 'survival' ? 'creative' : 'survival');
      if (sim.soloPlayer.player.dead) sim.soloPlayer.respawn();
      // keep the kit stocked
      for (let i = 0; i < kit.length; i++) {
        const k = kit[i];
        if (k === null || k === undefined) continue;
        const s = sim.soloPlayer.player.inventory.hotbar[i];
        if (s === null || s === undefined) sim.soloPlayer.player.inventory.hotbar[i] = { item: k, count: k === I.BUCKET_WATER ? 1 : 64 };
      }
      const a = performance.now();
      sim.tick();
      const dt = performance.now() - a;
      if (tick > 50 && dt > worst) worst = dt;
      expect(Number.isFinite(sim.soloPlayer.player.pos.x + sim.soloPlayer.player.pos.y + sim.soloPlayer.player.pos.z)).toBe(true);
    }
    const ticks = sim.ticks - ticks0;
    const avg = (performance.now() - t0) / ticks;
    console.log(
      `soak: ${ticks} ticks, avg tick ${avg.toFixed(2)} ms, worst random-walk tick ${worst.toFixed(1)} ms, chunks ${sim.world.chunks.size}, ` +
        `entities ${sim.entities.all().length}, structures ${sim.structures.all().length}, events ${JSON.stringify(Object.fromEntries(kinds))}, ` +
        `sounds ${JSON.stringify(Object.fromEntries(sounds))}, toasts ${JSON.stringify(Object.fromEntries(toasts))}, player (${sim.soloPlayer.player.pos.x.toFixed(1)}, ${sim.soloPlayer.player.pos.y.toFixed(1)}, ${sim.soloPlayer.player.pos.z.toFixed(1)})`,
    );
    // Every kind of gameplay happened, not just walking and mining.
    for (const k of ['blockBroken', 'blockPlaced', 'explosion', 'structureAdded', 'structureRemoved', 'toast']) {
      expect(kinds.get(k) ?? 0, k).toBeGreaterThan(0);
    }
    for (const s of ['glue', 'bucket_empty', 'bucket_fill', 'fuse']) expect(sounds.get(s) ?? 0, s).toBeGreaterThan(0);
    for (const t of ['toast.glue.added', 'toast.ship.assembled', 'toast.rotor.started', 'toast.rotor.stopped']) expect(toasts.get(t) ?? 0, t).toBeGreaterThan(0);
    expect((toasts.get('toast.dock.done') ?? 0) + (toasts.get('toast.dock.blocked') ?? 0) + (toasts.get('toast.dock.tilted') ?? 0)).toBeGreaterThan(0);
    expect(kinds.get('structureAdded') ?? 0).toBeGreaterThanOrEqual(6); // three rafts and three windmills
    expect(avg).toBeLessThan(25);
  }, 60_000);
});
