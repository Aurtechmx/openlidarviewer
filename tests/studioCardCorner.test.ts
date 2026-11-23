/**
 * studioCardCorner.test.ts
 *
 * The Studio scan-report card is composed in the bottom-left corner. The
 * colour bar and its notes hold the right edge of the capture, and a card in
 * the bottom-right covered the notes on any image shorter than about 1000 px.
 */
import { expect, test, vi } from 'vitest';

const corners: string[] = [];
vi.mock('../src/export/ScanReportRenderer', async (orig) => {
  const real = await orig<typeof import('../src/export/ScanReportRenderer')>();
  return {
    ...real,
    composeScanReportOntoBlob: vi.fn(async (blob: Blob, _data: unknown, corner: string) => {
      corners.push(corner);
      return blob;
    }),
  };
});

import { runStudioExport } from '../src/export/BaseExportMode';
import type { ExportContext, ExportSceneAdapter } from '../src/export/types';

test('the card goes bottom-left, clear of the colour bar notes on the right', async () => {
  const adapter = {
    setExportColorMode: () => {},
    currentColorMode: () => 'elevation',
    snapshotColorModes: () => ({ staticModes: new Map(), streamingMode: null }),
    restoreColorModes: () => {},
    excludeUnsupported: () => [],
    restoreVisibility: () => {},
    hasRgb: () => false,
    hasIntensity: () => false,
    hasClassification: () => false,
    hasNormals: () => false,
    worldUpAxis: () => 2 as const,
    localBoundsAabb: () => [0, 0, 0, 10, 10, 5],
    dataBoundsAabb: () => [0, 0, 0, 10, 10, 5],
    snapshot: async () => new Blob([new Uint8Array([0])], { type: 'image/png' }),
    sourceName: () => 'room',
    sourcePointCount: () => 1000,
    residentPointCount: () => 1000,
    crsLabel: () => null,
  } as unknown as ExportSceneAdapter;
  const context = { adapter, canvas: { width: 800, height: 600 } } as unknown as ExportContext;
  await runStudioExport(context, 'height-map', 'Height Map', 'elevation', {});
  expect(corners).toEqual(['bottom-left']);
});
