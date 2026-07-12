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
import { buildExportProvenance, provenanceJson } from './exportProvenance';
import { serializeContours } from '../contour/contourDownload';
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
  /** True when the horizontal CRS is geographic. */
  readonly isGeographic?: boolean;
  readonly softwareVersion: string;
  readonly metricVersion: string;
  readonly generatedAt: Date;
  /** The evidence-gate permit stamp, threaded into every file's provenance. */
  readonly exportPermit: ExportPermitStamp | null;
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
 * Build the complete deliverable ZIP bytes from a result. Throws (via the
 * manifest) if the decision is blocked — a blocked product yields no package.
 */
export function buildContourDeliverableFromResult(
  result: AnalyseContoursResult,
  opts: DeliverableBuildOptions,
): Uint8Array {
  const basename = opts.basename || 'contour-deliverable';
  const provenance = buildExportProvenance(result, {
    basename,
    generatedAt: opts.generatedAt,
    softwareVersion: opts.softwareVersion,
    metricVersion: opts.metricVersion,
    exportPermit: opts.exportPermit,
  });

  // Honest geometry role: label the bundled GeoJSON by its ACTUAL style, so a
  // crisp/analytical export is never called cartographic and vice-versa.
  const model = result.model ?? null;
  const style = result.generationParams?.contourStyle ?? model?.contourStyle ?? null;
  const isAnalytical = style === 'crisp';
  const geojsonRole: PackageRole = isAnalytical
    ? 'contours-analytical-geojson'
    : 'contours-cartographic-geojson';

  const dtm = result.dtm ?? null;
  const hasContours = (model?.features.length ?? 0) > 0;

  const horizontalUnit = opts.linearUnit === 'foot' || opts.linearUnit === 'us-survey-foot' ? 'ft' : 'm';

  const manifest = buildContourPackageManifest({
    projectName: basename,
    decision: opts.decision,
    available: {
      pdf: false,
      analyticalGeojson: hasContours && isAnalytical,
      cartographicGeojson: hasContours && !isAnalytical,
      cartographicDxf: false,
      dtm: dtm != null,
      hillshade: false,
      support: false,
      uncertainty: false,
      validationJson: false,
      provenanceJson: true,
      studioJson: false,
    },
    omissionReasons: OMISSION_REASONS,
    provenance: {
      crs: provenance.horizontalCrs,
      verticalDatum: provenance.verticalDatum,
      horizontalUnit: opts.isGeographic ? 'degrees' : horizontalUnit,
      verticalUnit: horizontalUnit,
      software: provenance.software,
      softwareVersion: provenance.softwareVersion,
    },
    citation: `${provenance.software} ${provenance.softwareVersion}, ${basename} contour deliverable.`,
  });

  const bytes = new Map<PackageRole, Uint8Array>();

  if (hasContours && model) {
    const gj = serializeContours(model, 'geojson', {
      basename,
      labels: result.labels,
      provenance,
      worldOrigin: opts.worldOrigin ?? null,
      linearUnit: opts.linearUnit,
    });
    bytes.set(geojsonRole, enc(gj.content));
  }

  if (dtm != null) {
    const ox = opts.worldOrigin?.x ?? 0;
    const oy = opts.worldOrigin?.y ?? 0;
    bytes.set(
      'dtm-raster',
      writeGeoTiff({
        values: dtm.z,
        coverage: dtm.coverage,
        cols: dtm.cols,
        rows: dtm.rows,
        cellSize: dtm.cellSizeM,
        xllCorner: ox + dtm.originH1,
        yllCorner: oy + dtm.originH2,
        noData: NO_DATA,
        epsg: parseEpsg(dtm.crs),
        isGeographic: opts.isGeographic ?? false,
        verticalEpsg: parseEpsg(dtm.verticalDatum),
      }),
    );
  }

  bytes.set('provenance-json', enc(JSON.stringify(provenanceJson(provenance), null, 2)));

  return assembleContourDeliverable(manifest, bytes);
}
