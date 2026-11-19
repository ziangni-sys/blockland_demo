import { describe, expect, it, vi } from 'vitest';
import { B } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';
import { buildMesh } from '../../src/mesh/mesher';
import { meshTransferables, type MeshRequest, type MeshResponse } from '../../src/mesh/types';
import { serveMeshRequests, type MeshErrorResponse, type MeshWorkerScope } from '../../src/mesh/worker';
import { makeInput, put } from './helpers';

function fakeScope() {
  const posted: Array<{ msg: unknown; transfer: Transferable[] | undefined }> = [];
  const scope: MeshWorkerScope = {
    onmessage: null,
    postMessage(msg, transfer) {
      posted.push({ msg, transfer });
    },
  };
  return { scope, posted };
}

describe('mesh worker protocol', () => {
  it('answers a request with the mesh, echoing the id and transferring every buffer', () => {
    const { scope, posted } = fakeScope();
    serveMeshRequests(scope);
    expect(scope.onmessage).toBeTypeOf('function');
    const input = makeInput(2, 2, 2, true);
    put(input, 0, 0, 0, makeCell(B.STONE));
    put(input, 1, 1, 1, makeCell(B.WATER));
    put(input, 1, 0, 1, makeCell(B.TALL_GRASS));
    const req: MeshRequest = { type: 'mesh', id: 77, input };
    scope.onmessage!({ data: req });
    expect(posted.length).toBe(1);
    const res = posted[0]!.msg as MeshResponse;
    expect(res.type).toBe('mesh');
    expect(res.id).toBe(77);
    expect(res.data).toEqual(buildMesh(input));
    const transfer = posted[0]!.transfer!;
    expect(transfer).toEqual(meshTransferables(res.data));
    expect(transfer.length).toBe(18); // 3 groups x 6 arrays
    expect(new Set(transfer).size).toBe(18); // no buffer listed twice (would throw in postMessage)
  });

  it('keeps answering sequential jobs independently', () => {
    const { scope, posted } = fakeScope();
    serveMeshRequests(scope);
    const a = makeInput(1, 1, 1);
    put(a, 0, 0, 0, makeCell(B.STONE));
    const b = makeInput(3, 1, 1);
    scope.onmessage!({ data: { type: 'mesh', id: 1, input: a } });
    scope.onmessage!({ data: { type: 'mesh', id: 2, input: b } });
    scope.onmessage!({ data: { type: 'mesh', id: 3, input: a } });
    const res = posted.map((p) => p.msg as MeshResponse);
    expect(res.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(res[1]!.data).toEqual({ opaque: null, cutout: null, translucent: null });
    expect(posted[1]!.transfer).toEqual([]);
    expect(res[2]!.data).toEqual(res[0]!.data);
    expect(res[2]!.data.opaque!.positions.buffer).not.toBe(res[0]!.data.opaque!.positions.buffer);
  });

  it('answers a malformed job instead of dropping it, marked as an error so the client keeps its old mesh', () => {
    const { scope, posted } = fakeScope();
    serveMeshRequests(scope);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    scope.onmessage!({ data: { type: 'mesh', id: 5, input: { sx: 4, sy: 4, sz: 4, cells: new Uint16Array(3), holes: null, part2: null, light: null } } });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    const res = posted[0]!.msg as MeshErrorResponse;
    expect(res.type).toBe('mesh');
    expect(res.id).toBe(5);
    expect(res.data).toEqual({ opaque: null, cutout: null, translucent: null });
    expect(res.error).toMatch(/RangeError: .*cells has 3 entries/);
    expect(posted[0]!.transfer).toEqual([]);
    // a legitimately empty section is NOT an error: the two replies are distinguishable
    scope.onmessage!({ data: { type: 'mesh', id: 6, input: makeInput(4, 4, 4) } });
    const ok = posted[1]!.msg as MeshResponse;
    expect(ok.data).toEqual(res.data);
    expect('error' in ok).toBe(false);
    expect('error' in res).toBe(true);
    // and the worker keeps serving after a failure
    expect(ok.id).toBe(6);
  });

  it('ignores unrelated messages', () => {
    const { scope, posted } = fakeScope();
    serveMeshRequests(scope);
    scope.onmessage!({ data: { type: 'other' } as unknown as MeshRequest });
    scope.onmessage!({ data: null as unknown as MeshRequest });
    expect(posted.length).toBe(0);
  });
});
