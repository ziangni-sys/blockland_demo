/**
 * Mesh data contract between the mesher (runs in a Worker; pure) and any render backend.
 * The renderer consumes ONLY these plain typed arrays — it never looks at voxel data.
 */

/**
 * Input of one meshing job: a box of cells with a 1-cell margin on every side.
 * The same job format is used for world sections (16^3) and for whole structures.
 *
 * Padded dims: px = sx + 2, py = sy + 2, pz = sz + 2.
 * Index of interior cell (x,y,z) (0-based inside the box):
 *     (x + 1) + (z + 1) * px + (y + 1) * px * pz
 */
export interface MeshInput {
  sx: number;
  sy: number;
  sz: number;
  /**
   * Padded base layer (id + state of each cell's first part), length px*py*pz. Margin cells
   * outside known space should be AIR.
   */
  cells: Uint16Array;
  /**
   * Holes of each cell's first part, same layout as `cells` (docs/SHAPES.md 8.1). null = no cell
   * of this box has holes. (Until the mesher reads it, partial cells mesh as full blocks.)
   */
  holes: Uint8Array | null;
  /** Each cell's second part, same layout as `cells` (0 = none). null = no two-part cell in this box. */
  part2: Uint32Array | null;
  /**
   * Padded light bytes (sky << 4 | block), same layout as `cells`.
   * null = no voxel light available (structures): the mesher emits full sky light (255),
   * zero block light, and still computes ambient occlusion from `cells`.
   */
  light: Uint8Array | null;
}

/**
 * One draw group. Indexed triangles, 4 vertices + 6 indices per quad.
 * Positions are in the box's own space: interior cell (x,y,z) spans [x,x+1]^3.
 *
 * WINDING / CULLING: triangles are counter-clockwise seen from outside. The renderer
 * culls back faces (FrontSide) in ALL passes; anything that must be visible from both
 * sides (plants, helm wheel, propeller blades, liquid faces) is emitted twice by the
 * mesher, as a front and a back copy. Never draw these groups DoubleSide.
 */
export interface GeometryData {
  vertexCount: number;
  indexCount: number;
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz per vertex, components in -127..127 (normalized signed bytes). */
  normals: Int8Array;
  /** uv per vertex, 0..1 across one tile (v = 0 at the bottom of the tile image). */
  uvs: Float32Array;
  /** Texture-array layer (tile id) per vertex. */
  layers: Uint16Array;
  /**
   * 4 bytes per vertex: [sky, block, ao, flags].
   *  sky, block : smooth light 0..255 (255 = level 15)
   *  ao         : ambient occlusion as LINEAR openness: level * 85 (0 = both sides blocked,
   *               255 = open). The renderer owns the brightness curve.
   *  flags      : bit 0 = emissive (ignore lighting)
   *               bit 1 = liquid surface, PER VERTEX: the vertex follows the wave. Set on
   *                       liquid vertices on a free surface (corner height < 1); coincident
   *                       vertices always agree, so a vertical displacement that depends
   *                       only on world xz keeps the liquid watertight.
   *               bit 2 = plant (sway in shader)
   */
  light: Uint8Array;
  indices: Uint32Array;
}

export const VFLAG_EMISSIVE = 1;
export const VFLAG_LIQUID_SURFACE = 2;
export const VFLAG_PLANT = 4;

/** Result of one meshing job. A group is null when it has no geometry. */
export interface MeshData {
  /** Fully opaque faces. */
  opaque: GeometryData | null;
  /** Alpha-tested faces (leaves, glass, plants): opaque pass with discard. */
  cutout: GeometryData | null;
  /** Blended faces (water, ice): drawn after opaque, no depth write. */
  translucent: GeometryData | null;
}

/** Every transferable buffer of a MeshData (for postMessage transfer lists). */
export function meshTransferables(m: MeshData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const g of [m.opaque, m.cutout, m.translucent]) {
    if (!g) continue;
    out.push(
      g.positions.buffer as ArrayBuffer,
      g.normals.buffer as ArrayBuffer,
      g.uvs.buffer as ArrayBuffer,
      g.layers.buffer as ArrayBuffer,
      g.light.buffer as ArrayBuffer,
      g.indices.buffer as ArrayBuffer,
    );
  }
  return out;
}

/** The buffers of a MeshInput (for the postMessage transfer list of a meshing job): every layer that is not null. */
export function meshInputTransferables(input: MeshInput): ArrayBuffer[] {
  const out: ArrayBuffer[] = [input.cells.buffer as ArrayBuffer];
  if (input.holes !== null) out.push(input.holes.buffer as ArrayBuffer);
  if (input.part2 !== null) out.push(input.part2.buffer as ArrayBuffer);
  if (input.light !== null) out.push(input.light.buffer as ArrayBuffer);
  return out;
}

// ---- worker protocol (src/mesh/worker.ts)

export interface MeshRequest {
  type: 'mesh';
  /** Opaque job id echoed back. */
  id: number;
  input: MeshInput;
}
export interface MeshResponse {
  type: 'mesh';
  id: number;
  data: MeshData;
  /**
   * Set when the job failed. `data` is then empty and the client must KEEP the mesh it
   * already shows (a legitimately empty section has no `error`).
   */
  error?: string;
}
