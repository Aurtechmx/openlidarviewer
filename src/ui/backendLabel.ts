/**
 * backendLabel.ts — the canonical human name for a GPU backend.
 *
 * The tool dock and the debug overlay both display which backend the renderer
 * initialised, and they had drifted apart ("WebGL2" vs "WebGL 2"). One helper
 * gives both the same string, so the two readouts can never disagree.
 */

/** The backend the renderer is on, or null before it has initialised. */
export type GpuBackend = 'webgpu' | 'webgl2';

/** The display label for a backend; an em dash when it is not yet known. */
export function backendLabel(backend: GpuBackend | null): string {
  if (backend === 'webgpu') return 'WebGPU';
  if (backend === 'webgl2') return 'WebGL 2';
  return '—';
}
