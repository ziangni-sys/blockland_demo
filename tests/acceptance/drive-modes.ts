/**
 * Acceptance scenarios that run twice: with the usual server-driven player, and with a
 * client-driven one (src/entities/drive.ts) played by the lag-0 client harness
 * (tests/drive/client.ts). The scenario code is the same; only the scene factory differs:
 * withDrive() attaches the client to the new simulation when the running suite is client-driven.
 */
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { Simulation } from '../../src/sim/simulation';
import { attachClient, type LaggedClient } from '../drive/client';

/** Pose lag (ticks) of the client-driven runs; null = the server-driven run. */
const DRIVES: ReadonlyArray<number | null> = [null, 0];

/** The drive of the suite whose hooks and tests are running (suites run one after another). */
let current: number | null = null;
/** Clients attached in the running suite. */
const clients: LaggedClient[] = [];

/** describe() once per drive mode; scenes built inside use withDrive() on their simulation. */
export function driveSuite(name: string, body: () => void): void {
  for (const lag of DRIVES) {
    describe(lag === null ? name : `${name} [client-driven, lag ${lag}]`, () => {
      beforeAll(() => {
        current = lag;
        clients.length = 0;
      });
      if (lag !== null) {
        afterAll(() => {
          // The client really drove: it reported, the server took its reports, and no report
          // failed a check (lag 0: the client sees exactly what the server sees).
          expect(clients.length).toBeGreaterThan(0);
          for (const c of clients) {
            const d = c.control.online ? c.control.player.remote : null;
            if (d !== null) expect(d.accepted, 'accepted reports').toBeGreaterThan(0);
            expect(c.stats.reports).toBeGreaterThan(0);
            expect(c.causes().filter((k) => k.startsWith('check:'))).toEqual([]);
          }
        });
      }
      body();
    });
  }
}

/** The running suite's drive applied to a freshly built single-player simulation. */
export function withDrive(sim: Simulation): Simulation {
  if (current !== null) clients.push(attachClient(sim, current));
  return sim;
}
