/**
 * Child-process probe for tests/render/players-alloc.test.ts (not a test file itself): heap bytes
 * per frame of the other players' path, measured like tests/drive/alloc-probe.ts (bundled with
 * rolldown, V8's sampling heap profiler, best of several rounds of optimised code).
 *
 * Cases:
 *  - 'view builder': ViewBuilder.updateEntities over a scene whose entity list is reused (the
 *    replica's own entities() allocates its list each call, which is not this package's), three
 *    players and the own player in third person, two of them on a moving, turning structure;
 *  - 'renderer': EntityLayer.set + animate for those four players (walking, name tags, held items,
 *    postures), the backend built without a GPU.
 */
import { Session } from 'node:inspector/promises';
import { qfromYaw, vec3 } from '../../src/core/math';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import type { EntityView } from '../../src/net/client/replica';
import type { EntityRenderState } from '../../src/render/backend';
import { ThreeBackend } from '../../src/render/three/backend';
import type { EntityLayer } from '../../src/render/three/entities';
import { labelView } from '../../src/render/three/labels';
import { shownPlayer, ViewBuilder, type EntityScene } from '../../src/client/view';
import { StructureGrid } from '../../src/voxel/sgrid';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';

const CALLS = 20_000;
const ROUNDS = 6;
const CLEAN = 0.05;
/** Names as players pick them: the longest the player table allows (24 code points), CJK, Arabic. */
const NAMES = ['船长布拉姆船长布拉姆船长布拉姆', 'W'.repeat(24), 'سارة سارة سارة'];

// ---- the scene the view builder reads
const world = new World(1);
world.addChunk(new Chunk(0, 0));
const grid = new StructureGrid(9, world);
grid.pivot.x = 4;
grid.pivot.y = 50;
grid.pivot.z = 4;
grid.setPoseImmediate(vec3(4, 50, 4), qfromYaw(0));
const flags = { sneaking: false, sprinting: false, flying: false, dead: false, onGround: true };
function player(id: number, carrierId: number, held: number, name: string): EntityView & { pos: { x: number; y: number; z: number } } {
  return { id, kind: 'player', pos: vec3(id, 50, 0), yaw: 0, carrierId, pitch: 0.1, look: { pitch: 0.1, flags }, player: { flags, steeringShipId: 0, heldItem: held }, name, item: 0, count: 0, cell: 0, fuse: 0 };
}
const views = [player(1, 9, B.PLANKS_OAK, NAMES[0]!), player(2, 9, I.GLUE, NAMES[1]!), player(3, 0, 0, NAMES[2]!)];
const scene = {
  world,
  entities: () => views,
  structures: () => [],
  state: { structures: new Map([[9, { structure: { grid } }]]) },
} as unknown as EntityScene;
const view = new ViewBuilder();
(view as unknown as { showSelf: boolean }).showSelf = true;
const me = shownPlayer();
me.id = 100;
const local = vec3();
let tick = 0;
const q = qfromYaw(0);
function viewFrame(): number {
  tick += 1 / 3;
  // The structure sails and turns; 1 stands on it, 2 walks on it, 3 walks on land.
  grid.position.x = 6 + 2 * Math.sin(tick * 0.02);
  qfromYaw(tick * 0.01, q);
  grid.rotation.x = q.x;
  grid.rotation.y = q.y;
  grid.rotation.z = q.z;
  grid.rotation.w = q.w;
  local.x = 2;
  local.y = 50;
  local.z = 2;
  grid.toWorld(local, views[0]!.pos);
  local.x = 2 + Math.sin(tick * 0.1);
  grid.toWorld(local, views[1]!.pos);
  views[2]!.pos.x = 10 + 3 * Math.sin(tick * 0.03);
  me.feet.x = 12 + 2 * Math.sin(tick * 0.05);
  const list = view.updateEntities(scene, me, tick, tick + 2);
  return list.length;
}

// ---- the renderer
const be = new ThreeBackend({ forceWebGL: true });
const bi = be as unknown as { buildPipelines(): void; ready: boolean; entities: EntityLayer };
bi.buildPipelines();
bi.ready = true;
const layer = bi.entities;
const lv = { ...labelView(), x: 0, y: 52, z: 10 };
const states: EntityRenderState[] = (['stand', 'sneak', 'sprint', 'helm'] as const).map((posture, i) => ({
  id: i + 1, kind: 'player', x: i * 2, y: 50, z: 0, yaw: 0, vx: 3, vy: 0, vz: 0, payload: 0, flash: 0, sky: 15, block: 0,
  headYaw: 0.3, headPitch: 0.2, held: i === 0 ? B.PLANKS_OAK : i === 1 ? I.GLUE : 0, posture, label: i === 3 ? null : NAMES[i]!,
}));
let time = 0;
function renderFrame(): number {
  time += 1 / 60;
  for (const s of states) {
    s.x = 8 + 4 * Math.sin(time + s.id);
    s.yaw = time * 0.1;
    s.headYaw = s.yaw + 0.3;
  }
  layer.set(states);
  layer.animate(time, lv);
  return layer.count;
}

const cases: Record<string, (n: number) => number> = {
  'view builder': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += viewFrame();
    return s;
  },
  renderer: (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += renderFrame();
    return s;
  },
};

interface ProfileNode {
  selfSize: number;
  children: ProfileNode[];
}
function totalBytes(n: ProfileNode): number {
  let s = n.selfSize;
  for (const c of n.children) s += totalBytes(c);
  return s;
}

const SAMPLING = { samplingInterval: 64, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true };
const session = new Session();
session.connect();
await session.post('HeapProfiler.enable');
await session.post('HeapProfiler.startSampling', SAMPLING as never);
await session.post('HeapProfiler.stopSampling');
const out: Record<string, number> = {};
let sink = 0;
for (const [name, run] of Object.entries(cases)) {
  let best = Infinity;
  for (let r = 0; r < ROUNDS && best > CLEAN; r++) {
    sink += run(CALLS * 2);
    await session.post('HeapProfiler.startSampling', SAMPLING as never);
    sink += run(CALLS);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
    best = Math.min(best, totalBytes(profile.head) / CALLS);
  }
  out[name] = best;
}
session.disconnect();
process.stdout.write(JSON.stringify({ bytesPerCall: out, sink, labels: layer.labels.size }) + '\n');
