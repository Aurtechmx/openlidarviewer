// What these tests would catch:
//
//  - A LAS whose body ends before its declared records opening as complete:
//    no truncation recorded, no warning, coverage read as full.
//  - A partial scan passing the coverage gates that whole-dataset products
//    and interactive tools apply.
//  - A measurement on a scan with no horizontal unit shown in metres, or its
//    confidence line reading "datum resolved".

import { describe, it, expect } from 'vitest';
import { writeLas } from '../src/convert/writeLas';
import { loadLas } from '../src/io/loadLas';
import { truncationOf, truncationText } from '../src/io/truncation';
import { deriveScanFacts } from '../src/process/scanFacts';
import { ProcessService } from '../src/process/ProcessService';
import { runQaChecks } from '../src/qa/qaChecks';
import { layerBasisProvider } from '../src/process/stateProviders';
import { analysedBasisLine } from '../src/terrain/export/analysedBasis';
import { signalsFromLive } from '../src/app/processStudioMount';
import { buildLayerHealth } from '../src/app/layerHealth';
import { confidenceForKind } from '../src/render/measure/measureConfidence';
import { buildMeasureConfidenceContext } from '../src/app/measureConfidenceContext';
import { formatUnitUnverified } from '../src/render/measure/format';

function plane(n: number): Parameters<typeof writeLas>[0] {
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = 500000 + (i % 51) * 0.2; y[i] = 4000000 + Math.floor(i / 51) * 0.2; z[i] = 50; }
  return { count: n, x, y, z };
}

describe('truncated LAS', () => {
  it('keeps the records read and records the shortfall', async () => {
    const bytes = writeLas(plane(2601), { epsg: 32613 }).slice(0, 400);
    const pc = await loadLas(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'las', 'broken.las');
    expect(pc.pointCount).toBe(4);
    expect(truncationOf(pc)).toEqual({ read: 4, declared: 2601 });
    expect(pc.metadata?.loadWarnings).toContain('Truncated: 4 of 2,601 points read');
  });

  it('leaves a complete file unmarked', async () => {
    const bytes = writeLas(plane(100), { epsg: 32613 });
    const pc = await loadLas(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'las');
    expect(truncationOf(pc)).toBeNull();
    expect(pc.metadata?.truncation).toBeUndefined();
  });

  it('reads as partial coverage and fails the whole-dataset gates', () => {
    const raw = signalsFromLive({
      hasStreamingSource: () => false,
      getStreamingPointCount: () => null,
      getActivePointCount: () => 4,
      getResolvedCrs: () => null,
      getPresentClassCodes: () => [],
      getClassificationDerived: () => false,
      getActiveCloudData: () => ({ positions: new Float32Array(12), declaredPointCount: 2601, truncated: true }),
    });
    const facts = deriveScanFacts(raw!);
    expect(facts.coverage).toBe('partial');
    expect(layerBasisProvider(facts)).toMatchObject({ value: 'partial', validity: 'review' });
    expect(runQaChecks(facts).find((c) => c.id === 'COVERAGE')?.status).toBe('review');
    const dsm = ProcessService.fromFacts([facts]).capability('dsm');
    expect(dsm?.reasonCode).toBe('TRUNCATED');
    expect(dsm?.readiness).not.toBe('ready');
    expect(analysedBasisLine({ analysedPointCount: 4, declaredPointCount: 2601, coverage: 'partial', loadStride: null })).toBe(
      '4 of 2,601 points (truncated file); whole-dataset support not claimed',
    );
  });

  it('shows the truncation on the Layer Health loading row', () => {
    const rows = buildLayerHealth({
      name: 'broken.las', crsName: null, crsSource: null, horizontalUnit: null, verticalUnit: null, verticalDatum: null,
      compatibility: null, mounted: true, sourceOrigin: null, frameOffset: null, precisionMm: null, precisionBasis: null,
      streaming: false, residency: { resident: 4, source: 2601, truncated: truncationText({ read: 4, declared: 2601 }) }, soleLayer: true,
    });
    expect(rows.find((r) => r.label === 'Loading')).toMatchObject({ value: 'Truncated: 4 of 2,601 points read', status: 'warn' });
  });
});

describe('unknown horizontal unit', () => {
  it('formats a value without a unit and marks it unverified', () => {
    expect(formatUnitUnverified(10.73712)).toBe('10.737 (unit unverified)');
    expect(formatUnitUnverified(5)).toBe('5 (unit unverified)');
  });

  it('never reads as datum resolved', () => {
    const scene = buildMeasureConfidenceContext(
      { measure: { datumResolved: true, crsKnown: false, geographicCrs: false }, clouds: () => ['c'] },
      null,
    );
    const conf = confidenceForKind('distance', scene);
    expect(conf.label).not.toContain('datum resolved');
    expect(conf.level).toBe('approximate');
    // A known unit with the same facts is unchanged.
    const known = buildMeasureConfidenceContext(
      { measure: { datumResolved: true, crsKnown: true, geographicCrs: false }, clouds: () => ['c'] },
      null,
    );
    expect(known.unitVerified).toBe(true);
    expect(confidenceForKind('distance', known).label).toBe('Viewer measurement · datum resolved');
  });
});
