/**
 * The image export hands back a promise that settles when the export is done,
 * so the button that started it can stay disabled for the whole run. A failed
 * export settles too (the button comes back for a retry) and reports the
 * failure, never success.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/io/download', () => ({ triggerDownload: vi.fn() }));
vi.mock('../src/diagnostics/usageCounters', () => ({ increment: vi.fn() }));

import { exportImageAction, type ExportImageActionDeps } from '../src/app/exportImageAction';
import { triggerDownload } from '../src/io/download';

function deps(exportImage: () => Promise<unknown>) {
  const progress = { setProgress: vi.fn(), setError: vi.fn() };
  const d = {
    getViewer: () => ({ exportImage, getCloud: () => ({ name: 'site.las' }), streamingCloud: null }),
    getProgress: () => progress,
    scans: { activeExportTargetId: () => 'a', activeId: 'a' },
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
    currentClassScopeStamp: () => '',
  } as unknown as ExportImageActionDeps;
  return { d, progress };
}

describe('exportImageAction settles with the export', () => {
  it('returns a promise that resolves only after the download', async () => {
    let finish: (v: unknown) => void = () => {};
    const { d } = deps(() => new Promise((r) => { finish = r; }));
    const run = exportImageAction('height-map', d) as unknown as Promise<void> | undefined;
    expect(run && typeof run.then).toBe('function');
    let settled = false;
    void run!.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ blob: new Blob(['x']) });
    await run;
    expect(settled).toBe(true);
    expect(triggerDownload).toHaveBeenCalledTimes(1);
  });

  it('settles on failure and reports the error, not success', async () => {
    vi.mocked(triggerDownload).mockClear();
    const { d, progress } = deps(() => Promise.reject(new Error('render lost')));
    const run = exportImageAction('height-map', d) as unknown as Promise<void> | undefined;
    expect(run && typeof run.then).toBe('function');
    await expect(run).resolves.toBeUndefined();
    expect(progress.setError).toHaveBeenCalledWith('Image export failed: render lost');
    expect(triggerDownload).not.toHaveBeenCalled();
  });
});
