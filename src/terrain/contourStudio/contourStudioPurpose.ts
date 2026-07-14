/**
 * contourStudioPurpose.ts
 *
 * Purpose presets for Contour Studio (v0.5.9 spec §6.2). A purpose is a named
 * bundle of sensible DEFAULTS. Selecting one changes only presentation/product
 * defaults for settings the user has not already overridden — it never raises an
 * evidence level, hides a warning, bypasses a gate, changes a source fact, or
 * invents validation (§6.3). Those live outside this state entirely, so a
 * purpose switch is structurally incapable of touching them.
 */

import {
  baseContourStudioState,
  BASE_GENERALIZE_TOLERANCE_CELLS,
  type ContourStudioPurpose,
  type ContourStudioState,
} from './contourStudioState';

/**
 * Per-purpose generalization strength (cells) — the single source of truth for
 * how hard each purpose simplifies its exported contour geometry. It is the
 * Douglas–Peucker epsilon as a fraction of the grid cell (`ε = tolerance × cell`,
 * applied by the honesty-gated {@link simplifyPolyline}, so a low-confidence or
 * gap vertex is NEVER dropped regardless of the value). The ordering is honest,
 * not cosmetic:
 *
 *   - Survey Review     → 0     EXACT. A review wants the raw analytical isolines;
 *                               0 routes the export to the crisp style (no
 *                               generalization at all), tolerance 0 in provenance.
 *   - Terrain Research  → 0.25  LIGHT. Faithful enough for reproducibility/QA
 *                               while shedding marching-squares stair-steps —
 *                               a quarter-cell of give is below the grid's own
 *                               resolution, so the line stays terrain-legible.
 *   - Engineering Plan  → 0.5   MODERATE. The historical default
 *                               (`BASE_GENERALIZE_TOLERANCE_CELLS`) — a clean
 *                               CAD-ready line without visibly departing the data.
 *   - Presentation Map  → 1.0   STRONG. Cartographic-only (no analytical claim),
 *                               so the cleanest visual: a full cell of give
 *                               removes clutter for a legible map. Still bounded
 *                               at one cell — it never invents terrain.
 *   - Custom            → 0.5   The neutral base default; coincides with
 *                               Engineering Plan until the user adjusts it (both
 *                               generalize at the base tolerance), which is fine —
 *                               Custom is "you drive every setting".
 *
 * Bounded to [0, 1] cell: the strongest preset gives at most one grid cell, so no
 * purpose can over-simplify a faithful line into a misleading one.
 */
export const PURPOSE_GENERALIZE_TOLERANCE_CELLS: Readonly<
  Record<ContourStudioPurpose, number>
> = {
  'survey-review': 0,
  'terrain-research': 0.25,
  'engineering-plan': BASE_GENERALIZE_TOLERANCE_CELLS, // 0.5 — the moderate default
  'presentation-map': 1.0,
  custom: BASE_GENERALIZE_TOLERANCE_CELLS, // 0.5 — neutral base
};

/** Human-facing metadata for a purpose card. */
export interface PurposeMeta {
  readonly id: ContourStudioPurpose;
  readonly label: string;
  readonly summary: string;
}

/** The default settings a purpose applies (everything except identity/overrides). */
export type PurposeDefaults = Pick<
  ContourStudioState,
  'surface' | 'contour' | 'labels' | 'appearance' | 'validation' | 'deliverable'
>;

export const PURPOSE_META: Readonly<Record<ContourStudioPurpose, PurposeMeta>> = {
  'engineering-plan': {
    id: 'engineering-plan',
    label: 'Engineering Plan',
    summary:
      'Clear contours, index lines, labels, and CAD-friendly exports. Best for site communication and planning.',
  },
  'survey-review': {
    id: 'survey-review',
    label: 'Survey Review',
    summary:
      'Exact analytical geometry, minimal smoothing, validation appendix required. Does not imply survey certification.',
  },
  'terrain-research': {
    id: 'terrain-research',
    label: 'Terrain Research',
    summary:
      'Analytical and cartographic outputs with support, validation, and provenance pages. Best for papers, QA, and reproducibility.',
  },
  'presentation-map': {
    id: 'presentation-map',
    label: 'Presentation Map',
    summary:
      'Clean visual map with simplified labels and a compact evidence statement.',
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    summary: 'Neutral defaults — you drive every setting.',
  },
};

/** The defaults each purpose applies over the neutral base. */
export function purposeDefaults(purpose: ContourStudioPurpose): PurposeDefaults {
  switch (purpose) {
    case 'engineering-plan':
      return {
        surface: {
          cartographicSmoothing: true,
          generalizeToleranceCells: PURPOSE_GENERALIZE_TOLERANCE_CELLS['engineering-plan'],
        },
        contour: { analytical: true, cartographic: true, indexEvery: 5 },
        labels: { enabled: true, indexOnly: false },
        appearance: { hillshade: false, hypsometricTint: false },
        validation: { appendixRequired: false },
        deliverable: {
          pdf: true,
          geojson: true,
          dxf: true,
          completePackage: false,
          allowExploratory: true,
        },
      };
    case 'survey-review':
      return {
        // Minimal smoothing: the review wants exact analytical geometry.
        surface: {
          cartographicSmoothing: false,
          // 0 → exact: the export uses the crisp analytical style, no generalize.
          generalizeToleranceCells: PURPOSE_GENERALIZE_TOLERANCE_CELLS['survey-review'],
        },
        contour: { analytical: true, cartographic: false, indexEvery: 5 },
        labels: { enabled: true, indexOnly: true },
        appearance: { hillshade: false, hypsometricTint: false },
        // Appendix required — but this documents the internal validation state,
        // it does NOT assert survey certification.
        validation: { appendixRequired: true },
        deliverable: {
          pdf: true,
          geojson: true,
          dxf: false,
          completePackage: false,
          // Strict path: a survey review should not ship exploratory output.
          allowExploratory: false,
        },
      };
    case 'terrain-research':
      return {
        surface: {
          cartographicSmoothing: true,
          generalizeToleranceCells: PURPOSE_GENERALIZE_TOLERANCE_CELLS['terrain-research'],
        },
        contour: { analytical: true, cartographic: true, indexEvery: 5 },
        labels: { enabled: true, indexOnly: false },
        appearance: { hillshade: true, hypsometricTint: false },
        validation: { appendixRequired: true },
        deliverable: {
          pdf: true,
          geojson: true,
          dxf: true,
          completePackage: true,
          allowExploratory: true,
        },
      };
    case 'presentation-map':
      return {
        surface: {
          cartographicSmoothing: true,
          generalizeToleranceCells: PURPOSE_GENERALIZE_TOLERANCE_CELLS['presentation-map'],
        },
        contour: { analytical: false, cartographic: true, indexEvery: 5 },
        labels: { enabled: true, indexOnly: true },
        appearance: { hillshade: true, hypsometricTint: true },
        validation: { appendixRequired: false },
        deliverable: {
          pdf: true,
          geojson: false,
          dxf: false,
          completePackage: false,
          allowExploratory: true,
        },
      };
    case 'custom': {
      const b = baseContourStudioState();
      return {
        surface: b.surface,
        contour: b.contour,
        labels: b.labels,
        appearance: b.appearance,
        validation: b.validation,
        deliverable: b.deliverable,
      };
    }
  }
}

/** The dotted setting paths a purpose owns — used to preserve user overrides. */
const PURPOSE_OWNED_PATHS = [
  'surface.cartographicSmoothing',
  'surface.generalizeToleranceCells',
  'contour.analytical',
  'contour.cartographic',
  'contour.indexEvery',
  'labels.enabled',
  'labels.indexOnly',
  'appearance.hillshade',
  'appearance.hypsometricTint',
  'validation.appendixRequired',
  'deliverable.pdf',
  'deliverable.geojson',
  'deliverable.dxf',
  'deliverable.completePackage',
  'deliverable.allowExploratory',
] as const;

/**
 * Apply a purpose to a state: set `purpose`, then overlay the purpose defaults
 * onto every owned setting the user has NOT overridden. Identity fields (area,
 * schemaVersion) and the override set are preserved. Pure.
 */
export function applyPurpose(
  state: ContourStudioState,
  purpose: ContourStudioPurpose,
): ContourStudioState {
  const d = purposeDefaults(purpose);
  const next: ContourStudioState = {
    ...state,
    purpose,
    surface: { ...d.surface },
    contour: { ...d.contour },
    labels: { ...d.labels },
    appearance: { ...d.appearance },
    validation: { ...d.validation },
    deliverable: { ...d.deliverable },
  };
  // Re-assert any user-overridden setting from the incoming state so the purpose
  // switch never discards an explicit choice.
  let result = next;
  for (const path of PURPOSE_OWNED_PATHS) {
    if (state.overrides[path]) {
      result = setPath(result, path, getPath(state, path));
    }
  }
  return result;
}

// ── tiny dotted-path get/set over the known settings groups ────────────────
type SettingGroup = 'surface' | 'contour' | 'labels' | 'appearance' | 'validation' | 'deliverable';

function getPath(state: ContourStudioState, path: string): boolean | number {
  const [group, key] = path.split('.') as [SettingGroup, string];
  return (state[group] as unknown as Record<string, boolean | number>)[key];
}

function setPath(
  state: ContourStudioState,
  path: string,
  value: boolean | number,
): ContourStudioState {
  const [group, key] = path.split('.') as [SettingGroup, string];
  return {
    ...state,
    [group]: { ...(state[group] as unknown as Record<string, unknown>), [key]: value },
  };
}
