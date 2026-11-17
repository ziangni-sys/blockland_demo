/**
 * The Simulation: owns every piece of game state and advances it one fixed tick at a time.
 * No DOM, no rendering, no wall-clock time — it runs headless in Node (tests) exactly as
 * in the browser. All state hangs off the instance; creating a new Simulation starts from
 * nothing (docs/LESSONS.md "同种子开新世界，上一局的胶还在").
 *
 * Tick order (docs/ARCHITECTURE.md, docs/LESSONS.md "每个 tick 的顺序"):
 *   1. time++, chunk housekeeping, player actions
 *   2. scheduled block ticks (liquids, falling blocks ...)
 *   3. structures move (rotors, then ship dynamics)
 *   4. carried entities follow their carriers
 *   5. entities move, collide, get pushed / crushed, attach / detach
 *   6. lighting catches up
 */
import { DAY_TICKS } from '../core/constants';
import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import { World } from '../voxel/world';
import type { VoxelGrid } from '../voxel/grid';
import { LightEngine } from '../light/engine';
import { Fluids } from '../liquid/fluids';
import { GlueStore } from '../structures/glue';
import { StructureManager } from '../structures/manager';
import { createShipDynamics } from '../structures/physics';
import { Ship, type ShipDynamics, type StructureHost } from '../structures/structure';
import { EntityManager } from '../entities/manager';
import type { Player } from '../entities/entity';
import type { EntityEvent, EntityHost } from '../entities/host';
import type { ChunkGenerator } from '../worldgen/generator';
import { BlockUpdates } from './blockupdates';
import { ChunkManager, type LoadAnchor } from './chunks';
import { explode } from './explosion';
import { Interaction } from './interact';
import { emptyView, type InteractionView, type SimEvent } from './view';

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
}

/** Lighting work per tick (cells visited) — keeps a big relight from stalling a frame. */
const LIGHT_BUDGET = 60_000;

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

  /** Things that happened, for the client. Emitted synchronously during tick(). */
  readonly events = new Emitter<SimEvent>();
  /** What the player's actions look like right now (overlays, hints). Rebuilt every tick. */
  view: InteractionView = emptyView();

  loadRadius: number;
  readonly syncChunks: boolean;

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

    const spawn = opts.spawn ?? opts.generator.spawnPoint();
    // The ground under the player must exist before the first tick.
    this.chunks.loadAround(opts.generator, spawn.x, spawn.z, 1);
    const player = this.entities.createPlayer(opts.mode, spawn.x, spawn.y, spawn.z);
    player.spawn.x = spawn.x;
    player.spawn.y = spawn.y;
    player.spawn.z = spawn.z;
    // Start in the morning.
    this.world.time = Math.floor(DAY_TICKS * 0.04);

    this.interaction = new Interaction(this);
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
    return this.player.mode === 'creative';
  }
  /** 0..1 over a day: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight. */
  get dayTime(): number {
    return (this.world.time % DAY_TICKS) / DAY_TICKS;
  }
  /** Every grid a ray or a body can touch: the world first, then every structure. */
  grids(): VoxelGrid[] {
    const out: VoxelGrid[] = [this.world];
    for (const s of this.structures.all()) out.push(s.grid);
    return out;
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
    if (ev.entity === this.player) {
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
  /** Steering read-out while the player holds a helm, else null. */
  helmView(): { throttle: number; rudder: number; speed: number; sails: number } | null {
    const id = this.player.steeringShipId;
    if (id === 0) return null;
    const ship = this.structures.get(id);
    if (!(ship instanceof Ship)) return null;
    const v = ship.grid.linearVelocity;
    return { throttle: ship.throttle, rudder: ship.rudder, speed: Math.hypot(v.x, v.z), sails: ship.sails };
  }

  // ------------------------------------------------------------------ tick

  tick(): void {
    const world = this.world;
    world.time++;

    // 1. chunk housekeeping + player actions
    this.updateChunks();
    this.interaction.tick();

    // 2. scheduled block ticks
    const due = world.ticks.takeDue(world.time);
    for (let i = 0; i < due.length; i++) {
      const t = due[i]!;
      if (world.getId(t.x, t.y, t.z) !== t.id) continue;
      if (this.fluids.handles(t.id)) this.fluids.tick(t.x, t.y, t.z, t.id);
      else this.blocks.scheduledTick(t.x, t.y, t.z, t.id);
    }

    // 3. structures
    this.structures.step();

    // 4 + 5. entities
    this.entities.syncCarried();
    this.entities.update();

    // 6. lighting
    this.light.update(LIGHT_BUDGET);

    this.view = this.interaction.buildView();
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
