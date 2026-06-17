/**
 * scanStory.test.ts
 *
 * Exhaustive coverage of the fitness-for-use synthesis: the Dataset Story and
 * the Export Health Check. Pure reductions, so every branch is pinned here.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScanStory,
  buildExportHealth,
  type ScanStoryInputs,
  type StoryProduct,
} from '../src/intelligence/scanStory';

const PRODUCTS: StoryProduct[] = [
  { label: 'Profiles', status: 'Ready' },
  { label: 'Measurements', status: 'Ready' },
  { label: 'DTM/DEM export', status: 'Preview' },
  { label: 'Contours', status: 'Blocked' },
];

/** A clean, georeferenced, fully-analysed Good scan. */
const GOOD: ScanStoryInputs = {
  captureLabel: 'Aerial / airborne ALS',
  pointCount: 15_700_000,
  areaM2: 1_000_000,
  surfaceTier: 'Good',
  products: [
    { label: 'Profiles', status: 'Ready' },
    { label: 'DTM/DEM export', status: 'Ready' },
  ],
  density: 'dense',
  groundVisibility: 'good',
  coverageMode: 'full',
  crsKnown: true,
  datumKnown: true,
  classification: 'source',
};

describe('buildScanStory — headline', () => {
  it('formats capture type, area (km²), and count (M)', () => {
    const s = buildScanStory(GOOD);
    expect(s.headline).toBe('Aerial / airborne ALS — 1.00 km², 15.7M points');
  });

  it('falls back to "Point cloud" and an honest count with no metadata', () => {
    const s = buildScanStory({});
    expect(s.headline).toBe('Point cloud — unknown count');
    expect(s.assessment).toBe('Unknown');
  });

  it('uses hectares and K-points at smaller scales', () => {
    const s = buildScanStory({ areaM2: 50_000, pointCount: 4200 });
    expect(s.headline).toContain('ha');
    expect(s.headline).toContain('4.2K points');
  });

  it('omits the area clause when area is absent or zero', () => {
    expect(buildScanStory({ pointCount: 100, areaM2: 0 }).headline).toBe('Point cloud — 100 points');
  });
});

describe('buildScanStory — product split', () => {
  it('routes products into bestFor / useCaution / notRecommended by status', () => {
    const s = buildScanStory({ ...GOOD, products: PRODUCTS });
    expect(s.bestFor).toEqual(['Profiles', 'Measurements']);
    expect(s.useCaution).toEqual(['DTM/DEM export']);
    expect(s.notRecommended).toEqual(['Contours']);
  });

  it('empty product list yields empty buckets, not crashes', () => {
    const s = buildScanStory({ surfaceTier: 'Good' });
    expect(s.bestFor).toEqual([]);
    expect(s.useCaution).toEqual([]);
    expect(s.notRecommended).toEqual([]);
  });
});

describe('buildScanStory — primary limiter severity order', () => {
  it('Blocked surface dominates everything', () => {
    const s = buildScanStory({ ...GOOD, surfaceTier: 'Blocked', coverageMode: 'resident-only' });
    expect(s.primaryLimiter).toMatch(/surface quality/i);
  });

  it('a streaming preview outranks ground / density / georef', () => {
    const s = buildScanStory({
      ...GOOD,
      surfaceTier: 'Preview',
      coverageMode: 'resident-only',
      groundVisibility: 'poor',
      density: 'sparse',
      crsKnown: false,
    });
    expect(s.primaryLimiter).toMatch(/partial coverage/i);
  });

  it('ground visibility outranks density and georef', () => {
    const s = buildScanStory({
      ...GOOD,
      surfaceTier: 'Limited',
      coverageMode: 'full',
      groundVisibility: 'poor',
      density: 'sparse',
      crsKnown: false,
    });
    expect(s.primaryLimiter).toMatch(/ground visibility/i);
  });

  it('sparse density outranks georef', () => {
    const s = buildScanStory({
      ...GOOD,
      surfaceTier: 'Limited',
      groundVisibility: 'good',
      density: 'sparse',
      crsKnown: false,
    });
    expect(s.primaryLimiter).toMatch(/density/i);
  });

  it('a Good, georeferenced, full scan reports no real limiter', () => {
    expect(buildScanStory(GOOD).primaryLimiter).toMatch(/none/i);
  });

  it('CRS-unknown is the limiter when surface + coverage + density are all fine', () => {
    const s = buildScanStory({ ...GOOD, crsKnown: false });
    expect(s.primaryLimiter).toMatch(/coordinate system/i);
  });
});

describe('buildScanStory — next step + not-established', () => {
  it('streaming preview → re-run after full stream', () => {
    expect(buildScanStory({ ...GOOD, coverageMode: 'sampled' }).nextStep).toMatch(/stream in/i);
  });

  it('CRS unknown → set coordinate system', () => {
    expect(buildScanStory({ ...GOOD, crsKnown: false }).nextStep).toMatch(/coordinate system/i);
  });

  it('a Good scan → validate against control', () => {
    expect(buildScanStory(GOOD).nextStep).toMatch(/ground control/i);
  });

  it('vertical accuracy is ALWAYS listed as not established', () => {
    expect(buildScanStory(GOOD).notEstablished).toContain('Vertical accuracy (never measured in-app)');
  });

  it('adds CRS + datum to not-established when unknown', () => {
    const s = buildScanStory({ ...GOOD, crsKnown: false, datumKnown: false });
    expect(s.notEstablished).toContain('Coordinate system (CRS)');
    expect(s.notEstablished).toContain('Vertical datum');
  });
});

describe('buildExportHealth — verdict', () => {
  it('a clean Good source scan is ready with no blockers', () => {
    const h = buildExportHealth(GOOD);
    expect(h.verdict).toBe('ready');
    expect(h.blockers).toEqual([]);
  });

  it('a derived + resident + CRS-unknown scan is caution with actionable blockers', () => {
    const h = buildExportHealth({
      ...GOOD,
      coverageMode: 'resident-only',
      classification: 'derived',
      classConfidence: 0.42,
      crsKnown: false,
    });
    expect(h.verdict).toBe('caution');
    expect(h.blockers.length).toBeGreaterThan(0);
    expect(h.blockers.some((b) => /heuristic/i.test(b))).toBe(true);
    expect(h.blockers.some((b) => /coordinate system/i.test(b))).toBe(true);
    // The derived row carries its confidence.
    expect(h.rows.find((r) => r.label === 'Classification')?.value).toMatch(/42% confidence/);
  });

  it('a Blocked surface forces a blocked verdict', () => {
    const h = buildExportHealth({ ...GOOD, surfaceTier: 'Blocked' });
    expect(h.verdict).toBe('blocked');
    expect(h.blockers.some((b) => /gate failed/i.test(b))).toBe(true);
  });
});

describe('buildExportHealth — rows', () => {
  it('renders a scan-scope, classification, CRS, datum, density, and products row', () => {
    const labels = buildExportHealth(GOOD).rows.map((r) => r.label);
    expect(labels).toEqual([
      'Scan scope',
      'Classification',
      'Coordinate system',
      'Vertical datum',
      'Point density',
      'Terrain products',
    ]);
  });

  it('source classification reads as good, none as info', () => {
    expect(buildExportHealth(GOOD).rows.find((r) => r.label === 'Classification')?.tier).toBe('good');
    expect(
      buildExportHealth({ ...GOOD, classification: 'none' }).rows.find((r) => r.label === 'Classification')
        ?.tier,
    ).toBe('info');
  });

  it('omits the density row when density is unknown', () => {
    const h = buildExportHealth({ ...GOOD, density: 'unknown' });
    expect(h.rows.some((r) => r.label === 'Point density')).toBe(false);
  });

  it('Good terrain products read Export-ready; undefined reads Not analysed', () => {
    expect(buildExportHealth(GOOD).rows.find((r) => r.label === 'Terrain products')?.value).toBe(
      'Export-ready',
    );
    expect(
      buildExportHealth({ classification: 'none' }).rows.find((r) => r.label === 'Terrain products')?.value,
    ).toBe('Not analysed');
  });
});
