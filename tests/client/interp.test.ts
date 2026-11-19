import { describe, expect, it } from 'vitest';
import { approach } from '../../src/client/interp';

describe('approach', () => {
  it('is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 10; i++) a = approach(a, 1, 5, 0.01);
    const b = approach(0, 1, 5, 0.1);
    expect(a).toBeCloseTo(b, 10);
    expect(approach(3, 1, 5, 0)).toBe(3);
    expect(approach(3, 1, 5, -1)).toBe(3);
  });
});
