/**
 * Harness-only "offscreen" mode (URL offscreen=1): every renderer.render() goes into a render
 * target instead of the canvas; `window.offscreenSnapshot()` reads the last frame back and
 * paints it into a 2D canvas on top of the page (call it before taking a screenshot).
 *
 * Why: some environments (headless Chromium on SwiftShader) hand out a WebGPU device that is
 * lost the moment a frame is PRESENTED to a canvas, while rendering into textures works. This
 * mode lets the harness exercise and screenshot the real WebGPU pipelines there. It patches
 * the shared three.js module from the outside; the backend itself is untouched. Pipelines
 * are compiled again for the render target's format, so pipeline counts differ in this mode.
 */
import * as THREE from 'three/webgpu';

interface Patched {
  __blRT?: THREE.RenderTarget;
}

export function installOffscreen(view: HTMLCanvasElement): void {
  const out = document.createElement('canvas');
  out.id = 'offscreen-view';
  out.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;display:block;pointer-events:none';
  document.body.appendChild(out);
  const ctx2d = out.getContext('2d')!;
  let last: (THREE.WebGPURenderer & Patched) | null = null;
  const proto = THREE.WebGPURenderer.prototype as unknown as { render(this: THREE.WebGPURenderer & Patched, scene: THREE.Object3D, camera: THREE.Camera): void };
  const render = proto.render;
  proto.render = function (this: THREE.WebGPURenderer & Patched, scene: THREE.Object3D, camera: THREE.Camera): void {
    const w = Math.max(1, view.width);
    const h = Math.max(1, view.height);
    let rt = this.__blRT;
    if (!rt || rt.width !== w || rt.height !== h) {
      rt?.dispose();
      rt = new THREE.RenderTarget(w, h, { samples: 4 });
      this.__blRT = rt;
    }
    this.setRenderTarget(rt);
    render.call(this, scene, camera);
    this.setRenderTarget(null);
    last = this;
  };
  (window as unknown as { offscreenSnapshot(): Promise<boolean> }).offscreenSnapshot = async (): Promise<boolean> => {
    const r = last;
    const rt = r?.__blRT;
    if (!r || !rt) return false;
    const w = rt.width;
    const h = rt.height;
    const px = (await r.readRenderTargetPixelsAsync(rt, 0, 0, w, h)) as Uint8Array;
    out.width = w;
    out.height = h;
    const img = ctx2d.createImageData(w, h);
    // WebGL reads the bottom row first, WebGPU the top row.
    const flip = (r.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true;
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      const src = (flip ? h - 1 - y : y) * row;
      img.data.set(px.subarray(src, src + row), y * row);
    }
    ctx2d.putImageData(img, 0, 0);
    return true;
  };
}
