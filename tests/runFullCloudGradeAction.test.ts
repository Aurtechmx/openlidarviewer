/**
 * runFullCloudGradeAction.test.ts — the stale-cloud guard (Upgrade #6).
 *
 * The full-cloud grade decodes a multi-million-point sample over several
 * seconds. If the streaming cloud is detached or swapped while it runs, the
 * result describes a scan that's no longer shown and must NOT paint over the
 * new (or absent) cloud's panel. gradeFullCloud is mocked so the test can mutate
 * the viewer's active cloud mid-grade without a real GPU/decoder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { gradeFullCloud } = vi.hoisted(() => ({ gradeFullCloud: vi.fn() }));
vi.mock('../src/render/streaming/fullCloudGradeAdapter', () => ({ gradeFullCloud }));
vi.mock('../src/render/streaming/sampleGrade', () => ({
  gradeSampleDensity: vi.fn(() => ({})),
  summarizeSampleGrade: vi.fn(() => ['Density: Moderate']),
}));

import { runFullCloudGrade } from '../src/render/streaming/runFullCloudGradeAction';
import { summarizeSampleGrade } from '../src/render/streaming/sampleGrade';

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

type FakeViewer = { streamingCloud: { crs: () => null } | null; streamingDecoder: unknown };
const mkViewer = (cloud: FakeViewer['streamingCloud'], decoder: unknown = {}): FakeViewer => ({
  streamingCloud: cloud,
  streamingDecoder: decoder,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (viewer: FakeViewer, panel: any) => runFullCloudGrade({ viewer, panel } as any);

describe('runFullCloudGrade — stale-cloud guard', () => {
  beforeEach(() => gradeFullCloud.mockReset());

  it('paints the result when the active cloud is unchanged', async () => {
    const viewer = mkViewer(sourceA);
    gradeFullCloud.mockResolvedValue(RUN);
    const panel = makePanel();
    await run(viewer, panel);
    expect(panel.setGradeResult).toHaveBeenCalledTimes(1);
  });

  it('discards the result when the cloud is REPLACED mid-grade', async () => {
    const viewer = mkViewer(sourceA);
    gradeFullCloud.mockImplementation(async () => {
      viewer.streamingCloud = sourceB; // user opened a different scan
      return RUN;
    });
    const panel = makePanel();
    await run(viewer, panel);
    expect(panel.setGradeResult).not.toHaveBeenCalled();
  });

  it('discards the result when the cloud is DETACHED mid-grade', async () => {
    const viewer = mkViewer(sourceA);
    gradeFullCloud.mockImplementation(async () => {
      viewer.streamingCloud = null; // scan closed
      return RUN;
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
    gradeFullCloud.mockResolvedValue(RUN);
    vi.mocked(summarizeSampleGrade).mockClear();
  });

  // The action builds the scan's ONE SpatialContext from `source.crs()`, and
  // the facade reads the whole CrsInfo, so these stand-ins carry the fields a
  // real detection always supplies. The unit columns under test are unchanged.
  const CRS_BASE = { source: 'wkt' as const, name: 'Test CRS', isGeographic: false };

  const runWithCrs = async (crs: unknown) => {
    const cloud = { crs: () => crs } as FakeViewer['streamingCloud'];
    const panel = makePanel();
    await run(mkViewer(cloud), panel);
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
});
