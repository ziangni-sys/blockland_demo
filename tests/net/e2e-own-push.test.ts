/**
 * End to end (package 6): scenes of package 2's lag tests (tests/drive) rebuilt with the real client,
 * clock and links; the table and what is judged are in own-table.ts.
 */
import { describe } from 'vitest';
import { sceneTests } from './own-table';

describe('the own player end to end: push scenes', () => {
  sceneTests(['ram6', 'ram14', 'bridge', 'drown', 'steer', 'pushedOff']);
});
