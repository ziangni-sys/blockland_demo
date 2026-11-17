/**
 * The Simulation: owns every piece of game state and advances it one fixed tick at a time.
 * No DOM, no rendering, no wall-clock time — it runs headless in Node (tests) exactly as
 * in the browser. All state hangs off the instance; creating a new Simulation starts from
 * nothing (docs/LESSONS.md "同种子开新世界，上一局的胶还在").
 *
 * Tick order (docs/ARCHITECTURE.md, docs/LESSONS.md "每个 tick 的顺序"):
 *   0. time++, entity snapshot (prev* for render interpolation), chunk housekeeping
 *   1. player actions (swap hands, place, mine, use, glue, assemble, steer)
 *   2. scheduled block ticks (liquids, falling blocks ...)
 *   3. structures move (rotors, then ship dynamics)
 *   4. carried entities follow their carriers
 *   5. entities move, collide, get pushed / crushed, attach / detach (blast crates explode here)
 *   6. ambient rabbits
 *   7. lighting catches up; every joined player's InteractionView is rebuilt
 * Block updates (falling sand, popping torches) queued by any phase run right after it.
 *
 * PLAYERS. The simulation starts with no players and knows no "local" one: join(key) /
 * leave(key) and the per-player PlayerControl (sim/players.ts) — its entity, view, helm read-out
 * and the scripted controls (look, click, hold, give, teleport, mode, respawn ...). Everything
 * that runs per player runs for every joined player in ascending entity id order. What is decided
 * per world lives in `rules` (sim/rules.ts); nothing reads some player's mode to decide a world
 * effect.
 */
import { DAY_TICKS, ROTOR_MAX_CELLS, ROTOR_MIN_SAILS, SHIP_MAX_CELLS, STRUCTURE_MAX_BOX_CELLS } from '../core/constants';
import { Emitter } from '../core/events';
import { mod } from '../core/math';
import { Rng } from '../core/rng';
import { World } from '../voxel/world';
import type { VoxelGrid } from '../voxel/grid';
import { LightEngine } from '../light/engine';
import { Fluids } from '../liquid/fluids';
import { GlueStore } from '../structures/glue';
import { StructureManager } from '../structures/manager';
import { createShipDynamics } from '../structures/physics';
import type { ShipDynamics, Structure, StructureHost } from '../structures/structure';
import { EntityManager } from '../entities/manager';
import { ItemEntity, Player, type GameMode } from '../entities/entity';
import type { EntityEvent, EntityHost } from '../entities/host';
import type { ChunkGenerator } from '../worldgen/generator';
import { BlockUpdates } from './blockupdates';
import { ChunkManager, type LoadAnchor } from './chunks';
import { explode } from './explosion';
import { Interaction } from './interact';
import { MAX_VIEW_RADIUS, PlayerRegistry, type PlayerControl } from './players';
import { RabbitSpawner } from './rabbits';
import { worldRulesFor, type WorldRules } from './rules';
import type { PlayerKey, SimEvent } from './view';

export type { GameMode } from '../entities/entity';

export interface SimOptions {
  /** 32-bit world seed. */
  seed: number;
  /** The mode the world is created in: its rules (worldRulesFor). A save brings its own. */
  mode: GameMode;
  generator: ChunkGenerator;
  /** Chunk radius kept loaded around a player who joins (default 8; capped at MAX_VIEW_RADIUS). */
  loadRadius?: number;
  /**
   * Generate missing chunks synchronously inside tick() (headless tests, tools).
   * In the browser this is false: the client pulls `chunks.wanted()` and feeds
   * `chunks.provide()` from worker threads.
   */
  syncChunks?: boolean;
  /** Where new players start (the world spawn); defaults to generator.spawnPoint(). Not saved. */
  spawn?: { x: number; y: number; z: number };
  /** Ambient rabbits by day (default true). Tests that count entities turn them off. */
  rabbits?: boolean;
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
  /** Who is in the world (sim/players.ts). */
  readonly players: PlayerRegistry;
  /** What is decided per world (sim/rules.ts). Saved. */
  readonly rules: WorldRules;
  /** Where new players appear (feet). */
  readonly spawnPoint: { readonly x: number; readonly y: number; readonly z: number };
  /** View radius (chunks) a player starts with when it joins. */
  readonly defaultViewRadius: number;

  /** Things that happened, for the clients. Emitted synchronously during tick() (and join / leave). */
  readonly events = new Emitter<SimEvent>();

  readonly syncChunks: boolean;

  /** Assembly limits, for messages (docs/DESIGN.md). */
  readonly shipMaxCells = SHIP_MAX_CELLS;
  readonly rotorMaxCells = ROTOR_MAX_CELLS;
  readonly rotorMinSails = ROTOR_MIN_SAILS;
  readonly structureMaxBoxCells = STRUCTURE_MAX_BOX_CELLS;

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
    this.defaultViewRadius = Math.max(0, Math.min(MAX_VIEW_RADIUS, Math.floor(opts.loadRadius ?? 8)));
    this.rules = worldRulesFor(opts.mode);
    const spawn = opts.spawn ?? opts.generator.spawnPoint();
    this.spawnPoint = Object.freeze({ x: spawn.x, y: spawn.y, z: spawn.z });
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
    this.players = new PlayerRegistry(this);
    this.rabbits = new RabbitSpawner(this, opts.rabbits ?? true);
    // The one sim-level world hook (block updates, washed-away drops, preview staleness). It is
    // registered after the light, liquid and structure hooks, so it sees each change last.
    this.unsubWorld = this.world.onCellChange((x, y, z, oldCell, newCell, flags) => {
      this.interaction.onWorldChange(x, y, z, oldCell, newCell, flags);
      this.blocks.onWorldChange(x, y, z, oldCell, newCell, flags);
    });

    // Start in the morning. The clock must be set BEFORE any chunk is loaded: loading
    // schedules liquid ticks relative to world.time. No chunk is loaded yet: join() loads the
    // ground under each player.
    this.world.time = Math.floor(DAY_TICKS * START_DAY_TIME);
  }

  /**
   * Host command: replace the world's rules (sim/rules.ts). Takes effect from the next world
   * effect on; players keep their own modes.
   */
  setRules(rules: WorldRules): void {
    this.rules.defaultMode = rules.defaultMode;
    this.rules.dropsEnabled = rules.dropsEnabled;
  }

  // ------------------------------------------------------------------ queries

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
      get dropsEnabled(): boolean {
        return sim.rules.dropsEnabled;
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
      get harmsCreatures(): boolean {
        return sim.rules.defaultMode === 'survival';
      },
      structures: () => sim.structures.all(),
      structure: (id) => sim.structures.get(id),
      explode: (x, y, z, power, source) => explode(sim, x, y, z, power, source),
      emit: (ev) => sim.onEntityEvent(ev),
    };
  }

  /** Entity events that concern a joined player become events addressed to that player. */
  private onEntityEvent(ev: EntityEvent): void {
    if (ev.type === 'pickup') {
      const taker = ev.player !== undefined ? this.players.controlOf(ev.player) : undefined;
      if (taker !== undefined && ev.entity instanceof ItemEntity) {
        this.events.emit({ type: 'playerPickup', player: taker.key, item: ev.entity.stack.item, count: ev.amount ?? 0 });
      }
    } else if (ev.entity instanceof Player) {
      const c = this.players.controlOf(ev.entity);
      if (c !== undefined) {
        if (ev.type === 'hurt') this.events.emit({ type: 'playerHurt', player: c.key, amount: ev.amount ?? 0, cause: ev.cause ?? '' });
        else if (ev.type === 'death') this.events.emit({ type: 'playerDied', player: c.key, cause: ev.cause ?? '' });
        else if (ev.type === 'helmReleased') this.events.emit({ type: 'helmReleased', player: c.key, cause: ev.cause ?? '' });
      }
    }
    this.interaction.onEntityEvent(ev);
  }

  // ------------------------------------------------------------------ players

  /** Bring player `key` into the world (restored from its record, or new). See sim/players.ts. */
  join(key: PlayerKey): PlayerControl {
    return this.players.join(key);
  }
  /** Take player `key` out of the world, keeping its record. See sim/players.ts. */
  leave(key: PlayerKey): void {
    this.players.leave(key);
  }

  /**
   * SINGLE-PLAYER TESTS AND TOOLS ONLY: the control of the one joined player. Throws unless
   * exactly one player has joined. Simulation code never uses it — everything there handles any
   * number of players (a test under tests/sim fails if src/ uses it).
   */
  get soloPlayer(): PlayerControl {
    const online = this.players.online();
    if (online.length !== 1) throw new Error(`soloPlayer: ${online.length} players have joined, not exactly one`);
    return online[0]!;
  }

  /** Set the time of day (0..1, 0 = sunrise) without disturbing the world clock. */
  setDayTime(t: number): void {
    if (!Number.isFinite(t)) return;
    const target = Math.round(mod(t, 1) * DAY_TICKS);
    this.dayOffset = mod(target - this.world.time, DAY_TICKS);
  }

  /** Run `ticks` ticks. */
  advance(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.tick();
  }

  // ------------------------------------------------------------------ tick

  tick(): void {
    // Records of players who did not join a just-loaded world let go of wheels and carriers.
    this.players.settleAfterLoad();
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
    this.interaction.buildViews();
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
  }

  /** Unsubscribe every hook this simulation installed on shared objects. */
  dispose(): void {
    this.unsubWorld();
    for (const off of this.structureHooks.values()) off();
    this.structureHooks.clear();
    this.structures.dispose();
    this.events.clear();
  }

  /** Chunks stay loaded around every joined player (its own view radius, capped at MAX_VIEW_RADIUS) and every ship. */
  private updateChunks(): void {
    const anchors: LoadAnchor[] = [];
    for (const c of this.players.online()) {
      const p = c.player;
      anchors.push({ x: p.pos.x, z: p.pos.z, radius: c.viewRadius });
    }
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
