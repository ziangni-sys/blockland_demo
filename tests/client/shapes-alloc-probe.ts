/**
 * Child-process probe for tests/client/shapes-alloc.test.ts (not a test file itself): heap bytes
 * per call of the per-frame overlay and camera paths over partial cells, next to the same path
 * over whole blocks (docs/SHAPES.md 8.6: no geometry or object is made per frame; 4.4: per-frame
 * code never forms the packed value of a two-part cell). Bundled and run by tests/heap-probe-run.ts
 * in both inlining conditions; measured by tests/heap-probe.ts.
 *
 * Cases, each a pair (partial / whole):
 *  - 'overlays': ViewBuilder.updateOverlays with the target on the lower part of a two-part cell
 *    being mined (the crack condition reads both parts), or on a whole block being mined;
 *  - 'sweep' / 'clearance': the camera's sweep and clearance under a ceiling of upper half slabs,
 *    or of whole blocks; 'camera': ViewBuilder.updateCamera in 'back' under that ceiling;
 *  - 'light': sampleLight in a two-part cell, or in a whole block;
 *  - 'layer': OverlayLayer.update with the target switching between two part fills with cracks
 *    (cached geometry swapped) and glued faces over six quadrant masks, or on a whole block with
 *    as many glued faces over all four quadrants;
 *  - 'step': updateStepLag through a step every few frames (no whole-block twin).
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { makeCell, makePart } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { vec3 } from '../../src/core/math';
import { cameraGridFrame, clearanceAt, stepLagState, sweepGrids, sweepScratch, updateStepLag } from '../../src/client/camera';
import { blocksCamera, sampleLight, shownPlayer, ViewBuilder } from '../../src/client/view';
import type { ClientReplica } from '../../src/net/client/replica';
import type { Target } from '../../src/net/protocol';
import { NX, NY, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import type { OverlayFace, OverlayState } from '../../src/render/backend';
import { OverlayLayer } from '../../src/render/three/overlays';
import { SharedUniforms } from '../../src/render/three/shading';
import { GlueStore } from '../../src/structures/glue';
import { Chunk } from '../../src/voxel/chunk';
import { getPacked } from '../../src/voxel/parts';
import { World } from '../../src/voxel/world';
import { measureCases } from '../heap-probe';

const Y = 40;
const world = new World(1);
world.addChunk(new Chunk(0, 0));
const lower = makePart(B.STONE, 0, 0xcc); // holes 0xcc: the lower half
const upper = makePart(B.PLANKS_OAK, 0, 0x33);
world.setCell(2, Y, 2, canonCell(lower, upper));
world.setCell(4, Y, 2, makeCell(B.STONE));
// Ceilings over x 0..7: upper half slabs over z 0..7 at Y + 3, whole stone over z 8..15.
for (let x = 0; x < 16; x++) {
  for (let z = 0; z < 8; z++) world.setCell(x, Y + 3, z, makePart(B.STONE, 0, 0x33));
  for (let z = 8; z < 16; z++) world.setCell(x, Y + 3, z, makeCell(B.STONE));
}

// ---- overlays
const view = {
  mining: { gridId: 0, x: 2, y: Y, z: 2, sub: 0, progress: 0.5 },
  gluing: null,
  preview: null,
  conflicts: [],
  hint: null,
};
// The replica keeps its structure list (ClientReplica.structures returns the same array until it changes).
const noStructures: never[] = [];
const replica = { world, worldGlue: new GlueStore(), ownState: { view }, state: { structures: new Map() }, structures: () => noStructures } as unknown as ClientReplica;
const builder = new ViewBuilder();
const me = shownPlayer();
const partTarget: Target = { gridId: 0, x: 2, y: Y, z: 2, face: 2, sub: 1, cell: getPacked(world, 2, Y, 2) };
const wholeTarget: Target = { gridId: 0, x: 4, y: Y, z: 2, face: 2, sub: 1, cell: makeCell(B.STONE) };
function overlays(n: number, t: Target): number {
  view.mining.x = t.x;
  let s = 0;
  for (let i = 0; i < n; i++) s += builder.updateOverlays(replica, me, t, 0).breakFill;
  return s;
}

// ---- camera
const frames = [cameraGridFrame()];
frames[0]!.grid = world;
const scratch = sweepScratch();
const o = vec3(3.5, Y + 2.2, 3.5);
const up = vec3(0, 1, 0);
function sweep(n: number, z: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    o.z = z + (i & 3) * 0.1;
    s += sweepGrids(frames, 1, blocksCamera, o, up, 4, 0.25, false, scratch);
  }
  return s;
}
const c = vec3(3.5, Y + 2.6, 3.5); // 0.9 below the slabs' underside, 0.4 below the whole blocks
function clearance(n: number, z: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    c.z = z + (i & 3) * 0.1;
    s += clearanceAt(frames, 1, blocksCamera, c, 1, scratch);
  }
  return s;
}
const light = { sky: 0, block: 0 };
function sample(n: number, x: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    sampleLight(world, x + 0.5, Y + 0.25, 2.5, light);
    s += light.sky;
  }
  return s;
}

// The third-person camera of a frame: 'back' looking down steeply, pulled in under the ceiling.
const camBuilder = new ViewBuilder();
const camMe = shownPlayer();
camMe.feet.y = Y + 1;
camMe.pitch = -1.2;
const scene = { world, structures: () => noStructures };
function camera(n: number, z: number): number {
  camMe.feet.x = 3.5;
  let s = 0;
  for (let i = 0; i < n; i++) {
    camMe.feet.z = z + (i & 3) * 0.1;
    s += camBuilder.updateCamera(scene, camMe, 70, 1 / 60, 'back').y;
  }
  return s;
}

// ---- the overlay layer (no GPU: scene graph and buffers only)
const tex = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4, 1);
const layer = new OverlayLayer(new SharedUniforms(), uniform(new THREE.Vector4(1, 0, 0, 1)), tex, []);
const root = new THREE.Group();
const resolve = (): THREE.Object3D => root;
const cellA = { structureId: 0, x: 2, y: Y, z: 2, fill: 0x33 };
const cellB = { structureId: 0, x: 2, y: Y, z: 2, fill: 0xcc };
const cellW = { structureId: 0, x: 4, y: Y, z: 2, fill: 0xff };
const st: OverlayState = { target: cellA, breakProgress: 0.5, breakFill: 0x33, preview: [], conflicts: [], glue: [], targetOctant: -1, placement: null };
/** Glued faces: covered and exposed, over several quadrant masks (partial) or all four quadrants (whole), the same number of each. */
const glueFace = (x: number, face: Dir, covered: boolean, quads: number): OverlayFace => ({ structureId: 0, x, y: Y, z: 4, fill: 0xff, face, covered, sky: 15, block: 0, quads });
const gluePartial: OverlayFace[] = [
  glueFace(0, PY, true, 0b0101),
  glueFace(0, PY, false, 0b1010),
  glueFace(1, PX, true, 0b0011),
  glueFace(2, NX, false, 0b1100),
  glueFace(3, PZ, false, 0b0001),
  glueFace(4, NY, true, 0b0110),
  glueFace(5, PY, false, 0b0111),
];
const glueWhole: OverlayFace[] = gluePartial.map((f) => ({ ...f, quads: 15 }));
function layerFrames(n: number, partial: boolean): number {
  st.glue = partial ? gluePartial : glueWhole;
  for (let i = 0; i < n; i++) {
    const a = (i & 1) === 0;
    st.target = partial ? (a ? cellA : cellB) : cellW;
    st.breakFill = partial ? (a ? 0x33 : 1 << 6) : 0xff;
    layer.update(st, resolve, 1);
  }
  return root.children.length;
}

// ---- step offset
const lag = stepLagState();
const stepper = shownPlayer();
stepper.onGround = true;
function steps(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    stepper.tick = Math.floor(i / 3);
    stepper.tickY = Math.floor(stepper.tick / 4) * 0.5;
    stepper.feet.y = stepper.tickY - (2 - (i % 3)) * 0.1;
    updateStepLag(lag, stepper, null, 1 / 60);
    s += lag.value < 0 ? 1 : 0;
  }
  return s;
}

await measureCases({
  'overlays partial': (n) => overlays(n, partTarget),
  'overlays whole': (n) => overlays(n, wholeTarget),
  'sweep partial': (n) => sweep(n, 3),
  'sweep whole': (n) => sweep(n, 11),
  'clearance partial': (n) => clearance(n, 3),
  'clearance whole': (n) => clearance(n, 11),
  'camera partial': (n) => camera(n, 3),
  'camera whole': (n) => camera(n, 11),
  'light partial': (n) => sample(n, 2),
  'light whole': (n) => sample(n, 4),
  'layer partial': (n) => layerFrames(n, true),
  'layer whole': (n) => layerFrames(n, false),
  step: (n) => steps(n),
});
