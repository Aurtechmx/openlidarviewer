/**
 * presetApplication.ts
 *
 * Apply an inspection preset, and report what actually took effect.
 *
 * The application used to sit inline in `Viewer.applyPreset()`, which made it
 * unreachable from a Node test: everything around it needs three.js and a
 * canvas. The preset itself is data and the application is a fixed sequence of
 * setter calls, so both are testable once the setters arrive through a host
 * interface. That is the whole reason this module exists — the Viewer keeps
 * owning the setters, this module owns the order and the reporting.
 *
 * Two properties matter enough to be structural rather than remembered:
 *
 *   - The host carries NO camera control, so applying a preset cannot move the
 *     view. A preset changes how a scan looks, never where the analyst is
 *     standing.
 *   - The host carries no way to lock a control, so every knob a preset touches
 *     stays editable by hand afterwards. A preset is a starting point.
 */

import {
  applyPresetColorMode,
  type ColorModeApplication,
  type ColorModeHost,
} from './colorModeSupport';
import { getPreset, type InspectionPreset, type PresetId, type SkyPreset } from './inspectionPresets';
import type { PointSizeMode } from './pointStyle';

/**
 * The controls a preset drives, plus the colour-mode host.
 *
 * Structural and deliberately narrow, so a test can pass a recording literal
 * and so the absence of a camera setter is enforced by the type rather than by
 * a comment. Nothing here corresponds to `ReservedPresetCapabilities`: those
 * fields have no setter to name.
 */
export interface PresetApplyHost {
  /** The per-layer / streaming colour-mode surface. */
  readonly colorHost: ColorModeHost;
  setEdlEnabled(on: boolean): void;
  setEdlStrength(strength: number): void;
  setPointSize(size: number): void;
  setPointSizeMode(mode: PointSizeMode): void;
  applySky(sky: SkyPreset): void;
}

/**
 * What applying a preset achieved.
 *
 * `partial` is the field a caller has to read before saying the preset is
 * active. Everything except the colour mode always applies, so a shortfall can
 * only come from the colour mode, and `colorMode` says which layers refused it.
 */
export interface PresetApplication {
  /** The preset that was applied. Resolved, so an unknown id reports the fallback. */
  readonly presetId: PresetId;
  /** The preset record whose values were pushed through the host. */
  readonly preset: InspectionPreset;
  /** Per-layer and streaming outcome of the colour-mode move. */
  readonly colorMode: ColorModeApplication;
  /** True when the scene is not fully in the state the preset describes. */
  readonly partial: boolean;
}

/**
 * Push a preset's applied fields through `host` and report the outcome.
 *
 * An unknown id resolves to the default preset (`getPreset`), so this is safe to
 * call from prefs or a session import carrying an older or third-party id.
 *
 * Only the fields with a live setter behind them are pushed. The values under
 * `preset.reserved` are read by nothing here on purpose: there is no setter to
 * call, so pretending to apply them would be the bug this module exists to
 * avoid.
 */
export function applyInspectionPreset(
  host: PresetApplyHost,
  id: PresetId | string,
): PresetApplication {
  const preset = getPreset(id);
  host.setEdlEnabled(preset.edlEnabled);
  host.setEdlStrength(preset.edlStrength);
  host.setPointSize(preset.pointSize);
  host.setPointSizeMode(preset.pointSizeMode);
  host.applySky(preset.sky);
  const colorMode = applyPresetColorMode(host.colorHost, preset.defaultColorMode);
  return { presetId: preset.id, preset, colorMode, partial: colorMode.partial };
}
