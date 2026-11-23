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

import type { SpaceMetrics, SpaceNote } from '../spaceMetrics';
import {
  metresToFeet,
  sqMetresToSqFeet,
  cubicMetresToCubicFeet,
  resolveLinearUnitScale,
  fineDecimals,
} from '../spaceMetrics';
import type { ObjectMetrics } from '../objectMetrics';
import { SOFTWARE_NAME } from '../export/exportProvenance';
import { type LinearUnitScale, UNIT_FACTORS } from '../../units/units';
import { SPACE_REPORT_TEXT, type SpaceReportKey } from '../../i18n/deliverables/spaceReport';
import { ENGLISH, type ExportLocale } from '../../i18n/exportLocale';
import { languageInfo } from '../../i18n/languages';
import { fill } from '../../i18n/message';
import { fixed, grouped, restyleNumbers, withDecimalMark, type NumberStyle } from '../../i18n/numberStyle';

/**
 * One label/value line in a report section, with the OPTIONAL per-row qualifier
 * that says what the number is.
 *
 * The panel carried those qualifiers as tooltips ("Bounding envelope, not a
 * solid volume"; "the envelope's skin, not the object's true (mesh) surface")
 * and the row type had no field for them, so the export printed a bare envelope
 * volume and a bare bounding surface area with nothing naming either one. The
 * hint rides the row so both surfaces read from the same string.
 */
export interface ReportRow {
  readonly label: string;
  readonly value: string;
  /** Qualifier printed under the value; single-sourced with the panel. */
  readonly hint?: string;
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
  /**
   * Points actually measured (the subset the metrics were computed over), or
   * null when there are no measurements. NEVER 0 as a stand-in for absent: the
   * no-measurements branch used to render "Points  0 measured / 0 loaded",
   * which reads as a scan that loaded nothing rather than one not yet measured.
   */
  readonly measuredPointCount: number | null;
  /**
   * The LOADED / resident population that subset was drawn from. Never the
   * file's declared total: a display-sampled or still-streaming load holds far
   * fewer points than the file, so this must not be printed as "source". Null
   * when absent, for the same reason as {@link measuredPointCount}.
   */
  readonly loadedPointCount: number | null;
  /** Truncation note for a truncated source file; null for a complete read. */
  readonly coverage?: string | null;
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
  /**
   * Truncation note when the scan's file is truncated, e.g. "Truncated: 4 of
   * 2,601 points read". Printed as a Coverage row; absent for a complete read.
   */
  readonly coverageNote?: string | null;
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
  /**
   * The language and number style to write the report in. English with point
   * decimals when absent; the English report is byte-identical to the one
   * printed before the report had a catalog.
   */
  readonly locale?: ExportLocale;
}

const DASH = '—';
type Num = number | null | undefined;
const ok = (v: Num): v is number => v != null && Number.isFinite(v);

/**
 * The words and number writers for one report: the catalog of its language
 * and the helpers bound to its number style.
 */
interface ReportWords {
  readonly style: NumberStyle;
  /** The catalog entry for `key`, its parameters filled. */
  readonly t: (key: SpaceReportKey, params?: Record<string, string | number>) => string;
  /** Two decimals, or a dash. */
  readonly m1: (v: Num) => string;
  /** A grouped whole number, or a dash. */
  readonly i0: (v: Num) => string;
  /** `toFixed` in the report's number style. */
  readonly fx: (v: number, digits: number) => string;
}

function reportWords(locale: ExportLocale): ReportWords {
  const catalog = SPACE_REPORT_TEXT[locale.lang];
  const style = locale.numberStyle;
  return {
    style,
    t: (key, params) => fill(catalog[key], params, key),
    m1: (v) => (ok(v) ? fixed(style, v, 2) : DASH),
    i0: (v) => (ok(v) ? grouped(style, v) : DASH),
    fx: (v, digits) => fixed(style, v, digits),
  };
}

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
  /** A fine area, printed at the precision its magnitude supports. */
  readonly areaFine: (v: Num) => string;
  /** A fine volume, printed at the precision its magnitude supports. */
  readonly volFine: (v: Num) => string;
  /** Mean point spacing. */
  readonly spacing: (v: Num) => string;
  /** Areal point density. */
  readonly density: (v: Num) => string;
}

/**
 * A fine figure in the report's number style, at the decimal count its
 * magnitude supports. The panel's `magnitudeFixed` groups in the host's locale,
 * and a grouping comma left in a comma-style report reads as a decimal.
 */
function magnitude(style: NumberStyle, v: number, maxDecimals: number): string {
  const d = Math.min(maxDecimals, fineDecimals(v));
  return d === 0 ? grouped(style, v) : fixed(style, v, d);
}

/** Metric branch: in English, the exact strings the report has always printed. */
function metricFormat(w: ReportWords): UnitFormat {
  const { m1, i0, fx, style } = w;
  const mag = (v: number, d: number): string => magnitude(style, v, d);
  return {
    triple: (l, wd, h) =>
      `${m1(l)} x ${m1(wd)} x ${m1(h)} m  (${fx(metresToFeet(l), 1)} x ` +
      `${fx(metresToFeet(wd), 1)} x ${fx(metresToFeet(h), 1)} ft)`,
    tripleBare: (l, wd, h) => `${m1(l)} x ${m1(wd)} x ${m1(h)} m`,
    len: (v) => (ok(v) ? `${fx(v, 1)} m (${fx(metresToFeet(v), 1)} ft)` : DASH),
    area: (v) => (ok(v) ? `${i0(v)} m² (${i0(sqMetresToSqFeet(v))} ft²)` : DASH),
    vol: (v) => (ok(v) ? `${i0(v)} m³ (${i0(cubicMetresToCubicFeet(v))} ft³)` : DASH),
    areaFine: (v) => (ok(v) ? `${mag(v, 2)} m² (${mag(sqMetresToSqFeet(v), 1)} ft²)` : DASH),
    volFine: (v) => (ok(v) ? `${mag(v, 2)} m³ (${mag(cubicMetresToCubicFeet(v), 1)} ft³)` : DASH),
    spacing: (v) => (ok(v) ? `${fx(v * 100, 1)} cm` : DASH),
    density: (v) => (ok(v) ? w.t('densityMetric', { v: fx(v, 1) }) : DASH),
  };
}

/**
 * Unknown branch: the SAME numbers with no metre suffix and no foot conversion.
 * Converting an unverified unit to feet would be a second fabrication stacked on
 * the first, so the conversion is dropped outright rather than relabelled. Mean
 * spacing loses its x100 centimetre rendering for the same reason: a centimetre
 * is a metre subdivision, and the scale is not known to be metres.
 */
function sourceFormat(w: ReportWords): UnitFormat {
  const { m1, i0, fx, style } = w;
  const mag = (v: number, d: number): string => magnitude(style, v, d);
  const SU = w.t('sourceUnits');
  const SU_SQ = w.t('sourceUnitsSq');
  const SU_CU = w.t('sourceUnitsCu');
  return {
    triple: (l, wd, h) => `${m1(l)} x ${m1(wd)} x ${m1(h)}  ${SU}`,
    tripleBare: (l, wd, h) => `${m1(l)} x ${m1(wd)} x ${m1(h)}  ${SU}`,
    len: (v) => (ok(v) ? `${fx(v, 1)} ${SU}` : DASH),
    area: (v) => (ok(v) ? `${i0(v)} ${SU_SQ}` : DASH),
    vol: (v) => (ok(v) ? `${i0(v)} ${SU_CU}` : DASH),
    areaFine: (v) => (ok(v) ? `${mag(v, 2)} ${SU_SQ}` : DASH),
    volFine: (v) => (ok(v) ? `${mag(v, 2)} ${SU_CU}` : DASH),
    spacing: (v) => (ok(v) ? `${fx(v, 3)} ${SU}` : DASH),
    density: (v) => (ok(v) ? w.t('densitySource', { v: fx(v, 1) }) : DASH),
  };
}

const unitFormat = (scale: LinearUnitScale, w: ReportWords): UnitFormat =>
  scale.known ? metricFormat(w) : sourceFormat(w);

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
function captureSection(q: SpaceMetrics['quality'], f: UnitFormat, w: ReportWords): ReportSection {
  const { t, i0 } = w;
  return {
    title: t('secCapture'),
    rows: [
      {
        label: t('points'),
        value: t('pointsValue', { measured: i0(q.sampledPointCount), loaded: i0(q.sourcePointCount) }),
      },
      { label: t('density'), value: f.density(q.densityPerM2) },
      { label: t('spacing'), value: f.spacing(q.meanSpacingM) },
      // HONESTY: coveragePct is occupied / (cols*rows) over the bounding-box
      // grid — a fill ratio of the extent, not a traced footprint. Label says so
      // (matches the ObjectPanel "Bounding area filled" row).
      { label: t('boundingFilled'), value: t('percent', { pct: Math.round(q.coveragePct) }) },
      { label: t('colour'), value: q.hasRgb ? t('yes') : t('no') },
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
function unitsLabel(scale: LinearUnitScale, w: ReportWords): string {
  if (!scale.known) return w.t('unitsUnknown');
  const f = scale.metresPerUnit;
  if (f === 1) return w.t('unitsMetres');
  if (isFootFactor(f)) return w.t('unitsFeet');
  return w.t('unitsFactor', { f: withDecimalMark(w.style, String(f)) });
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
function interiorContent(input: SpaceReportInput, scale: LinearUnitScale, w: ReportWords): SpaceReportContent {
  const { t, i0 } = w;
  const space = input.space!;
  const d = space.dims;
  const p = space.planes;
  const f = unitFormat(scale, w);
  const dims: ReportSection = {
    title: t('secDimensions'),
    rows: [
      { label: t('lxwxh'), value: f.triple(d.lengthM, d.widthM, d.heightM) },
      { label: t('footprint'), value: f.area(space.floorAreaM2) },
      { label: t('ceilingHeight'), value: f.len(space.ceilingHeightM) },
      { label: t('enclosedVolume'), value: f.vol(space.enclosedVolumeM3) },
      { label: t('storeys'), value: i0(space.storyCount) },
    ],
  };
  const planes: ReportSection = {
    title: t('secPlanes'),
    rows: [
      { label: t('floor'), value: p.floorPresent ? t('present', { area: f.area(p.floorAreaM2) }) : t('notDetected') },
      { label: t('ceiling'), value: p.ceilingPresent ? t('present', { area: f.area(p.ceilingAreaM2) }) : t('notDetected') },
      {
        label: t('walls'),
        value: t('wallsValue', { pct: Math.round(p.wallCoveragePct), n: p.dominantWallDirections }),
      },
    ],
  };
  return assemble(input, space, t('scanInterior'), [dims, planes, captureSection(space.quality, f, w)], scale, w);
}

/**
 * Build the pure content model for the OBJECT report from object + space metrics
 * (space supplies the capture-quality block + reasons).
 */
function objectContent(input: SpaceReportInput, scale: LinearUnitScale, w: ReportWords): SpaceReportContent {
  const { t } = w;
  const o = input.object!;
  const space = input.space;
  const obb = o.obb;
  const aabb = o.aabb;
  const f = unitFormat(scale, w);
  const dims: ReportSection = {
    title: t('secDimensions'),
    rows: [
      { label: t('oriented'), value: f.triple(obb.lengthM, obb.widthM, obb.heightM) },
      {
        label: t('axisAligned'),
        value: f.tripleBare(aabb.lengthM, aabb.widthM, aabb.heightM),
      },
      // The hints are the panel's tooltips (objectMetrics.ts); the English
      // catalog holds the same sentences, and a test keeps them equal.
      { label: t('largest'), value: f.len(o.longestDimensionM), hint: t('hintLargest') },
      { label: t('envelopeVolume'), value: f.volFine(o.envelopeVolumeM3), hint: t('hintEnvelopeVolume') },
      { label: t('boundingSurface'), value: f.areaFine(o.surfaceAreaM2), hint: t('hintBoundingSurface') },
      // Was "Scan completeness ... % of directions", which read as capture
      // completeness. The figure bins directions about the centroid, so its
      // ceiling is the shape of the point set, not how much was captured.
      {
        label: t('angularCoverage'),
        value: t('angularValue', { pct: Math.round(o.completenessPct) }),
        hint: t('hintAngular'),
      },
    ],
  };
  const sections: ReportSection[] = [dims];
  if (space) sections.push(captureSection(space.quality, f, w));
  return assemble(input, space, t('scanObject'), sections, scale, w);
}

/** Common assembly: title, subtitle, provenance, provenance lines, caveats. */
function assemble(
  input: SpaceReportInput,
  space: SpaceMetrics | null,
  scanType: string,
  sections: ReportSection[],
  scale: LinearUnitScale,
  w: ReportWords,
): SpaceReportContent {
  const { t } = w;
  const locale = input.locale ?? ENGLISH;
  const name = (input.name ?? '').trim() || t('untitled');
  const provenance: SpaceReportProvenance = {
    software: SOFTWARE_NAME,
    softwareVersion: input.softwareVersion ?? t('unknown'),
    metricVersion: input.metricVersion ?? t('unknown'),
    generated: toIso(input.generatedAt),
    source: input.name ?? null,
    scanType,
    units: unitsLabel(scale, w),
    measuredPointCount: space?.quality.sampledPointCount ?? null,
    loadedPointCount: space?.quality.sourcePointCount ?? null,
    coverage: input.coverageNote?.trim() || null,
    notSurveyGrade: t('notSurveyGrade'),
  };
  return {
    title: name,
    subtitle: scanType,
    sections,
    provenance,
    provenanceLines: spaceProvenanceLines(provenance, locale),
    caveats: space ? caveatsIn(space, w, locale) : [],
  };
}

/**
 * The metrics' caveats in the report's language. English with point decimals prints the metrics'
 * own sentences, as it always has. Another language says each coded note in
 * that language; a metrics object without notes (one built before notes
 * existed, or by hand in a test) keeps its English sentences rather than lose
 * a caveat.
 */
function caveatsIn(space: SpaceMetrics, w: ReportWords, locale: ExportLocale): string[] {
  if ((locale.lang === 'en' && locale.numberStyle === 'point') || !space.notes || space.notes.length !== space.reasons.length) return [...space.reasons];
  return space.notes.map((n) => noteText(n, w));
}

/** One coded caveat in the report's language. */
export function noteText(n: SpaceNote, w: ReportWords): string {
  switch (n.code) {
    case 'stream': return w.t('noteStream');
    case 'stream-partial': return w.t('noteStreamPartial');
    case 'unit-unverified': return w.t('noteUnitUnverified');
    case 'too-few-points': return w.t('noteTooFewPoints');
    case 'stray-excluded': return w.t('noteStrayExcluded', { count: w.i0(n.count) });
    case 'density-scaled': return w.t('noteDensityScaled', { measured: w.i0(n.measured), loaded: w.i0(n.loaded) });
    case 'ceiling-approximate': return w.t('noteCeilingApproximate');
    case 'ceiling-missing': return w.t('noteCeilingMissing');
    case 'walls-estimate': return w.t('noteWallsEstimate');
    case 'open-object': return w.t('noteOpenObject');
  }
}

/**
 * The evidence stamp for the space / object report.
 *
 * This footer used to print `evidenceNote('MEAS-AREA')`. MEAS-AREA is at
 * E4_CROSS_IMPLEMENTATION_VALIDATED, so the note took the strong branch and
 * told the reader the product was "cross-implementation validated against an
 * independent implementation". MEAS-AREA is the planimetric shoelace area of a
 * user-drawn polygon, checked against OGR_GEOM_AREA on a planar-polygon
 * fixture. This report's headline figures are a PCA envelope volume, an
 * oriented-box surface area, an angular-coverage ratio and a sampled density.
 * The polygon claim covers none of them.
 *
 * No entry in the claim registry does: the VOL- claims are point-sample volumes
 * measured against a base surface, which is a different estimator again. So the
 * report makes NO cross-validation claim and states what its figures actually
 * are. Registering a claim for these products is the way to change this line.
 */
// The footer prints this under an "Evidence" key, so the sentence does not
// repeat the word: the line read "Evidence   Evidence: unvalidated ...".
export const SPACE_REPORT_EVIDENCE_NOTE = SPACE_REPORT_TEXT.en.evidence;

/**
 * Plain `Key  Value` provenance lines for the report footer. A report in a
 * language other than English adds a Language line, which says when the
 * translation has not been reviewed yet.
 */
export function spaceProvenanceLines(p: SpaceReportProvenance, locale: ExportLocale = ENGLISH): string[] {
  const w = reportWords(locale);
  const { t, i0 } = w;
  const KEY_W = 16;
  // Keys wider than the column still need a gutter (same guarantee as the
  // terrain provenance kv), or key and value jam into one token.
  const kv = (k: string, v: string): string => `${k.padEnd(Math.max(KEY_W, k.length + 2))}${v}`;
  const info = languageInfo(locale.lang);
  return [
    kv(t('kSoftware'), `${p.software} ${p.softwareVersion}`),
    kv(t('kMetricVersion'), p.metricVersion),
    kv(t('kGenerated'), p.generated.slice(0, 16).replace('T', ' ') + ' UTC'),
    kv(t('kSource'), p.source ?? t('unknown')),
    kv(t('kScanType'), p.scanType),
    kv(t('kUnits'), p.units),
    ...(locale.lang === 'en' ? [] : [kv(t('kLanguage'), info.reviewed ? info.name : t('languageDraft', { name: info.name }))]),
    kv(t('kPoints'), t('pointsLine', { measured: i0(p.measuredPointCount), loaded: i0(p.loadedPointCount) })),
    ...(p.coverage ? [kv(t('kCoverage'), t('coverageLine', { coverage: restyleNumbers(p.coverage, w.style) }))] : []),
    kv(t('kNote'), p.notSurveyGrade),
    kv(t('kEvidence'), t('evidence')),
  ];
}

/**
 * Build the report content for the supplied scan. Routes to the interior or
 * object branch from `space.spaceKind`. When `space` is null (no measurements
 * yet) it returns a graceful, near-empty report rather than throwing.
 */
export function buildSpaceReportContent(input: SpaceReportInput): SpaceReportContent {
  const scale = reportScale(input);
  const w = reportWords(input.locale ?? ENGLISH);
  const { t } = w;
  if (!input.space) {
    return assemble(
      input,
      null,
      input.object ? t('scanObject') : t('scanInterior'),
      [{ title: t('secMeasurements'), rows: [{ label: t('status'), value: t('noMeasurements') }] }],
      scale,
      w,
    );
  }
  if (input.space.spaceKind === 'object' || input.object) {
    return objectContent(input, scale, w);
  }
  return interiorContent(input, scale, w);
}

/** The report's words for `locale`, for the PDF renderer's own labels. */
export function spaceReportWords(locale: ExportLocale = ENGLISH): ReportWords {
  return reportWords(locale);
}
export type { ReportWords };
