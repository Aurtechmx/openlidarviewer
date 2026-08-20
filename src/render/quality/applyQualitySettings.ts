/**
 * applyQualitySettings.ts
 *
 * The one place a resolved {@link QualitySettings} is pushed at the renderer.
 *
 * The host is structural — the four members below, not the `Viewer` class — so
 * the apply order is testable in Node against a recording double, and so this
 * module carries no three.js dependency into the startup shell.
 *
 * Order matters: the pixel-ratio ceiling is written BEFORE the frame request,
 * because the render loop reads the ceiling once per frame and a request that
 * arrived first would repaint at the old resolution.
 */

import { setMaxPixelRatio } from './pixelRatioCeiling';
import type { QualitySettings } from './qualityPolicy';
import type { StreamingQuality } from '../streaming/streamingBudget';

/** The renderer surface the quality control drives. Satisfied by `Viewer`. */
export interface QualityRenderHost {
  setEdlEnabled(on: boolean): void;
  setAntialiasing(on: boolean): void;
  setStreamingQuality(quality: StreamingQuality, isMobile: boolean): void;
  requestFrame(): void;
}

/**
 * Apply display + streaming settings to the renderer.
 *
 * `setStreamingQuality` is a no-op while no cloud is streaming, which is why
 * the shell also keeps the preset in its own state for the next open — the
 * scheduler is constructed with it.
 */
export function applyQualitySettings(
  host: QualityRenderHost,
  settings: QualitySettings,
  isMobile: boolean,
): void {
  setMaxPixelRatio(settings.maxPixelRatio);
  host.setEdlEnabled(settings.edlEnabled);
  host.setAntialiasing(settings.antialiasing);
  host.setStreamingQuality(settings.streamingQuality, isMobile);
  host.requestFrame();
}
