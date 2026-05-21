import type { AnalysisModule, AnalysisResult, AnalysisRow } from '../ModuleApi';
import type { PointCloud } from '../../model/PointCloud';

function rowInfo(label: string, value: string): AnalysisRow {
  return { label, value, status: 'info' };
}

function rowWarn(label: string, value: string): AnalysisRow {
  return { label, value, status: 'warn' };
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

  run(cloud: PointCloud): AnalysisResult {
    const rows: AnalysisRow[] = [];

    const n = cloud.pointCount;
    rows.push(rowInfo('Point Count', n.toLocaleString('en-US')));

    // Extent — rounded to a tenth of a metre.
    const bounds = cloud.bounds();
    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[1] - bounds.min[1];
    const height = bounds.max[2] - bounds.min[2];
    rows.push(rowInfo('Width', `${width.toFixed(1)} m`));
    rows.push(rowInfo('Depth', `${depth.toFixed(1)} m`));
    rows.push(rowInfo('Height', `${height.toFixed(1)} m`));

    const footprintArea = width * depth;

    // Point density.
    if (footprintArea <= 0 || n === 0) {
      rows.push(rowWarn('Density', 'N/A (degenerate footprint)'));
    } else {
      rows.push(rowInfo('Density', `${(n / footprintArea).toFixed(1)} pts/m²`));
    }

    // Estimated point spacing.
    if (footprintArea <= 0 || n === 0) {
      rows.push(rowWarn('Spacing', 'N/A (degenerate footprint)'));
    } else {
      rows.push(rowInfo('Spacing', formatLength(Math.sqrt(footprintArea / n))));
    }

    // Attribute coverage.
    rows.push(rowInfo('RGB', cloud.colors !== undefined ? 'Yes' : 'No'));
    rows.push(rowInfo('Intensity', cloud.intensity !== undefined ? 'Yes' : 'No'));
    const hasClassification = cloud.classification !== undefined;
    rows.push(rowInfo('Classification', hasClassification ? 'Yes' : 'No'));

    // Classification coverage — the share of points with a non-zero class
    // code. A diagnostic, shown under "Advanced report".
    let coverage = 'N/A';
    if (hasClassification && n > 0) {
      const cls = cloud.classification!;
      let nonZero = 0;
      for (let i = 0; i < n; i++) {
        if (cls[i] !== 0) nonZero++;
      }
      coverage = `${((nonZero / n) * 100).toFixed(1)} %`;
    }
    rows.push({ label: 'Classification Coverage', value: coverage, status: 'info', advanced: true });

    return { rows };
  },
};
