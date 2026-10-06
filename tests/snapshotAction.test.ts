import { describe, it, expect, vi, beforeEach } from 'vitest';

const stamp = vi.fn(async (blob: Blob, _ctx: unknown) => blob);
const banner = vi.fn(async (blob: Blob, _scope: string) => blob);
vi.mock('../src/lazyChunks', () => ({
  loadExportStudio: async () => ({ stampFigureProvenanceOntoBlob: stamp }),
  loadScanReportRenderer: async () => ({ composeClassScopeBannerOntoBlob: banner }),
}));

import { saveSnapshot, type SnapshotViewer } from '../src/app/snapshotAction';
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
    await saveSnapshot({ viewer: v, classScopeStamp: () => 'showing 3 of 5 classes', referencePlaneNote: () => 'Reference plane, not measured terrain. Orientation: Horizontal', onError: vi.fn(), download });
    expect(v.snapshot).toHaveBeenCalledWith({ annotations: false, measurements: true, colorbar: true });
    expect(banner).toHaveBeenCalledWith(expect.any(Blob), 'showing 3 of 5 classes');
    expect(stamp.mock.calls[0][1]).toMatchObject({ colorMode: 'elevation', referencePlane: 'Reference plane, not measured terrain. Orientation: Horizontal' });
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'openlidarviewer.png');
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
