/**
 * Adversarial review (correctness): Inventory.consume / consumeSelected accept counts that are
 * not positive integers. consumeSelected(-10) ADDS ten items and returns true (count 5 -> 15);
 * consume(item, 1.5) leaves a fractional stack (13.5) that the save code (varuint) cannot write.
 */
import { describe, expect, it } from 'vitest';
import { ByteWriter } from '../../src/save/bytes';
import { Inventory } from '../../src/entities/inventory';
import { B } from './harness';

describe('review: consume counts are validated', () => {
  it('consumeSelected with a negative count never creates items', () => {
    const inv = new Inventory();
    inv.hotbar[0] = { item: B.COBBLE, count: 5 };
    inv.consumeSelected(-10);
    expect(inv.count(B.COBBLE)).toBeLessThanOrEqual(5);
  });

  it('consume with a fractional count never leaves a fractional stack (the inventory must stay saveable)', () => {
    const inv = new Inventory();
    inv.hotbar[0] = { item: B.COBBLE, count: 15 };
    inv.consume(B.COBBLE, 1.5);
    expect(Number.isInteger(inv.hotbar[0]?.count ?? 0)).toBe(true);
    expect(() => inv.serialize(new ByteWriter())).not.toThrow();
  });
});
