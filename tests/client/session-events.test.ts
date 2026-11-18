/**
 * The client plays one player of a world (WorldSession): the toasts addressed to it reach the
 * page, those of other players never do (the server sends each player its own events, section
 * 11), and its own hurt makes its model flash.
 */
import { describe, expect, it } from 'vitest';
import { SessionRig } from './rig';

describe('WorldSession events', () => {
  it('shows the toasts addressed to its own player only; its own hurt flashes its model', async () => {
    const key = 'm'.repeat(32);
    const rig = await SessionRig.create({ mode: 'survival', playerKey: key });
    rig.sim.join('other');
    rig.playUntilReady();
    const sim = rig.sim;
    sim.events.emit({ type: 'toast', player: key, message: { key: 'toast.glue.added' }, kind: 'info' });
    sim.events.emit({ type: 'toast', player: 'other', message: { key: 'toast.glue.removed' }, kind: 'warn' });
    sim.events.emit({ type: 'playerHurt', player: 'other', amount: 2, cause: 'fall' });
    rig.ticks(2);
    expect(rig.toasts).toEqual([{ message: { key: 'toast.glue.added' }, kind: 'info' }]);
    expect(rig.session.shown.hurt).toBe(false);
    sim.events.emit({ type: 'playerHurt', player: key, amount: 3, cause: 'fall' });
    rig.ticks(2);
    expect(rig.session.shown.hurt).toBe(true);
    rig.run(1000);
    expect(rig.session.shown.hurt).toBe(false);
  });
});
