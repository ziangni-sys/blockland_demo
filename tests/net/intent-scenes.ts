/**
 * Scenes of the end-to-end tests of package 7 (NETCODE section 10, intents): the island world, and
 * the play-through script run by an Actor — a person at a real HeadlessClient acting by intents
 * alone (ClientActor), or a server-driven bot of the same world acting through PlayerControl
 * (BotActor, the reference: what the game did before package 7). The script uses only what both can
 * do the same way; its world and inventory must end exactly alike.
 *
 * ISLAND: the sea of OWN_SEA (stone to y 19, water 20..29, air from 30) with a stone island
 * x -6..8, z -6..6 up to y 29 (players stand at y 30); a 3 x 3 plank deck in the water against its
 * east shore (x 9..11, z -1..1, y 29); a one-block pit at (-3, 29, -3); a glass block at (-4, 30, 2);
 * two stones to mine at (-2, 30, -2) and (-1, 30, -2);
 * a felt windmill on a bearing that faces up at (4, 31, -4) (a plus of five felt above it, four-fold
 * symmetric, so where it stops makes no difference); a blast crate at (-5, 30, 5).
 */
import { ID_MASK, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, PY, type Dir } from '../../src/core/dirs';
import { ItemEntity } from '../../src/entities/entity';
import type { NetInventory } from '../../src/net/protocol';
import type { PlayerControl } from '../../src/sim/players';
import type { Simulation } from '../../src/sim/simulation';
import { giveStarterItems } from '../../src/sim/starter';
import { Ship } from '../../src/structures/structure';
import { hashColumn } from './digest';
import { fill, loadArea } from './e2e-scenes';
import { NetHarness, testMeta, type ClientLink, type HeadlessClient } from './harness';
import { OWN_SEA, OWN_SEA_TOP, SEA_FLOOR } from './own-scenes';

/** First air above the island (and the sea). */
export const S = OWN_SEA_TOP;
/** The loaded area every comparison covers. */
export const AREA = { x0: -24, z0: -24, x1: 40, z1: 24 } as const;

/** The island world in `mode` (rules and the joining players), built before anyone joins. */
export async function islandWorld(mode: 'creative' | 'survival' = 'survival'): Promise<NetHarness> {
  const h = new NetHarness();
  await h.create(testMeta('island', mode), { generator: OWN_SEA, exampleShip: false });
  buildIsland(h.sim);
  return h;
}

export function buildIsland(sim: Simulation): void {
  loadArea(sim, AREA.x0, AREA.z0, AREA.x1, AREA.z1);
  fill(sim, -6, SEA_FLOOR, -6, 8, S - 1, 6, B.STONE);
  fill(sim, 9, S - 1, -1, 11, S - 1, 1, B.PLANKS_OAK);
  sim.world.setCell(-3, S - 1, -3, makeCell(B.AIR));
  sim.world.setCell(-4, S, 2, makeCell(B.GLASS));
  sim.world.setCell(4, S, -4, makeCell(B.STONE));
  sim.world.setCell(4, S + 1, -4, makeCell(B.BEARING, facingState(PY)));
  for (const [dx, dz] of [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    sim.world.setCell(4 + dx, S + 2, -4 + dz, makeCell(B.WOOL_WHITE));
  }
  sim.world.setCell(-5, S, 5, makeCell(B.TNT));
  // Two stones to mine, standing on the island (their drops land where the player picks them up).
  sim.world.setCell(-2, S, -2, makeCell(B.STONE));
  sim.world.setCell(-1, S, -2, makeCell(B.STONE));
}

/** What the play-through compares: every column of AREA, the world glue, the structures, the drops and the player's inventory. */
export interface Outcome {
  columns: string;
  glue: string;
  structures: string;
  drops: string;
  inventory: NetInventory;
}

export function outcome(sim: Simulation, key: string): Outcome {
  const cols: string[] = [];
  for (let cx = AREA.x0 >> 4; cx <= AREA.x1 >> 4; cx++) {
    for (let cz = AREA.z0 >> 4; cz <= AREA.z1 >> 4; cz++) {
      const ch = sim.world.getChunk(cx, cz);
      cols.push(`${cx},${cz}:${ch === undefined ? 'missing' : hashColumn(ch.layers())}`);
    }
  }
  const glue = Array.from(sim.worldGlue.toArray()).join(',');
  const structures = sim.structures
    .all()
    .map((s) => `${s.constructor.name}:${s.grid.count}`)
    .join(';');
  const drops = sim.entities
    .all()
    .filter((e): e is ItemEntity => e instanceof ItemEntity && !e.removed)
    .map((e) => `${e.stack.item}x${e.stack.count}`)
    .sort()
    .join(',');
  return { columns: cols.join(';'), glue, structures, drops, inventory: inventoryOf(sim.players.get(key)!) };
}

export function inventoryOf(ctrl: PlayerControl): NetInventory {
  const inv = ctrl.player.inventory;
  const copy = (s: { item: number; count: number } | null | undefined): { item: number; count: number } | null => (s ? { item: s.item, count: s.count } : null);
  return { selected: inv.selected, hotbar: inv.hotbar.map(copy), main: inv.main.map(copy), offhand: copy(inv.offhand), cursor: copy(inv.cursor) };
}

// ====================================================================== actors

/** One player acting in the island world; every method returns when its effect is done (see the implementations). */
export interface Actor {
  readonly label: string;
  readonly sim: Simulation;
  /** Let `ms` of game time pass. */
  wait(ms: number): void;
  /** Run until `cond` (checked every tick), at most `maxMs`. */
  until(cond: () => boolean, maxMs?: number): void;
  teleport(x: number, y: number, z: number): void;
  hold(item: number): void;
  emptyHand(): void;
  swapHands(): void;
  /** Aim at the cell (face) and right-click; throws when it cannot be aimed at. */
  useOn(x: number, y: number, z: number, face?: Dir, gridId?: number): void;
  /** Aim at the cell and hold the left button until it is gone. */
  mine(x: number, y: number, z: number, face?: Dir): void;
  /** Aim at the cell and pick its block. */
  pickBlock(x: number, y: number, z: number, face?: Dir): void;
  /** Aim at the face and hold the right button for `ms`, then let go. */
  holdUseOn(x: number, y: number, z: number, face: Dir, ms: number): void;
  sneak(on: boolean): void;
  /** Right-click (whatever is aimed at): from the wheel, sneaking, it docks. */
  click(): void;
  /** Hold the stick forward (-1..1) at every tick while `fn` returns a number; stops when it returns null. */
  drive(fn: () => number | null, maxMs?: number): void;
  /** The server's player. */
  readonly ctrl: PlayerControl;
}

/** A person at a real client: intents only (and host commands for teleporting). */
export class ClientActor implements Actor {
  readonly label: string;
  constructor(
    readonly h: NetHarness,
    readonly c: HeadlessClient,
  ) {
    this.label = `client ${c.key}`;
  }
  get sim(): Simulation {
    return this.h.sim;
  }
  get ctrl(): PlayerControl {
    return this.sim.players.get(this.c.key)!;
  }
  wait(ms: number): void {
    this.h.run(ms);
  }
  until(cond: () => boolean, maxMs = 30_000): void {
    this.h.runUntil(cond, maxMs, 5);
  }
  teleport(x: number, y: number, z: number): void {
    this.c.teleport(x, y, z);
    this.h.run(300);
  }
  hold(item: number): void {
    this.c.hold(item);
    this.c.waitAck();
  }
  emptyHand(): void {
    this.c.emptyHand();
    this.c.waitAck();
  }
  swapHands(): void {
    this.c.swapHands();
    this.c.waitAck();
  }
  useOn(x: number, y: number, z: number, face?: Dir, gridId = 0): void {
    if (!this.c.useOn(x, y, z, face, gridId)) throw new Error(`${this.label} cannot aim at ${x},${y},${z}`);
  }
  mine(x: number, y: number, z: number, face?: Dir): void {
    if (!this.c.mine(x, y, z, face)) throw new Error(`${this.label} could not mine ${x},${y},${z}`);
    this.c.waitAck();
  }
  pickBlock(x: number, y: number, z: number, face?: Dir): void {
    if (!this.c.aimAt(x, y, z, face)) throw new Error(`${this.label} cannot aim at ${x},${y},${z}`);
    this.c.waitLook();
    if (!this.c.pickBlock()) throw new Error(`${this.label}: nothing to pick`);
    this.c.waitAck();
  }
  holdUseOn(x: number, y: number, z: number, face: Dir, ms: number): void {
    if (!this.c.aimAt(x, y, z, face)) throw new Error(`${this.label} cannot aim at ${x},${y},${z}`);
    this.c.holdAim({ x, y, z, face });
    this.c.pressUse();
    this.c.waitAck();
    this.h.run(ms);
    this.c.holdAim(null);
    this.c.releaseUse();
    this.c.waitAck();
  }
  sneak(on: boolean): void {
    this.c.input.sneak = on;
    this.h.run(200);
  }
  click(): void {
    this.c.use();
    this.c.waitAck();
  }
  drive(fn: () => number | null, maxMs = 60_000): void {
    const end = this.h.net.now + maxMs;
    let t = this.sim.ticks;
    for (;;) {
      if (this.h.net.now > end) throw new Error(`${this.label}: drive did not finish`);
      const f = fn();
      if (f === null) break;
      this.c.input.forward = f;
      this.h.runUntil(() => this.sim.ticks > t, 1000, 1);
      t = this.sim.ticks;
    }
    this.c.input.forward = 0;
  }
}

/** A server-driven bot of the same world, ticked by hand (no client: the reference run). */
export class BotActor implements Actor {
  readonly label = 'server-driven bot';
  constructor(
    readonly h: NetHarness,
    readonly ctrl: PlayerControl,
  ) {}
  get sim(): Simulation {
    return this.h.sim;
  }
  private tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.h.host.tickOnce();
      this.h.host.generateChunks();
    }
  }
  wait(ms: number): void {
    this.tick(Math.round(ms / 50));
  }
  until(cond: () => boolean, maxMs = 30_000): void {
    for (let i = 0; !cond(); i++) {
      if (i * 50 > maxMs) throw new Error(`${this.label}: condition not reached`);
      this.tick();
    }
  }
  teleport(x: number, y: number, z: number): void {
    this.ctrl.teleport(x, y, z);
    this.tick(6);
  }
  hold(item: number): void {
    const inv = this.ctrl.player.inventory;
    const slot = inv.hotbar.findIndex((s) => s !== null && s.item === item);
    if (slot < 0) throw new Error(`${this.label}: no ${item} in the hotbar`);
    this.ctrl.hold(item);
    this.tick();
  }
  emptyHand(): void {
    if (!this.ctrl.player.inventory.hotbar.some((s) => s === null)) throw new Error(`${this.label}: the hotbar is full`);
    this.ctrl.emptyHand();
    this.tick();
  }
  swapHands(): void {
    this.ctrl.swapHands();
    this.tick();
  }
  useOn(x: number, y: number, z: number, face?: Dir, gridId = 0): void {
    if (!this.ctrl.aimAt(x, y, z, face, gridId)) throw new Error(`${this.label} cannot aim at ${x},${y},${z}`);
    this.ctrl.use();
    this.tick();
  }
  mine(x: number, y: number, z: number, face?: Dir): void {
    if (!this.ctrl.aimAt(x, y, z, face, 0, true)) throw new Error(`${this.label} cannot aim at ${x},${y},${z}`);
    const input = this.ctrl.player.input;
    const before = this.sim.world.getCell(x, y, z);
    this.ctrl.attack();
    input.attack = true;
    this.until(() => this.sim.world.getCell(x, y, z) !== before);
    input.attack = false;
    this.tick();
  }
  pickBlock(x: number, y: number, z: number, face?: Dir): void {
    if (!this.ctrl.aimAt(x, y, z, face, 0)) throw new Error(`${this.label} cannot aim at ${x},${y},${z}`);
    if (!this.ctrl.pickBlock()) throw new Error(`${this.label}: nothing to pick`);
    this.tick();
  }
  holdUseOn(x: number, y: number, z: number, face: Dir, ms: number): void {
    if (!this.ctrl.aimAt(x, y, z, face, 0)) throw new Error(`${this.label} cannot aim at ${x},${y},${z}`);
    const input = this.ctrl.player.input;
    this.ctrl.use();
    input.use = true;
    this.tick(Math.round(ms / 50));
    input.use = false;
    this.tick();
  }
  sneak(on: boolean): void {
    this.ctrl.player.input.sneak = on;
    this.tick();
  }
  click(): void {
    this.ctrl.use();
    this.tick();
  }
  drive(fn: () => number | null, maxMs = 60_000): void {
    for (let i = 0; ; i++) {
      if (i * 50 > maxMs) throw new Error(`${this.label}: drive did not finish`);
      const f = fn();
      if (f === null) break;
      this.ctrl.player.input.forward = f;
      this.tick();
    }
    this.ctrl.player.input.forward = 0;
  }
}

/** Every drop near the player has been picked up (or none is left within a few blocks). */
function pickedUp(a: Actor): boolean {
  const p = a.ctrl.player.pos;
  return !a.sim.entities.all().some((e) => e instanceof ItemEntity && !e.removed && Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 4);
}

/** Steps of the play-through, for the report (what each took on the client's link). */
export interface PlayLog {
  steps: Array<{ step: string; ms: number }>;
}

/**
 * The play-through (see the task: by intents alone): mine and place, fill and empty a bucket, pick
 * a block, glue a face by hand (timed, survival) and remove it, glue into the off-hand and build on
 * the raft (glass glued as it is placed, the helm), preview and assemble at the helm, steer away and
 * back to the shore, dock, start the windmill and stop it, light the blast crate, swap the glue
 * back. Returns its log; throws when a step fails.
 */
export function playThrough(a: Actor, now: () => number): PlayLog {
  const sim = a.sim;
  const log: PlayLog = { steps: [] };
  let t0 = now();
  const step = (name: string, check: boolean): void => {
    if (!check) throw new Error(`${a.label}: step "${name}" did not do what it should`);
    log.steps.push({ step: name, ms: now() - t0 });
    t0 = now();
  };
  const id = (x: number, y: number, z: number): number => sim.world.getCell(x, y, z) & ID_MASK;

  // Mine two stones in front of the feet (the cobble they drop is picked up), place two cobbles.
  a.teleport(-1.5, S, -0.5);
  a.mine(-2, S, -2, PY);
  a.until(() => pickedUp(a), 5000);
  a.mine(-1, S, -2, PY);
  a.until(() => pickedUp(a), 5000);
  step('mine two stones', id(-2, S, -2) === B.AIR && id(-1, S, -2) === B.AIR);
  a.hold(B.COBBLE);
  a.useOn(1, S - 1, -3, PY);
  a.useOn(0, S - 1, -3, PY);
  step('place two cobbles', id(0, S, -3) === B.COBBLE && id(1, S, -3) === B.COBBLE);

  // Empty the bucket into the pit and fill it again.
  a.teleport(-2.5, S, -1.5);
  a.hold(I.BUCKET_WATER);
  a.useOn(-3, S - 2, -3, PY);
  step('empty the bucket into the pit', id(-3, S - 1, -3) === B.WATER && a.ctrl.player.inventory.selectedStack()?.item === I.BUCKET);
  a.useOn(-3, S - 1, -3, PY);
  step('fill the bucket', id(-3, S - 1, -3) === B.AIR && a.ctrl.player.inventory.selectedStack()?.item === I.BUCKET_WATER);

  // Pick the glass block: it is only in the backpack (survival swaps it into the selected slot).
  a.pickBlock(-4, S, 2, PY);
  step('pick block', a.ctrl.player.inventory.selectedStack()?.item === B.GLASS);

  // Glue a face by hand (timed: the stone's mining time) and remove it (sneaking).
  a.hold(I.GLUE);
  a.holdUseOn(-2, S - 1, 0, PY, 2200);
  step('glue a face by hand (timed)', sim.worldGlue.has(-2, S - 1, 0, PY));
  a.sneak(true);
  a.useOn(-2, S - 1, 0, PY);
  a.sneak(false);
  step('remove the glue', !sim.worldGlue.has(-2, S - 1, 0, PY));

  // Glue into the off-hand; build on the raft: the helm, two glass blocks glued as they are placed.
  a.teleport(7.6, S, 0.5);
  a.hold(I.GLUE);
  a.swapHands();
  step('glue into the off-hand', a.ctrl.player.inventory.offhand?.item === I.GLUE);
  a.hold(B.HELM);
  a.useOn(10, S - 1, 0, PY);
  a.hold(B.GLASS);
  a.useOn(11, S - 1, -1, PY);
  a.useOn(11, S - 1, 1, PY);
  step(
    'build on the raft (glass glued by the off-hand)',
    id(10, S, 0) === B.HELM && id(11, S, -1) === B.GLASS && id(11, S, 1) === B.GLASS && sim.worldGlue.has(11, S - 1, -1, PY) && sim.worldGlue.has(11, S - 1, 1, PY),
  );

  // Preview and assemble at the helm (empty hand), steer away and back to the shore, dock.
  a.emptyHand();
  a.useOn(10, S, 0, NX);
  step('preview at the helm', a.ctrl.view.preview?.kind === 'ship');
  a.useOn(10, S, 0, NX);
  const ship = sim.structures.ships()[0];
  step('assemble (and take the wheel)', ship instanceof Ship && ship.grid.count === 12 && a.ctrl.player.steeringShipId === ship.id);
  const start = ship!.grid.position.x;
  let phase = 0;
  let still = 0;
  a.drive(() => {
    const s = ship!;
    const d = s.grid.position.x - start;
    const v = s.grid.linearVelocity.x;
    if (phase === 0) {
      if (d < 4) return 1;
      phase = 1;
    }
    if (phase === 1) {
      if (d > 1.5) return -1;
      phase = 2;
    }
    // Slowly back against the shore, until it lies still there.
    still = Math.abs(v) < 0.02 && d < 0.3 ? still + 1 : 0;
    return still >= 10 ? null : -0.4;
  });
  a.wait(500);
  step('steer away and back to the shore', Math.abs(ship!.grid.position.x - start) < 0.3);
  a.sneak(true);
  a.click();
  a.sneak(false);
  step('dock', ship!.removed && id(9, S - 1, 0) === B.PLANKS_OAK && id(10, S, 0) === B.HELM && sim.worldGlue.has(11, S - 1, 1, PY));

  // Start the windmill and stop it.
  a.teleport(1.5, S, -3.5);
  a.useOn(4, S + 1, -4, NX);
  step('preview the windmill', a.ctrl.view.preview?.kind === 'rotor');
  a.useOn(4, S + 1, -4, NX);
  step('start the windmill', sim.structures.rotors().length === 1);
  a.wait(1500);
  a.useOn(4, S + 1, -4, NX);
  step('stop the windmill', sim.structures.rotors().length === 0 && id(4, S + 2, -4) === B.WOOL_WHITE);

  // Light the blast crate with an empty hand, walk away (teleport), let it go off.
  a.teleport(-2.5, S, 2.5);
  a.useOn(-5, S, 5, PY);
  step('light the blast crate', id(-5, S, 5) === B.AIR && sim.entities.all().some((e) => e.kind === 'tnt' && !e.removed));
  let blasts = 0;
  const off = sim.events.on((e) => {
    if (e.type === 'explosion') blasts++;
  });
  a.teleport(6.5, S, -5.5);
  a.until(() => !sim.entities.all().some((e) => e.kind === 'tnt' && !e.removed), 10_000);
  a.wait(3000);
  off();
  step('the blast', blasts === 1);

  // The glue back into the main hand.
  a.emptyHand();
  a.swapHands();
  step('glue back into the main hand', a.ctrl.player.inventory.offhand === null && a.ctrl.player.inventory.selectedStack()?.item === I.GLUE);
  return log;
}

/** The reference: the same world, a server-driven bot runs the play-through. */
export async function referencePlay(): Promise<Outcome> {
  const h = await islandWorld('survival');
  const ctrl = h.sim.join('p');
  giveStarterItems(ctrl);
  ctrl.giveItem(B.GLASS, 5);
  const bot = new BotActor(h, ctrl);
  bot.wait(200);
  playThrough(bot, () => h.sim.ticks * 50);
  bot.wait(2000);
  return outcome(h.sim, 'p');
}

/** A client on `link` runs the play-through by intents; returns the outcome and the run. */
export async function clientPlay(link: ClientLink): Promise<{ out: Outcome; h: NetHarness; c: HeadlessClient; log: PlayLog }> {
  const h = await islandWorld('survival');
  const c = h.addClient('p', link, { local: true, viewRadius: 3 });
  h.runUntil(() => c.ready && c.own !== null && c.intents !== null, 60_000);
  h.sim.players.get('p')!.giveItem(B.GLASS, 5);
  h.run(300);
  const a = new ClientActor(h, c);
  const log = playThrough(a, () => h.net.now);
  h.run(2000);
  h.quiesce();
  return { out: outcome(h.sim, 'p'), h, c, log };
}
