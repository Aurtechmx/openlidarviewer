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
 *
 * UNITS: the row formatters are selected from the RESOLVED linear-unit scale,
 * so the report cannot disclaim the scale in its provenance and stamp a metre
 * suffix on its rows at the same time. An unverified scale prints bare numbers
 * qualified as source units, with no foot conversion.
 */

import type { SpaceMetrics } from '../spaceMetrics';
import {
  metresToFeet,
  sqMetresToSqFeet,
  cubicMetresToCubicFeet,
  resolveLinearUnitScale,
} from '../spaceMetrics';
import type { ObjectMetrics } from '../objectMetrics';
import { SOFTWARE_NAME, NOT_SURVEY_GRADE_NOTE } from '../export/exportProvenance';
import { evidenceNote } from '../../validation/exportEvidenceNote';
import { type LinearUnitScale, UNIT_FACTORS } from '../../units/units';

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
  /** Points actually measured (the subset the metrics were computed over). */
  readonly measuredPointCount: number;
  /**
   * The LOADED / resident population that subset was drawn from. Never the
   * file's declared total: a display-sampled or still-streaming load holds far
   * fewer points than the file, so this must not be printed as "source".
   */
  readonly loadedPointCount: number;
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
  /**
   * Legacy source-unit→metre factor (from the CRS). AMBIGUOUS at exactly 1: a
   * genuine metre CRS and an unknown / local scan BOTH arrive as 1, so this
   * number alone cannot honestly assert metres. It is the LAST resort: the
   * scale on {@link space} (resolved from the CRS authority) and an explicit
   * {@link linearUnit} both outrank it, and a bare factor of 1 is read as an
   * UNKNOWN scale rather than the old "metres (assumed)".
   */
  readonly unitToMetres?: number;
  /**
   * The source frame's linear-unit scale as a discriminated union, so an unknown
   * unit can never be silently labelled metres. When supplied this WINS over
   * both `space.linearUnit` and {@link unitToMetres}: `knownUnit(1)` prints
   * "metres", a foot factor prints the feet→metres conversion, and
   * `unknownUnit()` states the coordinates are in the file's own units.
   *
   * Normally unnecessary: `space.linearUnit` already carries the authoritative
   * verdict, because `spaceMetrics` records the `unitKnown` flag the caller took
   * from the resolved `SpatialContext`.
   */
  readonly linearUnit?: LinearUnitScale;
}

const DASH = '—';
type Num = number | null | undefined;
const ok = (v: Num): v is number => v != null && Number.isFinite(v);
const m1 = (v: Num): string => (ok(v) ? v.toFixed(2) : DASH);
const i0 = (v: Num): string => (ok(v) ? Math.round(v).toLocaleString() : DASH);

// Source-unit qualifiers for the UNKNOWN-scale branch. They name the number's
// dimensionality without asserting a metre, so the row is still readable.
const SU = '(source units)';
const SU_SQ = '(square source units)';
const SU_CU = '(cubic source units)';

/**
 * The value formatters for one report, bound ONCE to the resolved scale.
 *
 * This is the seam the field defect went through: the row builders used to call
 * hard-coded ` m` / `metresToFeet(...)` helpers that never saw the scale, so a
 * report whose provenance said "scale unverified" still stamped metres on every
 * length and converted them to feet on top. With the formatters chosen from the
 * scale, an unverified unit CANNOT reach a metre suffix.
 *
 * Only the suffix and the presence of the conversion differ between the two
 * branches; the numbers are identical.
 */
interface UnitFormat {
  /** L x W x H with the foot conversion (the wide dimension rows). */
  readonly triple: (l: number, w: number, h: number) => string;
  /** L x W x H without a conversion (the axis-aligned row). */
  readonly tripleBare: (l: number, w: number, h: number) => string;
  /** A single length. */
  readonly len: (v: Num) => string;
  /** A coarse (rounded) area. */
  readonly area: (v: Num) => string;
  /** A coarse (rounded) volume. */
  readonly vol: (v: Num) => string;
  /** A fine (2 dp) area. */
  readonly areaFine: (v: Num) => string;
  /** A fine (2 dp) volume. */
  readonly volFine: (v: Num) => string;
  /** Mean point spacing. */
  readonly spacing: (v: Num) => string;
  /** Areal point density. */
  readonly density: (v: Num) => string;
}

/** Metric branch: the exact strings the report has always printed. */
const METRIC_FORMAT: UnitFormat = {
  triple: (l, w, h) =>
    `${m1(l)} x ${m1(w)} x ${m1(h)} m  (${metresToFeet(l).toFixed(1)} x ` +
    `${metresToFeet(w).toFixed(1)} x ${metresToFeet(h).toFixed(1)} ft)`,
  tripleBare: (l, w, h) => `${m1(l)} x ${m1(w)} x ${m1(h)} m`,
  len: (v) => (ok(v) ? `${v.toFixed(1)} m (${metresToFeet(v).toFixed(1)} ft)` : DASH),
  area: (v) =>
    ok(v)
      ? `${Math.round(v).toLocaleString()} m² (${Math.round(sqMetresToSqFeet(v)).toLocaleString()} ft²)`
      : DASH,
  vol: (v) =>
    ok(v)
      ? `${Math.round(v).toLocaleString()} m³ (${Math.round(cubicMetresToCubicFeet(v)).toLocaleString()} ft³)`
      : DASH,
  areaFine: (v) => (ok(v) ? `${v.toFixed(2)} m² (${sqMetresToSqFeet(v).toFixed(1)} ft²)` : DASH),
  volFine: (v) => (ok(v) ? `${v.toFixed(2)} m³ (${cubicMetresToCubicFeet(v).toFixed(1)} ft³)` : DASH),
  spacing: (v) => (ok(v) ? `${(v * 100).toFixed(1)} cm` : DASH),
  density: (v) => (ok(v) ? `${v.toFixed(1)} pts/m²` : DASH),
};

/**
 * Unknown branch: the SAME numbers with no metre suffix and no foot conversion.
 * Converting an unverified unit to feet would be a second fabrication stacked on
 * the first, so the conversion is dropped outright rather than relabelled. Mean
 * spacing loses its x100 centimetre rendering for the same reason: a centimetre
 * is a metre subdivision, and the scale is not known to be metres.
 */
const SOURCE_FORMAT: UnitFormat = {
  triple: (l, w, h) => `${m1(l)} x ${m1(w)} x ${m1(h)}  ${SU}`,
  tripleBare: (l, w, h) => `${m1(l)} x ${m1(w)} x ${m1(h)}  ${SU}`,
  len: (v) => (ok(v) ? `${v.toFixed(1)} ${SU}` : DASH),
  area: (v) => (ok(v) ? `${Math.round(v).toLocaleString()} ${SU_SQ}` : DASH),
  vol: (v) => (ok(v) ? `${Math.round(v).toLocaleString()} ${SU_CU}` : DASH),
  areaFine: (v) => (ok(v) ? `${v.toFixed(2)} ${SU_SQ}` : DASH),
  volFine: (v) => (ok(v) ? `${v.toFixed(2)} ${SU_CU}` : DASH),
  spacing: (v) => (ok(v) ? `${v.toFixed(3)} ${SU}` : DASH),
  density: (v) => (ok(v) ? `${v.toFixed(1)} pts per square source unit` : DASH),
};

const unitFormat = (scale: LinearUnitScale): UnitFormat =>
  scale.known ? METRIC_FORMAT : SOURCE_FORMAT;

function toIso(at: Date | string | null | undefined): string {
  if (at instanceof Date) return at.toISOString();
  if (typeof at === 'string' && at.length > 0) return at;
  return new Date().toISOString();
}

/**
 * Capture-quality section, shared between interior + object reports.
 *
 * The point row names BOTH populations for what they are. It used to read
 * "Points (used / source)", but the second number is the LOADED / resident
 * count the viewer holds, which for a display-sampled or still-streaming cloud
 * is far smaller than the file's declared total. Calling it "source" invited
 * the reader to treat a display sample as the whole file. The file total is not
 * available at this layer, so no file-total claim is printed at all.
 */
function captureSection(q: SpaceMetrics['quality'], f: UnitFormat): ReportSection {
  return {
    title: 'Capture quality',
    rows: [
      {
        label: 'Points (measured / loaded)',
        value: `${i0(q.sampledPointCount)} measured / ${i0(q.sourcePointCount)} loaded`,
      },
      { label: 'Density', value: f.density(q.densityPerM2) },
      { label: 'Mean spacing', value: f.spacing(q.meanSpacingM) },
      // HONESTY: coveragePct is occupied / (cols*rows) over the bounding-box
      // grid — a fill ratio of the extent, not a traced footprint. Label says so
      // (matches the ObjectPanel "Bounding area filled" row).
      { label: 'Bounding area filled', value: `${Math.round(q.coveragePct)}%` },
      { label: 'Colour (RGB)', value: q.hasRgb ? 'Yes' : 'No' },
    ],
  };
}

/** True when a metres-per-unit factor is an international or US-survey foot. */
function isFootFactor(metresPerUnit: number): boolean {
  return (
    Math.abs(metresPerUnit - UNIT_FACTORS.M_PER_FT) < 1e-6 ||
    Math.abs(metresPerUnit - UNIT_FACTORS.M_PER_US_FT) < 1e-6
  );
}

/**
 * HONEST source-unit label for the provenance block. An UNKNOWN scale must never
 * be printed as metres — it states the coordinates are in the file's own,
 * unverified units. A KNOWN metre CRS prints "metres"; a known foot CRS prints
 * the feet→metres conversion; any other known factor prints the explicit factor.
 */
function unitsLabel(scale: LinearUnitScale): string {
  if (!scale.known) return 'source units (scale unverified — not asserted as metres)';
  const f = scale.metresPerUnit;
  if (f === 1) return 'metres';
  if (isFootFactor(f)) return 'feet (source) → metres';
  return `source units × ${f} → metres`;
}

/**
 * The scale this report prints under, in authority order:
 *
 * 1. an explicit {@link SpaceReportInput.linearUnit};
 * 2. the scale the metrics were COMPUTED under, which the CRS authority
 *    resolved (`SpatialContext.linearUnitKnown` reaches `spaceMetrics` as
 *    `unitKnown` and is recorded on the result). This is how a declared metre
 *    CRS stops being read as unknown: the factor is 1 either way, but the
 *    authority knows which 1 it is;
 * 3. the legacy bare factor, which cannot tell the two apart and so fails
 *    closed to unknown at exactly 1.
 *
 * Order 2 before 3 deliberately: a metrics object that says the unit is
 * unverified must not be overridden by a bare factor supplied alongside it.
 */
function reportScale(input: SpaceReportInput): LinearUnitScale {
  return (
    input.linearUnit ??
    input.space?.linearUnit ??
    resolveLinearUnitScale(input.unitToMetres, undefined)
  );
}

/**
 * Build the pure content model for the INTERIOR report from space metrics.
 */
function interiorContent(input: SpaceReportInput, scale: LinearUnitScale): SpaceReportContent {
  const space = input.space!;
  const d = space.dims;
  const p = space.planes;
  const f = unitFormat(scale);
  const dims: ReportSection = {
    title: 'Dimensions',
    rows: [
      { label: 'L x W x H', value: f.triple(d.lengthM, d.widthM, d.heightM) },
      { label: 'Floor area', value: f.area(space.floorAreaM2) },
      { label: 'Ceiling height', value: f.len(space.ceilingHeightM) },
      { label: 'Enclosed volume', value: f.vol(space.enclosedVolumeM3) },
      { label: 'Storeys / levels', value: i0(space.storyCount) },
    ],
  };
  const planes: ReportSection = {
    title: 'Planes',
    rows: [
      { label: 'Floor', value: p.floorPresent ? `Present  ${f.area(p.floorAreaM2)}` : 'Not detected' },
      { label: 'Ceiling', value: p.ceilingPresent ? `Present  ${f.area(p.ceilingAreaM2)}` : 'Not detected' },
      {
        label: 'Walls',
        value: `${Math.round(p.wallCoveragePct)}% coverage / ~${p.dominantWallDirections} direction(s)`,
      },
    ],
  };
  return assemble(input, space, 'Interior space', [dims, planes, captureSection(space.quality, f)], scale);
}

/**
 * Build the pure content model for the OBJECT report from object + space metrics
 * (space supplies the capture-quality block + reasons).
 */
function objectContent(input: SpaceReportInput, scale: LinearUnitScale): SpaceReportContent {
  const o = input.object!;
  const space = input.space;
  const obb = o.obb;
  const aabb = o.aabb;
  const f = unitFormat(scale);
  const dims: ReportSection = {
    title: 'Dimensions',
    rows: [
      { label: 'Oriented (L x W x H)', value: f.triple(obb.lengthM, obb.widthM, obb.heightM) },
      {
        label: 'Axis-aligned (L x W x H)',
        value: f.tripleBare(aabb.lengthM, aabb.widthM, aabb.heightM),
      },
      { label: 'Largest dimension', value: f.len(o.longestDimensionM) },
      { label: 'Envelope volume', value: f.volFine(o.envelopeVolumeM3) },
      { label: 'Bounding surface area', value: f.areaFine(o.surfaceAreaM2) },
      { label: 'Scan completeness', value: `${Math.round(o.completenessPct)}% of directions` },
    ],
  };
  const sections: ReportSection[] = [dims];
  if (space) sections.push(captureSection(space.quality, f));
  return assemble(input, space, 'Object', sections, scale);
}

/** Common assembly: title, subtitle, provenance, provenance lines, caveats. */
function assemble(
  input: SpaceReportInput,
  space: SpaceMetrics | null,
  scanType: string,
  sections: ReportSection[],
  scale: LinearUnitScale,
): SpaceReportContent {
  const name = (input.name ?? '').trim() || 'Untitled scan';
  const provenance: SpaceReportProvenance = {
    software: SOFTWARE_NAME,
    softwareVersion: input.softwareVersion ?? 'unknown',
    metricVersion: input.metricVersion ?? 'unknown',
    generated: toIso(input.generatedAt),
    source: input.name ?? null,
    scanType,
    units: unitsLabel(scale),
    measuredPointCount: space?.quality.sampledPointCount ?? 0,
    loadedPointCount: space?.quality.sourcePointCount ?? 0,
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
  // Keys wider than the column still need a gutter (same guarantee as the
  // terrain provenance kv), or key and value jam into one token.
  const kv = (k: string, v: string): string => `${k.padEnd(Math.max(KEY_W, k.length + 2))}${v}`;
  return [
    kv('Software', `${p.software} ${p.softwareVersion}`),
    kv('Metric version', p.metricVersion),
    kv('Generated', p.generated.slice(0, 16).replace('T', ' ') + ' UTC'),
    kv('Source', p.source ?? 'unknown'),
    kv('Scan type', p.scanType),
    kv('Units', p.units),
    kv('Points', `${i0(p.measuredPointCount)} measured / ${i0(p.loadedPointCount)} loaded in viewer`),
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
  const scale = reportScale(input);
  if (!input.space) {
    return assemble(
      input,
      null,
      input.object ? 'Object' : 'Interior space',
      [{ title: 'Measurements', rows: [{ label: 'Status', value: 'No measurements available yet.' }] }],
      scale,
    );
  }
  if (input.space.spaceKind === 'object' || input.object) {
    return objectContent(input, scale);
  }
  return interiorContent(input, scale);
}
