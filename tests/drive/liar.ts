/**
 * A client-driven player whose client makes its move reports up (no mover of its own, as in
 * checks.test.ts ScriptedClient): what the server's checks (entities/drive.ts) let a dishonest
 * client get away with. Used by the cheat tests of docs/SHAPES.md 5.8 (stairs-cheats.test.ts) and
 * of the standing claim (wall-cheats.test.ts).
 */
import { emptyReport, type MoveReport } from '../../src/entities/drive';
import { hurts, LAND_TOP, landRun, type Run } from './scenes';

export class Liar {
  seq = 0;
  epoch: number;
  landings = 0;
  /** Reports go in this carrier's frame (0: the world). */
  carrierId = 0;
  /** Ticks the client's copies of the ships lag the server by, as its reports claim (viewTick): the lag the checks allow for (drive.ts LAG). */
  viewLag = 2;
  private wasOnGround = true;
  readonly causes: string[] = [];
  constructor(readonly run: Run) {
    const c = run.sim.soloPlayer;
    c.setDrive('client');
    const first = c.takeCorrection();
    if (first === null) throw new Error('no drive correction');
    this.epoch = first.epoch;
    this.carrierId = first.carrierId;
  }
  get player() {
    return this.run.sim.soloPlayer.player;
  }
  get rejected(): number {
    return this.player.remote!.rejected;
  }
  get accepted(): number {
    return this.player.remote!.accepted;
  }
  /** Damage the player took so far. */
  get damage(): number {
    return hurts(this.run).reduce((a, e) => a + e.amount, 0);
  }
  private make(x: number, y: number, z: number, onGround: boolean, seqStep: number, vy: number): MoveReport {
    const r = emptyReport();
    this.seq += seqStep;
    r.seq = this.seq;
    r.epoch = this.epoch;
    r.carrierId = this.carrierId;
    r.pos.x = x;
    r.pos.y = y;
    r.pos.z = z;
    r.vel.y = vy;
    r.onGround = onGround;
    r.viewTick = this.run.sim.ticks - this.viewLag;
    if (onGround && !this.wasOnGround) this.landings = (this.landings + 1) & 255;
    this.wasOnGround = onGround;
    r.landings = this.landings;
    return r;
  }
  tick(): void {
    this.run.sim.tick();
    const c = this.run.sim.soloPlayer.takeCorrection();
    if (c !== null) {
      this.epoch = c.epoch;
      this.causes.push(c.cause);
    }
  }
  /** Send one report (seq gap `seqStep`) and let the server tick; true when the server accepted it. */
  send(x: number, y: number, z: number, onGround = true, seqStep = 1, vy = 0): boolean {
    const a0 = this.accepted;
    this.run.sim.soloPlayer.submitReport(this.make(x, y, z, onGround, seqStep, vy));
    this.tick();
    return this.accepted > a0;
  }
  /** Let the server's clock run (movement credit refills) without reports. */
  wait(n: number): void {
    for (let i = 0; i < n; i++) this.tick();
  }
}

/** A flat-land run with `build` applied, the liar standing at (x, LAND_TOP, z) (one report sent: the envelope is held there). */
export function liar(x: number, z: number, build: (run: Run) => void): Liar {
  const run = landRun('survival', { x, y: LAND_TOP, z }, null);
  build(run);
  run.sim.advance(5);
  const l = new Liar(run);
  l.send(x, LAND_TOP, z);
  return l;
}
