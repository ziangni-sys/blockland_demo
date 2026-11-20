/**
 * Child-process probe for tests/heap-probe.test.ts (not a test file itself): two cases with a
 * known answer, measured by tests/heap-probe.ts. One allocates about 1 KB per call, as a
 * structure query that builds its local box per call again would; the other allocates nothing.
 */
import { measureCases } from './heap-probe';

let keep: number[] = [];
await measureCases({
  // An array of 128 doubles: 1 KB of elements on the JS heap (a typed array would keep its
  // elements outside it, where the heap profiler does not look).
  'a 1 KB array per call': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      keep = new Array<number>(128).fill(i + 0.5);
      s += keep[(i * 7) & 127]!;
    }
    return s;
  },
  'nothing allocated': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s = (s + Math.imul(i, 31)) | 0;
    return s;
  },
});
