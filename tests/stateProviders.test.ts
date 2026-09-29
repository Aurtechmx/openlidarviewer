import { describe, expect, it } from 'vitest';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { deriveScanFacts } from '../src/process/scanFacts';
import {
  datasetNameProvider,
  horizontalCrsProvider,
  layerBasisProvider,
  reviewStateProvider,
  verticalReferenceProvider,
  VERTICAL_UNKNOWN,
} from '../src/process/stateProviders';

/** Deep-freeze so any write by a provider throws in strict mode. */
function freeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o as object).forEach(freeze);
    Object.freeze(o);
  }
  return o;
}

const feet: ResolvedCrs = freeze({
  kind: 'projected',
  name: 'NAD83 / Texas Central (ftUS)',
  epsg: 2277,
  linearUnit: 'us-survey-foot',
  linearUnitToMetres: 1200 / 3937,
  source: 'las-evlr',
  confidence: 'high',
  userConfirmed: false,
  verticalEpsg: 5703,
  verticalDatum: 'NAVD88',
});

const unknownVertical: ResolvedCrs = freeze({
  kind: 'projected',
  name: 'WGS 84 / UTM zone 14N',
  epsg: 32614,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
});

describe('state strip providers', () => {
  it('dataset name: streaming source wins, then the active cloud, else none', () => {
    expect(datasetNameProvider(freeze({ streamingName: 'site.copc.laz', activeCloudName: 'a.las' }))).toEqual({
      value: 'site.copc.laz', source: 'streaming-source', validity: 'info',
    });
    expect(datasetNameProvider({ streamingName: null, activeCloudName: 'a.las' })?.value).toBe('a.las');
    expect(datasetNameProvider({ streamingName: null, activeCloudName: null })).toBeNull();
  });

  it('feet unit: returns the context unit and EVLR source unchanged', () => {
    const ctx = freeze(spatialContextFrom(feet));
    const f = horizontalCrsProvider(ctx, feet);
    expect(f.value).toEqual({
      crsName: ctx.crsName, epsg: 2277, linearUnit: 'us-survey-foot', linearUnitKnown: ctx.linearUnitKnown,
    });
    expect(f.source).toBe('las-evlr');
    expect(f.validity).toBe(ctx.metricSeverity === 'ok' ? 'measured' : ctx.metricSeverity === 'block' ? 'blocked' : 'review');
  });

  it('no CRS: unresolved source and the context fail-closed values', () => {
    const ctx = freeze(spatialContextFrom(null));
    const f = horizontalCrsProvider(ctx, null);
    expect(f.source).toBe('unresolved');
    expect(f.value.linearUnitKnown).toBe(false);
    expect(f.validity).not.toBe('measured');
  });

  it('unknown vertical: says Vertical: unknown and asks for review', () => {
    const ctx = freeze(spatialContextFrom(unknownVertical));
    const v = verticalReferenceProvider(ctx);
    expect(v.value.label).toBe(VERTICAL_UNKNOWN);
    expect(v.value.reference).toBe(ctx.verticalReference);
    expect(v.validity).toBe('review');
  });

  it('known vertical: carries the datum from the context', () => {
    const ctx = freeze(spatialContextFrom(feet));
    const v = verticalReferenceProvider(ctx);
    expect(v.value.datum).toBe(ctx.verticalDatum);
    expect(v.value.epsg).toBe(ctx.verticalEpsg);
    if (ctx.verticalReferenceKnown) expect(v.validity).toBe('measured');
  });

  it('resident-only: returns the coverage deriveScanFacts settled on', () => {
    const facts = freeze(deriveScanFacts({ kind: 'streaming' }));
    expect(layerBasisProvider(facts)).toEqual({ value: 'resident-only', source: 'scan-facts', validity: 'preview' });
    expect(layerBasisProvider(freeze(deriveScanFacts({ kind: 'static', coverage: 'sampled' })))?.value).toBe('sampled');
    expect(layerBasisProvider(freeze(deriveScanFacts({})))?.validity).toBe('measured');
    expect(layerBasisProvider(null)).toBeNull();
  });

  it('stale: counts stale results and review/blocked rows, worst glyph first', () => {
    const rows = freeze([
      { id: 'terrain' as const, status: 'ready' as const },
      { id: 'observatory' as const, status: 'review' as const },
    ]);
    const results = freeze([
      { id: 'terrain:dtm', status: 'stale' as const },
      { id: 'measure:1', status: 'ready' as const },
    ]);
    const r = reviewStateProvider(rows, results);
    expect(r.value.count).toBe(2);
    expect(r.validity).toBe('review');
    const withBlocked = reviewStateProvider([...rows, { id: 'range', status: 'blocked' }], results);
    expect(withBlocked.validity).toBe('blocked');
    expect(reviewStateProvider([], []).value.count).toBe(0);
    expect(reviewStateProvider([], []).validity).toBe('measured');
  });
});
