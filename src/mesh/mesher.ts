/**
 * The mesher: voxels -> geometry. Pure and deterministic; runs in the mesh Worker and in
 * Node tests. World sections and structures share it (docs/ARCHITECTURE.md).
 *
 * GEOMETRY CONVENTIONS (the render backend relies on these)
 * --------------------------------------------------------
 * Space      Box space of the MeshInput: interior cell (x,y,z) spans [x,x+1]^3. Every
 *            vertex of a cell lies inside that cell's box.
 * Quads      Everything is quads: 4 vertices + 6 indices, no shared vertices. Triangles
 *            are COUNTER-CLOCKWISE seen from the front (outside): the renderer must cull
 *            back faces in EVERY pass (FrontSide). Double-sided parts (plants, helm wheel,
 *            propeller blades, liquid faces) are emitted twice: the front, and a back copy
 *            with reversed winding and negated normal that reuses the same positions, uvs,
 *            light and diagonal. Drawing with DoubleSide would draw those parts twice
 *            (and compound the alpha of blended liquid faces).
 * Normals    Signed bytes, unit length * 127. Axis faces are exactly (+-127, 0, 0) etc.
 * UV         0..1 across one tile, (0,0) = bottom-left of the tile IMAGE, (1,1) = top-right.
 *            Side faces (+-X, +-Z): v grows with +Y; u grows to the viewer's right when the
 *            face is seen from outside (+X: u = 1-z, -X: u = z, +Z: u = x, -Z: u = 1-x),
 *            so tiles are never mirrored. Top (+Y): u = x, v = 1-z (north is up when looking
 *            down). Bottom (-Y): u = x, v = z (looking up, south is up). Partial boxes use
 *            the matching sub-rectangle of the tile (uv derived from position).
 *            Rotated faces: logs turn their side tile so its v direction (the bark grain)
 *            runs along the log axis; bearings turn their side tile so its top points to
 *            the front face.
 * Layers     Texture-array layer = BlockDef.tileIds entry for that face / part.
 * Tile art   What the shapes expect from the painted tiles (image rows counted from the top):
 *              torch            the post is columns 7..8 and the bottom 10 rows (6..15); the
 *                               top cap samples rows 6..7 (the head), the bottom cap 14..15.
 *              propeller_blade  ONE blade, root at the bottom edge, tip at the top edge; each
 *                               of the four blades maps the whole tile.
 *              helm_wheel       the whole wheel, centred, on a transparent background.
 *              log side         grain runs vertically in the image.
 *              bearing side     image "up" points toward the bearing's front face.
 *              cross plants     the whole plant, standing on the bottom edge.
 * Light      4 bytes per vertex [sky, block, ao, flags]:
 *              sky, block  smooth light, level 0..15 scaled by 17 (0..255). Per vertex the
 *                          average of the up-to-4 non-opaque cells touching the vertex in
 *                          the layer just outside the face; the diagonal cell is ignored
 *                          when both side cells are opaque. MeshInput.light === null
 *                          (structures): sky 255, block 0.
 *              ao          LINEAR openness: 255 / 170 / 85 / 0 for 0 / 1 / 2 / 3-or-both-sides
 *                          occluders (classic side1 + side2 + corner rule; only OPAQUE cubes
 *                          occlude). No brightness curve is applied here: the renderer maps
 *                          ao / 255 to brightness with its own curve (lighting.ts aoFactor).
 *              flags       VFLAG_EMISSIVE on every face of a light-emitting block (torch,
 *                          lava, lamp: draw unlit/full bright). VFLAG_PLANT on cross plants
 *                          (uv.v is 0 at the roots, 1 at the tips: scale sway by v).
 *                          VFLAG_LIQUID_SURFACE (per vertex) on every liquid vertex that
 *                          lies on a free surface: the top surface's corners (both sides)
 *                          and the coincident top corners of liquid side faces — except
 *                          corners forced to full height by a falling column, which stay
 *                          pinned. Coincident liquid vertices always agree on the flag, so
 *                          a vertical displacement that depends only on world xz keeps the
 *                          liquid watertight.
 * Diagonal   Each quad is split along its brighter diagonal by AO (ties: by light), which
 *            keeps a lone dark corner from smearing a streak across the quad. Liquid top
 *            surfaces fold along their flatter diagonal instead.
 * Groups     BlockDef.layer picks opaque / cutout / translucent. Double-sided decal parts
 *            (helm wheel, propeller blades) never go to the plain opaque pass: they need
 *            alpha testing, so an 'opaque' block puts them in cutout.
 *
 * CULLING
 * -------
 * A cube face is skipped when the neighbour cell covers it (every OPAQUE cube covers all
 * six faces; a snow-like 'layers' slab in the opaque pass covers the face below it) and
 * between two cells of the same non-opaque full cube (glass, ice, leaves). Faces on the
 * box border are tested against the margin cells. Shapes that only partly fill their cell
 * are culled per part: a part's face is tested only when it lies on the cell boundary.
 * Liquid faces (top, sides, bottom) are double-sided so they are visible from inside the
 * liquid, except where the neighbour draws its own face over the whole shared plane
 * (a full cube, another liquid, ...): only the outward copy is emitted there.
 */
import * as cellBits from '../blocks/cell';
import type { MeshData, MeshInput } from './types';
import { MeshContext } from './shapes/builder';
import * as cubeShapes from './shapes/cube';
import * as liquidShapes from './shapes/liquid';
import * as models from './shapes/models';
import * as tables from './shapes/tables';

// Hot-path imports are bound to module-local constants once, at module init. Module
// runners that implement ES live bindings as getter calls (the Vite/Vitest SSR transform)
// would otherwise pay a call per table read inside the meshing loops; bundles are unaffected.
const { ID_MASK } = cellBits;
const { emitCube } = cubeShapes;
const { LiquidScratch, emitLiquid } = liquidShapes;
const { emitCactus, emitCross, emitHelm, emitLayers, emitPropeller, emitTorch } = models;
const {
  G_CUTOUT,
  G_OPAQUE,
  G_TRANSLUCENT,
  SHAPE,
  SH_AXIS,
  SH_BEARING,
  SH_CACTUS,
  SH_CROSS,
  SH_CUBE,
  SH_HELM,
  SH_LAYERS,
  SH_LIQUID,
  SH_NONE,
  SH_PROPELLER,
  SH_TORCH,
} = tables;

export { AO_BYTE } from './shapes/tables';
export { LIQUID_FULL_HEIGHT } from './shapes/liquid';

function checkInput(input: MeshInput): void {
  const { sx, sy, sz } = input;
  if (!Number.isInteger(sx) || !Number.isInteger(sy) || !Number.isInteger(sz) || sx < 0 || sy < 0 || sz < 0) {
    throw new RangeError(`mesh input: bad dimensions ${sx}x${sy}x${sz}`);
  }
  const n = (sx + 2) * (sy + 2) * (sz + 2);
  if (input.cells.length !== n) {
    throw new RangeError(`mesh input: cells has ${input.cells.length} entries, expected ${n}`);
  }
  if (input.light !== null && input.light.length !== n) {
    throw new RangeError(`mesh input: light has ${input.light.length} entries, expected ${n}`);
  }
}

/**
 * A reusable mesher. Owns growable scratch buffers, so a long-lived instance (the mesh
 * Worker keeps one) builds without reallocating; every MeshData it returns is made of
 * exact-size copies that never alias the scratch. Not safe for concurrent use — there is
 * none in JS — but any sequence of build() calls is independent of the previous ones.
 */
export class Mesher {
  private readonly ctx = new MeshContext();
  private readonly liquid = new LiquidScratch();

  build(input: MeshInput): MeshData {
    checkInput(input);
    const ctx = this.ctx;
    ctx.begin(input);
    try {
      const { sx, sy, sz, cells } = input;
      const px = sx + 2;
      const slab = px * (sz + 2);
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          let p = 1 + (z + 1) * px + (y + 1) * slab;
          for (let x = 0; x < sx; x++, p++) {
            const cell = cells[p]!;
            const id = cell & ID_MASK;
            const shape = SHAPE[id]!;
            if (shape === SH_NONE) continue;
            switch (shape) {
              case SH_CUBE:
              case SH_AXIS:
              case SH_BEARING:
                emitCube(ctx, p, x, y, z, cell, id, shape);
                break;
              case SH_LIQUID:
                emitLiquid(ctx, this.liquid, p, x, y, z, id);
                break;
              case SH_CROSS:
                emitCross(ctx, p, x, y, z, id);
                break;
              case SH_TORCH:
                emitTorch(ctx, p, x, y, z, id);
                break;
              case SH_LAYERS:
                emitLayers(ctx, p, x, y, z, cell, id);
                break;
              case SH_CACTUS:
                emitCactus(ctx, p, x, y, z, id);
                break;
              case SH_HELM:
                emitHelm(ctx, p, x, y, z, cell, id);
                break;
              case SH_PROPELLER:
                emitPropeller(ctx, p, x, y, z, cell, id);
                break;
            }
          }
        }
      }
      const g = ctx.groups;
      return { opaque: g[G_OPAQUE]!.finish(), cutout: g[G_CUTOUT]!.finish(), translucent: g[G_TRANSLUCENT]!.finish() };
    } finally {
      ctx.end();
    }
  }
}

/**
 * Mesh one box of cells (see MeshInput). Pure: the result depends only on `input`, and
 * nothing survives the call. Hot callers should keep a Mesher and call build() instead,
 * which reuses its scratch buffers between jobs.
 */
export function buildMesh(input: MeshInput): MeshData {
  return new Mesher().build(input);
}
