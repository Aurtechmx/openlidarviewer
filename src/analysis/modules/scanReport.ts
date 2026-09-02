import type { AnalysisModule, AnalysisResult, AnalysisRow, RunOptions } from '../ModuleApi';
import type { PointCloud } from '../../model/PointCloud';
import { sourcePositions } from '../../model/pointFrames';
import type { ClassScope } from '../../render/class/classScope';
import type { SpatialContext } from '../../geo/SpatialContext';
import { spatialContextFrom } from '../../geo/SpatialContext';
import { isZUpFormat } from '../../io/sniffFormat';
import { heightLabel } from '../../geo/height';
import {
  estimateInMemoryPrecision,
  formatPrecisionMetres,
  precisionGradeLabel,
} from '../../geo/inMemoryPrecision';

function rowInfo(label: string, value: string): AnalysisRow {
  return { label, value, status: 'info' };
}

function rowWarn(label: string, value: string): AnalysisRow {
  return { label, value, status: 'warn' };
}

/**
 * Stamp `scope` onto a row, but only when it is a real subset. A full or
 * absent scope leaves the row untouched so the unfiltered output stays
 * byte-identical to the legacy result.
 */
function withScope(row: AnalysisRow, scope: ClassScope | undefined): AnalysisRow {
  if (scope?.kind === 'subset') row.scope = scope;
  return row;
}

/** Format a length in metres — centimetres below a metre, for readability. */
function formatLength(metres: number): string {
  return metres < 1 ? `${(metres * 100).toFixed(1)} cm` : `${metres.toFixed(2)} m`;
}

/** Source→metre factors and unit labels for the extent block. */
export interface ScanReportUnitBasis {
  /** Whether the CRS declares a real, resolved linear unit (metres claimable). */
  readonly unitKnown: boolean;
  /** Horizontal source→metre factor; 1 (identity) when the unit is unconfirmed. */
  readonly mpu: number;
  /** Vertical source→metre factor; 1 (identity) when the unit is unconfirmed. */
  readonly vmpu: number;
  /** Length suffix: ' m' when confirmed, ' (source units)' otherwise. */
  readonly lengthUnit: string;
  /** Areal-density suffix: ' pts/m²' when confirmed, ' pts/unit²' otherwise. */
  readonly densityUnit: string;
}

/**
 * Resolve the extent block's unit basis, FAILING CLOSED on an unconfirmed
 * linear unit.
 *
 * Metres are only CLAIMED when the CRS declares a real linear unit. An
 * unknown-unit CRS carries the inert placeholder `linearUnitToMetres: 1`, and
 * a CRS-less cloud resolves the same way — multiplying a source span by that 1
 * and stamping "m" would report non-metre data (feet, or even degrees for a
 * geographic CRS) as metres. So metres are claimed only when the one
 * {@link SpatialContext} says the linear unit is real — `ctx.linearUnitKnown` —
 * the same canonical gate the streaming report (`streamingExtentRows`), the
 * space report (`spaceMetrics`), the measure tool and the lasso already apply
 * (each is `isLinearUnitKnown`, which the façade wraps). When the unit is
 * unconfirmed the factor stays 1, the raw source span is shown, and the "m" /
 * "pts/m²" claim is withheld.
 *
 * NOTE: the gate is `linearUnitKnown`, NOT `metricClaimsPermitted`. The two agree
 * on every well-formed CRS but diverge on a corrupt `linearUnit: 'metre'` with a
 * non-finite `linearUnitToMetres`, where the ladder blocks the metric headline
 * yet the unit name is still "known"; the report's fail-closed rule keys off the
 * declared unit, so preserving the prior behaviour means reading `linearUnitKnown`.
 */
export function scanReportUnitBasis(ctx: SpatialContext): ScanReportUnitBasis {
  const unitKnown = ctx.linearUnitKnown;
  const mpu = unitKnown ? ctx.linearUnitToMetres : 1;
  const vmpu = unitKnown ? (ctx.verticalUnitToMetres ?? mpu) : 1;
  return {
    unitKnown,
    mpu,
    vmpu,
    lengthUnit: unitKnown ? ' m' : ' (source units)',
    densityUnit: unitKnown ? ' pts/m²' : ' pts/unit²',
  };
}

/**
 * Scan Report — the headline metrics that describe a scan: size, density,
 * spacing and which attributes it carries. Numbers are rounded for a clean,
 * professional read; the raw classification-coverage diagnostic is marked
 * `advanced` so the Inspector tucks it under "Advanced report".
 */
export const scanReport: AnalysisModule = {
  id: 'scan-report',
  label: 'Scan Report',

  run(cloud: PointCloud, _selection?: unknown, options?: RunOptions): AnalysisResult {
    const rows: AnalysisRow[] = [];
    const scope = options?.scope;

    // A subset scope restricts every per-point figure (count, footprint,
    // density, coverage) to the visible classes. The set is masked to a byte
    // to match how classification is stored and counted elsewhere.
    const subset =
      scope?.kind === 'subset' && cloud.classification !== undefined
        ? new Set(scope.codes.map((c) => c & 0xff))
        : null;
    const cls = cloud.classification;
    const isVisible = (i: number): boolean =>
      subset === null || (cls !== undefined && subset.has(cls[i] & 0xff));

    // ── Per-point scan ──────────────────────────────────────────────────
    // Full scope: `n` is the cloud's reported point count and the extent comes
    // from `cloud.bounds()` — byte-identical to the legacy path. Subset scope:
    // count and extent are recomputed over the visible points only.
    const totalN = cloud.pointCount;
    let n = totalN;
    const bounds = cloud.bounds();
    let minX = bounds.min[0], minY = bounds.min[1], minZ = bounds.min[2];
    let maxX = bounds.max[0], maxY = bounds.max[1], maxZ = bounds.max[2];

    if (subset !== null) {
      n = 0;
      minX = minY = minZ = Infinity;
      maxX = maxY = maxZ = -Infinity;
      const pos = sourcePositions(cloud);
      for (let i = 0; i < totalN; i++) {
        if (!isVisible(i)) continue;
        n++;
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (n === 0) {
        // No visible points — every extent collapses to zero so the degenerate
        // branches below report N/A rather than NaN/Infinity arithmetic.
        minX = minY = minZ = maxX = maxY = maxZ = 0;
      }
    }

    // ── File-scale honesty ──────────────────────────────────────────────────
    // The loader strides huge clouds for display, so `n` (the decoded/rendered
    // count) under-represents the survey. For the unfiltered report the file's
    // declared total is the honest headline, and density/spacing follow from
    // it — the same back-scaling the terrain pipeline already applies. A class
    // subset can only be counted over the points actually loaded, so it keeps
    // the decoded basis.
    const declaredN = cloud.declaredPointCount;
    // `sampled`: the file holds more points than the buffer, whatever the
    // scope. `strided`: the unfiltered report back-scales density/spacing to
    // the declared total (a class subset keeps the decoded basis).
    const sampled = declaredN !== undefined && declaredN > totalN;
    const strided = subset === null && sampled;
    const reportedN = strided ? (declaredN as number) : n;

    if (sampled) {
      // The file's count is a whole-file fact: it does not change with the
      // class scope, so it carries no scope stamp, and it stays on the panel
      // when a class is solo'd — otherwise a filtered report reads its visible
      // sample count as the file's total and the sampling disappears with it.
      rows.push(rowInfo('Point Count', (declaredN as number).toLocaleString('en-US')));
      // Don't hide the sampling: name the subset actually held in memory AND
      // every reduction that produced it, so the header count, the Health
      // Check's decoded count and this row reconcile in one sentence. A
      // voxel-reduced buffer holds one averaged centroid per occupied voxel.
      const decoded = cloud.decodedPointCount;
      const loaded = totalN.toLocaleString('en-US');
      const how =
        decoded !== undefined && decoded > totalN
          ? `stride to ${decoded.toLocaleString('en-US')}, then voxel-reduced to ${loaded} centroids`
          : cloud.loadStride !== undefined && cloud.loadStride > 1
            ? `1-in-${cloud.loadStride} stride`
            : 'stride';
      rows.push(rowInfo('Loaded', `${loaded} (display sample: ${how})`));
      if (subset !== null) {
        rows.push(
          withScope(rowInfo('Visible', `${n.toLocaleString('en-US')} of the ${loaded}-point display sample`), scope),
        );
      }
    } else {
      rows.push(withScope(rowInfo('Point Count', n.toLocaleString('en-US')), scope));
    }

    // Extent — bounds are in the source CRS's native linear units (feet for a
    // state-plane-feet cloud), so convert to metres before reporting "m" /
    // "pts/m²" / spacing. Horizontal spans use linearUnitToMetres; height uses
    // the vertical unit when the CRS declares one separately.
    //
    // FAIL CLOSED on the unit: `scanReportUnitBasis` claims metres only when the
    // CRS declares a real linear unit. An unknown-unit CRS (or a CRS-less cloud)
    // carries the inert placeholder factor 1; multiplying by it and stamping "m"
    // would report non-metre data — feet, or even degrees for a geographic CRS —
    // as metres. When unconfirmed, the factor stays 1, the raw source span is
    // shown, and the "m" / "pts/m²" claim is withheld (matches #218/#220).
    // The one SpatialContext for this report: the RESOLVED active context when
    // the shell threads it (so a user CRS/unit override drives the unit gate and
    // the datum row), falling back to the cloud's declared CRS for pure-module
    // callers/tests — byte-identical for a same-unit no-override scan. Both the
    // unit gate and the datum classification read this single `ctx`.
    const ctx = options?.spatialContext ?? spatialContextFrom(cloud.metadata?.crs);
    const basis = scanReportUnitBasis(ctx);
    const { mpu, vmpu } = basis;
    // Footprint and height are axis-aware. LAS-family (and COPC/EPT) are Z-up
    // by spec, so the ground footprint is X·Y and height is Z. Mesh formats
    // (PLY/OBJ/GLB/GLTF) load in their native Y-up frame — the same up-axis
    // the renderer and elevation filter honour — so their footprint is X·Z and
    // height is Y. Assuming Z-up for a Y-up façade scan put the building height
    // into "Depth" and computed density/spacing over the vertical cross-section.
    const spanX = maxX - minX, spanY = maxY - minY, spanZ = maxZ - minZ;
    const zUp = isZUpFormat(cloud.sourceFormat);
    const width = spanX * mpu;
    const depth = (zUp ? spanY : spanZ) * mpu;
    const height = (zUp ? spanZ : spanY) * vmpu;
    rows.push(
      withScope(rowInfo('Width', `${width.toFixed(1)}${basis.lengthUnit}`), scope),
      withScope(rowInfo('Depth', `${depth.toFixed(1)}${basis.lengthUnit}`), scope),
      withScope(rowInfo('Height', `${height.toFixed(1)}${basis.lengthUnit}`), scope),
    );

    const footprintArea = width * depth;

    // Point density — over the file's true count (back-scaled when strided).
    // Both figures are nominal averages (count ÷ footprint), and on a strided
    // load they mix bases — the header's count over the SAMPLE's footprint —
    // so the row says so rather than reading as a measured density.
    const mixedBasis = strided ? ' (mean: declared count over the display-sample footprint)' : '';
    if (footprintArea <= 0 || reportedN === 0) {
      rows.push(withScope(rowWarn('Density', 'N/A (degenerate footprint)'), scope));
    } else {
      rows.push(withScope(rowInfo('Density', `${(reportedN / footprintArea).toFixed(1)}${basis.densityUnit}${mixedBasis}`), scope));
    }

    // Estimated point spacing. The cm/m formatter assumes metres, so it is used
    // only when the unit is confirmed; an unconfirmed scan shows the raw source
    // spacing without a metre label.
    if (footprintArea <= 0 || reportedN === 0) {
      rows.push(withScope(rowWarn('Spacing', 'N/A (degenerate footprint)'), scope));
    } else {
      const spacing = Math.sqrt(footprintArea / reportedN);
      const spacingValue = basis.unitKnown ? formatLength(spacing) : `${spacing.toFixed(2)} (source units)`;
      const spacingBasis = strided ? ' (nominal: √(display-sample footprint ÷ declared count))' : '';
      rows.push(withScope(rowInfo('Spacing', `${spacingValue}${spacingBasis}`), scope));
    }

    // In-memory resolution — what the Float32 position buffer can still tell
    // apart at this extent. The other extent rows describe the survey; this one
    // describes the REPRESENTATION, and on a wide extent the two diverge: a
    // millimetre-quantized source file can sit in a buffer whose step is a
    // centimetre, and nothing else on this card would say so.
    //
    // Measured over the WHOLE buffer, never the class subset: every point is
    // resident regardless of which classes are visible, so the step a filtered
    // view lands on is the step the full extent produces. That is also why no
    // row here carries a scope stamp.
    //
    // The extent is lifted back into the source frame and paired with the
    // origin the loader actually subtracted (`sourceOrigin`, the immutable file
    // origin — the live origin can move when a layer mounts, and the buffer
    // does not follow it). The vertical factor is passed only for a Z-up
    // format, because it describes storage axis Z; a Y-up mesh keeps one unit
    // for all three axes and falls back to the horizontal factor.
    //
    // FAIL CLOSED, same rule as the extent block: with no established linear
    // unit there is no length to report, so the step is shown in source units
    // and left ungraded rather than stamped with a fabricated millimetre.
    const so = cloud.sourceOrigin;
    const precision = estimateInMemoryPrecision({
      extent: {
        min: [bounds.min[0] + so[0], bounds.min[1] + so[1], bounds.min[2] + so[2]],
        max: [bounds.max[0] + so[0], bounds.max[1] + so[1], bounds.max[2] + so[2]],
      },
      strategy: { kind: 'shared-origin', origin: [so[0], so[1], so[2]] },
      unit: {
        linearUnitKnown: basis.unitKnown,
        linearUnitToMetres: ctx.linearUnitToMetres,
        verticalUnitToMetres: zUp ? ctx.verticalUnitToMetres : undefined,
      },
    });
    const pm = precision.metres;
    rows.push(
      pm
        ? {
            label: 'In-memory resolution',
            value:
              `${formatPrecisionMetres(pm.worstCaseSpacing)} worst case, `
              + `${formatPrecisionMetres(pm.typicalSpacing)} mean over the reach `
              + `(${precisionGradeLabel(precision.grade)})`,
            status: precision.grade === 'fine' ? 'info' : 'warn',
          }
        : rowWarn(
            'In-memory resolution',
            `${precision.worstCaseSpacing.toPrecision(3)} (source units) worst case — `
              + 'no linear unit declared, not graded',
          ),
      {
        label: 'Quantization basis',
        value:
          `Float32 positions, ${precision.governingAxis} axis, `
          + `${precision.reach.toFixed(0)} source units from the local origin `
          + `(${precision.localOrigin.map((n) => n.toFixed(0)).join(', ')})`,
        status: 'info',
        advanced: true,
      },
      // Attribute coverage.
      rowInfo('RGB', cloud.colors !== undefined ? 'Yes' : 'No'),
      rowInfo('Intensity', cloud.intensity !== undefined ? 'Yes' : 'No'),
    );
    // A cloud can carry the classification dimension while every point is still
    // unassigned (ASPRS 0 = never classified, 1 = unclassified). A bare "Yes"
    // there implies a classified cloud that isn't — so report the honest state.
    //
    // v0.5.5 P12 — the coverage percentage (share of visible points with a
    // non-zero class code) merges INTO this row: the old separate
    // "Classification Coverage" diagnostic duplicated the same fact one line
    // below ("Present, unclassified" + "0.0 %" are one statement). Both loops
    // honour a class-subset scope; full scope is byte-identical to counting
    // the whole buffer.
    //
    // "Coverage" counts every non-zero code, which includes ASPRS 1
    // (Unclassified) — so a tile whose points are 95 % code 1 would read as
    // fully classified. The headline therefore also states the code-1 share,
    // over the same visible points, and names the sample once when the buffer
    // is a display sample of the file.
    let classValue = 'No';
    if (cls !== undefined) {
      let anyAssigned = false;
      let nonZero = 0;
      let codeOne = 0;
      for (let i = 0; i < totalN; i++) {
        if (!isVisible(i)) continue;
        const code = cls[i] & 0xff;
        if (code > 1) anyAssigned = true;
        if (code !== 0) nonZero++;
        if (code === 1) codeOne++;
      }
      const pct = (k: number): string => ((k / n) * 100).toFixed(1);
      if (!anyAssigned) {
        classValue = n > 0 ? `Present, unclassified (${pct(nonZero)} % coverage)` : 'Present, unclassified';
      } else if (n > 0) {
        classValue =
          `Yes — codes on ${pct(nonZero)} %, ${pct(codeOne)} % unclassified (code 1)`
          + (strided ? ' of display sample' : '');
      } else {
        classValue = 'Yes';
      }
    }
    rows.push(withScope(rowInfo('Classification', classValue), scope));

    // Header provenance — shown only when the file carried it, labelled by
    // what the header field IS. LAS `system_identifier` names the hardware OR
    // the producing process/organisation, and the File Creation Day/Year is
    // when the file was written, not when the survey was flown.
    const meta = cloud.metadata;
    if (meta?.captureSensor) rows.push(rowInfo('System identifier', meta.captureSensor));
    if (meta?.sourceSoftware) rows.push(rowInfo('Source Software', meta.sourceSoftware));
    if (meta?.captureDate) rows.push(rowInfo('File created', meta.captureDate));
    if (meta?.scannerOrigin) {
      const [sx, sy, sz] = meta.scannerOrigin;
      rows.push(
        rowInfo(
          'Scanner Origin',
          `${sx.toFixed(2)}, ${sy.toFixed(2)}, ${sz.toFixed(2)}`,
        ),
      );
    }

    // Non-fatal anomalies the loader worked around (a skipped E57 scan, a
    // normalised pose quaternion). Shown as warn rows so a partially-loaded
    // file is never presented as a cleanly-loaded one.
    for (const w of meta?.loadWarnings ?? []) rows.push(rowWarn('Load Warning', w));

    // Declared source metadata — the file's own provenance declarations
    // (standard schema fields plus extension-namespace fields), verbatim.
    // Rendered by the Inspector as a collapsible "Source metadata" section
    // with the extension fields under "Extended metadata (file-declared)".
    // Declared, not verified — only rows the file actually declared appear.
    const sm = meta?.sourceMetadata;
    if (sm) {
      const declared = (
        fields: readonly { name: string; value: string }[],
        group: AnalysisRow['group'],
      ): void => {
        for (const f of fields) rows.push({ label: f.name, value: f.value, status: 'info', group });
      };
      declared(sm.standard, 'src-std');
      declared(sm.extensions, 'src-ext');
    }

    // Georeferenced bounding box — the scan's extent in real-world
    // coordinates (local bounds plus the origin subtracted on load). Shown
    // under the Advanced report; survey and topographic work needs absolute
    // coordinates, not the viewer's internal recentred values.
    //
    // The world frame is the SOURCE origin, fixed for the cloud's life. The
    // live origin moves when a layer mounts into a project frame; the reported
    // survey corner must stay in the file's frame regardless. The two coincide
    // today (mounting is off), so this is a no-op that stays correct later.
    const origin = cloud.sourceOrigin;
    const corner = (c: [number, number, number]): string =>
      `${(c[0] + origin[0]).toFixed(3)}, ${(c[1] + origin[1]).toFixed(3)}, ` +
      `${(c[2] + origin[2]).toFixed(3)}`;
    rows.push(
      { label: 'Min corner', value: corner(bounds.min), status: 'info', advanced: true },
      { label: 'Max corner', value: corner(bounds.max), status: 'info', advanced: true },
    );

    // The absolute corners carry an absolute Z, which asserts a vertical
    // reference the reader cannot recover from the number alone. State it,
    // honestly (roadmap P1 #6): a georeferenced scan whose file declares no —
    // or an unrecognised — vertical datum reads "Height (datum unknown)" rather
    // than letting the corner Z pass as a sea-level elevation, mirroring the
    // Inspector's datum-honest Z label (#229) via the same classifier. Shown
    // only when the file carried a CRS: a scan with none has purely local
    // corners and no datum to name. The datum → reference classification is read
    // from the same `ctx` as the extent block (behaviour-identical to the prior
    // direct `verticalReferenceFromDatum` call over these same datum fields), so
    // the report and the inspector can never disagree about what a datum means.
    if (meta?.crs) {
      rows.push({
        label: 'Vertical reference',
        value: heightLabel(ctx.verticalReference),
        status: 'info',
        advanced: true,
      });
    }

    // (v0.5.5 P12 — the separate "Classification Coverage" diagnostic row
    // merged into the main Classification row above.)

    return scope?.kind === 'subset' ? { rows, scope } : { rows };
  },
};
