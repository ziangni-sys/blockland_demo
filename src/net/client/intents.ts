/**
 * The client's side of the intents (docs/NETCODE.md section 10): ClientIntents.
 *
 * TARGETS. The client chooses what the player aims at itself, on its replica, with the rays the
 * server uses (sim/rays.ts): the use ray of the held item and the mining ray (always plain), every
 * grid at the pose it is shown at (ClientReplica.setPoses), ships with their hulls. The embedding
 * code passes the ray in (ViewRay): in first person the eye ray (origin = the eyes); in the
 * third-person views the camera ray, of which only a hit within REACH of the eyes counts (what the
 * server would refuse is never outlined: everything the outline shows can be acted on). The eyes
 * are the player's feet as shown (OwnPlayer.displayPos) plus the eye height. The outline is drawn
 * from useTarget at once, without waiting for the server.
 *
 * AIM. When a target changes (any field, the cell value and the octant included: a block replaced
 * under the crosshair, or the crosshair moving from one octant of a cell to another, is a new
 * target; docs/SHAPES.md 6.3), the client sends Aim — at most one per client tick (the latest
 * targets go in the next tick's) — on the reliable channel, so it keeps its order with the presses
 * and releases: the timed glue, hold-to-mine, the preview and the hint follow it on the server.
 *
 * INTENTS. Every intent of section 10's table, all with one increasing seq (from 1, per
 * connection). The ones with a target carry moveSeq, the seq of the last movement report sent
 * (OwnPlayer.lastSeq): the server takes the eyes of that report, once it accepted it, to check the
 * reach (else those of the newest it accepted, with more allowance). A press (Use,
 * Attack, PickBlock) recomputes the targets with the held item of its moment first, from the last
 * view ray. Placing, mining and the rest of what changes the world wait for the server (section 17
 * item 4); inventory actions are predicted (InventoryPredictor: `inventory`).
 *
 * DRIVING (package 9, tests/net/harness.ts HeadlessClient): one ClientIntents per connection, once
 * the player is predicted (NetClient ready); onBatch() after every applied batch; update(view,
 * clientTick, moveSeq) every frame after OwnPlayer.frame; the press / action methods from input.
 */
import { partAt } from '../../blocks/shapes';
import { vec3, type Vec3 } from '../../core/math';
import { pickBlockItem } from '../../entities/inventory';
import type { Inventory } from '../../entities/inventory';
import { REACH, castRay, rayKindOf, type RayKind, type RayScene } from '../../sim/rays';
import { Ship } from '../../structures/structure';
import type { VoxelGrid } from '../../voxel/grid';
import type { GridHit } from '../../voxel/raycast';
import type { ClientMessage, HostCommand, InventoryArea, Target } from '../protocol';
import { InventoryPredictor, type InventoryAction } from './inventory';
import type { ClientReplica } from './replica';

/** The ray the targets are chosen along (world space). */
export interface ViewRay {
  /** The player's eyes as shown. */
  readonly eye: Vec3;
  /** Where the ray starts: the eyes (first person) or the camera (third person). */
  readonly origin: Vec3;
  /** Unit direction. */
  readonly dir: Vec3;
}

/** The targets chosen for a view: the use ray's and the mining ray's. */
export interface Targets {
  use: Target | null;
  mine: Target | null;
}

/** Origins closer than this to the eyes count as the eye ray (first person). */
const SAME_ORIGIN = 1e-9;

/** Every grid and ship of the replica, at the poses they are shown at, for the rays. */
export function replicaScene(replica: ClientReplica): RayScene {
  const structures = replica.structures();
  const grids: VoxelGrid[] = [replica.world];
  const ships: Ship[] = [];
  for (const s of structures) {
    grids.push(s.grid);
    if (s instanceof Ship) ships.push(s);
  }
  return { grids, ships };
}

/** A hit as the protocol's Target: `sub` is the octant hit, `cell` the whole cell content seen (docs/SHAPES.md 6.3). */
function targetOf(h: GridHit | null): Target | null {
  return h === null ? null : { gridId: h.grid.gridId, x: h.x, y: h.y, z: h.z, face: h.face, sub: h.octant, cell: h.cell };
}

/** Ray `kind` along `view` within REACH of the eyes (see TARGETS in the header). */
export function chooseTarget(scene: RayScene, kind: RayKind, view: ViewRay): Target | null {
  const o = view.origin;
  const e = view.eye;
  const away = Math.hypot(o.x - e.x, o.y - e.y, o.z - e.z);
  if (away <= SAME_ORIGIN) return targetOf(castRay(scene, e, view.dir, kind));
  const h = castRay(scene, o, view.dir, kind, away + REACH);
  if (h === null) return null;
  const p = h.point;
  return Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z) <= REACH ? targetOf(h) : null;
}

/** Both targets for the held item `held` (-1 = empty hand). */
export function chooseTargets(replica: ClientReplica, held: number, view: ViewRay): Targets {
  const scene = replicaScene(replica);
  const kind = rayKindOf(held);
  const use = chooseTarget(scene, kind, view);
  const mine = kind === 'plain' ? use : chooseTarget(scene, 'plain', view);
  return { use, mine };
}

/** Same target (every field: section 10). */
export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (a === null || b === null) return a === b;
  return a.gridId === b.gridId && a.x === b.x && a.y === b.y && a.z === b.z && a.face === b.face && a.sub === b.sub && a.cell === b.cell;
}

export class ClientIntents {
  /** Inventory prediction: `inventory.inventory` is what the player's inventory shows. */
  readonly inventory = new InventoryPredictor();
  /** Seq of the last intent sent (0 before the first). */
  seq = 0;
  /** The targets of the last update or press: the outline (use) and what a left-click mines. */
  useTarget: Target | null = null;
  mineTarget: Target | null = null;
  /** The buttons are down (a press was sent, its release not yet). */
  useHeld = false;
  attackHeld = false;
  /** Aims sent so far. */
  aims = 0;

  private sentUse: Target | null = null;
  private sentMine: Target | null = null;
  private aimTick = NaN;
  private lastView: { eye: Vec3; origin: Vec3; dir: Vec3 } | null = null;

  constructor(
    readonly replica: ClientReplica,
    private readonly sendMessage: (m: ClientMessage) => void,
  ) {
    this.onBatch();
  }

  // ------------------------------------------------------------------ state

  /** The inventory as shown (the server's with the unacknowledged actions replayed), or null before the server's first. */
  get shownInventory(): Inventory | null {
    return this.inventory.inventory;
  }

  /** The item in the selected hotbar slot as shown, -1 for an empty hand. */
  get heldItem(): number {
    const inv = this.inventory.inventory;
    const s = inv?.selectedStack() ?? null;
    return s !== null && s.count > 0 ? s.item : -1;
  }

  /** The selected hotbar slot as shown. */
  get selected(): number {
    return this.inventory.inventory?.selected ?? 0;
  }

  /** The server has processed every intent sent (its ack has reached the replica). */
  get settled(): boolean {
    return (this.inventory.ack ?? 0) >= this.seq;
  }

  private get creative(): boolean {
    const st = this.replica.state;
    return (st.private.vitals?.mode ?? st.rules.defaultMode) === 'creative';
  }

  // ------------------------------------------------------------------ driving

  /** After every batch applied to the replica: the server's inventory and ack reach the predictor. */
  onBatch(): void {
    const pr = this.replica.state.private;
    this.inventory.update(pr.inventory, pr.ack, this.creative);
  }

  /**
   * Every frame (after OwnPlayer.frame): the targets for `view` (copied), and an Aim when they
   * changed since the last one sent, unless one went in this client tick already (`clientTick`:
   * OwnPlayer.tick). `moveSeq`: the last movement report sent.
   */
  update(view: ViewRay, clientTick: number, moveSeq: number): void {
    const v = this.lastView ?? { eye: vec3(), origin: vec3(), dir: vec3() };
    copy3(v.eye, view.eye);
    copy3(v.origin, view.origin);
    copy3(v.dir, view.dir);
    this.lastView = v;
    this.retarget();
    if (sameTarget(this.useTarget, this.sentUse) && sameTarget(this.mineTarget, this.sentMine)) return;
    if (clientTick === this.aimTick) return;
    this.aimTick = clientTick;
    this.sentUse = this.useTarget;
    this.sentMine = this.mineTarget;
    this.aims++;
    this.send({ type: 'aim', seq: ++this.seq, moveSeq, use: this.useTarget, mine: this.mineTarget });
  }

  // ------------------------------------------------------------------ presses and releases

  /** Right button down: Use with the use target, the selected slot and the sneak key (slab mode 0: M2.3 has no slabs to place). */
  pressUse(sneak: boolean, moveSeq: number): void {
    this.retarget();
    this.useHeld = true;
    // The press's target is the server's claimed use target from then on.
    this.sentUse = this.useTarget;
    this.send({ type: 'use', seq: ++this.seq, moveSeq, slot: this.selected, sneak, slabMode: 0, target: this.useTarget });
  }

  releaseUse(): void {
    this.useHeld = false;
    this.send({ type: 'useRelease', seq: ++this.seq });
  }

  /** Left button down: Attack with the mining target and the selected slot. */
  pressAttack(moveSeq: number): void {
    this.retarget();
    this.attackHeld = true;
    this.sentMine = this.mineTarget;
    this.send({ type: 'attack', seq: ++this.seq, moveSeq, slot: this.selected, target: this.mineTarget });
  }

  releaseAttack(): void {
    this.attackHeld = false;
    this.send({ type: 'attackRelease', seq: ++this.seq });
  }

  // ------------------------------------------------------------------ inventory actions (predicted)

  /** Swap the selected hotbar stack with the off-hand (F). */
  swapHands(): void {
    this.predicted({ type: 'swapHands', seq: ++this.seq }, { kind: 'swapHands' });
  }

  selectSlot(slot: number): void {
    this.predicted({ type: 'selectSlot', seq: ++this.seq, slot }, { kind: 'selectSlot', slot });
  }

  /** Pick block (middle click) on the use target, predicted with the part aimed at (docs/SHAPES.md 6.2); false (nothing sent) without one. */
  pickBlock(moveSeq: number): boolean {
    this.retarget();
    const t = this.useTarget;
    if (t === null) return false;
    this.predicted({ type: 'pickBlock', seq: ++this.seq, moveSeq, target: t }, { kind: 'pickBlock', item: pickBlockItem(partAt(t.cell, t.sub)) });
    return true;
  }

  invClick(area: InventoryArea, index: number, button: 0 | 2, shift: boolean): void {
    this.predicted({ type: 'invClick', seq: ++this.seq, area, index, button, shift }, { kind: 'invClick', area, index, button, shift });
  }

  creativePick(item: number, shift: boolean): void {
    this.predicted({ type: 'creativePick', seq: ++this.seq, item, shift }, { kind: 'creativePick', item, shift });
  }

  /** Throw the cursor stack (the cursor empties at once; the drop appears when the server says so). */
  dropCursor(): void {
    this.predicted({ type: 'dropCursor', seq: ++this.seq }, { kind: 'dropCursor' });
  }

  /** The inventory screen closes: the cursor stack goes back into the inventory. */
  closeInventory(): void {
    this.predicted({ type: 'closeInventory', seq: ++this.seq }, { kind: 'closeInventory' });
  }

  // ------------------------------------------------------------------ commands (the server answers)

  /** Let go of the helm (sent when a screen opens while steering: scenario 21). */
  releaseHelm(): void {
    this.send({ type: 'releaseHelm', seq: ++this.seq });
  }

  respawn(): void {
    this.send({ type: 'respawn', seq: ++this.seq });
  }

  /** The subscription radius (the embedding code sets NetClient.viewRadius too: the next Hello, a reload's ready zone). */
  setViewRadius(radius: number): void {
    this.send({ type: 'setViewRadius', seq: ++this.seq, radius });
  }

  hostCommand(command: HostCommand): void {
    this.send({ type: 'hostCommand', seq: ++this.seq, command });
  }

  // ------------------------------------------------------------------ internals

  private predicted(m: ClientMessage, action: InventoryAction): void {
    this.send(m);
    this.inventory.predict(this.seq, action);
  }

  private send(m: ClientMessage): void {
    this.sendMessage(m);
  }

  /** The targets from the last view ray, with the held item as shown now. */
  private retarget(): void {
    const v = this.lastView;
    if (v === null) return;
    const t = chooseTargets(this.replica, this.heldItem, v);
    this.useTarget = t.use;
    this.mineTarget = t.mine;
  }
}

function copy3(out: Vec3, v: Readonly<Vec3>): void {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
}
