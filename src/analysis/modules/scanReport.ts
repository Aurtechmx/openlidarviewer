import type { AnalysisModule, AnalysisResult, AnalysisRow } from '../ModuleApi';
import type { PointCloud } from '../../model/PointCloud';

function rowInfo(label: string, value: string): AnalysisRow {
  return { label, value, status: 'info' };
}

function rowWarn(label: string, value: string): AnalysisRow {
  return { label, value, status: 'warn' };
}

export const scanReport: AnalysisModule = {
  id: 'scan-report',
  label: 'Scan Report',

  run(cloud: PointCloud): AnalysisResult {
    const rows: AnalysisRow[] = [];

    // Point count
    const n = cloud.pointCount;
    rows.push(rowInfo('Point Count', `${n}`));

    // Extent
    const bounds = cloud.bounds();
    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[1] - bounds.min[1];
    const height = bounds.max[2] - bounds.min[2];
    rows.push(rowInfo('Width (X)', `${width} m`));
    rows.push(rowInfo('Depth (Y)', `${depth} m`));
    rows.push(rowInfo('Height (Z)', `${height} m`));

    // Footprint area
    const footprintArea = width * depth;

    // Point density
    if (footprintArea <= 0 || n === 0) {
      rows.push(rowWarn('Point Density', 'N/A (degenerate footprint)'));
    } else {
      const density = n / footprintArea;
      rows.push(rowInfo('Point Density', `${density.toFixed(4)} pts/m²`));
    }

    // Estimated point spacing
    if (footprintArea <= 0 || n === 0) {
      rows.push(rowWarn('Est. Point Spacing', 'N/A (degenerate footprint)'));
    } else {
      const spacing = Math.sqrt(footprintArea / n);
      rows.push(rowInfo('Est. Point Spacing', `${spacing.toFixed(4)} m`));
    }

    // Attribute coverage: RGB
    rows.push(rowInfo('Has RGB', cloud.colors !== undefined ? 'Yes' : 'No'));

    // Attribute coverage: intensity
    rows.push(rowInfo('Has Intensity', cloud.intensity !== undefined ? 'Yes' : 'No'));

    // Attribute coverage: classification
    const hasClassification = cloud.classification !== undefined;
    rows.push(rowInfo('Has Classification', hasClassification ? 'Yes' : 'No'));

    // Classification coverage: percent of points with non-zero code
    if (hasClassification && n > 0) {
      let nonZeroCount = 0;
      const cls = cloud.classification!;
      for (let i = 0; i < n; i++) {
        if (cls[i] !== 0) nonZeroCount++;
      }
      const pct = (nonZeroCount / n) * 100;
      rows.push(rowInfo('Classification Coverage', `${pct.toFixed(2)} %`));
    } else {
      rows.push(rowInfo('Classification Coverage', 'N/A'));
    }

    return { rows };
  },
};
