/**
 * Name tags (EntityRenderState.label): one billboard per player above the head.
 *
 * LOOK. The tag uses the HUD's own visual language (src/ui/styles.ts .bl-hint): a pill of the dark
 * panel ink, a faint brass rim, a brass stripe on its left end and warm-white text with a soft
 * shadow, in the UI's font stack. It is drawn unlit and unfogged (readable at night), depth-tested
 * against everything opaque (hidden behind blocks, ships and bodies) and never writes depth.
 *
 * SIZE. A tag is LABEL_WORLD_HEIGHT blocks tall, but never smaller on screen than LABEL_MIN_PX CSS
 * pixels, so a name stays readable as far as its player can be seen, and never larger than
 * LABEL_MAX_PX, so a player standing a block or two away does not wear a banner (labelHeight).
 *
 * FOG. The tag is not fogged like a surface (it would turn into a sky-coloured smudge); it fades
 * instead, its opacity 1 - the fog factor at its distance (lighting.fogFactor: the distance fog in
 * air, the medium's fog under water or lava), so it goes as its player's body goes into the fog,
 * and is hidden where the fog is opaque. The opacity is per sprite (a per-object uniform read from
 * userData.tagAlpha), so tags sharing a text fade each at its own distance.
 *
 * TEXTURES. Each distinct text is rasterised once into a canvas texture with its own material,
 * shared by every tag showing it and counted: the last release disposes both, so nothing stays
 * behind after players leave or the world closes (LabelCache.size, dispose()). Where no canvas
 * exists (Node, the headless tests) a 1x1 placeholder texture with the measured aspect stands in.
 */
import * as THREE from 'three/webgpu';
import { texture as textureNode, uniform } from 'three/tsl';
import { createFogParams, fogFactor, type FogParams } from './lighting';

/** Height of a tag near the camera (blocks). */
export const LABEL_WORLD_HEIGHT = 0.3;
/** A tag is never drawn smaller than this on screen (CSS pixels of the viewport height). */
export const LABEL_MIN_PX = 15;
/** Nor larger than this (the pill's height at its raster's nominal size is 25 px). */
export const LABEL_MAX_PX = 32;
/** Gap between the top of the head and the bottom of the tag (blocks). */
export const LABEL_GAP = 0.18;
/** Render order in the transparent list: after water (0) and the overlays (60+). */
export const LABEL_RENDER_ORDER = 80;
/** A tag fainter than this (fog) is not drawn. */
const MIN_ALPHA = 0.02;
/** Longest text drawn (code points); the player table allows 24 (MAX_NAME_LENGTH). */
const LABEL_MAX_CHARS = 24;

/** Raster layout, in texture pixels (2x the size at which the tag is usually seen). */
const FONT_PX = 30;
const PAD_X = 22;
const PAD_Y = 10;
const STRIPE = 5;
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Zen Hei", sans-serif';
/** The HUD palette (src/ui/styles.ts): --panel-bg-soft, --line-faint, --brass-400, --canvas-50. */
const PANEL = 'rgba(10, 20, 37, 0.74)';
const RIM = 'rgba(214, 170, 88, 0.35)';
const BRASS = '#d5a957';
const TEXT = '#fdf7ea';

/**
 * World height of a tag at `distance` blocks from the camera: LABEL_WORLD_HEIGHT, held between
 * LABEL_MIN_PX and LABEL_MAX_PX of a viewport `viewportPx` CSS pixels tall with a vertical field of
 * view of `fovDeg` degrees.
 */
export function labelHeight(distance: number, fovDeg: number, viewportPx: number): number {
  const perBlock = viewportPx / (2 * Math.tan((Math.max(1, Math.min(179, fovDeg)) * Math.PI) / 360) * Math.max(1e-3, distance));
  return Math.min(LABEL_MAX_PX / perBlock, Math.max(LABEL_WORLD_HEIGHT, LABEL_MIN_PX / perBlock));
}

/** The text a tag shows: control characters out, at most LABEL_MAX_CHARS code points. */
export function labelText(raw: string): string {
  let out = '';
  let n = 0;
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) continue;
    if (n++ >= LABEL_MAX_CHARS) break;
    out += ch;
  }
  return out;
}

/** One rasterised text, shared by every tag showing it. */
export interface LabelEntry {
  readonly text: string;
  readonly material: THREE.SpriteNodeMaterial;
  readonly texture: THREE.Texture;
  /** Width / height of the tag. */
  readonly aspect: number;
  refs: number;
}

interface Raster {
  texture: THREE.Texture;
  aspect: number;
}

type Canvas2D = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): Canvas2D | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/** The pill with its stripe, rim and text; or a placeholder where there is no canvas. */
function rasterize(text: string): Raster {
  const font = `600 ${FONT_PX}px ${FONT_STACK}`;
  const probe = makeCanvas(1, 1);
  const pctx = probe?.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
  if (!probe || !pctx) {
    const t = new THREE.DataTexture(new Uint8Array([10, 20, 37, 190]), 1, 1);
    t.needsUpdate = true;
    return { texture: t, aspect: (Math.max(1, [...text].length) * FONT_PX * 0.6 + 2 * PAD_X) / (FONT_PX + 2 * PAD_Y) };
  }
  pctx.font = font;
  const textW = Math.ceil(pctx.measureText(text).width);
  const h = FONT_PX + 2 * PAD_Y;
  const w = Math.max(h, textW + 2 * PAD_X + STRIPE);
  const canvas = makeCanvas(w, h)!;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const r = h / 2;
  const pill = (inset: number): void => {
    ctx.beginPath();
    ctx.moveTo(r, inset);
    ctx.lineTo(w - r, inset);
    ctx.arc(w - r, r, r - inset, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(r, h - inset);
    ctx.arc(r, r, r - inset, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.closePath();
  };
  ctx.clearRect(0, 0, w, h);
  pill(1);
  ctx.fillStyle = PANEL;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = RIM;
  ctx.stroke();
  // The brass stripe on the left end, clipped to the pill.
  ctx.save();
  pill(1);
  ctx.clip();
  ctx.fillStyle = BRASS;
  ctx.fillRect(0, 0, STRIPE + r * 0.35, h);
  ctx.fillStyle = PANEL;
  ctx.fillRect(STRIPE, 0, r * 0.35 + 1, h);
  ctx.restore();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1.5;
  ctx.fillStyle = TEXT;
  ctx.fillText(text, (w + STRIPE) / 2, h / 2 + 1);
  const t = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  return { texture: t, aspect: w / h };
}

/** The per-sprite opacity node: userData.tagAlpha of the sprite drawn (NameTag.place). */
function tagAlphaNode(): THREE.Node {
  return uniform(1).onObjectUpdate((frame) => {
    const a = (frame.object?.userData as { tagAlpha?: number } | undefined)?.tagAlpha;
    return a ?? 1;
  });
}

/**
 * Material of one tag: the canvas holds sRGB already and the renderer writes to the canvas with no
 * conversion (backend.ts init), so the texel goes out as it is; its alpha times the sprite's fade.
 */
function labelMaterial(tex: THREE.Texture, alpha: THREE.Node | null): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial();
  m.name = 'name-tag';
  m.lights = false;
  m.fog = false;
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = true;
  m.sizeAttenuation = true;
  m.colorNode = textureNode(tex);
  if (alpha !== null) m.opacityNode = alpha;
  return m;
}

/** Counted cache of rasterised texts. */
export class LabelCache {
  private readonly entries = new Map<string, LabelEntry>();
  /** The fade of the sprite being drawn, shared by every material of the cache. */
  private readonly alpha = tagAlphaNode();

  /** Entries alive (texts shown by at least one tag). */
  get size(): number {
    return this.entries.size;
  }

  /** The entry of `text` with one more reference. */
  acquire(text: string): LabelEntry {
    let e = this.entries.get(text);
    if (e === undefined) {
      const r = rasterize(text);
      e = { text, material: labelMaterial(r.texture, this.alpha), texture: r.texture, aspect: r.aspect, refs: 0 };
      this.entries.set(text, e);
    }
    e.refs++;
    return e;
  }

  /** One reference less; the last one disposes the texture and the material. */
  release(e: LabelEntry): void {
    if (--e.refs > 0) return;
    if (this.entries.get(e.text) === e) this.entries.delete(e.text);
    e.texture.dispose();
    e.material.dispose();
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      e.texture.dispose();
      e.material.dispose();
      e.refs = 0;
    }
    this.entries.clear();
  }
}

/** Where the camera is and how it projects, for the tags' screen size (EntityLayer.animate). */
export interface LabelView {
  /** Camera, world. */
  x: number;
  y: number;
  z: number;
  fov: number;
  /** Viewport height, CSS pixels. */
  viewportPx: number;
  /** The fog the tags fade with (read during EntityLayer.animate only). */
  fog: Readonly<FogParams>;
}

/** A view with no fog to speak of (the backend hands its own fog in). */
export function labelView(): LabelView {
  const fog = createFogParams();
  fog.start = 1e9;
  fog.end = 2e9;
  return { x: 0, y: 0, z: 0, fov: 75, viewportPx: 540, fog };
}

/**
 * The tag of one player view: a sprite under the view's root, its text acquired from the cache
 * while shown. place() puts its bottom `top` blocks above the feet and sizes it for the camera.
 */
export class NameTag {
  readonly sprite: THREE.Sprite;
  private entry: LabelEntry | null = null;
  /** The raw text last passed to setText. */
  private raw: string | null = null;

  constructor(
    private readonly cache: LabelCache,
    placeholder: THREE.SpriteNodeMaterial,
  ) {
    this.sprite = new THREE.Sprite(placeholder);
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = LABEL_RENDER_ORDER;
    this.sprite.visible = false;
    this.sprite.name = 'name-tag';
  }

  /** The text shown (null = none). */
  get text(): string | null {
    return this.entry?.text ?? null;
  }

  /**
   * Show `raw` (null hides the tag and lets go of its text). Called every frame: the same raw
   * text returns before anything is made (labelText builds a new string).
   */
  setText(raw: string | null): void {
    if (raw === this.raw) return;
    this.raw = raw;
    const text = raw === null ? null : labelText(raw);
    if (text === (this.entry?.text ?? null) || (text === '' && this.entry === null)) return;
    if (this.entry !== null) {
      this.cache.release(this.entry);
      this.entry = null;
    }
    if (text !== null && text !== '') {
      this.entry = this.cache.acquire(text);
      this.sprite.material = this.entry.material;
    }
  }

  /**
   * Bottom of the tag at local height `top` over the feet at world (x, y, z); sized for `view`,
   * faded with its fog (userData.tagAlpha); hidden without text or where the fog is opaque.
   */
  place(x: number, y: number, z: number, top: number, view: LabelView): void {
    const e = this.entry;
    if (e === null) {
      this.sprite.visible = false;
      return;
    }
    const dx = x - view.x;
    const dy = y + top - view.y;
    const dz = z - view.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const alpha = 1 - fogFactor(view.fog, d);
    if (!(alpha >= MIN_ALPHA)) {
      this.sprite.visible = false;
      return;
    }
    const h = labelHeight(d, view.fov, view.viewportPx);
    this.sprite.userData.tagAlpha = alpha;
    this.sprite.visible = true;
    this.sprite.position.set(0, top, 0);
    this.sprite.scale.set(h * e.aspect, h, 1);
  }

  /** Let go of the text (the view is released or disposed). */
  release(): void {
    this.setText(null);
    this.sprite.visible = false;
  }
}

/** The material sprites have before their first text (never drawn: they are hidden). */
export function placeholderLabelMaterial(): THREE.SpriteNodeMaterial {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  return labelMaterial(t, null);
}
