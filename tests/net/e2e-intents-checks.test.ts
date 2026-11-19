/**
 * Package 7 end to end: the server's checks of a target (NETCODE section 10) on the three links.
 *  - A target whose block changed on the server before the intent arrived (mined, replaced, the
 *    helm removed) is no target; one out of reach is no target (a forged intent).
 *  - A forged movement report (standing next to a far target, of the present epoch or a stale
 *    one) lends no eyes to the intents that refer to it: only reports package 2 accepted count.
 *  - A click on a ship that sailed on meanwhile still lands, up to some speed per link (measured).
 *  - Hold-to-mine and the timed glue while walking, sprinting and riding a moving ship (a target on
 *    the deck, and one on a pier passing by), and hold-to-mine while flying fast: never
 *    interrupted by the checks on the first two links.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PX, PY, type Dir } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import type { Ship } from '../../src/structures/structure';
import { fill, LINKS } from './e2e-scenes';
import type { NetMoveReport } from '../../src/net/protocol';
import type { ClientLink, HeadlessClient } from './harness';
import { assemble, buildRaft, LAND, LAND_TOP, OWN_SEA, OWN_SEA_TOP, ownWorld, SEA_FLOOR, stat, type OwnRun } from './own-scenes';

const T = LAND_TOP;
const S = OWN_SEA_TOP;

/** Send a forged intent with the client's next seq (a client of this build never sends it). */
function forge(c: HeadlessClient, m: Record<string, unknown> & { type: string }): void {
  const it = c.intents!;
  it.seq++;
  c.net.send({ ...m, seq: it.seq } as never);
}

describe('package 7: a target that changed before its intent arrived, or out of reach, is no target', () => {
  for (const [i, l] of LINKS.entries()) {
    it(`on ${l.name}`, async () => {
      const r = await ownWorld(LAND, 'creative', l.make(200 + i));
      const { c, sim, h } = r;
      sim.world.setCell(2, T, 0, makeCell(B.COBBLE));
      sim.world.setCell(-2, T, 0, makeCell(B.BRICKS));
      sim.world.setCell(0, T, -2, makeCell(B.HELM, facingState(NZ)));
      h.run(50);
      c.catchUp(sim.ticks);
      // Mined meanwhile: the Use with planks in hand on its top face places nothing.
      c.hold(B.PLANKS_OAK);
      c.waitAck();
      expect(c.aimAt(2, T, 0, PY)).toBe(true);
      c.use();
      sim.world.setCell(2, T, 0, makeCell(B.AIR));
      c.waitAck();
      expect(sim.world.getCell(2, T, 0) & ID_MASK).toBe(B.AIR);
      expect(sim.world.getCell(2, T + 1, 0) & ID_MASK).toBe(B.AIR);
      // Replaced meanwhile: the left-click does not mine the stone that took the bricks' place.
      expect(c.aimAt(-2, T, 0, PY, 0, true)).toBe(true);
      c.attack();
      sim.world.setCell(-2, T, 0, makeCell(B.STONE));
      c.waitAck();
      expect(sim.world.getCell(-2, T, 0) & ID_MASK).toBe(B.STONE);
      // The helm removed meanwhile (cobble in its place): no preview, nothing placed against the cobble.
      c.emptyHand();
      c.waitAck();
      expect(c.aimAt(0, T, -2, PY)).toBe(true);
      c.use();
      sim.world.setCell(0, T, -2, makeCell(B.COBBLE));
      c.waitAck();
      expect(r.ctrl.view.preview).toBeNull();
      c.hold(B.PLANKS_OAK);
      c.waitAck();
      sim.world.setCell(0, T, -2, makeCell(B.HELM, facingState(NZ)));
      h.run(50);
      c.catchUp(sim.ticks);
      expect(c.aimAt(0, T, -2, PY)).toBe(true);
      c.use();
      sim.world.setCell(0, T, -2, makeCell(B.COBBLE));
      c.waitAck();
      expect(sim.world.getCell(0, T + 1, -2) & ID_MASK).toBe(B.AIR);
      expect(h.intentStats('p')!.failed.cell).toBeGreaterThanOrEqual(4); // the clicks (and aims that went with them)
      // Out of reach (forged): a block 8 away is not mined; one in reach behind another block is (no occlusion check).
      sim.world.setCell(8, T, 0, makeCell(B.STONE));
      sim.world.setCell(3, T, 1, makeCell(B.STONE));
      sim.world.setCell(3, T, 0, makeCell(B.STONE));
      h.run(50);
      c.catchUp(sim.ticks);
      const moveSeq = c.own!.lastSeq;
      forge(c, { type: 'attack', moveSeq, slot: c.inventory.selected, target: { gridId: 0, x: 8, y: T, z: 0, face: PY, sub: 0, cell: makeCell(B.STONE) } });
      forge(c, { type: 'attackRelease' });
      forge(c, { type: 'attack', moveSeq, slot: c.inventory.selected, target: { gridId: 0, x: 3, y: T, z: 1, face: PX, sub: 0, cell: makeCell(B.STONE) } });
      forge(c, { type: 'attackRelease' });
      c.waitAck();
      expect(sim.world.getCell(8, T, 0) & ID_MASK).toBe(B.STONE);
      expect(sim.world.getCell(3, T, 1) & ID_MASK).toBe(B.AIR);
      expect(h.intentStats('p')!.failed.reach).toBe(1);
    }, 60_000);
  }
});

describe('package 7: a forged movement report lends no eyes to the intents that refer to it', () => {
  for (const [i, l] of LINKS.entries()) {
    it(`on ${l.name}`, async () => {
      const r = await ownWorld(LAND, 'creative', l.make(250 + i));
      const { c, sim, h } = r;
      // About 30 blocks from the player at (0.5, T, 0.5).
      sim.world.setCell(20, T, 22, makeCell(B.BRICKS));
      sim.world.setCell(-20, T, 22, makeCell(B.TNT));
      h.run(50);
      c.catchUp(sim.ticks);
      c.emptyHand();
      c.waitAck();
      let last: NetMoveReport | null = null;
      c.onReport = (rep) => {
        last = { ...rep, pos: { ...rep.pos }, vel: { ...rep.vel } };
      };
      h.run(100);
      const moves = h.sinks!.moves;
      const tnt = (): number => sim.entities.all().filter((e) => e.kind === 'tnt').length;
      let reach = h.intentStats('p')!.failed.reach;
      for (const present of [true, false]) {
        const at = present ? { x: 20, z: 22 } : { x: -20, z: 22 };
        const epoch = present ? r.ctrl.player.remote!.epoch : 0;
        // The forged report: feet next to the target, the next seq. It is put straight into the
        // server's queue (the unreliable channel of a lossy link might lose it).
        const forged: NetMoveReport = { ...last!, epoch, seq: c.own!.lastSeq + 1, pos: { x: at.x + 0.5, y: T, z: at.z - 1.5 }, vel: { x: 0, y: 0, z: 0 } };
        moves.receive('p', forged);
        const target = { gridId: 0, x: at.x, y: T, z: at.z, face: PY, sub: 0, cell: sim.world.getCell(at.x, T, at.z) };
        if (present) forge(c, { type: 'attack', moveSeq: forged.seq, slot: c.inventory.selected, target });
        else forge(c, { type: 'use', moveSeq: forged.seq, slot: c.inventory.selected, sneak: false, slabMode: 0, target });
        forge(c, { type: present ? 'attackRelease' : 'useRelease' });
        c.waitAck();
        h.run(200);
        expect(h.intentStats('p')!.failed.reach).toBe(reach + 1);
        reach++;
      }
      expect(sim.world.getCell(20, T, 22) & ID_MASK).toBe(B.BRICKS);
      expect(sim.world.getCell(-20, T, 22) & ID_MASK).toBe(B.TNT);
      expect(tnt()).toBe(0);
      expect(Math.hypot(r.ctrl.player.pos.x - 0.5, r.ctrl.player.pos.z - 0.5)).toBeLessThan(1);
      // The client goes on as before: adopts the correction for the refused report, and clicks in reach.
      c.onReport = null;
      sim.world.setCell(2, T, 0, makeCell(B.BRICKS));
      h.run(50);
      c.catchUp(sim.ticks);
      expect(c.aimAt(2, T, 0, PY, 0, true)).toBe(true);
      c.attack();
      c.waitAck();
      expect(sim.world.getCell(2, T, 0) & ID_MASK).toBe(B.AIR);
    }, 60_000);
  }
});

// ====================================================================== a ship passing by

/**
 * A plank raft 2 wide and 21 long sails east past a pier at `speed` (held there); the player on the
 * pier left-clicks (creative) a deck cell when the client shows it right in front. Did it break?
 */
async function passingShip(link: ClientLink, speed: number): Promise<{ landed: boolean; viewLag: number }> {
  const r = await ownWorld(OWN_SEA, 'creative', link, (sim) => {
    fill(sim, -40, S - 1, 2, -20, S - 1, 3, B.PLANKS_OAK);
    sim.world.setCell(-22, S, 2, makeCell(B.HELM, facingState(NZ)));
  });
  const { c, sim, h } = r;
  const ship = assemble(sim, vec3(-22, S, 2));
  r.onTick(() => {
    if (!ship.removed) {
      ship.grid.linearVelocity.x = speed;
      ship.grid.linearVelocity.z = 0;
      ship.grid.angularVelocity.x = ship.grid.angularVelocity.y = ship.grid.angularVelocity.z = 0;
    }
  });
  c.emptyHand();
  c.waitAck();
  // Wait until the client shows the middle of the deck right in front of the player (x 0.5).
  const midLocal = -30;
  const shownX = (): number => {
    const rs = c.replica!.state.structures.get(ship.id);
    return rs === undefined ? -Infinity : rs.structure.grid.toWorld({ x: midLocal + 0.5, y: S - 0.5, z: 2.5 }).x;
  };
  h.runUntil(() => shownX() >= 0.5, 120_000, 1);
  const before = ship.grid.getCell(midLocal, S - 1, 2);
  if (!c.aimAt(midLocal, S - 1, 2, PY, ship.id, true)) throw new Error(`speed ${speed}: cannot aim at the deck`);
  c.attack();
  const viewLag = (h.sinks!.moves as unknown as { viewLag(k: string): number | null }).viewLag('p') ?? 0;
  c.waitAck();
  return { landed: ship.grid.getCell(midLocal, S - 1, 2) !== before, viewLag };
}

describe('package 7: a click on a ship that sailed on meanwhile lands (measured per link)', () => {
  const speeds = [2, 4, 6, 8, 10, 12, 14];
  for (const [i, l] of LINKS.entries()) {
    it(`on ${l.name}`, async () => {
      const results: string[] = [];
      let fastest = 0;
      for (const v of speeds) {
        const res = await passingShip(l.make(300 + 10 * i + v), v);
        results.push(`${v} b/s ${res.landed ? 'lands' : 'refused'} (view lag ${res.viewLag} ticks)`);
        if (res.landed && fastest === v - 2) fastest = v;
      }
      stat(`passing ship, ${l.name}: ${results.join('; ')}`);
      // The game's fastest ship (10.5 blocks/s with 40 sails) is clicked on every link.
      expect(fastest, results.join('; ')).toBeGreaterThanOrEqual(10);
    }, 300_000);
  }
});

// ====================================================================== holding the button while moving

type Motion = 'walk' | 'sprint' | 'ride deck' | 'ride pier';
type What = 'mine' | 'glue';

interface HoldResult {
  done: boolean;
  /** Times the server's progress fell back (or vanished) before it was done. */
  interruptions: number;
  /** Ticks from the first progress to done, and the least it can take. */
  ticks: number;
  expected: number;
  /** How far the player moved (world, blocks) from the press to done. */
  moved: number;
}

/**
 * The player holds a button on one cell (keeping its aim at every frame) while moving: walking (circling
 * the block, strafing), sprinting (forward and to the side), or standing on a raft sailing at 4 b/s
 * (the target on its deck, or on a pier it passes). Survival: mining a plank or stone, or gluing its top face.
 */
async function holdWhileMoving(link: ClientLink, what: What, motion: Motion): Promise<HoldResult> {
  const ride = motion === 'ride deck' || motion === 'ride pier';
  let r: OwnRun;
  let target: { x: number; y: number; z: number; face: Dir; gridId: number };
  let ship: Ship | null = null;
  if (!ride) {
    r = await ownWorld(LAND, 'survival', link, (sim) => sim.world.setCell(0, T, -3, makeCell(B.STONE)), 3);
    target = { x: 0, y: T, z: -3, face: PY, gridId: 0 };
    r.ctrl.teleport(motion === 'walk' ? 3.5 : 3.5, T, motion === 'walk' ? -2.5 : 0.5);
  } else {
    r = await ownWorld(OWN_SEA, 'survival', link, (sim) => {
      // A pier along the course: a stone wall north of it, its top at y S.
      fill(sim, 0, SEA_FLOOR, -3, 60, S, -3, B.STONE);
    }, 3);
    const helm = buildRaft(r.sim, { x0: 10, z0: -1, x1: 18, z1: 3, y: S - 1, helm: { x: 11, z: 1, facing: NZ } });
    r.sim.world.setCell(15, S, 1, makeCell(B.PLANKS_OAK));
    ship = assemble(r.sim, helm);
    r.ctrl.teleport(14.5, S, -0.5);
    target = motion === 'ride deck' ? { x: 15, y: S, z: 1, face: PY, gridId: ship.id } : { x: 17, y: S, z: -3, face: PY, gridId: 0 };
  }
  const { c, sim, h, ctrl } = r;
  h.run(1500);
  if (what === 'glue') c.hold(I.GLUE);
  else c.emptyHand();
  c.waitAck();
  if (ship !== null) {
    const s = ship;
    r.onTick(() => {
      if (!s.removed) s.grid.linearVelocity.x = 4;
    });
    h.run(1000);
    // The pier block 3 ahead: it passes by within reach while it is mined (6 blocks at 4 b/s).
    if (motion === 'ride pier') target.x = Math.floor(ctrl.player.pos.x) + 3;
  }
  const grid = (): { getCell(x: number, y: number, z: number): number } => sim.structures.gridById(target.gridId)!;
  const before = grid().getCell(target.x, target.y, target.z);
  const done = (): boolean => (what === 'mine' ? grid().getCell(target.x, target.y, target.z) !== before : sim.structures.glueFor(sim.structures.gridById(target.gridId)!).has(target.x, target.y, target.z, target.face));
  // Server side: the progress of the operation every tick.
  const res: HoldResult = { done: false, interruptions: 0, ticks: 0, expected: 30, moved: 0 };
  const from = { ...ctrl.player.pos };
  let last = 0;
  let first = -1;
  r.onTick(() => {
    if (res.done) return;
    if (done()) {
      res.done = true;
      res.ticks = first < 0 ? 0 : sim.ticks - first;
      const p = ctrl.player.pos;
      res.moved = Math.hypot(p.x - from.x, p.z - from.z);
      return;
    }
    const v = what === 'mine' ? ctrl.view.mining : ctrl.view.gluing;
    const p = v === null ? 0 : v.progress;
    if (p > 0 && first < 0) first = sim.ticks - 1;
    if (last > 0 && p < last) res.interruptions++;
    last = p;
  });
  if (!c.aimAt(target.x, target.y, target.z, target.face, target.gridId, what === 'mine')) throw new Error(`${motion}: cannot aim at the target`);
  c.holdAim(target);
  const i = c.input;
  if (motion === 'walk') i.strafe = 1;
  if (motion === 'sprint') {
    i.forward = 1;
    i.strafe = 1;
    i.sprint = true;
  }
  if (what === 'mine') c.pressAttack();
  else c.pressUse();
  h.runUntil(() => res.done, 6000, 1);
  c.holdAim(null);
  c.stopInput();
  c.waitAck();
  return res;
}

describe('package 7: holding a button while moving is never interrupted by the checks (first two links)', () => {
  const motions: Motion[] = ['walk', 'sprint', 'ride deck', 'ride pier'];
  for (const [i, l] of LINKS.entries()) {
    it(`on ${l.name}`, async () => {
      const lines: string[] = [];
      let interrupted = 0;
      for (const what of ['mine', 'glue'] as const) {
        for (const m of motions) {
          const res = await holdWhileMoving(l.make(400 + 10 * i + motions.indexOf(m)), what, m);
          expect(res.done, `${what} ${m}`).toBe(true);
          expect(res.moved, `${what} ${m}: the player moved`).toBeGreaterThan(2);
          interrupted += res.interruptions;
          lines.push(`${what} ${m}: ${res.interruptions} interruptions, ${res.ticks} ticks (least ${res.expected}), moved ${res.moved.toFixed(1)} blocks`);
        }
      }
      stat(`hold while moving, ${l.name}: ${lines.join('; ')}`);
      if (i < 2) expect(interrupted, lines.join('; ')).toBe(0);
    }, 300_000);
  }
});

/** Creative: sprint-flying 1.5 blocks above the ground, looking down ahead, the left button held for 2 s. */
async function flyMining(link: ClientLink): Promise<{ broken: number; reachFailures: number; heldTicks: number }> {
  const r = await ownWorld(LAND, 'creative', link, undefined, 3);
  const { c, sim, h } = r;
  r.ctrl.teleport(0.5, T + 1.5, 0.5);
  h.run(500);
  c.emptyHand();
  c.waitAck();
  c.input.jumpPresses += 2; // double tap: fly
  h.run(400);
  let broken = 0;
  sim.events.on((e) => {
    if (e.type === 'blockBroken') broken++;
  });
  c.input.yaw = -Math.PI / 2; // east
  c.input.pitch = -Math.PI / 4;
  c.input.forward = 1;
  c.input.sprint = true;
  h.run(500);
  const t0 = sim.ticks;
  c.pressAttack();
  h.run(2000);
  c.releaseAttack();
  c.stopInput();
  c.waitAck();
  const st = h.intentStats('p')!;
  return { broken, reachFailures: st.failed.reach + st.aimFailed.reach, heldTicks: sim.ticks - t0 };
}

describe('package 7: hold-to-mine while sprint-flying (creative)', () => {
  for (const [i, l] of LINKS.entries()) {
    it(`on ${l.name}`, async () => {
      const res = await flyMining(l.make(500 + i));
      stat(`fly-mining, ${l.name}: ${res.broken} blocks broken in ${res.heldTicks} ticks held, ${res.reachFailures} reach failures`);
      expect(res.broken).toBeGreaterThan(3);
      if (i < 2) expect(res.reachFailures).toBe(0);
    }, 60_000);
  }
});

describe('LESSONS 界岩能直接放到船上: a Use intent goes through the same place()', () => {
  it('deeprock onto a ship is refused with the toast; into the world it is placed', async () => {
    const r = await ownWorld(OWN_SEA, 'creative', LINKS[1]!.make(900));
    const { c, sim, h, ctrl } = r;
    const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 14, z1: 4, y: S - 1, helm: { x: 12, z: 1, facing: NZ } });
    const ship = assemble(sim, helm);
    sim.world.setCell(9, S - 1, 6, makeCell(B.STONE));
    ctrl.teleport(12.5, S, 3.5);
    h.run(1500);
    const toasts: string[] = [];
    c.onBatch = (b) => {
      for (const e of b.private?.events ?? []) if (e.type === 'toast') toasts.push(e.message.key);
    };
    c.hold(B.DEEPROCK);
    c.waitAck();
    const cells = ship.grid.count;
    expect(c.useOn(13, S - 1, 3, PY, ship.id)).toBe(true);
    expect(ship.grid.count).toBe(cells);
    expect(ship.grid.getCell(13, S, 3) & ID_MASK).toBe(B.AIR);
    expect(toasts).toEqual(['toast.place.notOnStructure']);
    expect(c.useOn(9, S - 1, 6, PY)).toBe(true);
    expect(sim.world.getCell(9, S, 6) & ID_MASK).toBe(B.DEEPROCK);
  }, 60_000);
});

describe('third person: the camera ray chooses the target, only within reach of the eyes (DESIGN 视角)', () => {
  it('a camera 4 blocks behind and 0.75 to the right: the block the crosshair is on is the target and the click lands; one beyond reach of the eyes is no target', async () => {
    const r = await ownWorld(LAND, 'creative', LINKS[1]!.make(950));
    const { c, sim, h } = r;
    sim.world.setCell(0, T + 1, -4, makeCell(B.BRICKS));
    sim.world.setCell(1, T + 1, -7, makeCell(B.BRICKS));
    h.run(50);
    c.catchUp(sim.ticks);
    c.emptyHand();
    c.waitAck();
    c.camera = (eye, dir) => {
      // DESIGN 越肩视角: 4 behind the eyes and 0.75 to the right (right = (-dir.z, 0, dir.x)), looking at the point
      // REACH (5) along the look, so the crosshair there is on the eye ray's target.
      const len = Math.hypot(dir.x, dir.z) || 1;
      const origin = vec3(eye.x - dir.x * 4 + (-dir.z / len) * 0.75, eye.y - dir.y * 4, eye.z - dir.z * 4 + (dir.x / len) * 0.75);
      const at = vec3(eye.x + dir.x * 5, eye.y + dir.y * 5, eye.z + dir.z * 5);
      const d = vec3(at.x - origin.x, at.y - origin.y, at.z - origin.z);
      const n = Math.hypot(d.x, d.y, d.z);
      return { origin, dir: vec3(d.x / n, d.y / n, d.z / n) };
    };
    // The look at the near block's face: the camera ray, aimed through the same point, hits it 8 blocks from the camera.
    c.lookAtCell(0, T + 1, -4);
    h.run(100);
    expect(c.target).toMatchObject({ gridId: 0, x: 0, y: T + 1, z: -4 });
    c.attack();
    c.waitAck();
    expect(sim.world.getCell(0, T + 1, -4) & ID_MASK).toBe(B.AIR);
    // The far block (beyond REACH of the eyes, well within the camera's ray): no target.
    c.lookAtCell(1, T + 1, -7);
    h.run(100);
    expect(c.target).toBeNull();
    c.camera = null;
  }, 60_000);
});
