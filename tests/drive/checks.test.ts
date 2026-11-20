/**
 * The server's checks of move reports, driven by a scripted client that sends reports it made up
 * (no mover of its own): what no honest client can produce is refused, and what the server keeps
 * on the reported track (falls, the vertical envelope, movement time) holds however the reports
 * are bunched.
 */
import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../../src/core/constants';
import { FALL_SAFE_HEIGHT, GRAVITY, JUMP_SPEED, PLAYER_MAX_HEALTH, REPORT_CREDIT_TICKS, REPORT_DEBT_TICKS, REPORT_STALL_TICKS, SPRINT_SPEED } from '../../src/entities/constants';
import { emptyReport, type Correction, type MoveReport } from '../../src/entities/drive';
import { NZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { Liar } from './liar';
import { assemble, B, facingState, LAND_TOP, fill, hurts, landRun, makeCell, SEA_TOP, seaRun, type Run } from './scenes';

const T = LAND_TOP;

interface ReportOpts {
  onGround?: boolean;
  flying?: boolean;
  /** Seq numbers skipped before this report (1 = the next tick). */
  seqStep?: number;
  vy?: number;
  /** Ticks the client's view lags the server's present tick (viewTick = ticks - viewLag; default 2). */
  viewLag?: number;
  /** Landings counted so far (default: the client's own count, see ScriptedClient.landings). */
  landings?: number;
}

/** A client that makes its reports up. Reports queue until tick(); corrections are adopted (their epoch) after each tick. */
class ScriptedClient {
  seq = 0;
  epoch: number;
  /** Landings so far, as an honest client counts them: a report on the ground after one that was not. */
  landings = 0;
  private wasOnGround = true;
  readonly causes: string[] = [];
  last: Correction | null = null;
  constructor(readonly run: Run) {
    const c = run.sim.soloPlayer;
    c.setDrive('client');
    const first = c.takeCorrection();
    if (first === null) throw new Error('no drive correction');
    this.epoch = first.epoch;
    this.last = first;
  }
  get player() {
    return this.run.sim.soloPlayer.player;
  }
  get rejected(): number {
    return this.player.remote!.rejected;
  }
  /** The next report (seq, epoch, landings counted). */
  private make(x: number, y: number, z: number, o: ReportOpts): MoveReport {
    const r = emptyReport();
    this.seq += o.seqStep ?? 1;
    r.seq = this.seq;
    r.epoch = this.epoch;
    r.pos.x = x;
    r.pos.y = y;
    r.pos.z = z;
    r.vel.y = o.vy ?? 0;
    r.onGround = o.onGround ?? true;
    r.flying = o.flying ?? false;
    r.viewTick = this.run.sim.ticks - (o.viewLag ?? 2);
    if (r.onGround && !this.wasOnGround) this.landings = (this.landings + 1) & 255;
    this.wasOnGround = r.onGround;
    r.landings = o.landings ?? this.landings;
    return r;
  }
  report(x: number, y: number, z: number, o: ReportOpts = {}): void {
    this.run.sim.soloPlayer.submitReport(this.make(x, y, z, o));
  }
  /** The report this client would send, lost on the way. */
  lose(x: number, y: number, z: number, o: ReportOpts = {}): void {
    this.make(x, y, z, o);
  }
  tick(): void {
    this.run.sim.tick();
    const c = this.run.sim.soloPlayer.takeCorrection();
    if (c !== null) {
      this.epoch = c.epoch;
      this.causes.push(c.cause);
      this.last = c;
    }
  }
  send(x: number, y: number, z: number, o: ReportOpts = {}): void {
    this.report(x, y, z, o);
    this.tick();
  }
}

/** A flat-land run whose player is driven by a scripted client; `build` adds blocks first. */
function scripted(x: number, z: number, build?: (run: Run) => void, y = T): { run: Run; c: ScriptedClient } {
  const run = landRun('survival', { x, y, z }, null);
  build?.(run);
  run.sim.advance(5);
  return { run, c: new ScriptedClient(run) };
}

/** Heights of a jump from the ground at T with take-off speed `vy`, one per tick, down to T again (the motion model's gravity step). */
function jumpArc(vy: number): number[] {
  const out: number[] = [];
  let y = T;
  let v = vy;
  do {
    const v1 = v - GRAVITY * TICK_DT;
    y = Math.max(T, y + (v + v1) * 0.5 * TICK_DT);
    v = v1;
    out.push(y);
  } while (y > T);
  return out;
}

/** Heights of an honest fall from `y0` (from rest) down to `floor`, one per tick (the motion model's gravity step). */
function fallTrack(y0: number, floor: number): number[] {
  const out: number[] = [];
  let y = y0;
  let v = 0;
  while (y > floor) {
    const v1 = v - GRAVITY * TICK_DT;
    y = Math.max(floor, y + (v + v1) * 0.5 * TICK_DT);
    v = v1;
    out.push(y);
  }
  return out;
}

// ====================================================================== falls (finding: bunched landing)

describe('fall damage on the reported track, however the reports are bunched', () => {
  /** Teleport 12 blocks up, then report the fall; `bunch(i, n)` = how many reports go in the tick that ends with report i (of n). */
  function fall(mode: 'single' | 'landing+standing' | 'five-in-one'): { damage: number; rejected: number; causes: string[] } {
    const { run, c } = scripted(0.5, 0.5);
    run.sim.soloPlayer.teleport(0.5, T + 12, 0.5);
    c.tick();
    const track = fallTrack(T + 12, T);
    const n = track.length;
    for (let i = 0; i < n; i++) {
      const landed = i === n - 1;
      c.report(0.5, track[i]!, 0.5, { onGround: landed, vy: landed ? 0 : -10 });
      if (mode === 'single') c.tick();
      else if (mode === 'landing+standing') {
        if (landed) {
          // The landing and two standing reports arrive together.
          c.report(0.5, T, 0.5);
          c.report(0.5, T, 0.5);
        }
        c.tick();
      } else if (i >= n - 5) {
        // The last five reports (the landing among them) arrive in one tick.
        if (landed) c.tick();
      } else c.tick();
    }
    run.sim.advance(3);
    return { damage: PLAYER_MAX_HEALTH - c.player.health, rejected: c.rejected, causes: c.causes };
  }
  it('a landing report followed by standing ones in the same tick still hurts (the largest landing of the tick counts)', () => {
    const one = fall('single');
    expect(one.damage).toBe(Math.ceil(12 - FALL_SAFE_HEIGHT));
    for (const mode of ['landing+standing', 'five-in-one'] as const) {
      const r = fall(mode);
      expect(r.damage, mode).toBe(one.damage);
      expect(r.rejected, mode).toBe(0);
    }
  });
});

// ====================================================================== walls (finding: one report through a wall)

describe('a report may not pass through a wall, whatever movement time it has in store', () => {
  /** Stand at x = 2.69 against a stone wall (x 3 .. 3 + thick, z -5..5, 4 high), keep quiet, then report from beyond it. */
  function wall(thick: number, quiet: number, seqStep: number, to: number): { x: number; causes: string[]; rejected: number } {
    const { c } = scripted(2.69, 0.5, (run) => fill(run.sim.world, 3, T, -5, 2 + thick, T + 3, 5, B.STONE));
    for (let i = 0; i < 12; i++) c.send(2.69, T, 0.5);
    for (let i = 0; i < quiet; i++) c.tick();
    c.send(to, T, 0.5, { seqStep });
    return { x: c.player.pos.x, causes: c.causes, rejected: c.rejected };
  }
  it('through a one-block and a two-block wall after a quiet spell: a correction, no effect', () => {
    for (const [thick, quiet, step] of [
      [1, 10, 5],
      [1, 10, 10],
      [2, 10, 10],
      [1, 0, 10],
    ] as const) {
      const r = wall(thick, quiet, step, 3 + thick + 0.31);
      expect(r.causes, `${thick} thick, step ${step}`).toEqual(['check:path']);
      expect(r.x, `${thick} thick, step ${step}`).toBe(2.69);
    }
  });
  it('out of a roofed one-block cage: a correction, no effect', () => {
    const { c } = scripted(0.5, 0.5, (run) => {
      fill(run.sim.world, -1, T, -1, 1, T + 2, 1, B.STONE);
      fill(run.sim.world, 0, T, 0, 0, T + 1, 0, 0);
    });
    for (let i = 0; i < 12; i++) c.send(0.5, T, 0.5);
    c.send(2.4, T, 0.5, { seqStep: 10 });
    expect(c.causes).toEqual(['check:path']);
    expect(c.player.pos.x).toBe(0.5);
  });
  it('round the end of a wall, the reports between lost: accepted (the client slid along the wall, then went round its corner)', () => {
    // Pressed against the end of a wall (x 3, z -5..0), then beyond its corner.
    const { c } = scripted(2.69, 0.5, (run) => fill(run.sim.world, 3, T, -5, 3, T + 3, 0, B.STONE));
    for (let i = 0; i < 12; i++) c.send(2.69, T, 0.5);
    c.send(3.5, T, 1.6, { seqStep: 6 });
    expect(c.causes).toEqual([]);
    expect(c.player.pos.x).toBe(3.5);
  });
  it('the same burst over open ground is accepted (movement time in store)', () => {
    const { c } = scripted(2.69, 0.5);
    for (let i = 0; i < 12; i++) c.send(2.69, T, 0.5);
    for (let i = 0; i < 10; i++) c.tick();
    c.send(2.69 + SPRINT_SPEED * 10 * TICK_DT, T, 0.5, { seqStep: 10 });
    expect(c.causes).toEqual([]);
    expect(c.player.pos.x).toBeCloseTo(2.69 + 2.8, 9);
  });
});

// ====================================================================== flight, hovering, fall evasion (finding)

describe('nothing lifts a body that nothing holds up: survival flight, hovering, fall evasion, stalled reports', () => {
  it('rising in survival without flying: refused once it outclimbs a jump, then the server lets it fall', () => {
    const { run, c } = scripted(0.5, 0.5);
    let y = T;
    let top = T;
    for (let t = 0; t < 40 && c.rejected === 0; t++) {
      y += 0.3;
      c.send(0.5, y, 0.5, { onGround: false, vy: 6 });
      top = Math.max(top, c.player.pos.y);
    }
    expect(c.causes[0]).toBe('check:rise');
    // No more than a jump (1.25) and the slack.
    expect(top - T).toBeLessThan(1.25 + 0.5 + 1e-9);
    // The server takes over and the body comes down; its client is told every tick it does.
    run.sim.advance(30);
    expect(c.player.pos.y).toBe(T);
    expect(c.player.onGround).toBe(true);
    expect(run.sim.soloPlayer.player.remote!.takeover).toBe(false);
  });
  it('a jump whose take-off report is lost (and the reports of the ticks it stood in before): its arc may start in any of those ticks', () => {
    for (const lost of [1, 2, 4, 8]) {
      const { c } = scripted(0.5, 0.5);
      for (let i = 0; i < 5; i++) c.send(0.5, T, 0.5);
      // Standing, then the take-off: every one of these reports lost.
      for (let i = 0; i < lost - 1; i++) {
        c.lose(0.5, T, 0.5);
        c.tick();
      }
      const arc = jumpArc(JUMP_SPEED);
      c.lose(0.5, arc[0]!, 0.5, { onGround: false, vy: 7 });
      c.tick();
      for (let i = 1; i < arc.length; i++) c.send(0.5, arc[i]!, 0.5, { onGround: arc[i] === T, vy: 1 });
      expect(c.causes, `${lost} lost`).toEqual([]);
      expect(c.player.pos.y, `${lost} lost`).toBe(T);
    }
  });
  it('an arc a little above a jump (lifted along a tilted face) draws on the slack once, not on every report; again and again, as the slack refills', () => {
    const { c } = scripted(0.5, 0.5);
    for (let i = 0; i < 5; i++) c.send(0.5, T, 0.5);
    // A jump 0.5 b/s faster than JUMP_SPEED: by the time it comes down it runs about 0.3 above
    // the envelope, for about ten reports (charged on each one, that would be about 2 blocks).
    for (let jump = 0; jump < 20; jump++) {
      for (const y of jumpArc(JUMP_SPEED + 0.5)) c.send(0.5, y, 0.5, { onGround: y === T, vy: 1 });
      for (let i = 0; i < 4; i++) c.send(0.5, T, 0.5);
    }
    expect(c.causes).toEqual([]);
    expect(c.rejected).toBe(0);
  });
  it('hovering at the top of an honest jump: refused within a jump time, and it comes down', () => {
    const { run, c } = scripted(0.5, 0.5);
    let y = T;
    let v = JUMP_SPEED;
    // The jump's rise, tick by tick.
    while (v > 0) {
      const v1 = v - GRAVITY * TICK_DT;
      y += (v + v1) * 0.5 * TICK_DT;
      v = v1;
      c.send(0.5, y, 0.5, { onGround: false, vy: v });
    }
    expect(c.rejected).toBe(0);
    let held = 0;
    while (c.rejected === 0 && held < 40) {
      c.send(0.5, y, 0.5, { onGround: false });
      held++;
    }
    expect(c.causes).toEqual(['check:rise']);
    expect(held).toBeLessThan(15);
    run.sim.advance(30);
    expect(c.player.pos.y).toBe(T);
  });
  it('coming down 3 blocks a tick while claiming to stand: the fall still counts', () => {
    const honest = scripted(0.5, 0.5);
    honest.run.sim.soloPlayer.teleport(0.5, T + 30, 0.5);
    honest.c.tick();
    for (const y of fallTrack(T + 30, T)) honest.c.send(0.5, y, 0.5, { onGround: y === T });
    honest.run.sim.advance(3);
    const { run, c } = scripted(0.5, 0.5);
    run.sim.soloPlayer.teleport(0.5, T + 30, 0.5);
    c.tick();
    for (let y = T + 30; y > T; ) {
      y = Math.max(T, y - 3);
      c.send(0.5, y, 0.5, { onGround: true });
    }
    run.sim.advance(3);
    expect(hurts(honest.run).map((h) => h.amount)).toEqual([Math.ceil(30 - FALL_SAFE_HEIGHT)]);
    expect(hurts(run).map((h) => h.amount)).toEqual([Math.ceil(30 - FALL_SAFE_HEIGHT)]);
    expect(c.rejected).toBe(0);
  });
  it('reports stopping in mid-air: the server lets the body fall after REPORT_STALL_TICKS, hurts it on landing, and takes reports again', () => {
    const { run, c } = scripted(0.5, 0.5);
    run.sim.soloPlayer.teleport(0.5, T + 20, 0.5);
    c.tick();
    const track = fallTrack(T + 20, T);
    for (let i = 0; i < 4; i++) c.send(0.5, track[i]!, 0.5, { onGround: false, vy: -6 });
    const held = c.player.pos.y;
    for (let t = 0; t < REPORT_STALL_TICKS; t++) {
      c.tick();
      expect(c.player.pos.y).toBe(held);
    }
    // Silent and in mid-air: from now on the server moves the body, a correction every tick.
    const before = c.causes.length;
    for (let t = 0; t < 60 && !c.player.onGround; t++) c.tick();
    expect(c.player.pos.y).toBe(T);
    expect(c.causes.length - before).toBeGreaterThan(10);
    expect(c.causes.slice(before).every((x) => x === 'fall')).toBe(true);
    expect(hurts(run).map((h) => h.cause)).toEqual(['fall']);
    expect(hurts(run)[0]!.amount).toBe(Math.ceil(20 - FALL_SAFE_HEIGHT));
    // The client adopts the last correction and reports again from there.
    const at = c.last!.pos;
    const acc = c.player.remote!.accepted;
    for (let t = 0; t < 5; t++) c.send(at.x, at.y, at.z);
    expect(c.player.remote!.accepted - acc).toBe(5);
    expect(c.player.remote!.takeover).toBe(false);
  });
});

// ====================================================================== speed (finding: sustained slack)

describe('speed: the slack is a budget, not an allowance per report', () => {
  function run(step: number, ticks: number): { rejectedAt: number; x: number } {
    const { c } = scripted(0.5, 0.5);
    let x = 0.5;
    for (let t = 0; t < ticks; t++) {
      x += step;
      c.send(x, T, 0.5);
      if (c.rejected > 0) return { rejectedAt: t, x: c.player.pos.x };
    }
    return { rejectedAt: -1, x: c.player.pos.x };
  }
  it('sprint speed is accepted for as long as it lasts', () => {
    expect(run(SPRINT_SPEED * TICK_DT, 200).rejectedAt).toBe(-1);
  });
  it('a quarter over sprint speed is refused within a second, twice sprint speed at once', () => {
    expect(run(SPRINT_SPEED * TICK_DT * 1.25, 200).rejectedAt).toBeGreaterThanOrEqual(0);
    expect(run(SPRINT_SPEED * TICK_DT * 1.25, 200).rejectedAt).toBeLessThan(20);
    expect(run(SPRINT_SPEED * TICK_DT * 2, 200).rejectedAt).toBeLessThan(3);
  });
});

// ====================================================================== movement time (finding: jitter)

describe('movement time: reports may run ahead of the server clock by REPORT_MAX_LAG, not further', () => {
  it('a burst of reports in one tick (the uplink delay dropped) is accepted up to the credit and the debt', () => {
    const { c } = scripted(0.5, 0.5);
    let x = 0.5;
    const step = SPRINT_SPEED * TICK_DT;
    for (let t = 0; t < 20; t++) c.send((x += step), T, 0.5);
    for (let k = 0; k < REPORT_CREDIT_TICKS + REPORT_DEBT_TICKS - 1; k++) c.report((x += step), T, 0.5);
    c.tick();
    expect(c.rejected).toBe(0);
  });
  it('a client that runs twice as fast as the server is refused once the debt is spent', () => {
    const { c } = scripted(0.5, 0.5);
    let x = 0.5;
    const step = SPRINT_SPEED * TICK_DT;
    let t = 0;
    for (; t < 40 && c.rejected === 0; t++) {
      c.report((x += step), T, 0.5);
      c.report((x += step), T, 0.5);
      c.tick();
    }
    expect(c.causes).toEqual(['check:speed']);
    // Credit (full at the start) plus debt, one tick of credit back per tick, two spent.
    expect(t).toBeGreaterThan(REPORT_DEBT_TICKS);
    expect(t).toBeLessThan(REPORT_CREDIT_TICKS + REPORT_DEBT_TICKS + 3);
  });
});

// ====================================================================== landings (package 6)

describe('landings: two falls never merge when the landing between them is lost; a count alone ends no fall', () => {
  /**
   * Teleported 3 blocks above a one-block platform (top at T + 3) next to open ground (top at T):
   * an honest 3-block fall onto the platform, a step east off its edge, another 3-block fall.
   * `loseLanding`: every report between the falls is lost (the landing on the platform and the
   * step); `count`: the client counts its landings (an honest client does).
   */
  function steps(loseLanding: boolean, count: boolean): { damage: number; rejected: number; causes: string[] } {
    const { run, c } = scripted(0.5, 0.5, (r) => fill(r.sim.world, 1, T, -1, 1, T + 2, 1, B.STONE));
    run.sim.soloPlayer.teleport(1.5, T + 6, 0.5);
    c.tick();
    const opts = (o: ReportOpts): ReportOpts => (count ? o : { ...o, landings: 0 });
    const first = fallTrack(T + 6, T + 3);
    for (let i = 0; i < first.length; i++) {
      const landed = i === first.length - 1;
      if (landed && loseLanding) c.lose(1.5, first[i]!, 0.5, opts({ onGround: true }));
      else c.send(1.5, first[i]!, 0.5, opts({ onGround: landed, vy: landed ? 0 : -8 }));
    }
    // Off the edge, east, at walking speed.
    let x = 1.5;
    for (let i = 0; i < 4; i++) {
      x += 0.2;
      if (loseLanding) c.lose(x, T + 3, 0.5, opts({}));
      else c.send(x, T + 3, 0.5, opts({}));
    }
    x = 2.5;
    const second = fallTrack(T + 3, T);
    for (let i = 0; i < second.length; i++) {
      const landed = i === second.length - 1;
      c.send(x, second[i]!, 0.5, opts({ onGround: landed, vy: landed ? 0 : -8 }));
    }
    run.sim.advance(3);
    return { damage: PLAYER_MAX_HEALTH - c.player.health, rejected: c.rejected, causes: c.causes };
  }
  it('both landings seen: no damage; every report between the falls lost: still none, nothing refused (the count ends the first fall and starts the envelope again)', () => {
    expect(steps(false, true)).toEqual({ damage: 0, rejected: 0, causes: ['teleport'] });
    expect(steps(true, true)).toEqual({ damage: 0, rejected: 0, causes: ['teleport'] });
    // Without the count the server cannot explain the track: the second fall would hang above the
    // first one's arc (refused), or merge with it into one 6-block fall.
    const blind = steps(true, false);
    expect(blind.rejected).toBeGreaterThan(0);
    expect(blind.causes).toContain('check:rise');
  });
  it('a count that rises in mid-air, with no ground in reach, ends no fall: the full fall still hurts', () => {
    const { run, c } = scripted(0.5, 0.5);
    run.sim.soloPlayer.teleport(0.5, T + 12, 0.5);
    c.tick();
    const track = fallTrack(T + 12, T);
    let fake = 0;
    for (let i = 0; i < track.length; i++) {
      const landed = i === track.length - 1;
      if (i % 3 === 2) fake++;
      c.send(0.5, track[i]!, 0.5, { onGround: landed, vy: landed ? 0 : -8, landings: (c.landings + fake) & 255 });
    }
    run.sim.advance(3);
    expect(hurts(run).map((h) => h.amount)).toEqual([Math.ceil(12 - FALL_SAFE_HEIGHT)]);
    expect(c.rejected).toBe(0);
  });
  it('landings counted in mid-air climb nothing: one report every 10 ticks, a jump higher each time and one more landing, is refused at the second and comes down', () => {
    const { run, c } = scripted(0.5, 0.5);
    for (let i = 0; i < 5; i++) c.send(0.5, T, 0.5);
    let y = T;
    let top = T;
    for (let cycle = 0; cycle < 40; cycle++) {
      for (let i = 0; i < 9; i++) c.tick();
      y = Math.min(T + 7, y + 1.2);
      c.landings = (c.landings + 1) & 255;
      c.report(0.5, y, 0.5, { onGround: false, seqStep: 10, vy: 0 });
      c.tick();
      top = Math.max(top, c.player.pos.y);
    }
    // The first one is a jump in the gap; the second claims one from mid-air.
    expect(c.causes[0]).toBe('check:rise');
    expect(top - T).toBeLessThan(1.25 + 1e-9);
    run.sim.advance(40);
    expect(c.player.pos.y).toBe(T);
  });
  it('a jump right after a landing whose report was lost is accepted (the envelope starts again there)', () => {
    const { c } = scripted(0.5, 0.5);
    c.send(0.5, T, 0.5);
    let y = T;
    let v = JUMP_SPEED;
    const arc: number[] = [];
    for (let i = 0; i < 20; i++) {
      const v1 = v - GRAVITY * TICK_DT;
      y = Math.max(T, y + (v + v1) * 0.5 * TICK_DT);
      v = v1;
      arc.push(y);
      if (y === T) break;
    }
    // A jump, landing (lost), and at once the next jump: its first report is the first one the server sees.
    for (let i = 0; i < arc.length - 1; i++) c.send(0.5, arc[i]!, 0.5, { onGround: false, vy: 1 });
    c.lose(0.5, T, 0.5, { onGround: true });
    for (let i = 0; i < 5; i++) c.send(0.5, arc[i]!, 0.5, { onGround: false, vy: 1 });
    expect(c.causes).toEqual([]);
    expect(c.rejected).toBe(0);
  });
});

// ====================================================================== the report's lag (package 6)

describe("after a correction the server waits the report's lag before it takes over a body hanging in mid-air", () => {
  /** Ticks after a teleport into the air, with no report since, until the server lets the body fall; reports so far had `viewLag`. */
  function stall(viewLag: number): number {
    const { run, c } = scripted(0.5, 0.5);
    for (let i = 0; i < 10; i++) c.send(0.5, T, 0.5, { viewLag });
    run.sim.soloPlayer.teleport(0.5, T + 10, 0.5);
    c.tick();
    let t = 0;
    while (!c.player.remote!.takeover && t < 100) {
      c.tick();
      t++;
    }
    return t;
  }
  it('REPORT_STALL_TICKS plus the lag in ticks (at least REPORT_MAX_LAG): a round trip passes before any report of the new epoch can come', () => {
    // (Counted from the tick that settled the correction; the takeover comes in the tick after the wait.)
    expect(stall(2)).toBe(REPORT_STALL_TICKS + REPORT_DEBT_TICKS + 1);
    expect(stall(12)).toBe(REPORT_STALL_TICKS + 13 + 1);
  });
});

// ====================================================================== a carrier switch

describe("a carrier switch is allowed what the server's poses lead the client's copies by, no more", () => {
  /**
   * A report in another frame than the last accepted one is compared in the world at the server's
   * poses, which lead the client's copies by the lag at both carriers' speeds: that much is
   * allowed on top of the body's own motion, horizontally, vertically and above the vertical
   * envelope (and not carried on). The client says which frame a report is in, and may switch at
   * every report. A flat block more at every switch let a lying client beside a raft at rest climb
   * 0.9 and move 1.2 a report, alternating the raft's frame and the world's: 4.8 blocks up (to the
   * claimed carrier's reach) and 8.4 along in seven reports, unharmed.
   */
  function raftAtRest(): { l: Liar; ship: ReturnType<typeof assemble>; run: Run } {
    const run = seaRun('survival', vec3(0.5, SEA_TOP, 0.5), null);
    const sim = run.sim;
    fill(sim.world, -6, SEA_TOP - 1, -6, 6, SEA_TOP - 1, 6, B.PLANKS_OAK);
    sim.world.setCell(5, SEA_TOP, 5, makeCell(B.HELM, facingState(NZ)));
    const ship = assemble(sim, vec3(5, SEA_TOP, 5));
    for (let t = 0; t < 100; t++) sim.tick();
    const l = new Liar(run);
    expect(l.carrierId).toBe(ship.id);
    const p = ship.grid.toLocal(l.player.pos);
    l.send(p.x, p.y, p.z, true);
    return { l, ship, run };
  }

  for (const [what, up, along] of [
    ['0.9 up', 0.9, 0],
    ['1.2 along', 0, 1.2],
    ['0.5 up', 0.5, 0],
    ['0.6 along', 0, 0.6],
  ] as const)
    it(`beside a raft at rest, ${what} a report in the air, the raft's frame and the world's by turns: no higher and no farther than in one frame`, () => {
      const result = (switching: boolean): { top: number; far: number } => {
        const { l, ship } = raftAtRest();
        const g = ship.grid;
        const sp = l.player;
        const p0 = g.toLocal(sp.pos);
        let top = 0;
        let far = 0;
        for (let t = 0; t < 40; t++) {
          const cur = g.toLocal(sp.pos);
          const target = vec3(cur.x - along, cur.y + up, cur.z);
          if (!switching || t % 2 === 1) {
            l.carrierId = ship.id;
            l.send(target.x, target.y, target.z, false);
          } else {
            l.carrierId = 0;
            const tw = g.toWorld(target);
            l.send(tw.x, tw.y, tw.z, false);
          }
          const now = g.toLocal(sp.pos);
          top = Math.max(top, now.y - p0.y);
          far = Math.max(far, Math.hypot(now.x - p0.x, now.z - p0.z));
        }
        return { top, far };
      };
      const one = result(false);
      const both = result(true);
      expect(both.top).toBeLessThanOrEqual(one.top + 1e-6);
      expect(both.far).toBeLessThanOrEqual(one.far + 1e-6);
      expect(both.top).toBeLessThan(1.8);
    });
});
