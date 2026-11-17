/**
 * Fault isolation for the frame loop: an exception in one subsystem (a tick, the mesher,
 * the renderer, the UI ...) is caught by the caller and reported here ONCE per distinct
 * error (numbers in the message ignored), then the frame goes on. The first report of each error is logged and shown to the
 * player (toast); repeats only bump a counter visible in the debug overlay.
 */

/** Human-readable one-line description of anything thrown. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message ? `${err.name}: ${err.message}` : err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export interface FaultRecord {
  what: string;
  message: string;
  count: number;
}

/** Distinct faults remembered; beyond this, new ones are folded into one record per subsystem. */
const MAX_DISTINCT = 64;

/**
 * De-duplication key: the subsystem plus the message with every number replaced, so errors
 * that only differ by coordinates or ids ("chunk 3,-2 is not ...", "grid 17 ...") count as
 * one fault instead of a fresh toast and log line per chunk or section.
 */
function faultKey(what: string, message: string): string {
  return `${what}\u0000${message.replace(/\d+(?:\.\d+)?/g, '#')}`;
}

export class Faults {
  private readonly byKey = new Map<string, FaultRecord>();
  /** Most recent distinct faults, newest last (debug overlay). */
  readonly recent: FaultRecord[] = [];

  constructor(
    /** Called on the first occurrence of each distinct fault. Must not throw. */
    private readonly onFirst: (rec: FaultRecord, err: unknown) => void,
    private readonly log: (msg: string, err: unknown) => void = () => undefined,
  ) {}

  report(what: string, err: unknown): void {
    const message = describeError(err);
    let key = faultKey(what, message);
    let known = this.byKey.get(key);
    if (!known && this.byKey.size >= MAX_DISTINCT) {
      // Bounded memory: one catch-all record per subsystem from here on.
      key = `${what}\u0000*`;
      known = this.byKey.get(key);
    }
    if (known) {
      known.count++;
      return;
    }
    const rec: FaultRecord = { what, message, count: 1 };
    this.byKey.set(key, rec);
    this.recent.push(rec);
    if (this.recent.length > 4) this.recent.shift();
    try {
      this.log(`[blocklands] ${what} failed: ${message}`, err);
      this.onFirst(rec, err);
    } catch {
      // Reporting must never become a second fault.
    }
  }

  get total(): number {
    let n = 0;
    for (const r of this.byKey.values()) n += r.count;
    return n;
  }
}
