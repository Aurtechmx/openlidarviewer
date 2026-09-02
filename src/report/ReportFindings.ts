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
 *  - A density floor is a threshold, not a quality level — and the density
 *    this report holds is ALL RETURNS over the bounding-box footprint. USGS
 *    QL floors are defined on nominal PULSE density, which the file does not
 *    record (a multi-return forest tile at 10 returns/m² may be 3–4 pulses/m²),
 *    so no finding is ever graded against a QL floor: the density row is
 *    stated as a fact and the QL bar, where the classifier cited USGS QL
 *    literature for an airborne delivery, is drawn as ungraded context only.
 *    `terrain/quality/demAccuracyStandards.ts` refuses the same comparison for
 *    the same reason.
 *  - Vertical accuracy is *never* asserted. The cloud cannot tell us RMSEz
 *    without ground control, so that finding is always rendered "—, not
 *    evaluated in this report". This is the centre of the deliverable: it
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
   * Optional density-bar datum: the measured all-returns density drawn
   * against the USGS QL pulse-density floors as CONTEXT, not a grade. Present
   * ONLY when the classifier cited USGS QL literature for this scan (see the
   * gating rule above), so the renderer never draws a bar implying a
   * standard that doesn't apply to this capture type.
   */
  readonly densityBar?: {
    /** Bar caption; names the floors and states that nothing is graded. */
    readonly caption: string;
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
 * The technical report's density is the all-returns record count over the
 * bounding-box footprint. USGS QL tiers are defined on nominal PULSE density,
 * which the file does not record, so the row states the number and its basis
 * and grades nothing. The terrain / DEM products separately grade
 * **bare-earth (ground) density**, which is far lower under canopy.
 */
const DENSITY_LABEL = 'Point density (all returns)';
const DENSITY_BASIS = 'over the bounding-box footprint';
const QL_NOT_EVALUATED =
  'USGS QL floors are defined on nominal pulse density, which this file does not record; not evaluated.';
const DENSITY_BAR_CAPTION = 'USGS pulse-density floors (context, not graded)';

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

/**
 * Footprint area in m² from width × depth, or NaN when the area is not a
 * confirmed metric quantity. FAILS CLOSED on an unconfirmed linear unit: when
 * the CRS declares no real unit, `width`/`depth` are raw source-unit spans, so
 * multiplying them would yield a source-unit² figure the report must NOT present
 * as m² — the coverage finding reads "unknown extent" instead.
 */
function footprintAreaM2(metadata: MetadataInputs): number {
  if (metadata.extentUnitStatus === 'unknown') return Number.NaN;
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
      detail: `All-returns density ${value} ${DENSITY_BASIS}. No capture-type density standard applied to this scan.`,
      tier: 'info',
    };
  }
  // Airborne delivery: the QL floors are the relevant literature, but they are
  // pulse-density floors and this is a returns count — stated, never graded.
  return {
    label: DENSITY_LABEL,
    value,
    detail: `All-returns density ${value} ${DENSITY_BASIS}. ${QL_NOT_EVALUATED}`,
    tier: 'info',
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
  const totalText =
    metadata.sourcePointCount === null
      ? 'point count unknown from source metadata'
      : formatCount(metadata.sourcePointCount);
  const headline = `${captureLabel} — ${formatArea(area)}, ${totalText}.`;

  const findings: ReportFinding[] = [];

  // 1. Extent / scale — the bounding box, which is not a surveyed area, and
  //    the file's record count, which is what was delivered, not what was
  //    captured.
  const extent = formatArea(area);
  findings.push(
    {
      label: 'Bounding-box extent',
      value: Number.isFinite(area) && area > 0 ? `${extent} (not surveyed area)` : extent,
      detail:
        metadata.sourcePointCount === null
          ? 'Point count unknown from source metadata.'
          : `${formatCount(metadata.sourcePointCount)} delivered (file record count).`,
      tier: 'info',
    },
    // 2. Point density — the one genuinely quantitative finding.
    densityFinding(metadata, qlApplies),
  );

  // 3. Attribute channels.
  const channels: string[] = [];
  channels.push(
    metadata.hasClassification ? 'classification' : 'no classification',
    metadata.hasIntensity ? 'intensity' : 'no intensity',
    metadata.hasRgb ? 'RGB' : 'no RGB',
  );
  findings.push({
    label: 'Attributes',
    value: channels.join(', '),
    tier: metadata.hasClassification ? 'info' : 'caution',
    detail: metadata.hasClassification
      ? undefined
      : 'No classification channel — ground / feature extraction needs one.',
  });

  // 4. Georeference — a declared CRS name is a fact, not a met threshold.
  if (metadata.crsName && metadata.crsName.length > 0) {
    findings.push({
      label: 'Georeference',
      value: metadata.crsName,
      detail: metadata.crsUnit ? `Linear unit: ${metadata.crsUnit}.` : undefined,
      tier: 'info',
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
    detail:
      'Not evaluated in this report. A hold-out RMSEz appears in the Terrain report when ' +
      'terrain analysis has run; neither replaces independent ground-control checkpoints.',
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
          caption: DENSITY_BAR_CAPTION,
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
