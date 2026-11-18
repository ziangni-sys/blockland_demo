/**
 * The player's identity in the browser (client/identity.ts; docs/NETCODE.md section 3 "玩家身份"):
 * one random 128-bit key per browser in localStorage, `?slot=<name>` for another one.
 */
import { describe, expect, it } from 'vitest';
import { newPlayerKey, playerKeyFor, PLAYER_KEY_STORAGE, slotFromSearch } from '../../src/client/identity';
import type { KeyValueStore } from '../../src/client/settings';

function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

/** A different byte pattern on every call. */
function counterRandom(): (bytes: Uint8Array<ArrayBuffer>) => void {
  let n = 0;
  return (bytes) => {
    n++;
    for (let i = 0; i < bytes.length; i++) bytes[i] = (n * 37 + i * 11) & 255;
  };
}

describe('player identity', () => {
  it('a key is 32 lowercase hex characters (128 random bits)', () => {
    const key = newPlayerKey(counterRandom());
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is made once and kept: the same browser gets the same key on every page load', () => {
    const store = memoryStore();
    const random = counterRandom();
    const a = playerKeyFor(store, null, random);
    expect(store.map.get(PLAYER_KEY_STORAGE)).toBe(a);
    expect(playerKeyFor(store, null, random)).toBe(a);
  });

  it('?slot=<name> picks another identity, kept under its own name; the default one is untouched', () => {
    const store = memoryStore();
    const random = counterRandom();
    const main = playerKeyFor(store, null, random);
    const second = playerKeyFor(store, slotFromSearch('?slot=two'), random);
    expect(second).not.toBe(main);
    expect(store.map.get(`${PLAYER_KEY_STORAGE}:two`)).toBe(second);
    expect(playerKeyFor(store, 'two', random)).toBe(second);
    expect(playerKeyFor(store, null, random)).toBe(main);
  });

  it('reads the slot from the address; anything else is the default identity', () => {
    expect(slotFromSearch('?slot=b')).toBe('b');
    expect(slotFromSearch('?x=1&slot=guest_2')).toBe('guest_2');
    expect(slotFromSearch('')).toBeNull();
    expect(slotFromSearch(null)).toBeNull();
    expect(slotFromSearch('?slot=')).toBeNull();
    expect(slotFromSearch('?slot=a%20b')).toBeNull();
    expect(slotFromSearch(`?slot=${'x'.repeat(33)}`)).toBeNull();
  });

  it('a stored value that is not a key is replaced; without storage the key lives as long as the page', () => {
    const store = memoryStore();
    store.map.set(PLAYER_KEY_STORAGE, 'local');
    const key = playerKeyFor(store, null, counterRandom());
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(store.map.get(PLAYER_KEY_STORAGE)).toBe(key);
    expect(playerKeyFor(null, null, counterRandom())).toMatch(/^[0-9a-f]{32}$/);
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(playerKeyFor(throwing, null, counterRandom())).toMatch(/^[0-9a-f]{32}$/);
  });
});
