/**
 * Player models and name tags in the three.js backend (package 12), without a GPU (the backend in
 * the state init() leaves it in, as in backend.test.ts). The same code runs on WebGPU and on the
 * WebGL2 fallback (only the renderer differs); both are drawn in scripts/e2e-players.mjs.
 *  - name tags: one per text, created with the player, re-made when the text changes, shared by two
 *    players with the same name, gone when the player leaves or dies and when the world closes;
 *    sized to stay readable far away, fading with the fog at their distance (in air and under water)
 *    and hidden where it is opaque;
 *  - the model: head turn limited and pitch applied, the held item in the right hand, the postures,
 *    the walk swinging only with the own motion handed over.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import type { EntityRenderState, PlayerPosture } from '../../src/render/backend';
import { ThreeBackend } from '../../src/render/three/backend';
import { HEAD_TURN_LIMIT, type EntityLayer } from '../../src/render/three/entities';
import { LABEL_MAX_PX, LABEL_MIN_PX, LABEL_WORLD_HEIGHT, labelHeight, labelText, labelView, type LabelView } from '../../src/render/three/labels';
import { computeFog, createFogParams, fogFactor } from '../../src/render/three/lighting';

interface Internals {
  buildPipelines(): void;
  ready: boolean;
  entities: EntityLayer;
  camWorld: { x: number; y: number; z: number };
  viewDistance: number;
}

function readyBackend(): { be: ThreeBackend; layer: EntityLayer } {
  const be = new ThreeBackend({ forceWebGL: true });
  const i = be as unknown as Internals;
  i.buildPipelines();
  i.ready = true;
  return { be, layer: i.entities };
}

function player(id: number, over: Partial<EntityRenderState> = {}): EntityRenderState {
  return { id, kind: 'player', x: id * 3, y: 40, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, payload: 0, flash: 0, sky: 15, block: 0, headYaw: 0, headPitch: 0, held: 0, posture: 'stand', label: `P${id}`, ...over };
}

/** A camera at (0, 42, 10) with the fog of a 200-block view distance in air at noon. */
const VIEW: LabelView = { ...labelView(), x: 0, y: 42, z: 10, fov: 70, viewportPx: 540, fog: computeFog(200, 'none', 1, createFogParams()) };

/** The view's tag sprite and its model parts by role (see entities.ts PlayerView). */
function parts(layer: EntityLayer, id: number) {
  const v = layer.viewOf(id)!;
  const root = v.root as THREE.Group;
  const sprite = root.children.find((o) => o instanceof THREE.Sprite) as THREE.Sprite;
  const groups = root.children.filter((o) => o instanceof THREE.Group) as THREE.Group[];
  const upper = groups[0]!;
  const legs = root.children.filter((o) => o instanceof THREE.Mesh) as THREE.Mesh[];
  const neck = upper.children.find((o) => o instanceof THREE.Group) as THREE.Group;
  const arms = upper.children.filter((o) => o instanceof THREE.Mesh).slice(1) as THREE.Mesh[];
  const hand = arms[1]!.children[0] as THREE.Mesh;
  return { root, sprite, upper, neck, armL: arms[0]!, armR: arms[1]!, legL: legs[0]!, legR: legs[1]!, hand };
}

describe('name tags', () => {
  it('are created with their players, re-made when the text changes, shared by equal names, removed with the player and when the world closes', () => {
    const { be, layer } = readyBackend();
    be.setEntities([player(1), player(2), player(3, { label: 'P1' })]);
    layer.animate(0, VIEW);
    expect(layer.labels.size).toBe(2); // 'P1' twice, 'P2'
    expect(layer.viewOf(1)!.labelText).toBe('P1');
    expect(layer.viewOf(3)!.labelText).toBe('P1');
    const s1 = parts(layer, 1).sprite;
    expect(s1.visible).toBe(true);
    expect(s1.material).toBe(parts(layer, 3).sprite.material);
    // Renamed: a new texture; the old one goes once nobody shows it.
    be.setEntities([player(1, { label: 'Ada' }), player(2), player(3, { label: 'P1' })]);
    layer.animate(0.1, VIEW);
    expect(layer.viewOf(1)!.labelText).toBe('Ada');
    expect(layer.labels.size).toBe(3);
    be.setEntities([player(1, { label: 'Ada' }), player(2)]);
    expect(layer.labels.size).toBe(2); // 3 left: 'P1' released
    // No label: no tag.
    be.setEntities([player(1, { label: null }), player(2)]);
    layer.animate(0.2, VIEW);
    expect(parts(layer, 1).sprite.visible).toBe(false);
    expect(layer.labels.size).toBe(1);
    // A view handed to another entity starts from its own text (pooled views keep nothing).
    be.setEntities([player(4, { label: 'Dov' })]);
    layer.animate(0.3, VIEW);
    expect(layer.labels.size).toBe(1);
    expect(layer.viewOf(4)!.labelText).toBe('Dov');
    be.setEntities([]);
    expect(layer.labels.size).toBe(0);
    be.setEntities([player(5), player(6)]);
    layer.animate(0.4, VIEW);
    expect(layer.labels.size).toBe(2);
    be.dispose();
    expect(layer.labels.size).toBe(0);
  });

  it('a texture and its material are disposed when the last tag lets go of them', () => {
    const { be, layer } = readyBackend();
    be.setEntities([player(1, { label: 'Zed' })]);
    layer.animate(0, VIEW);
    const mat = parts(layer, 1).sprite.material as THREE.SpriteNodeMaterial;
    let disposed = 0;
    mat.addEventListener('dispose', () => disposed++);
    be.setEntities([player(1, { label: 'Zed' }), player(2, { label: 'Zed' })]);
    be.setEntities([player(2, { label: 'Zed' })]);
    expect(disposed).toBe(0);
    be.setEntities([]);
    expect(disposed).toBe(1);
    be.dispose();
  });

  it('keep at least LABEL_MIN_PX on screen far away, LABEL_WORLD_HEIGHT between, at most LABEL_MAX_PX close by; hidden beyond the view distance; not for other kinds', () => {
    const px = (d: number): number => (labelHeight(d, 70, 540) / (2 * Math.tan((35 * Math.PI) / 180) * d)) * 540;
    expect(labelHeight(6, 70, 540)).toBe(LABEL_WORLD_HEIGHT);
    for (const d of [20, 60, 150]) expect(px(d)).toBeGreaterThanOrEqual(LABEL_MIN_PX - 1e-9);
    // A player a block or two away (package 11): the tag stops growing on screen.
    for (const d of [0.4, 1, 2, 3]) expect(px(d)).toBeCloseTo(LABEL_MAX_PX, 6);
    for (let d = 0.3; d < 200; d *= 1.1) {
      expect(px(d)).toBeLessThanOrEqual(LABEL_MAX_PX + 1e-9);
      expect(px(d)).toBeGreaterThanOrEqual(LABEL_MIN_PX - 1e-9);
    }
    const { be, layer } = readyBackend();
    be.setEntities([player(1, { x: 0, z: 0 }), player(2, { x: 0, z: -300 }), { ...player(3), kind: 'rabbit', label: null }]);
    layer.animate(0, VIEW);
    const near = parts(layer, 1).sprite;
    expect(near.visible).toBe(true);
    expect(near.scale.y).toBeCloseTo(labelHeight(Math.hypot(10, 2 + 0.12), 70, 540), 1);
    expect(near.position.y).toBeGreaterThan(1.82);
    expect(parts(layer, 2).sprite.visible).toBe(false); // 300 blocks: beyond the fog
    expect(layer.labels.size).toBe(2);
    be.dispose();
  });

  it('fade with the fog at their own distance, as the body does, and are hidden where it is opaque: in air and under water', () => {
    const { be, layer } = readyBackend();
    // Render distance 4 (64 blocks): the fog runs from 35 to 63 blocks.
    const air = computeFog(64, 'none', 1, createFogParams());
    const view: LabelView = { ...VIEW, fog: air };
    const at = (z: number) => player(Math.round(z) + 1000, { x: 0, y: 40, z: 10 - z, label: 'Same' });
    be.setEntities([at(5), at(45), at(55), at(60), at(70)]);
    layer.animate(0, view);
    const tag = (z: number) => parts(layer, Math.round(z) + 1000).sprite;
    const dist = (z: number) => Math.hypot(z, 40 + 1.82 + 0.18 - 42);
    expect(tag(5).visible).toBe(true);
    expect(tag(5).userData.tagAlpha).toBe(1);
    for (const z of [45, 55]) {
      expect(tag(z).visible).toBe(true);
      expect(tag(z).userData.tagAlpha).toBeCloseTo(1 - fogFactor(air, dist(z)), 9);
    }
    expect(tag(45).userData.tagAlpha).toBeGreaterThan(tag(55).userData.tagAlpha);
    expect(tag(55).userData.tagAlpha).toBeLessThan(0.5);
    // At 60 blocks the boat and its crew are all but lost in the fog (factor 0.97): so are their
    // names, as faint as the bodies; past the fog's end they are not drawn.
    expect(fogFactor(air, dist(60))).toBeGreaterThan(0.96);
    expect(tag(60).userData.tagAlpha).toBeLessThan(0.04);
    expect(tag(70).visible).toBe(false);
    // The tags share one material (same text) and still fade each at its own distance: the opacity is per sprite.
    expect(tag(45).material).toBe(tag(55).material);
    expect((tag(45).material as THREE.SpriteNodeMaterial).opacityNode).not.toBeNull();
    // Under water the short exponential fog of the medium applies.
    const water = computeFog(64, 'water', 1, createFogParams());
    layer.animate(0.1, { ...VIEW, fog: water });
    expect(tag(5).userData.tagAlpha).toBeCloseTo(1 - fogFactor(water, dist(5)), 9);
    expect(tag(5).userData.tagAlpha).toBeLessThan(0.7);
    expect(tag(45).visible).toBe(false);
    be.dispose();
  });

  it('text: control characters dropped, at most 24 code points', () => {
    expect(labelText('a\u0000b\u007fc\u0085d')).toBe('abcd');
    expect(labelText('船'.repeat(30))).toBe('船'.repeat(24));
  });
});

describe('the player model', () => {
  it('turns the head within HEAD_TURN_LIMIT of the body, tilts it by the pitch; holds the item in the right hand', () => {
    const { be, layer } = readyBackend();
    be.setEntities([player(1, { yaw: 0.5, headYaw: 0.9, headPitch: 0.4, held: B.PLANKS_OAK }), player(2, { yaw: 0, headYaw: 3, held: I.GLUE }), player(3)]);
    layer.animate(0, VIEW);
    const a = parts(layer, 1);
    expect(a.root.rotation.y).toBeCloseTo(0.5, 9);
    expect(a.neck.rotation.y).toBeCloseTo(0.4, 9);
    expect(a.neck.rotation.x).toBeCloseTo(0.4, 9);
    expect(a.hand.visible).toBe(true);
    expect(parts(layer, 2).neck.rotation.y).toBeCloseTo(HEAD_TURN_LIMIT, 9);
    expect(parts(layer, 2).hand.visible).toBe(true);
    expect(parts(layer, 2).hand.geometry).not.toBe(a.hand.geometry);
    expect(parts(layer, 3).hand.visible).toBe(false);
    // The right arm is raised a little while holding something.
    expect(a.armR.rotation.x).toBeGreaterThan(parts(layer, 3).armR.rotation.x + 0.2);
    be.dispose();
  });

  it('postures: sneaking bends and lowers, sprinting leans, flying trails the legs, at the helm both hands reach for the wheel', () => {
    const { be, layer } = readyBackend();
    const postures: PlayerPosture[] = ['stand', 'sneak', 'sprint', 'fly', 'helm'];
    be.setEntities(postures.map((p, i) => player(i + 1, { posture: p, vx: p === 'sprint' || p === 'fly' ? 5.6 : 0 })));
    layer.animate(0, VIEW);
    layer.animate(0.5, VIEW);
    const [stand, sneak, sprint, fly, helm] = postures.map((_, i) => parts(layer, i + 1));
    expect(sneak!.upper.rotation.x).toBeLessThan(-0.3);
    expect(sneak!.root.position.y).toBeLessThan(stand!.root.position.y - 0.1);
    expect(sneak!.sprite.position.y).toBeLessThan(stand!.sprite.position.y);
    expect(sprint!.upper.rotation.x).toBeLessThan(-0.1);
    expect(fly!.legL.rotation.x + fly!.legR.rotation.x).toBeLessThan(-0.6);
    expect(helm!.armL.rotation.x).toBeGreaterThan(1);
    expect(helm!.armR.rotation.x).toBeGreaterThan(1);
    expect(stand!.upper.rotation.x).toBe(0);
    be.dispose();
  });

  it('walks only with the own motion handed over: legs swing at walking speed, stay still at none (whatever the position does)', () => {
    const { be, layer } = readyBackend();
    let maxSwingWalk = 0;
    let maxSwingCarried = 0;
    for (let f = 0; f < 120; f++) {
      const t = f / 60;
      // 1 walks at 4.3 b/s; 2 is carried at 8 b/s by a ship and turned with it, no own motion.
      be.setEntities([player(1, { x: t * 4.3, vx: 4.3 }), player(2, { x: 10 + t * 8, z: Math.sin(t), yaw: t, headYaw: t })]);
      layer.animate(t, VIEW);
      maxSwingWalk = Math.max(maxSwingWalk, Math.abs(parts(layer, 1).legL.rotation.x));
      maxSwingCarried = Math.max(maxSwingCarried, Math.abs(parts(layer, 2).legL.rotation.x));
    }
    expect(maxSwingWalk).toBeGreaterThan(0.6);
    expect(maxSwingCarried).toBe(0);
    be.dispose();
  });

  it('freezes as it is when time stops (the world paused): the walk does not snap to rest', () => {
    const { be, layer } = readyBackend();
    for (let f = 0; f < 50; f++) {
      be.setEntities([player(1, { x: f * 0.07, vx: 4.3 })]);
      layer.animate(f / 60, VIEW);
    }
    const p = parts(layer, 1);
    const pose = [p.legL.rotation.x, p.legR.rotation.x, p.armL.rotation.x, p.armR.rotation.x];
    expect(Math.abs(pose[0]!)).toBeGreaterThan(0.1);
    // Paused: the display time stands still and the view builder reports no own motion.
    for (let f = 0; f < 5; f++) {
      be.setEntities([player(1, { x: 49 * 0.07, vx: 0 })]);
      layer.animate(49 / 60, VIEW);
      expect([p.legL.rotation.x, p.legR.rotation.x, p.armL.rotation.x, p.armR.rotation.x]).toEqual(pose);
    }
    be.dispose();
  });

  it('a one-frame jump of the measured motion (an unflagged teleport) is not a run: the limbs stay calm', () => {
    const { be, layer } = readyBackend();
    let prev = 0;
    let maxStep = 0;
    let maxSwing = 0;
    for (let f = 0; f < 60; f++) {
      be.setEntities([player(1, { vx: f === 10 ? 1800 : 0 })]);
      layer.animate(f / 60, VIEW);
      const a = parts(layer, 1).legL.rotation.x;
      maxStep = Math.max(maxStep, Math.abs(a - prev));
      maxSwing = Math.max(maxSwing, Math.abs(a));
      prev = a;
    }
    expect(maxSwing).toBeLessThan(0.3);
    expect(maxStep).toBeLessThan(0.1);
    expect(prev).toBe(0); // settled
    be.dispose();
  });
});
