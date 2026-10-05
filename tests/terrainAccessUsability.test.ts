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

describe('route GeoJSON frame', () => {
  it('labels the frame by the origin actually added to the coordinates', () => {
    const run = weakSupportRun();
    const local = buildTerrainAccessPackage(run, { basename: 'ta' });
    const shifted = buildTerrainAccessPackage(run, { basename: 'ta', worldOrigin: { x: 500, y: 4000 } });
    const json = (zip: Uint8Array) => JSON.parse(new TextDecoder().decode(extractEntry(zip, 'ta-route.geojson')!));
    const readme = (zip: Uint8Array) => new TextDecoder().decode(extractEntry(zip, 'ta-README.txt')!);
    expect(json(local).coordinateFrame).toBe('local-planar-metres');
    expect(json(shifted).coordinateFrame).toBe('scan-origin-plus-grid-offset-metres');
    expect(json(shifted).features[0].geometry.coordinates[0]).toEqual([500, 4000]);
    expect(readme(local)).toContain(routeFrameLines(null).join('\n'));
    expect(readme(shifted)).toContain(routeFrameLines({ x: 500, y: 4000 }).join('\n'));
    expect(readme(shifted)).toContain("The scan's load-time origin (500, 4000)");
    expect(readme(shifted)).not.toContain("relative to the grid's own (0, 0) corner");
  });
});
