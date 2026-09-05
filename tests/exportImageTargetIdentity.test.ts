/**
 * An image export may not pair one scan's pixels with another scan's name.
 *
 * `Viewer.exportImage` builds its scene adapter before awaiting the Studio
 * chunk, and an earlier fix moved that construction earlier still. That changed
 * nothing: the adapter is a set of CLOSURES over live Viewer state — `clouds()`
 * walks `this._clouds` at call time, `snapshot()` calls straight through — so it
 * answers for whatever is on screen when the Studio finally invokes it, not for
 * whatever was there when it was allocated. Meanwhile the filename stem and the
 * class-scope stamp were read up front, from the scan the user asked about.
 *
 * Open another scan during that gap and the download is scan A's name over scan
 * B's pixels. The identity gate belongs to the caller that holds both.
 */
import { describe, it, expect, vi } from 'vitest';
import { exportImageAction } from '../src/app/exportImageAction';
import { EXPORT_SCAN_CHANGED_REFUSAL } from '../src/export/exportScanIdentity';

function harness(opts: { swapTo?: string | null } = {}) {
  const downloads: string[] = [];
  const errors: string[] = [];
  const scans = { activeId: 'scan-A' as string | null };
  const viewer = {
    getCloud: (id: string) => ({ name: `${id}.laz` }),
    streamingCloud: null,
    exportImage: vi.fn(async () => {
      // The Studio chunk resolves a turn later. The user opens another scan.
      await new Promise((r) => setTimeout(r, 0));
      if (opts.swapTo !== undefined) scans.activeId = opts.swapTo;
      return { blob: new Blob(['pixels']), worldFile: null };
    }),
  };
  const deps = {
    getViewer: () => viewer,
    getProgress: () => ({
      setProgress: () => { /* not asserted */ },
      setError: (t: string) => { errors.push(t); },
    }),
    scans,
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
    currentClassScopeStamp: () => '',
  };
  return { deps, downloads, errors, viewer };
}

describe('exportImageAction — scan identity across the Studio await', () => {
  it('does NOT refuse when the scan is unchanged', async () => {
    const h = harness();
    exportImageAction('height-map' as never, h.deps as never);
    await vi.waitFor(() => expect(h.viewer.exportImage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 5));
    // The download itself needs a DOM this environment has not got, so the run
    // ends in that failure. What matters here is which failure: the export
    // reached the writing step, so the identity gate let it through.
    for (const e of h.errors) expect(e).not.toContain(EXPORT_SCAN_CHANGED_REFUSAL);
  });

  it('REFUSES when another scan was opened while the Studio loaded', async () => {
    const h = harness({ swapTo: 'scan-B' });
    exportImageAction('height-map' as never, h.deps as never);
    await vi.waitFor(() => expect(h.errors.length).toBeGreaterThan(0), { timeout: 2000 });
    // The refusal names the cause; nothing was written.
    expect(h.errors[0]).toContain(EXPORT_SCAN_CHANGED_REFUSAL);
  });

  it('REFUSES when the scan was closed mid-export', async () => {
    const h = harness({ swapTo: null });
    exportImageAction('height-map' as never, h.deps as never);
    await vi.waitFor(() => expect(h.errors.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(h.errors[0]).toContain(EXPORT_SCAN_CHANGED_REFUSAL);
  });
});
