/**
 * contourPackageManifest.ts
 *
 * The complete-deliverable-package model (v0.5.9 spec §21). Pure: it decides
 * WHICH files the package contains, their honest per-feature vector attributes
 * (§21.1), and the README (§21.2) — without assembling any bytes. The ZIP
 * assembly + raster encoding + SHA256SUMS-over-bytes are the wiring on top;
 * keeping the manifest pure lets the honesty rules be tested directly.
 *
 * Rules enforced here:
 *  - a BLOCKED decision never yields a package (§19.4) — building one throws;
 *  - a product that cannot be produced is OMITTED with a reason, never emitted
 *    as an empty placeholder (§21);
 *  - vector attributes are honest: nulls where a value is unknown, the geometry
 *    role and evidence level carried per feature, and support never overstated.
 */

import type { ContourFeature } from '../contour/contourFeatureModel';
import type { ContourGeometryRole } from './contourGeometryProduct';
import type { ScientificExportDecision } from '../../export/exportManifest';

/** Sanitize a project name into a filesystem- and zip-safe stem. */
export function packageStem(raw: string, fallback = 'contour-deliverable'): string {
  const s = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s.length > 0 ? s : fallback;
}

// ── §21.1 vector attributes ────────────────────────────────────────────────

export interface FeatureAttributeContext {
  readonly featureId: number;
  readonly indexOrder: number;
  readonly geometryRole: ContourGeometryRole;
  readonly evidenceLevel: string;
  readonly validationMode: string;
  readonly methodId: string;
  readonly methodVersion: string;
  readonly sourceHash: string;
  readonly softwareVersion: string;
  readonly gitCommit: string;
  /** Unit label for elevation, or 'unknown'. */
  readonly elevationUnit: string;
  /** Per-feature uncertainty; nulls when not assessed. */
  readonly uncertainty?: {
    readonly verticalSigmaM: number | null;
    readonly horizontalP95M: number | null;
    readonly condition: 'finite' | 'near-flat-unbounded' | 'vertical-uncertainty-unavailable' | 'unsupported' | 'not-assessed';
  };
}

type Support = 'measured' | 'interpolated' | 'unsupported';
function supportOf(f: ContourFeature): Support {
  if (f.grade === 'solid') return 'measured';
  if (f.grade === 'dashed') return 'interpolated';
  return 'unsupported';
}

/** Build the §21.1 attribute record for one contour feature. Honest by
 *  construction — unknown values are null, never fabricated. */
export function contourFeatureAttributes(
  f: ContourFeature,
  ctx: FeatureAttributeContext,
): Readonly<Record<string, string | number | boolean | null>> {
  const support = supportOf(f);
  const u = ctx.uncertainty;
  return {
    feature_id: ctx.featureId,
    elevation: f.value,
    elevation_unit: ctx.elevationUnit || 'unknown',
    contour_type: f.isIndex ? 'index' : 'intermediate',
    index_order: ctx.indexOrder,
    geometry_role: ctx.geometryRole,
    closed: f.closed,
    support_class: support,
    measured_fraction: support === 'measured' ? 1 : 0,
    interpolated_fraction: support === 'interpolated' ? 1 : 0,
    unsupported_fraction: support === 'unsupported' ? 1 : 0,
    vertical_sigma_m: u ? u.verticalSigmaM : null,
    horizontal_p95_m: u ? u.horizontalP95M : null,
    uncertainty_condition: u ? u.condition : 'not-assessed',
    validation_mode: ctx.validationMode,
    evidence_level: ctx.evidenceLevel,
    method_id: ctx.methodId,
    method_version: ctx.methodVersion,
    source_hash: ctx.sourceHash,
    software_version: ctx.softwareVersion,
    git_commit: ctx.gitCommit,
  };
}

// ── §21 package manifest ───────────────────────────────────────────────────

export type PackageRole =
  | 'contour-map-pdf'
  | 'contours-analytical-geojson'
  | 'contours-cartographic-geojson'
  | 'contours-cartographic-dxf'
  | 'dtm-raster'
  | 'hillshade-raster'
  | 'support-raster'
  | 'uncertainty-raster'
  | 'validation-json'
  | 'provenance-json'
  | 'contour-studio-json'
  | 'readme'
  | 'checksums';

export interface PackageEntry {
  readonly role: PackageRole;
  readonly filename: string;
  readonly status: 'included' | 'omitted';
  /** Present only when omitted — why the file is absent. */
  readonly reason?: string;
}

export interface ContourPackageManifest {
  readonly projectName: string;
  readonly zipName: string;
  readonly entries: readonly PackageEntry[];
  readonly readme: string;
  readonly exploratory: boolean;
}

/** Which producible products are available for this package. */
export interface PackageAvailability {
  readonly pdf: boolean;
  readonly analyticalGeojson: boolean;
  readonly cartographicGeojson: boolean;
  readonly cartographicDxf: boolean;
  readonly dtm: boolean;
  readonly hillshade: boolean;
  readonly support: boolean;
  readonly uncertainty: boolean;
  readonly validationJson: boolean;
  readonly provenanceJson: boolean;
  readonly studioJson: boolean;
}

export interface PackageInput {
  readonly projectName: string;
  readonly decision: ScientificExportDecision;
  readonly available: PackageAvailability;
  /** Reason to record when a product is omitted (per role). */
  readonly omissionReasons?: Partial<Record<PackageRole, string>>;
  readonly provenance: {
    readonly crs: string;
    readonly verticalDatum: string;
    readonly horizontalUnit: string;
    readonly verticalUnit: string;
    readonly software: string;
    readonly softwareVersion: string;
  };
  /** One-line citation recommendation for the README. */
  readonly citation: string;
}

interface FileSpec { role: PackageRole; ext: string; label: string; available: (a: PackageAvailability) => boolean; desc: string }

const FILE_SPECS: readonly FileSpec[] = [
  { role: 'contour-map-pdf', ext: 'Contour_Report.pdf', label: 'Contour report (PDF)', available: (a) => a.pdf, desc: 'Multipage technical report — contour summary, surface support, validation, method and provenance. Text pages, not a rendered map sheet.' },
  { role: 'contours-analytical-geojson', ext: 'Contours_Analytical.geojson', label: 'Analytical contours (GeoJSON)', available: (a) => a.analyticalGeojson, desc: 'Exact isolines of the terrain surface — for GIS and reproducibility.' },
  { role: 'contours-cartographic-geojson', ext: 'Contours_Cartographic.geojson', label: 'Cartographic contours (GeoJSON)', available: (a) => a.cartographicGeojson, desc: 'Generalized, labelled lines for presentation — derived from the analytical geometry.' },
  { role: 'contours-cartographic-dxf', ext: 'Contours_Cartographic.dxf', label: 'Cartographic contours (DXF)', available: (a) => a.cartographicDxf, desc: 'The cartographic contours for CAD.' },
  { role: 'dtm-raster', ext: 'DTM.tif', label: 'DTM raster', available: (a) => a.dtm, desc: 'The digital terrain model grid.' },
  { role: 'hillshade-raster', ext: 'Hillshade.tif', label: 'Hillshade raster', available: (a) => a.hillshade, desc: 'A shaded-relief image of the DTM.' },
  { role: 'support-raster', ext: 'Support.tif', label: 'Support raster', available: (a) => a.support, desc: 'Per-cell support: measured / interpolated / unsupported.' },
  { role: 'uncertainty-raster', ext: 'Uncertainty.tif', label: 'Uncertainty raster', available: (a) => a.uncertainty, desc: 'A model-based support/uncertainty score.' },
  { role: 'validation-json', ext: 'Validation.json', label: 'Validation (JSON)', available: (a) => a.validationJson, desc: 'The internal validation figures and their scope.' },
  { role: 'provenance-json', ext: 'Provenance.json', label: 'Provenance (JSON)', available: (a) => a.provenanceJson, desc: 'The canonical scientific-analysis record and build identity.' },
  { role: 'contour-studio-json', ext: 'ContourStudio.json', label: 'Contour Studio state (JSON)', available: (a) => a.studioJson, desc: 'The exact settings that produced this deliverable.' },
];

/**
 * Build the package manifest. Throws for a blocked decision (§19.4). README and
 * SHA256SUMS are always present; every other file is included only when it can
 * be produced, and omitted with a reason otherwise.
 */
export function buildContourPackageManifest(input: PackageInput): ContourPackageManifest {
  if (input.decision.status === 'blocked') {
    throw new Error('Contour package: the export decision is blocked — no polished package is produced.');
  }
  const exploratory = input.decision.status === 'exploratory';
  const stem = packageStem(input.projectName);
  const entries: PackageEntry[] = [];

  for (const spec of FILE_SPECS) {
    const filename = `${stem}_${spec.ext}`;
    if (spec.available(input.available)) {
      entries.push({ role: spec.role, filename, status: 'included' });
    } else {
      entries.push({
        role: spec.role,
        filename,
        status: 'omitted',
        reason: input.omissionReasons?.[spec.role] ?? 'Not available for this scan.',
      });
    }
  }
  // README + checksums always present.
  entries.push({ role: 'readme', filename: `${stem}_README.txt`, status: 'included' });
  entries.push({ role: 'checksums', filename: 'SHA256SUMS', status: 'included' });

  const readme = buildReadme(stem, entries, input, exploratory);
  return { projectName: input.projectName, zipName: `${stem}_Contour_Deliverable.zip`, entries, readme, exploratory };
}

function buildReadme(stem: string, entries: readonly PackageEntry[], input: PackageInput, exploratory: boolean): string {
  const included = entries.filter((e) => e.status === 'included');
  const omitted = entries.filter((e) => e.status === 'omitted');
  const descOf = (role: PackageRole): string => FILE_SPECS.find((s) => s.role === role)?.desc ?? '';
  const lines: string[] = [];

  lines.push(`${stem} — Contour deliverable`, '');
  if (exploratory) {
    lines.push(
      'EXPLORATORY DELIVERABLE. One or more scientific prerequisites were incomplete, so',
      'these outputs are watermarked and are for inspection, not for validated use.',
      '',
    );
  }
  lines.push('Contents');
  for (const e of included) {
    if (e.role === 'readme' || e.role === 'checksums') continue;
    lines.push(`  ${e.filename} — ${descOf(e.role)}`);
  }
  lines.push('  SHA256SUMS — checksums for the files above.');
  if (omitted.length > 0) {
    lines.push('', 'Not included');
    for (const e of omitted) lines.push(`  ${e.filename} — omitted: ${e.reason}`);
  }

  lines.push(
    '',
    'Analytical vs cartographic geometry',
    '  Analytical contours are exact isolines of the terrain grid (use for GIS and',
    '  reproducibility). Cartographic contours are generalized and labelled for legible',
    '  maps; they are derived from the analytical geometry and are not exact.',
    '',
    'Validation scope',
    '  Validation is internal (hold-out) only. No independent field checkpoints were',
    '  provided. These outputs are not survey-grade.',
    '',
    'Uncertainty limits',
    '  Reported uncertainty is model-based. Near-flat areas may have unbounded contour-',
    '  position sensitivity and are marked accordingly; unsupported spans are not measured.',
    '',
    'Coordinate reference',
    `  CRS: ${input.provenance.crs}`,
    `  Vertical datum: ${input.provenance.verticalDatum}`,
    `  Horizontal unit: ${input.provenance.horizontalUnit}`,
    `  Vertical unit: ${input.provenance.verticalUnit}`,
    '',
    'Integrity',
    '  Verify files against SHA256SUMS (e.g. `shasum -a 256 -c SHA256SUMS`).',
    '  A checksum verifies file integrity only — it does not prove authorship.',
    '',
    'Citation',
    `  ${input.citation}`,
    '',
    `Produced by ${input.provenance.software} ${input.provenance.softwareVersion}.`,
  );
  return lines.join('\n');
}
