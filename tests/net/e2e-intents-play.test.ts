/**
 * Package 7 end to end: a whole play-through by intents alone (tests/net/intent-scenes.ts
 * playThrough: mine and place, the bucket, pick block, timed glue by hand and its removal, glue in
 * the off-hand building on a raft, preview and assembly at the helm, steering away and back, docking,
 * a windmill started and stopped, a blast crate) by a real client on each of the three links ends
 * with exactly the world and the inventory a server-driven player's run of the same script ends with.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { LINKS } from './e2e-scenes';
import { clientPlay, inventoryOf, referencePlay, type Outcome } from './intent-scenes';
import { stat } from './own-scenes';

describe('package 7: the play-through by intents alone ends exactly like a server-driven player\'s', () => {
  let ref: Outcome;
  beforeAll(async () => {
    ref = await referencePlay();
  }, 120_000);

  for (const [i, l] of LINKS.entries()) {
    it(`on ${l.name}`, async () => {
      const run = await clientPlay(l.make(70 + 10 * i));
      const { h, c } = run;
      expect(run.out.columns).toEqual(ref.columns);
      expect(run.out.glue).toEqual(ref.glue);
      expect(run.out.structures).toEqual(ref.structures);
      expect(run.out.drops).toEqual(ref.drops);
      expect(run.out.inventory).toEqual(ref.inventory);
      // The client shows the server's inventory, and its replica is the server's world.
      const shown = c.inventory;
      expect({ selected: shown.selected, hotbar: shown.hotbar, main: shown.main, offhand: shown.offhand, cursor: shown.cursor }).toEqual(inventoryOf(h.sim.players.get('p')!));
      expect(h.compareNow(c, false)).toEqual([]);
      // No target of an intent was refused (out of reach, stale, of the wrong kind), no report either.
      expect(h.intentStats('p')!.failed).toEqual({ grid: 0, cell: 0, ray: 0, reach: 0 });
      expect(c.correctionsSince(0, (k) => k.startsWith('check:'))).toEqual([]);
      stat(`play-through ${l.name}: ${(h.net.now / 1000).toFixed(1)} s of game time; steps ${run.log.steps.map((s) => `${s.step} ${(s.ms / 1000).toFixed(1)}`).join(', ')}`);
    }, 300_000);
  }
});
