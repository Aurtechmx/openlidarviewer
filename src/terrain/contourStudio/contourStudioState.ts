/**
 * contourStudioState.ts
 *
 * The serializable Contour Studio state model (v0.5.9 spec §8). Pure data +
 * pure helpers: defaults, deterministic serialization with a schema version and
 * a migration seam, and a stable content hash for reproducibility.
 *
 * Design constraints from the spec:
 *  - the state carries ONLY presentation/product choices — never evidence
 *    levels, validation verdicts, warnings, or source facts. Those come from the
 *    analysis result and the evidence gate, so a state change can never raise a
 *    claim (§6.3);
 *  - automatic choices are distinguished from user overrides (§8.2) via the
 *    `overrides` set, so re-applying a purpose preserves what the user changed;
 *  - serialization is deterministic (sorted keys) and carries the schema version
 *    so a saved session can be migrated forward (§8.3).
 */

import { canonicalJson, fnv1a } from '../../canonicalHash';

export const CONTOUR_STUDIO_SCHEMA = 1 as const;

export type ContourStudioPurpose =
  | 'engineering-plan'
  | 'survey-review'
  | 'terrain-research'
  | 'presentation-map'
  | 'custom';

export type ContourArea =
  | { readonly kind: 'entire-scan' }
  | { readonly kind: 'current-view' }
  | {
      readonly kind: 'polygon';
      readonly coordinates: ReadonlyArray<readonly [number, number]>;
    };

/** Whether cartographic generalization is applied by default for this purpose. */
export interface ContourSurfaceSettings {
  readonly cartographicSmoothing: boolean;
}

/** Which geometry products to emit + how often an index (bold) contour falls. */
export interface ContourGeometrySettings {
  /** Emit exact analytical isolines (GIS/research). */
  readonly analytical: boolean;
  /** Emit generalized cartographic contours (PDF/presentation). */
  readonly cartographic: boolean;
  /** Every Nth contour is an index line (>= 1). */
  readonly indexEvery: number;
}

export interface ContourLabelSettings {
  readonly enabled: boolean;
  /** Label only index contours (cleaner presentation maps). */
  readonly indexOnly: boolean;
}

export interface ContourAppearanceSettings {
  readonly hillshade: boolean;
  readonly hypsometricTint: boolean;
}

export interface ContourValidationSettings {
  /** The purpose demands the multi-page validation appendix in the deliverable. */
  readonly appendixRequired: boolean;
}

export interface ContourDeliverableSettings {
  readonly pdf: boolean;
  readonly geojson: boolean;
  readonly dxf: boolean;
  readonly completePackage: boolean;
  /** Whether exploratory (watermarked) output may be produced for this purpose. */
  readonly allowExploratory: boolean;
}

export interface ContourStudioState {
  readonly schemaVersion: typeof CONTOUR_STUDIO_SCHEMA;
  readonly purpose: ContourStudioPurpose;
  readonly area: ContourArea;
  readonly surface: ContourSurfaceSettings;
  readonly contour: ContourGeometrySettings;
  readonly labels: ContourLabelSettings;
  readonly appearance: ContourAppearanceSettings;
  readonly validation: ContourValidationSettings;
  readonly deliverable: ContourDeliverableSettings;
  /**
   * Settings the user explicitly changed (dotted paths, e.g.
   * `surface.cartographicSmoothing`). Re-applying a purpose leaves these
   * untouched, so a purpose switch never silently discards user choices.
   */
  readonly overrides: Readonly<Record<string, boolean>>;
}

/** A recommended value with its provenance and rationale (spec §8.2). */
export interface RecommendedValue<T> {
  readonly value: T;
  readonly source: 'automatic' | 'user';
  readonly rationale: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
}

/**
 * The neutral baseline state (used by the `custom` purpose and as the starting
 * point every purpose preset overlays its defaults onto).
 */
export function baseContourStudioState(): ContourStudioState {
  return {
    schemaVersion: CONTOUR_STUDIO_SCHEMA,
    purpose: 'custom',
    area: { kind: 'entire-scan' },
    surface: { cartographicSmoothing: true },
    contour: { analytical: true, cartographic: true, indexEvery: 5 },
    labels: { enabled: true, indexOnly: false },
    appearance: { hillshade: false, hypsometricTint: false },
    validation: { appendixRequired: false },
    deliverable: {
      pdf: true,
      geojson: true,
      dxf: false,
      completePackage: false,
      allowExploratory: true,
    },
    overrides: {},
  };
}

/** Deterministic JSON for a state (sorted keys), for saving + hashing. */
export function serializeContourStudioState(state: ContourStudioState): string {
  return canonicalJson(state);
}

/**
 * Parse a serialized state, validating the schema version. Unknown/newer schema
 * versions throw rather than silently loading a shape we don't understand; the
 * `migrate` seam is where forward migrations from older versions will live.
 */
export function parseContourStudioState(json: string): ContourStudioState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Contour Studio state: not valid JSON.');
  }
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Contour Studio state: expected an object.');
  }
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  const migrated = migrate(raw, typeof v === 'number' ? v : 0);
  return migrated;
}

/** Forward-migration seam. Today only schema 1 exists. */
function migrate(raw: unknown, version: number): ContourStudioState {
  if (version === CONTOUR_STUDIO_SCHEMA) {
    // Overlay onto the base so a partial/old-but-same-version object still
    // yields a complete, valid state (missing fields fall back to defaults).
    return coerce(raw as Partial<ContourStudioState>);
  }
  throw new Error(
    `Contour Studio state: unsupported schemaVersion ${version} (this build understands ${CONTOUR_STUDIO_SCHEMA}).`,
  );
}

/** Complete a possibly-partial state against the base defaults. */
function coerce(p: Partial<ContourStudioState>): ContourStudioState {
  const base = baseContourStudioState();
  return {
    schemaVersion: CONTOUR_STUDIO_SCHEMA,
    purpose: p.purpose ?? base.purpose,
    area: p.area ?? base.area,
    surface: { ...base.surface, ...p.surface },
    contour: { ...base.contour, ...p.contour },
    labels: { ...base.labels, ...p.labels },
    appearance: { ...base.appearance, ...p.appearance },
    validation: { ...base.validation, ...p.validation },
    deliverable: { ...base.deliverable, ...p.deliverable },
    overrides: { ...(p.overrides ?? {}) },
  };
}

/** Stable content fingerprint of a state (reproducibility, §8.3). */
export function contourStudioStateHash(state: ContourStudioState): string {
  return fnv1a(serializeContourStudioState(state));
}
