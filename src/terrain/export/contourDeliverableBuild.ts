/**
 * contourDeliverableBuild.ts
 *
 * Produce the complete Contour Studio deliverable ZIP from an analysis result:
 * gather the product bytes (contours GeoJSON, DTM GeoTIFF, provenance JSON),
 * decide the honest manifest (contourPackageManifest), and assemble the ZIP with
 * a SHA256SUMS integrity manifest (contourDeliverablePackage).
 *
 * Scope (v0.5.9): the curated deliverable bundles the CURRENT contour geometry
 * (honestly labelled analytical vs cartographic by its actual style), the DTM
 * raster, provenance, a README, and checksums. The other geometry variant, the
 * cartographic DXF, the rasters beyond the DTM, the map PDF and the validation
 * JSON are OMITTED with honest reasons (produced via their own dedicated
 * products) — never shipped as empty placeholders. Widening the set is additive.
 *
 * Pure and synchronous given the result: no DOM, no I/O. Reuses the same
 * serializers every other export uses, so a file in the package is byte-for-byte
 * what the standalone export would produce.
 */

import type { AnalyseContoursResult } from '../contour/analyseContours';
import type { ExportPermitStamp } from './exportProvenance';
import type { ScientificExportDecision } from '../../export/exportManifest';
import type { ContourWorldOrigin } from '../contour/contourFeatureModel';
import type { DxfLinearUnit } from '../contour/dxfContours';
import { buildExportProvenance, provenanceJson, analysisRecordFromProvenance } from './exportProvenance';
import { buildContourPdfModel } from '../contourStudio/contourDeliverablePdfModel';
import { buildContourStudioPdf } from './contourStudioPdf';
import { serializeContours } from '../contour/contourDownload';
import { verticalUnitLabel } from '../../units/units';
import { writeGeoTiff } from './demGeoTiff';
import { parseEpsg } from './demPackage';
import {
  buildContourPackageManifest,
  type PackageRole,
} from '../contourStudio/contourPackageManifest';
import { assembleContourDeliverable } from './contourDeliverablePackage';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const NO_DATA = -9999;

export interface DeliverableBuildOptions {
  /** The granted export decision (from the §19 permit). */
  readonly decision: ScientificExportDecision;
  /** Project / basename stem for the files. */
  readonly basename: string;
  /** World origin the loader subtracted (for CRS registration). */
  readonly worldOrigin?: ContourWorldOrigin | null;
  /** Resolved horizontal linear unit ('metre' | 'foot' | …). */
  readonly linearUnit?: DxfLinearUnit;
  /**
   * Metres-per-unit of the Z (elevation) axis, ONLY when the source declares a
   * vertical unit separately from the horizontal one. Absent/null ⇒ the
   * elevation unit is genuinely unknown and is reported as such — the vertical
   * unit is never inferred from the horizontal unit.
   */
  readonly verticalUnitToMetres?: number | null;
  /** Source frame → WGS 84 lon/lat, for the RFC 7946 contour GeoJSON. */
  readonly toLonLat?: (p: readonly [number, number, number]) => [number, number, number];
  /** True when the horizontal CRS is geographic. */
  readonly isGeographic?: boolean;
  readonly softwareVersion: string;
  readonly metricVersion: string;
  readonly generatedAt: Date;
  /** The evidence-gate permit stamp, threaded into every file's provenance. */
  readonly exportPermit: ExportPermitStamp | null;
  /**
   * The contour geometry method actually bundled, as `id@version` (from the
   * Contour Studio export intent). Stamped into provenance so the deliverable
   * self-describes its geometry. Null ⇒ not set by Contour Studio.
   */
  readonly contourMethod?: string | null;
  /**
   * The Contour Studio purpose that produced this deliverable (e.g.
   * `presentation-map`). Stamped into provenance so a bundle records the purpose
   * it was built for. Null ⇒ no purpose context.
   */
  readonly deliverablePurpose?: string | null;
}

/** Honest one-line reasons for the products this curated package omits. */
const OMISSION_REASONS: Partial<Record<PackageRole, string>> = {
  'contour-map-pdf': 'Export separately via the Map sheet (PDF) product.',
  'contours-cartographic-dxf': 'Export separately via the DXF product.',
  'hillshade-raster': 'Not bundled in this package.',
  'support-raster': 'Not bundled in this package.',
  'uncertainty-raster': 'Not bundled in this package.',
  'validation-json': 'Not bundled in this package.',
  'contour-studio-json': 'Not bundled in this package.',
};

/**
 * The product bytes + honest availability flags shared by the sync (PDF-less)
 * and async (with-PDF) builders. Gathering these once keeps the two entry
 * points byte-for-byte identical for every product they both emit.
 */
interface GatheredDeliverable {
  readonly basename: string;
  readonly provenance: ReturnType<typeof buildExportProvenance>;
  readonly isAnalytical: boolean;
  readonly hasContours: boolean;
  readonly dtm: AnalyseContoursResult['dtm'] | null;
  readonly horizontalUnit: 'ft' | 'm';
  /** Elevation unit label — a declared Z unit ('m'|'ft'|'units') or 'unknown'. */
  readonly verticalUnit: string;
  readonly bytes: Map<PackageRole, Uint8Array>;
}

/**
 * The grid summary in the deliverable's OWN horizontal unit — never a
 * hard-coded metre. A foot or geographic (degree) frame is labelled honestly,
 * mirroring the `horizontalUnit` the same provenance reports.
 */
export function deliverableGridLabel(
  dtm: AnalyseContoursResult['dtm'] | null,
  horizontalUnit: string,
  isGeographic: boolean | undefined,
): string {
  if (dtm == null) return 'unknown';
  const unit = isGeographic ? 'degrees' : horizontalUnit;
  return `${dtm.cols}x${dtm.rows} @ ${dtm.cellSizeM} ${unit}`;
}

function gatherDeliverable(
  result: AnalyseContoursResult,
  opts: DeliverableBuildOptions,
): GatheredDeliverable {
  const basename = opts.basename || 'contour-deliverable';
  const provenance = buildExportProvenance(result, {
    basename,
    generatedAt: opts.generatedAt,
    softwareVersion: opts.softwareVersion,
    metricVersion: opts.metricVersion,
    exportPermit: opts.exportPermit,
    // Contour Studio stamps the geometry method + purpose so the bundle
    // self-describes what it holds and which purpose produced it.
    contourMethod: opts.contourMethod ?? null,
    deliverablePurpose: opts.deliverablePurpose ?? null,
    // Label the contour interval in the real vertical unit, not a hard-coded metre.
    verticalUnitToMetres: opts.verticalUnitToMetres,
  });

  // Honest geometry role: label the bundled GeoJSON by its ACTUAL style, so a
  // crisp/analytical export is never called cartographic and vice-versa.
  const model = result.model ?? null;
  const style = result.generationParams?.contourStyle ?? model?.contourStyle ?? null;
  const isAnalytical = style === 'crisp';
  const nativeGeojsonRole: PackageRole = 'contours-native-geojson';
  const geojsonRole: PackageRole = isAnalytical
    ? 'contours-analytical-geojson'
    : 'contours-cartographic-geojson';

  const dtm = result.dtm ?? null;
  const hasContours = (model?.features.length ?? 0) > 0;
  const horizontalUnit = opts.linearUnit === 'foot' || opts.linearUnit === 'us-survey-foot' ? 'ft' : 'm';
  // Elevation unit is reported ONLY from a separately-declared Z axis — never
  // copied from the horizontal unit. Undeclared ⇒ honest 'unknown', matching the
  // convention the live Contour Studio uses (unknownUnit()).
  const vScale = opts.verticalUnitToMetres;
  const verticalUnit =
    vScale != null && Number.isFinite(vScale) && vScale > 0 ? verticalUnitLabel(vScale) : 'unknown';

  const bytes = new Map<PackageRole, Uint8Array>();

  if (hasContours && model) {
    // A `.geojson` in the package makes the same promise as one on disk: RFC
    // 7946, WGS 84 degrees. Written that way whenever the CRS can be
    // converted; otherwise the native frame ships instead, since projected
    // numbers in a degrees field would be worse than an unconverted file.
    const gj = serializeContours(model, opts.toLonLat ? 'geojson' : 'geojson-native', {
      basename,
      labels: result.labels,
      provenance,
      worldOrigin: opts.worldOrigin ?? null,
      linearUnit: opts.linearUnit,
      toLonLat: opts.toLonLat,
    });
    bytes.set(geojsonRole, enc(gj.content));
    if (opts.toLonLat) {
      // The survey grid ships alongside, for GIS that wants it.
      const native = serializeContours(model, 'geojson-native', {
        basename, labels: result.labels, provenance,
        worldOrigin: opts.worldOrigin ?? null, linearUnit: opts.linearUnit,
      });
      bytes.set(nativeGeojsonRole, enc(native.content));
    }
  }

  if (dtm != null) {
    const ox = opts.worldOrigin?.x ?? 0;
    const oy = opts.worldOrigin?.y ?? 0;
    // Add the dropped vertical origin back so the packaged DTM raster reads real
    // source heights, matching the contour geometry in the SAME ZIP (which
    // serializeContours already shifts). Shifted COPY of covered cells only —
    // never mutate result.dtm.z; NODATA stays coverage-gated by the writer.
    const oz = opts.worldOrigin?.z ?? 0;
    let dtmValues: ArrayLike<number> = dtm.z;
    if (oz !== 0) {
      const shifted = Float64Array.from(dtm.z as ArrayLike<number>);
      for (let i = 0; i < shifted.length; i++) if (dtm.coverage[i] !== 0) shifted[i] += oz;
      dtmValues = shifted;
    }
    bytes.set(
      'dtm-raster',
      writeGeoTiff({
        values: dtmValues,
        coverage: dtm.coverage,
        cols: dtm.cols,
        rows: dtm.rows,
        cellSize: dtm.cellSizeM,
        xllCorner: ox + dtm.originH1,
        yllCorner: oy + dtm.originH2,
        noData: NO_DATA,
        epsg: dtm.horizontalEpsg ?? parseEpsg(dtm.crs),
        isGeographic: opts.isGeographic ?? false,
        verticalEpsg: dtm.verticalEpsg ?? parseEpsg(dtm.verticalDatum),
      }),
    );
  }

  bytes.set('provenance-json', enc(JSON.stringify(provenanceJson(provenance), null, 2)));

  return { basename, provenance, isAnalytical, hasContours, dtm, horizontalUnit, verticalUnit, bytes };
}

/** Assemble the package manifest for a gathered deliverable. `pdf` flips when
 *  the multipage Contour Studio PDF is included (async path only). */
function manifestFor(g: GatheredDeliverable, opts: DeliverableBuildOptions, pdf: boolean) {
  return buildContourPackageManifest({
    projectName: g.basename,
    decision: opts.decision,
    available: {
      pdf,
      analyticalGeojson: g.hasContours && g.isAnalytical,
      cartographicGeojson: g.hasContours && !g.isAnalytical,
      cartographicDxf: false,
      dtm: g.dtm != null,
      hillshade: false,
      support: false,
      uncertainty: false,
      validationJson: false,
      provenanceJson: true,
      studioJson: false,
    },
    omissionReasons: OMISSION_REASONS,
    provenance: {
      crs: g.provenance.horizontalCrs,
      verticalDatum: g.provenance.verticalDatum,
      horizontalUnit: opts.isGeographic ? 'degrees' : g.horizontalUnit,
      verticalUnit: g.verticalUnit,
      software: g.provenance.software,
      softwareVersion: g.provenance.softwareVersion,
    },
    citation: `${g.provenance.software} ${g.provenance.softwareVersion}, ${g.basename} contour deliverable.`,
  });
}

/**
 * Build the complete deliverable ZIP bytes from a result. Throws (via the
 * manifest) if the decision is blocked — a blocked product yields no package.
 *
 * SYNCHRONOUS + PDF-LESS. pdf-lib is async, so the multipage Contour Studio PDF
 * cannot be emitted here without changing this signature (which the existing
 * synchronous callers and `demExport.test.ts` depend on). Use
 * {@link buildContourDeliverableFromResultAsync} for the with-PDF package.
 */
export function buildContourDeliverableFromResult(
  result: AnalyseContoursResult,
  opts: DeliverableBuildOptions,
): Uint8Array {
  const g = gatherDeliverable(result, opts);
  return assembleContourDeliverable(manifestFor(g, opts, false), g.bytes);
}

/**
 * Build the complete deliverable ZIP bytes INCLUDING the multipage Contour
 * Studio PDF (`contour-map-pdf` role). Async because pdf-lib is async. Builds
 * the pure PDF content model from the result's provenance + honest support /
 * validation / geometry figures, emits the bytes via {@link buildContourStudioPdf},
 * flips `available.pdf` on, and adds the bytes to the package byte map. Throws
 * (via the model / manifest) for a blocked decision. Renders honest content
 * only — no fabricated numbers.
 */
export async function buildContourDeliverableFromResultAsync(
  result: AnalyseContoursResult,
  opts: DeliverableBuildOptions,
): Promise<Uint8Array> {
  const g = gatherDeliverable(result, opts);

  // Honest support split from the DTM cell tally (measured / interpolated /
  // everything-else-unsupported), as percentages of all cells.
  const tally = result.cellStatusTally;
  const total = tally.total > 0 ? tally.total : 1;
  const measuredPct = (tally.measured / total) * 100;
  const interpolatedPct = (tally.interpolated / total) * 100;
  const unsupportedPct = Math.max(0, 100 - measuredPct - interpolatedPct);

  const validation = result.validation;
  const record = analysisRecordFromProvenance(g.provenance);

  const pdfModel = buildContourPdfModel({
    title: `${g.basename} - Contour deliverable`,
    provenance: {
      software: g.provenance.software,
      softwareVersion: g.provenance.softwareVersion,
      gitCommit: g.provenance.build,
      generated: g.provenance.generated,
      crs: g.provenance.horizontalCrs,
      verticalDatum: g.provenance.verticalDatum,
      horizontalUnit: opts.isGeographic ? 'degrees' : g.horizontalUnit,
      verticalUnit: g.verticalUnit,
      grid: deliverableGridLabel(g.dtm, g.horizontalUnit, opts.isGeographic),
      // The registered contour method actually exported, when Contour Studio set
      // it; otherwise none (never a fabricated id).
      methodIds: g.provenance.contourMethod ? [g.provenance.contourMethod] : [],
      sourceHash: record.contentHash,
    },
    support: { measuredPct, interpolatedPct, unsupportedPct },
    validation: {
      mode: validation.method,
      rmseM: Number.isFinite(validation.rmse) ? validation.rmse : null,
      sampleSize: validation.sampleSize,
      // Hold-out only — no independent field checkpoints are supplied here.
      independentCheckpoints: false,
    },
    decision: opts.decision,
    // The bundled geometry is labelled by its actual style; the other variant is
    // not shipped in this package, so analyticalAvailable stays false.
    geometry: { cartographic: !g.isAnalytical, analyticalAvailable: false },
  });

  const pdfBytes = await buildContourStudioPdf(pdfModel);
  g.bytes.set('contour-map-pdf', pdfBytes);

  return assembleContourDeliverable(manifestFor(g, opts, true), g.bytes);
}
