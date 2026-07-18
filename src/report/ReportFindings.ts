/**
 * ReportFindings.ts
 *
 * Pure synthesis leaf — turns the raw dataset metadata (+ optional
 * capture-type provenance) into a short, scannable "Inspection summary":
 * a one-line headline plus a handful of findings a reviewer can read in a
 * couple of seconds, and an explicit list of what the report does NOT
 * establish.
 *
 * Honesty rules this module is built around:
 *
 *  - It reports what was *measured*. Point density, extent and attribute
 *    presence are read straight from the loaded cloud. They are stated, not
 *    judged.
 *  - It only compares density against the USGS QL1 / QL2 tiers when the
 *    capture-type classifier has *itself* cited USGS QL literature for this
 *    scan (an airborne-ALS delivery). The Scan Acceptance template
 *    deliberately bakes in no QL thresholds because they would be misapplied
 *    to TLS / phone / cropped subsets; this module honours the same line by
 *    gating the tier on the classifier's own applicability decision.
 *  - Vertical accuracy is *never* asserted. The cloud cannot tell us RMSEz
 *    without ground control, so that finding is always rendered "—, requires
 *    ground-control validation". This is the centre of the deliverable: it
 *    says plainly what the scan cannot prove on its own.
 *
 * Pure data: no DOM, no pdf-lib, no I/O. Deterministic — tests pin it.
 */

import type { MetadataInputs } from './ReportMetadataSection';
import type { ReportProvenanceFingerprint } from './types';

/**
 * Descriptive characterisation of a finding — NOT a pass/fail grade of the
 * data. `met` means a stated, literature-anchored threshold is reached;
 * `caution` flags something a reviewer should weigh; `unknown` marks what the
 * cloud cannot establish on its own; `info` is a neutral fact.
 */
export type FindingTier = 'met' | 'caution' | 'unknown' | 'info';

/** One row in the inspection summary. */
export interface ReportFinding {
  /** Short row label, e.g. "Point density". */
  readonly label: string;
  /** The measured / stated value, e.g. "16 pts/m²" or "—". */
  readonly value: string;
  /** Optional one-line interpretation, e.g. "Meets USGS QL1 (≥ 8 pts/m²)". */
  readonly detail?: string;
  /** Descriptive tier (drives the status dot + label). */
  readonly tier: FindingTier;
  /** Optional literature citation for the interpretation. */
  readonly source?: string;
}

/** The synthesised summary the renderer lays out as a card. */
export interface ReportInspectionSummary {
  /** One descriptive line: capture type + scale. */
  readonly headline: string;
  /** Findings in priority order. */
  readonly findings: readonly ReportFinding[];
  /** What the report does NOT establish — always non-empty. */
  readonly caveats: readonly string[];
  /**
   * Optional density-bar datum: the measured density against the USGS QL
   * thresholds. Present ONLY when the QL comparison is applicable (see the
   * gating rule above), so the renderer never draws a bar implying a
   * standard that doesn't apply to this capture type.
   */
  readonly densityBar?: {
    readonly measured: number;
    readonly unit: string;
    readonly thresholds: readonly { readonly label: string; readonly value: number }[];
  };
}

/**
 * USGS nominal pulse-density tiers (aggregate, pts/m²). Real published
 * constants from the USGS Lidar Base Specification, surveyed in Lohani &
 * Ghosh 2017 §6 — the same source the provenance classifier cites. Held here
 * as named constants so the comparison is auditable.
 */
const USGS_QL1_PTS_PER_M2 = 8;
const USGS_QL2_PTS_PER_M2 = 2;
const USGS_DENSITY_SOURCE = 'Lohani & Ghosh 2017 §6 (USGS Lidar Base Spec)';
/**
 * The technical report's density is the all-returns total over the footprint —
 * the nominal delivery density USGS QL tiers are defined against. The terrain /
 * DEM products instead grade **bare-earth (ground) density**, which is far
 * lower under canopy, so the two reports can legitimately land on different QL
 * verdicts for the same scan. Naming the basis on each keeps that from reading
 * as a contradiction.
 */
const DENSITY_LABEL = 'Point density (all returns)';
const GROUND_BASIS_NOTE =
  ' Terrain/DEM products grade bare-earth ground density separately.';

/**
 * The QL density comparison is applicable only when the classifier has cited
 * USGS QL literature for this scan — i.e. it decided this is an airborne-ALS
 * delivery and emitted a QL-labelled accuracy bound. Keying on the classifier's
 * own output (rather than re-deriving capture type here) keeps the QL tiers out
 * of TLS / phone / unknown reports, matching the Scan Acceptance guardrail.
 */
function usgsQlApplies(provenance: ReportProvenanceFingerprint | undefined): boolean {
  if (!provenance) return false;
  return provenance.bounds.some((b) => /\bQL\b|USGS/i.test(b.label));
}

/** Footprint area in m² from width × depth, or NaN when either is unknown. */
function footprintAreaM2(metadata: MetadataInputs): number {
  const { width, depth } = metadata;
  if (!Number.isFinite(width) || !Number.isFinite(depth)) return Number.NaN;
  return width * depth;
}

/** "100.0 ha" / "4,200 m²" — human scale for the footprint. */
function formatArea(areaM2: number): string {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) return 'unknown extent';
  if (areaM2 >= 10_000) return `${(areaM2 / 10_000).toFixed(1)} ha`;
  return `${Math.round(areaM2).toLocaleString('en-US')} m²`;
}

/** "15.7 M points" / "420,000 points" — compact count. */
function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return 'unknown count';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M points`;
  return `${Math.round(n).toLocaleString('en-US')} points`;
}

/** Build the point-density finding, honouring the QL-applicability gate. */
function densityFinding(
  metadata: MetadataInputs,
  qlApplies: boolean,
): ReportFinding {
  const d = metadata.density;
  if (!Number.isFinite(d) || d <= 0) {
    return {
      label: DENSITY_LABEL,
      value: '—',
      detail: 'Not reported for this source.',
      tier: 'unknown',
    };
  }
  // One decimal, matching the on-screen Scan Report panel. Integer rounding
  // pushed 2.586 pts/m² to "3", overstating density in a report whose header
  // promise is honest provenance (and disagreeing with the panel's "2.6").
  const value = `${d.toFixed(1)} pts/m²`;
  if (!qlApplies) {
    // No capture-type density standard applies — state the number, claim nothing.
    return {
      label: DENSITY_LABEL,
      value,
      detail: 'No capture-type density standard applied to this scan.',
      tier: 'info',
    };
  }
  if (d >= USGS_QL1_PTS_PER_M2) {
    return {
      label: DENSITY_LABEL,
      value,
      detail: `Meets USGS QL1 (≥ ${USGS_QL1_PTS_PER_M2} pts/m²) on all-returns density.${GROUND_BASIS_NOTE}`,
      tier: 'met',
      source: USGS_DENSITY_SOURCE,
    };
  }
  if (d >= USGS_QL2_PTS_PER_M2) {
    return {
      label: DENSITY_LABEL,
      value,
      detail: `Meets USGS QL2 (≥ ${USGS_QL2_PTS_PER_M2} pts/m²); below QL1 (≥ ${USGS_QL1_PTS_PER_M2}) on all-returns density.${GROUND_BASIS_NOTE}`,
      tier: 'met',
      source: USGS_DENSITY_SOURCE,
    };
  }
  return {
    label: DENSITY_LABEL,
    value,
    detail: `Below USGS QL2 (≥ ${USGS_QL2_PTS_PER_M2} pts/m²) on all-returns density.${GROUND_BASIS_NOTE}`,
    tier: 'caution',
    source: USGS_DENSITY_SOURCE,
  };
}

/**
 * Synthesise the inspection summary. Deterministic; safe to call for any
 * scan (returns a summary even when most fields are unknown — the value is in
 * stating plainly what is and is not known).
 */
export function buildInspectionSummary(
  metadata: MetadataInputs,
  provenance?: ReportProvenanceFingerprint,
): ReportInspectionSummary {
  const qlApplies = usgsQlApplies(provenance);
  const area = footprintAreaM2(metadata);

  // Headline: capture type (if classified) + scale.
  const captureLabel = provenance?.label ?? 'Point cloud';
  const headline = `${captureLabel} — ${formatArea(area)}, ${formatCount(metadata.sourcePointCount)}.`;

  const findings: ReportFinding[] = [];

  // 1. Coverage / scale.
  findings.push({
    label: 'Coverage',
    value: formatArea(area),
    detail: `${formatCount(metadata.sourcePointCount)} captured.`,
    tier: 'info',
  });

  // 2. Point density — the one genuinely quantitative finding.
  findings.push(densityFinding(metadata, qlApplies));

  // 3. Attribute channels.
  const channels: string[] = [];
  channels.push(metadata.hasClassification ? 'classification' : 'no classification');
  channels.push(metadata.hasIntensity ? 'intensity' : 'no intensity');
  channels.push(metadata.hasRgb ? 'RGB' : 'no RGB');
  findings.push({
    label: 'Attributes',
    value: channels.join(', '),
    tier: metadata.hasClassification ? 'info' : 'caution',
    detail: metadata.hasClassification
      ? undefined
      : 'No classification channel — ground / feature extraction needs one.',
  });

  // 4. Georeference.
  if (metadata.crsName && metadata.crsName.length > 0) {
    findings.push({
      label: 'Georeference',
      value: metadata.crsName,
      detail: metadata.crsUnit ? `Linear unit: ${metadata.crsUnit}.` : undefined,
      tier: 'met',
    });
  } else {
    findings.push({
      label: 'Georeference',
      value: 'No CRS declared',
      detail: 'Exports cannot be georeferenced without a declared CRS.',
      tier: 'caution',
    });
  }

  // 5. Vertical accuracy — never asserted. The honesty centrepiece.
  findings.push({
    label: 'Vertical accuracy',
    value: '—',
    detail: 'Not measured. Requires ground-control validation (NVA = 1.96 × RMSEz).',
    tier: 'unknown',
  });

  // Caveats — always at least the validation reminder.
  const caveats: string[] = [];
  const scope = metadata.classScopeNote?.trim();
  if (scope) {
    caveats.push(
      `A class filter was active at export (${scope}); the figures above are full-cloud.`,
    );
  }
  caveats.push(
    'These findings describe the delivered data. They are not a substitute for ' +
      'ground-control validation, and any accuracy tier above is an expected range, ' +
      'not a guarantee.',
  );

  const densityBar =
    qlApplies && Number.isFinite(metadata.density) && metadata.density > 0
      ? {
          measured: metadata.density,
          unit: 'pts/m²',
          thresholds: [
            { label: 'QL2', value: USGS_QL2_PTS_PER_M2 },
            { label: 'QL1', value: USGS_QL1_PTS_PER_M2 },
          ],
        }
      : undefined;

  return { headline, findings, caveats, densityBar };
}
