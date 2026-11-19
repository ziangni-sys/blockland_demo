/**
 * The protocol catalogue (NETCODE sections 3, 14): build identity, message ids and channels, and the
 * constants that must agree with the modules they mirror.
 */
import { describe, expect, it } from 'vitest';
import { HOTBAR_SLOTS as INV_HOTBAR, MAIN_SLOTS as INV_MAIN } from '../../src/entities/inventory';
import { encodeServerMessage } from '../../src/net/codec';
import {
  BUILD_ID,
  ENTITY_KINDS,
  HOTBAR_SLOTS,
  MAIN_SLOTS,
  MESSAGE_CHANNEL,
  MSG,
  SECTION,
  emptyTickBatch,
  type MessageType,
} from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE } from '../../src/net/transport';

describe('protocol catalogue', () => {
  it("BUILD_ID is 'test' under Vitest", () => {
    expect(BUILD_ID).toBe('test');
  });

  it('message ids are distinct; client messages below 0x80, server messages above', () => {
    const ids = Object.values(MSG);
    expect(new Set(ids).size).toBe(ids.length);
    const server = new Set<MessageType>(['welcome', 'refuse', 'kick', 'pong', 'tickBatch', 'samples']);
    for (const t of Object.keys(MSG) as MessageType[]) expect(MSG[t] >= 0x80, t).toBe(server.has(t));
    // The ids that never change (section 3).
    expect(MSG.hello).toBe(0x01);
    expect(MSG.refuse).toBe(0x82);
  });

  it('only Ping, MoveReport, Pong and Samples are unreliable', () => {
    const unreliable = (Object.keys(MESSAGE_CHANNEL) as MessageType[]).filter((t) => MESSAGE_CHANNEL[t] === UNRELIABLE);
    expect(unreliable.sort()).toEqual(['moveReport', 'ping', 'pong', 'samples']);
    expect(Object.keys(MESSAGE_CHANNEL).sort()).toEqual(Object.keys(MSG).sort());
    expect(MESSAGE_CHANNEL.tickBatch).toBe(RELIABLE);
  });

  it('agrees with the modules it mirrors', () => {
    expect(HOTBAR_SLOTS).toBe(INV_HOTBAR);
    expect(MAIN_SLOTS).toBe(INV_MAIN);
    expect(ENTITY_KINDS).toEqual(['player', 'item', 'falling', 'tnt', 'rabbit']);
    expect(Object.values(SECTION)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('emptyTickBatch encodes to the 6-byte heartbeat', () => {
    expect(encodeServerMessage(emptyTickBatch(100_000)).length).toBe(6);
  });
});
