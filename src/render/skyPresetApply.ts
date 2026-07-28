/**
 * skyPresetApply.ts
 *
 * Apply a sky preset to the scene, the renderer clear colour, and the canvas
 * parent's CSS. Extracted from Viewer so the preset stack owns its own
 * application path and the viewer monolith stops growing to hold it.
 *
 * Returns whether the phone layout was used, which the caller stores so a
 * later resize can tell the two CSS layers apart.
 */

import * as THREE from 'three';

import { getSkyDefinition } from './skyPresets';
import type { SkyPreset } from './inspectionPresets';

/** The parts of the Viewer this needs. Structural, so a test can pass a stub. */
export interface SkyHost {
  readonly scene: THREE.Scene;
  readonly renderer: { setClearColor(c: THREE.Color, a: number): void };
  readonly canvas: HTMLCanvasElement | null | undefined;
}

/**
 * Apply a sky preset to the scene + the canvas container CSS.
 *
 * The renderer is opaque (`alpha: false`), so the canvas paints over
 * any CSS background set on its DOM parent. The user only sees what
 * `scene.background` clears to each frame. Setting both means:
 *   - `scene.background` is the source of truth the user sees
 *   - the parent CSS background acts as a fallback for any non-render
 *     edges (sheet transitions, resize blits) and matches the in-app
 *     reading so screenshots and HTML embeds stay coherent.
 *
 * Radial-gradient presets fall back to their flat `fallbackColor`
 * when fed into `scene.background` because Three.js takes a solid
 * Color or a Texture there — CSS gradients can't render against a
 * WebGPU clear. The fallback colour is chosen to match the centre
 * of the gradient so the visual difference reads small.
 */
export function applySkyPreset(sky: SkyPreset, host: SkyHost): boolean {
  const def = getSkyDefinition(sky);
  const color = new THREE.Color(def.fallbackColor);
  // Three places need the new colour or the user sees nothing:
  //   1. scene.background — what `renderer.render(scene, camera)`
  //      clears to when EDL is OFF and the renderer paints direct.
  //   2. renderer.clearColor — what the EDL post-pipeline pass
  //      framebuffer clears to when EDL is ON. Without this the
  //      pass clears to the renderer default (opaque black) and
  //      the scene.background change is invisible while EDL is on.
  //   3. parent CSS background — sheet-edge fallback during resize
  //      / transitions and the source we read back in screenshot
  //      composition for in-context image exports.
  host.scene.background = color;
  host.renderer.setClearColor(color, 1.0);
  const canvas = host.canvas;
  if (!canvas) return false;
  const parent = canvas.parentElement;
  if (!parent) return false;
  // Device-aware CSS layer.
  //   Desktop (≥ 768 px) — apply the rich radial gradient. The wide
  //     canvas viewport carries the gradient without leaking under
  //     UI chrome.
  //   Phone (< 768 px) — apply only the flat fallback colour. On
  //     phones the Inspector becomes a bottom-sheet covering ~54 %
  //     of the viewport; a radial gradient extending behind the
  //     sheet edge or the topbar reads as visual leakage. The flat
  //     colour confines the visible background to the canvas area
  //     and matches what the renderer is clearing to anyway.
  const isPhone =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767px)').matches;
  parent.style.background = isPhone ? def.fallbackColor : def.background;
  parent.style.backgroundColor = def.fallbackColor;
  return isPhone;
}
