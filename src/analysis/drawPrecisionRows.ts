/**
 * drawPrecisionRows.ts: the scan report rows for the per-draw precision bound
 * (`science/drawPrecision.ts`).
 *
 * The headline row states the bound and its outcome for the view the report
 * was generated at. The advanced row states what is bounded and what is not,
 * so the figure is never read as survey accuracy or as a screen-space error.
 *
 * Pure: no DOM, no three.js.
 */

import type { AnalysisRow } from './ModuleApi';
import { formatPrecisionMetres } from '../geo/inMemoryPrecision';
import type { DrawPrecisionDiagnostic } from '../science/drawPrecision';

const BACKEND_LABEL = { webgpu: 'WebGPU, WGSL f32', webgl2: 'WebGL 2, GLSL highp' } as const;

function headline(d: DrawPrecisionDiagnostic): AnalysisRow {
  const label = 'Draw precision bound';
  if (d.state === 'NOT_TESTED') {
    return { label, value: `Not tested: ${d.reason ?? 'shader contract not verified'}`, status: 'info' };
  }
  if (d.state === 'UNGRADED') {
    return {
      label,
      value: `${(d.boundSourceUnits ?? Number.NaN).toPrecision(3)} (source units) at this view; ${d.reason ?? 'no unit'}, not graded`,
      status: 'info',
    };
  }
  const outcome = d.state === 'PASS' ? 'within' : 'not certified within';
  return {
    label,
    value:
      `${formatPrecisionMetres(d.boundMetres ?? Number.NaN)} at this view, `
      + `${outcome} ${formatPrecisionMetres(d.tauMetres ?? Number.NaN)} (${BACKEND_LABEL[d.backend]})`,
    status: d.state === 'PASS' ? 'info' : 'warn',
  };
}

/** Headline plus the advanced scope row. */
export function drawPrecisionRows(d: DrawPrecisionDiagnostic): AnalysisRow[] {
  const rho = d.tileBasis === 'measured' ? 'measured storage error' : 'worst-case Float32 storage error';
  return [
    headline(d),
    {
      label: 'Draw bound scope',
      value:
        'Upper bound on the eye-space point position before projection, for the declared shader '
        + `expression and round-to-nearest binary32 arithmetic, with ${rho}. `
        + 'Projection, the divide by w, point sprite size and survey accuracy are not covered. '
        + 'Method: A. Urias, "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU".',
      status: 'info',
      advanced: true,
    },
  ];
}
