/**
 * flowPulseLab.test.ts — the Flow Pulse view shows what the runner said.
 *
 * Rendered through the recording DOM stub, as the Dataset Story card is. The
 * view owns no wording of its own about the run, so these tests compare the
 * rendered text against the runner's limitations rather than against copies
 * of them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

beforeAll(installRecordingDom);

const { renderFlowPulseLab, runLabFlowPulse, flowScaleOf } = await import('../src/ui/fieldSimulation/flowPulseLab');
type LabInput = Parameters<typeof runLabFlowPulse>[0] & object;

function dtmOf(rows: readonly (readonly number[])[]): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = rows[r][c];
  return {
    z, coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n),
    counts: new Uint32Array(n), interpDistanceCells: new Float32Array(n),
    cols: w, rows: h, cellSizeM: 1, originH1: 0, originH2: 0, crs: null,
    verticalDatum: null, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, meanConfidence: 1, warnings: [],
  } as DtmGrid;
}

function input(over: Partial<LabInput> = {}, resolved = true): LabInput {
  return {
    result: { dtm: dtmOf([[3, 2, 1], [3, 2, 1]]), horizontalScaleResolved: resolved } as never,
    isGeographic: false, worldOriginY: null, resolvedUnitToMetres: resolved ? 1 : null,
    layerId: 'scan-1', filename: 'site', ...over,
  };
}

const textOf = (node: HTMLElement) => (node as unknown as RecordingEl).textContent;

describe('a completed run', () => {
  it('shows every limitation the runner produced, verbatim', () => {
    const outcome = runLabFlowPulse(input({}, false));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.limitations.length).toBeGreaterThan(1);
    const text = textOf(renderFlowPulseLab(outcome));
    for (const sentence of outcome.limitations) expect(text).toContain(sentence);
  });

  it('withholds square metres when the horizontal scale is unresolved', () => {
    const outcome = runLabFlowPulse(input({}, false));
    const text = textOf(renderFlowPulseLab(outcome));
    expect(text).not.toContain('m²');
    expect(text).toContain('Withheld: the horizontal scale');
    // Cell counts survive, because direction does not depend on the unit.
    expect(text).toContain('3 cells');
  });

  it('reports square metres once the scale is resolved', () => {
    const text = textOf(renderFlowPulseLab(runLabFlowPulse(input())));
    expect(text).toContain('m²');
    expect(text).not.toContain('Withheld: the horizontal scale');
  });
});

describe('a refusal is a plain message', () => {
  it('names the missing analysis when no surface is on the panel', () => {
    const outcome = runLabFlowPulse(null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const text = textOf(renderFlowPulseLab(outcome));
    expect(text).toContain('did not run');
    expect(text).toContain(outcome.reason);
  });

  it('refuses a geographic frame whose latitude cannot be derived', () => {
    const outcome = runLabFlowPulse(input({ isGeographic: true, worldOriginY: Number.NaN }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('UNITS_UNRESOLVED');
    expect(textOf(renderFlowPulseLab(outcome))).toContain(outcome.reason);
  });
});

describe('a geographic frame with no world origin', () => {
  it.each([null, undefined])('refuses with UNITS_UNRESOLVED when the origin is %s', (origin) => {
    const outcome = runLabFlowPulse(input({ isGeographic: true, worldOriginY: origin as never }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('UNITS_UNRESOLVED');
    expect(textOf(renderFlowPulseLab(outcome))).toContain(outcome.reason);
  });

  it('still runs a projected frame with no origin', () => {
    expect(runLabFlowPulse(input({ worldOriginY: null })).ok).toBe(true);
  });
});

describe('the frame the run reads', () => {
  it('takes latitude from the grid centre in world coordinates, as the analysis did', () => {
    const scale = flowScaleOf(input({ isGeographic: true, worldOriginY: 40 }));
    expect(scale.latitudeDeg).toBe(41); // 40 + 0 + (2 rows / 2) * 1
    expect(scale.resolved).toBe(true);
  });

  it('leaves a projected frame without a latitude', () => {
    expect(flowScaleOf(input()).latitudeDeg).toBeNull();
  });
});
