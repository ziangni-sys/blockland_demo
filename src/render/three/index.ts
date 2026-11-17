/**
 * three.js render backend (WebGPU renderer with node materials, WebGL2 fallback).
 * The client creates it with createThreeBackend() and drives it only through RenderBackend.
 */
import type { RenderBackend } from '../backend';
import { ThreeBackend, type ThreeBackendOptions } from './backend';

export type { DeviceLostInfo, ThreeBackendOptions } from './backend';
export { BackendDisposedError, ThreeBackend } from './backend';

/**
 * Creates the backend. Options are optional and default to: WebGPU when available and able
 * to present (WebGL2 otherwise), MSAA on, high-performance adapter, no loss callback.
 */
export function createThreeBackend(options: ThreeBackendOptions = {}): RenderBackend {
  return new ThreeBackend(options);
}
