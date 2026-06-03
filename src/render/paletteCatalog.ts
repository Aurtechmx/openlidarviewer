/**
 * paletteCatalog.ts
 *
 * The user-facing catalogue of elevation palettes — the built-in
 * perceptual ramps already in `colorModes.ts` plus a runtime registry
 * for custom user-defined palettes from the Palette Editor (A.4).
 *
 * Custom palettes are 2..8 control points, each a `[t, r, g, b]` tuple
 * with `t` in [0, 1] and r/g/b in [0, 255]. The editor builds the array
 * in monotonic-t order; the catalogue validates the shape on add and
 * stores it under a unique id so the picker and the runtime colour
 * pipeline read it through the same seam as the built-ins.
 *
 * Pure data — no DOM, no three.js — so the catalogue ships through the
 * same module-graph seam every Stream A item already uses.
 */

import type { ElevationPalette } from './colorModes';

/** Control point in a custom ramp — `[t, r, g, b]`. */
export type PaletteControlPoint = readonly [number, number, number, number];

/** A registered custom palette. */
export interface CustomPalette {
  /** Unique id — used as the `ElevationPalette | string` payload. */
  readonly id: string;
  /** Human label shown in the picker. */
  readonly label: string;
  /** Monotonic-t control points; the picker renders a swatch from these. */
  readonly stops: ReadonlyArray<PaletteControlPoint>;
  /** Whether the palette was tagged colour-blind safe by the editor. */
  readonly colorblindSafe: boolean;
}

/** Built-in named presets that ship with the app. Display labels + short blurbs. */
export interface BuiltinPaletteMeta {
  readonly id: ElevationPalette;
  readonly label: string;
  readonly description: string;
  /** Whether the palette is fully colour-blind safe. */
  readonly colorblindSafe: boolean;
}

const BUILTINS: ReadonlyArray<BuiltinPaletteMeta> = [
  {
    id: 'cividis',
    label: 'Cividis',
    description: 'Fully colourblind-safe, deep blue → yellow. Best general-purpose default.',
    colorblindSafe: true,
  },
  {
    id: 'viridis',
    label: 'Viridis',
    description: 'Matplotlib default. Dark purple → blue → green → yellow. Partial CVD safety.',
    colorblindSafe: false,
  },
  {
    id: 'inferno',
    label: 'Inferno',
    description: 'Black → purple → orange → yellow. Highest dynamic range; best for terrain.',
    colorblindSafe: false,
  },
  {
    id: 'turbo',
    label: 'Turbo',
    description: 'Spectral rainbow, perceptually-corrected. Wider hue range than viridis.',
    colorblindSafe: false,
  },
  {
    id: 'classic',
    label: 'Classic',
    description: 'Blue → green → red rainbow. Legacy LiDAR convention; not perceptually uniform.',
    colorblindSafe: false,
  },
];

/** List every built-in palette in display order. */
export function listBuiltinPalettes(): readonly BuiltinPaletteMeta[] {
  return BUILTINS;
}

/** Look up a built-in palette meta. */
export function getBuiltinPalette(id: ElevationPalette): BuiltinPaletteMeta {
  return BUILTINS.find((p) => p.id === id) ?? BUILTINS[0];
}

// ── custom palette registry (in-memory) ─────────────────────────────────────

const customs = new Map<string, CustomPalette>();

/** Validate a control-point series. Throws on bad shape. */
export function validateCustomStops(stops: ReadonlyArray<PaletteControlPoint>): void {
  if (stops.length < 2) {
    throw new Error('Custom palette needs at least 2 control points.');
  }
  if (stops.length > 8) {
    throw new Error('Custom palette accepts at most 8 control points.');
  }
  let lastT = -Infinity;
  for (let i = 0; i < stops.length; i++) {
    const [t, r, g, b] = stops[i];
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      throw new Error(`Stop ${i}: t must be a number in [0, 1].`);
    }
    if (t <= lastT) {
      throw new Error(`Stops must be strictly monotonic in t (stop ${i} violates).`);
    }
    lastT = t;
    for (const c of [r, g, b]) {
      if (!Number.isFinite(c) || c < 0 || c > 255) {
        throw new Error(`Stop ${i}: r/g/b must be numbers in [0, 255].`);
      }
    }
  }
}

/** Register a custom palette. Throws on shape failure; returns the registered entry. */
export function registerCustomPalette(palette: CustomPalette): CustomPalette {
  if (!palette.id || palette.id.length === 0) {
    throw new Error('Custom palette id must be a non-empty string.');
  }
  if (!palette.label || palette.label.length === 0) {
    throw new Error('Custom palette label must be a non-empty string.');
  }
  validateCustomStops(palette.stops);
  customs.set(palette.id, palette);
  return palette;
}

/** Remove a custom palette. No-op when the id is unknown. */
export function unregisterCustomPalette(id: string): void {
  customs.delete(id);
}

/** Look up a custom palette by id, or undefined when not found. */
export function getCustomPalette(id: string): CustomPalette | undefined {
  return customs.get(id);
}

/** List every registered custom palette. */
export function listCustomPalettes(): readonly CustomPalette[] {
  return [...customs.values()];
}

/** Clear every custom palette — test-only helper. */
export function clearCustomPalettes(): void {
  customs.clear();
}
