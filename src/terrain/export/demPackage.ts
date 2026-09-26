/**
 * demPackage.ts
 *
 * Assemble a georeferenced DEM deliverable from an analysis result: the
 * bare-earth DTM, the top-surface DSM, and the canopy height model (CHM), each
 * as both an Esri ASCII Grid (.asc) and a Float32 GeoTIFF (.tif), plus an
 * optional .prj (CRS WKT) and a metadata README with the survey details, and
 * a six-band terrain evidence GeoTIFF (per-cell support on the DTM grid, see
 * demEvidence.ts) bound into the DTM passport. On request, a two-band
 * sensitivity GeoTIFF (model spread over a fixed ensemble, see
 * demSensitivity.ts) is added and bound the same way. Bundled into a single
 * store-only ZIP.
 *
 * Pure-data: returns the ZIP bytes; no DOM. The DSM grid is reconstructed as
 * DTM + canopy height (= max(DTM, DSM)), so no extra grid needs threading
 * through the pipeline.
 *
 * Honesty contract: the DEM export stays AVAILABLE even when the contour
 * quality gate is preview-only or the coverage is partial — the bare-earth
 * raster is still real data. But the README is then self-documenting about it:
 * it always carries the coverage mode, the quality-gate verdict, the warnings
 * list, the generation parameters, and a real bounds extent, and it leads with
 * a prominent PRELIMINARY caveat whenever the data is not full + ready.
 */

import {
  buildEvidenceContractView,
  type EvidenceContractView,
} from '../../validation/evidenceBoundaryInspector';
import { buildScientificArtifactPassport } from '../../science/scientificArtifactPassport';
import { dtmProductDigest } from '../../science/dtmProductDigest';
import type { AnalysedBasis } from './analysedBasis';
import type { AnalyseContoursResult } from '../contour/analyseContours';
import { epsgFromCrsLabel } from '../../export/crsIdentifier';
import {
  buildExportProvenance,
  analysisRecordFromProvenance,
  processingManifestFromProvenance,
  provenanceLines,
  dtmArtifactClaims,
  type ExportPermitStamp,
} from './exportProvenance';
import { writeAsciiGrid } from './demAsciiGrid';
import { writeGeoTiff, verticalUnitGeoKeyCode } from './demGeoTiff';
import {
  hasEvidenceArrays,
  terrainEvidenceBands,
  writeTerrainEvidenceGeoTiff,
  terrainEvidenceReadmeLines,
  TERRAIN_EVIDENCE_METHOD_ID,
} from './demEvidence';
import {
  writeTerrainSensitivityGeoTiff,
  terrainSensitivityBands,
  terrainSensitivityReadmeLines,
  TERRAIN_SENSITIVITY_METHOD_ID,
  type SensitivityMemberGrid,
} from './demSensitivity';
import {
  reconstructionResidual,
  terrainAttentionBands,
  writeTerrainAttentionGeoTiff,
  verticalReferenceInUnit,
  demEvidenceTier,
  demEvidenceRecord,
  terrainAttentionReadmeLines,
  TERRAIN_ATTENTION_METHOD_ID,
  type DemEvidenceRecord,
} from './demAttention';
import { horizontalCellMetresXY } from '../ground/horizontalScale';
import { buildZip, type ZipEntry } from '../../convert/zipStore';
import { buildSha256Manifest } from './sha256';
import { verticalUnitLabel, horizontalUnitLabel, UNIT_FACTORS } from '../../units/units';

// The integrity manifest moved beside the hash it is built from, where the
// contour package can reach it without importing a DEM module. Re-exported so
// the callers that knew it here still do.
export { buildSha256Manifest } from './sha256';

/**
 * Resolved linear unit of a projected CRS — the SAME vocabulary the DXF
 * `$INSUNITS` seam uses. Drives the README's horizontal cell-size / bounds unit
 * (and, on a foot CRS, the elevation unit) so a foot-based scan never reads "m".
 */
export type DemLinearUnit = 'metre' | 'foot' | 'us-survey-foot' | 'unknown';

/**
 * Plain horizontal-unit label for a PROJECTED CRS (geographic frames label
 * "degrees" separately). A foot CRS (international or US survey) reads "ft"; an
 * omitted / metre / unknown unit keeps the standing metre default for
 * back-compat (the terrain stack's `unitToMetres` defaults to 1).
 */
function projectedUnitLabel(unit: DemLinearUnit | undefined): string {
  // Two different absences. `undefined` is a projected CRS with no UNIT clause,
  // and the WKT default for that is the metre, a convention this project pins
  // deliberately and the README tests state. `'unknown'` is a resolved frame
  // that could not determine the unit, which the previous ternary also read as
  // metres: the README printed "Cell size 1 m" for a scan whose unit never
  // resolved. Only the second is not metres.
  if (unit === undefined) return 'm';
  return horizontalUnitLabel({ isGeographic: false, linearUnit: unit });
}

/**
 * Elevation-unit word for the README, mapped from the units.ts short label
 * (`'m'` / `'ft'` / `'units'`). The DTM stores Z in the scan's SOURCE vertical
 * units, so the label is derived from the resolved VERTICAL factor the caller
 * CLAIMS (`opts.verticalUnitToMetres`), never the horizontal one — a compound CRS (metre
 * plan over a foot height, or the reverse) would otherwise stamp the README and
 * the GeoTIFF vertical GeoKey with different units for the SAME zip. `'units'`
 * (an absent / degenerate factor) reads `'unknown'`, the fail-closed contract
 * the contour deliverable already uses — never a fabricated metre.
 */
const ELEVATION_UNIT_NAME = { m: 'metres', ft: 'feet', units: 'unknown' } as const;

export interface DemPackageOptions {
  /**
   * Absolute world origin (cloud origin). `x`/`y` shift the grid frame; `z` (the
   * dropped vertical origin) is added back to the DTM and DSM elevation values so
   * a recentred scan writes real source heights, not the recentred-negative
   * local frame. CHM is a height DIFFERENCE (DSM−DTM) and is never shifted.
   */
  readonly worldOrigin?: { readonly x: number; readonly y: number; readonly z?: number } | null;
  /**
   * SHA-256 of the source file, when the loader verified one. Left unset where
   * no digest was taken, and the passport records that as unavailable rather
   * than as an absent field that might have held one.
   */
  readonly sourceSha256?: string | null;
  /** Base filename (no extension) for the entries. Default 'terrain'. */
  readonly basename?: string;
  /** Metres per source vertical unit, or null when the frame resolved none. */
  readonly verticalUnitToMetres?: number | null;
  /** CRS WKT for the .prj sidecar, when available. */
  readonly wkt?: string | null;
  /** True when the horizontal CRS is geographic (lat/lon, degree cells). */
  readonly isGeographic?: boolean;
  /**
   * Resolved linear unit of a projected CRS. Drives the README's cell-size /
   * bounds / elevation unit so a foot-based scan reads "ft" / "feet" instead of
   * the metre default. Omitted ⇒ the standing metre assumption (back-compat).
   */
  readonly linearUnit?: DemLinearUnit;
  /** ISO generation timestamp. Default `new Date().toISOString()`. */
  readonly generationDateIso?: string;
  /** Producing software name. Default 'OpenLiDARViewer'. */
  readonly softwareName?: string;
  /** Producing software version. Default 'unknown'. */
  readonly softwareVersion?: string;
  /** Terrain metric version (e.g. 'v0.4.1'). Default 'unknown'. */
  readonly metricVersion?: string;
  /**
   * The §19 evidence-gate permit stamp for this raster (from the unified
   * resolver, DTM claim). Stamped into the README provenance so the package
   * records the same gate decision as the contour exports. null / omitted when
   * the export did not route through the gate.
   */
  readonly exportPermit?: ExportPermitStamp | null;
  /** The analysed basis the frame recorded; see `ExportProvenanceOptions.analysedBasis`. */
  readonly analysedBasis?: AnalysedBasis | null;
  /**
   * The sensitivity ensemble's member grids (demSensitivity.ts), member 0 the
   * canonical run this result came from. Off by default: omitted or null writes
   * no sensitivity raster. The caller runs the ensemble; this only writes it.
   */
  readonly sensitivityGrids?: readonly SensitivityMemberGrid[] | null;
}

/**
 * Parse an authority code from a CRS identifier, or null.
 *
 * This is fed the CRS DISPLAY label (`terrainAnalysisRunner` passes the
 * resolver's `name` through as `dtm.crs`; `verticalDatum` is a datum name), and
 * it previously matched any 3–6 digit run with the `EPSG:` prefix OPTIONAL. So
 * every CRS whose name carries a year stamped its GeoTIFF with that year:
 * `CH1903+ / LV95` wrote 1903 instead of 2056, `Mexico ITRF2008 / LCC` wrote
 * 2008 instead of 6362, `Baltic 1977` wrote 1977 instead of 5705. A raster
 * asserting the wrong CRS is worse than one asserting none, because a reader
 * places it confidently rather than asking.
 *
 * Delegates to the shared identifier helper so the rule for "does this label
 * name a code" lives in one place — it requires an explicit `EPSG:` token and
 * accepts both the bare form and the parenthesised form the parsers build.
 */
export function parseEpsg(id: string | null | undefined): number | null {
  return epsgFromCrsLabel(id);
}

const NO_DATA = -9999;

/** Print a numeric coordinate at full precision, or an explicit fallback. */
function coord(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? String(v) : 'unknown';
}

/**
 * Reconstruct the DSM (top surface) and CHM (canopy height) coverage from the
 * bare-earth DTM and the per-cell canopy height.
 *
 * DSM = DTM + canopy height, defined only where BOTH the canopy height is
 * finite AND the DTM has a ground reference at that cell (otherwise there is no
 * height to add the canopy onto). CHM coverage is wherever the canopy height is
 * finite — the above-ground figure stands on its own. NaN canopy → no DSM/CHM.
 *
 * Pure, deterministic, allocation-only; exported for direct unit testing.
 */
export function reconstructDsmChm(
  dtmZ: ArrayLike<number>,
  dtmCoverage: ArrayLike<number>,
  canopyHeight: ArrayLike<number>,
): { dsmZ: Float32Array; dsmCov: Uint8Array; chmCov: Uint8Array } {
  const n = dtmZ.length;
  const dsmZ = new Float32Array(n);
  const dsmCov = new Uint8Array(n);
  const chmCov = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const h = canopyHeight[i];
    if (Number.isFinite(h)) {
      chmCov[i] = 1;
      if (dtmCoverage[i] !== 0 && Number.isFinite(dtmZ[i])) {
        dsmZ[i] = dtmZ[i] + h;
        dsmCov[i] = 1;
      }
    }
  }
  return { dsmZ, dsmCov, chmCov };
}

/** Options for {@link buildDemReadme}. */
export interface DemReadmeOptions {
  readonly result: AnalyseContoursResult;
  readonly basename: string;
  readonly isGeographic: boolean;
  /** Metres per source vertical unit, or null when the frame resolved none. */
  readonly verticalUnitToMetres?: number | null;
  /**
   * Resolved linear unit of a projected CRS (ignored when `isGeographic`).
   * Omitted ⇒ the standing metre assumption.
   */
  readonly linearUnit?: DemLinearUnit;
  /** Bounds extent in CRS units (lower-left + upper-right). null when unknown. */
  readonly boundsMinX: number | null;
  readonly boundsMinY: number | null;
  readonly boundsMaxX: number | null;
  readonly boundsMaxY: number | null;
  readonly generationDateIso: string;
  readonly softwareName: string;
  readonly softwareVersion: string;
  readonly metricVersion: string;
  /** The evidence-gate permit stamp for this raster, or null. */
  readonly exportPermit?: ExportPermitStamp | null;
  readonly analysedBasis?: AnalysedBasis | null;
  /**
   * Filename of the terrain evidence raster in the same package, or null /
   * omitted when the package carries none.
   */
  readonly evidenceFilename?: string | null;
  /** Vertical unit label of the evidence raster's dispersion band. Default 'unknown'. */
  readonly evidenceVerticalUnit?: string;
  /** False when the evidence raster marks every cell unresolved. Default true. */
  readonly evidenceFrameResolved?: boolean;
  /** Filename of the sensitivity raster in the same package, or null / omitted. */
  readonly sensitivityFilename?: string | null;
  /** Filename of the attention raster in the same package, or null / omitted. */
  readonly attentionFilename?: string | null;
  /** DEM evidence tier record; omitted writes no tier section. */
  readonly demEvidence?: DemEvidenceRecord | null;
}

/** Map a coverage mode to a one-line plain-English label. */
function coverageLabel(mode: string): string {
  switch (mode) {
    // "every point the analysis was handed", not every point in the file: on a
    // display sample those differ, and the Analysed basis line below says by
    // how much. The old wording read as a claim about the whole file.
    case 'full': return 'full (every point handed to the analysis participated)';
    case 'resident-only': return 'resident-only (streaming scan — only resident nodes were walked)';
    case 'sampled': return 'sampled (a stride / random subset was analysed under budget)';
    default: return mode || 'unknown';
  }
}

/**
 * Build the metadata README that travels with the rasters. ALWAYS self-
 * documenting: CRS + status, vertical datum + status, no-data, cell size, a
 * real bounds extent, coverage mode, quality-gate verdict + status, the
 * warnings list, generation parameters, generation date, and software +
 * version + metric version. Leads with a PRELIMINARY caveat when the data is
 * not full + ready, so a partial / preview export can never read as final.
 */
/**
 * The evidence decision for this artifact, field by field.
 *
 * Answers the questions a reader has about a level: which claim it belongs to,
 * what the claim carries before any study is considered, what it resolved to
 * here, and what the resolver said about applicability. Where a scoped study
 * matched, each envelope field it was checked against is listed with its
 * verdict.
 *
 * This renders `buildEvidenceContractView`, which resolves through the one
 * evidence resolver. It holds no applicability rules of its own.
 */
function evidenceContractLines(result: AnalyseContoursResult): string[] {
  const claims = dtmArtifactClaims(result);
  if (claims.length === 0) return [];
  return renderEvidenceContract(buildEvidenceContractView(claims[0]));
}

/**
 * The contract as lines, from a resolved view.
 *
 * Split from the resolving above so the absent-level wording can be read back
 * without standing up an analysis to produce it. A level that was never
 * recorded prints as `none recorded` rather than as an empty column: a blank
 * field reads as a level that exists and happens to be empty, which is the
 * opposite of what it means.
 */
export function renderEvidenceContract(view: EvidenceContractView): string[] {
  const lines = [
    `Evidence contract`,
    `  Claim          ${view.claimId}`,
    `  Baseline       ${view.baselineEvidence ?? 'none recorded'}`,
    `  Effective      ${view.effectiveEvidence ?? 'none recorded'}`,
    `  Resolution     ${view.resolutionState}`,
    `  Matched study  ${view.matchedStudy ?? 'none applies'}`,
    `  Verdict        ${view.applicabilityVerdict}`,
  ];
  if (view.envelopeChecks.length > 0) {
    lines.push(`  Envelope`);
    for (const c of view.envelopeChecks) {
      lines.push(`    ${c.field.padEnd(22)} ${c.status}`);
    }
  }
  lines.push(``);
  return lines;
}

/**
 * The vertical factor the package states heights in: the claim factor, gated
 * on the result's own statement that a vertical scale resolved, falling back
 * to the geometry factor only when the caller states no claim. Null = unknown.
 */
function resolvedVerticalFactor(result: AnalyseContoursResult, claim: number | null | undefined): number | null {
  return result.verticalScaleResolved === false ? null : (claim ?? result.dtm.verticalUnitToMetres ?? null);
}

export function buildDemReadme(opts: DemReadmeOptions): string {
  const { result, basename, isGeographic } = opts;
  const dtm = result.dtm;
  const quality = result.quality;

  // ONE provenance object — the SAME builder every other export uses — so the
  // README's reference frame, verdicts, accuracy, software + version and date
  // are word-for-word identical to the GeoJSON / DXF / SVG / map sheet.
  const p = buildExportProvenance(result, {
    // Threaded, not defaulted: the README's reference frame is only "word-for-
    // word identical" to the other exports if it is stamped from the same
    // resolved scale they are.
    verticalUnitToMetres: opts.verticalUnitToMetres ?? null,
    basename,
    generatedAt: opts.generationDateIso,
    softwareVersion: opts.softwareVersion,
    metricVersion: opts.metricVersion,
    exportPermit: opts.exportPermit ?? null,
    // The raster, plus the hold-out accuracy figure when the README prints one.
    evidenceClaimIds: dtmArtifactClaims(result),
    analysedBasis: opts.analysedBasis ?? null,
  });

  // Digest the surface as it ships: the emitted Z and coverage arrays, the grid
  // geometry and the CRS codes. Bound to the method digest when the resolution
  // supplied one, so the pair (surface, method) is what the value proves equal.
  const surfaceDigest = dtmProductDigest(
    {
      z: dtm.z,
      coverage: dtm.coverage,
      cols: dtm.cols,
      rows: dtm.rows,
      cellSizeM: dtm.cellSizeM,
      // The README prints these as the package's own bounds, so the digest is
      // taken over the origin the deliverable declares.
      originH1: opts.boundsMinX ?? 0,
      originH2: opts.boundsMinY ?? 0,
      horizontalEpsg: parseEpsg(p.horizontalCrs),
      verticalEpsg: null,
    },
    p.scopedEvidence?.methodDigest ?? undefined,
  );

  const cov = (() => {
    let measured = 0; let interp = 0; const total = dtm.coverage.length;
    for (const c of dtm.coverage) {
      if (c === 2) measured++;
      else if (c === 1) interp++;
    }
    return { measured, interp, total };
  })();
  const pct = (n: number): string => (cov.total ? `${Math.round((100 * n) / cov.total)}%` : '—');
  // Horizontal cell/bounds unit: degrees for a geographic frame, else the
  // resolved projected linear unit (m, or ft on a foot CRS) — the grid's
  // cellSizeM is stored in SOURCE units, so a foot CRS must read "ft" not "m".
  const hUnit = isGeographic ? 'degrees' : projectedUnitLabel(opts.linearUnit);
  // Elevation unit: the DTM stores Z in SOURCE vertical units, so the label
  // comes from the resolved VERTICAL factor — NOT opts.linearUnit (horizontal),
  // which is what the GeoTIFF's vertical GeoKey (4099) already keys off. Honoured
  // in both branches: a geographic frame's cells are degrees but its heights
  // still carry the declared vertical unit. An absent / degenerate factor reads
  // 'unknown' (fail-closed), never a fabricated metre.
  // `dtm.verticalUnitToMetres` is the GEOMETRY factor the runner pins to the
  // inert placeholder 1 for a scan with no CRS, so reading it here printed
  // "metres" for a frame whose own Provenance block, built from the CLAIM
  // factor threaded in as `opts.verticalUnitToMetres`, said the vertical unit
  // was unverified. Read the claim, gated on the result's own statement that a
  // vertical scale resolved; fall back to the geometry factor only when the
  // caller states no claim at all (a legacy direct call).
  const zFactor = resolvedVerticalFactor(result, opts.verticalUnitToMetres);
  const zUnit = zFactor == null
    ? 'unknown'
    : ELEVATION_UNIT_NAME[verticalUnitLabel(zFactor)];
  const reasons = quality?.reasons ?? [];
  const exportReasons = quality?.exportReasons ?? [];
  const warnings = result.warnings ?? [];

  // Prominent top caveat when the GEOREFERENCED export is anything short of full
  // coverage + export-ready. The DEM is the georeferenced deliverable, so its
  // caveat keys off the unified EXPORT readiness verdict (which already gates on
  // a known CRS + vertical datum) — a clean surface with an unknown datum still
  // reads PRELIMINARY here. The reason is named inline.
  const isFull = p.coverageMode === 'full';
  const isExportReady = p.exportReadiness === 'Ready';
  const caveatNote = p.exportReason ? ` (${p.exportReason})` : '';
  const lines: string[] = [];
  if (!isFull || !isExportReady) {
    lines.push(
      `*** PRELIMINARY DEM — coverage: ${p.coverageMode}; export readiness: ${p.exportReadiness}${caveatNote}. ***`,
      `*** Not for reliable terrain products. Treat heights and extents as`,
      `*** provisional and read the Quality gate + Warnings sections below.`,
      ``,
    );
  }

  lines.push(
    `OpenLiDARViewer — DEM export`,
    ``,
    `Files`,
    `  ${basename}-dtm.asc / .tif   Bare-earth digital terrain model (ground)`,
    `  ${basename}-dsm.asc / .tif   Digital surface model (top surface: canopy + structures)`,
    `  ${basename}-chm.asc / .tif   Canopy height model (above-ground height = DSM - DTM)`,
    ...(opts.evidenceFilename
      ? [`  ${opts.evidenceFilename.padEnd(28)} Terrain evidence: per-cell support for the DTM (see below)`]
      : []),
    ...(opts.sensitivityFilename
      ? [`  ${opts.sensitivityFilename.padEnd(28)} Terrain sensitivity: model spread for the DTM (see below)`]
      : []),
    ...(opts.attentionFilename
      ? [`  ${opts.attentionFilename.padEnd(28)} Terrain attention: where to inspect first, and why (see below)`]
      : []),
    `  *.prj                        Coordinate reference system (WKT), when known`,
    `  SHA256SUMS.txt               SHA-256 of every file above (verify: sha256sum -c)`,
    ``,
    `Raster`,
    `  Grid size      ${dtm.cols} x ${dtm.rows} cells`,
    `  Cell size      ${dtm.cellSizeM} ${hUnit}`,
    `  NODATA value   ${NO_DATA}`,
    `  Coverage       ${pct(cov.measured)} measured, ${pct(cov.interp)} interpolated`,
    `  Bounds (CRS units, ${isGeographic ? 'lon/lat degrees' : 'projected'})`,
    `    min X / min Y  ${coord(opts.boundsMinX)} / ${coord(opts.boundsMinY)}`,
    `    max X / max Y  ${coord(opts.boundsMaxX)} / ${coord(opts.boundsMaxY)}`,
    `  Elevation unit ${zUnit}`,
    // The DERIVED-PRODUCT digest: a hash of the surface this package emits, not
    // of the source file and not of the analysis inputs. Two packages carrying
    // the same grid of heights and coverage states share this value; any cell,
    // coverage state, grid geometry or CRS code that differs moves it. It is
    // what lets a reader check that a DTM they hold is the one a report
    // described, which the method digest cannot answer on its own.
    `  Surface digest ${surfaceDigest}`,
    ``,
    ...(opts.evidenceFilename ? terrainEvidenceReadmeLines(
          opts.evidenceFilename,
          hUnit,
          opts.evidenceVerticalUnit ?? 'unknown',
          opts.evidenceFrameResolved ?? true,
        ) : []),
    ...(opts.sensitivityFilename
      ? terrainSensitivityReadmeLines(opts.sensitivityFilename, opts.evidenceVerticalUnit ?? 'unknown')
      : []),
    ...(opts.demEvidence ? terrainAttentionReadmeLines(opts.attentionFilename ?? null, opts.demEvidence) : []),
    `Coverage mode`,
    `  ${coverageLabel(p.coverageMode)}`,
    `  Analysed basis: ${p.analysedBasisLine}`,
    ``,
    `Quality gate`,
  );

  // Quality gate — the unified verdicts come from the provenance block below;
  // here we surface the gate's own per-axis REASON lists (surface + export
  // georeferencing) so a preview / blocked export explains itself in full.
  if (reasons.length) {
    lines.push(`  Surface reasons`);
    for (const r of reasons) lines.push(`    - ${r}`);
  }
  if (exportReasons.length) {
    lines.push(`  Export reasons (georeferencing)`);
    for (const r of exportReasons) lines.push(`    - ${r}`);
  }
  if (!reasons.length && !exportReasons.length) {
    lines.push(`  (no gate reasons — see Export readiness in Provenance below)`);
  }
  lines.push(``, `Warnings`);
  if (warnings.length) {
    for (const w of warnings) lines.push(`  - ${w}`);
  } else {
    lines.push(`  (none)`);
  }
  lines.push(``);

  // Generation parameters are derived from the actual run (result.generationParams),
  // never mirrored constants. If the field is somehow absent we say "unknown"
  // rather than silently asserting geodesic/on/on — provenance must stay honest.
  // (The contour STYLE lives in the Provenance block below — single-sourced — so
  // it can't drift from what the other exports stamp.)
  const gp = result.generationParams;
  const interpStr = gp ? `${gp.interpolation} void fill` : 'unknown';
  let despikeStr: string;
  if (gp) despikeStr = gp.despike ? 'on (blunder-only outlier removal)' : 'off';
  else despikeStr = 'unknown';
  const aggStr = gp ? gp.aggregation : 'unknown';
  lines.push(
    `Generation parameters`,
    `  Interpolation  ${interpStr}`,
    `  Cell aggregation ${aggStr}`,
    `  Despike        ${despikeStr}`,
    `  Grid cell size ${dtm.cellSizeM} ${hUnit}`,
    ``,
    // The unified provenance block — IDENTICAL lines to every other export.
    `Provenance`,
    ...provenanceLines(p).map((l) => `  ${l}`),
    ``,
    // A read-only explanation of the evidence decision the resolver made:
    // which claim, what it starts at, what it resolved to, and why. The view is
    // built by the resolver itself rather than by a second reading of the same
    // rules, so this section cannot disagree with the decision it describes.
    ...evidenceContractLines(result),
    `The ASCII grids and GeoTIFFs describe the same surfaces; use whichever your`,
    `software prefers. Interpolated cells are real estimates between measured`,
    `ground; treat them with the coverage figure above in mind.`,
    ``,
  );

  return lines.join('\n');
}

/** Build a full DEM package (ZIP) from an analysis result. Returns ZIP bytes. */
export function buildDemPackage(
  result: AnalyseContoursResult,
  options: DemPackageOptions = {},
): Uint8Array {
  const dtm = result.dtm;
  const basename = options.basename || 'terrain';
  // Defaulted once for the whole package. Two clocks read a millisecond apart
  // would stamp the README and the passport differently, so a rebuild from the
  // same inputs would not produce the same bytes and neither file would be
  // wrong enough to notice.
  const generationDateIso = options.generationDateIso ?? new Date().toISOString();
  const ox = options.worldOrigin?.x ?? 0;
  const oy = options.worldOrigin?.y ?? 0;
  const xll = ox + dtm.originH1;
  const yll = oy + dtm.originH2;
  const cellSize = dtm.cellSizeM;
  // Numeric codes from the resolver are authoritative; the label parse is the
  // defensive fallback for grids built before the codes travelled.
  const epsg = dtm.horizontalEpsg ?? parseEpsg(dtm.crs);
  const verticalEpsg = dtm.verticalEpsg ?? parseEpsg(dtm.verticalDatum);
  // GeoTIFF unit code for the Z values, from the factor the analysis carried.
  const verticalUnitCode = verticalUnitGeoKeyCode(dtm.verticalUnitToMetres);
  const isGeographic = options.isGeographic ?? false;

  // Bounds extent in CRS units: lower-left corner of the lower-left cell to the
  // upper-right corner of the upper-right cell.
  const boundsMinX = xll;
  const boundsMinY = yll;
  const boundsMaxX = xll + dtm.cols * cellSize;
  const boundsMaxY = yll + dtm.rows * cellSize;

  // Reconstruct DSM = DTM + canopy height. Covered where the canopy height is
  // defined and the DTM carries a ground reference.
  const chm = result.surface.canopy.heightM;
  const { dsmZ, dsmCov, chmCov } = reconstructDsmChm(dtm.z, dtm.coverage, chm);

  // Add the dropped vertical origin back to the ABSOLUTE-elevation grids (DTM,
  // DSM) so they write real source heights. A shifted COPY of covered cells only
  // (never mutate result.dtm.z — it backs the live viewer and later exports; and
  // NODATA is coverage-gated by the writers, so uncovered cells are untouched).
  // CHM is a height difference and is written exactly as-is.
  const oz = options.worldOrigin?.z ?? 0;
  const shiftZ = (values: ArrayLike<number>, coverage: ArrayLike<number>): ArrayLike<number> => {
    if (oz === 0) return values;
    const out = Float64Array.from(values as ArrayLike<number>);
    for (let i = 0; i < out.length; i++) if (coverage[i] !== 0) out[i] += oz;
    return out;
  };

  const grids: Array<{
    key: string;
    values: ArrayLike<number>;
    coverage: ArrayLike<number>;
    verticalEpsg: number | null;
  }> = [
    // CHM is DSM − DTM: a height ABOVE GROUND, not a coordinate in any absolute
    // vertical CRS. Stamping it with the DTM/DSM's VerticalCSType told a GIS
    // its canopy heights were NAVD88 elevations — a claim a reader acts on
    // (geoid corrections, benchmark comparisons). Only the absolute grids
    // carry the stamp; the relative one states no vertical reference.
    { key: 'dtm', values: shiftZ(dtm.z, dtm.coverage), coverage: dtm.coverage, verticalEpsg },
    { key: 'dsm', values: shiftZ(dsmZ, dsmCov), coverage: dsmCov, verticalEpsg },
    { key: 'chm', values: chm, coverage: chmCov, verticalEpsg: null },
  ];

  const entries: ZipEntry[] = [];
  for (const g of grids) {
    const common = {
      values: g.values, coverage: g.coverage,
      cols: dtm.cols, rows: dtm.rows, cellSize, xllCorner: xll, yllCorner: yll, noData: NO_DATA,
    };
    entries.push(
      {
        name: `${basename}-${g.key}.asc`,
        bytes: new TextEncoder().encode(writeAsciiGrid(common)),
      },
      {
        name: `${basename}-${g.key}.tif`,
        bytes: writeGeoTiff({ ...common, epsg, isGeographic, verticalEpsg: g.verticalEpsg, verticalUnitCode: g.verticalEpsg != null ? verticalUnitCode : null }),
      },
    );
  }

  // Terrain evidence raster: per-cell support on the DTM's grid and NoData
  // cells. Written whenever the grid carries its per-cell support arrays.
  const evidenceName = `${basename}_evidence.tif`;
  const hUnit = isGeographic ? 'degrees' : projectedUnitLabel(options.linearUnit);
  // Band 5's unit and the unresolved state (cell_state 6) follow the README's
  // own elevation-unit rule, plus a horizontal CRS code.
  const evFactor = resolvedVerticalFactor(result, options.verticalUnitToMetres);
  const evVUnit = evFactor == null || verticalUnitLabel(evFactor) === 'units' ? 'unknown' : verticalUnitLabel(evFactor);
  const evFrameResolved = evVUnit !== 'unknown' && epsg != null;
  let evidenceBytes: Uint8Array | null = null;
  if (hasEvidenceArrays(dtm)) {
    evidenceBytes = writeTerrainEvidenceGeoTiff(dtm, {
      xllCorner: xll,
      yllCorner: yll,
      noData: NO_DATA,
      epsg,
      isGeographic,
      horizontalUnit: hUnit,
      verticalUnit: evVUnit,
      frameResolved: evFrameResolved,
      demValues: grids[0].values,
    });
    entries.push({ name: evidenceName, bytes: evidenceBytes });
  }

  // Terrain sensitivity raster: written only when the caller ran the ensemble.
  const sensitivityName = `${basename}_sensitivity.tif`;
  let sensitivityBytes: Uint8Array | null = null;
  if (options.sensitivityGrids && options.sensitivityGrids.length > 0) {
    sensitivityBytes = writeTerrainSensitivityGeoTiff(options.sensitivityGrids, {
      xllCorner: xll,
      yllCorner: yll,
      noData: NO_DATA,
      epsg,
      isGeographic,
      verticalUnit: evVUnit,
      demValues: grids[0].values,
    });
    entries.push({ name: sensitivityName, bytes: sensitivityBytes });
  }

  // Terrain attention raster: where to inspect first, with one reason per
  // cell, from the evidence inputs, the reconstruction residual and (when
  // requested) the sensitivity range. Written with the evidence raster.
  const attentionName = `${basename}_attention.tif`;
  let attentionBytes: Uint8Array | null = null;
  let residual: ReturnType<typeof reconstructionResidual> | null = null;
  const vRef = evVUnit === 'unknown' ? null : verticalReferenceInUnit(evFactor);
  if (evidenceBytes && hasEvidenceArrays(dtm)) {
    const hFactor = options.linearUnit === 'foot' ? UNIT_FACTORS.M_PER_FT
      : options.linearUnit === 'us-survey-foot' ? UNIT_FACTORS.M_PER_US_FT : 1;
    const lat = isGeographic ? yll + (dtm.rows * cellSize) / 2 : 0;
    const step = horizontalCellMetresXY(cellSize, isGeographic, lat, hFactor);
    residual = reconstructionResidual(dtm, {
      cellMetresX: step.x,
      cellMetresY: step.y,
      verticalUnitToMetres: evFactor ?? 1,
    });
    const ev = terrainEvidenceBands(dtm, { frameResolved: evFrameResolved });
    const sens = options.sensitivityGrids && options.sensitivityGrids.length > 0
      ? terrainSensitivityBands(options.sensitivityGrids).range
      : null;
    const bands = terrainAttentionBands({
      cols: dtm.cols,
      rows: dtm.rows,
      coverage: dtm.coverage,
      interpDistanceCells: dtm.interpDistanceCells,
      confidence: dtm.confidence,
      cellState: ev.cellState,
      residual: residual.residual,
      sensitivityRange: sens,
      verticalReference: vRef,
      frameResolved: evFrameResolved,
    });
    attentionBytes = writeTerrainAttentionGeoTiff(bands, dtm, {
      xllCorner: xll,
      yllCorner: yll,
      epsg,
      isGeographic,
      demValues: grids[0].values,
    });
    entries.push({ name: attentionName, bytes: attentionBytes });
  }
  const hasDtmTif = entries.some((e) => e.name === `${basename}-dtm.tif`);
  const demEvidence = demEvidenceRecord({
    tier: demEvidenceTier({
      passport: hasDtmTif,
      evidence: evidenceBytes != null,
      sensitivity: sensitivityBytes != null,
      attention: attentionBytes != null,
    }),
    residual: attentionBytes ? residual : null,
    verticalReference: vRef,
    verticalUnit: evVUnit,
    sensitivityGrids: sensitivityBytes ? options.sensitivityGrids ?? null : null,
  });

  if (options.wkt) {
    entries.push({ name: `${basename}.prj`, bytes: new TextEncoder().encode(options.wkt) });
  }
  const readme = buildDemReadme({
    verticalUnitToMetres: options.verticalUnitToMetres ?? null,
    result,
    basename,
    isGeographic,
    linearUnit: options.linearUnit,
    boundsMinX, boundsMinY, boundsMaxX, boundsMaxY,
    generationDateIso,
    softwareName: options.softwareName ?? 'OpenLiDARViewer',
    softwareVersion: options.softwareVersion ?? 'unknown',
    metricVersion: options.metricVersion ?? 'unknown',
    exportPermit: options.exportPermit ?? null,
    analysedBasis: options.analysedBasis ?? null,
    evidenceFilename: evidenceBytes ? evidenceName : null,
    evidenceVerticalUnit: evVUnit,
    evidenceFrameResolved: evFrameResolved,
    sensitivityFilename: sensitivityBytes ? sensitivityName : null,
    attentionFilename: attentionBytes ? attentionName : null,
    demEvidence,
  });
  entries.push({
    name: `${basename}-README.txt`,
    bytes: new TextEncoder().encode(readme),
  });

  // A passport for the bare-earth raster, beside the raster. The artifact is
  // ONE file rather than the package: a passport digesting the ZIP it travels
  // inside could never verify, because adding it changes what it measured.
  //
  // This is a tamper-evident provenance record, not a signature. It binds the
  // source identity, the analysis record, the processing manifest, the methods,
  // the evidence decision and the digest of the raster it names. A recipient
  // who rehashes that raster and reads the record can tell whether the file
  // they hold is the one this analysis produced; nothing here proves who
  // produced it.
  const dtmTif = entries.find((e) => e.name === `${basename}-dtm.tif`);
  if (dtmTif) {
    const passportProvenance = buildExportProvenance(result, {
      verticalUnitToMetres: options.verticalUnitToMetres ?? null,
      basename,
      generatedAt: generationDateIso,
      softwareVersion: options.softwareVersion ?? 'unknown',
      metricVersion: options.metricVersion ?? 'unknown',
      exportPermit: options.exportPermit ?? null,
      evidenceClaimIds: dtmArtifactClaims(result),
      analysedBasis: options.analysedBasis ?? null,
    });
    const passport = buildScientificArtifactPassport({
      // The source digest is recorded when the loader verified one and left
      // null when it did not. Null reads as unavailable rather than as a
      // digest that happens to be missing.
      source: { name: passportProvenance.source, sha256: options.sourceSha256 ?? null },
      analysis: analysisRecordFromProvenance(passportProvenance),
      processing: processingManifestFromProvenance(passportProvenance),
      evidence: {
        baseline: passportProvenance.scopedEvidence?.baselineEvidence ?? null,
        effective: passportProvenance.scopedEvidence?.effectiveEvidence ?? null,
        resolutionState: passportProvenance.scopedEvidence?.resolutionState ?? 'unresolved',
        matchedStudy: passportProvenance.scopedEvidence?.matchedScopedStudy ?? null,
        applicabilityVerdict:
          passportProvenance.scopedEvidence?.applicabilityVerdict ?? 'no scoped study applies',
      },
      artifact: {
        filename: dtmTif.name,
        mediaType: 'image/tiff',
        bytes: dtmTif.bytes,
      },
      demEvidence: demEvidence as unknown as Record<string, unknown>,
      ...(evidenceBytes || sensitivityBytes
        ? {
            companions: [
              ...(evidenceBytes
                ? [{ filename: evidenceName, mediaType: 'image/tiff', bytes: evidenceBytes, methodId: TERRAIN_EVIDENCE_METHOD_ID }]
                : []),
              ...(sensitivityBytes
                ? [{ filename: sensitivityName, mediaType: 'image/tiff', bytes: sensitivityBytes, methodId: TERRAIN_SENSITIVITY_METHOD_ID }]
                : []),
              ...(attentionBytes
                ? [{ filename: attentionName, mediaType: 'image/tiff', bytes: attentionBytes, methodId: TERRAIN_ATTENTION_METHOD_ID }]
                : []),
            ],
          }
        : {}),
    });
    entries.push({
      name: `${basename}-dtm.tif.olv-passport.json`,
      bytes: new TextEncoder().encode(`${JSON.stringify(passport, null, 2)}\n`),
    });
  }

  // Integrity manifest LAST: it hashes every file already assembled (README
  // included) so a recipient can verify the whole deliverable with a standard
  // `sha256sum -c`. It hashes everything except itself, per the sha256sum
  // convention, so its own presence doesn't need to be self-referential.
  entries.push({
    name: 'SHA256SUMS.txt',
    bytes: new TextEncoder().encode(buildSha256Manifest(entries)),
  });

  return buildZip(entries);
}
