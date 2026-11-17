/**
 * The Simulation: owns every piece of game state and advances it one fixed tick at a time.
 * No DOM, no rendering, no wall-clock time — it runs headless in Node (tests) exactly as
 * in the browser. All state hangs off the instance; creating a new Simulation starts from
 * nothing (docs/LESSONS.md "同种子开新世界，上一局的胶还在").
 *
 * Tick order (docs/ARCHITECTURE.md, docs/LESSONS.md "每个 tick 的顺序"):
 *   0. time++, entity snapshot (prev* for render interpolation), chunk housekeeping
 *   1. player actions (place, mine, use, glue, assemble, steer)
 *   2. scheduled block ticks (liquids, falling blocks ...)
 *   3. structures move (rotors, then ship dynamics)
 *   4. carried entities follow their carriers
 *   5. entities move, collide, get pushed / crushed, attach / detach (blast crates explode here)
 *   6. ambient rabbits
 *   7. lighting catches up; the InteractionView is rebuilt
 * Block updates (falling sand, popping torches) queued by any phase run right after it.
 *
 * Scripted control (tests, tools, the debug console): lookAt / lookAtCell, use / attack,
 * useOn / mine (aim + click, checked), targetCell / mineTargetCell, hold / emptyHand /
 * giveItem, teleport, advance, setDayTime. They only write what the client would write
 * (input, inventory) or what a command would (teleport), so a scripted session behaves
 * exactly like a played one.
 */
import { DAY_TICKS, ROTOR_MAX_CELLS, ROTOR_MIN_SAILS, SHIP_MAX_CELLS } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../core/dirs';
import { Emitter } from '../core/events';
import { mod, vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { World } from '../voxel/world';
import type { VoxelGrid } from '../voxel/grid';
import { LightEngine } from '../light/engine';
import { Fluids } from '../liquid/fluids';
import { GlueStore } from '../structures/glue';
import { StructureManager } from '../structures/manager';
import { createShipDynamics } from '../structures/physics';
import { Ship, type ShipDynamics, type Structure, type StructureHost } from '../structures/structure';
import { EntityManager } from '../entities/manager';
import type { Player } from '../entities/entity';
import type { EntityEvent, EntityHost } from '../entities/host';
import { maxStackOf } from '../entities/inventory';
import type { ChunkGenerator } from '../worldgen/generator';
import { BlockUpdates } from './blockupdates';
import { ChunkManager, type LoadAnchor } from './chunks';
import { explode } from './explosion';
import { Interaction } from './interact';
import { RabbitSpawner } from './rabbits';
import { emptyView, type GridCell, type InteractionView, type SimEvent } from './view';

export type GameMode = 'creative' | 'survival';

export interface SimOptions {
  /** 32-bit world seed. */
  seed: number;
  mode: GameMode;
  generator: ChunkGenerator;
  /** Chunk radius kept loaded around the player (default 8). */
  loadRadius?: number;
  /**
   * Generate missing chunks synchronously inside tick() (headless tests, tools).
   * In the browser this is false: the client pulls `chunks.wanted()` and feeds
   * `chunks.provide()` from worker threads.
   */
  syncChunks?: boolean;
  /** Where the player starts; defaults to generator.spawnPoint(). */
  spawn?: { x: number; y: number; z: number };
  /** Ambient rabbits by day (default true). Tests that count entities turn them off. */
  rabbits?: boolean;
  /**
   * Do not generate and light the ground around the spawn point in the constructor (default
   * false). Set it when the next call is importSave(): that throws every chunk away and loads
   * the ground under the SAVED player itself, so the constructor's work would be wasted (tens of
   * milliseconds on generated terrain). A simulation that is ticked without an import still gets
   * its chunks (syncChunks, or chunks.provide()); until they arrive the player is frozen in place.
   */
  deferInitialLoad?: boolean;
}

/** Lighting work per tick (cells visited) — keeps a big relight from stalling a frame. */
const LIGHT_BUDGET = 60_000;
/** Time of day a new world starts at (0 = sunrise). */
const START_DAY_TIME = 0.04;

export class Simulation {
  readonly world: World;
  readonly light: LightEngine;
  readonly fluids: Fluids;
  readonly chunks: ChunkManager;
  readonly worldGlue = new GlueStore();
  readonly rng: Rng;
  readonly generator: ChunkGenerator;

  readonly dynamics: ShipDynamics;
  readonly structures: StructureManager;
  readonly entities: EntityManager;

  readonly blocks: BlockUpdates;
  readonly interaction: Interaction;
  readonly rabbits: RabbitSpawner;

  /** Things that happened, for the client. Emitted synchronously during tick(). */
  readonly events = new Emitter<SimEvent>();
  /** What the player's actions look like right now (overlays, hints). Rebuilt every tick. */
  view: InteractionView = emptyView();

  loadRadius: number;
  readonly syncChunks: boolean;

  /** Assembly limits, for messages (docs/DESIGN.md). */
  readonly shipMaxCells = SHIP_MAX_CELLS;
  readonly rotorMaxCells = ROTOR_MAX_CELLS;
  readonly rotorMinSails = ROTOR_MIN_SAILS;

  /**
   * Offset (ticks) between the world clock and the time of day. The clock itself
   * (world.time) drives scheduled ticks and must only ever advance by one per tick, so
   * changing the time of day moves this offset instead. Saved.
   */
  dayOffset = 0;

  /** Structures the change hooks and the structureAdded / Removed events have seen. */
  private knownStructures: readonly Structure[] = [];
  private readonly structureHooks = new Map<Structure, () => void>();
  private readonly unsubWorld: () => void;

  constructor(opts: SimOptions) {
    this.generator = opts.generator;
    this.loadRadius = opts.loadRadius ?? 8;
    this.syncChunks = opts.syncChunks ?? false;
    this.rng = new Rng((opts.seed ^ 0x51ed270b) >>> 0);

    this.world = new World(opts.seed);
    this.light = new LightEngine(this.world);
    this.fluids = new Fluids(this.world);
    this.chunks = new ChunkManager(this.world, this.light, this.fluids);
    this.light.attach();
    this.fluids.attach();

    const structureHost = this.makeStructureHost();
    this.dynamics = createShipDynamics(structureHost);
    this.structures = new StructureManager(structureHost, this.dynamics);
    this.entities = new EntityManager(this.makeEntityHost());
    this.blocks = new BlockUpdates(this);
    this.interaction = new Interaction(this);
    this.rabbits = new RabbitSpawner(this, opts.rabbits ?? true);
    // The one sim-level world hook (block updates, washed-away drops, preview staleness). It is
    // registered after the light, liquid and structure hooks, so it sees each change last.
    this.unsubWorld = this.world.onCellChange((x, y, z, oldCell, newCell, flags) => {
      this.interaction.onWorldChange(x, y, z, oldCell, newCell, flags);
      this.blocks.onWorldChange(x, y, z, oldCell, newCell, flags);
    });

    const spawn = opts.spawn ?? opts.generator.spawnPoint();
    // Start in the morning. The clock must be set BEFORE any chunk is loaded: loading
    // schedules liquid ticks relative to world.time.
    this.world.time = Math.floor(DAY_TICKS * START_DAY_TIME);
    // The ground under the player must exist before the first tick (unless a save brings its own).
    if (opts.deferInitialLoad !== true) this.chunks.loadAround(opts.generator, spawn.x, spawn.z, 1);
    // Generated chunks are pristine: whatever the hooks queued while loading is not a change.
    this.blocks.clear();
    const player = this.entities.createPlayer(opts.mode, spawn.x, spawn.y, spawn.z);
    player.spawn.x = spawn.x;
    player.spawn.y = spawn.y;
    player.spawn.z = spawn.z;
  }

  // ------------------------------------------------------------------ queries

  /** The local player. (Loading a save may replace the object, so never cache it across ticks.) */
  get player(): Player {
    const p = this.entities.player;
    if (!p) throw new Error('simulation has no player');
    return p;
  }
  get mode(): GameMode {
    return this.player.mode;
  }
  /** StructureHost: creative mode suppresses drops from displaced blocks. */
  get creative(): boolean {
    const p = this.entities.player;
    return p !== null && p.mode === 'creative';
  }
  /**
   * Ticks since the world began (read-only view of world.time, which is saved). The clock drives
   * scheduled block ticks: never write world.time to change the time of day — use setDayTime().
   */
  get ticks(): number {
    return this.world.time;
  }
  /**
   * 0..1 over a day: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight. THE time of day: it is
   * (world.time + dayOffset) mod DAY_TICKS, so world.time % DAY_TICKS alone is wrong as soon as
   * setDayTime() was used.
   */
  get dayTime(): number {
    return mod(this.world.time + this.dayOffset, DAY_TICKS) / DAY_TICKS;
  }
  /** True between sunrise and sunset. */
  get isDay(): boolean {
    return this.dayTime < 0.5;
  }
  /** Every grid a ray or a body can touch: the world first, then every structure. */
  grids(): VoxelGrid[] {
    const out: VoxelGrid[] = [this.world];
    for (const s of this.structures.all()) out.push(s.grid);
    return out;
  }
  /** The grid with this id (0 = the world), or undefined. */
  grid(id: number): VoxelGrid | undefined {
    return this.structures.gridById(id);
  }

  // ------------------------------------------------------------------ hosts
  // The structures and entities modules do not know the simulation; they talk to it
  // through these two small adapters.

  private makeStructureHost(): StructureHost {
    const sim = this;
    return {
      world: sim.world,
      worldGlue: sim.worldGlue,
      rng: sim.rng,
      get creative(): boolean {
        return sim.creative;
      },
      spawnDrop: (x, y, z, item, count) => {
        sim.entities.spawnItem(x, y, z, item, count);
      },
      releaseRiders: (structure) => sim.entities.releaseRiders(structure),
      blockUpdate: (x, y, z) => sim.blocks.updateAround(x, y, z),
    };
  }

  private makeEntityHost(): EntityHost {
    const sim = this;
    return {
      world: sim.world,
      rng: sim.rng,
      structures: () => sim.structures.all(),
      structure: (id) => sim.structures.get(id),
      explode: (x, y, z, power, source) => explode(sim, x, y, z, power, source),
      emit: (ev) => sim.onEntityEvent(ev),
    };
  }

  private onEntityEvent(ev: EntityEvent): void {
    if (ev.entity === this.entities.player) {
      if (ev.type === 'hurt') this.events.emit({ type: 'playerHurt', amount: ev.amount ?? 0, cause: ev.cause ?? '' });
      else if (ev.type === 'death') this.events.emit({ type: 'playerDied', cause: ev.cause ?? '' });
    }
    this.interaction?.onEntityEvent(ev);
  }

  // ------------------------------------------------------------------ player-facing actions

  setMode(mode: GameMode): void {
    this.player.mode = mode;
    if (mode === 'survival') this.player.flying = false;
  }
  respawn(): void {
    if (this.player.dead) this.entities.respawn(this.player);
  }
  /** Let go of the helm, if the player holds one (the client calls this when a screen opens). */
  releaseHelm(): void {
    if (this.player.steeringShipId !== 0) this.entities.stopSteering(this.player);
  }
  /** Throw the stack held by the inventory cursor into the world (clicking outside the inventory). */
  dropCursorStack(): void {
    const stack = this.player.inventory.takeCursor();
    if (stack) this.entities.dropFromPlayer(this.player, stack.item, stack.count);
  }
  /**
   * Pick block (middle click): put the block the player looks at (the use ray's target, what
   * the outline shows; world or structure) in hand — see Interaction.pickBlock for the hotbar
   * and backpack rules (creative fills a slot, survival only selects or swaps). Also writes
   * input.slot, so the next tick keeps the selection; a client that drives input.slot must
   * adopt player.inventory.selected afterwards. Returns true when the block is in hand.
   */
  pickBlock(): boolean {
    return this.interaction.pickBlock();
  }
  /** Steering read-out while the player holds a helm, else null. */
  helmView(): { throttle: number; rudder: number; speed: number; sails: number } | null {
    const id = this.player.steeringShipId;
    if (id === 0) return null;
    const ship = this.structures.get(id);
    if (!(ship instanceof Ship)) return null;
    const v = ship.grid.linearVelocity;
    return { throttle: ship.throttle, rudder: ship.rudder, speed: Math.hypot(v.x, v.z), sails: ship.sails };
  }
  /** Set the time of day (0..1, 0 = sunrise) without disturbing the world clock. */
  setDayTime(t: number): void {
    if (!Number.isFinite(t)) return;
    const target = Math.round(mod(t, 1) * DAY_TICKS);
    this.dayOffset = mod(target - this.world.time, DAY_TICKS);
  }

  // ------------------------------------------------------------------ scripted control

  /** Point the player's view at a world point (writes input.yaw / pitch like the client does). */
  lookAt(x: number, y: number, z: number): void {
    const p = this.player;
    const e = p.eyePos();
    const dx = x - e.x;
    const dy = y - e.y;
    const dz = z - e.z;
    const h = Math.hypot(dx, dz);
    if (h < 1e-12 && Math.abs(dy) < 1e-12) return;
    // forward = (-sin(yaw) cos(pitch), sin(pitch), -cos(yaw) cos(pitch))
    const yaw = h < 1e-12 ? p.yaw : Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, h);
    p.input.yaw = yaw;
    p.input.pitch = pitch;
    p.yaw = yaw;
    p.pitch = pitch;
  }

  /**
   * Point the view at a cell of a grid (0 = world, else a structure id): at the centre of
   * `face` when given (the ray then enters through that face, if the eye is on its outer
   * side), else at the cell centre. Returns false when the grid does not exist.
   */
  lookAtCell(x: number, y: number, z: number, face?: Dir, gridId = 0): boolean {
    const g = this.structures.gridById(gridId);
    if (g === undefined) return false;
    const p = vec3(x + 0.5, y + 0.5, z + 0.5);
    if (face !== undefined) {
      // Slightly inside the face: the ray crosses the face near its centre, never an edge.
      p.x += DIR_X[face]! * 0.45;
      p.y += DIR_Y[face]! * 0.45;
      p.z += DIR_Z[face]! * 0.45;
    }
    g.toWorld(p, p);
    this.lookAt(p.x, p.y, p.z);
    return true;
  }

  /** Queue one right-click (consumed by the next tick). */
  use(): void {
    this.player.input.usePresses++;
  }
  /** Queue one left-click (consumed by the next tick). */
  attack(): void {
    this.player.input.attackPresses++;
  }

  /**
   * Hold nothing: select the first empty hotbar slot, or empty the selected one when the hotbar
   * is full (its stack is discarded). Useful before clicks that differ with a block in hand
   * (lighting a blast crate, sneak + right-click docking at a ship's helm).
   */
  emptyHand(): void {
    const p = this.player;
    const inv = p.inventory;
    let slot = inv.hotbar.findIndex((s) => s === null || s.count <= 0);
    if (slot < 0) {
      slot = inv.selected;
      inv.hotbar[slot] = null;
    }
    inv.selected = slot;
    p.input.slot = slot;
  }

  /** Put items into the inventory like a pickup does. Returns the amount that did not fit. */
  giveItem(item: number, count = 1): number {
    return this.player.inventory.add(item, count);
  }

  /**
   * Hold `item` in hand: a hotbar slot already holding it is selected; otherwise a stack of
   * `count` (default: a full stack) goes into the first empty hotbar slot, or replaces the
   * selected one when the hotbar is full.
   */
  hold(item: number, count: number = maxStackOf(item)): void {
    const p = this.player;
    const inv = p.inventory;
    let slot = inv.hotbar.findIndex((s) => s !== null && s.item === item);
    if (slot < 0) {
      slot = inv.hotbar.findIndex((s) => s === null);
      if (slot < 0) slot = inv.selected;
      inv.hotbar[slot] = { item, count: Math.max(1, Math.floor(count)) };
    }
    inv.selected = slot;
    p.input.slot = slot;
  }

  /** Move the player's feet to a world point: lets go of any helm or carrier, no velocity, no fall. */
  teleport(x: number, y: number, z: number): void {
    const p = this.player;
    this.releaseHelm();
    p.carrierId = 0;
    p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.fallDistance = 0;
    p.setPosition(x, y, z);
  }

  /** Run `ticks` ticks. */
  advance(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.tick();
  }

  /**
   * The cell the player looks at right now with the held item's use ray (what a right-click acts
   * on: with a bucket in hand, liquid sources count), or null.
   */
  targetCell(): (GridCell & { face: Dir }) | null {
    const h = this.interaction.raycast();
    return h === null ? null : { gridId: h.grid.gridId, x: h.x, y: h.y, z: h.z, face: h.face };
  }
  /** The cell a left-click would mine right now (liquid never counts), or null. */
  mineTargetCell(): (GridCell & { face: Dir }) | null {
    const h = this.interaction.raycastMining();
    return h === null ? null : { gridId: h.grid.gridId, x: h.x, y: h.y, z: h.z, face: h.face };
  }

  /**
   * Aim at a cell (see lookAtCell), right-click once and run one tick. Returns false — and
   * clicks nothing — when that cell is not what the ray hits (out of reach, hidden behind
   * something), so a scripted scene fails loudly instead of clicking the wrong block.
   */
  useOn(x: number, y: number, z: number, face?: Dir, gridId = 0): boolean {
    if (!this.aimAt(x, y, z, face, gridId)) return false;
    this.use();
    this.tick();
    return true;
  }

  /**
   * Aim at a cell and hold the attack button until it is gone (survival mining takes the
   * block's hardness in seconds; creative breaks it at once), at most `maxTicks`. Returns true
   * when the cell was mined; false when it could not be aimed at or did not break in time.
   */
  mine(x: number, y: number, z: number, face?: Dir, gridId = 0, maxTicks = 400): boolean {
    if (!this.aimAt(x, y, z, face, gridId, true)) return false;
    const input = this.player.input;
    const grid = this.structures.gridById(gridId)!;
    const before = grid.getCell(x, y, z);
    this.attack();
    input.attack = true;
    try {
      for (let i = 0; i < maxTicks; i++) {
        this.tick();
        const g = this.structures.gridById(gridId);
        if (g === undefined || g.getCell(x, y, z) !== before) return true;
        // Keep aiming at the cell: a carrier may have turned the player.
        if (!this.aimAt(x, y, z, face, gridId, true)) return false;
      }
      return false;
    } finally {
      input.attack = false;
    }
  }

  /**
   * lookAtCell + check that the ray hits exactly that cell: the use ray of the held item, or the
   * mining ray (which never stops at liquid, even with a bucket in hand).
   */
  private aimAt(x: number, y: number, z: number, face: Dir | undefined, gridId: number, mining = false): boolean {
    if (!this.lookAtCell(x, y, z, face, gridId)) return false;
    const h = mining ? this.interaction.raycastMining() : this.interaction.raycast();
    return h !== null && h.grid.gridId === gridId && h.x === x && h.y === y && h.z === z && (face === undefined || h.face === face);
  }

  // ------------------------------------------------------------------ tick

  tick(): void {
    const world = this.world;
    world.time++;
    // prev* = where everything was at the end of the last tick: whatever moves an entity in
    // this tick (taking the wheel, an explosion, its carrier) is interpolated by the client.
    this.entities.beginTick();

    // 0 + 1. chunk housekeeping, player actions
    this.updateChunks();
    this.syncStructures();
    this.interaction.tick();
    this.afterPhase();

    // 2. scheduled block ticks
    const due = world.ticks.takeDue(world.time);
    for (let i = 0; i < due.length; i++) {
      const t = due[i]!;
      if (world.getId(t.x, t.y, t.z) !== t.id) continue;
      if (this.fluids.handles(t.id)) this.fluids.tick(t.x, t.y, t.z, t.id);
      else this.blocks.scheduledTick(t.x, t.y, t.z, t.id);
    }
    this.afterPhase();

    // 3. structures
    this.structures.step();
    this.afterPhase();

    // 4 + 5. entities
    this.entities.syncCarried();
    this.entities.update();
    this.afterPhase();

    // 6. ambient life
    this.rabbits.tick();

    // 7. lighting, view
    this.light.update(LIGHT_BUDGET);
    this.view = this.interaction.buildView();
  }

  /** Run queued block updates and catch up with structures created or removed. */
  private afterPhase(): void {
    this.blocks.flush();
    this.syncStructures();
  }

  /**
   * Hook the cell changes of new structures (support rules inside structures) and emit
   * structureAdded / structureRemoved. The manager replaces its list whenever the set
   * changes, so the common case is one reference comparison. Identity, not id, decides:
   * after loading a save a new structure may reuse an old one's id.
   */
  syncStructures(): void {
    const cur = this.structures.all();
    if (cur === this.knownStructures) return;
    const prev = this.knownStructures;
    this.knownStructures = cur;
    const now = new Set(cur);
    for (const s of prev) {
      if (now.has(s)) continue;
      const off = this.structureHooks.get(s);
      if (off !== undefined) {
        off();
        this.structureHooks.delete(s);
      }
      this.events.emit({ type: 'structureRemoved', id: s.id });
    }
    const before = new Set(prev);
    for (const s of cur) {
      if (before.has(s)) continue;
      const grid = s.grid;
      this.structureHooks.set(
        s,
        grid.onCellChange((x, y, z, oldCell, newCell, flags) => this.blocks.onStructureChange(grid, x, y, z, oldCell, newCell, flags)),
      );
      this.events.emit({ type: 'structureAdded', id: s.id });
    }
  }

  /** Called by importSave once everything is loaded: forget transient state, re-sync hooks. */
  afterLoad(): void {
    this.interaction.reset();
    this.blocks.clear();
    this.syncStructures();
    this.view = emptyView();
  }

  /** Unsubscribe every hook this simulation installed on shared objects. */
  dispose(): void {
    this.unsubWorld();
    for (const off of this.structureHooks.values()) off();
    this.structureHooks.clear();
    this.structures.dispose();
    this.events.clear();
  }

  private updateChunks(): void {
    const anchors: LoadAnchor[] = [{ x: this.player.pos.x, z: this.player.pos.z, radius: this.loadRadius }];
    for (const s of this.structures.ships()) {
      const p = s.grid.position;
      anchors.push({ x: p.x, z: p.z, radius: 3 });
    }
    this.chunks.setAnchors(anchors);
    if (this.syncChunks) {
      for (const c of this.chunks.wanted(4)) this.chunks.loadColumn(this.generator, c.cx, c.cz);
    }
    if ((this.world.time & 15) === 0) this.chunks.unloadFar();
  }
}
