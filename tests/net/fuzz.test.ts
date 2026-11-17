/**
 * Decoding untrusted bytes (NETCODE section 14, tests of package 3 in section 16): truncated and
 * corrupted messages throw ProtocolError and nothing else, never read out of bounds, never
 * allocate out of proportion and never loop without bound; whatever a corrupted message decodes
 * to can be encoded again (the limits are the same on both ends).
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { ByteWriter, SaveFormatError } from '../../src/save/bytes';
import {
  ProtocolError,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  readHelloBuild,
} from '../../src/net/codec';
import {
  MAX_COORD,
  MAX_PREVIEW_CELLS,
  MAX_STRUCTURE_BOX_CELLS,
  MESSAGE_CHANNEL,
  MSG,
  type AnyMessage,
  type MessageType,
  type TickBatchMsg,
} from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE, type Channel } from '../../src/net/transport';
import { Gen } from './gen';

interface Codec {
  encode(m: AnyMessage): Uint8Array;
  decode(bytes: Uint8Array, channel: Channel): AnyMessage;
}
const CLIENT: Codec = {
  encode: (m) => encodeClientMessage(m as never),
  decode: decodeClientMessage,
};
const SERVER: Codec = {
  encode: (m) => encodeServerMessage(m as never),
  decode: decodeServerMessage,
};

/**
 * Decode `bytes`: either a value that encodes again into a valid message (Rot64 re-normalises, so
 * the second decode may differ in the last digits of a rotation), or a
 * ProtocolError raised by the reader's own checks (its cause is a SaveFormatError: no TypeError or
 * RangeError escaped from somewhere unexpected).
 */
function probe(codec: Codec, bytes: Uint8Array, channel: Channel): 'ok' | 'error' {
  let m: AnyMessage;
  try {
    m = codec.decode(bytes, channel);
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    expect((e as ProtocolError).cause).toBeInstanceOf(SaveFormatError);
    return 'error';
  }
  const again = codec.encode(m);
  expect(codec.decode(again, channel).type).toBe(m.type);
  return 'ok';
}

function channelOf(bytes: Uint8Array): Channel {
  const type = (Object.keys(MSG) as MessageType[]).find((t) => MSG[t] === bytes[0]);
  return type === undefined ? RELIABLE : MESSAGE_CHANNEL[type];
}

function samples(seed: number): Array<{ codec: Codec; bytes: Uint8Array }> {
  const g = new Gen(seed);
  return [
    ...g.clientMessages().map((m) => ({ codec: CLIENT, bytes: encodeClientMessage(m) })),
    ...g.serverMessages().map((m) => ({ codec: SERVER, bytes: encodeServerMessage(m) })),
  ];
}

describe('truncated messages', () => {
  it('every strict prefix of every message is a ProtocolError', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const { codec, bytes } of samples(seed)) {
        const ch = channelOf(bytes);
        // Every prefix of small messages; a spread of prefixes of large ones.
        const step = Math.max(1, Math.floor(bytes.length / 300));
        for (let n = 0; n < bytes.length; n += n < 64 ? 1 : step) {
          expect(probe(codec, bytes.subarray(0, n), ch), `seed ${seed} type 0x${bytes[0]!.toString(16)} prefix ${n}/${bytes.length}`).toBe('error');
        }
      }
    }
  });

  it('trailing bytes are a ProtocolError', () => {
    for (const { codec, bytes } of samples(7)) {
      const longer = new Uint8Array(bytes.length + 1);
      longer.set(bytes);
      expect(probe(codec, longer, channelOf(bytes))).toBe('error');
    }
  });
});

describe('corrupted messages', () => {
  it('random byte changes either decode to something that encodes again, or are a ProtocolError', () => {
    const rng = new Rng(99);
    let decoded = 0;
    let refused = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const { codec, bytes } of samples(500 + seed)) {
        for (let trial = 0; trial < 30; trial++) {
          const bad = bytes.slice();
          const edits = 1 + rng.int(0, 2);
          for (let k = 0; k < edits; k++) {
            const at = rng.int(0, bad.length - 1);
            bad[at] = rng.chance(0.5) ? rng.int(0, 255) : bad[at]! ^ (1 << rng.int(0, 7));
          }
          if (probe(codec, bad, channelOf(bad)) === 'ok') decoded++;
          else refused++;
        }
      }
    }
    // Both outcomes occur often: the test exercises the decoders, not only the id check.
    expect(decoded).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
  });

  it('random bytes after a valid id are handled the same way', () => {
    const rng = new Rng(5);
    for (const type of Object.keys(MSG) as MessageType[]) {
      const codec = MSG[type] < 0x80 ? CLIENT : SERVER;
      for (let trial = 0; trial < 300; trial++) {
        const bytes = new Uint8Array(1 + rng.int(0, 80));
        bytes[0] = MSG[type];
        for (let i = 1; i < bytes.length; i++) bytes[i] = rng.chance(0.3) ? rng.int(0, 3) : rng.int(0, 255);
        probe(codec, bytes, MESSAGE_CHANNEL[type]);
      }
    }
  });

  it('readHelloBuild throws ProtocolError only', () => {
    const rng = new Rng(8);
    for (let trial = 0; trial < 500; trial++) {
      const bytes = new Uint8Array(rng.int(0, 12)).map(() => rng.int(0, 255));
      if (bytes.length > 0 && rng.chance(0.7)) bytes[0] = MSG.hello;
      try {
        expect(typeof readHelloBuild(bytes)).toBe('string');
      } catch (e) {
        expect(e).toBeInstanceOf(ProtocolError);
      }
    }
  });
});

describe('hostile lengths and counts', () => {
  const tickBatch = (sections: number, body: (w: ByteWriter) => void): Uint8Array => {
    const w = new ByteWriter();
    w.u8(MSG.tickBatch).varuint(1).u16(sections);
    body(w);
    return w.finish();
  };
  const fast = (f: () => void): void => {
    const t0 = performance.now();
    expect(f).toThrow(ProtocolError);
    expect(performance.now() - t0).toBeLessThan(50);
  };

  it('a list count beyond what the input could hold fails before allocating or looping', () => {
    for (let bit = 0; bit <= 11; bit++) {
      if (bit === 10) continue; // private state has no count
      fast(() => decodeServerMessage(tickBatch(1 << bit, (w) => w.varuint(2 ** 50)), RELIABLE));
    }
    const samplesMsg = new ByteWriter().u8(MSG.samples).varuint(1).varuint(1).varuint(2 ** 52).finish();
    fast(() => decodeServerMessage(samplesMsg, UNRELIABLE));
    const welcome = new ByteWriter().u8(MSG.welcome).varuint(1).u8(1).u32(0).varuint(2 ** 40).finish();
    fast(() => decodeServerMessage(welcome, RELIABLE));
    const strings = new ByteWriter().u8(MSG.hello).varuint(2 ** 40).finish();
    fast(() => decodeClientMessage(strings, RELIABLE));
  });

  it('a raw CellVolume must be present in the input; a palette larger than the input fails', () => {
    fast(() => decodeServerMessage(tickBatch(1 << 1, (w) => w.varuint(1).varint(0).varint(0).u8(1).u8(1)), RELIABLE));
    fast(() => decodeServerMessage(tickBatch(1 << 1, (w) => w.varuint(1).varint(0).varint(0).u8(1).u8(0).varuint(4000)), RELIABLE));
  });

  it('a run-length CellVolume ends when its runs cover the volume, never later', () => {
    // Palette of 2, one run token for 10 cells, then nothing: the decoder needs more tokens and the input ends.
    fast(() => decodeServerMessage(tickBatch(1 << 1, (w) => w.varuint(1).varint(0).varint(0).u8(1).u8(0).varuint(2).varuint(1).varuint(2).varuint(9 * 2)), RELIABLE));
    // A run longer than what is left of the volume.
    fast(() => decodeServerMessage(tickBatch(1 << 1, (w) => w.varuint(1).varint(0).varint(0).u8(1).u8(0).varuint(1).varuint(1).varuint(32768)), RELIABLE));
  });

  describe('the preview bitmap', () => {
    const view = (sx: number, sy: number, sz: number, bitmap: Uint8Array, minX = 0): Uint8Array =>
      tickBatch(1 << 10, (w) => {
        w.u8(8).u8(4).bool(true).varuint(3).u8(0).varint(minX).varint(0).varint(0).varuint(sx).varuint(sy).varuint(sz);
        w.raw(bitmap);
      });

    it('a box larger than its bitmap in the input fails before allocating', () => {
      fast(() => decodeServerMessage(view(2 ** 20, 2 ** 20, 2 ** 20, new Uint8Array(64)), RELIABLE));
      fast(() => decodeServerMessage(view(3, 3, 3, new Uint8Array(3)), RELIABLE));
      const ok = decodeServerMessage(view(3, 3, 3, new Uint8Array(4)), RELIABLE);
      expect(ok.type).toBe('tickBatch');
    });

    it('a full bitmap fails before its cells are allocated (one bit would become 12 bytes)', () => {
      // A 256 KiB bitmap of ones (the largest box): 2.1 million cells if it were decoded.
      const full = new Uint8Array(MAX_STRUCTURE_BOX_CELLS / 8).fill(0xff);
      const before = process.memoryUsage().arrayBuffers;
      fast(() => decodeServerMessage(view(8, MAX_STRUCTURE_BOX_CELLS / 8, 1, full), RELIABLE));
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
      // Exactly MAX_PREVIEW_CELLS set bits decode; one more is refused.
      const bits = (n: number): Uint8Array => {
        const b = new Uint8Array(Math.ceil((MAX_PREVIEW_CELLS + 1) / 8));
        for (let i = 0; i < n; i++) b[i >> 3]! |= 1 << (i & 7);
        return b;
      };
      const side = bits(0).length * 8;
      const ok = decodeServerMessage(view(side, 1, 1, bits(MAX_PREVIEW_CELLS)), RELIABLE) as TickBatchMsg;
      expect(ok.private!.view!.preview!.cells.length).toBe(3 * MAX_PREVIEW_CELLS);
      expect(() => decodeServerMessage(view(side, 1, 1, bits(MAX_PREVIEW_CELLS + 1)), RELIABLE)).toThrow(/MAX_PREVIEW_CELLS/);
    });

    it('a box above MAX_STRUCTURE_BOX_CELLS, or one whose far corner leaves MAX_COORD, is refused', () => {
      // The whole bitmap is in the input: the box limit refuses it, not the input length.
      const over = view(8, MAX_STRUCTURE_BOX_CELLS / 8 + 1, 1, new Uint8Array(MAX_STRUCTURE_BOX_CELLS / 8 + 1));
      expect(() => decodeServerMessage(over, RELIABLE)).toThrow(/too large/);
      expect(() => decodeServerMessage(view(2, 1, 1, Uint8Array.of(3), MAX_COORD), RELIABLE)).toThrow(/coordinate range/);
      const edge = decodeServerMessage(view(2, 1, 1, Uint8Array.of(3), MAX_COORD - 1), RELIABLE) as TickBatchMsg;
      expect([...edge.private!.view!.preview!.cells]).toEqual([MAX_COORD - 1, 0, 0, MAX_COORD, 0, 0]);
    });
  });

  it('a huge coordinate, a coordinate delta that overflows and an unknown enumeration are refused', () => {
    fast(() => decodeServerMessage(tickBatch(1, (w) => w.varuint(1).varint(2 ** 40).varint(0)), RELIABLE));
    // Structure delta cells: two deltas of 2^27 + 2^27 + 2^27 leave the coordinate range.
    fast(() =>
      decodeServerMessage(
        tickBatch(1 << 5, (w) => w.varuint(1).varuint(3).u8(1).varuint(2).varint(2 ** 27).varint(0).varint(0).varuint(1).varint(2 ** 27 + 2 ** 27).varint(0).varint(0).varuint(1)),
        RELIABLE,
      ),
    );
    fast(() => decodeServerMessage(new ByteWriter().u8(MSG.kick).u8(7).string('').finish(), RELIABLE));
    fast(() => decodeServerMessage(tickBatch(1 << 13, () => undefined), RELIABLE));
  });
});
