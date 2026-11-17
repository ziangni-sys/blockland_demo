/**
 * Renderer-drawn entity models: box-built rabbit and player figures (original designs),
 * plus their shared vertex-coloured material. Models face -Z at yaw 0 (the game's yaw
 * convention maps directly onto Object3D.rotation.y).
 */
import * as THREE from 'three/webgpu';
import { attribute, Fn, mix, positionWorld, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { hexToLinear } from './lighting';
import { applyFogNode, encodeOutput, modelLightNode, worldNormal, type SharedUniforms } from './shading';

/** Vertex-coloured, per-object lit material for box models. */
export function createModelMaterial(u: SharedUniforms, obj: Node<'vec4'>): THREE.NodeMaterial {
  const m = new THREE.NodeMaterial();
  m.name = 'entity-model';
  m.lights = false;
  m.fog = false;
  m.colorNode = Fn(() => {
    const col = attribute('color', 'vec3');
    const lit = col.mul(modelLightNode(u, obj, worldNormal()));
    const flashed = mix(lit, vec3(1, 1, 1), obj.z);
    return vec4(encodeOutput(applyFogNode(u, flashed, positionWorld)), 1);
  })();
  return m;
}

/** Face colours in BoxGeometry group order [+X, -X, +Y, -Y, +Z, -Z] (sRGB hex). */
type FaceColors = readonly [number, number, number, number, number, number];

function faces(all: number, over?: Partial<Record<0 | 1 | 2 | 3 | 4 | 5, number>>): FaceColors {
  const f: [number, number, number, number, number, number] = [all, all, all, all, all, all];
  if (over) for (const k of Object.keys(over)) f[Number(k)] = over[Number(k) as 0]!;
  return f;
}

/**
 * A box of size (w,h,d) whose local origin is at `pivot` relative to the box centre, so the
 * part rotates around its joint (ear base, shoulder, hip).
 */
function part(w: number, h: number, d: number, colors: FaceColors, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  // BoxGeometry builds 4 vertices per face in +X, -X, +Y, -Y, +Z, -Z order.
  for (let f = 0; f < 6; f++) {
    const c = hexToLinear(colors[f]!);
    for (let k = 0; k < 4; k++) {
      const v = f * 4 + k;
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

// ------------------------------------------------------------------ palette (original)
const FUR = 0xc8955c; // caramel back
const FUR_LIGHT = 0xf2e4c6; // cream belly / muzzle
const EAR_IN = 0xe7a3ab;
const EYE = 0x2b1d18;
const NOSE = 0xd77f8c;
const TUNIC = 0x2e8c80;
const TUNIC_DARK = 0x246f66;
const SKIN = 0xe3b68f;
const HAIR = 0x5a3a24;
const TROUSERS = 0x2c3452;
const BOOTS = 0x5b3b25;

/** Shared geometries of all rabbits / players (built once per backend). */
export interface ModelGeometries {
  rabbit: {
    body: THREE.BufferGeometry;
    head: THREE.BufferGeometry;
    ear: THREE.BufferGeometry;
    tail: THREE.BufferGeometry;
    hindFoot: THREE.BufferGeometry;
    foreFoot: THREE.BufferGeometry;
  };
  player: {
    head: THREE.BufferGeometry;
    torso: THREE.BufferGeometry;
    arm: THREE.BufferGeometry;
    leg: THREE.BufferGeometry;
  };
  dispose(): void;
}

export function createModelGeometries(): ModelGeometries {
  const rabbit = {
    // Body: round-ish loaf, cream underside and chest.
    body: part(0.32, 0.27, 0.42, faces(FUR, { 3: FUR_LIGHT, 5: FUR_LIGHT }), 0, 0, 0),
    // Head: cream muzzle front with eyes painted on the sides via a darker band is too fiddly
    // for boxes; eyes and nose are tiny child boxes instead (see buildRabbit).
    head: part(0.24, 0.22, 0.22, faces(FUR, { 5: FUR_LIGHT, 3: FUR_LIGHT }), 0, 0, 0),
    // Ear pivots at its base; inner side (front, -Z) pink.
    ear: part(0.075, 0.25, 0.04, faces(FUR, { 5: EAR_IN }), 0, 0.125, 0),
    tail: part(0.12, 0.12, 0.1, faces(FUR_LIGHT), 0, 0, 0),
    hindFoot: part(0.09, 0.07, 0.2, faces(FUR, { 3: FUR_LIGHT }), 0, 0.035, 0),
    foreFoot: part(0.065, 0.11, 0.065, faces(FUR_LIGHT), 0, 0.055, 0),
  };
  const player = {
    head: part(0.42, 0.42, 0.42, faces(SKIN, { 2: HAIR, 4: HAIR, 0: SKIN, 1: SKIN }), 0, 0.21, 0),
    torso: part(0.48, 0.66, 0.26, faces(TUNIC, { 2: TUNIC_DARK, 3: TUNIC_DARK }), 0, 0.33, 0),
    // Arms / legs pivot at the shoulder / hip (top of the box).
    arm: part(0.17, 0.62, 0.18, faces(TUNIC, { 3: SKIN }), 0, -0.31, 0),
    leg: part(0.2, 0.74, 0.22, faces(TROUSERS, { 3: BOOTS }), 0, -0.37, 0),
  };
  return {
    rabbit,
    player,
    dispose() {
      for (const g of Object.values(rabbit)) g.dispose();
      for (const g of Object.values(player)) g.dispose();
    },
  };
}

/** Small solid-colour box used for eyes / nose. */
export function detailGeometry(w: number, h: number, d: number, color: number): THREE.BufferGeometry {
  return part(w, h, d, faces(color), 0, 0, 0);
}

export const RABBIT_EYE = EYE;
export const RABBIT_NOSE = NOSE;
