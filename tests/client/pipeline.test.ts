/**
 * The client's replica -> backend pipeline: section meshing on a World, the terrain source, and
 * the WorldSession with its structure renderer and view builder against a real server (rig.ts:
 * a ServerHost on a virtual clock, the session connected over a loopback link, a recording fake
 * backend, no workers: every pool is null, so the main-thread fallbacks run).
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { makeCell, facingState } from '../../src/blocks/cell';
import { NZ } from '../../src/core/dirs';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { FlatGenerator } from '../../src/worldgen/generator';
import type { GenErrorResponse, GenResponse } from '../../src/worldgen/protocol';
import { sectionKey } from '../../src/voxel/chunk';
import { SectionMesher, isTriviallyEmpty } from '../../src/client/meshing';
import { TerrainSource } from '../../src/client/terrain';
import { mediumAt, sampleLight } from '../../src/client/view';
import type { WorkerPool } from '../../src/client/workers';
import { snapshotSection } from '../../src/mesh/snapshot';
import { FLAT_TOP, RecordingBackend, SessionRig, flatWorld } from './rig';

const noErrors = (what: string, err: unknown): void => {
  throw new Error(`${what}: ${String(err)}`);
};

function meshAll(m: SectionMesher): void {
  // Until nothing is waiting and the queue only holds sections whose neighbours are missing.
  let stable = 0;
  for (let i = 0; i < 400 && stable < 3; i++) {
    const before = m.stats.installed;
    m.update(0, 1e9, 0.5, FLAT_TOP, 0.5, 0, -1);
    stable = m.stats.installed === before && m.stats.waiting === 0 ? stable + 1 : 0;
  }
}

describe('isTriviallyEmpty', () => {
  it('detects all-air and all-opaque boxes', () => {
    const world = flatWorld(1);
    expect(isTriviallyEmpty(snapshotSection(world, 0, 7, 0))).toBe(true); // sky
    expect(isTriviallyEmpty(snapshotSection(world, 0, 0, 0))).toBe(true); // buried stone + deeprock
    expect(isTriviallyEmpty(snapshotSection(world, 0, 2, 0))).toBe(false); // the surface (y = 35)
  });
});

describe('SectionMesher (main-thread fallback)', () => {
  it('meshes sections whose 8 neighbour chunks are loaded and nothing else', () => {
    const world = flatWorld(2);
    const backend = new RecordingBackend();
    const m = new SectionMesher(world, backend, null, () => 0, noErrors);
    meshAll(m);
    expect(backend.sections.size).toBeGreaterThan(0);
    for (const key of backend.sections.keys()) {
      const { ox, oy, oz } = backend.sections.get(key)!;
      const cx = ox / 16;
      const cz = oz / 16;
      expect(key).toBe(sectionKey(cx, oy / 16, cz));
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) expect(world.getChunk(cx + dx, cz + dz)).toBeDefined();
    }
    // the flat surface lies in section y 2 (y 32..47): the middle chunk has it
    expect(backend.sections.has(sectionKey(0, 2, 0))).toBe(true);
    expect(m.isSettled(sectionKey(0, 2, 0))).toBe(true);
    // sky sections are settled but have no mesh
    expect(m.isSettled(sectionKey(0, 7, 0))).toBe(true);
    expect(backend.sections.has(sectionKey(0, 7, 0))).toBe(false);
    // the outer ring lacks neighbours: never meshed
    expect(m.isSettled(sectionKey(2, 2, 0))).toBe(false);
  });

  it('remeshes after an edit and drops meshes when a chunk unloads', () => {
    const world = flatWorld(2);
    const backend = new RecordingBackend();
    const m = new SectionMesher(world, backend, null, () => 0, noErrors);
    meshAll(m);
    const installed = m.stats.installed;
    world.setCell(3, 40, 3, makeCell(B.BRICKS));
    m.update(0, 1e9, 0, 40, 0, 0, -1); // snapshot + mesh
    m.update(0, 1e9, 0, 40, 0, 0, -1); // install
    expect(m.stats.installed).toBeGreaterThan(installed);
    expect(backend.sections.has(sectionKey(0, 2, 0))).toBe(true);
    m.dropChunk(0, 0);
    for (let sy = 0; sy < 8; sy++) expect(backend.sections.has(sectionKey(0, sy, 0))).toBe(false);
    expect(m.isSettled(sectionKey(0, 2, 0))).toBe(false);
    m.dispose();
    expect(backend.sections.size).toBe(0);
  });
});

describe('TerrainSource', () => {
  it('generates on the main thread without a pool: at least one column per frame, the rest within the budget', () => {
    const gen = new FlatGenerator();
    let t = 0;
    const src = new TerrainSource(gen.spec(), null, () => t, noErrors);
    const got = new Map<string, Uint16Array>();
    for (let i = 0; i < 6; i++) src.generate(i, 0, (cells) => got.set(`${i},0`, cells));
    expect(got.size).toBe(0); // nothing is generated inside generate(): the frame pays for it
    // a frame with no time left: still one column
    src.pump(0, 0);
    expect(got.size).toBe(1);
    t = 0;
    src.pump(0, 1e9);
    expect(got.size).toBe(6);
    expect(got.get('3,0')).toEqual(gen.generate(3, 0));
    expect(src.stats.syncGenerated).toBe(6);
    expect(src.pending).toBe(0);
  });

  it('a generator that keeps failing delivers an empty column (after retries on later frames), so loading never hangs', () => {
    const errors: string[] = [];
    const src = new TerrainSource({ kind: 'terrain', seed: 1 }, null, () => 0, (what) => errors.push(what));
    (src as unknown as { generator: { generate: () => Uint16Array } }).generator = {
      generate: () => {
        throw new Error('generator bug');
      },
    };
    let cells: Uint16Array | null = null;
    src.generate(0, 0, (c) => (cells = c));
    src.pump(0, 1e9);
    src.pump(0, 1e9);
    expect(cells).toBeNull();
    src.pump(0, 1e9);
    expect(cells).not.toBeNull();
    expect(cells!.length).toBe(CHUNK_VOLUME);
    expect(cells!.every((c) => c === 0)).toBe(true);
    expect(errors.length).toBe(3);
  });

  it('with a pool: worker results wait for pump(); a worker that fails twice sends the column to the main thread; nothing is delivered after dispose()', () => {
    const jobs: Array<{ id: number; cx: number; cz: number; done: (r: GenResponse | GenErrorResponse) => void; fail: (reason: string) => void }> = [];
    const pool = {
      failed: false,
      submit(build: (id: number) => { cx: number; cz: number }, _t: unknown, done: (r: GenResponse | GenErrorResponse) => void, fail: (reason: string) => void): boolean {
        const req = build(jobs.length + 1);
        jobs.push({ id: jobs.length + 1, cx: req.cx, cz: req.cz, done, fail });
        return true;
      },
    } as unknown as WorkerPool<GenResponse | GenErrorResponse>;
    const errors: string[] = [];
    const src = new TerrainSource({ kind: 'terrain', seed: 5 }, pool, () => 0, (what) => errors.push(what));
    const got: string[] = [];
    src.generate(1, 2, () => got.push('1,2'));
    src.generate(3, 4, () => got.push('3,4'));
    expect(jobs.length).toBe(2);
    jobs[0]!.done({ type: 'gen', id: 1, cx: 1, cz: 2, cells: new Uint16Array(CHUNK_VOLUME) });
    expect(got).toEqual([]); // the worker's answer arrives between frames
    src.pump(0, 1e9);
    expect(got).toEqual(['1,2']);
    jobs[1]!.fail('crashed');
    expect(jobs.length).toBe(3); // retried in the pool
    jobs[2]!.fail('crashed');
    expect(errors).toEqual(['terrain worker']);
    src.pump(0, 1e9); // generated on the main thread
    expect(got).toEqual(['1,2', '3,4']);
    src.generate(5, 5, () => got.push('5,5'));
    src.dispose();
    jobs[3]!.done({ type: 'gen', id: 4, cx: 5, cz: 5, cells: new Uint16Array(CHUNK_VOLUME) });
    src.pump(0, 1e9);
    expect(got).toEqual(['1,2', '3,4']);
  });

  it('a world the terrain workers do not build (flat) is generated on the main thread even with a pool', () => {
    let submitted = 0;
    const pool = { failed: false, submit: () => (submitted++, true) } as unknown as WorkerPool<GenResponse | GenErrorResponse>;
    const src = new TerrainSource(new FlatGenerator().spec(), pool, () => 0, noErrors);
    let got = false;
    src.generate(0, 0, () => (got = true));
    src.pump(0, 1e9);
    expect(submitted).toBe(0);
    expect(got).toBe(true);
  });
});

describe('WorldSession (against a real server)', () => {
  it('reaches "loading done" once the area around the player is in the replica and meshed; only then does it predict and take input', async () => {
    const rig = await SessionRig.create({ viewRadius: 4 });
    const s = rig.session;
    expect(s.loadingProgress().done).toBe(false);
    expect(s.own).toBeNull();
    rig.playUntilReady();
    const prog = s.loadingProgress();
    expect(prog.done).toBe(true);
    expect(prog.progress).toBe(1);
    expect(prog.chunksLoaded).toBe(prog.chunksNeeded);
    expect(prog.sectionsReady).toBe(prog.sectionsNeeded);
    expect(prog.sectionsNeeded).toBe(25 * 8);
    expect(s.net.status).toBe('ready');
    expect(s.own).not.toBeNull();
    expect(s.intents).not.toBeNull();
    rig.run(200);
    expect(rig.backend.camera).not.toBeNull();
    expect(rig.backend.overlays).not.toBeNull();
    expect(rig.backend.sections.size).toBeGreaterThan(0);
    // the player is where the server has it (the world spawn)
    expect(s.shown.feet.x).toBeCloseTo(0.5);
    expect(s.shown.feet.y).toBeCloseTo(FLAT_TOP);
    expect(rig.errors).toEqual([]);
    s.dispose();
    expect(rig.backend.sections.size).toBe(0);
    expect(rig.backend.entities).toEqual([]);
  });

  it('the structure renderer meshes a ship as soon as it is assembled, poses it every frame and removes it when it is gone', async () => {
    const y = FLAT_TOP;
    const rig = await SessionRig.create({
      setup: (sim) => {
        for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) sim.world.setCell(x, y, z, makeCell(B.PLANKS_OAK));
        sim.world.setCell(4, y + 1, 4, makeCell(B.HELM, facingState(NZ)));
      },
    });
    rig.playUntilReady();
    const res = rig.sim.structures.assembleShip(4, y + 1, 4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    rig.runUntil(() => rig.backend.structures.has(ship.id));
    const replicaShip = rig.session.replica!.state.structures.get(ship.id)!.structure;
    expect(rig.backend.structures.get(ship.id)).toEqual({ ox: 2, oy: y, oz: 2 });
    const pose = rig.backend.poses.get(ship.id)!;
    expect(pose.pivotX).toBeCloseTo(replicaShip.grid.pivot.x);
    expect(pose.px).toBeCloseTo(replicaShip.grid.position.x);
    expect(pose.sky).toBeGreaterThan(0);
    expect(rig.session.structures.allMeshed(rig.session.replica!)).toBe(true);
    // editing the ship on the server remeshes it on the client
    const meshed = rig.backend.structures.get(ship.id);
    ship.grid.setCell(2, y + 1, 2, makeCell(B.PLANKS_OAK));
    rig.runUntil(() => rig.backend.structures.get(ship.id) !== meshed);
    // the structure leaves -> its mesh is removed
    rig.sim.structures.dockShip(ship);
    rig.runUntil(() => !rig.backend.structures.has(ship.id));
    expect(rig.backend.structures.size).toBe(0);
    expect(rig.errors).toEqual([]);
  });

  it('the view builder puts the camera at the eyes and lists every entity but the player (first person)', async () => {
    const rig = await SessionRig.create();
    rig.playUntilReady();
    const s = rig.session;
    rig.sim.entities.spawnItem(2.5, FLAT_TOP + 0.5, 0.5, B.STONE, 3);
    rig.runUntil(() => rig.backend.entities.length === 1);
    s.held.yaw = 0.5;
    s.held.pitch = -0.2;
    rig.run(100);
    const cam = rig.backend.camera!;
    expect(cam.x).toBeCloseTo(0.5);
    expect(cam.y).toBeCloseTo(FLAT_TOP + 1.62);
    expect(cam.yaw).toBeCloseTo(0.5);
    expect(cam.pitch).toBeCloseTo(-0.2);
    expect(cam.fov).toBeCloseTo(70);
    const list = rig.backend.entities;
    expect(list.length).toBe(1);
    expect(list[0]!.kind).toBe('item');
    expect(list[0]!.payload).toBe(B.STONE);
    expect(list[0]!.sky).toBe(15);
    const env = rig.backend.env!;
    expect(env.viewDistance).toBe(64);
    expect(env.submerged).toBe('none');
    expect(env.dayTime).toBeGreaterThanOrEqual(0);
    expect(env.dayTime).toBeLessThan(1);
  });

  it('detects water above and below its surface; light comes from the replica (the server has none)', () => {
    const world = flatWorld(1);
    world.setCell(1, 35, 1, makeCell(B.WATER, 0));
    world.setCell(1, 36, 1, makeCell(B.WATER, 0));
    expect(mediumAt(world, 1.5, 35.9, 1.5)).toBe('water'); // water above: full cell
    expect(mediumAt(world, 1.5, 36.5, 1.5)).toBe('water'); // source surface at 14/16
    expect(mediumAt(world, 1.5, 36.95, 1.5)).toBe('none');
    expect(mediumAt(world, 1.5, 40, 1.5)).toBe('none');
    const light = { sky: 0, block: 0 };
    sampleLight(world, 0.5, 34.5, 0.5, light); // inside turf -> samples the cell above
    expect(light.sky).toBe(15);
  });

  it('turns the private view into overlays: the outline is the client\'s own target, cracks only on it, the preview list cached', async () => {
    const rig = await SessionRig.create();
    rig.playUntilReady();
    const s = rig.session;
    rig.lookAt(1.5, FLAT_TOP - 0.5, 1.5);
    rig.run(100);
    const target = s.intents!.useTarget!;
    expect(target).toMatchObject({ gridId: 0, x: 1, y: FLAT_TOP - 1, z: 1, face: 2 });
    const view = s.replica!.state.private.view;
    view.mining = { gridId: 0, x: 1, y: FLAT_TOP - 1, z: 1, sub: 0, progress: 2 };
    view.preview = { gridId: 0, kind: 'ship', cells: Int32Array.from([1, 34, 1, 2, 34, 1]) };
    view.conflicts = [{ x: 5, y: 6, z: 7 }];
    rig.frame();
    const o = rig.backend.overlays!;
    expect(o.target).toEqual({ structureId: 0, x: 1, y: FLAT_TOP - 1, z: 1 });
    expect(o.breakProgress).toBe(1);
    expect(o.preview.length).toBe(2);
    expect(o.conflicts).toEqual([{ structureId: 0, x: 5, y: 6, z: 7 }]);
    const previewList = o.preview;
    rig.frame();
    expect(rig.backend.overlays!.preview).toBe(previewList);
    // cracks of another cell are not drawn on the target
    view.mining = { gridId: 0, x: 9, y: FLAT_TOP - 1, z: 9, sub: 0, progress: 0.5 };
    rig.frame();
    expect(rig.backend.overlays!.breakProgress).toBe(0);
  });
});
