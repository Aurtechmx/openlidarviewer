/**
 * reportFindings.test.ts
 *
 * Pins the honest synthesis in `buildInspectionSummary`:
 *   - all-returns density is never graded against a USGS QL (pulse-density)
 *     floor; the ungraded context bar appears only when the classifier has
 *     itself cited QL literature (airborne-ALS) — never for TLS / phone /
 *     unknown / no-provenance scans;
 *   - vertical accuracy is ALWAYS reported unmeasured;
 *   - the class-filter caveat surfaces when a filter was active;
 *   - the density bar is present iff the QL comparison applies.
 */

import { describe, it, expect } from 'vitest';
import { buildInspectionSummary } from '../src/report/ReportFindings';
import type { MetadataInputs } from '../src/report/ReportMetadataSection';
import type { ReportProvenanceFingerprint } from '../src/report/types';

function meta(overrides: Partial<MetadataInputs> = {}): MetadataInputs {
  return {
    fileName: 'scan.copc.laz',
    format: 'COPC',
    sourcePointCount: 15_680_312,
    width: 1000,
    depth: 1000,
    height: 200,
    density: 16,
    hasRgb: false,
    hasIntensity: true,
    hasClassification: true,
    crsName: 'EPSG:32612 — WGS 84 / UTM 12N',
    crsUnit: 'metre',
    ...overrides,
  };
}

/** Airborne-ALS provenance — carries USGS QL-labelled density bounds. */
function alsProvenance(): ReportProvenanceFingerprint {
  return {
    label: 'Aerial / airborne LiDAR (ALS)',
    confidence: 'medium',
    signals: ['Streaming format: COPC'],
    bounds: [
      { label: 'Typical density (USGS QL2)', value: '>= 2 pts/m^2', source: 'Lohani & Ghosh 2017 §6' },
      { label: 'Typical density (USGS QL1)', value: '>= 8 pts/m^2', source: 'Lohani & Ghosh 2017 §6' },
    ],
    disclaimer: 'Expected ranges, not guarantees.',
  };
}

/** TLS provenance — no USGS QL literature. */
function tlsProvenance(): ReportProvenanceFingerprint {
  return {
    label: 'Terrestrial Laser Scan (TLS)',
    confidence: 'medium',
    signals: ['High density, small extent'],
    bounds: [{ label: 'Typical accuracy', value: '± 2 mm', source: 'Vendor spec' }],
    disclaimer: 'Expected ranges, not guarantees.',
  };
}

function find(summary: ReturnType<typeof buildInspectionSummary>, label: string) {
  return summary.findings.find((f) => f.label === label);
}

describe('buildInspectionSummary — density tier gating', () => {
  it('never grades all-returns density against a USGS QL floor (pulse density is not recorded)', () => {
    for (const d of [16, 4, 1]) {
      const s = buildInspectionSummary(meta({ density: d }), alsProvenance());
      const f = find(s, 'Point density (all returns)');
      expect(f?.tier).toBe('info');
      expect(f?.detail).toBe(
        `All-returns density ${d.toFixed(1)} pts/m² over the bounding-box footprint. ` +
          'USGS QL floors are defined on nominal pulse density, which this file does not record; not evaluated.',
      );
      expect(f?.detail).not.toMatch(/at or above|below the/i);
    }
  });

  it('keeps the pulse-density floor bar as ungraded context for airborne ALS', () => {
    const s = buildInspectionSummary(meta({ density: 16 }), alsProvenance());
    expect(s.densityBar?.caption).toBe('USGS pulse-density floors (context, not graded)');
    expect(s.densityBar?.thresholds.map((t) => t.label)).toEqual(['QL2', 'QL1']);
  });



  it('does NOT apply QL tiers for TLS (no QL literature cited)', () => {
    const s = buildInspectionSummary(meta({ density: 16 }), tlsProvenance());
    const d = find(s, 'Point density (all returns)');
    expect(d?.tier).toBe('info');
    expect(d?.detail).toMatch(/No capture-type density standard/);
    expect(d?.source).toBeUndefined();
    expect(s.densityBar).toBeUndefined();
  });

  it('does NOT apply QL tiers when there is no provenance', () => {
    const s = buildInspectionSummary(meta({ density: 16 }));
    expect(find(s, 'Point density (all returns)')?.tier).toBe('info');
    expect(s.densityBar).toBeUndefined();
  });

  it('reports density unknown when not finite', () => {
    const s = buildInspectionSummary(meta({ density: Number.NaN }), alsProvenance());
    const d = find(s, 'Point density (all returns)');
    expect(d?.value).toBe('—');
    expect(d?.tier).toBe('unknown');
    expect(s.densityBar).toBeUndefined();
  });
});

describe('buildInspectionSummary — honesty invariants', () => {
  it('always reports vertical accuracy as unmeasured', () => {
    for (const prov of [undefined, alsProvenance(), tlsProvenance()]) {
      const s = buildInspectionSummary(meta(), prov);
      const v = find(s, 'Vertical accuracy');
      expect(v?.value).toBe('—');
      expect(v?.tier).toBe('unknown');
      expect(v?.detail).toBe(
        'Not evaluated in this report. A hold-out RMSEz appears in the Terrain report when ' +
          'terrain analysis has run; neither replaces independent ground-control checkpoints.',
      );
      expect(v?.detail).not.toMatch(/1\.96/);
    }
  });

  it('always emits at least the validation caveat', () => {
    const s = buildInspectionSummary(meta());
    expect(s.caveats.length).toBeGreaterThanOrEqual(1);
    expect(s.caveats.join(' ')).toMatch(/ground-control validation/i);
  });

  it('surfaces the class-filter caveat when a filter was active', () => {
    const s = buildInspectionSummary(
      meta({ classScopeNote: 'Low vegetation · 1 of 5 classes' }),
      alsProvenance(),
    );
    expect(s.caveats.some((c) => /class filter was active/i.test(c))).toBe(true);
    expect(s.caveats.some((c) => /full-cloud/i.test(c))).toBe(true);
  });

  it('flags a missing CRS as a caution', () => {
    const s = buildInspectionSummary(meta({ crsName: undefined }));
    const g = find(s, 'Georeference');
    expect(g?.tier).toBe('caution');
    expect(g?.value).toMatch(/No CRS/);
  });

  it('states a declared CRS as a fact (info), not a met threshold', () => {
    const s = buildInspectionSummary(meta());
    expect(find(s, 'Georeference')?.tier).toBe('info');
    expect(s.findings.some((f) => f.tier === 'met')).toBe(false);
  });

  it('names the extent as a bounding box and the count as the file record count', () => {
    const s = buildInspectionSummary(meta());
    const e = find(s, 'Bounding-box extent');
    expect(e?.value).toBe('100.0 ha (not surveyed area)');
    expect(e?.detail).toBe('15.7 M points delivered (file record count).');
    expect(find(s, 'Coverage')).toBeUndefined();
  });

  it('flags a missing classification channel as a caution', () => {
    const s = buildInspectionSummary(meta({ hasClassification: false }));
    expect(find(s, 'Attributes')?.tier).toBe('caution');
  });

  it('headline names the capture type and scale', () => {
    const s = buildInspectionSummary(meta(), alsProvenance());
    expect(s.headline).toMatch(/Aerial \/ airborne LiDAR/);
    expect(s.headline).toMatch(/ha/);
    expect(s.headline).toMatch(/M points/);
  });
});

describe('buildInspectionSummary — density states the threshold, not the quality level', () => {
  const detail = (density: number): string =>
    find(buildInspectionSummary(meta({ density }), alsProvenance()), 'Point density (all returns)')!.detail!;

  it('never reports the scan as meeting a USGS quality level', () => {
    for (const d of [16, 4, 1]) {
      expect(detail(d)).not.toMatch(/Meets USGS QL\d\b/);
      expect(detail(d)).not.toMatch(/Below USGS QL\d\b/);
    }
  });

  it('states the basis (all returns over the bounding box) on every density row', () => {
    for (const d of [16, 4, 1]) expect(detail(d)).toMatch(/over the bounding-box footprint/);
    const s = buildInspectionSummary(meta({ density: 16 }), tlsProvenance());
    expect(find(s, 'Point density (all returns)')?.detail).toMatch(/over the bounding-box footprint/);
  });
});
