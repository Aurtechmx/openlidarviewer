/**
 * reportExport.ts — the report / geo-context export orchestration lifted out of
 * main.ts.
 *
 * Two functions live here: {@link generateReportPdf}, which assembles and renders
 * the multi-page PDF report from the live scan state (metadata, annotations,
 * measurements, unit system + provenance fingerprint), and {@link exportGeoContext},
 * which resolves the origin + CRS + name for the ACTIVE scan — static OR streaming
 * — so the Products-lane exporters (measurements / integrity report / KML) place
 * local points back into the source frame. Both read the same active-scan seam and
 * the same resolved CRS the rest of the shell uses.
 *
 * The genuinely pure decisions the extraction exposes are free functions so they
 * are Node-testable without a Viewer, the report engine or the DOM:
 * {@link effectiveCrsName} (the CRS-label honesty rule — only a projected /
 * geographic CRS names the frame, so a post-override label can't confidently place
 * an export in the CRS the user rejected), {@link reportPointCount} (the file-scale
 * honesty rule the PDF's Point Count follows — the declared total over the strided
 * display subset, the same rule as the Layers chip's `layerChipCount`) and
 * {@link isNonTerrainVerdict} (the capture-lens predicate that rules out an aerial
 * density guess for a compact object / interior). Everything else is imperative
 * orchestration, driven through a structural {@link ReportExportDeps} of accessor
 * functions closing over the shell's services and its mutable scan verdict rather
 * than the Viewer class — the same seam `openScan` and `openStreaming` use. The
 * heavy report engine (which pulls pdf-lib) is passed in as a lazy loader so this
 * module stays free of the boot graph. `main.ts` keeps thin `generateReportPdf` /
 * `exportGeoContext` delegates that bind its running state to these deps. Part of
 * the v0.6 decomposition (see `docs/architecture/architecture-map.md`).
 */

import { footprintMetres } from '../report/reportFootprint';
import type { Footprint } from '../report/reportFootprint';
import { spatialContextFrom } from '../geo/SpatialContext';
import { isZUpFormat } from '../io/sniffFormat';
import { increment as recordUsage } from '../diagnostics/usageCounters';
import { classify as classifyProvenance } from '../diagnostics/provenance';
import { signalsForStaticCloud, signalsForStreamingCloud } from '../diagnostics/provenanceSignals';
import { triggerDownload } from '../io/download';

import type { MetadataInputs, ReportProvenanceFingerprint } from '../report';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { SpaceKind } from '../terrain/scanShape';
import type { Viewer } from '../render/Viewer';
import type { DropZone } from '../ui/DropZone';
import type { ScanService } from './ScanService';
import type { loadReportEngine } from '../lazyChunks';

// ─────────────────────────────────────────────────────────────────────────────
// Pure decisions the extraction exposes — decidable without a Viewer, the report
// engine or the DOM, so `tests/reportExport.test.ts` pins each one directly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The CRS label to STAMP on an export, or undefined for none. Only a projected or
 * geographic CRS names the frame the coordinates live in; a local-coordinate (or
 * absent) CRS yields undefined so nothing false is stamped.
 *
 * The label must come from the RESOLVED CRS — the same one every conversion, unit
 * factor and validation gate uses — not from the raw source metadata. After a user
 * override (the picker exists precisely because files declare wrong CRSs), the
 * source label names the CRS the user rejected: a KML whose coordinates were
 * converted under the override then carried metadata naming the old CRS would place
 * confidently in the wrong frame — worse than no label. The raw source name stays
 * available on the cloud for provenance.
 */
export function effectiveCrsName(crs: ResolvedCrs | null): string | undefined {
  return crs && (crs.kind === 'projected' || crs.kind === 'geographic')
    ? crs.name
    : undefined;
}

/**
 * The FILE-scale point count the PDF's "Point Count" reports. The loader strides
 * huge clouds for display, so the in-memory `pointCount` is the rendered subset —
 * the client PDF must describe the FILE, so use the declared total (and the density
 * that follows from it) when striding reduced the in-memory count. Mirrors the
 * Layers chip's `layerChipCount` and the Scan Report panel; the two must agree.
 */
export function reportPointCount(
  declaredPointCount: number | undefined,
  renderedPointCount: number,
): number {
  return declaredPointCount !== undefined && declaredPointCount > renderedPointCount
    ? declaredPointCount
    : renderedPointCount;
}

/**
 * True for a compact object / interior scan — the capture-lens verdict that rules
 * out an aerial density guess in the provenance fingerprint (v0.5.7). A temple is
 * not drone LiDAR just because its density resembles a UAV survey.
 */
export function isNonTerrainVerdict(verdict: SpaceKind | null): boolean {
  return verdict === 'object' || verdict === 'interior';
}

/**
 * The extent-carrying subset of {@link MetadataInputs}, mapped from a
 * {@link Footprint}. A confirmed footprint carries metre extents + a pts·m⁻²
 * density (byte-identical to the historical build). An unconfirmed footprint
 * carries the RAW source-unit spans, a NaN density (so the density row / QL
 * grading is omitted), and the `extentUnitStatus: 'unknown'` flag that makes the
 * dataset summary print a "units unconfirmed — extents in source units" warning
 * instead of a metre label.
 */
export function footprintToMetadataExtent(
  fp: Footprint,
): Pick<MetadataInputs, 'width' | 'depth' | 'height' | 'density' | 'extentUnitStatus'> {
  if (fp.unitStatus === 'confirmed') {
    return {
      width: fp.widthMetres,
      depth: fp.depthMetres,
      height: fp.heightMetres,
      density: fp.densityPerM2,
    };
  }
  return {
    width: fp.widthSourceUnits,
    depth: fp.depthSourceUnits,
    height: fp.heightSourceUnits,
    density: Number.NaN,
    extentUnitStatus: 'unknown',
  };
}

/**
 * Origin + CRS + name for the ACTIVE scan, static OR streaming — the frame the
 * Products-lane exporters place local points back into.
 */
export interface GeoExportContext {
  origin: readonly [number, number, number];
  crsName: string | undefined;
  name: string | null;
}

/**
 * The running-app seam the report / geo-context exports write through. Accessors
 * are functions, not snapshots, so the lazily-bound Viewer, the resolved CRS and
 * the mutable scan verdict are read at call time — exactly as the inline versions
 * read the shell's `viewer` / `crsService` / `lastScanVerdict`. The report engine
 * (which pulls pdf-lib) is passed as a lazy loader so this module stays free of the
 * boot graph and the pure decisions above can be tested without it.
 */
export interface ReportExportDeps {
  /** Resolves once the lazily-loaded Viewer chunk is in place — awaited before any `getViewer()`. */
  readonly viewerReady: Promise<unknown>;
  /** The live Viewer (a late-bound `let` in the shell). */
  getViewer: () => Viewer;
  /** Active-scan selection + lookup. */
  scans: Pick<ScanService, 'activeId' | 'activeCloud'>;
  /** The resolved CRS for the active scan (the shell's `crsService.current()`), or null. */
  crsCurrent: () => ResolvedCrs | null;
  /** The shape router's latest verdict for the active scan (the shell's `lastScanVerdict`). */
  lastScanVerdict: () => SpaceKind | null;
  /** The current class-scope stamp — disclosed on the PDF when a filter narrows the view. */
  classScopeStamp: () => string;
  /** A file name without its extension (the shell's `baseName`). */
  baseName: (name: string) => string;
  /** Lazily import the report engine (pdf-lib + the pure builders). */
  loadReportEngine: typeof loadReportEngine;
  /** The drop-zone status surface — carries a partial-render warning. */
  dropZone: Pick<DropZone, 'setError'>;
  /** `?debug=1` — console diagnostics for the wrapped, defensive blocks. */
  readonly debug: boolean;
}

/**
 * Origin + CRS + name for the ACTIVE scan, static OR streaming. The Products-
 * lane exporters (measurements / integrity report / KML) place local points
 * back into the source frame by adding the cloud origin — but streaming clouds
 * aren't tracked by `scans.activeId`, so reading only the static cloud left them
 * exporting at RENDER-frame coordinates (off by the whole `renderOrigin`) with
 * no CRS. This resolves the origin from the streaming source's `renderOrigin`
 * when no static cloud is active.
 */
export function exportGeoContext(deps: ReportExportDeps): GeoExportContext {
  const viewer = deps.getViewer();
  // The label comes from the RESOLVED CRS, the same rule every export path uses.
  // The label comes ONLY from the RESOLVED CRS. It must NOT fall back to the
  // file's declared metadata name: when the user resolved the scan to Local /
  // no-CRS, `effectiveCrsName` is undefined, and the report then states local /
  // unknown honestly rather than resurrecting the rejected source CRS (1B). A
  // streaming scan reaches the resolved authority now that EPT publishes its CRS
  // to CrsService on commit (blocker 2). Source A, when wanted, belongs only in a
  // field explicitly labelled source-declared, never in the active CRS label.
  const crsName = effectiveCrsName(deps.crsCurrent());
  if (deps.scans.activeId) {
    const c = viewer.getCloud(deps.scans.activeId);
    // SOURCE frame (float64-transform.md step 2): sessions save + import here.
    if (c) return { origin: c.sourceOrigin, crsName, name: c.name };
  }
  const sc = viewer.streamingCloud;
  if (sc) return { origin: sc.renderOrigin, crsName, name: sc.name };
  return { origin: [0, 0, 0], crsName: undefined, name: null };
}

/**
 * Assemble + render a PDF report from the live state.
 * Lazy-loads the report engine (which pulls pdf-lib) on first call.
 * Returns a Promise so the caller can surface errors via toast/alert.
 *
 * Pulls the active streaming OR static cloud's metadata, the current
 * annotations + measurements + unit system, and assembles a
 * `ReportInputs`. Visuals + technical notes are queued for a UI-coupled
 * follow-up (the user will pre-render image exports + type notes via a
 * follow-on Studio-panel dialog). The engineering-
 * inspection template renders cleanly without visuals.
 */
export async function generateReportPdf(templateId: string, deps: ReportExportDeps): Promise<void> {
  // the report flow needs the Viewer state; ensure it's loaded.
  await deps.viewerReady;
  const viewer = deps.getViewer();
  const report = await deps.loadReportEngine();
  const streamingCloud = viewer.streamingCloud;
  const staticCloud = deps.scans.activeCloud() ?? undefined;
  if (!streamingCloud && !staticCloud) {
    throw new Error('Load a scan first.');
  }

  // Build the MetadataInputs the composer + dataset-summary section need.
  //
  // CRS authority: the report's spatial context, unit gate and stamped CRS row
  // all read the RESOLVED active CRS (the same `crsService.current()` every
  // conversion, export and validation gate uses), never the file's declared
  // metadata. A user CRS/unit override is thereby honoured in the PDF, and a
  // scan resolved to Local / no-CRS states local/unknown honestly rather than
  // resurrecting the rejected source CRS. `effectiveCrsName` keeps the stamped
  // label to a frame that actually names coordinates (projected/geographic).
  const activeCrs = deps.crsCurrent();
  const activeCrsLabel = effectiveCrsName(activeCrs);
  let metadata: MetadataInputs;
  let exportFileStem: string;
  if (streamingCloud) {
    // `dataBounds` (tight data AABB), NOT `localBounds` (the octree cube): the
    // cube inflates height ~7× and, for a partial footprint, deflates density.
    const b = streamingCloud.dataBounds();
    // ONE spatial context for this report, built here at the export boundary
    // from the RESOLVED active CRS: the footprint's unit gate, both scale
    // factors, and the CRS row printed in the Methods appendix all read it, so
    // the file cannot state one unit and measure in another — and an override is
    // honoured rather than the streaming source declaration.
    //
    // Footprint + density in metres / pts·m⁻², not raw CRS units (see
    // reportFootprint): a foot-CRS scan would otherwise overstate the headline
    // area ~10.76× and be graded against the wrong USGS Quality Level. FAIL
    // CLOSED on an unconfirmed unit: an unknown-unit CRS carries the inert
    // placeholder factor, so the context's `linearUnitKnown` gates whether the
    // report may claim metres at all — otherwise the extents are emitted in
    // source units with no density and a "units unconfirmed" warning row.
    const ctx = spatialContextFrom(activeCrs);
    const fp = footprintMetres({
      extentX: b[3] - b[0], extentY: b[4] - b[1], extentZ: b[5] - b[2],
      pointCount: streamingCloud.sourcePointCount,
      linearUnitToMetres: ctx.linearUnitToMetres,
      verticalUnitToMetres: ctx.verticalUnitToMetres,
      linearUnitKnown: ctx.linearUnitKnown,
      // COPC and EPT are Z-up by spec.
      zUp: true,
    });
    const ext = footprintToMetadataExtent(fp);
    const modes = streamingCloud.availableColorModes();
    // Streaming-preview accounting — how much of the cloud is resident at
    // export time. Surfaced as a "Loaded" row so the PDF discloses that a
    // mid-stream report describes the full cloud but inspected only the
    // resident subset. counts().known is the total known node count.
    const nodeCounts = streamingCloud.counts();
    metadata = {
      fileName: streamingCloud.name,
      format: streamingCloud.kind === 'ept' ? 'EPT' : 'COPC',
      sourcePointCount: streamingCloud.sourcePointCount,
      ...ext,
      hasRgb: modes.includes('rgb'),
      hasIntensity: modes.includes('intensity'),
      hasClassification: modes.includes('classification'),
      streamingResident: {
        points: streamingCloud.residentPointCount,
        nodes: nodeCounts.resident,
        totalNodes: nodeCounts.known,
      },
      ...(activeCrsLabel ? { crsName: activeCrsLabel, crsUnit: activeCrs?.linearUnit } : {}),
      // Class-filter honesty — when a filter narrows the live view, disclose
      // it so the PDF's full-cloud figures aren't read as filter-scoped.
      ...(deps.classScopeStamp() ? { classScopeNote: deps.classScopeStamp() } : {}),
    };
    exportFileStem = deps.baseName(streamingCloud.name);
  } else if (staticCloud) {
    const b = staticCloud.bounds();
    // File-scale honesty: the loader strides huge clouds for display, so
    // `pointCount` is the rendered subset. The client PDF must describe the
    // FILE — use the declared total (and the density that follows from it) when
    // striding reduced the in-memory count, matching the Scan Report panel.
    const fileN = reportPointCount(staticCloud.declaredPointCount, staticCloud.pointCount);
    // Same one-context rule as the streaming path above — RESOLVED active CRS,
    // not the file's declared metadata, so an override drives the report's units.
    // Footprint + density in metres / pts·m⁻² (see reportFootprint): a foot-CRS
    // scan would otherwise overstate area ~10.76× and be graded against the
    // wrong USGS Quality Level. FAIL CLOSED on an unconfirmed unit — see the
    // streaming path above.
    const ctx = spatialContextFrom(activeCrs);
    const fp = footprintMetres({
      extentX: b.max[0] - b.min[0], extentY: b.max[1] - b.min[1], extentZ: b.max[2] - b.min[2],
      pointCount: fileN,
      linearUnitToMetres: ctx.linearUnitToMetres,
      verticalUnitToMetres: ctx.verticalUnitToMetres,
      linearUnitKnown: ctx.linearUnitKnown,
      // Mesh formats load Y-up, so the PDF reads the same axes as the
      // on-screen Scan Report rather than assuming Z.
      zUp: isZUpFormat(staticCloud.sourceFormat),
    });
    const ext = footprintToMetadataExtent(fp);
    metadata = {
      fileName: staticCloud.name,
      format: staticCloud.sourceFormat.toUpperCase(),
      sourcePointCount: fileN,
      ...ext,
      hasRgb: !!staticCloud.colors,
      hasIntensity: !!staticCloud.intensity,
      hasClassification: !!staticCloud.classification,
      ...(activeCrsLabel ? { crsName: activeCrsLabel, crsUnit: activeCrs?.linearUnit } : {}),
      // Class-filter honesty — when a filter narrows the live view, disclose
      // it so the PDF's full-cloud figures aren't read as filter-scoped.
      ...(deps.classScopeStamp() ? { classScopeNote: deps.classScopeStamp() } : {}),
    };
    exportFileStem = deps.baseName(staticCloud.name);
  } else {
    throw new Error('Load a scan first.');
  }

  // Derive the cover title from the actual template so each template
  // produces a distinct, recognisable PDF. The user-reported bug — "all
  // reports show the same export" — was driven by a hardcoded
  // `title: 'Scan Report'` that made the cover identical across every
  // template choice. Pulling `label` off `getReportTemplate(templateId)`
  // gives "Survey Summary" or "Technical Report" as appropriate. The
  // dataset name moves into the subtitle so both axes (template type,
  // source scan) are surfaced on the cover.
  //
  // v0.5.5 P12 — legacy ids (engineering-inspection, qa-validation,
  // terrain-review, technical-documentation, scan-acceptance) normalise
  // to the nearest current template, so an id carried in old UI state or
  // an external caller keeps working; the export filename follows the
  // NORMALISED id.
  const validatedTemplateId =
    report.normalizeReportTemplateId(templateId) ?? report.DEFAULT_TEMPLATE_ID;
  const template = report.getReportTemplate(validatedTemplateId);
  const coverTitle = template?.label ?? 'Scan Report';
  // Compute the same provenance fingerprint the Inspector's Provenance
  // section already shows, and feed it to the report. Templates that
  // include the `provenance` section get a real capture-type +
  // confidence + cited accuracy bounds — auto-computed, varies per
  // scan, gives every export per-template differentiation without
  // requiring the user to take measurements or annotate first.
  //
  // Wrapped because a malformed cloud shape shouldn't sink the whole
  // PDF — the section gracefully renders "No provenance fingerprint
  // available" when the fingerprint is undefined.
  let provenanceFp: ReportProvenanceFingerprint | undefined;
  try {
    const activeCloud = deps.scans.activeCloud();
    const streamingCloud = viewer.streamingCloud;
    // The shape router's verdict rules out an aerial density guess for a
    // compact object / interior (v0.5.7 capture lens) — a temple is not drone
    // LiDAR just because its density resembles a UAV survey.
    const isNonTerrain = isNonTerrainVerdict(deps.lastScanVerdict());
    if (activeCloud) {
      const f = classifyProvenance({ ...signalsForStaticCloud(activeCloud as never), isNonTerrain });
      provenanceFp = {
        label: f.label,
        confidence: f.confidence,
        signals: f.signals,
        bounds: f.bounds.map((b) => ({ label: b.label, value: b.value, source: b.source })),
        disclaimer: f.disclaimer,
      };
    } else if (streamingCloud) {
      const f = classifyProvenance({ ...signalsForStreamingCloud(streamingCloud as never), isNonTerrain });
      provenanceFp = {
        label: f.label,
        confidence: f.confidence,
        signals: f.signals,
        bounds: f.bounds.map((b) => ({ label: b.label, value: b.value, source: b.source })),
        disclaimer: f.disclaimer,
      };
    }
  } catch (err) {
    if (deps.debug) console.warn('[report] classifyProvenance threw', err);
  }
  const inputs = report.composeReportInputs({
    templateId: validatedTemplateId,
    title: coverTitle,
    subtitle: metadata.fileName,
    metadata,
    visuals: [],          // user-pre-rendered Studio exports
    annotations: viewer.annotate.getAnnotations(),
    measurements: viewer.measure.getMeasurements(),
    unitSystem: viewer.measure.unitSystem,
    // Render-units → metres, the SAME factor the live measure readouts apply
    // (B2, v0.4.5) — so the report PDF's measurement values agree with the
    // panel to the digit on foot-based CRSs.
    unitToMetres: viewer.measure.unitToMetres,
    // Scene up-axis and vertical factor, so the PDF matches the live tool on a
    // Y-up scan and a compound CRS (M6) — the same inputs the panel derives its
    // readouts from, now that the report shares measurementMetrics.
    worldUp: viewer.measure.worldUp,
    verticalToMetres: viewer.measure.verticalUnitToMetres,
    provenance: provenanceFp,
    // The file's own declared source metadata (E57 today) — verbatim,
    // rendered by the report's "Declared source metadata" section under the
    // "declared by the file, not verified" disclosure. Undefined (streaming
    // sources, metadata-less files) omits the section entirely.
    sourceMetadata: staticCloud?.metadata?.sourceMetadata,
  });

  const result = await report.generateReport(inputs);
  // The download filename now mirrors the template choice so the
  // user's Downloads folder distinguishes a Survey Summary from an
  // Engineering Inspection at a glance.
  triggerDownload(result.blob, `${exportFileStem}-${validatedTemplateId}.pdf`);
  // Per-section render failures are caught by the engine's isolation pass
  // and surfaced as a `failedSections` list — the PDF still ships but
  // misses those sections. Tell the user so they're not surprised by a
  // partial deliverable, and record it for local diagnostics so the
  // partial-PDF mode is visible in the session-stats panel.
  if (result.failedSections.length > 0) {
    recordUsage('error', 'report:partial');
    const list = result.failedSections.join(', ');
    deps.dropZone.setError(
      `Report rendered without these sections: ${list}. ` +
        'Check for unusual characters in the affected inputs and try again.',
    );
  }
}
