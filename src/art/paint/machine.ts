/**
 * Functional blocks: helm, bearing, propeller, torch, blast crate.
 */
import { Canvas, Field, forLine, paintField, toneIndex, wrap } from '../canvas';
import type { Ramp } from '../color';
import * as M from '../materials';
import { hrand, vnoise } from '../noise';
import { S, type Painter } from './kit';

/** Offset of pixel (x, y)'s centre from the tile centre (8, 8). */
function centreOffset(x: number, y: number): [number, number] {
  return [x + 0.5 - 8, y + 0.5 - 8];
}

function tone(r: Ramp, t: number): Ramp[number] {
  return r[toneIndex(t, r.length)]!;
}

// ---------------------------------------------------------------- helm

const paintHelmBase: Painter = (c, seed) => {
  const r = M.HELM_WOOD;
  const f = new Field();
  f.each((x, y) => {
    const stave = x >> 2;
    const col = x & 3;
    // Vertical staves, grain along v.
    let t = 2 + (vnoise(x + stave * 3, y, 16, 3, seed + stave) - 0.5) * 1.0;
    if (col === 0) t += 0.55;
    if (col === 3) t = 0.5; // seam between staves
    if (y === S - 1) t -= 0.9;
    return t;
  });
  paintField(c, f, r);
  // Brass band near the top, with two rivets.
  for (let x = 0; x < S; x++) {
    c.set(x, 2, M.BRASS[4]!);
    c.set(x, 3, M.BRASS[hrand(x, 3, seed) > 0.75 ? 3 : 2]!);
    c.set(x, 4, M.BRASS[1]!);
    c.set(x, 5, r[0]!); // band shadow on the wood
  }
  for (const x of [3, 11]) {
    c.set(x, 3, M.BRASS[4]!);
    c.set(x + 1, 3, M.BRASS[0]!);
  }
};

/**
 * Ship's wheel, 15 px across, centred on pixel (7, 7) so spokes are exact pixel lines:
 * a 1-px rim of radius 5, eight spokes, handles sticking out past the rim, brass hub.
 */
const paintHelmWheel: Painter = (c) => {
  c.clear();
  const wood = M.HELM_WOOD;
  const cx = 7;
  const cy = 7;
  // Spokes and handles: axis spokes reach radius 7, diagonal ones 5 steps (about 7.1).
  const dirs: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 7],
    [-1, 0, 7],
    [0, 1, 7],
    [0, -1, 7],
    [1, 1, 5],
    [-1, 1, 5],
    [1, -1, 5],
    [-1, -1, 5],
  ];
  for (const [dx, dy, n] of dirs) {
    for (let k = 2; k <= n; k++) {
      const r = Math.hypot(dx * k, dy * k);
      const handle = r > 5.5;
      // Handles are lit on their top-left facing side; the outermost pixel is a dark knob end.
      let t = handle ? 3 : 2.2;
      if (k === n) t = 1.2;
      if (handle && dx + dy > 0) t -= 0.6;
      c.set(cx + dx * k, cy + dy * k, wood[toneIndex(t, wood.length)]!);
    }
  }
  // Rim: pixels whose centre lies within half a pixel of radius 5.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ox = x - cx;
      const oy = y - cy;
      const r = Math.sqrt(ox * ox + oy * oy);
      if (Math.abs(r - 5) > 0.55) continue;
      const light = -(ox + oy) / r; // +1 toward the top-left
      c.set(x, y, wood[toneIndex(2.2 + light * 1.3, wood.length)]!);
    }
  }
  // Brass hub.
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      const t = x - cx + y - cy;
      c.set(x, y, M.BRASS[t < 0 ? 4 : t > 0 ? 1 : 3]!);
    }
  }
  c.set(cx, cy, M.BRASS[2]!);
};

// ---------------------------------------------------------------- bearing

/** Steel square with a bevelled 1-px border; `t` is the face tone. */
function steelPlate(c: Canvas, seed: number, t: number): void {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = t + (vnoise(x, y, 2, 16, seed) - 0.5) * 0.5;
      if (x === 0 || y === 0) v = t + 1.2;
      if (x === S - 1 || y === S - 1) v = t - 1.1;
      c.set(x, y, tone(M.STEEL, v));
    }
  }
}

function bolt(c: Canvas, x: number, y: number, r: Ramp = M.STEEL): void {
  c.set(x, y, r[r.length - 1]!);
  c.set(x + 1, y, r[1]!);
  c.set(x, y + 1, r[1]!);
  c.set(x + 1, y + 1, r[0]!);
}

const paintBearingFront: Painter = (c, seed) => {
  steelPlate(c, seed, 1.1);
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const [ox, oy] = centreOffset(x, y);
      const r = Math.sqrt(ox * ox + oy * oy);
      const light = -(ox + oy) / Math.max(r, 0.001);
      if (r > 6.7) continue;
      let t = 2.9 + (vnoise(x, y, 2, 16, seed + 1) - 0.5) * 0.45;
      if (r > 5.8) t = 2.4 + light * 1.4; // raised rim of the turntable
      else if (r > 2.9 && r < 3.7) t = 2.1; // turned groove
      c.set(x, y, tone(M.STEEL, t));
    }
  }
  // Bolt circle.
  for (let k = 0; k < 8; k++) {
    const a = (k + 0.5) * (Math.PI / 4);
    const x = Math.floor(8 + Math.cos(a) * 4.7);
    const y = Math.floor(8 + Math.sin(a) * 4.7);
    c.set(x, y, M.STEEL[4]!);
    c.set(x + 1, y + 1, M.STEEL[1]!);
  }
  // Brass axle boss with a square key socket.
  for (let y = 5; y <= 10; y++) {
    for (let x = 5; x <= 10; x++) {
      const [ox, oy] = centreOffset(x, y);
      const r = Math.sqrt(ox * ox + oy * oy);
      if (r > 2.5) continue;
      c.set(x, y, M.BRASS[-(ox + oy) > 0 ? 3 : 2]!);
    }
  }
  c.set(7, 7, M.STEEL[0]!);
  c.set(8, 7, M.STEEL[0]!);
  c.set(7, 8, M.STEEL[0]!);
  c.set(8, 8, M.BRASS[1]!);
};

const paintBearingBack: Painter = (c, seed) => {
  steelPlate(c, seed, 1.6);
  // Inner bevel: a recessed panel inside a 2-px border.
  for (let i = 2; i < S - 2; i++) {
    c.set(i, 2, M.STEEL[0]!);
    c.set(2, i, M.STEEL[0]!);
    c.set(i, S - 3, M.STEEL[3]!);
    c.set(S - 3, i, M.STEEL[3]!);
  }
  // Vent slots.
  for (const y of [6, 8, 10]) {
    for (let x = 5; x <= 10; x++) {
      c.set(x, y, M.STEEL[0]!);
      c.set(x, y + 1, M.STEEL[3]!);
    }
  }
  bolt(c, 3, 3);
  bolt(c, 11, 3);
  bolt(c, 3, 11);
  bolt(c, 11, 11);
};

const paintBearingSide: Painter = (c, seed) => {
  // Top of the tile = the rotor (front) side: the turntable's edge sits above a seam.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let t: number;
      if (y <= 4) {
        t = 2.9 + (vnoise(x, y, 2, 16, seed) - 0.5) * 0.8;
        if (y === 0) t += 1.1;
        if (y === 4) t -= 0.6;
      } else if (y === 5) {
        t = 0;
      } else {
        t = 1.4 + (vnoise(x, y, 16, 2, seed + 1) - 0.5) * 0.4;
        const col = wrap(x, 4);
        if (col === 1) t += 0.9; // ribs
        if (col === 2) t -= 0.5;
        if (y === 6) t += 0.6;
        if (y === S - 1) t -= 0.8;
      }
      c.set(x, y, tone(M.STEEL, t));
    }
  }
};

// ---------------------------------------------------------------- propeller

const paintPropellerHub: Painter = (c, seed) => {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const [ox, oy] = centreOffset(x, y);
      const r = Math.sqrt(ox * ox + oy * oy);
      const light = -(ox + oy) / Math.max(r, 0.001);
      let t: number;
      if (r > 6.6) {
        t = 1.2 + (hrand(x, y, seed) - 0.5) * 0.4; // backing plate
        if (x === 0 || y === 0) t += 1;
        if (x === S - 1 || y === S - 1) t -= 0.9;
      } else if (r > 5.6) {
        t = 2 - light * 1.2; // the boss is domed: its outer ring shades opposite to the face
      } else {
        t = 2.6 + light * (r / 5.6) * 1.2;
        if (r < 2) t = 3.3 + light * 0.8;
      }
      c.set(x, y, tone(M.BRASS, t));
    }
  }
  c.set(6, 6, M.BRASS[4]!);
  for (const [x, y] of [
    [1, 1],
    [14, 1],
    [1, 14],
    [14, 14],
  ] as const) {
    c.set(x, y, M.BRASS[0]!);
  }
};

/** One blade, root at the bottom centre, tip at the top, on a transparent background. */
const paintPropellerBlade: Painter = (c) => {
  c.clear();
  const inside = (x: number, y: number): boolean => {
    if (y < 0 || y >= S) return false;
    const s = (S - (y + 0.5)) / S; // 0 at the root .. 1 at the tip
    let w = 1.05 + 2.6 * Math.min(1, s / 0.62) * (2 - Math.min(1, s / 0.62));
    if (s > 0.8) w *= Math.sqrt(Math.max(0, 1 - ((s - 0.8) / 0.2) ** 2));
    const xc = 8 + s * 0.9 - 0.4; // slight sweep
    return Math.abs(x + 0.5 - xc) <= w;
  };
  for (let y = 0; y < S; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < S; x++) {
      if (!inside(x, y)) continue;
      if (left < 0) left = x;
      right = x;
    }
    if (left < 0) continue;
    for (let x = left; x <= right; x++) {
      // Leading edge (left) catches the light, a ridge runs down the middle, the trailing
      // edge and the tip are outlined dark so the blade reads against the sky.
      const u = right > left ? (x - left) / (right - left) : 0.5;
      let t = 2.7 - u * 2;
      if (Math.abs(u - 0.45) < 0.2) t += 0.3;
      if (x === right || !inside(x, y - 1)) t = 0.2;
      else if (x === left) t = 3.4;
      c.set(x, y, tone(M.BRASS, t));
    }
  }
};

const paintPropellerBack: Painter = (c, seed) => {
  steelPlate(c, seed + 3, 1.3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const [ox, oy] = centreOffset(x, y);
      const r = Math.sqrt(ox * ox + oy * oy);
      const light = -(ox + oy) / Math.max(r, 0.001);
      if (r <= 3.6 && r > 2.4) c.set(x, y, tone(M.BRASS, 2 + light * 1.3));
      else if (r <= 2.4) c.set(x, y, M.STEEL[r < 1.2 ? 0 : 1]!);
    }
  }
  bolt(c, 2, 2);
  bolt(c, 12, 2);
  bolt(c, 2, 12);
  bolt(c, 12, 12);
};

// ---------------------------------------------------------------- torch

const paintTorch: Painter = (c) => {
  c.clear();
  // The stick is exactly two pixels wide in the centre columns (7, 8): the mesher maps those
  // columns onto a thin post.
  for (let y = 8; y < S; y++) {
    c.set(7, y, M.TORCH_STICK[2]!);
    c.set(8, y, M.TORCH_STICK[1]!);
  }
  c.set(7, 7, M.TORCH_STICK[0]!);
  c.set(8, 7, M.TORCH_STICK[0]!);
  c.set(8, S - 1, M.TORCH_STICK[0]!);
  const F = M.FLAME;
  const flame: ReadonlyArray<readonly [number, number, number]> = [
    [8, 2, 0],
    [7, 3, 1],
    [8, 3, 1],
    [6, 4, 0],
    [7, 4, 2],
    [8, 4, 1],
    [9, 4, 0],
    [6, 5, 1],
    [7, 5, 3],
    [8, 5, 2],
    [9, 5, 1],
    [7, 6, 3],
    [8, 6, 2],
    [9, 1, 0],
  ];
  for (const [x, y, t] of flame) c.set(x, y, F[t]!);
};

// ---------------------------------------------------------------- blast crate

/** Crate face: dark frame, boards (horizontal or vertical), corner bolts. */
function paintCrate(c: Canvas, seed: number, vertical: boolean, shade: number): void {
  const r = M.CRATE_WOOD;
  const f = new Field();
  f.each((x, y) => {
    if (x === 0 || y === 0 || x === S - 1 || y === S - 1) return 0.3 + shade;
    if (x === 1 || y === 1) return 3.1 + shade;
    if (x === S - 2 || y === S - 2) return 1.2 + shade;
    const a = vertical ? x : y;
    const b = vertical ? y : x;
    // 3 boards of 4 px between the frame (2..13), seams at 5 and 9.
    if (a === 5 || a === 9) return 0.7 + shade;
    let t = 2 + (vnoise(vertical ? x : b, vertical ? b : y, vertical ? 16 : 3, vertical ? 3 : 16, seed + Math.floor(a / 4)) - 0.5) * 0.9;
    if (a === 6 || a === 10 || a === 2) t += 0.4;
    return t + shade;
  });
  paintField(c, f, r);
  for (const [x, y] of [
    [1, 1],
    [14, 1],
    [1, 14],
    [14, 14],
  ] as const) {
    c.set(x, y, M.STEEL[3]!);
  }
}

const paintTntSide: Painter = (c, seed) => {
  paintCrate(c, seed, false, 0);
  // Red warning band with diagonal hazard stripes (period 4 wraps horizontally).
  for (let x = 0; x < S; x++) {
    c.set(x, 6, M.WARNING_RED[4]!);
    for (const y of [7, 8]) c.set(x, y, M.WARNING_RED[wrap(x + y, 4) < 2 ? 2 : 1]!);
    c.set(x, 9, M.WARNING_RED[0]!);
    c.set(x, 10, M.CRATE_WOOD[0]!); // band shadow on the boards
  }
};

const paintTntTop: Painter = (c, seed) => {
  paintCrate(c, seed, true, 0.1);
  // Fuse coil: an Archimedean spiral of cord with its end standing up in the middle.
  const coil = new Uint8Array(S * S);
  for (let i = 0; i <= 260; i++) {
    const th = (i / 260) * Math.PI * 4.2;
    const r = 4.3 - th * 0.24;
    const x = Math.floor(8 + Math.cos(th) * r);
    const y = Math.floor(8 + Math.sin(th) * r);
    coil[wrap(y) * S + wrap(x)] = 1;
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (coil[y * S + x]) continue;
      if (coil[wrap(y - 1) * S + wrap(x - 1)] || coil[wrap(y - 1) * S + x]) c.set(x, y, M.CRATE_WOOD[0]!); // shadow
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!coil[y * S + x]) continue;
      const lit = !coil[wrap(y - 1) * S + x] || !coil[y * S + wrap(x - 1)];
      c.set(x, y, M.FUSE[lit ? 2 : 1]!);
    }
  }
  // The fuse end, frayed light tip.
  forLine(8, 7, 9, 5, (x, y) => c.set(x, y, M.FUSE[2]!));
  c.set(9, 4, M.FUSE[3]!);
};

const paintTntBottom: Painter = (c, seed) => paintCrate(c, seed, true, -0.45);

export const MACHINE_PAINTERS: Readonly<Record<string, Painter>> = Object.freeze({
  helm_base: paintHelmBase,
  helm_wheel: paintHelmWheel,
  bearing_front: paintBearingFront,
  bearing_back: paintBearingBack,
  bearing_side: paintBearingSide,
  propeller_hub: paintPropellerHub,
  propeller_blade: paintPropellerBlade,
  propeller_back: paintPropellerBack,
  torch: paintTorch,
  tnt_side: paintTntSide,
  tnt_top: paintTntTop,
  tnt_bottom: paintTntBottom,
});
