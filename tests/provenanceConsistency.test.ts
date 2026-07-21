/**
 * provenanceConsistency.test.ts — ONE provenance object, EVERY exporter.
 *
 * exportProvenance.ts promises that a single {@link ExportProvenance} derived
 * once from the analysis run is stamped word-for-word identically into every
 * artifact: the DEM package README (demPackage.ts), the contour GeoJSON / DXF /
 * SVG (contourDownload.ts → geojsonContours / dxfContours / svgContours), the
 * map-sheet PDF title block (mapSheetPdf.ts) and the Terrain Intelligence
 * Report content (terrainReportContent.ts). exportWriters.test.ts and friends
 * pin each serialiser in isolation; THIS suite drives all of them from the
 * SAME run + the SAME provenance object and asserts the user-visible fields
 * (surface-quality tier, export readiness + reason, CRS, datum, software +
 * metric version, accuracy figures, generation date) agree across every
 * output — so a "DEM says Preview, report says Good" class of drift fails
 * loudly, naming the exporter that diverged.
 *
 * Outputs are inspected the way a recipient would see them: the GeoJSON is
 * parsed and its `metadata` compared field-by-field, the DXF / SVG / README
 * text is scanned for the exact provenance lines, the report content rows are
 * read structurally, and the map-sheet PDF has its content streams inflated
 * and its text-show operators decoded so the printed title-block strings are
 * asserted for real (pdf-lib Flate-compresses content streams and hex-encodes
 * text, so a raw byte scan would see nothing).
 *
 * Pure data + pdf-lib; no DOM, no I/O beyond the in-memory artifacts.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  buildExportProvenance,
  provenanceLines,
  type ExportProvenance,
} from '../src/terrain/export/exportProvenance';
import { buildDemReadme } from '../src/terrain/export/demPackage';
import { serializeContours } from '../src/terrain/contour/contourDownload';
import { buildMapSheetPdf } from '../src/render/measure/mapSheetPdf';
import {
  buildTerrainReportContent,
  type TerrainReportContent,
} from '../src/terrain/export/terrainReportContent';
import { terrainAssessment } from '../src/terrain/contour/terrainAssessment';
import { SLOPE_ASPECT_CONVENTION_NOTE } from '../src/terrain/complexity/complexitySummary';
import { recommendedWorkflows } from '../src/terrain/contour/recommendedWorkflow';
import { terrainProducts } from '../src/terrain/contour/terrainProducts';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import type {
  ContourFeatureModel,
  ContourFeature,
} from '../src/terrain/contour/contourFeatureModel';

// ── the ONE run every exporter is driven from ───────────────────────────────

const OPTS = {
  basename: 'site',
  generatedAt: '2026-06-05T00:00:00.000Z',
  softwareVersion: '9.9.9',
  metricVersion: 'v0.4.1',
} as const;

/**
 * A complete, full-coverage, export-ready analysis result with everything
 * known — the same shape exportProvenance.test.ts / demPackageReadme.test.ts /
 * terrainReportContent.test.ts use, merged so ONE result drives the README
 * (needs the real grids), the report content (needs the quality ratios) and
 * the provenance builder. Hand-computed verdicts: tally 90/95 measured →
 * interpolation ~5%, all caps pass → surface 'Good'; CRS + datum known →
 * export 'Ready' with reason ''.
 */
function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      z: new Float32Array([10, 20, 30, 40]),
      coverage: new Uint8Array([2, 2, 1, 0]),
      cols: 2, rows: 2, cellSizeM: 1,
      originH1: 0, originH2: 0,
      crs: 'EPSG:32610', verticalDatum: 'EPSG:5703',
      coverageMode: 'full', meanConfidence: 82,
      sourcePointCount: 1_200_000, analyzedPointCount: 900_000,
    },
    intervalM: 1,
    surface: { canopy: { heightM: new Float32Array([0, 5, NaN, NaN]) } },
    model: {
      crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1,
      contourStyle: 'smooth', coverageMode: 'full', features: [{}, {}],
    },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      qualityLevel: 'QL2', qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, coverageMode: 'full',
      reasons: [], exportReasons: [],
      interpolatedCellRatio: 0.06, emptyCellRatio: 0.05, edgeRiskRatio: 0.02,
      meanCellConfidence: 82, groundPointRatio: 0.6,
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    excludedByClassification: 1200,
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    // Derived terrain complexity (v0.5.4) — the summary the core computes.
    // Every provenance/report surface must stamp these SAME strings.
    complexity: {
      vrmMedian: 0.034, vrmP25: 0.02, vrmP75: 0.041, vrmIqr: 0.021,
      vrmWindowCells: 3, vrmWindowGroundM: 3,
      tpiMedian: 0.12, tpiIqr: 0.4,
      tpiRadiusCells: 10, tpiRadiusGroundM: 10,
      tpiDominantClass: 'middle', tpiDominantFraction: 0.58,
      band: 'high', bandLabel: 'High', zUnitLabel: 'm',
      confidence: 82, validCellCount: 95, cellCount: 100,
      vrmText: 'median 0.0340 [IQR 0.0210], 3×3-cell window (≈3.0 m), dimensionless',
      tpiText:
        'dominant class middle slope (58% of valid cells), median 0.12 [IQR 0.40] m, radius 10 cells (≈10 m)',
      detail:
        'VRM median 0.0340 [IQR 0.0210], 3×3-cell window (≈3.0 m), dimensionless; TPI dominant class middle slope (58% of valid cells), median 0.12 [IQR 0.40] m, radius 10 cells (≈10 m); derived, confidence 82/100',
      slopeAspectConvention: SLOPE_ASPECT_CONVENTION_NOTE,
      groundDensityPerM2: 4.2,
      warnings: [
        '5 of 100 cells (5%) are voids or invalid — summarised over the 95 valid cells only',
      ],
    },
    warnings: ['Removed 2 outlier ground cell(s) before building the surface.'],
  } as unknown as AnalyseContoursResult;
}

/**
 * The same run with NO georeferencing. Hand-computed verdicts: the surface
 * metrics are untouched so surface quality stays 'Good', but the missing CRS
 * AND vertical datum cap export readiness to 'Preview' with the exact reason
 * 'CRS unknown and vertical datum unknown' — the case where a sloppy exporter
 * could most plausibly diverge (one stamping the surface verdict, another the
 * export verdict).
 */
function noGeorefResult(): AnalyseContoursResult {
  const base = readyResult() as unknown as {
    dtm: Record<string, unknown>;
    model: Record<string, unknown>;
    quality: Record<string, unknown>;
  };
  return {
    ...(base as unknown as AnalyseContoursResult),
    dtm: { ...base.dtm, crs: null, verticalDatum: null },
    model: { ...base.model, crs: null, verticalDatum: null },
    quality: { ...base.quality, crsKnown: false, datumKnown: false, exportReadiness: 'previewOnly' },
  } as unknown as AnalyseContoursResult;
}

/** A small contour model whose frame fields MATCH the run above. */
function contourModel(crs: string | null, verticalDatum: string | null): ContourFeatureModel {
  const features: ContourFeature[] = [
    { value: 10, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [10, 0], [10, 10]] },
    { value: 11, isIndex: false, grade: 'dashed', meanConfidence: 40, closed: false, coordinates: [[0, 5], [10, 5]] },
  ];
  return {
    features,
    crs,
    verticalDatum,
    intervalM: 1,
    contourStyle: 'smooth',
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    interpolatedFraction: 0.2,
    coverageMode: 'full',
    warnings: [],
  };
}

// ── reading the outputs the way a recipient would ───────────────────────────

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Extract the drawn text from a pdf-lib PDF: inflate every Flate stream
 * (content streams carry the page text; non-deflated streams pass through) and
 * decode the hex-encoded show-text operators (`<48656c6c6f> Tj`). Returns the
 * strings in draw order, newline-separated.
 */
function pdfText(bytes: Uint8Array): string {
  const whole = latin1(bytes);
  let streams = '';
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(whole)) !== null) {
    const start = m.index + m[0].length;
    const end = whole.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = bytes.subarray(start, end);
    try {
      streams += latin1(new Uint8Array(inflateSync(raw)));
    } catch {
      streams += latin1(raw); // not deflated — scan as-is
    }
  }
  let out = '';
  for (const hit of streams.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
    let s = '';
    for (let i = 0; i + 1 < hit[1].length; i += 2) {
      s += String.fromCharCode(parseInt(hit[1].slice(i, i + 2), 16));
    }
    out += `${s}\n`;
  }
  return out;
}

/** The value of one `Key  Value` provenance line in a text artifact. */
function kvValue(text: string, key: string): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^\\s*${esc}\\s{2,}(.+)$`, 'm').exec(text);
  return m ? m[1].trim() : '(missing)';
}

/** Strip the " — reason" suffix off an export-readiness line value. */
function verdictOnly(lineValue: string): string {
  return lineValue.split(' — ')[0].trim();
}

/** Map the sheet's printed readiness note back onto the provenance verdict. */
function mapSheetVerdict(text: string): string {
  // The note wraps across lines in the title-block column, so collapse
  // whitespace before matching — the verdict is about which note is present,
  // not where its line breaks fall.
  const flat = text.replace(/\s+/g, ' ');
  const ready = flat.includes('not a survey certification');
  const preview = flat.includes('PREVIEW - not survey-grade');
  if (ready && !preview) return 'Ready';
  if (preview && !ready) return 'Preview';
  return '(missing)';
}

/** One row value out of the report content's label/value sections. */
function reportRow(content: TerrainReportContent, section: string, label: string): string {
  const s = content.sections.find((x) => x.title === section);
  const r = s?.rows.find((x) => x.label === label);
  return r?.value ?? '(missing)';
}

// ── building every artifact from the SAME provenance object ─────────────────

interface RunOutputs {
  readonly prov: ExportProvenance;
  readonly demReadme: string;
  readonly geojson: Record<string, any>;
  readonly dxf: string;
  readonly svg: string;
  readonly mapSheetText: string;
  readonly report: TerrainReportContent;
}

async function buildAll(
  result: AnalyseContoursResult,
  model: ContourFeatureModel,
): Promise<RunOutputs> {
  // ONE provenance object — exactly what AnalysePanel builds once per run and
  // hands to every exporter.
  const prov = buildExportProvenance(result, OPTS);

  const demReadme = buildDemReadme({
    result,
    basename: OPTS.basename,
    isGeographic: false,
    boundsMinX: 600000, boundsMinY: 4000000, boundsMaxX: 600002, boundsMaxY: 4000002,
    generationDateIso: OPTS.generatedAt,
    softwareName: 'OpenLiDARViewer',
    softwareVersion: OPTS.softwareVersion,
    metricVersion: OPTS.metricVersion,
  });

  // Zero world origin: the geometry stays put but the frame contract is kept
  // (a zero shift returns the model unchanged, CRS stamp included).
  const serOpts = { basename: OPTS.basename, provenance: prov, worldOrigin: { x: 0, y: 0 } };
  const geojson = JSON.parse(serializeContours(model, 'geojson-native', serOpts).content) as Record<string, any>;
  const dxf = serializeContours(model, 'dxf', serOpts).content;
  const svg = serializeContours(model, 'svg', serOpts).content;

  const pdfBytes = await buildMapSheetPdf({
    model,
    labels: [],
    worldOrigin: { x: 585000, y: 3386000 },
    provenance: prov,
    title: 'Consistency sheet',
    preparedBy: 'Test',
  });
  const mapSheetText = pdfText(pdfBytes);

  const report = buildTerrainReportContent(result, OPTS);

  return { prov, demReadme, geojson, dxf, svg, mapSheetText, report };
}

// Built once per scenario, shared across the tests below.
let readyOutputsP: Promise<RunOutputs> | undefined;
const readyOutputs = (): Promise<RunOutputs> =>
  (readyOutputsP ??= buildAll(readyResult(), contourModel('EPSG:32610', 'EPSG:5703')));

let previewOutputsP: Promise<RunOutputs> | undefined;
const previewOutputs = (): Promise<RunOutputs> =>
  (previewOutputsP ??= buildAll(noGeorefResult(), contourModel(null, null)));

// ── the consistency contract ────────────────────────────────────────────────

describe('provenance consistency — export-ready run', () => {
  it('the shared provenance object itself reads Good / Ready (fixture sanity)', async () => {
    const { prov } = await readyOutputs();
    expect(prov.surfaceQuality).toBe('Good');
    expect(prov.exportReadiness).toBe('Ready');
    expect(prov.exportReason).toBe('');
    expect(prov.horizontalCrs).toBe('EPSG:32610');
    expect(prov.verticalDatum).toBe('EPSG:5703');
    expect(prov.accuracy).toEqual({ rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, usgsQualityLevel: 'QL2' });
  });

  it('README, DXF and SVG carry the identical provenance line block, verbatim', async () => {
    const { prov, demReadme, dxf, svg } = await readyOutputs();
    const lines = provenanceLines(prov);
    expect(lines.length).toBeGreaterThan(10); // the block is real, not a stub
    for (const line of lines) {
      // DEM README: indented under its "Provenance" heading.
      expect(demReadme).toContain(line);
      // DXF: each line is a leading group-code-999 comment.
      expect(dxf).toContain(`999\n${line}\n`);
      // SVG: the same lines inside the <metadata> comment (ASCII-safe here).
      expect(svg).toContain(line);
    }
  });

  it('GeoJSON metadata mirrors the shared provenance field-by-field', async () => {
    const { prov, geojson } = await readyOutputs();
    const md = geojson.metadata as Record<string, any>;
    // Provenance-added fields equal the shared object exactly.
    expect(md.software).toBe(prov.software);
    expect(md.softwareVersion).toBe(prov.softwareVersion);
    expect(md.metricVersion).toBe(prov.metricVersion);
    expect(md.generated).toBe(prov.generated);
    expect(md.source).toBe(prov.source);
    expect(md.horizontalCrs).toBe(prov.horizontalCrs);
    expect(md.crsKnown).toBe(prov.crsKnown);
    expect(md.datumKnown).toBe(prov.datumKnown);
    expect(md.surfaceQuality).toBe(prov.surfaceQuality);
    expect(md.exportReadiness).toBe(prov.exportReadiness);
    expect(md.exportReason).toBe(prov.exportReason);
    expect(md.accuracy).toEqual(prov.accuracy);
    expect(md.pointDensityPerM2).toBe(prov.pointDensityPerM2);
    expect(md.measuredCells).toBe(prov.measuredCells);
    expect(md.totalCells).toBe(prov.totalCells);
    // Model-derived keys (which win the merge) must AGREE with the provenance —
    // this is the cross-check that the file's two metadata sources can't split.
    expect(md.verticalDatum).toBe(prov.verticalDatum);
    expect(md.coverageMode).toBe(prov.coverageMode);
    expect(md.contourStyle).toBe(prov.contourStyle);
    expect(md.contourStyleLabel).toBe(prov.contourStyleLabel);
    expect(md.intervalM).toBe(prov.contourIntervalM);
    // The file-level CRS member georeferences the same frame the provenance names.
    expect(geojson.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::32610');
  });

  it('the map-sheet PDF prints the shared CRS / datum / style / accuracy / date', async () => {
    const { prov, mapSheetText } = await readyOutputs();
    expect(mapSheetText).toContain(prov.horizontalCrs);
    expect(mapSheetText).toContain(prov.verticalDatum);
    // Title block prints the generated date as "YYYY-MM-DD HH:MM UTC".
    expect(mapSheetText).toContain('2026-06-05 00:00 UTC');
    expect(mapSheetText).toContain(`Contour style: ${prov.contourStyleLabel}`);
    const acc = prov.accuracy!;
    expect(mapSheetText).toContain(`${acc.rmseZM!.toFixed(2)} m`);
    expect(mapSheetText).toContain(`${acc.nvaM!.toFixed(2)} m`);
    expect(mapSheetText).toContain(`${acc.vvaM!.toFixed(2)} m`);
    expect(mapSheetText).toContain(acc.usgsQualityLevel);
  });

  it('the terrain report content embeds the shared provenance verbatim', async () => {
    const { prov, report } = await readyOutputs();
    // The report's embedded provenance IS the shared object, field for field …
    expect(report.provenance).toEqual(prov);
    // … and its footer lines are the SAME formatter output every text export stamps.
    expect([...report.provenanceLines]).toEqual(provenanceLines(prov));
    // The user-visible rows are sourced from it too.
    expect(reportRow(report, 'Dataset Statistics', 'Horizontal CRS')).toBe(prov.horizontalCrs);
    expect(reportRow(report, 'Dataset Statistics', 'Vertical datum')).toBe(prov.verticalDatum);
    expect(reportRow(report, 'Dataset Statistics', 'Coverage mode')).toBe(prov.coverageMode);
    expect(reportRow(report, 'Dataset Statistics', 'Software')).toBe(`${prov.software} ${prov.softwareVersion}`);
    expect(reportRow(report, 'Terrain Assessment', 'Surface quality')).toBe(prov.surfaceQuality);
    expect(reportRow(report, 'Terrain Assessment', 'Export readiness')).toBe(prov.exportReadiness);
    expect(reportRow(report, 'Quality Metrics', 'Vertical RMSEz')).toBe(`${prov.accuracy!.rmseZM!.toFixed(2)} m`);
  });

  it('the report Executive Summary opens with the SAME verdicts the provenance stamps', async () => {
    const { prov, report } = await readyOutputs();
    // The verdict sentence is "<surfaceQuality> — <reason>": its leading token
    // must be the provenance's surface tier, so the headline can never say
    // "Good" while the stamped metadata says "Preview".
    expect(reportRow(report, 'Executive Summary', 'Verdict')).toMatch(
      new RegExp(`^${prov.surfaceQuality} — `),
    );
    // Ready run: the readiness row is the bare verdict (no reason suffix).
    expect(reportRow(report, 'Executive Summary', 'Export readiness')).toBe(
      prov.exportReadiness,
    );
  });

  it('the report Terrain Products list mirrors the panel terrainProducts view', async () => {
    const { report } = await readyOutputs();
    const a = terrainAssessment(readyResult());
    const view = terrainProducts(a, recommendedWorkflows(a));
    // Same six products, same order, Ready renamed Available — the PDF and
    // the Analyse panel grade products from one projection, never two.
    expect(report.products.map((p) => p.label)).toEqual(view.map((v) => v.label));
    expect(report.products.map((p) => p.availability)).toEqual(
      view.map((v) => (v.statusWord === 'Ready' ? 'Available' : v.statusWord)),
    );
    // … and the report's per-product notes ARE the panel rows' reasons —
    // the engine-selected strings, byte-identical (none here: all Ready).
    expect(report.products.map((p) => p.note)).toEqual(view.map((v) => v.reason));
  });

  it('EVERY exporter reports the same export-readiness verdict (no drift)', async () => {
    const o = await readyOutputs();
    const verdicts = {
      demReadme: verdictOnly(kvValue(o.demReadme, 'Export readiness')),
      dxf: verdictOnly(kvValue(o.dxf, 'Export readiness')),
      svg: verdictOnly(kvValue(o.svg, 'Export readiness')),
      geojson: String(o.geojson.metadata.exportReadiness),
      mapSheetPdf: mapSheetVerdict(o.mapSheetText),
      terrainReport: reportRow(o.report, 'Terrain Assessment', 'Export readiness'),
    };
    // Object equality so a divergence names the exporter in the diff.
    expect(verdicts).toEqual({
      demReadme: o.prov.exportReadiness,
      dxf: o.prov.exportReadiness,
      svg: o.prov.exportReadiness,
      geojson: o.prov.exportReadiness,
      mapSheetPdf: o.prov.exportReadiness,
      terrainReport: o.prov.exportReadiness,
    });
  });

  it('EVERY exporter reports the same surface-quality tier (no drift)', async () => {
    const o = await readyOutputs();
    const tiers = {
      demReadme: kvValue(o.demReadme, 'Surface quality'),
      dxf: kvValue(o.dxf, 'Surface quality'),
      svg: kvValue(o.svg, 'Surface quality'),
      geojson: String(o.geojson.metadata.surfaceQuality),
      terrainReport: reportRow(o.report, 'Terrain Assessment', 'Surface quality'),
    };
    expect(tiers).toEqual({
      demReadme: o.prov.surfaceQuality,
      dxf: o.prov.surfaceQuality,
      svg: o.prov.surfaceQuality,
      geojson: o.prov.surfaceQuality,
      terrainReport: o.prov.surfaceQuality,
    });
  });

  it('a fully-ready DEM README carries no PRELIMINARY caveat', async () => {
    const { demReadme } = await readyOutputs();
    expect(demReadme).not.toMatch(/PRELIMINARY/);
  });

  it('the shared provenance carries the derived-complexity record — reproducible parameters', async () => {
    const { prov } = await readyOutputs();
    const cx = prov.complexity!;
    expect(cx).not.toBeNull();
    // Metric name + window/radius in cells AND ground units.
    expect(cx.vrmWindowCells).toBe(3);
    expect(cx.vrmWindowGroundM).toBe(3);
    expect(cx.tpiRadiusCells).toBe(10);
    expect(cx.tpiRadiusGroundM).toBe(10);
    expect(cx.vrmText).toContain('3×3-cell window');
    expect(cx.tpiText).toContain('radius 10 cells');
    // Z units + the slope/aspect convention note.
    expect(cx.zUnit).toBe('m');
    expect(cx.convention).toBe(SLOPE_ASPECT_CONVENTION_NOTE);
    expect(cx.convention).toContain('Horn (1981)');
    // Derived confidence + ordered caveats.
    expect(cx.confidence).toBe(82);
    expect(cx.caveats).toHaveLength(1);
    expect(cx.caveats[0]).toContain('voids or invalid');
  });

  it('README, DXF and SVG stamp the complexity lines verbatim; GeoJSON mirrors the record', async () => {
    const { prov, demReadme, dxf, svg, geojson, report } = await readyOutputs();
    const cx = prov.complexity!;
    for (const text of [demReadme, dxf, svg]) {
      expect(kvValue(text, 'Ruggedness (VRM)')).toBe(cx.vrmText);
      expect(kvValue(text, 'Landform (TPI)')).toBe(cx.tpiText);
      expect(kvValue(text, 'Convention')).toBe(cx.convention);
      expect(kvValue(text, 'Complexity conf.')).toBe('82/100 (derived from data support)');
    }
    // GeoJSON metadata carries the structured record field-by-field.
    expect(geojson.metadata.complexity).toEqual({
      ...cx,
      caveats: [...cx.caveats],
    });
    // The report's Terrain Assessment rows print the SAME strings, and the
    // complexity caveats join the report warnings (deduped, order kept).
    expect(reportRow(report, 'Terrain Assessment', 'Ruggedness (VRM)')).toBe(cx.vrmText);
    expect(reportRow(report, 'Terrain Assessment', 'Landform (TPI)')).toBe(cx.tpiText);
    expect(reportRow(report, 'Terrain Assessment', 'Complexity confidence')).toBe(
      '82/100 (derived from data support)',
    );
    expect(report.warnings).toContain(cx.caveats[0]);
  });
});

describe('provenance consistency — un-georeferenced (Preview) run', () => {
  it('the shared provenance reads Good surface / Preview export with the georef reason', async () => {
    const { prov } = await previewOutputs();
    // Hand-computed: surface metrics unchanged → Good; CRS + datum missing →
    // export capped to Preview, reason naming BOTH gaps.
    expect(prov.surfaceQuality).toBe('Good');
    expect(prov.exportReadiness).toBe('Preview');
    expect(prov.exportReason).toBe('CRS unknown and vertical datum unknown');
    expect(prov.horizontalCrs).toBe('not georeferenced');
    expect(prov.verticalDatum).toBe('unknown');
  });

  it('every output downgrades to Preview together — the "DEM says Preview, report says Good" drill', async () => {
    const o = await previewOutputs();
    const verdicts = {
      demReadme: verdictOnly(kvValue(o.demReadme, 'Export readiness')),
      dxf: verdictOnly(kvValue(o.dxf, 'Export readiness')),
      svg: verdictOnly(kvValue(o.svg, 'Export readiness')),
      geojson: String(o.geojson.metadata.exportReadiness),
      mapSheetPdf: mapSheetVerdict(o.mapSheetText),
      terrainReport: reportRow(o.report, 'Terrain Assessment', 'Export readiness'),
    };
    expect(verdicts).toEqual({
      demReadme: 'Preview',
      dxf: 'Preview',
      svg: 'Preview',
      geojson: 'Preview',
      mapSheetPdf: 'Preview',
      terrainReport: 'Preview',
    });
    // And the surface tier stays 'Good' in every output that states it — the
    // two axes must not be conflated by any exporter.
    expect(kvValue(o.demReadme, 'Surface quality')).toBe('Good');
    expect(kvValue(o.dxf, 'Surface quality')).toBe('Good');
    expect(kvValue(o.svg, 'Surface quality')).toBe('Good');
    expect(String(o.geojson.metadata.surfaceQuality)).toBe('Good');
    expect(reportRow(o.report, 'Terrain Assessment', 'Surface quality')).toBe('Good');
  });

  it('the readiness REASON is the same sentence everywhere it is spelled out', async () => {
    const o = await previewOutputs();
    const reason = o.prov.exportReason;
    const readinessLine = `Export readiness  ${o.prov.exportReadiness} — ${reason}`;
    expect(o.demReadme).toContain(readinessLine);
    expect(o.dxf).toContain(`999\n${readinessLine}\n`);
    expect(o.svg).toContain(readinessLine);
    expect(String(o.geojson.metadata.exportReason)).toBe(reason);
    expect(reportRow(o.report, 'Terrain Assessment', 'Export note')).toBe(reason);
    // The report's Executive Summary readiness line spells the SAME sentence:
    // "<verdict> — <reason>" with no rewording.
    expect(reportRow(o.report, 'Executive Summary', 'Export readiness')).toBe(
      `${o.prov.exportReadiness} — ${reason}`,
    );
    // The DEM README's leading caveat names the same verdict + reason inline.
    expect(o.demReadme).toMatch(/PRELIMINARY/);
    expect(o.demReadme).toContain(`export readiness: Preview (${reason})`);
  });

  it('the report product reasons quote the SAME engine reason the provenance stamps', async () => {
    const o = await previewOutputs();
    // Good surface, georef-only gap: the engine's export reason ("CRS unknown
    // and vertical datum unknown") is THE deliverable reason — the same
    // string stamped on every artifact, never a reworded parallel.
    const a = terrainAssessment(noGeorefResult());
    const view = terrainProducts(a, recommendedWorkflows(a));
    expect(o.report.products.map((p) => p.note)).toEqual(view.map((v) => v.reason));
    for (const label of ['DTM/DEM export', 'Contours', 'Map sheet']) {
      const p = o.report.products.find((x) => x.label === label)!;
      expect(p.availability).toBe('Preview');
      expect(p.note).toBe(o.prov.exportReason);
    }
    // Inspection rows stay Available with no excuse — the surface is Good.
    for (const label of ['Profiles', 'Measurements', 'Terrain review']) {
      const p = o.report.products.find((x) => x.label === label)!;
      expect(p.availability).toBe('Available');
      expect(p.note).toBeUndefined();
    }
  });

  it('the map sheet prints the negated PREVIEW note and the honest CRS, never the ready note', async () => {
    const { mapSheetText } = await previewOutputs();
    // The readiness/evidence notes wrap within the title-block column; collapse
    // whitespace so the contiguous note is matched regardless of line breaks.
    const flat = mapSheetText.replace(/\s+/g, ' ');
    expect(flat).toContain('PREVIEW - not survey-grade until validated against control.');
    expect(flat).not.toContain('not a survey certification');
    expect(mapSheetText).toContain('not georeferenced');
  });

  it('the un-georeferenced GeoJSON omits the CRS member but still says so in metadata', async () => {
    const { geojson, prov } = await previewOutputs();
    expect(geojson.crs).toBeUndefined(); // never stamp a frame we do not have
    expect(geojson.metadata.horizontalCrs).toBe(prov.horizontalCrs); // 'not georeferenced'
    expect(geojson.metadata.crsKnown).toBe(false);
  });
});
