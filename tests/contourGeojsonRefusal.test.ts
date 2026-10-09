/**
 * A refused RFC 7946 contour GeoJSON says why.
 *
 * For a scan the lon/lat mapper refuses (NAD27, an unknown datum) the contour
 * GeoJSON cannot be written. The refusal reached the user as "Export failed"
 * and "Contour export failed. Try again.", which suggests a retry could work.
 * The mapper's reason now travels in the error, and the Studio button shows it.
 */

import { describe, it, expect, vi } from 'vitest';
import { serializeContours } from '../src/terrain/contour/contourDownload';
import { GeoJsonFrameError } from '../src/terrain/contour/geojsonContours';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import { ContourExportAdapter, type ContourExportHost } from '../src/ui/contourExportAdapter';
import { POLITE_REGION_SELECTOR } from '../src/ui/politeAnnounce';
import type { ContourExportIntent } from '../src/terrain/contourStudio/contourExportIntent';
import type { ContourExportFrameFacts } from '../src/export/contourExportPermit';
import { lonLatDatumRefusal } from '../src/export/lonLatMapper';

const REASON = lonLatDatumRefusal(26712);

const model = {
  features: [{ value: 1, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [1, 1]] }],
  crs: 'EPSG:26712',
  verticalDatum: null,
  intervalM: 1,
  contourStyle: 'smooth',
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  interpolatedFraction: 0,
  coverageMode: 'full',
  warnings: [],
} as unknown as ContourFeatureModel;

describe('serializeContours carries the mapper refusal', () => {
  it('throws a GeoJsonFrameError whose message is the datum reason', () => {
    let err: unknown;
    try {
      serializeContours(model, 'geojson', { worldOrigin: { x: 0, y: 0, z: 0 }, lonLatRefusal: REASON });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GeoJsonFrameError);
    expect((err as Error).message).toContain(REASON);
    expect((err as Error).name).toBe('GeoJsonFrameError');
  });
});

describe('the Studio button shows the refusal, not a retryable failure', () => {
  it('reads "Export refused" and announces the reason', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const region = { textContent: '' };
    const b = {
      textContent: 'Export',
      disabled: false,
      title: '',
      ownerDocument: { querySelector: (s: string) => (s === POLITE_REGION_SELECTOR ? region : null) },
    } as unknown as HTMLButtonElement;
    const host = {
      setContourStyle: () => {},
      exportVector: async () => { throw new GeoJsonFrameError(REASON); },
      openMapPdf: () => {},
      exportDemPackage: async () => {},
      exportCompletePackage: async () => {},
      exportTerrainReport: async () => {},
    } as unknown as ContourExportHost;
    const intent = {
      purpose: 'Survey Review', shapeStyle: 'crisp', generalizeToleranceCells: 0, generalizeMode: 'uniform',
      labelsIndexOnly: false, methodId: 'olv.contour.analytical', methodVersion: 1, methodTag: 'olv.contour.analytical@2',
      deliverable: {
        label: 'Survey Review', statement: '', analytical: true, cartographic: false, cartographicSmoothing: false,
        generalizeToleranceCells: 0, indexEvery: 5, labelsIndexOnly: true, hillshade: false, hypsometricTint: false,
        allowExploratory: false, completePackage: false, appendixRequired: true,
      },
    } as unknown as ContourExportIntent;
    const frame = { launchStatus: 'available', verticalUnitsKnown: true, crsProjected: true, precision: null } as unknown as ContourExportFrameFacts;
    new ContourExportAdapter(host).handle('geojson', b, intent, frame);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.textContent).toBe('Export refused');
    expect(region.textContent).toBe(`Contour export refused. ${REASON}`);
    expect(b.title).toBe(REASON);
    vi.runAllTimers();
    expect(b.textContent).toBe('Export');
    vi.useRealTimers();
  });
});
