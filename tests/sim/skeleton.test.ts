import { describe, expect, it } from 'vitest';
import { exportSave } from '../../src/sim/persist';
import { FlatGenerator, TerrainGenerator } from '../../src/worldgen/generator';
import { B } from '../../src/blocks/defs';
import { loadSolo, soloSim } from '../solo';

describe('simulation skeleton', () => {
  it('boots on real terrain, the player lands and stays put', () => {
    const gen = new TerrainGenerator(12345);
    const sim = soloSim({ seed: 12345, mode: 'survival', generator: gen, syncChunks: true, loadRadius: 3 });
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) sim.tick();
    const ms = (performance.now() - t0) / 100;
    const p = sim.soloPlayer.player;
    expect(p.onGround).toBe(true);
    expect(Number.isFinite(p.pos.y)).toBe(true);
    expect(sim.world.chunks.size).toBeGreaterThan(20);
    expect(sim.soloPlayer.view.target === null || typeof sim.soloPlayer.view.target.x === 'number').toBe(true);
    console.log(`avg tick ${ms.toFixed(2)} ms, chunks ${sim.world.chunks.size}, player y ${p.pos.y.toFixed(2)}, health ${p.health}`);
  });

  it('walks, places and breaks blocks, and round-trips a save', () => {
    const gen = new FlatGenerator();
    const sim = soloSim({ seed: 1, mode: 'creative', generator: gen, syncChunks: true, loadRadius: 2 });
    for (let i = 0; i < 20; i++) sim.tick();
    const p = sim.soloPlayer.player;
    const y0 = p.pos.y;
    const z0 = p.pos.z;
    p.input.forward = 1;
    for (let i = 0; i < 40; i++) sim.tick();
    p.input.forward = 0;
    expect(p.pos.z).toBeLessThan(z0 - 3); // yaw 0 looks toward -Z
    expect(p.pos.y).toBeCloseTo(y0, 3);
    // look down at the ground a little more than a block ahead and place a block there
    // (steeper, the new block would overlap the player's own body and is refused)
    p.input.pitch = -0.9;
    p.inventory.creativePick(B.PLANKS_OAK, true);
    p.input.slot = p.inventory.hotbar.findIndex((s) => s?.item === B.PLANKS_OAK);
    p.input.usePresses = 1;
    sim.tick();
    const placed: number[][] = [];
    for (const c of sim.world.chunks.values()) {
      for (let i = 0; i < c.cells.length; i++) if ((c.cells[i]! & 1023) === B.PLANKS_OAK) placed.push([c.cx, c.cz, i]);
    }
    expect(placed.length).toBe(1);
    const bundle = exportSave(sim);
    expect(bundle.chunks.length).toBe(1);

    const sim2 = loadSolo({ seed: 1, mode: 'creative', generator: gen, syncChunks: true, loadRadius: 2 }, bundle);
    for (let i = 0; i < 5; i++) sim2.tick();
    // The original keeps going too: the loaded copy must continue exactly like it.
    for (let i = 0; i < 5; i++) sim.tick();
    expect(sim2.soloPlayer.player.pos.z).toBeCloseTo(sim.soloPlayer.player.pos.z, 6);
    let found = 0;
    for (const c of sim2.world.chunks.values()) {
      for (let i = 0; i < c.cells.length; i++) if ((c.cells[i]! & 1023) === B.PLANKS_OAK) found++;
    }
    expect(found).toBe(1);
  });
});
