/**
 * tests/crsDetection.test.ts
 *
 * Coverage for CRS Phase C — the aggregator that combines VLR + catalog
 * + override signals into a single ResolvedCrs with provenance.
 *
 * Pins the priority order (override > catalog > VLR > default), the
 * confidence rules (high when signals agree, demoted when they conflict,
 * VLR-completeness ladder), and the conflict flag the Inspector
 * surfaces.
 */

import { describe, it, expect } from 'vitest';
import { detectCrs, type CrsSignals } from '../src/geo/CrsDetection';
import type { CrsInfo } from '../src/io/crs';

/** Build a vlr fixture with sensible defaults. */
function vlrAt(epsg: number, opts: Partial<CrsInfo> = {}): CrsInfo {
  return {
    source: opts.source ?? 'wkt',
    wkt: opts.wkt ?? `PROJCS["EPSG:${epsg}"]`,
    name: opts.name ?? `EPSG:${epsg}`,
    epsg,
    linearUnit: opts.linearUnit ?? 'metre',
    linearUnitToMetres: opts.linearUnitToMetres ?? 1,
    isGeographic: opts.isGeographic ?? false,
  };
}

describe('detectCrs — priority order', () => {
  it('user-override beats every other signal', () => {
    const signals: CrsSignals = {
      vlr: vlrAt(32612, { name: 'WGS 84 / UTM 12N' }),
      catalogEpsg: 26912,
      override: {
        epsg: 4326,
        kind: 'geographic',
        updatedAt: Date.now(),
      },
    };
    const r = detectCrs(signals);
    expect(r.resolved.epsg).toBe(4326);
    expect(r.resolved.source).toBe('user-override');
    expect(r.resolved.userConfirmed).toBe(true);
    expect(r.resolved.confidence).toBe('high');
  });

  it('catalog-tile beats the VLR when no override exists', () => {
    const signals: CrsSignals = {
      vlr: vlrAt(32612),
      catalogEpsg: 26912,
    };
    const r = detectCrs(signals);
    expect(r.resolved.epsg).toBe(26912);
    expect(r.resolved.source).toBe('catalog-tile');
  });

  it('VLR is used when no override or catalog exists', () => {
    const r = detectCrs({ vlr: vlrAt(32612), vlrSource: 'las-vlr' });
    expect(r.resolved.epsg).toBe(32612);
    expect(r.resolved.source).toBe('las-vlr');
  });

  it('defaultEpsg is used when no other signal exists', () => {
    const r = detectCrs({ defaultEpsg: 4978, datasetName: 'tileset.json' });
    expect(r.resolved.epsg).toBe(4978);
    expect(r.resolved.source).toBe('default-assumption');
    expect(r.resolved.confidence).toBe('low');
  });

  it('returns an unknown CRS when no signal at all is present', () => {
    const r = detectCrs({ datasetName: 'bare.ply' });
    expect(r.resolved.kind).toBe('unknown');
    expect(r.resolved.confidence).toBe('none');
    expect(r.resolved.epsg).toBeUndefined();
  });
});

describe('detectCrs — confidence rules', () => {
  it('marks catalog-tile high when it agrees with the VLR', () => {
    const r = detectCrs({
      vlr: vlrAt(32612),
      catalogEpsg: 32612,
    });
    expect(r.resolved.confidence).toBe('high');
    expect(r.conflict).toBe(false);
  });

  it('marks catalog-tile high when no VLR is present', () => {
    const r = detectCrs({ catalogEpsg: 32612 });
    expect(r.resolved.confidence).toBe('high');
    expect(r.conflict).toBe(false);
  });

  it('demotes confidence to medium when catalog and VLR disagree', () => {
    const r = detectCrs({
      vlr: vlrAt(32612),
      catalogEpsg: 26912,
    });
    expect(r.resolved.confidence).toBe('medium');
    expect(r.resolved.epsg).toBe(26912); // catalog still wins
    expect(r.conflict).toBe(true);
  });

  it('VLR with both EPSG + WKT scores high', () => {
    const r = detectCrs({
      vlr: vlrAt(32612, { wkt: 'PROJCS["WGS 84 / UTM 12N",...]' }),
    });
    expect(r.resolved.confidence).toBe('high');
  });

  it('VLR with only an EPSG (no WKT) scores medium', () => {
    const vlr = vlrAt(32612, { wkt: '' });
    const r = detectCrs({ vlr });
    expect(r.resolved.confidence).toBe('medium');
  });

  it('VLR with only a WKT (no EPSG) scores medium', () => {
    const vlr: CrsInfo = {
      source: 'wkt',
      wkt: 'PROJCS["Some unrecognised system"]',
      name: 'Some unrecognised system',
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      isGeographic: false,
    };
    const r = detectCrs({ vlr });
    expect(r.resolved.confidence).toBe('medium');
  });

  it('VLR with neither EPSG nor WKT scores low', () => {
    const vlr: CrsInfo = {
      source: 'wkt',
      name: 'Unknown',
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      isGeographic: false,
    };
    const r = detectCrs({ vlr });
    expect(r.resolved.confidence).toBe('low');
  });
});

describe('detectCrs — override semantics', () => {
  it('an override of `epsg: null` (local mode) carries through', () => {
    const r = detectCrs({
      override: { epsg: null, kind: 'local', updatedAt: 0 },
    });
    expect(r.resolved.kind).toBe('local');
    expect(r.resolved.epsg).toBeUndefined();
    expect(r.resolved.confidence).toBe('high');
    expect(r.resolved.userConfirmed).toBe(true);
  });

  it('an override uses VLR labels when the EPSG matches', () => {
    const r = detectCrs({
      vlr: vlrAt(32612, { name: 'WGS 84 / UTM 12N' }),
      override: { epsg: 32612, kind: 'projected', updatedAt: 0 },
    });
    expect(r.resolved.name).toBe('WGS 84 / UTM 12N');
    expect(r.resolved.wkt).toBeDefined();
  });

  it('an override falls back to the EPSG bareword when EPSG disagrees with VLR', () => {
    const r = detectCrs({
      vlr: vlrAt(32612, { name: 'WGS 84 / UTM 12N' }),
      override: { epsg: 4326, kind: 'geographic', updatedAt: 0 },
    });
    expect(r.resolved.name).toBe('EPSG:4326');
  });
});

describe('detectCrs — conflict flag', () => {
  it('reports conflict=true when catalog and VLR EPSGs both present and disagree', () => {
    const r = detectCrs({
      vlr: vlrAt(32612),
      catalogEpsg: 26912,
    });
    expect(r.conflict).toBe(true);
  });

  it('does NOT report conflict when only one source has an EPSG', () => {
    expect(detectCrs({ catalogEpsg: 32612 }).conflict).toBe(false);
    expect(detectCrs({ vlr: vlrAt(32612) }).conflict).toBe(false);
  });

  it('does NOT report conflict when both sources agree', () => {
    expect(
      detectCrs({ vlr: vlrAt(32612), catalogEpsg: 32612 }).conflict,
    ).toBe(false);
  });
});

describe('detectCrs — provenance trace', () => {
  it('records the considered sources in priority order', () => {
    const r = detectCrs({
      vlr: vlrAt(32612),
      vlrSource: 'copc-meta',
      catalogEpsg: 26912,
      catalogLabel: 'Planetary Computer',
    });
    expect(r.considered).toHaveLength(2);
    expect(r.considered[0].source).toBe('catalog-tile');
    expect(r.considered[1].source).toBe('copc-meta');
    expect(r.considered[0].note).toContain('Planetary');
  });

  it('records the override-only path when override beats everything', () => {
    const r = detectCrs({
      vlr: vlrAt(32612),
      catalogEpsg: 26912,
      override: { epsg: 4326, kind: 'geographic', updatedAt: 0 },
    });
    expect(r.considered).toHaveLength(1);
    expect(r.considered[0].source).toBe('user-override');
  });

  it('records the default-assumption path when nothing else surfaced', () => {
    const r = detectCrs({ defaultEpsg: 4978 });
    expect(r.considered).toHaveLength(1);
    expect(r.considered[0].source).toBe('default-assumption');
  });
});

describe('detectCrs — vlrSource label', () => {
  it('honours an EPT-srs vlrSource', () => {
    const r = detectCrs({
      vlr: vlrAt(32612),
      vlrSource: 'ept-srs',
    });
    expect(r.resolved.source).toBe('ept-srs');
  });

  it('honours a COPC-meta vlrSource', () => {
    const r = detectCrs({
      vlr: vlrAt(32612),
      vlrSource: 'copc-meta',
    });
    expect(r.resolved.source).toBe('copc-meta');
  });

  it('defaults to las-vlr when vlrSource is not specified', () => {
    const r = detectCrs({ vlr: vlrAt(32612) });
    expect(r.resolved.source).toBe('las-vlr');
  });
});
