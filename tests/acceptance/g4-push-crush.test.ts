/**
 * ACCEPTANCE 15-18 (docs/ACCEPTANCE.md "推与挤"): windmills pushing ships, wedging them against
 * walls, pushing and crushing players and rabbits — headless, whole-simulation scenes.
 *
 * Two kinds of world-mounted windmill are used (every one is started by the player: look at
 * the bearing, right-click to preview, right-click to start):
 *  - a WINDMILL: bearing facing +Z, four canvas arms in a vertical plane (axis horizontal); its
 *    blades sweep down through whatever is under the hub;
 *  - a PADDLE: bearing facing down, one canvas plate turning about a vertical axis; its blade
 *    sweeps horizontally (through the water surface at sea, along the ground on land).
 * DESIGN 运动与交互: 机械推物理 — 叶片把船推开，只有船被夹在叶片和地形之间推不动时，重叠的那几格才
 * 损毁并掉落；实体被挤 — 先推开，推不动（被世界方块或另一个结构体挡住）就受伤，并挪到最近的空位，
 * 创造模式只挪不伤；LESSONS 生物被挤住 — 生存模式下被挤 3 次算死.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NX, NY, NZ, PY, PZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import { CRUSH_DAMAGE, PLAYER_MAX_HEALTH, RABBIT_CRUSH_LIMIT } from '../../src/entities/constants';
import type { Rabbit } from '../../src/entities/entity';
import type { Rotor, Ship } from '../../src/structures/structure';
import type { Simulation } from '../../src/sim/simulation';
import type { SimEvent } from '../../src/sim/view';
import { ME, type TestWorld } from './world';
import {
  LAND_TOP,
  assemble,
  bodyIn,
  buildBoat,
  depthIn,
  TOUCH,
  buildWindmill,
  cellMap,
  copy,
  dist,
  drops,
  extent,
  fill,
  hdist,
  hubAbove,
  hullCentres,
  hullSamples,
  hurtEvents,
  idAt,
  landWorld,
  seaWorld,
  shipStats,
  startWindmillByClicks,
  watchCrushes,
  watchEvents,
  type Box3,
  type Cell3,
  type CrushRecord,
} from './g4-push-crush-helpers';

const T = LAND_TOP;

type Hurt = Extract<SimEvent, { type: 'playerHurt' }>;

// ======================================================================== windmills

/**
 * Paddle over the sea: bearing (0, 32, 0) facing down, canvas plate x 0..7, y 28..31, z 0 — its
 * lower half under the water surface (water up to y = 29). Turning about -Y it sweeps
 * east -> south -> west -> north; blade reach 7.5 blocks.
 */
function seaPaddle(sim: Simulation): Cell3 {
  const canvas: Cell3[] = [];
  for (let y = 28; y <= 31; y++) for (let x = 0; x <= 7; x++) canvas.push([x, y, 0]);
  return buildWindmill(sim, [0, 32, 0], NY, canvas);
}

/**
 * Windmill with four arms of `len` canvas cells in the vertical plane z = bz + 1: bearing
 * (bx, hy, bz) facing +Z, hub (bx, hy, bz + 1). It turns from +X toward +Y, so the lowest arm
 * moves toward +X.
 */
function windmill(sim: Simulation, bx: number, hy: number, bz: number, len = 4): Cell3 {
  const z = bz + 1;
  const canvas: Cell3[] = [[bx, hy, z]];
  for (let k = 1; k <= len; k++) canvas.push([bx + k, hy, z], [bx - k, hy, z], [bx, hy + k, z], [bx, hy - k, z]);
  return buildWindmill(sim, [bx, hy, bz], PZ, canvas);
}

/**
 * Paddle on land: bearing (0, T+2, 0) facing down, hub (0, T+1, 0), a blade two cells high along
 * the ground (x 0..6, y T..T+1, z 0). Turning about -Y it sweeps east -> south -> west -> north
 * through everything standing on the ground within 6.5 blocks of the hub.
 */
function landPaddle(sim: Simulation): Cell3 {
  const canvas: Cell3[] = [
    [0, T + 1, 0],
    [0, T, 0],
  ];
  for (let x = 1; x <= 6; x++) canvas.push([x, T, 0], [x, T + 1, 0]);
  return buildWindmill(sim, [0, T + 2, 0], NY, canvas);
}

// ======================================================================== ship traces

interface ShipTrace {
  ship: Ship;
  /** Per tick after the windmill started: */
  counts: number[];
  dropCounts: number[];
  contacts: number[];
  pinned: number[];
  positions: Vec3[];
  extents: Box3[];
  /** Hull cells the dynamics reports as destroyed, summed. */
  destroyedStat: number;
}

interface ShipRun extends ShipTrace {
  n0: number;
  cells0: Map<string, number>;
  /** Centre of mass while floating at rest, before the windmill started. */
  rest: Vec3;
}

function traceShip(w: TestWorld, ship: Ship, ticks: number, each?: () => void): ShipTrace {
  const { sim } = w;
  const out: ShipTrace = { ship, counts: [], dropCounts: [], contacts: [], pinned: [], positions: [], extents: [], destroyedStat: 0 };
  for (let i = 0; i < ticks; i++) {
    w.tickWhile(); // until the ship is gone
    out.counts.push(ship.removed ? 0 : ship.grid.count);
    out.dropCounts.push(drops(sim).count);
    if (ship.removed) break;
    const st = shipStats(sim, ship);
    out.contacts.push(st.rotorContacts);
    out.pinned.push(st.pinned);
    out.destroyedStat += st.destroyed;
    out.positions.push(copy(ship.grid.position));
    out.extents.push(extent(hullSamples(ship)));
    each?.();
  }
  return out;
}

function sum(a: readonly number[]): number {
  return a.reduce((s, v) => s + v, 0);
}

// ======================================================================== 15

describe('15. 风车推开阔水面上的船，船不受损。', () => {
  /** A 3x3 plank boat (open hold, helm) floating west of a paddle's southern arc, open water all around. */
  let paddle: ShipRun;
  /** The same boat floating in the plane of a windmill whose lowest blades dip into the sea. */
  let mill: ShipRun;

  beforeAll(() => {
    {
      // The player stands on a single block high above the water (out of reach of boat and blades).
      const w = seaWorld('survival', vec3(1.5, 34, -1.5));
      const { sim, me } = w;
      sim.world.setCell(1, 33, -2, makeCell(B.STONE));
      const helm = buildBoat(sim, -3, 4, -1, 6, 29, NZ); // x -3..-1, z 4..6
      const bearing = seaPaddle(sim);
      w.tick(2);
      const ship = assemble(sim, helm);
      w.tick(60); // float to rest
      const n0 = ship.grid.count;
      const cells0 = cellMap(ship.grid);
      const rest = copy(ship.grid.position);
      startWindmillByClicks(w, bearing, PY);
      paddle = { ...traceShip(w, ship, 300), n0, cells0, rest };
    }
    {
      const w = seaWorld('survival', vec3(1.5, 34, -2.5));
      const { sim, me } = w;
      sim.world.setCell(1, 33, -3, makeCell(B.STONE));
      const helm = buildBoat(sim, -4, -1, -2, 1, 29, NZ); // x -4..-2, z -1..1: astride the blade plane z = 0
      w.tick(2);
      const ship = assemble(sim, helm);
      w.tick(60);
      // Hub (0, 32, 0): the lowest arm reaches down to y = 28, two blocks into the sea.
      const bearing = windmill(sim, 0, 32, -1);
      w.tick(2);
      const n0 = ship.grid.count;
      const cells0 = cellMap(ship.grid);
      const rest = copy(ship.grid.position);
      startWindmillByClicks(w, bearing, PY);
      mill = { ...traceShip(w, ship, 250), n0, cells0, rest };
    }
  });

  it('风车推船: a paddle sweeping through the water surface pushes the floating boat along its sweep, far from where it floated', () => {
    const c = paddle.contacts.findIndex((v) => v > 0);
    expect(c).toBeGreaterThanOrEqual(0);
    // The blade reaches the boat sweeping west: a second after the first contact the boat has
    // been shoved west by more than a block...
    expect(paddle.positions[c + 20]!.x).toBeLessThan(paddle.rest.x - 1);
    // ... and it is pushed much farther than its own width (3 blocks).
    expect(Math.max(...paddle.positions.map((q) => hdist(q, paddle.rest)))).toBeGreaterThan(3);
  });

  it('风车推船: a windmill dipping its blades into the sea pushes the boat away along the sweep, clear of the blades', () => {
    expect(mill.contacts.some((v) => v > 0)).toBe(true);
    const end = mill.positions[mill.positions.length - 1]!;
    // The lowest arm moves toward +X: the boat ends up more than 5 blocks east of where it floated...
    expect(end.x - mill.rest.x).toBeGreaterThan(5);
    // ... out of the blades' reach: no contact during the last 50 ticks.
    expect(mill.contacts.slice(-50).every((v) => v === 0)).toBe(true);
  });

  for (const [name, run] of [
    ['paddle', (): ShipRun => paddle],
    ['windmill', (): ShipRun => mill],
  ] as const) {
    it(`船不受损 (${name}): every cell kept at every tick, nothing destroyed, no drops (survival)`, () => {
      const r = run();
      expect(sum(r.contacts)).toBeGreaterThan(0); // it really was pushed
      expect(r.n0).toBe(18); // 9 floor + 8 rim planks + the helm
      expect(r.counts.length).toBeGreaterThan(200);
      expect(r.counts.every((n) => n === r.n0)).toBe(true);
      expect(cellMap(r.ship.grid)).toEqual(r.cells0);
      expect(r.destroyedStat).toBe(0);
      expect(r.pinned.every((n) => n === 0)).toBe(true);
      expect(Math.max(...r.dropCounts)).toBe(0);
    });
  }
});

// ======================================================================== 16

describe('16. 叶片把船顶在墙角：先推；推不动时逐格损毁，不会穿墙。', () => {
  /**
   * The paddle and boat of scenario 15, the boat now in a corner of two thin (one block) stone
   * walls, one block away from each: a west wall (cells x = -5, face x = -4) and a wall between
   * the boat and the hub row (cells z = 2, face z = 3). The blade reaches the boat sweeping west,
   * then north-west: into the corner.
   */
  const WEST = { x: -5, z0: -1, z1: 12 };
  const NORTH = { z: 2, x0: -5, x1: -1 };
  const Y0 = 20;
  const Y1 = 33;
  let run: ShipRun;
  let restExtent: Box3;
  let maxPen = 0;
  let centresInWall = 0;
  let dropItems = new Set<number>();

  /** How far a world point lies inside / past one of the walls (0 on the boat's side). */
  function wallPenetration(p: Vec3): number {
    let pen = 0;
    if (p.y > Y0 && p.y < Y1 + 1) {
      if (p.z > WEST.z0 && p.z < WEST.z1 + 1) pen = Math.max(pen, WEST.x + 1 - p.x);
      if (p.x > NORTH.x0 && p.x < NORTH.x1 + 1) pen = Math.max(pen, NORTH.z + 1 - p.z);
    }
    return pen;
  }

  beforeAll(() => {
    const w = seaWorld('survival', vec3(1.5, 34, -1.5));
    const { sim, me } = w;
    sim.world.setCell(1, 33, -2, makeCell(B.STONE));
    fill(sim, WEST.x, Y0, WEST.z0, WEST.x, Y1, WEST.z1, B.STONE);
    fill(sim, NORTH.x0, Y0, NORTH.z, NORTH.x1, Y1, NORTH.z, B.STONE);
    const helm = buildBoat(sim, -3, 4, -1, 6, 29, NZ);
    const bearing = seaPaddle(sim);
    w.tick(2);
    const ship = assemble(sim, helm);
    w.tick(60);
    const n0 = ship.grid.count;
    const cells0 = cellMap(ship.grid);
    const rest = copy(ship.grid.position);
    restExtent = extent(hullSamples(ship));
    startWindmillByClicks(w, bearing, PY);
    const isWall = (p: Vec3): boolean => idAt(sim.world, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === B.STONE;
    const t = traceShip(w, ship, 450, () => {
      for (const p of hullSamples(ship)) maxPen = Math.max(maxPen, wallPenetration(p));
      for (const c of hullCentres(ship)) if (isWall(c)) centresInWall++;
    });
    run = { ...t, n0, cells0, rest };
    dropItems = drops(sim).items;
  });

  it('先推: the blade first pushes the boat up to the wall; no cell is lost while the boat can still move', () => {
    /** Distance from the hull to the nearer wall face. */
    const gap = (e: Box3): number => Math.min(e.minX - (WEST.x + 1), e.minZ - (NORTH.z + 1));
    // The boat floated a block away from both walls.
    expect(restExtent.minX).toBeCloseTo(-3, 1);
    expect(restExtent.minZ).toBeCloseTo(4, 1);
    expect(gap(restExtent)).toBeCloseTo(1, 1);
    const contact = run.contacts.findIndex((v) => v > 0);
    const destroy = run.counts.findIndex((n) => n < run.n0);
    expect(contact).toBeGreaterThanOrEqual(0);
    // The blade pushed the intact boat for at least two ticks before any cell went...
    expect(destroy - contact).toBeGreaterThanOrEqual(2);
    // ... all the way across the gap: on the last tick with every cell the hull lay against a wall.
    const intact = run.extents[destroy - 1]!;
    expect(gap(intact)).toBeLessThan(0.1);
    expect(gap(restExtent) - gap(intact)).toBeGreaterThan(0.9);
    // The first cell went while the hull was still pressed against that wall.
    expect(gap(run.extents[destroy]!)).toBeLessThan(0.1);
  });

  it('推不动时逐格损毁: wedged, the hull loses cells one per tick at most, gradually, each dropping its item (survival)', () => {
    const lost: number[] = [];
    let prev = run.n0;
    for (const n of run.counts) {
      lost.push(prev - n);
      prev = n;
    }
    const destroyed = run.n0 - run.counts[run.counts.length - 1]!;
    expect(destroyed).toBeGreaterThanOrEqual(3);
    expect(Math.max(...lost)).toBeLessThanOrEqual(1);
    expect(lost.filter((d) => d === 1).length).toBe(destroyed); // spread over `destroyed` ticks
    // Destroyed only in ticks where the blade could not move the boat (pinned blade contacts).
    lost.forEach((d, i) => {
      if (d > 0 && i < run.pinned.length) expect(run.pinned[i]).toBeGreaterThan(0);
    });
    // Survival: every destroyed cell became an item drop (planks, or the helm).
    expect(run.dropCounts[run.dropCounts.length - 1]).toBe(destroyed);
    expect(dropItems.size).toBeGreaterThan(0);
    for (const item of dropItems) expect([B.PLANKS_OAK, B.HELM]).toContain(item);
  });

  it('不会穿墙: at no tick is a hull cell centre inside a wall, nor any part of the hull half a block into one', () => {
    expect(sum(run.contacts)).toBeGreaterThan(0);
    expect(run.extents.length).toBeGreaterThan(20);
    expect(centresInWall).toBe(0);
    expect(maxPen).toBeLessThan(0.5);
  });
});

// ======================================================================== 17

interface PlayerRun {
  start: Vec3;
  maxAway: number;
  minHealth: number;
  hurts: Hurt[];
  crushes: CrushRecord[];
  /** Ticks at whose end the body still overlapped the blade. */
  insideBlade: number;
}

function tracePlayer(w: TestWorld, rotor: Rotor, ticks: number): PlayerRun {
  const { sim, me } = w;
  const events = watchEvents(sim);
  const crushes = watchCrushes(sim);
  const start = copy(me.player.pos);
  let maxAway = 0;
  let minHealth = me.player.health;
  let insideBlade = 0;
  for (let i = 0; i < ticks; i++) {
    w.tick();
    maxAway = Math.max(maxAway, hdist(me.player.pos, start));
    minHealth = Math.min(minHealth, me.player.health);
    if (bodyIn(rotor.grid, me.player)) insideBlade++;
  }
  return { start, maxAway, minHealth, hurts: hurtEvents(events), crushes, insideBlade };
}

interface CageRun {
  crush: CrushRecord | undefined;
  before: Vec3;
  after: Vec3;
  healthBefore: number;
  healthAfter: number;
  hurts: Hurt[];
  inWorld: boolean;
  inBlade: boolean;
}

/**
 * The player stands at (0.5, T, 3.5) and starts the land paddle; then a 1x2 cage of stone is
 * closed around that cell (walls on all four sides, roof at T+2). The blade sweeps through it.
 * Runs until the first crush.
 */
function cageRun(mode: 'survival' | 'creative'): CageRun {
  const w = landWorld(mode, vec3(0.5, T, 3.5));
  const { sim, me } = w;
  const bearing = landPaddle(sim);
  w.tick(2);
  const rotor = startWindmillByClicks(w, bearing, PZ);
  for (const [x, z] of [
    [-1, 3],
    [1, 3],
    [0, 2],
    [0, 4],
  ] as const) {
    fill(sim, x, T, z, x, T + 1, z, B.STONE);
  }
  fill(sim, -1, T + 2, 2, 1, T + 2, 4, B.STONE);
  const events = watchEvents(sim);
  const crushes = watchCrushes(sim);
  let before = copy(me.player.pos);
  let healthBefore = me.player.health;
  for (let i = 0; i < 200 && crushes.length === 0; i++) {
    before = copy(me.player.pos);
    healthBefore = me.player.health;
    w.tickWhile();
  }
  return {
    crush: crushes[0],
    before,
    after: copy(me.player.pos),
    healthBefore,
    healthAfter: me.player.health,
    hurts: hurtEvents(events),
    inWorld: bodyIn(sim.world, me.player),
    inBlade: bodyIn(rotor.grid, me.player),
  };
}

interface GunwaleRun {
  /** Player position in ship-local coordinates before / after. */
  l0: Vec3;
  l1: Vec3;
  maxDz: number;
  carrierAtEnd: boolean;
  /** Ticks at whose end the body was inside the ship's cells (deeper than TOUCH). */
  inShip: number;
  shipRotorContacts: number;
  crushes: CrushRecord[];
  hurts: Hurt[];
  minHealth: number;
}

describe('17. 叶片扫过玩家时把人推开。玩家被关在笼子里时，生存模式扣血并挪位，创造模式只挪位。风车沿着船舷推人时，不算挤伤。', () => {
  let sweep: PlayerRun;
  let millOver: PlayerRun;
  let cageSurvival: CageRun;
  let cageCreative: CageRun;
  let gunwale: GunwaleRun;

  beforeAll(() => {
    {
      // A survival player standing free on open ground, 3 blocks south of the paddle's hub.
      const w = landWorld('survival', vec3(0.5, T, 3.5));
      const { sim, me } = w;
      const bearing = landPaddle(sim);
      w.tick(2);
      const rotor = startWindmillByClicks(w, bearing, PZ);
      sweep = tracePlayer(w, rotor, 200);
    }
    {
      // A survival player standing free on open ground in the plane of a windmill on a tower; the
      // blades sweep down to about a block above the ground (through the player's head and chest).
      const w = landWorld('survival', vec3(-1.5, T, 1.5));
      const { sim, me } = w;
      const hy = hubAbove(T, 4, 0.05); // T + 5
      fill(sim, 0, T, 0, 0, hy - 1, 0, B.STONE_BRICKS); // the tower under the bearing
      const bearing = windmill(sim, 0, hy, 0);
      w.tick(2);
      const rotor = startWindmillByClicks(w, bearing, NX);
      millOver = tracePlayer(w, rotor, 200);
    }
    cageSurvival = cageRun('survival');
    cageCreative = cageRun('creative');
    {
      // A floating ship: plank deck x -6..8, z 0..4 at the sea surface, a two-high gunwale along
      // its north edge (z = 0), the helm at the east end. A survival player stands on the deck
      // against the gunwale. A windmill hangs from a bearing above the gunwale; its blades turn in
      // the plane z = 1, just inside the gunwale and clear of the deck, so the lowest arm sweeps
      // east along the gunwale over the deck — through the player, never through the ship.
      const w = seaWorld('survival', vec3(-1.5, 31, 1.31));
      const { sim, me } = w;
      fill(sim, -6, 29, 0, 8, 29, 4, B.PLANKS_OAK);
      fill(sim, -6, 30, 0, 8, 31, 0, B.PLANKS_OAK);
      sim.world.setCell(6, 30, 3, makeCell(B.HELM, facingState(NZ)));
      w.tick(2);
      const ship = assemble(sim, [6, 30, 3]);
      w.tick(80); // float to rest, the player riding on the deck
      if (me.player.carrierId !== ship.id) throw new Error('scene: the player is not aboard');
      const deckTop = ship.grid.toWorld(vec3(0, 30, 2)).y;
      const bearing = windmill(sim, 0, hubAbove(deckTop, 4, 0.05), 0);
      w.tick(2);
      startWindmillByClicks(w, bearing, NX);
      const events = watchEvents(sim);
      const crushes = watchCrushes(sim);
      const local = (): Vec3 => ship.grid.toLocal(copy(me.player.pos), vec3());
      const l0 = local();
      let maxDz = 0;
      let inShip = 0;
      let shipRotorContacts = 0;
      let minHealth = me.player.health;
      for (let i = 0; i < 200; i++) {
        w.tick();
        maxDz = Math.max(maxDz, Math.abs(local().z - l0.z));
        // Inside the ship's hard cells by more than a touch. (The body is a world-axis box resting on
        // a deck that rocks a little; in network mode the client placed it against the deck's
        // previous pose, and the same deck-local feet touch the deck of this tick by ~1e-5.)
        if (depthIn(ship.grid, me.player) > TOUCH) inShip++;
        shipRotorContacts += shipStats(sim, ship).rotorContacts;
        minHealth = Math.min(minHealth, me.player.health);
      }
      gunwale = {
        l0,
        l1: local(),
        maxDz,
        carrierAtEnd: me.player.carrierId === ship.id,
        inShip,
        shipRotorContacts,
        crushes,
        hurts: hurtEvents(events),
        minHealth,
      };
    }
  });

  it('叶片扫过玩家时把人推开: a paddle blade sweeping along the ground pushes a free-standing player aside, unhurt', () => {
    expect(sweep.maxAway).toBeGreaterThan(1);
    expect(sweep.insideBlade).toBe(0); // out of the blade at the end of every tick
    expect(sweep.crushes).toEqual([]);
    expect(sweep.hurts).toEqual([]);
    expect(sweep.minHealth).toBe(PLAYER_MAX_HEALTH);
  });

  it('叶片扫过玩家时把人推开: windmill blades sweeping down over a free-standing player push them aside, unhurt', () => {
    expect(millOver.maxAway).toBeGreaterThan(1);
    expect(millOver.crushes).toEqual([]);
    expect(millOver.hurts).toEqual([]);
    expect(millOver.minHealth).toBe(PLAYER_MAX_HEALTH);
  });

  it('关在笼子里，生存模式扣血: a survival player caged where the blade sweeps is crushed and loses health', () => {
    expect(cageSurvival.crush?.kind).toBe('player');
    expect(cageSurvival.healthBefore).toBe(PLAYER_MAX_HEALTH);
    expect(cageSurvival.healthAfter).toBe(PLAYER_MAX_HEALTH - CRUSH_DAMAGE);
    expect(cageSurvival.hurts).toEqual([{ type: 'playerHurt', player: ME, amount: CRUSH_DAMAGE, cause: 'crush' }]);
  });

  it('关在笼子里，生存模式挪位: the crushed survival player is moved out of the cage to a free spot', () => {
    expect(cageSurvival.crush).toBeDefined();
    expect(dist(cageSurvival.after, cageSurvival.before)).toBeGreaterThan(0.5);
    expect(cageSurvival.inWorld).toBe(false);
    expect(cageSurvival.inBlade).toBe(false);
    // No longer inside the cage (interior: x 0..1, z 3..4, y T..T+2).
    const a = cageSurvival.after;
    expect(a.x + 0.3 <= 0 || a.x - 0.3 >= 1 || a.z + 0.3 <= 3 || a.z - 0.3 >= 4 || a.y >= T + 2).toBe(true);
  });

  it('关在笼子里，创造模式只挪位: a creative player caged where the blade sweeps is only moved to a free spot, at full health', () => {
    expect(cageCreative.crush?.kind).toBe('player');
    expect(dist(cageCreative.after, cageCreative.before)).toBeGreaterThan(0.5);
    expect(cageCreative.inWorld).toBe(false);
    expect(cageCreative.inBlade).toBe(false);
    expect(cageCreative.healthAfter).toBe(PLAYER_MAX_HEALTH);
    expect(cageCreative.hurts).toEqual([]);
  });

  it('风车沿着船舷推人: the windmill pushes the player on the deck along the gunwale (scene: its blades never touch the ship)', () => {
    expect(gunwale.shipRotorContacts).toBe(0);
    expect(gunwale.l1.x - gunwale.l0.x).toBeGreaterThan(1); // along the gunwale, the way the lowest arm moves
    expect(gunwale.maxDz).toBeLessThan(0.2); // and stays against it
    expect(gunwale.inShip).toBe(0);
    expect(gunwale.carrierAtEnd).toBe(true);
  });

  it('风车沿着船舷推人时，不算挤伤: no crush, no damage', () => {
    expect(gunwale.l1.x - gunwale.l0.x).toBeGreaterThan(1); // it was pushed
    expect(gunwale.crushes).toEqual([]);
    expect(gunwale.hurts).toEqual([]);
    expect(gunwale.minHealth).toBe(PLAYER_MAX_HEALTH);
  });
});

// ======================================================================== 18

interface RabbitCrush {
  tick: number;
  before: Vec3;
  after: Vec3;
  aliveAfter: boolean;
  crushCount: number;
  /** After the crush the body overlaps neither world blocks nor the blade. */
  freeAfter: boolean;
}

interface RabbitRun {
  crushes: RabbitCrush[];
  removed: boolean;
  removedAtTick: number;
  crushCountEnd: number;
}

/**
 * A rabbit trapped in a sealed pocket (x -1..1, z 4, y T: three cells along the blade's path) in
 * a block of stone (x -4..4, z 1..7, y T..T+3) that the land paddle's blade sweeps through. The
 * stone is three blocks thick all around the pocket, so the only free spots within the crush
 * search radius are in the pocket: the rabbit stays trapped, squeezed again on every turn.
 * The player starts the paddle from the top of the stone block, above the blade.
 */
function rabbitRun(mode: 'survival' | 'creative', ticks: number): RabbitRun {
  const w = landWorld(mode, vec3(0.5, T + 4, 1.6));
  const { sim, me } = w;
  const bearing = landPaddle(sim);
  fill(sim, -4, T, 1, 4, T + 3, 7, B.STONE);
  fill(sim, -1, T, 4, 1, T, 4, 0);
  w.tick(2);
  const rabbit = sim.entities.spawnRabbit(1.5, T, 4.5) as Rabbit;
  const crushes = watchCrushes(sim);
  const rotor = startWindmillByClicks(w, bearing, PY);
  const out: RabbitRun = { crushes: [], removed: false, removedAtTick: -1, crushCountEnd: 0 };
  const mine = (): number => crushes.filter((c) => c.entityId === rabbit.id).length;
  for (let i = 0; i < ticks && !rabbit.removed; i++) {
    const before = copy(rabbit.pos);
    const n = mine();
    w.tickWhile();
    for (let k = n; k < mine(); k++) {
      out.crushes.push({
        tick: sim.ticks,
        before,
        after: copy(rabbit.pos),
        aliveAfter: !rabbit.removed,
        crushCount: rabbit.crushCount,
        freeAfter: !bodyIn(sim.world, rabbit) && !bodyIn(rotor.grid, rabbit),
      });
    }
    if (rabbit.removed) out.removedAtTick = sim.ticks;
  }
  out.removed = rabbit.removed;
  out.crushCountEnd = rabbit.crushCount;
  return out;
}

describe('18. 兔子被挤住：创造模式挪位；生存模式被挤多次后压扁。', () => {
  let creative: RabbitRun;
  let survival: RabbitRun;

  beforeAll(() => {
    creative = rabbitRun('creative', 900);
    survival = rabbitRun('survival', 900);
  });

  it('创造模式挪位: each time the blade squeezes the trapped rabbit, it is moved to a free spot', () => {
    expect(creative.crushes.length).toBeGreaterThanOrEqual(RABBIT_CRUSH_LIMIT + 1);
    for (const c of creative.crushes) {
      expect(c.freeAfter).toBe(true);
      expect(dist(c.after, c.before)).toBeGreaterThan(0.25);
    }
  });

  it('创造模式不会压扁: squeezed more often than the survival limit, the rabbit lives on', () => {
    expect(creative.crushes.length).toBeGreaterThan(RABBIT_CRUSH_LIMIT);
    expect(creative.crushes.every((c) => c.aliveAfter)).toBe(true);
    expect(creative.removed).toBe(false);
    expect(creative.crushCountEnd).toBe(0);
  });

  it('生存模式: the rabbit survives the first two squeezes, moved to a free spot each time', () => {
    expect(survival.crushes.length).toBeGreaterThanOrEqual(2);
    for (const c of survival.crushes.slice(0, 2)) {
      expect(c.aliveAfter).toBe(true);
      expect(c.freeAfter).toBe(true);
    }
    expect(survival.crushes.slice(0, 2).map((c) => c.crushCount)).toEqual([1, 2]);
  });

  it('生存模式被挤多次后压扁: the third squeeze flattens it', () => {
    expect(RABBIT_CRUSH_LIMIT).toBe(3);
    expect(survival.crushes.length).toBe(3);
    expect(survival.crushes[2]!.aliveAfter).toBe(false);
    expect(survival.removed).toBe(true);
    expect(survival.removedAtTick).toBe(survival.crushes[2]!.tick);
    expect(survival.crushCountEnd).toBe(3);
  });
});
