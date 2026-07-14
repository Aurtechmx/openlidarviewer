/**
 * snapshotColorbarPlumbing.test.ts
 *
 * Guards the two seams that carry `colorbar: true` from an export action down
 * to the canvas burn-in — each a place a regression could silently drop the
 * option and ship a legend-less figure while every other test stayed green:
 *
 *   1. `runStudioExport` (BaseExportMode) must REQUEST the colorbar on the
 *      adapter's `snapshot()`. The Studio export path (Height Map, Depth,
 *      Intensity, …) all funnel through it; the exportStudio.test.ts snapshot
 *      fake ignores its opts, so nothing else pins this.
 *   2. The Viewer's export adapter must DELEGATE `colorbar` through to
 *      `viewer.snapshot()` (the `snapshot(options)` closure in
 *      `_buildExportAdapter`). This is the one-line hop the review flagged as
 *      the silent-drop risk — normalising `options.colorbar === true`.
 *
 * `saveSnapshot` (main.ts) is the third caller; it passes the same literal
 * `colorbar: true` straight to `viewer.snapshot()`. main.ts is the app-entry
 * module (top-level DOM wiring, lazy Viewer chunk) and can't be imported in a
 * unit test, so it isn't driven here — but it shares the SAME
 * `viewer.snapshot({ colorbar })` sink whose delegation half #2 pins, and the
 * self-gating burn-in the sink performs is covered by activeColorbar()'s tests.
 */

import { describe, it, expect } from 'vitest';
import { runStudioExport } from '../src/export/BaseExportMode';
import type {
  ExportContext,
  ExportSceneAdapter,
} from '../src/export/types';
import { Viewer } from '../src/render/Viewer';

// ─────────────────────────────────────────────────────────────────────────────
// #1 — runStudioExport requests the colorbar on the adapter snapshot
// ─────────────────────────────────────────────────────────────────────────────

/** The options `adapter.snapshot()` was last called with. */
interface RecordedSnapshotOpts {
  measurements: boolean;
  annotations: boolean;
  inspector: boolean;
  probe: boolean;
  colorbar?: boolean;
}

function recordingAdapter(sink: { opts?: RecordedSnapshotOpts }): ExportSceneAdapter {
  return {
    // withColorMode swaps then restores around the capture.
    setExportColorMode: () => {},
    currentColorMode: () => 'rgb',
    hasRgb: () => false,
    hasIntensity: () => true,
    hasClassification: () => false,
    hasNormals: () => false,
    localBoundsAabb: () => [0, 0, 0, 10, 10, 5],
    snapshot: async (opts: RecordedSnapshotOpts) => {
      sink.opts = opts;
      return new Blob([], { type: 'image/png' });
    },
    sourceName: () => 'plumbing-fixture',
    sourcePointCount: () => 1000,
    residentPointCount: () => 1000,
    crsLabel: () => null,
  } as unknown as ExportSceneAdapter;
}

describe('runStudioExport → adapter.snapshot', () => {
  it('requests colorbar: true (alongside the existing inspector/probe bakes)', async () => {
    const sink: { opts?: RecordedSnapshotOpts } = {};
    const adapter = recordingAdapter(sink);
    const context = { adapter, canvas: { width: 100, height: 100 } } as unknown as ExportContext;
    // No width/height ⇒ the snapshot (not renderFigure) path. The report-card
    // composition afterwards uses canvas APIs Node lacks and throws, but the
    // snapshot() call — where colorbar is requested — has already run, so we
    // catch the later error and assert on the recorded opts.
    await runStudioExport(context, 'height-map', 'Height Map', 'elevation', {}).catch(() => {
      /* Node has no canvas for the scan-report composition — expected. */
    });
    expect(sink.opts).toBeDefined();
    expect(sink.opts!.colorbar).toBe(true);
    // Regression fence: the pre-existing on-screen-data bakes must not have
    // been disturbed by the colorbar addition.
    expect(sink.opts!.inspector).toBe(true);
    expect(sink.opts!.probe).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2 — the Viewer export adapter delegates colorbar to viewer.snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drive the REAL `_buildExportAdapter()` against a fake `viewer` whose
 * `snapshot()` records its options. The adapter's `snapshot` closure is the
 * only member we invoke, and it only calls `viewer.snapshot(...)`, so a
 * minimal fake exercises the actual shipped delegation.
 */
function adapterOverFakeViewer(sink: { opts?: RecordedSnapshotOpts }): ExportSceneAdapter {
  const fakeViewer = {
    _streaming: null,
    _clouds: new Map(),
    snapshot: async (opts: RecordedSnapshotOpts) => {
      sink.opts = opts;
      return new Blob([], { type: 'image/png' });
    },
  } as unknown as Viewer;
  // `_buildExportAdapter` is a private prototype method; reach it through an
  // untyped view so the call typechecks, then invoke the real body against
  // the fake `viewer` it closes over.
  const build = (Viewer.prototype as unknown as {
    _buildExportAdapter: (this: Viewer) => ExportSceneAdapter;
  })._buildExportAdapter;
  return build.call(fakeViewer);
}

describe('Viewer export adapter → viewer.snapshot', () => {
  it('forwards colorbar: true through to viewer.snapshot verbatim', async () => {
    const sink: { opts?: RecordedSnapshotOpts } = {};
    const adapter = adapterOverFakeViewer(sink);
    await adapter.snapshot({
      measurements: true,
      annotations: false,
      inspector: true,
      probe: false,
      colorbar: true,
    });
    expect(sink.opts).toBeDefined();
    expect(sink.opts!.colorbar).toBe(true);
    // The other flags ride through unchanged.
    expect(sink.opts!.measurements).toBe(true);
    expect(sink.opts!.inspector).toBe(true);
  });

  it('normalises a missing colorbar flag to false (no accidental burn-in)', async () => {
    const sink: { opts?: RecordedSnapshotOpts } = {};
    const adapter = adapterOverFakeViewer(sink);
    await adapter.snapshot({
      measurements: false,
      annotations: false,
      inspector: false,
      probe: false,
    });
    expect(sink.opts!.colorbar).toBe(false);
  });
});
