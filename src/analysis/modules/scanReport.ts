import type { AnalysisModule, AnalysisResult, AnalysisRow, RunOptions } from '../ModuleApi';
import type { PointCloud } from '../../model/PointCloud';
import type { ClassScope } from '../../render/class/classScope';

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
  if (scope && scope.kind === 'subset') row.scope = scope;
  return row;
}

/** Format a length in metres — centimetres below a metre, for readability. */
function formatLength(metres: number): string {
  return metres < 1 ? `${(metres * 100).toFixed(1)} cm` : `${metres.toFixed(2)} m`;
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
      scope && scope.kind === 'subset' && cloud.classification !== undefined
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
      const pos = cloud.positions;
      for (let i = 0; i < totalN; i++) {
        if (!isVisible(i)) continue;
        n++;
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
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
    const strided = subset === null && declaredN !== undefined && declaredN > n;
    const reportedN = strided ? (declaredN as number) : n;

    rows.push(withScope(rowInfo('Point Count', reportedN.toLocaleString('en-US')), scope));
    if (strided) {
      // Don't hide the sampling: name the subset actually held in memory.
      rows.push(rowInfo('Loaded', `${n.toLocaleString('en-US')} (display sample)`));
    }

    // Extent — bounds are in the source CRS's native linear units (feet for a
    // state-plane-feet cloud), so convert to metres before reporting "m" /
    // "pts/m²" / spacing. Horizontal spans use linearUnitToMetres; height uses
    // the vertical unit when the CRS declares one separately. metre / CRS-less
    // clouds resolve to factor 1 — byte-identical to before.
    const mpu = cloud.metadata?.crs?.linearUnitToMetres ?? 1;
    const vmpu = cloud.metadata?.crs?.verticalUnitToMetres ?? mpu;
    const width = (maxX - minX) * mpu;
    const depth = (maxY - minY) * mpu;
    const height = (maxZ - minZ) * vmpu;
    rows.push(withScope(rowInfo('Width', `${width.toFixed(1)} m`), scope));
    rows.push(withScope(rowInfo('Depth', `${depth.toFixed(1)} m`), scope));
    rows.push(withScope(rowInfo('Height', `${height.toFixed(1)} m`), scope));

    const footprintArea = width * depth;

    // Point density — over the file's true count (back-scaled when strided).
    if (footprintArea <= 0 || reportedN === 0) {
      rows.push(withScope(rowWarn('Density', 'N/A (degenerate footprint)'), scope));
    } else {
      rows.push(withScope(rowInfo('Density', `${(reportedN / footprintArea).toFixed(1)} pts/m²`), scope));
    }

    // Estimated point spacing.
    if (footprintArea <= 0 || reportedN === 0) {
      rows.push(withScope(rowWarn('Spacing', 'N/A (degenerate footprint)'), scope));
    } else {
      rows.push(withScope(rowInfo('Spacing', formatLength(Math.sqrt(footprintArea / reportedN))), scope));
    }

    // Attribute coverage.
    rows.push(rowInfo('RGB', cloud.colors !== undefined ? 'Yes' : 'No'));
    rows.push(rowInfo('Intensity', cloud.intensity !== undefined ? 'Yes' : 'No'));
    // A cloud can carry the classification dimension while every point is still
    // unassigned (ASPRS 0 = never classified, 1 = unclassified). A bare "Yes"
    // there implies a classified cloud that isn't — so report the honest state.
    let classValue = 'No';
    if (cls !== undefined) {
      let anyAssigned = false;
      for (let i = 0; i < totalN; i++) {
        if ((cls[i] & 0xff) > 1) { anyAssigned = true; break; }
      }
      classValue = anyAssigned ? 'Yes' : 'Present, unclassified';
    }
    rows.push(rowInfo('Classification', classValue));

    // Capture provenance — shown only when the file header carried it.
    const meta = cloud.metadata;
    if (meta?.captureSensor) rows.push(rowInfo('Capture Sensor', meta.captureSensor));
    if (meta?.sourceSoftware) rows.push(rowInfo('Source Software', meta.sourceSoftware));
    if (meta?.captureDate) rows.push(rowInfo('Captured', meta.captureDate));
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
      for (const f of sm.standard) {
        rows.push({ label: f.name, value: f.value, status: 'info', group: 'source-standard' });
      }
      for (const f of sm.extensions) {
        rows.push({ label: f.name, value: f.value, status: 'info', group: 'source-extension' });
      }
    }

    // Georeferenced bounding box — the scan's extent in real-world
    // coordinates (local bounds plus the origin subtracted on load). Shown
    // under the Advanced report; survey and topographic work needs absolute
    // coordinates, not the viewer's internal recentred values.
    const origin = cloud.origin;
    const corner = (c: [number, number, number]): string =>
      `${(c[0] + origin[0]).toFixed(3)}, ${(c[1] + origin[1]).toFixed(3)}, ` +
      `${(c[2] + origin[2]).toFixed(3)}`;
    rows.push({ label: 'Min corner', value: corner(bounds.min), status: 'info', advanced: true });
    rows.push({ label: 'Max corner', value: corner(bounds.max), status: 'info', advanced: true });

    // Classification coverage — the share of points with a non-zero class
    // code. A diagnostic, shown under "Advanced report". Full scope counts
    // over the whole buffer (byte-identical to the legacy loop, since the
    // visible count `n` equals the buffer length); subset scope counts only
    // the visible points, against the visible count as the denominator.
    let coverage = 'N/A';
    if (cls !== undefined && n > 0) {
      const clsBuf = cloud.classification!;
      let nonZero = 0;
      for (let i = 0; i < totalN; i++) {
        if (!isVisible(i)) continue;
        if (clsBuf[i] !== 0) nonZero++;
      }
      coverage = `${((nonZero / n) * 100).toFixed(1)} %`;
    }
    rows.push(
      withScope(
        { label: 'Classification Coverage', value: coverage, status: 'info', advanced: true },
        scope,
      ),
    );

    return scope && scope.kind === 'subset' ? { rows, scope } : { rows };
  },
};
