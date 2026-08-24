/**
 * unknownSourceTotal.test.ts
 *
 * A streaming source whose total point count is unknown, across every surface
 * that states one.
 *
 * `StreamingSource.sourcePointCount` was a number, which is correct for COPC
 * and EPT: both read the total from a header. A 3D Tiles tileset names content
 * URIs and not point totals, and the only route to a total is fetching every
 * tile, which is precisely what a streaming source must not do to open. The
 * field is therefore `number | null`.
 *
 * Null is not zero. Zero is a real answer meaning an empty source; null means
 * the question has no answer yet, and a surface that coerces one to the other
 * reports an empty scan, a density of zero, or a capture type inferred from a
 * density nothing measured. These tests are the coercion check: every assertion
 * below is that some surface said "unknown" or said nothing, rather than
 * printing a figure it does not have.
 */

import { describe, it, expect } from 'vitest';
import { streamingExtentRows } from '../src/analysis/streamingExtentRows';
import { footprintMetres } from '../src/report/reportFootprint';
import { buildDatasetSummary, type MetadataInputs } from '../src/report/ReportMetadataSection';
import { streamingProgress } from '../src/ui/StreamingPanel';
import { signalsForStreamingCloud } from '../src/diagnostics/provenanceSignals';
import type { SpatialContext } from '../src/geo/SpatialContext';

const HEADER = {
  min: [0, 0, 0] as readonly [number, number, number],
  max: [100, 200, 10] as readonly [number, number, number],
};

const METRIC_CONTEXT = {
  linearUnitKnown: true,
  linearUnitToMetres: 1,
  verticalUnitToMetres: 1,
} as unknown as SpatialContext;

describe('streaming extent rows', () => {
  it('drops density and spacing when the source has no total', () => {
    const { rows } = streamingExtentRows(HEADER, METRIC_CONTEXT, null);
    expect(rows.map((r: { label: string }) => r.label)).toEqual(['Width', 'Depth', 'Height']);
  });

  it('still states the extent, which does not depend on a count', () => {
    const { rows } = streamingExtentRows(HEADER, METRIC_CONTEXT, null);
    expect(rows.find((r: { label: string; value: string }) => r.label === 'Width')?.value).toBe('100.0 m');
  });

  it('reports density as usual for a source that knows its total', () => {
    const { rows } = streamingExtentRows(HEADER, METRIC_CONTEXT, 200_000);
    expect(rows.map((r: { label: string }) => r.label)).toContain('Density');
    expect(rows.find((r: { label: string; value: string }) => r.label === 'Density')?.value).toBe('10.0 pts/m²');
  });

  it('is not the same as a source that reports zero points', () => {
    // Zero is a real answer, and it also yields no density, but through the
    // count rather than through its absence. The two must not be conflated in
    // the source type even where the row set happens to match.
    const zero = streamingExtentRows(HEADER, METRIC_CONTEXT, 0);
    const unknown = streamingExtentRows(HEADER, METRIC_CONTEXT, null);
    expect(zero.rows.map((r: { label: string }) => r.label)).toEqual(unknown.rows.map((r: { label: string }) => r.label));
  });
});

describe('report footprint', () => {
  it('yields no density figure without a total', () => {
    const fp = footprintMetres({
      extentX: 100, extentY: 200, extentZ: 10,
      pointCount: null,
      linearUnitToMetres: 1, verticalUnitToMetres: 1, linearUnitKnown: true, zUp: true,
    });
    expect(fp.unitStatus).toBe('confirmed');
    if (fp.unitStatus !== 'confirmed') throw new Error('expected a confirmed unit');
    expect(Number.isNaN(fp.densityPerM2)).toBe(true);
  });

  it('yields one when the total is known', () => {
    const fp = footprintMetres({
      extentX: 100, extentY: 200, extentZ: 10,
      pointCount: 200_000,
      linearUnitToMetres: 1, verticalUnitToMetres: 1, linearUnitKnown: true, zUp: true,
    });
    if (fp.unitStatus !== 'confirmed') throw new Error('expected a confirmed unit');
    expect(fp.densityPerM2).toBeCloseTo(10, 9);
  });
});

describe('report metadata', () => {
  const base: MetadataInputs = {
    fileName: 'tileset.json',
    format: '3D Tiles',
    sourcePointCount: null,
    width: 100, depth: 200, height: 10,
    density: Number.NaN,
    hasRgb: true, hasIntensity: false, hasClassification: false,
  };

  it('prints Unknown rather than a zero for Points', () => {
    const rows = buildDatasetSummary(base);
    const points = rows.find((r: { label: string; value: string }) => r.label === 'Points');
    expect(points?.value).toMatch(/Unknown/);
    expect(points?.value).not.toMatch(/^0$/);
  });

  it('prints the figure when there is one', () => {
    const rows = buildDatasetSummary({ ...base, sourcePointCount: 1_234_567 });
    expect(rows.find((r: { label: string; value: string }) => r.label === 'Points')?.value).not.toMatch(/Unknown/);
  });

  it('states residency without a percentage of an unknown total', () => {
    const rows = buildDatasetSummary({
      ...base,
      streamingResident: { points: 1_000_000, nodes: 12, totalNodes: 40 },
    });
    const loaded = rows.find((r: { label: string; value: string }) => r.label === 'Loaded');
    expect(loaded?.value).toMatch(/source total unknown/);
    expect(loaded?.value).not.toMatch(/%/);
  });

  it('gives the percentage when the total is known', () => {
    const rows = buildDatasetSummary({
      ...base,
      sourcePointCount: 4_000_000,
      streamingResident: { points: 1_000_000, nodes: 12, totalNodes: 40 },
    });
    expect(rows.find((r: { label: string; value: string }) => r.label === 'Loaded')?.value).toMatch(/25%/);
  });
});

describe('streaming panel progress', () => {
  const status = {
    loadedNodes: 12, knownNodes: 40,
    displayedPoints: 1_000_000, sourcePoints: null,
    cacheBytes: 0,
  };

  it('shows a question mark for the total rather than 0.0M', () => {
    const p = streamingProgress(status);
    expect(p.pointsLabel).toBe('1.0M / ? pts');
  });

  it('keeps the resident figure visible, which is always known', () => {
    expect(streamingProgress(status).pointsLabel).toMatch(/^1\.0M/);
  });

  it('still drives the node progress bar, which does not need a point total', () => {
    const p = streamingProgress(status);
    expect(p.determinate).toBe(true);
    expect(p.fraction).toBeCloseTo(12 / 40, 9);
  });
});

describe('provenance signals', () => {
  const cloud = {
    kind: '3dtiles',
    sourcePointCount: null,
    dataBounds: () => [0, 0, 0, 100, 200, 10] as const,
    crs: () => null,
  };

  it('computes no density from a total the source never gave', () => {
    const signals = signalsForStreamingCloud(cloud as never);
    expect(signals.densityPerSqM).toBeUndefined();
  });

  it('makes no point-count claim, so no capture type can be inferred from one', () => {
    // Every reader of `pointCount` gates on `> 0`, so an unknown total makes no
    // claim. The assertion is that it did not arrive as a plausible figure.
    const signals = signalsForStreamingCloud(cloud as never);
    expect(signals.pointCount).toBe(0);
    expect(signals.pointCount).not.toBeGreaterThan(0);
  });

  it('still reports the extent, which comes from the bounds and not the count', () => {
    const signals = signalsForStreamingCloud(cloud as never);
    expect(signals.extent?.[0]).toBeCloseTo(100, 9);
  });
});
