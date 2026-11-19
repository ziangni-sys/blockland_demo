/**
 * End to end (package 12): what the view builder hands the renderer for the OTHER players, in a
 * scene of real clients on a 150 ms link with 20 ms jitter and 5% loss (NETCODE section 16's link):
 *  - p (the host's page, the observer) stands on a raft that sails in circles;
 *  - a steers it from the wheel (a real click on the helm, then held keys);
 *  - b stands on its deck, then walks it;
 *  - c stands on an island (the shore), holding glue;
 *  - c is killed: it is not drawn while dead;
 *  - a server-driven player far away is out of p's interest: never in the list.
 * At every frame of p: no entry for p itself (first person); a, b and c are there with their names,
 * held items and postures; b's position in the raft's frame matches the server's at renderTick
 * within the bound of scenario 31 (0.05); the own motion handed over (vx, vy, vz, which drives the
 * walk) is nil for whoever stands (on the deck, at the wheel, on the shore) and b's walking speed
 * on the deck while it walks; a's body faces the wheel. Then the lists go through the three.js
 * backend: one name tag per text, gone when a player leaves and when the world closes.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { vec3, type Vec3 } from '../../src/core/math';
import { WALK_SPEED } from '../../src/entities/constants';
import { headingOf } from '../../src/entities/structs';
import { Ship } from '../../src/structures/structure';
import type { EntityRenderState } from '../../src/render/backend';
import { ThreeBackend } from '../../src/render/three/backend';
import type { EntityLayer } from '../../src/render/three/entities';
import { labelView } from '../../src/render/three/labels';
import { shownPlayer, ViewBuilder } from '../../src/client/view';
import { fill, LINKS, loadArea } from './e2e-scenes';
import type { HeadlessClient, NetHarness } from './harness';
import { assemble, buildRaft, OWN_SEA, OWN_SEA_TOP, ownWorld, stat, type OwnRun } from './own-scenes';

const S = OWN_SEA_TOP;
const LINK_150 = LINKS[1]!;

async function guest(r: OwnRun, key: string, name: string, seed: number): Promise<HeadlessClient> {
  await r.h.host.control({ type: 'openRoom' });
  const c = r.h.addClient(key, LINK_150.make(seed), { viewRadius: 3, name });
  r.h.runUntil(() => c.ready && c.own !== null, 30_000);
  return c;
}

/** The server's local position of entity `id` on ship `shipId` at a fractional tick (harness history), or null. */
function serverLocalAt(h: NetHarness, id: number, shipId: number, tick: number): Vec3 | null {
  const a = h.history.get(Math.floor(tick))?.entities.get(id);
  const b = h.history.get(Math.floor(tick) + 1)?.entities.get(id);
  if (a === undefined || b === undefined || a.carrierId !== shipId || b.carrierId !== shipId) return null;
  const f = tick - Math.floor(tick);
  return vec3(a.local.x + (b.local.x - a.local.x) * f, a.local.y + (b.local.y - a.local.y) * f, a.local.z + (b.local.z - a.local.z) * f);
}

const speed = (s: EntityRenderState): number => Math.hypot(s.vx, s.vy, s.vz);

interface Watch {
  frames: number;
  selfSeen: number;
  farSeen: number;
  missing: Record<string, number>;
  /** Per player key: the entries seen (copies), latest last. */
  seen: Map<string, EntityRenderState[]>;
  bWorstLocal: number;
  bLocalFrames: number;
  aFacing: number[];
}

/** Watches p's frames: runs a ViewBuilder on p's replica (first person) and records what it hands over. */
function watch(h: NetHarness, p: HeadlessClient, ids: Record<string, number>, shipId: number, farId: number, onList?: (list: readonly EntityRenderState[]) => void): Watch {
  const w: Watch = { frames: 0, selfSeen: 0, farSeen: 0, missing: {}, seen: new Map(), bWorstLocal: 0, bLocalFrames: 0, aFacing: [] };
  const view = new ViewBuilder();
  const me = shownPlayer();
  p.onFrame = (now) => {
    const r = p.replica;
    const clock = p.net.clock;
    if (r === null || clock === null || !p.ready || p.own === null || !Number.isFinite(clock.renderTick)) return;
    me.id = r.ownEntityId;
    p.own.displayPos(now, me.feet);
    const list = view.updateEntities(r, me, clock.renderTick, clock.rotorTick);
    onList?.(list);
    w.frames++;
    if (list.some((s) => s.id === me.id)) w.selfSeen++;
    if (list.some((s) => s.id === farId)) w.farSeen++;
    for (const [key, id] of Object.entries(ids)) {
      const s = list.find((x) => x.id === id);
      if (s === undefined) {
        w.missing[key] = (w.missing[key] ?? 0) + 1;
        continue;
      }
      const arr = w.seen.get(key) ?? [];
      arr.push({ ...s });
      w.seen.set(key, arr);
      if (key === 'b') {
        const rs = r.state.structures.get(shipId);
        const want = serverLocalAt(h, id, shipId, clock.renderTick);
        if (rs !== undefined && want !== null) {
          const l = rs.structure.grid.toLocal(vec3(s.x, s.y, s.z));
          w.bLocalFrames++;
          w.bWorstLocal = Math.max(w.bWorstLocal, Math.hypot(l.x - want.x, l.y - want.y, l.z - want.z));
        }
      }
      if (key === 'a' && s.posture === 'helm') {
        // The body faces the wheel: the helm's centre, from the feet, along forward(yaw).
        const ship = r.state.structures.get(shipId)?.structure;
        if (ship instanceof Ship) {
          const hw = ship.grid.toWorld(vec3(ship.helmX + 0.5, ship.helmY + 0.5, ship.helmZ + 0.5));
          const dx = hw.x - s.x;
          const dz = hw.z - s.z;
          const n = Math.hypot(dx, dz);
          w.aFacing.push((-Math.sin(s.yaw) * dx - Math.cos(s.yaw) * dz) / n);
        }
      }
    }
  };
  return w;
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  return a.length === 0 ? NaN : a[Math.floor(a.length / 2)]!;
}

interface Internals {
  buildPipelines(): void;
  ready: boolean;
  entities: EntityLayer;
}

describe('package 12: the other players as the view builder hands them to the renderer (150 ms, 20 ms jitter, 5% loss)', () => {
  it('on a sailing, turning raft: the helmsman faces the wheel, the one on deck stands then walks, the one on shore holds glue, the dead one and the far one are not drawn, the own player never; tags follow the players', async () => {
    // The shore: a stone island west of the raft, its top the sea's surface layer.
    const r = await ownWorld(OWN_SEA, 'survival', LINK_150.make(121), (sim) => fill(sim, -14, S - 6, -6, -6, S - 1, 6, B.STONE));
    const p = r.c;
    const a = await guest(r, 'a', 'Ana', 123);
    const b = await guest(r, 'b', 'Bram 船长', 125);
    const c = await guest(r, 'c', 'Cleo', 127);
    const sim = r.sim;
    const ship = assemble(sim, buildRaft(sim, { x0: 10, z0: 0, x1: 18, z1: 8, y: S - 1, gunwale: true, helm: { x: 14, z: 1 } }));
    // Far away, out of p's interest (a server-driven player, never in p's chunks or structures).
    const far = sim.players.join('far');
    loadArea(sim, 130, 130, 150, 150);
    fill(sim, 139, S + 1, 139, 141, S + 1, 141, B.STONE);
    far.teleport(140.5, S + 2, 140.5);
    r.h.run(500);
    const ctrl = (k: string) => sim.players.get(k)!;
    ctrl('p').teleport(12.5, S, 6.5);
    ctrl('a').teleport(14.5, S, 3.5);
    ctrl('b').teleport(16.5, S, 6.5);
    ctrl('c').teleport(-10.5, S, 0.5);
    ctrl('b').hold(B.PLANKS_OAK, 16);
    ctrl('c').hold(I.GLUE, 1);
    ctrl('a').emptyHand();
    r.h.run(2000);
    for (const k of ['p', 'a', 'b']) expect(ctrl(k).player.carrierId, k).toBe(ship.id);
    expect(ctrl('c').player.carrierId).toBe(0);
    // a takes the wheel: a real click on the helm, then holds forward and a turn.
    expect(a.useOn(14, S, 1, undefined, ship.id)).toBe(true);
    r.h.run(500);
    expect(ctrl('a').player.steeringShipId).toBe(ship.id);
    a.input.forward = 1;
    a.input.strafe = 0.6;
    r.h.run(4000); // up to speed

    const ids = { a: ctrl('a').entityId, b: ctrl('b').entityId, c: ctrl('c').entityId };
    const lists: Array<readonly EntityRenderState[]> = [];
    // The backend side: a renderer-free three.js backend gets every list the builder hands over.
    const be = new ThreeBackend({ forceWebGL: true });
    const bi = be as unknown as Internals;
    bi.buildPipelines();
    bi.ready = true;
    const layer = bi.entities;
    const w = watch(r.h, p, ids, ship.id, far.entityId, (list) => {
      lists.push(list);
      be.setEntities(list);
      layer.animate(lists.length / 60, { ...labelView(), x: 0, y: S + 2, z: 0, fov: 70 });
    });

    // Phase 1: b stands on the deck while the raft sails and turns.
    let turned = 0;
    let lastYaw = headingOf(ship.grid.rotation);
    r.onTick(() => {
      const y = headingOf(ship.grid.rotation);
      turned += Math.abs(Math.atan2(Math.sin(y - lastYaw), Math.cos(y - lastYaw)));
      lastYaw = y;
    });
    r.h.run(8000);
    const standB = (w.seen.get('b') ?? []).slice();
    expect(layer.labels.size).toBe(3);
    expect(layer.viewOf(ids.b)?.labelText).toBe('Bram 船长');

    // Phase 2: b walks the deck back and forth.
    let n = 0;
    b.onStep = () => {
      n++;
      b.input.forward = 0.6;
      if (n % 40 === 0) b.input.yaw += Math.PI;
    };
    const from = w.seen.get('b')?.length ?? 0;
    r.h.run(8000);
    const walkB = (w.seen.get('b') ?? []).slice(from + 30);
    b.onStep = null;
    b.stopInput();

    stat(`p12\tturned ${turned.toFixed(2)} rad; frames ${w.frames}; b local worst ${w.bWorstLocal.toExponential(2)} over ${w.bLocalFrames}; stand b max v ${Math.max(...standB.map(speed)).toExponential(2)}; walk b median v ${median(walkB.map(speed)).toFixed(2)}; a facing min ${Math.min(...w.aFacing).toFixed(4)}`);
    expect(turned).toBeGreaterThan(1);
    expect(w.frames).toBeGreaterThan(800);
    expect(w.selfSeen).toBe(0);
    expect(w.farSeen).toBe(0);
    expect(w.missing).toEqual({});
    // b: where the server has it in the raft's frame (scenario 31's bound).
    expect(w.bLocalFrames).toBeGreaterThan(500);
    expect(w.bWorstLocal).toBeLessThan(0.05);
    // Own motion: standing on the sailing, turning deck is standing; walking is walking.
    expect(standB.length).toBeGreaterThan(300);
    expect(Math.max(...standB.map(speed))).toBeLessThan(0.1); // Pos32 steps: 1/512 block a tick
    const walkSpeed = median(walkB.map(speed));
    expect(walkSpeed).toBeGreaterThan(0.6 * WALK_SPEED * 0.7);
    expect(walkSpeed).toBeLessThan(0.6 * WALK_SPEED * 1.3);
    // a: at the wheel the whole time, still relative to the raft, facing the wheel, empty-handed.
    const seenA = w.seen.get('a')!;
    expect(seenA.every((s) => s.posture === 'helm')).toBe(true);
    expect(Math.max(...seenA.map(speed))).toBeLessThan(0.05);
    expect(w.aFacing.length).toBeGreaterThan(500);
    expect(Math.min(...w.aFacing)).toBeGreaterThan(0.99);
    expect(seenA.every((s) => s.held === 0 && s.label === 'Ana')).toBe(true);
    // b: planks in hand, its name; c: glue in hand on the shore, standing still.
    expect(w.seen.get('b')!.every((s) => s.held === B.PLANKS_OAK && s.label === 'Bram 船长' && s.posture !== 'helm')).toBe(true);
    const seenC = w.seen.get('c')!;
    expect(seenC.every((s) => s.held === I.GLUE && s.label === 'Cleo' && s.posture === 'stand')).toBe(true);
    expect(Math.max(...seenC.map(speed))).toBeLessThan(0.05);
    expect(Math.abs(seenC.at(-1)!.x - -10.5)).toBeLessThan(0.05);
    // Every entry is a person in a state the renderer understands.
    for (const list of lists) for (const s of list) if (s.kind === 'player') expect(Number.isFinite(s.x + s.y + s.z + s.yaw + s.headYaw + s.headPitch + s.vx + s.vy + s.vz)).toBe(true);

    // c dies: still an entity of p's replica (flag dead), not drawn, its tag gone.
    sim.entities.kill(ctrl('c').player, 'test');
    r.h.run(1500);
    expect(ctrl('c').player.dead).toBe(true);
    expect(p.replica!.state.entities.get(ids.c)?.player?.flags.dead).toBe(true);
    const missingC = w.missing.c ?? 0;
    r.h.run(1000);
    expect((w.missing.c ?? 0) - missingC).toBeGreaterThan(30);
    expect(lists.at(-1)!.some((s) => s.id === ids.c)).toBe(false);
    expect(layer.viewOf(ids.c)).toBeNull();
    expect(layer.labels.size).toBe(2);

    // b leaves: its entry and its tag go; then the world closes: nothing stays behind.
    b.net.leave();
    r.h.run(1500);
    expect(lists.at(-1)!.some((s) => s.id === ids.b)).toBe(false);
    expect(layer.viewOf(ids.b)).toBeNull();
    expect(layer.labels.size).toBe(1);
    const sprites: THREE.Object3D[] = [];
    layer.group.traverse((o) => {
      if (o instanceof THREE.Sprite && o.visible) sprites.push(o);
    });
    expect(sprites.length).toBe(1);
    be.setEntities([]);
    expect(layer.labels.size).toBe(0);
    be.dispose();
    expect(layer.labels.size).toBe(0);
  }, 240_000);
});
