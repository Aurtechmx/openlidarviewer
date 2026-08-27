/**
 * tilesetFrameUnknown.test.ts — a streamed tileset says whether it ever
 * established which way is up.
 *
 * A `region` bounding volume is the only in-spec way a 3D Tiles document
 * declares that its root frame is WGS84 geocentric. A document carrying only a
 * `box` or a `sphere` declares nothing, so its up axis is genuinely unknown and
 * every height, slope and terrain derivative read off it is measured along an
 * axis that may not be vertical. The scene draws identically either way, which
 * is why this has to be stated rather than seen.
 *
 * The merged reader recorded that on the cloud and raised a load warning. The
 * streaming replacement recorded nothing, so an unestablished tileset looked
 * exactly like an established one. These cases pin both halves back on: the
 * record on the source, and the notice on the surface a user reads.
 */

import { describe, it, expect, vi } from 'vitest';
import { openRemoteTileset } from '../src/app/openTilesetLayer';
import { TilesetStreamingSource } from '../src/render/streaming/TilesetStreamingSource';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { FRAME_UNKNOWN_NOTE } from '../src/geo/frame/frameProvenance';
import { REGION_DECLARES_GEOCENTRIC } from '../src/io/tiles3d/tilesetFrame';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';

const DEG = Math.PI / 180;

/** A box declares nothing about the frame the coordinates are in. */
const BOX_DOC = JSON.stringify({
  asset: { version: '1.0' },
  geometricError: 100,
  root: {
    boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
    geometricError: 50,
    refine: 'REPLACE',
    content: { uri: 'r.pnts' },
  },
});

/**
 * A region is stated in EPSG:4979 and is the one volume the tile transform does
 * not apply to, so carrying one IS the declaration. Monterrey, where the polar
 * axis and local up are 64.3 degrees apart.
 */
const REGION_DOC = JSON.stringify({
  asset: { version: '1.0' },
  geometricError: 100,
  root: {
    boundingVolume: {
      region: [-100.32 * DEG, 25.68 * DEG, -100.31 * DEG, 25.69 * DEG, 500, 580],
    },
    geometricError: 50,
    refine: 'REPLACE',
    content: { uri: 'r.pnts' },
  },
});

function transport(): TilesetTransport {
  return {
    fetchTilesetJson: async () => '{}',
    // An explicit hierarchy asks for no subtree, so a request for one here would
    // be the reader inventing work rather than a case this test set up.
    fetchSubtreeBytes: async () => {
      throw new Error('this tileset states an explicit hierarchy; no subtree exists');
    },
    fetchTileBytes: async () => new ArrayBuffer(8),
  };
}

function sourceFor(doc: string): TilesetStreamingSource {
  return new TilesetStreamingSource(
    'id',
    'n',
    'https://host/d/tileset.json',
    transport(),
    parseTileset(doc),
  );
}

/** Deps thin enough to open with, recording what reached the Scan Report. */
function deps() {
  const viewer = {
    clouds: () => [],
    attachStreamingCloud: vi.fn(async () => {}),
    setMode: vi.fn(),
    frameAll: vi.fn(),
    availableImageExportModes: () => new Map(),
  };
  const setReport = vi.fn();
  return {
    setReport,
    d: {
      isLoading: () => false,
      setLoading: () => {},
      viewerReady: Promise.resolve(),
      getViewer: () => viewer,
      getStreamingQuality: () => 'balanced',
      getStreamingBenchmark: () => null,
      isPhone: () => false,
      showToast: () => {},
      debug: false,
      closeStreaming: () => {},
      clearOpenStaticLayers: () => {},
      startStreamingStatusPolling: () => {},
      revealStreamingChrome: () => {},
      stage: { hideEmptyState: () => {} },
      inspector: { setReport, setStreamingMode: vi.fn() },
      // Added by the scan-detection work after this fake was written. The open
      // calls all three before it publishes the report, so a fake without them
      // throws and the report never reaches the Inspector at all.
      setLastStreamingReportCloud: vi.fn(),
      runStreamingModules: () => [],
      classLegendPanel: {
        getVisibility: () => ({ isFiltered: false }),
        setClasses: vi.fn(),
        hide: vi.fn(),
      },
      hideReclassifyUi: vi.fn(),
      syncInspectClassScope: vi.fn(),
      exportPanel: {
        setImageExportEnabled: vi.fn(),
        setImageExportAvailability: vi.fn(),
        setStreamingMode: vi.fn(),
      },
      bookmarks: { clear: vi.fn() },
      revealAnalysePanel: vi.fn(),
      prewarmExportStudio: vi.fn(),
      refreshViewsUI: vi.fn(),
      inspectorCards: { refreshProvenanceFromStreaming: () => {} },
      crsCoordinator: { refreshCrsForStreamingCloud: () => {} },
      streamingPanel: {
        setColorModes: vi.fn(),
        setQuality: () => {},
        setSourceUrl: () => {},
        setPhase: () => {},
        setSummary: vi.fn(),
        show: vi.fn(),
      },
      dropZone: {
        setOpening: () => {},
        setCancelHandler: () => {},
        setProgress: () => {},
        setError: vi.fn(),
      },
    },
  };
}

/** Serve the tileset document without touching the network. */
function withTransport<T>(doc: string, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('tileset.json')) {
      return new Response(doc, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new ArrayBuffer(0), { status: 404 });
  }) as unknown as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = realFetch;
  });
}

/** Everything the open path wrote to the Scan Report, as one blob of text. */
async function reportTextFor(doc: string): Promise<string> {
  const t = deps();
  await withTransport(doc, () =>
    openRemoteTileset('https://host/d/tileset.json', undefined, t.d as never),
  );
  return t.setReport.mock.calls
    .flatMap((call) => (call[0] as { label: string; value: string }[]) ?? [])
    .map((row) => `${row.label}: ${row.value}`)
    .join('\n');
}

describe('a tileset that declares no geocentric frame', () => {
  it('records that its frame was never established', () => {
    const p = sourceFor(BOX_DOC).frameProvenance;
    expect(
      p,
      'no record at all reads as "nobody asked", which is a different fact from ' +
        '"asked and could not be established"',
    ).not.toBeNull();
    expect(p!.basis).toBe('unknown');
    expect(p!.declaredBy).toBeNull();
    expect(p!.verticalReference).toBe('unknown');
    // The unit survives an unresolved frame: 3D Tiles states metres regardless.
    expect(p!.linearUnit).toBe('metre');
  });

  it('says so on the Scan Report, where a user deciding on an elevation looks', async () => {
    expect(
      await reportTextFor(BOX_DOC),
      'a field nobody reads leaves the user unable to tell an unestablished ' +
        'tileset from an established one',
    ).toContain(FRAME_UNKNOWN_NOTE);
  });
});

describe('a tileset that declares a region', () => {
  it('records the frame it established, and what established it', () => {
    const p = sourceFor(REGION_DOC).frameProvenance;
    expect(p).not.toBeNull();
    expect(p!.basis).toBe('local-enu');
    expect(p!.declaredBy).toBe(REGION_DECLARES_GEOCENTRIC);
    expect(p!.anchor, 'without the anchor the frame is applied but not reversible').toBeDefined();
  });

  it('raises no unknown-frame notice', async () => {
    expect(
      await reportTextFor(REGION_DOC),
      'crying wolf on a tileset that did declare its frame trains the user to ' +
        'ignore the notice that matters',
    ).not.toContain(FRAME_UNKNOWN_NOTE);
  });
});

describe('what a region does NOT establish', () => {
  it('records an ellipsoidal vertical reference, never an orthometric datum', () => {
    const p = sourceFor(REGION_DOC).frameProvenance;
    expect(
      p!.verticalReference,
      'an ENU frame tangent to the WGS84 ellipsoid gives heights above that ' +
        'ellipsoid; 3D Tiles carries no vertical datum',
    ).toBe('ellipsoidal');
  });

  it('does not name a geoid or an orthometric datum on the Scan Report', async () => {
    const text = (await reportTextFor(REGION_DOC)).toLowerCase();
    expect(text).toContain('ellipsoidal');
    for (const lie of ['orthometric', 'geoid', 'egm', 'navd', 'mean sea level', 'msl']) {
      expect(text, `the report claims ${lie}, which the document never stated`).not.toContain(lie);
    }
  });
});
