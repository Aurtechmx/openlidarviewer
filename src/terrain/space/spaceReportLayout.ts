/**
 * spaceReportLayout.ts
 *
 * The PURE content model for the Space / Object Report — the fields, labels and
 * formatted strings a one-page report prints — with NO pdf-lib and NO DOM, so
 * every line can be unit-tested without rendering. The PDF renderer
 * ({@link buildSpaceReportPdf}) consumes this so the two can never drift.
 *
 * A non-terrain scan has no terrain {@link AnalyseContoursResult}, so this
 * builds a small DEDICATED provenance (software + version, metric version, date,
 * source, scan type, units, point counts, not-survey-grade) rather than forcing
 * the terrain `buildExportProvenance`.
 *
 * HONESTY: every figure comes straight from {@link SpaceMetrics} /
 * {@link ObjectMetrics}; absent values read as an em-dash, never a fabricated
 * zero. The not-survey-grade note and the panel's caveats are carried verbatim.
 */

import type { SpaceMetrics } from '../spaceMetrics';
import { metresToFeet, sqMetresToSqFeet, cubicMetresToCubicFeet } from '../spaceMetrics';
import type { ObjectMetrics } from '../objectMetrics';
import { SOFTWARE_NAME, NOT_SURVEY_GRADE_NOTE } from '../export/exportProvenance';
import { evidenceNote } from '../../validation/exportEvidenceNote';

/** One label/value line in a report section. */
export interface ReportRow {
  readonly label: string;
  readonly value: string;
}

/** A titled block of rows. */
export interface ReportSection {
  readonly title: string;
  readonly rows: ReadonlyArray<ReportRow>;
}

/** A small, dedicated provenance for a non-terrain space/object report. */
export interface SpaceReportProvenance {
  readonly software: string;
  readonly softwareVersion: string;
  readonly metricVersion: string;
  readonly generated: string;
  readonly source: string | null;
  /** 'Interior space' / 'Object'. */
  readonly scanType: string;
  /** 'metres' / 'feet (source) → metres' etc. */
  readonly units: string;
  readonly sampledPointCount: number;
  readonly sourcePointCount: number;
  readonly notSurveyGrade: string;
}

export interface SpaceReportContent {
  readonly title: string;
  readonly subtitle: string;
  readonly sections: ReadonlyArray<ReportSection>;
  readonly provenance: SpaceReportProvenance;
  /** Provenance lines for the footer (single-sourced from `provenance`). */
  readonly provenanceLines: ReadonlyArray<string>;
  /** Honesty caveats carried verbatim from the metrics' reasons. */
  readonly caveats: ReadonlyArray<string>;
}

export interface SpaceReportInput {
  /** Interior / object space metrics (capture quality + reasons live here). */
  readonly space: SpaceMetrics | null;
  /** Object metrics — required for the object branch; ignored for interior. */
  readonly object?: ObjectMetrics | null;
  /** Scan name (the export basename). */
  readonly name?: string | null;
  /** Producing software version (`__APP_VERSION__`). */
  readonly softwareVersion?: string | null;
  /** Terrain metric version. */
  readonly metricVersion?: string | null;
  /** Generation timestamp — Date or ISO string. */
  readonly generatedAt?: Date | string | null;
  /** Source-unit→metre factor (from the CRS). 1 ⇒ metres assumed. */
  readonly unitToMetres?: number;
}

const DASH = '—';
const m1 = (v: number | null | undefined): string =>
  v != null && Number.isFinite(v) ? v.toFixed(2) : DASH;
const i0 = (v: number | null | undefined): string =>
  v != null && Number.isFinite(v) ? Math.round(v).toLocaleString() : DASH;
/** "12.3 m (40.4 ft)". */
const mft = (v: number | null | undefined): string =>
  v != null && Number.isFinite(v) ? `${v.toFixed(1)} m (${metresToFeet(v).toFixed(1)} ft)` : DASH;
const areaMft = (v: number | null | undefined): string =>
  v != null && Number.isFinite(v)
    ? `${Math.round(v).toLocaleString()} m² (${Math.round(sqMetresToSqFeet(v)).toLocaleString()} ft²)`
    : DASH;
const volMft = (v: number | null | undefined): string =>
  v != null && Number.isFinite(v)
    ? `${Math.round(v).toLocaleString()} m³ (${Math.round(cubicMetresToCubicFeet(v)).toLocaleString()} ft³)`
    : DASH;
const areaMftFine = (v: number | null | undefined): string =>
  v != null && Number.isFinite(v)
    ? `${v.toFixed(2)} m² (${sqMetresToSqFeet(v).toFixed(1)} ft²)`
    : DASH;
const volMftFine = (v: number | null | undefined): string =>
  v != null && Number.isFinite(v)
    ? `${v.toFixed(2)} m³ (${cubicMetresToCubicFeet(v).toFixed(1)} ft³)`
    : DASH;
const cm = (v: number | null | undefined): string =>
  v != null && Number.isFinite(v) ? `${(v * 100).toFixed(1)} cm` : DASH;

function toIso(at: Date | string | null | undefined): string {
  if (at instanceof Date) return at.toISOString();
  if (typeof at === 'string' && at.length > 0) return at;
  return new Date().toISOString();
}

/** Capture-quality section, shared between interior + object reports. */
function captureSection(q: SpaceMetrics['quality']): ReportSection {
  return {
    title: 'Capture quality',
    rows: [
      { label: 'Points (used / source)', value: `${i0(q.sampledPointCount)} / ${i0(q.sourcePointCount)}` },
      { label: 'Density', value: `${q.densityPerM2.toFixed(1)} pts/m²` },
      { label: 'Mean spacing', value: cm(q.meanSpacingM) },
      // HONESTY: coveragePct is occupied / (cols*rows) over the bounding-box
      // grid — a fill ratio of the extent, not a traced footprint. Label says so
      // (matches the ObjectPanel "Bounding area filled" row).
      { label: 'Bounding area filled', value: `${Math.round(q.coveragePct)}%` },
      { label: 'Colour (RGB)', value: q.hasRgb ? 'Yes' : 'No' },
    ],
  };
}

function unitsLabel(unitToMetres: number): string {
  return unitToMetres === 1 ? 'metres (assumed)' : `source units x ${unitToMetres} -> metres`;
}

/**
 * Build the pure content model for the INTERIOR report from space metrics.
 */
function interiorContent(input: SpaceReportInput): SpaceReportContent {
  const space = input.space!;
  const d = space.dims;
  const p = space.planes;
  const dims: ReportSection = {
    title: 'Dimensions',
    rows: [
      {
        label: 'L x W x H',
        value: `${m1(d.lengthM)} x ${m1(d.widthM)} x ${m1(d.heightM)} m  (${metresToFeet(d.lengthM).toFixed(1)} x ${metresToFeet(d.widthM).toFixed(1)} x ${metresToFeet(d.heightM).toFixed(1)} ft)`,
      },
      { label: 'Floor area', value: areaMft(space.floorAreaM2) },
      { label: 'Ceiling height', value: mft(space.ceilingHeightM) },
      { label: 'Enclosed volume', value: volMft(space.enclosedVolumeM3) },
      { label: 'Storeys / levels', value: i0(space.storyCount) },
    ],
  };
  const planes: ReportSection = {
    title: 'Planes',
    rows: [
      { label: 'Floor', value: p.floorPresent ? `Present  ${areaMft(p.floorAreaM2)}` : 'Not detected' },
      { label: 'Ceiling', value: p.ceilingPresent ? `Present  ${areaMft(p.ceilingAreaM2)}` : 'Not detected' },
      {
        label: 'Walls',
        value: `${Math.round(p.wallCoveragePct)}% coverage / ~${p.dominantWallDirections} direction(s)`,
      },
    ],
  };
  return assemble(input, space, 'Interior space', [dims, planes, captureSection(space.quality)]);
}

/**
 * Build the pure content model for the OBJECT report from object + space metrics
 * (space supplies the capture-quality block + reasons).
 */
function objectContent(input: SpaceReportInput): SpaceReportContent {
  const o = input.object!;
  const space = input.space;
  const obb = o.obb;
  const aabb = o.aabb;
  const dims: ReportSection = {
    title: 'Dimensions',
    rows: [
      {
        label: 'Oriented (L x W x H)',
        value: `${m1(obb.lengthM)} x ${m1(obb.widthM)} x ${m1(obb.heightM)} m  (${metresToFeet(obb.lengthM).toFixed(1)} x ${metresToFeet(obb.widthM).toFixed(1)} x ${metresToFeet(obb.heightM).toFixed(1)} ft)`,
      },
      {
        label: 'Axis-aligned (L x W x H)',
        value: `${m1(aabb.lengthM)} x ${m1(aabb.widthM)} x ${m1(aabb.heightM)} m`,
      },
      { label: 'Largest dimension', value: mft(o.longestDimensionM) },
      { label: 'Envelope volume', value: volMftFine(o.envelopeVolumeM3) },
      { label: 'Bounding surface area', value: areaMftFine(o.surfaceAreaM2) },
      { label: 'Scan completeness', value: `${Math.round(o.completenessPct)}% of directions` },
    ],
  };
  const sections: ReportSection[] = [dims];
  if (space) sections.push(captureSection(space.quality));
  return assemble(input, space, 'Object', sections);
}

/** Common assembly: title, subtitle, provenance, provenance lines, caveats. */
function assemble(
  input: SpaceReportInput,
  space: SpaceMetrics | null,
  scanType: string,
  sections: ReportSection[],
): SpaceReportContent {
  const name = (input.name ?? '').trim() || 'Untitled scan';
  const u2m = input.unitToMetres && input.unitToMetres > 0 ? input.unitToMetres : 1;
  const provenance: SpaceReportProvenance = {
    software: SOFTWARE_NAME,
    softwareVersion: input.softwareVersion ?? 'unknown',
    metricVersion: input.metricVersion ?? 'unknown',
    generated: toIso(input.generatedAt),
    source: input.name ?? null,
    scanType,
    units: unitsLabel(u2m),
    sampledPointCount: space?.quality.sampledPointCount ?? 0,
    sourcePointCount: space?.quality.sourcePointCount ?? 0,
    notSurveyGrade: NOT_SURVEY_GRADE_NOTE,
  };
  return {
    title: name,
    subtitle: scanType,
    sections,
    provenance,
    provenanceLines: spaceProvenanceLines(provenance),
    caveats: space ? [...space.reasons] : [],
  };
}

/** Plain `Key  Value` provenance lines for the report footer. */
export function spaceProvenanceLines(p: SpaceReportProvenance): string[] {
  const KEY_W = 16;
  const kv = (k: string, v: string): string => `${k.padEnd(KEY_W)}${v}`;
  return [
    kv('Software', `${p.software} ${p.softwareVersion}`),
    kv('Metric version', p.metricVersion),
    kv('Generated', p.generated.slice(0, 16).replace('T', ' ') + ' UTC'),
    kv('Source', p.source ?? 'unknown'),
    kv('Scan type', p.scanType),
    kv('Units', p.units),
    kv('Points', `${i0(p.sampledPointCount)} used / ${i0(p.sourcePointCount)} source`),
    kv('Note', p.notSurveyGrade),
    // Route the space/object report through the ONE evidence gate (PR6): its
    // dimensional figures sit below their required level, so the report states
    // the exploratory verdict rather than shipping with no gate stamp.
    kv('Evidence', evidenceNote('MEAS-AREA')),
  ];
}

/**
 * Build the report content for the supplied scan. Routes to the interior or
 * object branch from `space.spaceKind`. When `space` is null (no measurements
 * yet) it returns a graceful, near-empty report rather than throwing.
 */
export function buildSpaceReportContent(input: SpaceReportInput): SpaceReportContent {
  if (!input.space) {
    return assemble(input, null, input.object ? 'Object' : 'Interior space', [
      { title: 'Measurements', rows: [{ label: 'Status', value: 'No measurements available yet.' }] },
    ]);
  }
  if (input.space.spaceKind === 'object' || input.object) {
    return objectContent(input);
  }
  return interiorContent(input);
}
