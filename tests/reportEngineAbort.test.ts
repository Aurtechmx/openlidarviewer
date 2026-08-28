/**
 * reportEngineAbort.test.ts
 *
 * `generateReport` accepts an abort signal. When the signal is ALREADY aborted
 * before the call, the render must never start: the engine rejects with an
 * AbortError before `renderReportPdf` is reached, on both the straight-render
 * path (no timeout) and the timeout-race path (a finite timeout, where the
 * abort listener is wired inside the Promise).
 */

import { describe, it, expect } from 'vitest';
import { generateReport, DEFAULT_TEMPLATE_ID } from '../src/report';
import type { ReportInputs } from '../src/report';

function makeInputs(): ReportInputs {
  return {
    templateId: DEFAULT_TEMPLATE_ID,
    branding: {
      organisation: 'Acme Survey Co.',
      author: 'A. Inspector',
      accentColor: '#00b2ff',
      theme: 'light-technical',
    },
    cover: {
      title: 'Survey Summary',
      subtitle: 'Test',
      datasetName: 'test.copc.laz',
      exportedAt: '2026-05-28T15:30:00.000Z',
    },
    datasetRows: [{ label: 'Points', value: '1,000' }],
    visuals: [],
    annotations: [],
    measurements: [],
  };
}

describe('generateReport — already-aborted signal', () => {
  it('rejects with AbortError on the timeout-race path (finite timeout)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateReport(makeInputs(), { signal: controller.signal, timeoutMs: 30_000 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with AbortError on the straight-render path (no timeout)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateReport(makeInputs(), { signal: controller.signal, timeoutMs: Infinity }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
