/**
 * Sky dome: gradient following the time of day, sun and moon discs on opposite sides,
 * turning star field at night and a soft scrolling cloud layer.
 *
 * Drawn as a camera-centred sphere pushed to the far plane (z = w) AFTER the opaque world
 * with depth test on, so its fairly expensive fragment shader only runs on pixels that no
 * terrain covers. Under water / lava it collapses to the fog colour.
 */
import * as THREE from 'three/webgpu';
import {
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  dot,
  float,
  floor,
  Fn,
  fract,
  length,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  sin,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
  varying,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { makeCloudNoise } from './noise';
import { skyGradientNode, type SharedUniforms } from './shading';

/** Render order after every opaque / cutout object but before transparent ones. */
export const SKY_RENDER_ORDER = 50;

const NOISE_SIZE = 128;
const NOISE_SEED = 0x51a7e;

export interface Sky {
  mesh: THREE.Mesh;
  noise: THREE.DataTexture;
  dispose(): void;
}

/** Disc of angular radius `r` (radians) around direction `c`, with a soft edge of `soft`. */
function disc(dir: Node<'vec3'>, c: Node<'vec3'>, cosR: number, cosSoft: number): Node<'float'> {
  return smoothstep(cosSoft, cosR, dot(dir, c));
}

export function createSky(u: SharedUniforms): Sky {
  const noise = new THREE.DataTexture(makeCloudNoise(NOISE_SIZE, NOISE_SEED), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  noise.wrapS = THREE.RepeatWrapping;
  noise.wrapT = THREE.RepeatWrapping;
  noise.magFilter = THREE.LinearFilter;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.generateMipmaps = true;
  noise.colorSpace = THREE.NoColorSpace;
  noise.needsUpdate = true;

  const m = new THREE.NodeMaterial();
  m.name = 'sky';
  m.lights = false;
  m.fog = false;
  m.side = THREE.BackSide;
  m.depthWrite = false;
  m.depthTest = true;

  // Rotation-only view transform: the dome never translates with the camera. z = w puts every
  // fragment exactly on the far plane (depth 1), which passes LessEqual only where nothing
  // was drawn.
  const viewPos = cameraViewMatrix.mul(vec4(positionLocal, 0)).xyz;
  const clip = cameraProjectionMatrix.mul(vec4(viewPos, 1));
  m.vertexNode = vec4(clip.x, clip.y, clip.w, clip.w);
  const vDir = varying(positionLocal, 'vSkyDir');

  m.colorNode = Fn(() => {
    const dir = normalize(vDir);
    let col: Node<'vec3'> = skyGradientNode(u, dir);

    // ---- stars (rotating with the sky)
    const sdir = u.starRotation.mul(dir);
    const sp = sdir.mul(150);
    const cell = floor(sp);
    const h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const h2 = fract(sin(dot(cell, vec3(39.346, 11.135, 83.155))).mul(24634.6345));
    const f = fract(sp).sub(0.5);
    const starShape = smoothstep(0.32, 0.0, length(f));
    const twinkle = sin(u.time.mul(h2.mul(3).add(1.5)).add(h.mul(40))).mul(0.3).add(0.7);
    const starAmt = smoothstep(0.9965, 1, h).mul(starShape).mul(twinkle).mul(u.stars).mul(smoothstep(-0.02, 0.15, dir.y));
    col = col.add(vec3(0.85, 0.9, 1).mul(starAmt).mul(h2.mul(0.7).add(0.5)));

    // ---- sun: hot core, warm halo
    const sunUp = smoothstep(-0.12, 0.02, u.sunDir.y);
    const toSun = max(dot(dir, u.sunDir), 0);
    const sunCore = disc(dir, u.sunDir, 0.99935, 0.99895);
    const halo = pow(toSun, 220).mul(0.55).add(pow(toSun, 24).mul(0.12));
    col = col.add(u.sunColor.mul(sunCore.mul(3).add(halo)).mul(sunUp));

    // ---- moon: pale disc with soft maria from the noise texture
    const moonUp = smoothstep(-0.12, 0.02, u.moonDir.y);
    const moonCore = disc(dir, u.moonDir, 0.99955, 0.99925);
    const mside = normalize(vec3(u.moonDir.z, 0, u.moonDir.x.negate()).add(vec3(0.0001, 0, 0)));
    const mu = vec2(dot(dir.sub(u.moonDir), mside), dot(dir.sub(u.moonDir), vec3(0, 1, 0))).mul(18);
    const maria = texture(noise, mu.add(0.5)).g;
    const moonShade = mix(float(0.62), float(1), smoothstep(0.35, 0.7, maria));
    const moonHalo = pow(max(dot(dir, u.moonDir), 0), 400).mul(0.18);
    col = col.add(u.moonColor.mul(moonCore.mul(moonShade).mul(1.1).add(moonHalo)).mul(moonUp));

    // ---- clouds: a scrolling noise layer projected onto a high flat ceiling
    const above = smoothstep(0.0, 0.22, dir.y);
    const proj = dir.xz.div(dir.y.add(0.09));
    const wind = vec2(u.time.mul(0.0035), u.time.mul(0.0012));
    const cuv = proj.mul(0.11).add(wind);
    const n1 = texture(noise, cuv).r;
    const n2 = texture(noise, cuv.mul(2.9).add(vec2(0.37, 0.11)).add(wind.mul(1.7))).g;
    const shape = n1.mul(0.78).add(n2.mul(0.22));
    const density = smoothstep(0.5, 0.78, shape);
    // Lighter on the side facing the sun / moon: sample the density a little towards the light.
    const lightDir2 = normalize(u.sunDir.xz.add(vec2(0.0001, 0)));
    const n1s = texture(noise, cuv.add(lightDir2.mul(0.035))).b;
    const selfShadow = clamp(n1.sub(n1s).mul(2.2), 0, 1);
    const cloudLit = u.cloudColor.mul(float(1).sub(selfShadow.mul(0.35)));
    const glowSide = pow(toSun, 6).mul(u.sunGlow).mul(0.6);
    const cloudCol = cloudLit.add(glowSide);
    col = mix(col, cloudCol, density.mul(above).mul(0.88));

    // Under water / lava everything beyond a few blocks is fog.
    col = mix(col, u.fogColor, u.fogFixed);
    return vec4(max(col, vec3(0, 0, 0)), 1);
  })();

  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = SKY_RENDER_ORDER;
  mesh.matrixAutoUpdate = false;

  return {
    mesh,
    noise,
    dispose() {
      geo.dispose();
      m.dispose();
      noise.dispose();
    },
  };
}
