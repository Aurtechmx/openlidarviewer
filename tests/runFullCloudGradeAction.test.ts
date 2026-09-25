/**
 * runFullCloudGradeAction.test.ts — the stale-cloud guard (Upgrade #6).
 *
 * The full-cloud grade decodes a multi-million-point sample over several
 * seconds. If the streaming cloud is detached or swapped while it runs, the
 * result describes a scan that's no longer shown and must NOT paint over the
 * new (or absent) cloud's panel. gradeFullCloud is mocked so the test can mutate
 * the viewer's active cloud mid-grade without a real GPU/decoder.
 *
 * Also pins how the panel renders the adapter's refusal for a source that
 * states no point total: the reason where the coverage label goes, and no
 * summary lines at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { gradeFullCloud } = vi.hoisted(() => ({ gradeFullCloud: vi.fn() }));
vi.mock('../src/render/streaming/fullCloudGradeAdapter', () => ({ gradeFullCloud }));
vi.mock('../src/render/streaming/sampleGrade', () => ({
  gradeSampleDensity: vi.fn(() => ({})),
  summarizeSampleGrade: vi.fn(() => ['Density: Moderate']),
}));

import {
  runFullCloudGrade,
  type GradeActionHost,
} from '../src/render/streaming/runFullCloudGradeAction';
import { summarizeSampleGrade } from '../src/render/streaming/sampleGrade';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { ChunkDecoder } from '../src/io/copc/copcChunkDecode';

function makePanel() {
  return {
    setGradeBusy: vi.fn(),
    setGradeResult: vi.fn(),
    setGradeError: vi.fn(),
    setGradeCancelled: vi.fn(),
  };
}
const sourceA = { crs: () => null };
const sourceB = { crs: () => null };
const RUN = { coverage: { label: 'L', note: 'N' }, grade: {} };
const GRADED = { kind: 'graded', run: RUN };

type FakeViewer = { streamingCloud: { crs: () => null } | null; streamingDecoder: unknown };
const mkViewer = (cloud: FakeViewer['streamingCloud'], decoder: unknown = {}): FakeViewer => ({
  streamingCloud: cloud,
  streamingDecoder: decoder,
});
/**
 * The RESOLVED frame is now an argument. The default mirrors a scan with no
 * resolved CRS, which is what these guard tests assume.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (viewer: FakeViewer, panel: any, crs: unknown = null) =>
  runFullCloudGrade({ viewer, panel, context: spatialContextFrom(crs as never) } as any);

describe('runFullCloudGrade — stale-cloud guard', () => {
  beforeEach(() => gradeFullCloud.mockReset());

  it('paints the result when the active cloud is unchanged', async () => {
    const viewer = mkViewer(sourceA);
    gradeFullCloud.mockResolvedValue(GRADED);
    const panel = makePanel();
    await run(viewer, panel);
    expect(panel.setGradeResult).toHaveBeenCalledTimes(1);
  });

  it('discards the result when the cloud is REPLACED mid-grade', async () => {
    const viewer = mkViewer(sourceA);
    gradeFullCloud.mockImplementation(async () => {
      viewer.streamingCloud = sourceB; // user opened a different scan
      return GRADED;
    });
    const panel = makePanel();
    await run(viewer, panel);
    expect(panel.setGradeResult).not.toHaveBeenCalled();
  });

  it('discards the result when the cloud is DETACHED mid-grade', async () => {
    const viewer = mkViewer(sourceA);
    gradeFullCloud.mockImplementation(async () => {
      viewer.streamingCloud = null; // scan closed
      return GRADED;
    });
    const panel = makePanel();
    await run(viewer, panel);
    expect(panel.setGradeResult).not.toHaveBeenCalled();
  });

  it('errors honestly (no decode) when no streaming cloud is open', async () => {
    const panel = makePanel();
    await run(mkViewer(null, null), panel);
    expect(panel.setGradeError).toHaveBeenCalled();
    expect(gradeFullCloud).not.toHaveBeenCalled();
  });
});

describe('runFullCloudGrade — unit-confirmation gate', () => {
  beforeEach(() => {
    gradeFullCloud.mockReset();
    gradeFullCloud.mockResolvedValue(GRADED);
    vi.mocked(summarizeSampleGrade).mockClear();
  });

  // The action is HANDED the scan's ONE SpatialContext (built at the app
  // boundary from the resolved CRS), and the facade reads the whole CrsInfo, so
  // these stand-ins carry the fields a real detection always supplies.
  const CRS_BASE = { source: 'wkt' as const, name: 'Test CRS', isGeographic: false };

  const runWithCrs = async (crs: unknown, sourceCrs: unknown = crs) => {
    // `sourceCrs` is what the FILE declares; `crs` is what the app resolved to.
    // They differ only in the override test below.
    const cloud = { crs: () => sourceCrs } as FakeViewer['streamingCloud'];
    const panel = makePanel();
    await run(mkViewer(cloud), panel, crs);
    return panel;
  };

  it('summarises unconfirmed for a CRS-less cloud (metre factor never applied)', async () => {
    await runWithCrs(null);
    expect(vi.mocked(summarizeSampleGrade).mock.calls[0][1]).toBe(false);
  });

  it("summarises unconfirmed for an unknown-unit CRS (linearUnitToMetres:1 placeholder)", async () => {
    await runWithCrs({ ...CRS_BASE, linearUnit: 'unknown', linearUnitToMetres: 1 });
    expect(vi.mocked(summarizeSampleGrade).mock.calls[0][1]).toBe(false);
  });

  it('summarises confirmed for a real metre CRS', async () => {
    await runWithCrs({ ...CRS_BASE, linearUnit: 'metre', linearUnitToMetres: 1 });
    expect(vi.mocked(summarizeSampleGrade).mock.calls[0][1]).toBe(true);
  });

  it('summarises confirmed for a foot CRS', async () => {
    await runWithCrs({ ...CRS_BASE, linearUnit: 'foot', linearUnitToMetres: 0.3048 });
    expect(vi.mocked(summarizeSampleGrade).mock.calls[0][1]).toBe(true);
  });

  it('grades in the RESOLVED frame, not the one the file declares', async () => {
    // The operator has overridden a file that declares no usable unit with a
    // real metre CRS. Reading the header here would gate the grade off the
    // declaration the app has already replaced, so the figures would be labelled
    // "per source unit" for a scan the rest of the app measures in metres.
    await runWithCrs(
      { ...CRS_BASE, linearUnit: 'metre', linearUnitToMetres: 1 },
      { ...CRS_BASE, linearUnit: 'unknown', linearUnitToMetres: 1 },
    );
    expect(vi.mocked(summarizeSampleGrade).mock.calls[0][1]).toBe(true);
  });

  it('does not claim metres just because the FILE declares them', async () => {
    // The mirror case, and the one that matters more: the header says metres,
    // the operator resolved to Local coordinates. The grade must follow the
    // resolution and stop claiming an SI unit.
    await runWithCrs(null, { ...CRS_BASE, linearUnit: 'metre', linearUnitToMetres: 1 });
    expect(vi.mocked(summarizeSampleGrade).mock.calls[0][1]).toBe(false);
  });
});

describe('runFullCloudGrade — a source that states no point total', () => {
  beforeEach(() => {
    gradeFullCloud.mockReset();
    vi.mocked(summarizeSampleGrade).mockClear();
  });

  const UNAVAILABLE = {
    kind: 'unavailable',
    headline: 'Full-cloud grade unavailable: this format states no point total',
    note: 'The per-tile counts a grade would add up are decode-admission estimates.',
  };

  it('shows the reason in place of a coverage label, with no figures', async () => {
    gradeFullCloud.mockResolvedValue(UNAVAILABLE);
    const panel = makePanel();
    await run(mkViewer(sourceA), panel);
    expect(panel.setGradeResult).toHaveBeenCalledWith(UNAVAILABLE.headline, [], UNAVAILABLE.note);
    // No density/extent lines are summarised: there is no grade behind them.
    expect(vi.mocked(summarizeSampleGrade)).not.toHaveBeenCalled();
  });

  it('is a result, not an error (the refusal is deliberate, nothing failed)', async () => {
    gradeFullCloud.mockResolvedValue(UNAVAILABLE);
    const panel = makePanel();
    await run(mkViewer(sourceA), panel);
    expect(panel.setGradeError).not.toHaveBeenCalled();
    expect(panel.setGradeCancelled).not.toHaveBeenCalled();
  });

  it('discards the refusal too when the cloud is swapped mid-grade', async () => {
    const viewer = mkViewer(sourceA);
    gradeFullCloud.mockImplementation(async () => {
      viewer.streamingCloud = sourceB;
      return UNAVAILABLE;
    });
    const panel = makePanel();
    await run(viewer, panel);
    expect(panel.setGradeResult).not.toHaveBeenCalled();
  });
});

describe('runFullCloudGrade — host is a plain object, not a Viewer (render-F5)', () => {
  // `viewer` is typed `GradeActionHost`, the structural slice the action
  // reads (streamingCloud + streamingDecoder) — the same boundary
  // `StreamingHost` (streamingAttach.ts) and `StreamingRendererHost`
  // (StreamingRenderer.ts) draw. No `Viewer` import and no cast on `viewer`
  // itself anywhere in this block: a plain object literal satisfies the
  // parameter directly. (The nested `StreamingSource`/`ChunkDecoder` fakes
  // still cast, same as `streamingAttach.test.ts`'s `node()` helper — those
  // two heavy domain interfaces are orthogonal to this finding.)
  const fakeCloud = { crs: () => null } as unknown as StreamingSource;
  const fakeDecoder = {} as unknown as ChunkDecoder;

  beforeEach(() => {
    gradeFullCloud.mockReset();
    vi.mocked(summarizeSampleGrade).mockClear();
  });

  it('grades and paints the result from a plain-object host', async () => {
    const host: GradeActionHost = { streamingCloud: fakeCloud, streamingDecoder: fakeDecoder };
    gradeFullCloud.mockResolvedValue(GRADED);
    const panel = makePanel();
    await runFullCloudGrade({
      viewer: host,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      panel: panel as any,
      context: spatialContextFrom(null as never),
    });
    expect(gradeFullCloud).toHaveBeenCalledTimes(1);
    expect(panel.setGradeResult).toHaveBeenCalledTimes(1);
  });

  it('reports an error and never decodes when the host has no streaming cloud', async () => {
    const host: GradeActionHost = { streamingCloud: null, streamingDecoder: null };
    const panel = makePanel();
    await runFullCloudGrade({
      viewer: host,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      panel: panel as any,
      context: spatialContextFrom(null as never),
    });
    expect(panel.setGradeError).toHaveBeenCalledWith('Open a streaming COPC or EPT scan first.');
    expect(gradeFullCloud).not.toHaveBeenCalled();
  });

  it('surfaces a decode failure as a panel error, not a thrown exception', async () => {
    const host: GradeActionHost = { streamingCloud: fakeCloud, streamingDecoder: fakeDecoder };
    gradeFullCloud.mockRejectedValue(new Error('short chunk'));
    const panel = makePanel();
    await runFullCloudGrade({
      viewer: host,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      panel: panel as any,
      context: spatialContextFrom(null as never),
    });
    expect(panel.setGradeError).toHaveBeenCalledWith('Grade failed: short chunk');
    expect(panel.setGradeCancelled).not.toHaveBeenCalled();
  });
});
