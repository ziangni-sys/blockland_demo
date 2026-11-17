import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qslerp, quat, vec3, type Quat, type Vec3 } from '../../src/core/math';
import { approach, frameToLocal, frameToWorld, interpolateCarried, lerpAngle, lerpVec, type FramePose } from '../../src/client/interp';

const Y = vec3(0, 1, 0);

function frame(pos: Vec3, rot: Quat): FramePose {
  return { position: pos, rotation: rot };
}

describe('lerpAngle', () => {
  it('takes the short way round', () => {
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI); // across +-PI, not through 0
    expect(lerpAngle(-3, 3, 0.5)).toBeCloseTo(-Math.PI);
    expect(lerpAngle(0.2, 0.2 + 4 * Math.PI, 0.5)).toBeCloseTo(0.2);
    expect(lerpAngle(1, 2, 0)).toBe(1);
    expect(lerpAngle(1, 2, 1)).toBeCloseTo(2);
  });
});

describe('frame transforms', () => {
  it('frameToLocal inverts frameToWorld', () => {
    const f = frame(vec3(10, 5, -3), qfromAxisAngle(vec3(0.6, 0.8, 0), 1.1));
    const pivot = vec3(2.5, 1, 7.25);
    const p = vec3(-4, 9, 12);
    const l = frameToLocal(f, pivot, p, vec3());
    const back = frameToWorld(f, pivot, l, vec3());
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
    expect(back.z).toBeCloseTo(p.z);
  });

  it('the pivot maps to the frame position', () => {
    const f = frame(vec3(1, 2, 3), qfromAxisAngle(Y, 0.7));
    const pivot = vec3(5, 6, 7);
    const w = frameToWorld(f, pivot, pivot, vec3());
    expect(w).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('allows out to alias the input', () => {
    const f = frame(vec3(1, 0, 0), qfromAxisAngle(Y, Math.PI / 2));
    const p = vec3(1, 0, -1);
    frameToLocal(f, vec3(), p, p);
    frameToWorld(f, vec3(), p, p);
    expect(p.x).toBeCloseTo(1);
    expect(p.z).toBeCloseTo(-1);
  });
});

describe('interpolateCarried', () => {
  it('a rider standing still on a turning, moving deck stays glued to the deck at every alpha', () => {
    const pivot = vec3(0, 0, 0);
    const f0 = frame(vec3(0, 48, 0), qfromAxisAngle(Y, 0));
    const f1 = frame(vec3(0.5, 48, -0.2), qfromAxisAngle(Y, 0.3));
    const local = vec3(4, 1, 0); // rider 4 blocks off the pivot
    const prevWorld = frameToWorld(f0, pivot, local, vec3());
    const curWorld = frameToWorld(f1, pivot, local, vec3());
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const fr = frame(lerpVec(f0.position, f1.position, t, vec3()), qslerp(f0.rotation, f1.rotation, t, quat()));
      const out = interpolateCarried(prevWorld, curWorld, f0, f1, fr, pivot, t, vec3(), vec3());
      const expected = frameToWorld(fr, pivot, local, vec3());
      expect(out.x).toBeCloseTo(expected.x, 10);
      expect(out.y).toBeCloseTo(expected.y, 10);
      expect(out.z).toBeCloseTo(expected.z, 10);
    }
    // a plain world lerp would cut the arc's chord: measurably off the deck at t = 0.5
    const fr = frame(lerpVec(f0.position, f1.position, 0.5, vec3()), qslerp(f0.rotation, f1.rotation, 0.5, quat()));
    const naive = lerpVec(prevWorld, curWorld, 0.5, vec3());
    const onDeck = frameToWorld(fr, pivot, local, vec3());
    expect(Math.hypot(naive.x - onDeck.x, naive.z - onDeck.z)).toBeGreaterThan(0.01);
  });

  it('blends the rider’s own walking in the deck frame', () => {
    const pivot = vec3(1, 1, 1);
    const f = frame(vec3(10, 50, 10), qfromAxisAngle(Y, 1));
    const prevWorld = frameToWorld(f, pivot, vec3(0, 0, 0), vec3());
    const curWorld = frameToWorld(f, pivot, vec3(2, 0, 0), vec3());
    const out = interpolateCarried(prevWorld, curWorld, f, f, f, pivot, 0.5, vec3(), vec3());
    const expected = frameToWorld(f, pivot, vec3(1, 0, 0), vec3());
    expect(out.x).toBeCloseTo(expected.x);
    expect(out.z).toBeCloseTo(expected.z);
  });
});

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
