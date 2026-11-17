/**
 * ACCEPTANCE 19–22 (携带): riding ships and turntables, steering, drowning — whole-simulation,
 * headless. Every ship here is assembled by the player at its helm on a real sea and moved by
 * the real ship dynamics; the player acts through look + clicks + held movement input.
 *
 * Where a ship has to keep sailing while the player is NOT at the wheel, it sails on under a
 * remembered throttle / rudder (ship.throttle / ship.rudder written after the player let go of
 * the wheel): scene setup, the dynamics then move it as they would with a helmsman.
 */
import { expect, it } from 'vitest';
import { driveSuite } from './drive-modes';
import { ID_MASK } from '../../src/blocks/cell';
import { NX, PZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import type { ItemEntity } from '../../src/entities/entity';
import { exportSave } from '../../src/sim/persist';
import type { Simulation } from '../../src/sim/simulation';
import type { Rotor, Ship } from '../../src/structures/structure';
import { boxOverlapsSolid } from '../../src/voxel/shape';
import {
  B,
  Events,
  FLAT_TOP,
  PY,
  SEA_FLOOR,
  SEA_TOP,
  WATER_SURFACE,
  assembleAtHelm,
  buildHull,
  copy,
  fillBox,
  flatSim,
  hdist,
  local,
  makeCell,
  facingState,
  releaseWheelByClick,
  seaSim,
  steerToYaw,
  stopInput,
  walkTo,
  wrap,
  yawOf,
  yawToward,
} from './g5-carry-helpers';

// ---------------------------------------------------------------------------------- scenes

/**
 * Raft A on the sea: a 7x7 plank deck (x 0..6, z 0..6) in the surface layer, a one-high gunwale
 * on the north, east and west sides (the stern, z = 6, is open), the helm in the middle of the
 * deck facing north (bow = -Z). The seat behind the helm is the deck centre (3.5, 3.5).
 * Optionally a rubble pier touching the open stern (x 0..6, z 7..10, sea floor up to the deck
 * layer: top face at SEA_TOP).
 */
const RAFT_A = { x0: 0, z0: 0, x1: 6, z1: 6, y: SEA_TOP - 1, block: B.PLANKS_OAK, gunwale: ['N', 'E', 'W'] as const, helm: { x: 3, z: 2 } };
const DECK_TOP = SEA_TOP; // deck-local y of the deck's top face (deck cells are y = SEA_TOP - 1)

function raftA(mode: 'creative' | 'survival', opts: { pier?: boolean; spawn?: Vec3 } = {}): { sim: Simulation; ship: Ship } {
  const sim = seaSim(mode, opts.spawn ?? vec3(3.5, SEA_TOP, 3.5));
  if (opts.pier) fillBox(sim.world, 0, SEA_FLOOR, 7, 6, SEA_TOP - 1, 10, B.COBBLE);
  const helm = buildHull(sim, { ...RAFT_A, gunwale: [...RAFT_A.gunwale] });
  sim.advance(2);
  if (opts.spawn) walkTo(sim, () => vec3(3.5, 0, 4.2)); // from the pier onto the deck, behind the helm
  const ship = assembleAtHelm(sim, helm);
  expect(ship.grid.count).toBe(49 + 7 + 6 + 6 + 1);
  sim.advance(40); // settle on the water
  return { sim, ship };
}

/** Accumulated heading change of a structure, tick by tick (no wrap-around jumps). */
class YawTrack {
  private last: number;
  total = 0;
  constructor(private readonly grid: { rotation: { x: number; y: number; z: number; w: number } }) {
    this.last = yawOf(grid);
  }
  update(): number {
    const y = yawOf(this.grid);
    this.total += wrap(y - this.last);
    this.last = y;
    return this.total;
  }
}

/** Distance from a deck-local horizontal point to the outline of the deck rectangle [x0, x1+1] x [z0, z1+1]. */
function distToRect(lx: number, lz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = Math.max(x0 - lx, 0, lx - x1);
  const dz = Math.max(z0 - lz, 0, lz - z1);
  if (dx > 0 || dz > 0) return Math.hypot(dx, dz);
  return -Math.min(lx - x0, x1 - lx, lz - z0, z1 - lz);
}

function inWorldBlock(sim: Simulation): boolean {
  return boxOverlapsSolid(sim.world, sim.soloPlayer.player.box());
}

// ====================================================================================== 19

driveSuite('19. 站在船上的玩家：会被带着走；走上码头、跳进水里时脱离；潜行走到甲板边缘不会掉下去；船体没对齐网格时贴墙走不扣血；船转 45° 时在船角附近游泳，不会被拎上船', () => {
  it('会被带着走: a player standing on the deck (not at the wheel) keeps its deck spot and heading while the ship sails and turns for 300 ticks', () => {
    const { sim, ship } = raftA('survival');
    const p = sim.soloPlayer.player;
    releaseWheelByClick(sim);
    expect(p.carrierId).toBe(ship.id);
    // The ship sails on under a remembered throttle and rudder (nobody at the wheel).
    ship.throttle = 1;
    ship.rudder = 0.5;
    sim.advance(40);
    const l0 = local(ship, p.pos);
    const start = copy(ship.grid.position);
    const yaw = new YawTrack(ship.grid);
    const pyaw0 = p.yaw;
    let maxSlip = 0;
    let maxDy = 0;
    for (let i = 0; i < 300; i++) {
      sim.tick();
      yaw.update();
      expect(p.carrierId).toBe(ship.id);
      const l = local(ship, p.pos);
      maxSlip = Math.max(maxSlip, Math.hypot(l.x - l0.x, l.z - l0.z));
      maxDy = Math.max(maxDy, Math.abs(l.y - l0.y));
    }
    // the ship really went somewhere and turned
    expect(hdist(ship.grid.position, start)).toBeGreaterThan(5);
    expect(Math.abs(yaw.total)).toBeGreaterThan(1.5);
    // ... and the player went with it: same deck spot, standing on the deck, heading turned along
    expect(maxSlip).toBeLessThan(0.02);
    expect(maxDy).toBeLessThan(0.02);
    expect(Math.abs(l0.y - DECK_TOP)).toBeLessThan(0.02);
    expect(wrap(p.yaw - pyaw0 - yaw.total)).toBeCloseTo(0, 3);
    expect(p.health).toBe(20);
  });

  it('走上码头时脱离: walking from the deck onto a pier detaches at once; the ship then leaves without the player', () => {
    const { sim, ship } = raftA('survival', { pier: true });
    const p = sim.soloPlayer.player;
    releaseWheelByClick(sim);
    expect(p.carrierId).toBe(ship.id);
    // walk south (astern) onto the pier
    p.input.yaw = Math.PI;
    p.input.forward = 1;
    let detachedAt: number | null = null;
    for (let i = 0; i < 60 && p.pos.z < 9; i++) {
      sim.tick();
      const overPier = p.pos.z - p.halfWidth > 7.05; // the whole footprint is above the pier
      if (overPier && p.onGround && detachedAt === null) {
        expect(p.carrierId, 'standing on the pier').toBe(0);
        detachedAt = p.pos.z;
      }
      if (p.carrierId === 0) {
        expect(p.pos.z - p.halfWidth, 'not detached while still on the deck').toBeGreaterThan(6.9);
      }
    }
    expect(detachedAt).not.toBeNull();
    stopInput(sim);
    sim.advance(40); // let the walk die out
    expect(p.carrierId).toBe(0);
    expect(p.onWorldGround).toBe(true);
    // the ship sails away north; the player stays exactly where it stands
    const here = copy(p.pos);
    const shipStart = copy(ship.grid.position);
    ship.throttle = 1;
    for (let i = 0; i < 100; i++) {
      sim.tick();
      expect(p.carrierId).toBe(0);
    }
    expect(shipStart.z - ship.grid.position.z).toBeGreaterThan(1.5);
    expect(hdist(p.pos, here)).toBeLessThan(1e-6);
    expect(p.pos.y).toBeCloseTo(SEA_TOP, 9);
  });

  it('走上码头时脱离: a raft floating with its deck a little below the pier: stepping up onto the pier detaches at once', () => {
    // A raft two planks thick (x 0..6, z 0..6, y SEA_TOP-1 .. SEA_TOP) floats with its deck top
    // ~0.1 below the top of a pier one block higher than the sea (a step up; raft A floats ~0.2
    // ABOVE its pier: the other case, tested above).
    const pierTop = SEA_TOP + 1;
    const sim = seaSim('survival', vec3(3.5, pierTop, 4.5));
    fillBox(sim.world, 0, SEA_FLOOR, 7, 6, pierTop - 1, 10, B.COBBLE);
    fillBox(sim.world, 0, SEA_TOP - 1, 0, 6, SEA_TOP - 1, 6, B.PLANKS_OAK);
    const helm = buildHull(sim, { x0: 0, z0: 0, x1: 6, z1: 6, y: SEA_TOP, block: B.PLANKS_OAK, helm: { x: 3, z: 3 } });
    sim.advance(2);
    const ship = assembleAtHelm(sim, helm);
    expect(ship.grid.count).toBe(99);
    sim.advance(40);
    const p = sim.soloPlayer.player;
    releaseWheelByClick(sim);
    sim.advance(20);
    const deckTop = ship.grid.toWorld(vec3(3.5, pierTop, 5.5)).y;
    expect(deckTop).toBeLessThan(pierTop - 0.05);
    expect(deckTop).toBeGreaterThan(pierTop - 0.6);
    expect(p.carrierId).toBe(ship.id);
    p.input.yaw = Math.PI; // south, astern onto the pier
    p.input.forward = 1;
    let firstOnPier: { z: number; carrier: number } | null = null;
    for (let i = 0; i < 60 && p.pos.z < 9; i++) {
      sim.tick();
      if (firstOnPier === null && p.onWorldGround) firstOnPier = { z: p.pos.z, carrier: p.carrierId };
    }
    expect(firstOnPier, 'stepped up onto the pier').not.toBeNull();
    expect(firstOnPier!.carrier, 'detached the tick the pier was underfoot').toBe(0);
    expect(firstOnPier!.z - p.halfWidth, 'part of the footprint was still over the deck').toBeLessThan(7);
    stopInput(sim);
    sim.advance(40);
    expect(p.carrierId).toBe(0);
    const here = copy(p.pos);
    const shipStart = copy(ship.grid.position);
    ship.throttle = 1;
    for (let i = 0; i < 100; i++) {
      sim.tick();
      expect(p.carrierId).toBe(0);
    }
    expect(shipStart.z - ship.grid.position.z).toBeGreaterThan(1.5);
    expect(hdist(p.pos, here)).toBeLessThan(1e-6);
    expect(p.pos.y).toBeCloseTo(pierTop, 9);
  });

  it('跳进水里时脱离: jumping off the stern of a sailing ship into the water detaches; the ship leaves the swimmer behind', () => {
    const { sim, ship } = raftA('creative');
    const p = sim.soloPlayer.player;
    releaseWheelByClick(sim);
    ship.throttle = 1; // sailing north
    sim.advance(60);
    expect(p.carrierId).toBe(ship.id);
    // run astern (south) and jump over the open stern
    p.input.yaw = yawOf(ship.grid) + Math.PI;
    p.input.forward = 1;
    p.input.jump = true;
    let wetAt = -1;
    for (let i = 0; i < 80; i++) {
      sim.tick();
      if (p.wet > 0) {
        wetAt = i;
        break;
      }
    }
    expect(wetAt, 'reached the water').toBeGreaterThanOrEqual(0);
    expect(p.carrierId, 'detached on reaching the water').toBe(0);
    expect(local(ship, p.pos).z).toBeGreaterThan(7); // overboard astern
    // tread water while the ship sails on
    p.input.forward = 0;
    const swim0 = copy(p.pos);
    const ship0 = copy(ship.grid.position);
    for (let i = 0; i < 100; i++) {
      sim.tick();
      expect(p.carrierId).toBe(0);
    }
    const shipMoved = hdist(ship.grid.position, ship0);
    expect(shipMoved).toBeGreaterThan(2);
    expect(hdist(p.pos, swim0)).toBeLessThan(shipMoved - 1.5); // not dragged along
    expect(hdist(p.pos, ship.grid.position) - hdist(swim0, ship0)).toBeGreaterThan(1.5);
    expect(p.wet).toBeGreaterThan(0);
  });

  /** Sneak toward the open stern for `ticks` ticks; the walking direction is fixed in the deck frame. */
  function sneakToStern(sim: Simulation, ship: Ship, ticks: number): { minY: number; maxZ: number } {
    const p = sim.soloPlayer.player;
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = yawOf(ship.grid) + Math.PI; // deck-local +Z (the carrier turns the look with the deck)
    let minY = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < ticks; i++) {
      sim.tick();
      const l = local(ship, p.pos);
      expect(p.carrierId).toBe(ship.id);
      expect(p.wet).toBe(0);
      minY = Math.min(minY, l.y);
      maxZ = Math.max(maxZ, l.z);
    }
    stopInput(sim);
    return { minY, maxZ };
  }

  it('潜行走到甲板边缘不会掉下去: sneaking toward the open stern for 150 ticks stops at the edge (grid-aligned deck)', () => {
    const { sim, ship } = raftA('survival');
    releaseWheelByClick(sim);
    const { minY, maxZ } = sneakToStern(sim, ship, 150);
    expect(minY).toBeGreaterThan(DECK_TOP - 0.05); // never dropped below the deck surface
    expect(maxZ).toBeGreaterThan(6.6); // it really walked to the edge (deck ends at z = 7) ...
    expect(local(ship, sim.soloPlayer.player.pos).z - sim.soloPlayer.player.halfWidth).toBeLessThan(7); // ... and still stands on it
    sim.advance(20);
    expect(sim.soloPlayer.player.carrierId).toBe(ship.id);
  });

  it('潜行走到甲板边缘不会掉下去: on a deck yawed 0.6 rad (not grid-aligned) the sneaking player stops at the edge', () => {
    const { sim, ship } = raftA('survival');
    steerToYaw(sim, ship, 0.6);
    releaseWheelByClick(sim);
    sim.advance(20);
    expect(Math.abs(wrap(yawOf(ship.grid) - 0.6))).toBeLessThan(0.02);
    const { minY, maxZ } = sneakToStern(sim, ship, 150);
    expect(minY).toBeGreaterThan(DECK_TOP - 0.05);
    expect(maxZ).toBeGreaterThan(6.6);
    expect(local(ship, sim.soloPlayer.player.pos).z - sim.soloPlayer.player.halfWidth).toBeLessThan(7);
  });

  it('潜行走到甲板边缘不会掉下去: on a yawed deck that keeps turning and sailing, the sneaking player stays at the edge', () => {
    const { sim, ship } = raftA('survival');
    steerToYaw(sim, ship, -0.7);
    releaseWheelByClick(sim);
    ship.throttle = 0.6;
    ship.rudder = 0.6;
    sim.advance(30);
    const yaw = new YawTrack(ship.grid);
    const p = sim.soloPlayer.player;
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = yawOf(ship.grid) + Math.PI;
    let minY = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < 200; i++) {
      sim.tick();
      yaw.update();
      const l = local(ship, p.pos);
      expect(p.carrierId).toBe(ship.id);
      expect(p.wet).toBe(0);
      minY = Math.min(minY, l.y);
      maxZ = Math.max(maxZ, l.z);
    }
    expect(Math.abs(yaw.total)).toBeGreaterThan(0.5); // the deck turned under the player
    expect(minY).toBeGreaterThan(DECK_TOP - 0.05);
    expect(maxZ).toBeGreaterThan(6.6);
    expect(local(ship, p.pos).z - p.halfWidth).toBeLessThan(7);
  });

  it('潜行走到甲板边缘不会掉下去: on a raft without gunwale yawed 45 degrees, sneaking diagonally toward a corner stops there', () => {
    // 7x7 plank raft, helm in the middle; every edge open
    const sim = seaSim('survival', vec3(3.5, SEA_TOP, 4.5));
    const helm = buildHull(sim, { x0: 0, z0: 0, x1: 6, z1: 6, y: SEA_TOP - 1, block: B.PLANKS_OAK, helm: { x: 3, z: 3 } });
    sim.advance(2);
    const ship = assembleAtHelm(sim, helm);
    sim.advance(30);
    steerToYaw(sim, ship, Math.PI / 4);
    releaseWheelByClick(sim);
    sim.advance(20);
    const p = sim.soloPlayer.player;
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = yawOf(ship.grid) + Math.atan2(-1, -1); // deck-local (+x, +z): the stern-starboard corner (7, 7)
    let minY = Infinity;
    for (let i = 0; i < 200; i++) {
      sim.tick();
      const l = local(ship, p.pos);
      expect(p.carrierId).toBe(ship.id);
      expect(p.wet).toBe(0);
      minY = Math.min(minY, l.y);
    }
    stopInput(sim);
    const l = local(ship, p.pos);
    expect(minY).toBeGreaterThan(DECK_TOP - 0.05);
    expect(Math.max(l.x, l.z)).toBeGreaterThan(6.6); // at an edge next to the corner
    expect(Math.hypot(7 - l.x, 7 - l.z)).toBeLessThan(1.2);
    expect(Math.min(l.x, l.z) - p.halfWidth).toBeLessThan(7); // still over the deck
  });

  /**
   * Raft B: a 13x13 plank deck (x 0..12, z 0..12) without a gunwale, the helm in the middle
   * (6, ., 6) facing north. The ship is turned off the grid by its helmsman; then a WORLD wall is
   * put across the deck at chest height (stone y SEA_TOP+1 .. SEA_TOP+2 over z 1..2, south face
   * at z = 3): the flat deck floats under it, a player on the deck walks into it.
   */
  function wallScene(shipYaw: number): { sim: Simulation; ship: Ship } {
    const sim = seaSim('survival', vec3(6.5, SEA_TOP, 7.5));
    const helm = buildHull(sim, { x0: 0, z0: 0, x1: 12, z1: 12, y: SEA_TOP - 1, block: B.PLANKS_OAK, helm: { x: 6, z: 6 } });
    sim.advance(2);
    const ship = assembleAtHelm(sim, helm);
    sim.advance(30);
    steerToYaw(sim, ship, shipYaw);
    releaseWheelByClick(sim);
    sim.advance(10);
    fillBox(sim.world, -10, SEA_TOP + 1, 1, 22, SEA_TOP + 2, 2, B.STONE);
    sim.advance(2);
    return { sim, ship };
  }

  for (const shipYaw of [0.4, -0.25, Math.PI / 4]) {
    it(`船体没对齐网格时贴墙走不扣血: survival, ship yawed ${shipYaw.toFixed(2)} rad, walking along a world wall pressing into it costs no health`, () => {
      const { sim, ship } = wallScene(shipYaw);
      const p = sim.soloPlayer.player;
      const ev = new Events(sim);
      expect(Math.abs(wrap(yawOf(ship.grid) - shipYaw))).toBeLessThan(0.03);
      // to the wall
      walkTo(sim, () => vec3(p.pos.x, 0, 3.5), 0.1, 60);
      expect(p.carrierId).toBe(ship.id);
      let contact = 0;
      // along the wall, pressing into it (north-east, north-west, ...), looking where it goes
      const phases: Array<[number, number]> = [
        [-Math.PI / 2 + 0.3, 18],
        [Math.PI / 2 - 0.3, 30],
        [-Math.PI / 2 + 0.6, 30],
        [Math.PI / 2 - 0.05, 30],
        [-0.2, 20],
        [0.2, 20],
      ];
      for (const [yaw, n] of phases) {
        for (let i = 0; i < n; i++) {
          p.input.yaw = yaw;
          p.input.forward = 1;
          sim.tick();
          expect(p.health).toBe(20);
          expect(inWorldBlock(sim)).toBe(false);
          expect(p.carrierId).toBe(ship.id);
          if (Math.abs(p.pos.z - p.halfWidth - 3) < 0.01) contact++;
        }
      }
      stopInput(sim);
      sim.advance(20);
      expect(contact).toBeGreaterThan(80); // it really walked along the wall face
      expect(ev.of('playerHurt')).toEqual([]);
      expect(p.health).toBe(20);
    });
  }

  it('船体没对齐网格时贴墙走不扣血: survival, against a world wall on a deck that keeps turning under it, no health is lost', () => {
    const { sim, ship } = wallScene(0.3);
    const p = sim.soloPlayer.player;
    const ev = new Events(sim);
    walkTo(sim, () => vec3(p.pos.x, 0, 3.5), 0.1, 60);
    ship.rudder = -0.4; // remembered rudder: the deck slowly turns under the wall
    const yaw = new YawTrack(ship.grid);
    let contact = 0;
    for (let i = 0; i < 168; i++) {
      // back and forth along the wall (12 ticks east, then 24-tick legs), always pressing into it
      const east = i < 12 || Math.floor((i - 12) / 24) % 2 === 1;
      p.input.yaw = east ? -Math.PI / 2 + 0.4 : Math.PI / 2 - 0.4;
      p.input.forward = 1;
      sim.tick();
      yaw.update();
      expect(p.health).toBe(20);
      expect(inWorldBlock(sim)).toBe(false);
      expect(p.carrierId).toBe(ship.id);
      if (Math.abs(p.pos.z - p.halfWidth - 3) < 0.01) contact++;
    }
    expect(Math.abs(yaw.total)).toBeGreaterThan(0.2);
    expect(contact).toBeGreaterThan(80);
    expect(ev.of('playerHurt')).toEqual([]);
  });

  it('船体没对齐网格时贴墙走不扣血: survival, the yawed ship is pushed against the wall by its remembered throttle while the player walks along it', () => {
    const { sim, ship } = wallScene(-0.5);
    const p = sim.soloPlayer.player;
    const ev = new Events(sim);
    walkTo(sim, () => vec3(p.pos.x, 0, 3.5), 0.1, 60);
    ship.throttle = 1; // bow first under the wall until the helm (one block high) meets it
    const start = copy(ship.grid.position);
    let contact = 0;
    for (let i = 0; i < 200; i++) {
      p.input.yaw = Math.floor(i / 20) % 2 === 0 ? -Math.PI / 2 + 0.4 : Math.PI / 2 - 0.4;
      p.input.forward = 1;
      sim.tick();
      expect(p.health).toBe(20);
      expect(inWorldBlock(sim)).toBe(false);
      expect(p.carrierId).toBe(ship.id);
      if (Math.abs(p.pos.z - p.halfWidth - 3) < 0.01) contact++;
    }
    expect(start.z - ship.grid.position.z).toBeGreaterThan(1.5); // it sailed up to the wall
    expect(Math.abs(Math.sin(2 * yawOf(ship.grid)))).toBeGreaterThan(0.2); // still off the grid
    expect(contact).toBeGreaterThan(150);
    expect(ev.of('playerHurt')).toEqual([]);
  });

  /**
   * Raft C: a 7x7 plank deck with a one-high gunwale all round, helm in the middle facing north,
   * turned to 45 degrees by its helmsman. The swimmer starts in the water just outside the
   * corner that points west.
   */
  function swimScene(): { sim: Simulation; ship: Ship; corner: Vec3 } {
    const sim = seaSim('survival', vec3(3.5, SEA_TOP, 4.5));
    const helm = buildHull(sim, { x0: 0, z0: 0, x1: 6, z1: 6, y: SEA_TOP - 1, block: B.PLANKS_OAK, gunwale: ['N', 'S', 'E', 'W'], helm: { x: 3, z: 3 } });
    sim.advance(2);
    const ship = assembleAtHelm(sim, helm);
    sim.advance(30);
    steerToYaw(sim, ship, Math.PI / 4);
    releaseWheelByClick(sim);
    sim.advance(20);
    expect(Math.abs(wrap(yawOf(ship.grid) - Math.PI / 4))).toBeLessThan(0.02);
    const corner = ship.grid.toWorld(vec3(0, SEA_TOP - 1, 0)); // bow-port corner: points west at 45 degrees
    return { sim, ship, corner };
  }

  it('船转 45° 时在船角附近游泳，不会被拎上船: treading water at the corner while the ship drifts corner-first into the swimmer', () => {
    const { sim, ship, corner } = swimScene();
    const p = sim.soloPlayer.player;
    const centre = ship.grid.toWorld(vec3(3.5, SEA_TOP - 1, 3.5));
    const ux = (corner.x - centre.x) / hdist(corner, centre);
    expect(ux).toBeLessThan(-0.99); // the corner points west
    // just ahead of the bow face, at its port corner
    const at = ship.grid.toWorld(vec3(0.25, SEA_TOP - 1, -0.5));
    sim.soloPlayer.teleport(at.x, WATER_SURFACE - 1.3, at.z);
    stopInput(sim);
    p.input.jump = true; // treading water
    ship.throttle = 0.5; // the ship gets under way bow first (north-west), into the swimmer
    const deckTop = ship.grid.toWorld(vec3(3.5, SEA_TOP, 3.5)).y;
    const start = copy(p.pos);
    let maxY = -Infinity;
    let minDist = Infinity;
    for (let i = 0; i < 300; i++) {
      sim.tick();
      expect(p.carrierId).toBe(0);
      const l = local(ship, p.pos);
      minDist = Math.min(minDist, distToRect(l.x, l.z, 0, 0, 7, 7));
      expect(distToRect(l.x, l.z, 0, 0, 7, 7)).toBeGreaterThan(0); // never inside the hull outline
      maxY = Math.max(maxY, p.pos.y);
    }
    expect(maxY).toBeLessThan(deckTop - 0.5); // never lifted onto the deck
    expect(p.wet).toBeGreaterThan(0.3);
    expect(minDist).toBeLessThan(0.45); // the hull really touched the swimmer
    expect(hdist(p.pos, start)).toBeGreaterThan(1); // ... and shoved it along
  });

  it('船转 45° 时在船角附近游泳，不会被拎上船: swimming (W + space) into the corner of the ship at rest never lifts the swimmer aboard', () => {
    const { sim, ship, corner } = swimScene();
    const p = sim.soloPlayer.player;
    const centre = ship.grid.toWorld(vec3(3.5, SEA_TOP - 1, 3.5));
    const ux = (corner.x - centre.x) / hdist(corner, centre);
    const uz = (corner.z - centre.z) / hdist(corner, centre);
    sim.soloPlayer.teleport(corner.x + ux * 3, WATER_SURFACE - 1.3, corner.z + uz * 3);
    const deckTop = ship.grid.toWorld(vec3(3.5, SEA_TOP, 3.5)).y;
    let maxY = -Infinity;
    let minDist = Infinity;
    for (let i = 0; i < 200; i++) {
      p.input.yaw = yawToward(p.pos, corner) + (i < 100 ? 0.15 : -0.15);
      p.input.forward = 1;
      p.input.jump = true;
      sim.tick();
      expect(p.carrierId).toBe(0);
      const l = local(ship, p.pos);
      minDist = Math.min(minDist, distToRect(l.x, l.z, 0, 0, 7, 7));
      maxY = Math.max(maxY, p.pos.y);
    }
    expect(maxY).toBeLessThan(deckTop - 0.5);
    expect(p.wet).toBeGreaterThan(0.3);
    expect(minDist).toBeLessThan(0.45); // it swam right into the corner
  });
});

// ====================================================================================== 20

driveSuite('20. 竖直轴的转盘会带人转。转盘装在船上时，从转盘走到甲板会切换到跟船走，不会掉穿甲板。', () => {
  it('竖直轴的转盘会带人转: a rider on a turntable is carried round the axis and turned with it', () => {
    const T = FLAT_TOP;
    const sim = flatSim('survival', vec3(-3.5, T, 0.5));
    const w = sim.world;
    // bearing facing up on the ground; hub on it at the west edge of a 5x5 felt platform
    w.setCell(0, T, 0, makeCell(B.BEARING, facingState(PY)));
    fillBox(w, 0, T + 1, -2, 4, T + 1, 2, B.WOOL_WHITE);
    sim.advance(2);
    // the player starts it: right-click the bearing twice (preview, start)
    expect(sim.soloPlayer.useOn(0, T, 0, NX)).toBe(true);
    expect(sim.soloPlayer.view.preview?.kind).toBe('rotor');
    expect(sim.soloPlayer.useOn(0, T, 0, NX)).toBe(true);
    const rotors = sim.structures.rotors();
    expect(rotors.length).toBe(1);
    const rotor = rotors[0]!;
    expect(rotor.grid.count).toBe(25);
    // board: onto the platform centre (2 blocks from the axis)
    sim.soloPlayer.teleport(...xyz(rotor.grid.toWorld(vec3(2.5, T + 2, 0.5))));
    sim.advance(5);
    const p = sim.soloPlayer.player;
    expect(p.carrierId).toBe(rotor.id);
    const axis = vec3(0.5, 0, 0.5);
    const r0 = local(rotor, p.pos);
    const ang0 = Math.atan2(-(p.pos.z - axis.z), p.pos.x - axis.x);
    const yaw0 = p.yaw;
    let turned = 0;
    let lastAngle = rotor.angle;
    for (let i = 0; i < 160; i++) {
      sim.tick();
      turned += wrap(rotor.angle - lastAngle);
      lastAngle = rotor.angle;
      expect(p.carrierId).toBe(rotor.id);
      const l = local(rotor, p.pos);
      expect(Math.hypot(l.x - r0.x, l.z - r0.z)).toBeLessThan(0.02);
      expect(Math.abs(hdist(p.pos, axis) - 2)).toBeLessThan(0.05);
    }
    expect(turned).toBeGreaterThan(1.5); // the turntable really turned (CCW from above)
    const ang = Math.atan2(-(p.pos.z - axis.z), p.pos.x - axis.x);
    expect(wrap(ang - ang0 - turned)).toBeCloseTo(0, 1); // carried round the axis
    expect(wrap(p.yaw - yaw0 - turned)).toBeCloseTo(0, 3); // and turned with it
    expect(p.health).toBe(20);
  });

  /**
   * Ship D: an 11x11 plank deck (x 0..10, z 0..10), helm (9, ., 9) facing north. On the deck a
   * bearing facing up at (5, SEA_TOP, 4), glued to its felt hub; a 3x3 felt platform at
   * y = SEA_TOP + 1 (x 4..6, z 3..5): a turntable mounted on the ship.
   */
  function turntableShip(raised = false): { sim: Simulation; ship: Ship; rotor: Rotor } {
    const sim = seaSim('survival', vec3(9.5, SEA_TOP, 10.5));
    const w = sim.world;
    const helm = buildHull(sim, { x0: 0, z0: 0, x1: 10, z1: 10, y: SEA_TOP - 1, block: B.PLANKS_OAK, helm: { x: 9, z: 9 } });
    w.setCell(5, SEA_TOP, 4, makeCell(B.BEARING, facingState(PY)));
    fillBox(w, 4, SEA_TOP + 1, 3, 6, SEA_TOP + 1, 5, B.WOOL_RED);
    sim.worldGlue.add(5, SEA_TOP, 4, PY); // hub <-> bearing: the stopped turntable comes along
    // raised: a two-high plank block on the deck east of the platform (x 7..10, z 1..7), its top
    // flush with the platform top (the platform's corners sweep through its edge)
    if (raised) fillBox(w, 7, SEA_TOP, 1, 10, SEA_TOP + 1, 7, B.PLANKS_OAK);
    sim.advance(2);
    const ship = assembleAtHelm(sim, helm);
    expect(ship.grid.count).toBe(121 + 1 + 1 + 9 + (raised ? 56 : 0));
    sim.advance(20);
    releaseWheelByClick(sim);
    // walk to a spot from which the bearing shows under the platform, start it from there
    walkTo(sim, () => ship.grid.toWorld(vec3(5.5, SEA_TOP, 8.2)));
    sim.advance(5);
    expect(sim.soloPlayer.useOn(5, SEA_TOP, 4, PZ, ship.id)).toBe(true);
    expect(sim.soloPlayer.view.preview?.kind).toBe('rotor');
    expect(sim.soloPlayer.useOn(5, SEA_TOP, 4, PZ, ship.id)).toBe(true);
    const rotors = sim.structures.rotors();
    expect(rotors.length).toBe(1);
    const rotor = rotors[0]!;
    expect(rotor.parent).toBe(ship);
    expect(rotor.grid.count).toBe(9);
    // board the platform (a step up of two blocks: placed there)
    sim.soloPlayer.teleport(...xyz(rotor.grid.toWorld(vec3(5.5, SEA_TOP + 2, 4.5))));
    sim.advance(10);
    expect(sim.soloPlayer.player.carrierId).toBe(rotor.id);
    return { sim, ship, rotor };
  }

  it('转盘装在船上：骑在船上的转盘上的人跟着转盘转，也跟着船走', () => {
    const { sim, ship, rotor } = turntableShip();
    const p = sim.soloPlayer.player;
    ship.throttle = 1;
    ship.rudder = 0.3;
    sim.advance(20);
    const r0 = local(rotor, p.pos);
    const start = copy(ship.grid.position);
    const shipYaw = new YawTrack(ship.grid);
    const yaw0 = p.yaw;
    let spun = 0;
    let lastAngle = rotor.angle;
    for (let i = 0; i < 120; i++) {
      sim.tick();
      shipYaw.update();
      spun += wrap(rotor.angle - lastAngle);
      lastAngle = rotor.angle;
      expect(p.carrierId).toBe(rotor.id);
      const l = local(rotor, p.pos);
      expect(Math.hypot(l.x - r0.x, l.z - r0.z)).toBeLessThan(0.03);
    }
    expect(spun).toBeGreaterThan(0.8);
    expect(hdist(ship.grid.position, start)).toBeGreaterThan(1);
    expect(wrap(p.yaw - yaw0 - spun - shipYaw.total)).toBeCloseTo(0, 2);
  });

  it('从转盘走到甲板会切换到跟船走，不会掉穿甲板', () => {
    const { sim, ship, rotor } = turntableShip();
    const p = sim.soloPlayer.player;
    ship.throttle = 1;
    ship.rudder = 0.3;
    sim.advance(10);
    // walk straight off the platform (the look turns with the platform, so the walk is straight in its frame)
    p.input.yaw = yawToward(rotor.grid.toWorld(vec3(5.5, 0, 4.5)), rotor.grid.toWorld(vec3(9.5, 0, 4.5)));
    p.input.forward = 1;
    let switchedAt = -1;
    let minDeckY = Infinity;
    // walk until a few steps past the switch (the deck is 4 blocks wider than the platform there)
    for (let i = 0; i < 60 && (switchedAt < 0 || i < switchedAt + 6); i++) {
      sim.tick();
      const l = local(ship, p.pos);
      minDeckY = Math.min(minDeckY, l.y);
      expect(p.carrierId === rotor.id || p.carrierId === ship.id, `carried by the turntable or the ship (tick ${i})`).toBe(true);
      if (switchedAt < 0 && p.carrierId === ship.id) switchedAt = i;
    }
    stopInput(sim);
    expect(switchedAt, 'switched to the ship').toBeGreaterThanOrEqual(0);
    expect(minDeckY).toBeGreaterThan(DECK_TOP - 0.05); // never below the deck surface
    sim.advance(10);
    expect(p.carrierId).toBe(ship.id);
    // now it follows the ship, not the turntable: fixed deck spot while both keep moving
    const l0 = local(ship, p.pos);
    const rl0 = local(rotor, p.pos);
    expect(Math.abs(l0.y - DECK_TOP)).toBeLessThan(0.03);
    for (let i = 0; i < 100; i++) {
      sim.tick();
      expect(p.carrierId).toBe(ship.id);
      const l = local(ship, p.pos);
      expect(Math.hypot(l.x - l0.x, l.z - l0.z)).toBeLessThan(0.03);
      expect(l.y).toBeGreaterThan(DECK_TOP - 0.05);
    }
    const rl = local(rotor, p.pos);
    expect(Math.hypot(rl.x - rl0.x, rl.z - rl0.z)).toBeGreaterThan(1); // the turntable went on turning without the player
  });

  it('从转盘走到甲板会切换到跟船走，不会掉穿甲板: walking from the platform onto a deck flush with it (level walk)', () => {
    const { sim, ship, rotor } = turntableShip(true);
    const p = sim.soloPlayer.player;
    const top = SEA_TOP + 2; // deck-local top of the platform and of the raised deck
    ship.throttle = 1;
    ship.rudder = 0.3;
    sim.advance(10);
    // toward ship-local east, onto the raised deck (the platform turns the look while on it)
    p.input.yaw = yawToward(ship.grid.toWorld(vec3(5.5, 0, 4.5)), ship.grid.toWorld(vec3(9.5, 0, 4.5)));
    p.input.forward = 1;
    let switchedAt = -1;
    let minY = Infinity;
    for (let i = 0; i < 60; i++) {
      sim.tick();
      const l = local(ship, p.pos);
      minY = Math.min(minY, l.y);
      expect(p.carrierId === rotor.id || p.carrierId === ship.id, `carried by the turntable or the ship (tick ${i})`).toBe(true);
      if (switchedAt < 0 && p.carrierId === ship.id) switchedAt = i;
      if (Math.hypot(l.x - 5.5, l.z - 4.5) > 3.2) break; // clear of the platform's sweep (radius 2.12)
    }
    stopInput(sim);
    expect(switchedAt, 'switched to the ship').toBeGreaterThanOrEqual(0);
    expect(minY).toBeGreaterThan(top - 0.05); // a level walk: never dipped, never fell through
    sim.advance(10);
    const l0 = local(ship, p.pos);
    expect(l0.x).toBeGreaterThan(7); // on the raised deck, east of the platform
    // standing on it (the block lists the ship a few degrees: the world-axis body box rests on
    // the deck with one edge, its feet centre a few hundredths above the local top)
    expect(Math.abs(l0.y - top)).toBeLessThan(0.08);
    expect(p.carrierId).toBe(ship.id);
    for (let i = 0; i < 100; i++) {
      sim.tick();
      expect(p.carrierId).toBe(ship.id);
      const l = local(ship, p.pos);
      expect(Math.hypot(l.x - l0.x, l.z - l0.z)).toBeLessThan(0.03);
      expect(l.y).toBeGreaterThan(top - 0.05);
    }
  });
});

// ====================================================================================== 21

driveSuite('21. 掌舵时死亡会脱离船，复活在出生点；打开背包时舵会松开；暂停时甲板上的人和物品都不动。', () => {
  it('掌舵时死亡会脱离船，复活在出生点', () => {
    const spawn = vec3(3.5, SEA_TOP, 9.5); // on the pier
    const { sim, ship } = raftA('survival', { pier: true, spawn });
    const p = sim.soloPlayer.player;
    const ev = new Events(sim);
    p.input.forward = 1;
    p.input.strafe = 1;
    sim.advance(60);
    expect(ship.throttle).toBe(1);
    expect(ship.rudder).toBe(1);
    expect(p.steeringShipId).toBe(ship.id);
    // a lethal blow at the wheel
    sim.entities.damage(p, 1000, 'test');
    expect(p.dead).toBe(true);
    expect(ev.of('playerDied').length).toBe(1);
    expect(p.steeringShipId).toBe(0);
    expect(p.carrierId).toBe(0);
    expect(ship.helmsmanId).toBe(0);
    expect(ship.throttle).toBe(0);
    expect(ship.rudder).toBe(0);
    // the body is no longer carried: the ship coasts on, the body stays
    const body = copy(p.pos);
    const ship0 = copy(ship.grid.position);
    sim.advance(30);
    expect(hdist(ship.grid.position, ship0)).toBeGreaterThan(0.05);
    expect(hdist(p.pos, body)).toBe(0);
    expect(ship.throttle).toBe(0); // the held W no longer reaches the ship
    // respawn at the spawn point
    stopInput(sim);
    sim.soloPlayer.respawn();
    expect(p.dead).toBe(false);
    expect(p.pos).toEqual(spawn);
    expect(p.health).toBe(20);
    expect(p.steeringShipId).toBe(0);
    expect(p.carrierId).toBe(0);
    sim.advance(10);
    expect(hdist(p.pos, spawn)).toBeLessThan(1e-6);
    expect(p.onWorldGround).toBe(true);
    expect(p.carrierId).toBe(0);
  });

  it('打开背包时舵会松开: the client calls releaseHelm() when the inventory opens; throttle and rudder drop to zero, the player stays aboard', () => {
    const { sim, ship } = raftA('survival');
    const p = sim.soloPlayer.player;
    p.input.forward = 1;
    p.input.strafe = -1;
    sim.advance(40);
    expect(ship.throttle).toBe(1);
    expect(ship.rudder).toBe(-1);
    // the inventory opens: the client lets go of the wheel and zeroes the movement keys
    sim.soloPlayer.releaseHelm();
    stopInput(sim);
    expect(p.steeringShipId).toBe(0);
    expect(ship.helmsmanId).toBe(0);
    expect(ship.throttle).toBe(0);
    expect(ship.rudder).toBe(0);
    expect(sim.soloPlayer.helmView()).toBeNull();
    // the sim keeps ticking while the inventory is open: the player stays aboard, carried
    // while the ship coasts and turns on its momentum
    expect(p.carrierId).toBe(ship.id);
    const l0 = local(ship, p.pos);
    const s0 = copy(ship.grid.position);
    for (let i = 0; i < 40; i++) {
      sim.tick();
      expect(p.carrierId).toBe(ship.id);
      expect(ship.throttle).toBe(0);
      expect(ship.rudder).toBe(0);
    }
    expect(hdist(ship.grid.position, s0)).toBeGreaterThan(0.1);
    const l = local(ship, p.pos);
    expect(Math.hypot(l.x - l0.x, l.z - l0.z)).toBeLessThan(0.02);
    // inventory closed: W / A now walk the player, they no longer reach the ship
    p.input.forward = 1;
    p.input.strafe = -1;
    sim.advance(5);
    expect(ship.throttle).toBe(0);
    expect(ship.rudder).toBe(0);
    expect(hdist(local(ship, p.pos), l)).toBeGreaterThan(0.3);
  });

  /** Raft A sailing and turning (remembered throttle), the player on deck, a stack of planks lying on the deck. */
  function pauseScene(): { sim: Simulation; ship: Ship; item: ItemEntity } {
    const { sim, ship } = raftA('survival');
    releaseWheelByClick(sim);
    const at = ship.grid.toWorld(vec3(1.5, SEA_TOP + 0.3, 5.5));
    const item = sim.entities.spawnItem(at.x, at.y, at.z, B.PLANKS_OAK, 5, vec3(0, 0, 0));
    sim.advance(20);
    expect(item.carrierId).toBe(ship.id);
    ship.throttle = 1;
    ship.rudder = 0.5;
    sim.advance(40);
    return { sim, ship, item };
  }

  it('暂停时甲板上的人和物品都不动: no ticks while paused (the client autosaves); after resuming nothing jumps, both stay on the deck', () => {
    const a = pauseScene();
    const b = pauseScene(); // twin that is never paused
    const p = a.sim.soloPlayer.player;
    const pl0 = local(a.ship, p.pos);
    const il0 = local(a.ship, a.item.pos);
    const pw0 = copy(p.pos);
    const iw0 = copy(a.item.pos);
    const sp0 = copy(a.ship.grid.position);
    // ---- pause: the client stops calling tick(), saves, keeps drawing
    const save = exportSave(a.sim);
    expect(save.blobs.length).toBeGreaterThan(0);
    void a.sim.soloPlayer.helmView();
    void a.sim.soloPlayer.targetCell();
    expect(p.pos).toEqual(pw0);
    expect(a.item.pos).toEqual(iw0);
    expect(a.ship.grid.position).toEqual(sp0);
    // ---- resume
    a.sim.tick();
    b.sim.tick();
    expect(hdist(local(a.ship, p.pos), pl0)).toBeLessThan(0.005);
    expect(hdist(local(a.ship, a.item.pos), il0)).toBeLessThan(0.005);
    for (let i = 0; i < 100; i++) {
      a.sim.tick();
      b.sim.tick();
      expect(p.carrierId).toBe(a.ship.id);
      expect(a.item.removed).toBe(false);
      expect(a.item.carrierId).toBe(a.ship.id);
    }
    expect(hdist(local(a.ship, p.pos), pl0)).toBeLessThan(0.02);
    expect(Math.abs(local(a.ship, a.item.pos).y - il0.y)).toBeLessThan(0.02);
    expect(hdist(local(a.ship, a.item.pos), il0)).toBeLessThan(0.02);
    // the pause changed nothing at all: same state as the twin that was never paused
    expect(p.pos).toEqual(b.sim.soloPlayer.player.pos);
    expect(a.item.pos).toEqual(b.item.pos);
    expect(a.ship.grid.position).toEqual(b.ship.grid.position);
  });
});

// ====================================================================================== 22

driveSuite('22. 沉船上的舵手会溺水。', () => {
  /**
   * A deep open hull: 5x5 floor (x 0..4, z 0..4) and a ring wall `wall` cells high around a 3x3
   * hold, helm in the hold (2, ., 2) facing north; the seat (2.5, ., 3.5) is in the hold. Built
   * with its floor at `y`; the player spawns at the seat and takes the wheel by assembling.
   */
  function deepHull(block: number, y: number, wall: number): { sim: Simulation; ship: Ship; ev: Events } {
    const sim = seaSim('survival', vec3(2.5, y + 1, 3.5));
    const ev = new Events(sim);
    const helm = buildHull(sim, { x0: 0, z0: 0, x1: 4, z1: 4, y, block, gunwale: ['N', 'S', 'E', 'W'], gunwaleHeight: wall, helm: { x: 2, z: 2 } });
    sim.advance(2);
    const ship = assembleAtHelm(sim, helm);
    return { sim, ship, ev };
  }

  it('沉船上的舵手会溺水: survival, a stone-brick hull that cannot float sinks with the helmsman at the wheel; air runs out, drowning damage follows', () => {
    const { sim, ship, ev } = deepHull(B.STONE_BRICKS, SEA_TOP - 1, 3);
    const p = sim.soloPlayer.player;
    expect(ship.hull?.floats).toBe(false);
    let submergedAt = -1;
    let airOutAt = -1;
    let lastAir = p.air;
    for (let i = 0; i < 700 && !p.dead; i++) {
      sim.tick();
      if (!p.dead) expect(p.steeringShipId, `still at the wheel (tick ${i})`).toBe(ship.id);
      if (p.headWet && submergedAt < 0) submergedAt = i;
      if (submergedAt >= 0 && !p.dead) {
        expect(p.air).toBeLessThanOrEqual(lastAir);
      }
      lastAir = p.air;
      if (p.air === 0 && airOutAt < 0) airOutAt = i;
    }
    expect(submergedAt, 'the helmsman went under').toBeGreaterThanOrEqual(0);
    expect(ship.grid.position.y).toBeLessThan(SEA_FLOOR + 3); // the ship is on the sea floor
    expect(airOutAt - submergedAt).toBeGreaterThanOrEqual(299); // 300 ticks of air
    expect(airOutAt - submergedAt).toBeLessThan(320);
    const drown = ev.of('playerHurt').filter((e) => e.cause === 'drown');
    expect(drown.length).toBeGreaterThanOrEqual(5);
    expect(drown[0]!.amount).toBe(2);
    expect(ev.of('playerDied').map((e) => e.cause)).toEqual(['drown']);
  });

  it('对照：浮着的船，水线以下的干舱里掌舵不掉气', () => {
    const { sim, ship, ev } = deepHull(B.GLASS, SEA_TOP, 6);
    const p = sim.soloPlayer.player;
    expect(ship.hull?.floats).toBe(true);
    for (let i = 0; i < 700; i++) {
      sim.tick();
      expect(p.steeringShipId).toBe(ship.id);
      expect(p.headWet).toBe(false);
      expect(p.air).toBe(p.maxAir);
    }
    // the helmsman's eyes are below the waterline outside: there the world is water
    const eye = p.eyePos();
    expect(eye.y).toBeLessThan(WATER_SURFACE - 0.5);
    expect(sim.world.getCell(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) & ID_MASK).toBe(B.WATER);
    expect(ev.of('playerHurt')).toEqual([]);
    expect(p.health).toBe(20);
  });
});

function xyz(v: Vec3): [number, number, number] {
  return [v.x, v.y, v.z];
}
