/**
 * flowPulseContinuityIsolation.test.ts: §17, a flow result is invariant to
 * presentation state.
 *
 * `src/simulation/flowPulse` never imports `src/render`, so nothing in this
 * module tree can even NAME Continuity tier, micro-gap reconstruction,
 * temporal accumulation, EDL, DPR, point size, colour mode, Evidence Lens,
 * camera exposure or presentation sampling. What stands in for "vary
 * presentation state" here is every `DtmGrid` field `runFlowPulse` does NOT
 * read to route flow: per-cell confidence, coverage mode, CRS/datum labels,
 * warnings, source/analysed point tallies, and the grid's own origin. Two
 * DTMs that agree on `z`/`coverage`/`cols`/`rows`/`cellSizeM` but disagree on
 * all of those, as if the same terrain had been re-observed under a
 * different presentation, streaming, or session state upstream, must route
 * identically. `flowFieldDigest` is what a reader compares two runs by (see
 * its module doc), so that is the digest pinned here, not the run id or the
 * wall clock, which already vary between any two runs regardless of
 * presentation and are excluded from the record digest for that reason
 * (`simulationRunRecord.ts`).
 */
import { describe, expect, it } from 'vitest';

import { runFlowPulse, FLOW_PULSE_DEFAULTS, type FlowRunIdentity } from '../src/simulation/flowPulse/flowPulseRunner';
import type { HorizontalScale } from '../src/simulation/flowPulse/dtmFlowGrid';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const scale: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };

/** A 3x3 ramp falling east: no sinks, no flats, one outlet edge. */
function rampDtm(over: Partial<DtmGrid>): DtmGrid {
  const rows = [[3, 2, 1], [3, 2, 1], [3, 2, 1]];
  const w = 3, h = 3, n = w * h;
  const z = new Float32Array(n);
  const coverage = new Uint8Array(n).fill(2); // measured
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = rows[r][c];
  return {
    z, coverage, confidence: new Float32Array(n).fill(50), counts: new Uint32Array(n).fill(1),
    interpDistanceCells: new Float32Array(n), cols: w, rows: h, cellSizeM: 1,
    originH1: 0, originH2: 0, crs: null, verticalDatum: null, coverageMode: 'full',
    sourcePointCount: n, analyzedPointCount: n, meanConfidence: 50, warnings: [],
    ...over,
  } as DtmGrid;
}

const identityA: FlowRunIdentity = {
  layerId: 'session-a', filename: 'a.laz', sourceDigest: 'digest-a',
  analysisInputDigest: 'input-a', terrainCoreDigest: 'core-a', build: 'build-a',
  id: 'run-a', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: 'manifest-a',
};

const identityB: FlowRunIdentity = {
  layerId: 'session-b', filename: 'b.laz', sourceDigest: 'digest-b',
  analysisInputDigest: 'input-b', terrainCoreDigest: 'core-b', build: 'build-b',
  id: 'run-b', generatedAt: '2030-06-15T12:00:00.000Z', processingManifestHead: 'manifest-b',
};

describe('the field digest is invariant to everything a presentation state could vary', () => {
  it('agrees across two DTMs that differ in every field flow routing does not read', () => {
    const baseline = rampDtm({});
    const presentationVaried = rampDtm({
      confidence: new Float32Array(9).fill(12), // different per-cell confidence
      meanConfidence: 12,
      counts: new Uint32Array(9).fill(7), // different measured-return tallies
      coverageMode: 'resident-only', // as if only part of the stream were resident
      sourcePointCount: 99_999,
      analyzedPointCount: 42,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      originH1: 500_000,
      originH2: 4_000_000,
      warnings: ['a warning that only exists in this presentation state'],
      withheldExcluded: true, // the basis differs too, still not part of the field
      withheldExcludedCount: 3,
    });

    const a = runFlowPulse(baseline, scale, FLOW_PULSE_DEFAULTS, identityA);
    const b = runFlowPulse(presentationVaried, scale, FLOW_PULSE_DEFAULTS, identityB);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // The field itself: identical receivers, directions, statuses, upstream counts.
    expect(a.record.result.fieldDigest).toBe(b.record.result.fieldDigest);
    expect(Array.from(a.routed.receiver)).toEqual(Array.from(b.routed.receiver));
    expect(Array.from(a.routed.direction)).toEqual(Array.from(b.routed.direction));
    expect(Array.from(a.accumulation.upstreamCells)).toEqual(Array.from(b.accumulation.upstreamCells));

    // The two records legitimately disagree elsewhere: different identity and
    // different basis, therefore a different overall digest and different
    // limitations. Isolation is a claim about the FIELD, not about the record.
    expect(a.record.digest).not.toBe(b.record.digest);
    expect(a.basis.coverage).not.toBe(b.basis.coverage);
  });

  it('a conditioned run over the same presentation-varied pair still agrees on the field', () => {
    const params = { ...FLOW_PULSE_DEFAULTS, conditioning: 'priority-flood' as const };
    const baseline = rampDtm({});
    const presentationVaried = rampDtm({
      coverageMode: 'sampled', crs: 'EPSG:4326', verticalDatum: 'EGM2008',
      meanConfidence: 5, warnings: ['different presentation warning'],
    });

    const a = runFlowPulse(baseline, scale, params, identityA);
    const b = runFlowPulse(presentationVaried, scale, params, identityB);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.record.result.fieldDigest).toBe(b.record.result.fieldDigest);
  });
});
