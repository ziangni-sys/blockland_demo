/**
 * Render backend contract. The client drives a backend through this interface only; the
 * backend consumes mesh + material data and never touches simulation objects
 * (docs/DESIGN.md: "渲染层必须独立，只消费网格和材质数据，将来可以整层替换").
 *
 * All positions are WORLD space unless stated otherwise. Angles in radians.
 * Camera convention: yaw 0 looks toward -Z, yaw grows turning left; pitch > 0 looks up.
 */
import type { MeshData } from '../mesh/types';

export interface BackendInfo {
  api: 'webgpu' | 'webgl2';
  /** Human-readable adapter / renderer string for the debug overlay. */
  detail: string;
}

/** Tile textures: `count` square RGBA8 images of `size` px, concatenated layer after layer. */
export interface TileTextureData {
  size: number;
  count: number;
  /** length = size*size*4*count. Row 0 is the TOP row of each tile image. */
  pixels: Uint8Array;
}

export interface CameraState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Vertical field of view in degrees. */
  fov: number;
}

export interface EnvironmentState {
  /** 0..1 over a day. 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight. */
  dayTime: number;
  /** Medium the camera is in. */
  submerged: 'none' | 'water' | 'lava';
  /** View distance in blocks; fog is fitted to it. */
  viewDistance: number;
  /** Seconds since start, for shader animation (waves, sway). */
  time: number;
}

export type EntityKind = 'player' | 'item' | 'falling' | 'tnt' | 'rabbit';

/**
 * How a player model holds itself: standing / walking, sneaking (bent), sprinting (leaning
 * forward), flying (legs trailing), or seated at a helm with both hands on the wheel.
 */
export type PlayerPosture = 'stand' | 'sneak' | 'sprint' | 'fly' | 'helm';

/**
 * One entity to draw this frame (already interpolated by the client). (x, y, z) is the BOTTOM
 * CENTRE of its body.
 *
 * (vx, vy, vz) is the entity's OWN motion: its velocity relative to whatever carries it (a ship,
 * a rotor, or the world), in world axes, blocks per second. The client measures it from the
 * interpolated position in the carrier's frame, so someone standing on a sailing, turning ship has
 * none and someone walking its deck has their walking speed. It drives the walk and hop
 * animations; the backend does not guess carriers.
 */
export interface EntityRenderState {
  id: number;
  kind: EntityKind;
  x: number;
  y: number;
  z: number;
  /** Body heading (radians, the camera convention). */
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  /**
   * item    : item id shown (block id -> small cube, other -> flat icon)
   * falling : cell being carried
   * others  : unused (0)
   */
  payload: number;
  /** 0..1 white flash (TNT fuse, hurt). */
  flash: number;
  /** Sky / block light at the entity, 0..15 each. */
  sky: number;
  block: number;
  /**
   * Players: where the head looks (world heading and pitch, radians). The head turns from the
   * body up to a limit the model sets (at a helm the body faces the wheel, the head looks around).
   * Others: unused (headYaw = yaw, headPitch 0).
   */
  headYaw: number;
  headPitch: number;
  /** Players: item id in the main hand (0 = empty hand). Others: 0. */
  held: number;
  /** Players: posture. Others: 'stand'. */
  posture: PlayerPosture;
  /**
   * Players: the name tag drawn above the head (plain text, one line; null = none, the own player
   * never has one). The backend draws it as a billboard tag hidden behind whatever is in front of
   * it, kept readable at a distance (a minimum size on screen), unlit (readable at night).
   * Others: null.
   */
  label: string | null;
}

/**
 * A box of local cells of some grid, drawn as an overlay.
 * `structureId` 0 = world space; otherwise the box is in that structure's local space and
 * follows its pose.
 */
export interface OverlayCell {
  structureId: number;
  x: number;
  y: number;
  z: number;
}
export interface OverlayFace extends OverlayCell {
  /** Face direction (Dir 0..5) on the cell. */
  face: number;
  /**
   * Hard blocks on both sides of the face. A covered glued face is drawn as a bead along the
   * joint plus an x-ray ghost. An EXPOSED one (covered false) is drawn as a depth-tested decal
   * lying on the face: then the cell is the hard side and `face` points to the open side.
   */
  covered: boolean;
  /**
   * Light (0..15 each) of the cell on the open side, where the decal of an exposed face lies;
   * the decal is lit like the face under it. World faces carry the world's light there.
   * Structure faces carry sky 15 / block 0: a structure is lit by its pose
   * (StructurePose.sky / block), which the renderer applies on top, as for its mesh.
   * Unused for a covered face.
   */
  sky: number;
  block: number;
}

export interface OverlayState {
  /** Outline around the targeted cell, or null. */
  target: OverlayCell | null;
  /** Mining progress 0..1 drawn on the target cell (0 = none). */
  breakProgress: number;
  /** Cells that will be assembled (preview), tinted. */
  preview: OverlayCell[];
  /** Cells blocking a docking / blockify attempt, tinted red. */
  conflicts: OverlayCell[];
  /**
   * Glued faces to draw near the player: exposed ones always, covered ones while glue is in
   * one of the player's hands (see OverlayFace.covered).
   */
  glue: OverlayFace[];
}

/**
 * Space inside a floating hull where world water must not be drawn
 * (docs/LESSONS.md "船舱里冒出水面": cut the water, do not delete it).
 * A box of local cells of the structure; mask[i] != 0 marks a dry cell.
 * index = (x - ox) + (z - oz) * sx + (y - oy) * sx * sz.
 */
export interface DryVolume {
  ox: number;
  oy: number;
  oz: number;
  sx: number;
  sy: number;
  sz: number;
  mask: Uint8Array;
}

export interface StructurePose {
  /** World position of the structure's pivot. */
  px: number;
  py: number;
  pz: number;
  /** World rotation (unit quaternion). */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Pivot in structure-local space (mesh vertices are local; world = p + q * (v - pivot)). */
  pivotX: number;
  pivotY: number;
  pivotZ: number;
  /** Sky / block light to shade the structure with, 0..15 each. */
  sky: number;
  block: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  sections: number;
  structures: number;
}

/**
 * Call ordering: every method may be called at any time. Calls made before init()
 * resolves are queued (last write wins) and applied when it does; calls after dispose()
 * are no-ops. setSectionMesh / setStructureMesh TAKE OWNERSHIP of the MeshData typed arrays
 * (zero copy): the caller must not modify, recycle or transfer them afterwards.
 * A structure exists from its first setStructureMesh (or non-null setStructureDryVolume)
 * until setStructureMesh(id, ..., null); it stays hidden until its first pose; a pose for an
 * unknown id is kept only for the current frame.
 */
export interface RenderBackend {
  /** Create the GPU context on the canvas. Must fall back to WebGL2 when WebGPU is unavailable. */
  init(canvas: HTMLCanvasElement): Promise<BackendInfo>;
  /** Upload the tile texture array. Called once before any mesh. */
  setTiles(tiles: TileTextureData): void;

  /**
   * Create / replace the mesh of a world section. `key` is the client's section key;
   * (ox,oy,oz) is the world position of the section's local origin.
   * mesh = null removes it.
   */
  setSectionMesh(key: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void;

  /**
   * Create / replace a structure's mesh. Vertices are in structure-local cell space with
   * (ox,oy,oz) added (the local coordinates of the meshed box's origin). null removes the structure.
   */
  setStructureMesh(id: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void;
  /** Per-frame pose of a structure (interpolated). */
  setStructurePose(id: number, pose: StructurePose): void;
  /** Dry volume of a structure (null = none). */
  setStructureDryVolume(id: number, dry: DryVolume | null): void;

  /** Replace the full entity list for this frame. */
  setEntities(list: readonly EntityRenderState[]): void;
  setCamera(cam: CameraState): void;
  setEnvironment(env: EnvironmentState): void;
  setOverlays(o: OverlayState): void;

  resize(width: number, height: number, pixelRatio: number): void;
  /** Draw one frame. */
  render(): void;
  stats(): RenderStats;
  dispose(): void;
}
