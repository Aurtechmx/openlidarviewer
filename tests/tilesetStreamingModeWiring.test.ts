/**
 * tilesetStreamingModeWiring.test.ts — the two call sites between a tileset's
 * answer about its channels and the surfaces that act on it.
 *
 * `TilesetStreamingSource` folds that answer from the chunks the scheduler
 * actually served: nothing is offered before a tile has been read, and the
 * answer settles on the first tile with points. Both consumers read it once and
 * never again.
 *
 * The open published the chip row BEFORE any tile existed, so the row was
 * always the empty answer and a tileset whose tiles state normals could never
 * show a Normal chip. The export adapter answered `hasNormals()` from the
 * FORMAT — false for every streaming source — so the Normal Map export was shut
 * for a tileset that carries measured directions.
 *
 * Both directions are pinned here. A tileset that states normals must offer
 * both; a tileset that states none must offer neither, which matters exactly as
 * much: an offered chip that resolves to another channel is the defect this
 * area exists to prevent.
 */

import { describe, it, expect, vi } from 'vitest';
import { openRemoteTileset } from '../src/app/openTilesetLayer';
import { PntsChunkDecoder, type PntsDecodeMetadata } from '../src/io/tiles3d/pntsDecode';
import { buildExportAdapter, type ExportAdapterHost } from '../src/render/exportAdapter';
import { imageExportModeAvailability } from '../src/render/exportModeAvailability';
import type { TilesetStreamingSource } from '../src/render/streaming/TilesetStreamingSource';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';
import { gridPoints, makePnts, unitNormals } from './fixtures/tileset3d';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };
const DOC = JSON.stringify({
  asset: { version: '1.0' },
  geometricError: 100,
  root: { boundingVolume: BOX, geometricError: 50, refine: 'ADD', content: { uri: 'r.pnts' } },
});

const META: PntsDecodeMetadata = {
  format: 'pnts',
  tileTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  renderOrigin: [0, 0, 0],
};

const POINTS = gridPoints(3, 5);

/** One decoded tile body, with or without a stated NORMAL accessor. */
async function tile(normals: boolean): Promise<DecodedChunk> {
  const body = makePnts(POINTS, normals ? { normals: unitNormals(POINTS.length) } : {});
  return new PntsChunkDecoder().decode(body.buffer as ArrayBuffer, META);
}

/**
 * The shell collaborators the open writes into, recording every publish.
 *
 * `streamingCloud` is a real getter over the attached source rather than a
 * fixed value: the republish must refuse to repaint the panel for a layer that
 * is no longer the open one, and a mock that always agreed could not show it.
 */
function harness() {
  const setColorModes = vi.fn();
  const setImageExportAvailability = vi.fn();
  let attached: TilesetStreamingSource | null = null;
  const viewer = {
    clouds: () => [],
    attachStreamingCloud: vi.fn(async (cloud: TilesetStreamingSource) => {
      attached = cloud;
    }),
    setMode: vi.fn(),
    frameAll: vi.fn(),
    get streamingCloud() {
      return attached;
    },
    // The live per-mode map, built from the adapter the same way the real
    // viewer builds it, so the Normal Map gate here is the one a user meets.
    availableImageExportModes: vi.fn(() =>
      imageExportModeAvailability({
        hasAabb: true,
        zRange: 10,
        hasIntensity: false,
        hasClassification: false,
        hasNormals: adapter().hasNormals(),
      }),
    ),
  };
  const adapter = (): ReturnType<typeof buildExportAdapter> =>
    buildExportAdapter({
      clouds: () => new Map(),
      streaming: () =>
        attached === null
          ? null
          : ({ cloud: attached } as unknown as ReturnType<ExportAdapterHost['streaming']>),
      setColorMode: vi.fn(),
      setStreamingColorMode: vi.fn(),
      setVisible: vi.fn(),
      snapshot: vi.fn(async () => new Blob()),
      renderFramedTopDown: vi.fn(async () => null),
      renderFigure: vi.fn(async () => null),
      figureViewContext: vi.fn(),
    } as unknown as ExportAdapterHost);

  return {
    setColorModes,
    setImageExportAvailability,
    adapter,
    cloud: (): TilesetStreamingSource => {
      if (attached === null) throw new Error('nothing was attached');
      return attached;
    },
    d: {
      setLastStreamingReportCloud: vi.fn(),
      runStreamingModules: () => [],
      inspector: { setReport: vi.fn(), setStreamingMode: vi.fn() },
      classLegendPanel: {
        getVisibility: () => ({ isFiltered: () => false }),
        setClasses: vi.fn(),
        hide: vi.fn(),
      },
      inspectorCards: {
        refreshProvenanceFromStreaming: vi.fn(),
        refreshDatasetIntelligenceFromStreamingCloud: vi.fn(),
      },
      exportPanel: {
        setImageExportEnabled: vi.fn(),
        setImageExportAvailability,
        setStreamingMode: vi.fn(),
      },
      bookmarks: { clear: vi.fn() },
      revealAnalysePanel: vi.fn(),
      prewarmExportStudio: vi.fn(),
      refreshViewsUI: vi.fn(),
      hideReclassifyUi: vi.fn(),
      syncInspectClassScope: vi.fn(),
      isLoading: () => false,
      setLoading: vi.fn(),
      viewerReady: Promise.resolve(),
      getViewer: () => viewer,
      getStreamingQuality: () => 'balanced',
      getStreamingBenchmark: () => null,
      isPhone: () => false,
      showToast: vi.fn(),
      debug: false,
      closeStreaming: vi.fn(),
      clearOpenStaticLayers: vi.fn(),
      startStreamingStatusPolling: vi.fn(),
      revealStreamingChrome: vi.fn(),
      stage: { hideEmptyState: vi.fn() },
      crsCoordinator: { refreshCrsForStreamingCloud: vi.fn() },
      streamingPanel: {
        setColorModes,
        setQuality: vi.fn(),
        setSourceUrl: vi.fn(),
        setPhase: vi.fn(),
        setSummary: vi.fn(),
        show: vi.fn(),
      },
      dropZone: {
        setOpening: vi.fn(),
        setCancelHandler: vi.fn(),
        setProgress: vi.fn(),
        setError: vi.fn(),
      },
    },
  };
}

/** Serve the entry document without touching the network. */
async function open(t: ReturnType<typeof harness>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) =>
    String(input).endsWith('tileset.json')
      ? new Response(DOC, { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(new ArrayBuffer(0), { status: 404 })) as unknown as typeof fetch;
  try {
    await openRemoteTileset('https://host/d/tileset.json', undefined, t.d as never);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Every colour-mode row the panel was given, in publish order. */
function rows(t: ReturnType<typeof harness>): string[][] {
  return t.setColorModes.mock.calls.map((call) => [...(call[0] as string[])]);
}

describe('the colour-mode row a tileset publishes', () => {
  it('offers nothing but height before a tile has been read', async () => {
    const t = harness();
    await open(t);
    expect(
      rows(t),
      'a mode published before any tile is a promise about tiles nobody has seen',
    ).toEqual([['elevation']]);
  });

  it('republishes with the Normal chip once a tile has stated normals', async () => {
    const t = harness();
    await open(t);
    t.cloud().noteDecodedChannels(await tile(true));
    expect(
      rows(t).at(-1),
      'the row was published once at open, from the empty answer, so a tileset ' +
        'whose tiles state normals could never show the Normal chip',
    ).toContain('normal');
  });

  it('republishes exactly once, not on every chunk the scheduler serves', async () => {
    const t = harness();
    await open(t);
    for (let i = 0; i < 4; i++) t.cloud().noteDecodedChannels(await tile(true));
    expect(t.setColorModes).toHaveBeenCalledTimes(2);
  });

  it('never offers the Normal chip for a tileset whose tiles state none', async () => {
    const t = harness();
    await open(t);
    for (let i = 0; i < 3; i++) t.cloud().noteDecodedChannels(await tile(false));
    for (const row of rows(t)) expect(row).not.toContain('normal');
  });

  it('leaves the row alone when the answer settles without moving the offer', async () => {
    const t = harness();
    await open(t);
    t.cloud().noteDecodedChannels(await tile(false));
    expect(
      t.setColorModes,
      'a tile that states neither colour nor normals changes nothing a user can see',
    ).toHaveBeenCalledTimes(1);
  });

  it('publishes a fresh scan’s row without keeping the previous scan’s selection', async () => {
    const t = harness();
    await open(t);
    await open(t);
    // The panel is never hidden on a streaming-to-streaming swap, so the
    // previous scan's selection is still there to inherit. Only a republish of
    // the SAME layer's row may keep one.
    for (const call of t.setColorModes.mock.calls) expect(call[2]).toBeFalsy();
  });

  it('refuses to repaint the row for a layer that is no longer open', async () => {
    const t = harness();
    await open(t);
    const stale = t.cloud();
    const before = t.setColorModes.mock.calls.length;
    // A second scan takes the viewer. The decode continuation that carries this
    // notification can land after that swap.
    await open(t);
    stale.noteDecodedChannels(await tile(true));
    expect(rows(t).slice(before).every((row) => !row.includes('normal'))).toBe(true);
  });
});

describe('the Normal Map export gate', () => {
  it('opens for a tileset whose tiles state normals', async () => {
    const t = harness();
    await open(t);
    expect(t.adapter().hasNormals(), 'nothing has been read yet').toBe(false);
    t.cloud().noteDecodedChannels(await tile(true));
    expect(
      t.adapter().hasNormals(),
      'hasNormals answered from the format, so every streaming source was false',
    ).toBe(true);
    expect(imageExportModeAvailability({
      hasAabb: true,
      zRange: 10,
      hasIntensity: false,
      hasClassification: false,
      hasNormals: t.adapter().hasNormals(),
    }).get('normal')?.available).toBe(true);
  });

  it('stays shut for a tileset whose tiles state none', async () => {
    const t = harness();
    await open(t);
    for (let i = 0; i < 3; i++) t.cloud().noteDecodedChannels(await tile(false));
    expect(t.adapter().hasNormals()).toBe(false);
    expect(imageExportModeAvailability({
      hasAabb: true,
      zRange: 10,
      hasIntensity: false,
      hasClassification: false,
      hasNormals: t.adapter().hasNormals(),
    }).get('normal')?.available).toBe(false);
  });

  it('is republished off the live viewer when the answer moves', async () => {
    const t = harness();
    await open(t);
    const before = t.setImageExportAvailability.mock.calls.length;
    t.cloud().noteDecodedChannels(await tile(true));
    const published = t.setImageExportAvailability.mock.calls.at(-1)?.[0] as
      | Map<string, { available: boolean }>
      | undefined;
    expect(
      t.setImageExportAvailability.mock.calls.length,
      'the map was read once at open, when no tile had stated anything',
    ).toBeGreaterThan(before);
    expect(published?.get('normal')?.available).toBe(true);
  });
});
