/**
 * The image export hands back a promise that settles when the export is done,
 * so the button that started it can stay disabled for the whole run. A failed
 * export settles too (the button comes back for a retry) and reports the
 * failure, never success.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/io/download', () => ({ triggerDownload: vi.fn() }));
vi.mock('../src/diagnostics/usageCounters', () => ({ increment: vi.fn() }));

import { readFileSync } from 'node:fs';
import { exportImageAction, settleFileExport, type ExportImageActionDeps } from '../src/app/exportImageAction';
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

describe('settleFileExport', () => {
  it('shows the failure, records it in the error ledger and resolves so the button comes back', async () => {
    const g = globalThis as { __olvErrorLedger?: unknown[] };
    g.__olvErrorLedger = [];
    const progress = { setProgress: vi.fn(), setError: vi.fn() };
    const err = new RangeError('disk full');
    await expect(settleFileExport(Promise.reject(err), progress)).resolves.toBeUndefined();
    expect(progress.setError).toHaveBeenCalledWith('Export failed: disk full');
    expect(g.__olvErrorLedger).toHaveLength(1);
    expect((g.__olvErrorLedger[0] as unknown[]).slice(1)).toEqual([1, 'RangeError']);
  });

  it('resolves without an error on success', async () => {
    const progress = { setProgress: vi.fn(), setError: vi.fn() };
    await settleFileExport(Promise.resolve('ok'), progress);
    expect(progress.setError).not.toHaveBeenCalled();
  });
});

describe('main.ts export callbacks hand back their promise', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const panel = main.slice(main.indexOf('const exportPanel = new ExportPanel({'));
  const callback = (name: string): string => {
    const start = panel.indexOf(`  ${name}: (`);
    expect(start, `${name} is wired`).toBeGreaterThan(-1);
    const next = panel.slice(start + 1).search(/\n  [A-Za-z]+: /);
    return panel.slice(start, start + 1 + next);
  };

  it('returns the format export, so its button waits for it', () => {
    expect(callback('onExport')).toMatch(/return settleFileExport\(/);
  });

  it('returns the image export, so its button waits for it', () => {
    expect(callback('onExportImage')).toMatch(/onExportImage: \(mode\) =>\s*exportImageAction\(/);
  });

  it('returns the report build, so its button waits for it', () => {
    expect(callback('onExportReport')).toMatch(/return generateReportPdf\(/);
  });
});
