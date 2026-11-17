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

/**
 * Pedestal of the helm. The world mesher maps this tile onto a partial box (x, z in 4..12/16,
 * height 10/16) with position-derived uvs, so only two windows of it are ever seen:
 *   sides : columns 4..11, rows 6..15
 *   top   : columns 4..11, rows 4..11 (the bottom face samples the same rows)
 * The windows overlap in rows 6..11, so anything horizontal there would show on the top as
 * a stripe. The brass band therefore sits at the foot (rows 12..14), below the top window,
 * and rows 4..11 hold nothing but vertical staves.
 */
const paintHelmBase: Painter = (c, seed) => {
  const r = M.HELM_WOOD;
  const f = new Field();
  f.each((x, y) => {
    const stave = x >> 2;
    const col = x & 3;
    // Vertical staves, grain along v. Columns 4 and 11 are a stave's lit first column and
    // a seam, so each pedestal face gets a lit left and a shaded right edge.
    let t = 2 + (vnoise(x + stave * 3, y, 16, 3, seed + stave) - 0.5) * 1.0;
    if (col === 0) t += 0.55;
    if (col === 3) t = 0.5; // seam between staves
    return t;
  });
  paintField(c, f, r);
  // Brass foot band: lit upper lip, body, shaded lower lip, then the contact shadow.
  for (let x = 0; x < S; x++) {
    c.set(x, 12, M.BRASS[3]!);
    c.set(x, 13, M.BRASS[hrand(x, 13, seed) > 0.8 ? 3 : 2]!);
    c.set(x, 14, M.BRASS[1]!);
    c.set(x, 15, r[0]!);
  }
  // Rivets, symmetric inside both the mesher's (4..11) and the icon's (5..10) column window.
  for (const x of [6, 9]) {
    c.set(x, 13, M.BRASS[4]!);
    c.set(x, 14, M.BRASS[0]!);
  }
};

/**
 * Which part of the ship's wheel a texel belongs to, from its distance to the tile centre
 * (a >= b >= 0, half-integers: the design is defined on one octant and mirrored 8 ways).
 * The rim is the classic 12-px pixel circle; axis spokes are 2 px wide (centred on a texel
 * corner they cannot be 1 px), diagonal spokes the 1-px diagonals through the centre.
 */
type WheelPart = 'hub' | 'rim' | 'axis' | 'axisHandle' | 'diag' | 'diagHandle' | null;
function wheelPart(a: number, b: number): WheelPart {
  if (a <= 1.5 && !(a === 1.5 && b === 1.5)) return 'hub';
  if ((a === 5.5 && b <= 1.5) || (a === 4.5 && (b === 2.5 || b === 3.5))) return 'rim';
  if (b === 0.5) return a <= 4.5 ? 'axis' : a >= 6.5 ? 'axisHandle' : null;
  if (a === b) return a <= 3.5 ? 'diag' : a <= 5.5 ? 'diagHandle' : null;
  return null;
}

/**
 * Ship's wheel on a transparent background, symmetric about the tile centre (8, 8): the
 * mesher maps the whole tile onto a quad centred on the wheel's axle, so the hub must sit
 * exactly at uv (0.5, 0.5) or the wheel would hang off-centre (and wobble if it ever turns).
 * Eight spokes, handles past the rim with dark knob ends, a round brass hub; lit from the
 * top-left like every other tile.
 */
const paintHelmWheel: Painter = (c) => {
  c.clear();
  const wood = M.HELM_WOOD;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const [ox, oy] = centreOffset(x, y);
      const ax = Math.abs(ox);
      const ay = Math.abs(oy);
      const part = wheelPart(Math.max(ax, ay), Math.min(ax, ay));
      if (!part) continue;
      if (part === 'hub') {
        const s = ox + oy;
        c.set(x, y, M.BRASS[s < -1 ? 4 : s < 0 ? 3 : s < 1.5 ? 2 : 1]!);
        continue;
      }
      const r = Math.sqrt(ox * ox + oy * oy);
      const light = -(ox + oy) / r; // +1 toward the top-left
      // The rim is the boldest part (it is what makes a wheel read as a wheel); spokes stay a
      // step darker so the four axis spokes do not dominate as a plus sign.
      let t: number;
      if (part === 'rim') t = 2.7 + light * 1.2;
      else if (part === 'axis' || part === 'axisHandle') {
        // Of the two texels across a 2-px spoke, the one nearer the top-left is lit.
        const lit = ax < ay ? ox < 0 : oy < 0;
        t = part === 'axis' ? (lit ? 1.9 : 1.1) : lit ? 2.9 : 1.9;
        if (Math.max(ax, ay) === 7.5) t = lit ? 1.4 : 0.6; // knob end
      } else {
        t = part === 'diag' ? 1.6 + light * 0.4 : 2.6 + light * 0.6;
        if (Math.max(ax, ay) === 5.5) t = 1.1; // knob end
      }
      c.set(x, y, wood[toneIndex(t, wood.length)]!);
    }
  }
  c.set(8, 8, M.BRASS[0]!); // axle cap, in the hub's shaded quarter
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

/**
 * One blade, root at the bottom centre, tip at the top, on a transparent background. The
 * mesher maps the whole tile onto each blade quad with the radial axis at u = 0.5, so the
 * root is centred on x = 8 exactly (2 px wide, columns 7..8); the sweep only bends the tip.
 */
const paintPropellerBlade: Painter = (c) => {
  c.clear();
  const inside = (x: number, y: number): boolean => {
    if (y < 0 || y >= S) return false;
    const s = (S - (y + 0.5)) / S; // 0 at the root .. 1 at the tip
    let w = 1.05 + 2.6 * Math.min(1, s / 0.62) * (2 - Math.min(1, s / 0.62));
    if (s > 0.8) w *= Math.sqrt(Math.max(0, 1 - ((s - 0.8) / 0.2) ** 2));
    const xc = 8 + s * s * 0.9; // slight sweep toward the tip
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

/**
 * Torch. Two views share this tile:
 *  - the world mesher's post (src/mesh/mesher.ts tile-art table): a 2/16 x 10/16 stick whose
 *    sides sample columns 7..8 of rows 6..15 and whose top cap samples rows 6..7. That window
 *    alone must read as a torch: a glowing 2x2 head (rows 6..7) on an ember-tipped stick;
 *  - flat sprites (item icon, dropped item): the full tile, where a flame tongue rises from
 *    the head (rows 2..5, plus a halo in columns 6 and 9). Those texels are never sampled by
 *    the post, so they cost nothing in the world.
 */
const paintTorch: Painter = (c) => {
  c.clear();
  const F = M.FLAME;
  const W = M.TORCH_STICK;
  // Stick: lit column 7, shaded column 8, a darker butt at the very bottom.
  for (let y = 9; y < S; y++) {
    c.set(7, y, W[2]!);
    c.set(8, y, W[1]!);
  }
  c.set(8, S - 1, W[0]!);
  // Charred, ember-lit tip of the stick right under the head.
  c.set(7, 8, F[0]!);
  c.set(8, 8, W[0]!);
  // [x, y, flame tone]: head (rows 6..7, the post's top cap) first, then the sprite-only tongue.
  const flame: ReadonlyArray<readonly [number, number, number]> = [
    [7, 6, 3],
    [8, 6, 3],
    [7, 7, 2],
    [8, 7, 2],
    [6, 6, 1],
    [9, 6, 0],
    [6, 5, 1],
    [7, 5, 2],
    [8, 5, 3],
    [9, 5, 1],
    [6, 4, 0],
    [7, 4, 2],
    [8, 4, 2],
    [9, 4, 0],
    [7, 3, 1],
    [8, 3, 2],
    [8, 2, 1],
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
