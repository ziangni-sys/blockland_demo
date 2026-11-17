/**
 * Node materials (TSL) for the voxel world: one shared material per draw group, plus the
 * shared per-frame uniforms they read. The light model mirrors lighting.ts exactly.
 *
 * Per-object data. Sections, structures and renderer-drawn entities all share the same three
 * voxel materials; what differs per object lives in ONE per-object vec4 uniform (objectGroup,
 * so three keeps a separate small uniform buffer per render object):
 *   x = skylight scale   (1 for world sections; StructurePose.sky / 15 for structures)
 *   y = minimum block light (0 for sections; pose.block / 15 for structures and entities)
 *   z = white flash 0..1 (blast crates)
 *   w = 1 when the object is a WORLD section (only world water is cut by dry volumes)
 * Every mesh using these materials must carry a THREE.Vector4 in `userData.bl`.
 *
 * Everything that is the same for all objects sits in the renderGroup (one shared buffer,
 * updated once per render call) so thousands of sections do not each re-upload it.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  dFdx,
  dFdy,
  Discard,
  dot,
  exp,
  float,
  floor,
  Fn,
  If,
  int,
  length,
  log2,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  renderGroup,
  select,
  sin,
  cos,
  smoothstep,
  sRGBTransferOETF,
  texture,
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { AMBIENT_FLOOR, FACE_BOTTOM, FACE_TOP, FACE_X, FACE_Z, LIGHT_CURVE_K, type FogParams, type SkyState } from './lighting';
import { BOB_OFFSET, BOB_WAVES, RIPPLE_WAVES, SWAY_PHASES } from './waves';
import { DRY_THRESHOLD } from './drymask';

/** Number of structures whose dry volumes cut world water at the same time. */
export const DRY_SLOTS = 4;

type N<T> = Node<T>;

/** Shared uniforms (renderGroup). One instance per backend. */
export class SharedUniforms {
  readonly time = uniform(0).setGroup(renderGroup);
  readonly dayLight = uniform(1).setGroup(renderGroup);
  readonly skyTint = uniform(new THREE.Vector3(1, 1, 1)).setGroup(renderGroup);
  readonly blockTint = uniform(new THREE.Vector3(1, 0.8, 0.6)).setGroup(renderGroup);
  readonly zenith = uniform(new THREE.Vector3(0.1, 0.3, 0.8)).setGroup(renderGroup);
  readonly horizon = uniform(new THREE.Vector3(0.5, 0.7, 0.9)).setGroup(renderGroup);
  readonly sunGlow = uniform(new THREE.Vector3(1, 0.5, 0.2)).setGroup(renderGroup);
  readonly glowStrength = uniform(0).setGroup(renderGroup);
  readonly sunDir = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
  readonly moonDir = uniform(new THREE.Vector3(0, -1, 0)).setGroup(renderGroup);
  readonly sunColor = uniform(new THREE.Vector3(1, 1, 1)).setGroup(renderGroup);
  readonly moonColor = uniform(new THREE.Vector3(1, 1, 1)).setGroup(renderGroup);
  readonly cloudColor = uniform(new THREE.Vector3(1, 1, 1)).setGroup(renderGroup);
  readonly stars = uniform(0).setGroup(renderGroup);
  readonly night = uniform(0).setGroup(renderGroup);
  /** Rotates view directions into the frame of the turning star sphere. */
  readonly starRotation = uniform(new THREE.Matrix3()).setGroup(renderGroup);
  readonly fogStart = uniform(64).setGroup(renderGroup);
  readonly fogEnd = uniform(128).setGroup(renderGroup);
  readonly fogColor = uniform(new THREE.Vector3(0, 0, 0)).setGroup(renderGroup);
  readonly fogFixed = uniform(0).setGroup(renderGroup);
  /** Submerged exponential fog coefficient per block (lighting.ts FogParams.density). */
  readonly fogDensity = uniform(0).setGroup(renderGroup);
  /** Multiplicative surface tint of the medium the camera is in ((1,1,1) in air). */
  readonly mediumTint = uniform(new THREE.Vector3(1, 1, 1)).setGroup(renderGroup);
  /** Tile layers of world water (still, flow): only those fragments are cut by dry volumes. */
  readonly waterLayers = uniform(new THREE.Vector2(-1, -1)).setGroup(renderGroup);
  readonly dryCount = uniform(0).setGroup(renderGroup);
  /** Camera-relative position -> mask uvw, one per slot (pose.ts dryVolumeMatrix, camera as origin). */
  readonly dryMatrices: THREE.UniformNode<"mat4", THREE.Matrix4>[] = [];
  /** Layer count (DryVolume.sy) of each slot's mask, slot i in component i. */
  readonly dryLayers = uniform(new THREE.Vector4(1, 1, 1, 1)).setGroup(renderGroup);

  constructor() {
    for (let i = 0; i < DRY_SLOTS; i++) this.dryMatrices.push(uniform(new THREE.Matrix4()).setGroup(renderGroup));
  }

  applySky(s: SkyState, starAngle: number, tilt: number): void {
    this.dayLight.value = s.dayLight;
    this.skyTint.value.set(s.skyTint.r, s.skyTint.g, s.skyTint.b);
    this.blockTint.value.set(s.blockTint.r, s.blockTint.g, s.blockTint.b);
    this.zenith.value.set(s.zenith.r, s.zenith.g, s.zenith.b);
    this.horizon.value.set(s.horizon.r, s.horizon.g, s.horizon.b);
    this.sunGlow.value.set(s.sunGlow.r, s.sunGlow.g, s.sunGlow.b);
    this.glowStrength.value = s.glowStrength;
    this.sunDir.value.set(s.sunDir.x, s.sunDir.y, s.sunDir.z);
    this.moonDir.value.set(s.moonDir.x, s.moonDir.y, s.moonDir.z);
    this.sunColor.value.set(s.sunColor.r, s.sunColor.g, s.sunColor.b);
    this.moonColor.value.set(s.moonColor.r, s.moonColor.g, s.moonColor.b);
    this.cloudColor.value.set(s.cloudColor.r, s.cloudColor.g, s.cloudColor.b);
    this.stars.value = s.stars;
    this.night.value = s.night;
    // Stars turn with the sun around the axis of the (tilted) sun path, which is
    // a = (0, -sin(tilt), cos(tilt)). Rotation by -starAngle about a (Rodrigues).
    const ax = 0;
    const ay = -Math.sin(tilt);
    const az = Math.cos(tilt);
    const c = Math.cos(-starAngle);
    const sn = Math.sin(-starAngle);
    const t = 1 - c;
    this.starRotation.value.set(
      t * ax * ax + c,
      t * ax * ay - sn * az,
      t * ax * az + sn * ay,
      t * ax * ay + sn * az,
      t * ay * ay + c,
      t * ay * az - sn * ax,
      t * ax * az - sn * ay,
      t * ay * az + sn * ax,
      t * az * az + c,
    );
  }

  applyFog(f: FogParams): void {
    this.fogStart.value = f.start;
    this.fogEnd.value = Math.max(f.end, f.start + 0.01);
    this.fogColor.value.set(f.color.r, f.color.g, f.color.b);
    this.fogFixed.value = f.fixedColor;
    this.fogDensity.value = f.density;
    this.mediumTint.value.set(f.tint.r, f.tint.g, f.tint.b);
  }
}

// ------------------------------------------------------------------ shared graph pieces

/**
 * The renderer draws straight into the canvas (outputColorSpace = working space, so three adds
 * no linear->sRGB output pass and no RGBA16F framebuffer). Every material therefore shades in
 * linear space and encodes its final colour to sRGB here. Translucent layers blend in gamma
 * space as a consequence, which is the norm for this style of game.
 */
export function encodeOutput(c: N<'vec3'>): N<'vec3'> {
  return sRGBTransferOETF(c) as N<'vec3'>;
}

/** l / (K - (K-1) l): the brightness curve of lighting.ts. */
export function lightCurveNode(l: N<'float'>): N<'float'> {
  const x = clamp(l, 0, 1);
  return x.div(float(LIGHT_CURVE_K).sub(x.mul(LIGHT_CURVE_K - 1)));
}

/** Same as lighting.faceShade for a unit normal. */
export function faceShadeNode(n: N<'vec3'>): N<'float'> {
  const vy = select(n.y.greaterThan(0), float(FACE_TOP), float(FACE_BOTTOM));
  return n.x.mul(n.x).mul(FACE_X).add(n.y.mul(n.y).mul(vy)).add(n.z.mul(n.z).mul(FACE_Z));
}

/**
 * Sky gradient + sun glow for a unit direction (no discs, stars or clouds). It is also the
 * distance-fog colour, so far terrain melts exactly into the sky behind it. Below the
 * horizon the colour stays at the (slightly darkened) horizon colour.
 */
export function skyGradientNode(u: SharedUniforms, dir: N<'vec3'>): N<'vec3'> {
  const h = dir.y;
  const up = clamp(h, 0, 1);
  // sqrt-ish falloff keeps a broad bright band at the horizon and a deep zenith.
  const t = pow(up, 0.55);
  const below = clamp(h.negate().mul(3), 0, 1);
  const base = mix(u.horizon, u.zenith, t).mul(float(1).sub(below.mul(0.25)));
  const toSun = max(dot(dir, u.sunDir), 0);
  // Twilight glow: a broad lobe along the horizon centred on the sun's azimuth (so the far
  // side of the sky stays dusky) plus a tighter halo around the sun itself.
  const azimuth = max(dot(normalize(dir.xz.add(vec2(1e-5, 0))), normalize(u.sunDir.xz.add(vec2(1e-5, 0)))), 0);
  const nearHorizon = pow(float(1).sub(up), 3).mul(float(1).sub(below.mul(0.7)));
  const lobe = pow(azimuth, 3).mul(nearHorizon).mul(0.9).add(pow(toSun, 24).mul(0.6));
  // Blend rather than add: adding on top of the bright horizon only washes it out to white.
  return mix(base, u.sunGlow, clamp(lobe.mul(u.glowStrength), 0, 1));
}

/**
 * Fragment position relative to the camera (world - camera). The backend renders in a
 * floating RENDER SPACE (world minus an integer origin near the camera, see backend.ts), so
 * both terms are small and the difference is precise anywhere in the world. Fragment stage.
 */
export function cameraRelativePosition(): N<'vec3'> {
  return positionWorld.sub(cameraPosition);
}

/**
 * Medium tint + fog for a fragment at camera-relative position `rel` (mirrors
 * lighting.fogFactor). In air: smoothstep fog to the sky gradient seen in the same direction,
 * so far terrain melts exactly into the sky behind it. Submerged: every surface tinted by
 * the medium and exponential fog to its colour, rising from the first block.
 */
export function applyFogNode(u: SharedUniforms, color: N<'vec3'>, rel: N<'vec3'>): N<'vec3'> {
  const dist = length(rel);
  const air = smoothstep(u.fogStart, u.fogEnd, dist);
  const medium = float(1).sub(exp(dist.mul(u.fogDensity).negate()));
  const f = mix(air, medium, u.fogFixed);
  const dir = rel.div(max(dist, 1e-4));
  const fogCol = mix(skyGradientNode(u, dir), u.fogColor, u.fogFixed);
  return mix(color.mul(u.mediumTint), fogCol, f);
}

/** Decoded per-vertex light inputs (vertex stage values; they become varyings when read in the fragment). */
interface VertexLight {
  sky: N<'float'>;
  block: N<'float'>;
  ao: N<'float'>;
  emissive: N<'float'>;
  liquid: N<'float'>;
  plant: N<'float'>;
}

function decodeVertexLight(obj: N<'vec4'>): VertexLight {
  const l = attribute('vlight', 'vec4');
  const flags = floor(l.w.mul(255).add(0.5));
  const emissive = flags.mod(2);
  const liquid = floor(flags.div(2)).mod(2);
  const plant = floor(flags.div(4)).mod(2);
  return {
    sky: vertexStage(l.x.mul(obj.x)),
    block: vertexStage(max(l.y, obj.y)),
    ao: vertexStage(l.z),
    emissive: vertexStage(emissive),
    liquid,
    plant,
  };
}

/** Sum of travelling waves (waves.ts) at render-space xz, time t. */
function waveSum(waves: readonly { kx: number; kz: number; w: number; a: number }[], xz: N<'vec2'>, t: N<'float'>): N<'float'> {
  let h: N<'float'> = float(0);
  for (const wv of waves) h = h.add(sin(xz.x.mul(wv.kx).add(xz.y.mul(wv.kz)).add(t.mul(wv.w))).mul(wv.a));
  return h;
}

/**
 * Vertex position in render space before any displacement. Render space is also the
 * ANIMATION space of waves.ts: its origin is a multiple of WAVE_PERIOD, so every field is
 * seamless when the origin moves. World sections have integer translations there, so the
 * result is exact in float32 and coincident vertices of neighbouring sections get
 * bit-identical wave heights (the liquid surface stays watertight).
 */
function animSpacePosition(): N<'vec3'> {
  return modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
}

/**
 * Local-space vertex position with liquid bobbing and plant sway. Plants sway with uv.v as
 * the weight: the mesher's uv v = 0 is the bottom of the tile, so plant roots stay planted
 * no matter which vertices carry the plant flag.
 */
function animatedPosition(u: SharedUniforms, vl: VertexLight): N<'vec3'> {
  const p = positionLocal;
  const a = animSpacePosition();
  const t = u.time;
  const bob = waveSum(BOB_WAVES, a.xz, t).add(BOB_OFFSET).mul(vl.liquid);
  const ph = SWAY_PHASES.map((s) => a.x.mul(s.kx).add(a.z.mul(s.kz)));
  const swayW = uv().y.mul(vl.plant).mul(0.055);
  const sx = sin(t.mul(1.9).add(ph[0]!)).add(sin(t.mul(3.1).add(ph[1]!)).mul(0.35));
  const sz = cos(t.mul(1.6).add(ph[2]!));
  return p.add(vec3(sx.mul(swayW), bob, sz.mul(swayW).mul(0.7)));
}

/** World-space normal of the (possibly rotated) object, computed per vertex. */
export function worldNormal(): N<'vec3'> {
  const n = attribute('normal', 'vec3');
  return vertexStage(normalize(modelWorldMatrix.mul(vec4(n, 0)).xyz));
}

/** Terrain light colour (before albedo) — lighting.ts shadedBrightness, tinted, with AO and face term. */
function lightColor(u: SharedUniforms, vl: VertexLight, n: N<'vec3'>): N<'vec3'> {
  const s = lightCurveNode(vl.sky.mul(u.dayLight));
  const b = lightCurveNode(vl.block);
  const tinted = max(u.skyTint.mul(s), u.blockTint.mul(b));
  const floored = tinted.mul(1 - AMBIENT_FLOOR).add(AMBIENT_FLOOR);
  // The contract delivers AO as linear openness (level * 85); the soft response is ours.
  const ao = mix(float(0.45), float(1), vl.ao);
  const lit = floored.mul(ao).mul(faceShadeNode(n));
  // Emissive faces ignore darkness; keep a whisper of the face term so a glowing cube still reads as a cube.
  const emissiveLight = vec3(mix(float(0.86), float(1), faceShadeNode(n)));
  return mix(lit, emissiveLight, vl.emissive);
}

/**
 * Light colour for renderer-drawn models (rabbits, players) that have no per-vertex light:
 * sky / block come from the per-object uniform (x = sky 0..1, y = block 0..1).
 */
export function modelLightNode(u: SharedUniforms, obj: N<'vec4'>, n: N<'vec3'>): N<'vec3'> {
  const s = lightCurveNode(obj.x.mul(u.dayLight));
  const b = lightCurveNode(obj.y);
  const tinted = max(u.skyTint.mul(s), u.blockTint.mul(b));
  return tinted.mul(1 - AMBIENT_FLOOR).add(AMBIENT_FLOOR).mul(faceShadeNode(n));
}

/**
 * Mip level the hardware will pick for this fragment (tile texels per pixel), used to keep
 * alpha-tested foliage from thinning out in the distance: the box-filtered mips average
 * alpha down, so alpha is boosted by the mip level before the test (coverage-preserving
 * cutout, after Ben Golus).
 */
function mipLevel(uvTex: N<'vec2'>): N<'float'> {
  const dx = dFdx(uvTex);
  const dy = dFdy(uvTex);
  const d = max(dot(dx, dx), dot(dy, dy));
  return max(log2(max(d, 1e-8)).mul(0.5), 0);
}

export type VoxelPass = 'opaque' | 'cutout' | 'translucent';

export interface VoxelMaterials {
  opaque: THREE.NodeMaterial;
  cutout: THREE.NodeMaterial;
  translucent: THREE.NodeMaterial;
}

/**
 * Builds the three voxel materials. `tileNodes` receives every TextureNode that samples the
 * tile array so setTiles() can swap the texture without rebuilding any program.
 */
export function createVoxelMaterials(
  u: SharedUniforms,
  objUniform: N<'vec4'>,
  placeholder: THREE.DataArrayTexture,
  tileSize: N<'float'>,
  dryTextures: readonly THREE.Data3DTexture[],
  tileNodes: THREE.TextureNode[],
  dryNodes: THREE.TextureNode[],
): VoxelMaterials {
  const make = (pass: VoxelPass): THREE.NodeMaterial => {
    const m = new THREE.NodeMaterial();
    m.name = `voxel-${pass}`;
    m.lights = false;
    m.fog = false;
    const vl = decodeVertexLight(objUniform);
    m.positionNode = animatedPosition(u, vl);
    const nW = worldNormal();
    const layer = attribute('layer', 'uint');
    const uvs = uv();
    const tex = texture(placeholder, uvs).depth(int(layer));
    tileNodes.push(tex);
    const rel = cameraRelativePosition();

    if (pass === 'translucent') {
      const dry = dryVolumeFactor(u, rel, dryTextures, dryNodes);
      const li = float(layer);
      // Water is recognised by its tile layers: the ripples, glints, fresnel opacity and the
      // dry-volume cut are for water only. Other translucent blocks (ice) stay static.
      const isWater = li.equal(u.waterLayers.x).or(li.equal(u.waterLayers.y));
      const water = select(isWater, float(1), float(0));
      const cut = objUniform.w.greaterThan(0.5).and(isWater).and(dry.greaterThan(DRY_THRESHOLD));
      m.transparent = true;
      m.depthWrite = false;
      // FrontSide in every pass (mesh contract): faces visible from both sides, such as liquid
      // surfaces seen from below, arrive twice from the mesher as front and back copies.
      m.colorNode = Fn(() => {
        If(cut, () => {
          Discard();
        });
        const albedo = tex;
        const light = lightColor(u, vl, nW);
        const V = normalize(rel.negate());
        // Ripple normal for upward WATER faces (analytic gradient of travelling waves in
        // render space, which is precise and seamless anywhere, see waves.ts).
        const up = smoothstep(0.5, 0.9, nW.y).mul(water);
        const t = u.time;
        const p = positionWorld.xz;
        const phases = RIPPLE_WAVES.map((wv) => p.x.mul(wv.kx).add(p.y.mul(wv.kz)).add(t.mul(wv.w)));
        let dhx: N<'float'> = float(0);
        let dhz: N<'float'> = float(0);
        RIPPLE_WAVES.forEach((wv, i) => {
          const c = cos(phases[i]!);
          dhx = dhx.add(c.mul(wv.a * wv.kx));
          dhz = dhz.add(c.mul(wv.a * wv.kz));
        });
        const rippleN = normalize(vec3(dhx.negate(), 1, dhz.negate()));
        const N = normalize(mix(nW, rippleN, up));
        const ndv = abs(dot(N, V));
        const fres = float(0.02).add(pow(float(1).sub(ndv), 5).mul(0.98));
        const R = reflect(V.negate(), N);
        const skyVis = lightCurveNode(vl.sky);
        const reflCol = skyGradientNode(u, vec3(R.x, abs(R.y), R.z)).mul(skyVis.mul(0.85).add(0.15));
        // Gentle moving shimmer: two interfering wave fields brighten crests a little.
        const shimmer = pow(sin(phases[0]!.mul(0.5)).mul(sin(phases[1]!.mul(0.5))).mul(0.5).add(0.5), 6).mul(0.12).mul(up);
        const body = albedo.rgb.mul(light).mul(float(1).add(shimmer));
        const sunAmt = pow(max(dot(R, u.sunDir), 0), 180).mul(smoothstep(-0.05, 0.1, u.sunDir.y));
        const moonAmt = pow(max(dot(R, u.moonDir), 0), 300).mul(smoothstep(-0.05, 0.1, u.moonDir.y)).mul(0.35);
        const spec = u.sunColor.mul(sunAmt).add(u.moonColor.mul(moonAmt)).mul(skyVis).mul(up).mul(2.5);
        // Water mirrors the sky strongly at grazing angles; ice only a little (static: its
        // normal is the face normal and nothing depends on time).
        const color = mix(body, reflCol, fres.mul(mix(float(0.3), float(0.85), water))).add(spec);
        // Water: clearer looking straight down, more opaque (and sky coloured) at grazing
        // angles. Ice keeps its authored alpha, a little more opaque at grazing angles.
        const alphaWater = mix(albedo.a.mul(0.78), float(0.96), fres).add(spec.x.mul(0.5));
        const alphaOther = mix(albedo.a, max(albedo.a, float(0.92)), fres.mul(0.5));
        const alpha = clamp(mix(alphaOther, alphaWater, water), 0, 1);
        return vec4(encodeOutput(applyFogNode(u, color, rel)), alpha);
      })();
    } else {
      m.colorNode = Fn(() => {
        const albedo = tex;
        if (pass === 'cutout') {
          const lod = mipLevel(uvs.mul(tileSize));
          const a = albedo.a.mul(lod.mul(0.3).add(1));
          Discard(a.lessThan(0.5));
        }
        const light = lightColor(u, vl, nW);
        const lit = mix(albedo.rgb.mul(light), vec3(1, 1, 1), objUniform.z);
        return vec4(encodeOutput(applyFogNode(u, lit, rel)), 1);
      })();
    }
    return m;
  };
  return { opaque: make('opaque'), cutout: make('cutout'), translucent: make('translucent') };
}

/**
 * Dry-volume test (docs/LESSONS.md "船舱里冒出水面": the water stays in the world, the renderer
 * cuts it). Returns > DRY_THRESHOLD where the fragment lies inside the dry mask of one of the
 * nearest structures. Built eagerly (outside any Fn) so the four texture nodes exist exactly
 * once and the backend can retarget them every frame. Texture fetches are unconditional
 * (uniform control flow); only the results are selected per slot.
 *
 * Filtering (mirrored and tested in drymask.ts): the mask is sampled at the CENTRE of the
 * fragment's mask layer (exact in local y) and bilinearly in local x/z. Vertical filtering would let a non-dry layer above or below
 * (the hold floor, the deck) attenuate the value of a dry cell; near an inner corner of the
 * hold that pushed it under the threshold whenever the waterline came within ~0.3 cells of
 * the floor, the normal floating position of a small boat. Horizontal filtering is kept on
 * purpose: it moves the cut ~0.3 cells into the hull walls, which removes the z-fight line
 * where the water plane meets the inner wall faces.
 */
function dryVolumeFactor(
  u: SharedUniforms,
  rel: N<'vec3'>,
  dryTextures: readonly THREE.Data3DTexture[],
  dryNodes: THREE.TextureNode[],
): N<'float'> {
  const layers = [u.dryLayers.x, u.dryLayers.y, u.dryLayers.z, u.dryLayers.w];
  let dry: N<'float'> = float(0);
  for (let i = 0; i < DRY_SLOTS; i++) {
    const p = u.dryMatrices[i]!.mul(vec4(rel, 1)).xyz;
    const inside = p.x.greaterThanEqual(0).and(p.x.lessThan(1))
      .and(p.y.greaterThanEqual(0)).and(p.y.lessThan(1))
      .and(p.z.greaterThanEqual(0)).and(p.z.lessThan(1))
      .and(u.dryCount.greaterThan(i));
    const sy = layers[i]!;
    const w = floor(clamp(p.z, 0, 1).mul(sy)).min(sy.sub(1)).add(0.5).div(sy);
    const tn = texture3D(dryTextures[i]!, vec3(clamp(p.x, 0, 1), clamp(p.y, 0, 1), w), 0);
    dryNodes.push(tn);
    dry = max(dry, select(inside, tn.r, float(0)));
  }
  return dry;
}
