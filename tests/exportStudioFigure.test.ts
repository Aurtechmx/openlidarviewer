/**
 * exportStudioFigure.test.ts — the honest-resolution + PNG-provenance
 * contract of `runStudioExport` (`src/export/BaseExportMode.ts`).
 *
 * History this suite exists to prevent repeating: the Studio presets
 * advertised "2048 px" while `runStudioExport` silently ignored
 * `options.width`/`height` and shipped the live canvas size. The fixed
 * contract, pinned here with a mock adapter:
 *
 *   • An explicit width/height request routes to `adapter.renderFigure`
 *     (the true offscreen re-render) when the adapter supports it, and the
 *     result reports the ACTUAL rendered pixel size.
 *   • Without an explicit size — or when the adapter can't re-render — the
 *     WYSIWYG snapshot path is used and the result reports the live canvas
 *     size, never the unfulfilled request.
 *   • Every produced PNG carries figure provenance as standard text chunks
 *     (Software / Creation Time / olv:*), embedded LAST so no later
 *     re-encode strips them.
 */

import { test, expect, vi } from 'vitest';
import { runStudioExport } from '../src/export/BaseExportMode';
import { readPngTextChunks } from '../src/export/pngTextChunks';
import type { ExportContext, ExportSceneAdapter, HeightMapOptions } from '../src/export/types';

// A real, minimal 1×1 grayscale PNG (see exportPngTextChunks.test.ts for the
// byte-layout notes) — the mock render paths return it so the provenance
// embedding can run for real instead of being skipped on a non-PNG payload.
const TINY_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0, 58, 126, 155, 85,
  0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 168, 7, 0, 0, 129, 0, 128, 211, 148, 83, 74,
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

function tinyPngBlob(): Blob {
  return new Blob([TINY_PNG.slice() as unknown as BlobPart], { type: 'image/png' });
}

async function textChunksOf(blob: Blob): Promise<ReadonlyArray<{ keyword: string; text: string }>> {
  return readPngTextChunks(new Uint8Array(await blob.arrayBuffer()));
}

/** A recording adapter — every call lands in `calls` so ordering is assertable. */
function figureAdapter(opts: {
  withRenderFigure?: boolean;
  renderFigureResult?: { blob: Blob; widthPx: number; heightPx: number } | null;
  renderFigureRejects?: boolean;
  withViewContext?: boolean;
}): { adapter: ExportSceneAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter: ExportSceneAdapter = {
    setExportColorMode: (mode) => calls.push(`setColorMode:${mode}`),
    currentColorMode: () => 'rgb',
    hasRgb: () => true,
    hasIntensity: () => true,
    hasClassification: () => true,
    hasNormals: () => false,
    localBoundsAabb: () => [0, 0, 0, 10, 10, 5],
    snapshot: async () => {
      calls.push('snapshot');
      return tinyPngBlob();
    },
    sourceName: () => 'figure-scan',
    sourcePointCount: () => 1000,
    residentPointCount: () => 1000,
    crsLabel: () => ({ name: 'WGS 84 / UTM zone 14N', unit: 'm', epsg: 32614 }),
  };
  if (opts.withRenderFigure) {
    adapter.renderFigure = vi.fn(async (o: { widthPx?: number; heightPx?: number }) => {
      calls.push(`renderFigure:${o.widthPx ?? '-'}x${o.heightPx ?? '-'}`);
      if (opts.renderFigureRejects) {
        // The shape of a REAL device failure: the render throws, or the
        // canvas encode produces no blob and `_canvasToBlob` rejects. The
        // real adapter never converts these into a null return.
        throw new Error('device lost mid-render');
      }
      return opts.renderFigureResult !== undefined
        ? opts.renderFigureResult
        : { blob: tinyPngBlob(), widthPx: o.widthPx ?? 2048, heightPx: 1152 };
    });
  }
  if (opts.withViewContext) {
    adapter.figureViewContext = () => ({
      crs: adapter.crsLabel(),
      colorMode: adapter.currentColorMode(),
      camera: { position: [10, -5.25, 3], target: [0, 0, 0], fovDeg: 60 },
      clip: { mode: 'keep-inside', min: [-1, -2, 0], max: [5, 6, 7.5] },
    });
  }
  return { adapter, calls };
}

function figureContext(adapter: ExportSceneAdapter): ExportContext {
  // Only the fields runStudioExport touches — the GPU-facing members are
  // exercised in the live-build smoke test, not here.
  return { adapter, canvas: { width: 800, height: 600 } } as unknown as ExportContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Honest resolution
// ─────────────────────────────────────────────────────────────────────────────

test('an explicit width routes to renderFigure and reports the real output size', async () => {
  const { adapter, calls } = figureAdapter({ withRenderFigure: true });
  const result = await runStudioExport(
    figureContext(adapter),
    'height-map',
    'Height Map',
    'elevation',
    { width: 2048 },
  );
  expect(calls).toContain('renderFigure:2048x-');
  expect(calls).not.toContain('snapshot');
  expect(result.width).toBe(2048);
  expect(result.height).toBe(1152);
});

test('an explicit height alone also routes to the re-render path', async () => {
  const { adapter, calls } = figureAdapter({
    withRenderFigure: true,
    renderFigureResult: { blob: tinyPngBlob(), widthPx: 1707, heightPx: 960 },
  });
  const result = await runStudioExport(
    figureContext(adapter),
    'height-map',
    'Height Map',
    'elevation',
    { height: 960 },
  );
  expect(calls).toContain('renderFigure:-x960');
  expect(result.width).toBe(1707);
  expect(result.height).toBe(960);
});

test('without an explicit size the WYSIWYG snapshot path is untouched', async () => {
  const { adapter, calls } = figureAdapter({ withRenderFigure: true });
  const result = await runStudioExport(
    figureContext(adapter),
    'height-map',
    'Height Map',
    'elevation',
    {},
  );
  expect(calls).toContain('snapshot');
  expect(calls.some((c) => c.startsWith('renderFigure'))).toBe(false);
  // The result reports the live canvas size — what the snapshot actually is.
  expect(result.width).toBe(800);
  expect(result.height).toBe(600);
});

test('an adapter without renderFigure falls back to the snapshot and reports honestly', async () => {
  const { adapter, calls } = figureAdapter({ withRenderFigure: false });
  const result = await runStudioExport(
    figureContext(adapter),
    'height-map',
    'Height Map',
    'elevation',
    { width: 2048 },
  );
  expect(calls).toContain('snapshot');
  // The old lie was reporting/implying 2048 while shipping the canvas size;
  // the result must describe the pixels that exist.
  expect(result.width).toBe(800);
  expect(result.height).toBe(600);
});

test('a renderFigure that returns null (unplannable size request) falls back to the snapshot', async () => {
  const { adapter, calls } = figureAdapter({ withRenderFigure: true, renderFigureResult: null });
  const result = await runStudioExport(
    figureContext(adapter),
    'height-map',
    'Height Map',
    'elevation',
    { width: 2048 },
  );
  expect(calls.some((c) => c.startsWith('renderFigure'))).toBe(true);
  expect(calls).toContain('snapshot');
  expect(result.width).toBe(800);
  expect(result.height).toBe(600);
});

test('a renderFigure that REJECTS (device failure mid-render) also falls back to the snapshot', async () => {
  // Real device failures — a lost context, a canvas encode that yields no
  // blob — surface as rejections from the adapter, not as a null return.
  // An export must degrade to the WYSIWYG snapshot on a capture-quality
  // problem rather than die with an error toast, for the same reason the
  // provenance embedding is best-effort: the user asked for an image, and
  // an image exists on screen.
  const { adapter, calls } = figureAdapter({ withRenderFigure: true, renderFigureRejects: true });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = await runStudioExport(
      figureContext(adapter),
      'height-map',
      'Height Map',
      'elevation',
      { width: 2048 },
    );
    expect(calls.some((c) => c.startsWith('renderFigure'))).toBe(true);
    expect(calls).toContain('snapshot');
    // The result reports the snapshot's real size, never the size the
    // failed re-render was asked for.
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    // The failure is not swallowed silently — it lands in the console.
    expect(warnSpy).toHaveBeenCalled();
  } finally {
    warnSpy.mockRestore();
  }
});

test('the re-render runs INSIDE the colour-mode swap, and the swap is restored', async () => {
  const { adapter, calls } = figureAdapter({ withRenderFigure: true });
  await runStudioExport(figureContext(adapter), 'height-map', 'Height Map', 'elevation', {
    width: 2048,
  });
  // Forced into elevation, re-rendered, restored to the prior rgb.
  expect(calls).toEqual(['setColorMode:elevation', 'renderFigure:2048x-', 'setColorMode:rgb']);
});

// ─────────────────────────────────────────────────────────────────────────────
// PNG provenance embedding
// ─────────────────────────────────────────────────────────────────────────────

test('the produced PNG carries Software / Creation Time / olv:build / olv:colormap chunks', async () => {
  const { adapter } = figureAdapter({ withRenderFigure: true });
  // Typed as the height-map exporter's options so the `ramp` flows through
  // exactly the way HeightMapExporter passes it to runStudioExport.
  const options: HeightMapOptions = { width: 2048, ramp: 'terrain' };
  const result = await runStudioExport(
    figureContext(adapter),
    'height-map',
    'Height Map',
    'elevation',
    options,
  );
  const entries = await textChunksOf(result.blob);
  const byKeyword = new Map(entries.map((e) => [e.keyword, e.text]));
  expect(byKeyword.get('Software')).toBe('OpenLiDARViewer');
  expect(byKeyword.get('Creation Time')).toBeTruthy();
  // The vitest build identity pins commit "testtest" (vitest.config.ts), so
  // the build chunk is deterministic enough to fingerprint.
  expect(byKeyword.get('olv:build')).toContain('(testtest)');
  // olv:colormap records the mode the export FORCED — not the adapter's
  // pre-export live mode (rgb here) — plus the requested ramp as palette.
  expect(byKeyword.get('olv:colormap')).toBe('elevation · terrain');
  // olv:crs comes straight from the adapter's CRS label.
  expect(byKeyword.get('olv:crs')).toBe('WGS 84 / UTM zone 14N (EPSG:32614) · m');
});

test('camera + clip provenance ride along when the adapter can describe the view', async () => {
  const { adapter } = figureAdapter({ withRenderFigure: true, withViewContext: true });
  const result = await runStudioExport(
    figureContext(adapter),
    'height-map',
    'Height Map',
    'elevation',
    { width: 2048 },
  );
  const byKeyword = new Map((await textChunksOf(result.blob)).map((e) => [e.keyword, e.text]));
  expect(byKeyword.get('olv:camera')).toBe(
    'pos 10.000,-5.250,3.000 · target 0.000,0.000,0.000 · fov 60.0°',
  );
  expect(byKeyword.get('olv:clip')).toBe(
    'keep-inside · min -1.000,-2.000,0.000 · max 5.000,6.000,7.500',
  );
});

test('metadata embedding is best-effort — a non-PNG payload never sinks the export', async () => {
  const { adapter } = figureAdapter({
    withRenderFigure: true,
    renderFigureResult: {
      blob: new Blob(['not a png'], { type: 'image/png' }),
      widthPx: 2048,
      heightPx: 1152,
    },
  });
  const result = await runStudioExport(
    figureContext(adapter),
    'height-map',
    'Height Map',
    'elevation',
    { width: 2048 },
  );
  // The export still resolves, with the un-stamped payload passed through.
  expect(await result.blob.text()).toBe('not a png');
  expect(result.width).toBe(2048);
});
