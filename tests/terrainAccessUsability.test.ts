/**
 * terrainAccessUsability.test.ts — the Terrain Access Lab's reader-facing
 * wording and controls: the cost drivers and the evidence split on the run
 * card, the named top reason on the "no eligible cell" refusal, the
 * confidence hint and policy tooltips, square grid cells, one set of bucket
 * names, hint wiring on the inputs, the inspect mode's name, export gating
 * and the route GeoJSON frame label.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';

beforeAll(() => {
  installRecordingDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement = class HTMLInputElement {};
});

const lab = await import('../src/ui/fieldSimulation/terrainAccessLab');
const resultGrid = await import('../src/ui/fieldSimulation/terrainAccessResultGrid');
const explain = await import('../src/simulation/terrainAccess/terrainAccessExplain');
const cursor = await import('../src/simulation/terrainAccess/terrainAccessGridCursor');
const { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } = await import('../src/simulation/terrainAccess/terrainAccessRunner');
const { prepareTerrainAccessPreview } = await import('../src/simulation/terrainAccess/terrainAccessPreview');
const { buildTerrainAccessPackage, routeFrameLines } = await import('../src/export/terrainAccessPackage');
const { extractEntry } = await import('./helpers/zipReader');
const { buildDemPackage } = await import('../src/terrain/export/demPackage');
const { demResultAround, DEM_PKG_OPTS } = await import('./helpers/demPackageFixture');
const { placedWorldOrigin } = await import('../src/terrain/canonicalFrame');

const rec = (n: unknown): RecordingEl => n as RecordingEl;

function dtmOf(cols: number, rows: number, confidence: number): DtmGrid {
  const n = cols * rows;
  return {
    z: new Float32Array(n), coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(confidence),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, withheldExcluded: true, meanConfidence: confidence, warnings: [],
  } as DtmGrid;
}

const RESOLVED: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };

const profileOf = (over: Partial<TerrainAccessProfile> = {}): TerrainAccessProfile => ({
  name: 'test', maxLongitudinalGrade: 1, maxCrossSlope: 1, maxStepHeight: 1, maxRuggedness: null,
  vehicleWidth: 0, vehicleLength: null, minimumTerrainConfidence: 0, unknownPolicy: 'block',
  obstacleHeightThreshold: null, ...over,
});

const identity = {
  layerId: 'layer-a', filename: 'site', sourceDigest: null, analysisInputDigest: 'digest',
  build: 'test-build', id: 'run-1', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
};

/** A flat 4x3 run at confidence 60: every move costs only the support term. */
function weakSupportRun() {
  const r = runTerrainAccess(dtmOf(4, 3, 60), RESOLVED, profileOf(), 0, 11, TERRAIN_ACCESS_DEFAULTS, identity);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe('run card', () => {
  it('names the dominant cost term from the diagnostics', () => {
    const card = rec(lab.renderTerrainAccessRunCard(weakSupportRun()));
    expect(card.textContent).toContain('Cost driven mostly by: weak terrain support.');
  });

  it('shows p95 grade, total cost and the measured vs interpolated split', () => {
    const run = weakSupportRun();
    const text = rec(lab.renderTerrainAccessRunCard(run)).textContent;
    expect(text).toContain('P95 longitudinal grade');
    expect(text).toContain(`Total cost ${run.cost.toFixed(1)}`);
    expect(text).toContain('100% measured, 0% interpolated, 0% low confidence');
  });

  it('a route with no extra cost says the cost is distance alone', () => {
    expect(explain.costDriversSentence([{ term: 'support', total: 0 }])).toBe(
      'Cost is distance alone: every move was flat and fully supported.',
    );
    expect(explain.costDriversSentence([
      { term: 'cross-slope', total: 2 }, { term: 'step', total: 1 }, { term: 'support', total: 0 },
    ])).toBe('Cost driven mostly by: cross slope, then step height.');
  });
});

describe('no eligible cell refusal', () => {
  it('names the most common block reason with its count', () => {
    const out = prepareTerrainAccessPreview(dtmOf(4, 3, 40), RESOLVED, profileOf({ minimumTerrainConfidence: 50 }), TERRAIN_ACCESS_DEFAULTS);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('INSUFFICIENT_EVIDENCE');
    expect(out.reason).toContain('12 cells are below terrain confidence 50.');
  });

  it('formats large counts with separators', () => {
    const reason = new Array(12_000).fill('low-confidence');
    const s = explain.topBlockReasonSentence({ blocked: new Uint8Array(12_000).fill(1), reason }, profileOf({ minimumTerrainConfidence: 50 }));
    expect(s).toBe('12,000 cells are below terrain confidence 50.');
  });
});

describe('profile form', () => {
  it('explains the confidence score and links every hint to its input', () => {
    const form = rec(lab.buildProfileForm(() => {}, null).element);
    expect(form.textContent).toContain(lab.TERRAIN_CONFIDENCE_HINT);
    const inputs: RecordingEl[] = [];
    const hints = new Map<string, RecordingEl>();
    const walk = (n: RecordingEl): void => {
      if (n.className === 'olv-ta-field-input') inputs.push(n);
      if (n.className === 'olv-ta-field-hint') hints.set((n as unknown as { id: string }).id, n);
      n.children.forEach(walk);
    };
    walk(form);
    expect(inputs.length).toBe(9);
    for (const input of inputs) {
      const id = input.getAttribute('aria-describedby');
      expect(id).not.toBeNull();
      expect(hints.has(id!)).toBe(true);
    }
    const numeric = inputs.filter((i) => i.getAttribute('inputmode') === 'decimal');
    expect(numeric.length).toBe(8);
  });

  it('the weak-evidence policy tips speak of cells below the minimum confidence', () => {
    const form = rec(lab.buildProfileForm(() => {}, null).element);
    const tips: string[] = [];
    const walk = (n: RecordingEl): void => {
      if (n.className === 'olv-ta-segmented-btn' && n.dataset.tip) tips.push(n.dataset.tip);
      n.children.forEach(walk);
    };
    walk(form);
    expect(tips).toEqual([
      'Treat cells below the minimum confidence as impassable.',
      'Allow cells below the minimum confidence, at an extra route cost.',
    ]);
  });
});

describe('result grid', () => {
  it('keeps cells square: the canvas height follows its width', () => {
    const prev = prepareTerrainAccessPreview(dtmOf(8, 2, 100), RESOLVED, profileOf(), TERRAIN_ACCESS_DEFAULTS);
    if (!prev.ok) throw new Error(prev.reason);
    const g = new resultGrid.TerrainAccessResultGrid({ ariaLabel: 'grid', onActivate: () => {}, onMove: () => {} });
    g.load(prev.grid, prev.map);
    const canvas = rec(g.element).children[0]!;
    expect(canvas.style.height).toBe('auto');
    expect(canvas.style.aspectRatio).toBe('320 / 80');
  });

  it('the legend and the cursor readout use the same bucket names, and the legend explains them', () => {
    const legend = rec(resultGrid.terrainAccessGridLegend());
    for (const label of Object.values(explain.TERRAIN_ACCESS_STATE_LABEL)) {
      expect(legend.findByText(label)).toHaveLength(1);
    }
    expect(legend.textContent).toContain('low up to 15%, moderate up to 50%, high above 50%');
    const prev = prepareTerrainAccessPreview(dtmOf(2, 2, 100), RESOLVED, profileOf(), TERRAIN_ACCESS_DEFAULTS);
    if (!prev.ok) throw new Error(prev.reason);
    const report = cursor.describeTerrainAccessCell(prev.grid, prev.map, { col: 0, row: 0 });
    expect(report.mapState).toBe(explain.TERRAIN_ACCESS_STATE_LABEL[prev.map[0]!.state].toLowerCase());
  });
});

describe('controls', () => {
  it('the inspect mode reads "Inspect a cell"', () => {
    expect(lab.TERRAIN_ACCESS_MODE_OPTIONS.map((o) => o.label)).toEqual(['Set start', 'Set goal', 'Inspect a cell']);
  });

  it('export is ready only after a run produced a route', () => {
    expect(lab.terrainAccessExportReady(null, false, false)).toBe(false);
    expect(lab.terrainAccessExportReady({ ok: false, code: 'NO_PATH', reason: 'x' } as never, false, false)).toBe(false);
    const run = weakSupportRun();
    expect(lab.terrainAccessExportReady(run, false, false)).toBe(true);
    expect(lab.terrainAccessExportReady(run, true, false)).toBe(false);
    expect(lab.terrainAccessExportReady(run, false, true)).toBe(false);
  });
});

describe('route and raster placement', () => {
  // 4 x 3 cells of 2 m, cell (0, 0) at (-10, -6) from a load-time origin of
  // (400000, 3600000): the lower-left corner is (399990, 3599994).
  function placedDtm(): DtmGrid {
    return { ...dtmOf(4, 3, 60), cellSizeM: 2, originH1: -10, originH2: -6 } as DtmGrid;
  }
  const ORIGIN = { x: 400_000, y: 3_600_000 };
  const text = (zip: Uint8Array, name: string) => new TextDecoder().decode(extractEntry(zip, name)!);

  function placedRun() {
    const r = runTerrainAccess(placedDtm(), RESOLVED, profileOf(), 0, 11, TERRAIN_ACCESS_DEFAULTS, identity);
    if (!r.ok) throw new Error(r.reason);
    return r;
  }

  it('writes the raster corner and route vertices in the scan CRS, from a hand computation', () => {
    const run = placedRun();
    const zip = buildTerrainAccessPackage(run, {
      basename: 'ta', worldOrigin: ORIGIN, crsName: 'UTM zone 10N', wkt: 'PROJCS["x"]',
      gridPlacement: lab.terrainAccessGridPlacement(placedDtm()),
    });
    const asc = text(zip, 'ta-traversability.asc');
    expect(asc).toContain('xllcorner 399990\nyllcorner 3599994\ncellsize 2\n');
    const geo = JSON.parse(text(zip, 'ta-route.geojson'));
    expect(geo.coordinateFrame).toBe('scan-crs');
    // Cell 0 is (col 0, row 0): its centre is one half cell in from the corner.
    expect(geo.features[0].geometry.coordinates[0]).toEqual([399991, 3599995]);
    // Cell 11 is (col 3, row 2): 399990 + 3.5 * 2, 3599994 + 2.5 * 2.
    expect(geo.features[0].geometry.coordinates.at(-1)).toEqual([399997, 3599999]);
    expect(text(zip, 'ta.prj')).toBe('PROJCS["x"]');
    expect(text(zip, 'ta-README.txt')).toContain(routeFrameLines('scan-crs', 'UTM zone 10N').join('\n'));
  });

  it('places a Y-up scan the same way, through the canonical origin the Lab receives', () => {
    // A Y-up scene stores northing as -z. Its load-time origin (400000, 50,
    // -3600000) becomes (400000, 3600000, 50) in the canonical Z-up frame the
    // DTM and getMapContext use, so originH2 is a northing offset there too.
    const canon = placedWorldOrigin([400_000, 50, -3_600_000], 'y')!;
    expect(canon).toEqual([400_000, 3_600_000, 50]);
    const zip = buildTerrainAccessPackage(placedRun(), {
      basename: 'ta', worldOrigin: { x: canon[0], y: canon[1] }, crsName: 'UTM zone 10N',
      gridPlacement: lab.terrainAccessGridPlacement(placedDtm()),
    });
    const first = JSON.parse(text(zip, 'ta-route.geojson')).features[0].geometry.coordinates[0];
    // Cell (0, 0)'s centre in the scene is local x = -10 + 1, local z = -(-6 + 1) = 5.
    // In source coordinates that is x = 400000 - 9 and z = -3600000 + 5, so its
    // northing is -z = 3599995.
    const sceneX = -9;
    const sceneZ = 5;
    expect(first).toEqual([400_000 + sceneX, -(-3_600_000 + sceneZ)]);
    expect(text(zip, 'ta-traversability.asc')).toContain('xllcorner 399990\nyllcorner 3599994\n');
  });

  it('puts the raster on the same corner the DEM package writes for the same grid', () => {
    const dtm = { ...placedDtm(), verticalEpsg: 5703 } as DtmGrid;
    const dem = text(buildDemPackage(demResultAround(dtm), { ...DEM_PKG_OPTS, worldOrigin: ORIGIN }), 'terrain-dtm.asc');
    const ta = text(buildTerrainAccessPackage(placedRun(), {
      basename: 'ta', worldOrigin: ORIGIN, gridPlacement: lab.terrainAccessGridPlacement(dtm),
    }), 'ta-traversability.asc');
    const header = (asc: string) => asc.split('\n').slice(0, 5).join('\n');
    expect(header(ta)).toBe(header(dem));
  });

  it('labels the frame local without an origin, and source coordinates without a CRS', () => {
    const run = placedRun();
    const local = buildTerrainAccessPackage(run, { basename: 'ta' });
    expect(JSON.parse(text(local, 'ta-route.geojson')).coordinateFrame).toBe('local-planar-metres');
    expect(text(local, 'ta-traversability.asc')).toContain('xllcorner 0\nyllcorner 0\n');
    expect(text(local, 'ta-README.txt')).toContain(routeFrameLines('local-planar-metres', null).join('\n'));
    const noCrs = buildTerrainAccessPackage(run, { basename: 'ta', worldOrigin: ORIGIN, gridPlacement: lab.terrainAccessGridPlacement(placedDtm()) });
    expect(JSON.parse(text(noCrs, 'ta-route.geojson')).coordinateFrame).toBe('scan-source-coordinates');
    expect(extractEntry(noCrs, 'ta.prj')).toBeNull();
  });
});
