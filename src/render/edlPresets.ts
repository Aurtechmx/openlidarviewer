/**
 * edlPresets.ts
 *
 * Named EDL (Eye-Dome Lighting) bundles a one-tap pick can apply.
 * v0.3.7 visual-fidelity pass adds three named presets — Subtle,
 * Balanced, Inspection — that bundle EDL strength + adaptive-mode +
 * radius so the analyst can switch the depth response without reaching
 * into three sliders.
 *
 * Pure data — no DOM, no three.js — so the catalogue ships through
 * the same module-graph seam every Stream A leaf uses. The renderer
 * reads the chosen bundle through the same `setEdlStrength` / radius
 * setters that already exist.
 */

/** Named EDL preset ids. */
export type EdlPresetId = 'subtle' | 'balanced' | 'inspection';

/** A single named EDL preset bundle. */
export interface EdlPreset {
  readonly id: EdlPresetId;
  readonly label: string;
  readonly description: string;
  /** EDL strength multiplier in [0, 2]. The renderer reads this as is. */
  readonly strength: number;
  /** EDL kernel radius in pixels. Smaller = sharper edges, more sparkle. */
  readonly radius: number;
  /**
   * Whether the renderer's adaptive EDL stage should scale this
   * strength with zoom + density. `true` for Subtle and Balanced;
   * `false` for Inspection (the analyst gets full depth response
   * regardless of zoom).
   */
  readonly adaptive: boolean;
}

const PRESETS: ReadonlyArray<EdlPreset> = [
  {
    id: 'subtle',
    label: 'Subtle',
    description: 'Minimal enhancement — the cloud reads naturally, EDL only nudges crevice contrast.',
    strength: 0.35,
    radius: 1.4,
    adaptive: true,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Default — clear depth response without the over-shaded "cinema look".',
    strength: 0.7,
    radius: 1.6,
    adaptive: true,
  },
  {
    id: 'inspection',
    label: 'Inspection',
    description: 'Maximum depth perception — strong edges for fine geometry review.',
    strength: 1.2,
    radius: 2.0,
    adaptive: false,
  },
];

/** List every EDL preset in display order. */
export function listEdlPresets(): readonly EdlPreset[] {
  return PRESETS;
}

/** Look up a preset by id; falls back to Balanced for unknown ids. */
export function getEdlPreset(id: EdlPresetId): EdlPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[1];
}

/** Type-guard for an unknown string. */
export function isEdlPresetId(v: unknown): v is EdlPresetId {
  return (
    typeof v === 'string' && (v === 'subtle' || v === 'balanced' || v === 'inspection')
  );
}
