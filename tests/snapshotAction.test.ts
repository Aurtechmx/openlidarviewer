import { describe, it, expect, vi, beforeEach } from 'vitest';

const stamp = vi.fn(async (blob: Blob, _ctx: unknown) => blob);
const banner = vi.fn(async (blob: Blob, _scope: string) => blob);
vi.mock('../src/lazyChunks', () => ({
  loadExportStudio: async () => ({ stampFigureProvenanceOntoBlob: stamp }),
  loadScanReportRenderer: async () => ({ composeClassScopeBannerOntoBlob: banner }),
}));

import { saveSnapshot, snapshotFileName, type SnapshotViewer } from '../src/app/snapshotAction';
import { buildFigureProvenance } from '../src/export/figureProvenance';

function viewer(over: Partial<SnapshotViewer> = {}): SnapshotViewer {
  return {
    snapshot: vi.fn(async () => new Blob(['png'])),
    annotate: { getAnnotations: () => [] },
    measure: { getMeasurements: () => [{}] },
    figureViewContext: () => ({ crs: null, colorMode: 'elevation', camera: null, clip: null }),
    ...over,
  };
}

describe('Save view snapshot', () => {
  beforeEach(() => { stamp.mockClear(); banner.mockClear(); });

  it('burns what is placed, stamps the scope, and records a drawn reference plane in the provenance', async () => {
    const v = viewer();
    const download = vi.fn();
    const toast = vi.fn();
    const now = () => new Date(2026, 9, 25, 14, 3, 9);
    await saveSnapshot({ viewer: v, classScopeStamp: () => 'showing 3 of 5 classes', referencePlaneNote: () => 'Reference plane, not measured terrain. Orientation: Horizontal', onError: vi.fn(), download, toast, baseName: () => 'site-42', now });
    expect(v.snapshot).toHaveBeenCalledWith({ annotations: false, measurements: true, colorbar: true });
    expect(banner).toHaveBeenCalledWith(expect.any(Blob), 'showing 3 of 5 classes');
    expect(stamp.mock.calls[0][1]).toMatchObject({ colorMode: 'elevation', referencePlane: 'Reference plane, not measured terrain. Orientation: Horizontal' });
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'site-42-view-20261025-140309.png');
    expect(toast).toHaveBeenCalledWith('Snapshot saved as site-42-view-20261025-140309.png.');
  });

  it('names the file after the scan and the moment, and falls back to the app name', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(snapshotFileName('survey', at)).toBe('survey-view-20260102-030405.png');
    expect(snapshotFileName(null, at)).toBe('openlidarviewer-view-20260102-030405.png');
    expect(snapshotFileName('  ', at)).toBe('openlidarviewer-view-20260102-030405.png');
  });

  it('a capture failure reports instead of rejecting', async () => {
    const onError = vi.fn();
    await saveSnapshot({ viewer: viewer({ snapshot: async () => { throw new Error('gpu'); } }), classScopeStamp: () => '', referencePlaneNote: () => null, onError, download: vi.fn() });
    expect(onError).toHaveBeenCalledWith('Could not save the view');
  });

  it('a stamping failure still downloads the image', async () => {
    stamp.mockRejectedValueOnce(new Error('bad png'));
    const download = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await saveSnapshot({ viewer: viewer(), classScopeStamp: () => '', referencePlaneNote: () => null, onError: vi.fn(), download });
    expect(download).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('figure provenance', () => {
  const base = { build: 'b', timestamp: 't' };
  it('carries an olv:reference-plane chunk only when a plane was drawn', () => {
    expect(buildFigureProvenance(base).some((e) => e.keyword === 'olv:reference-plane')).toBe(false);
    const entries = buildFigureProvenance({ ...base, referencePlane: 'Reference plane, not measured terrain.' });
    expect(entries.at(-1)).toEqual({ keyword: 'olv:reference-plane', text: 'Reference plane, not measured terrain.' });
  });
});
