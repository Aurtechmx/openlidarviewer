/**
 * Findings ledger safety: the export status reflects what happened, switching
 * scans keeps each scan's findings, and Clear all can be undone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeDom } from './support/measurePanelDom';
import { SessionFindings } from '../src/render/measure/sessionFindings';
import type { ReportFinding } from '../src/render/measure/reportManifest';
import { buildFindingsPanel, type FindingsExportResult } from '../src/ui/findingsPanel';

beforeEach(() => installFakeDom());

const finding = (label: string): ReportFinding => ({ label, value: 1, unit: 'm' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = (root: any, sel: string): any => root.querySelector(sel);
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function mount(result: () => Promise<FindingsExportResult>, findings = new SessionFindings()) {
  if (findings.count === 0) findings.add(finding('A'));
  const panel = buildFindingsPanel({
    findings,
    collectMeasurements: () => Promise.resolve([]),
    exportReport: result,
  });
  return { findings, element: panel.element };
}

describe('findings export status', () => {
  it('a refused export never reports "Exported"', async () => {
    const { element, findings } = mount(() => Promise.resolve('refused'));
    q(element, '.olv-findings-export').click();
    await flush();
    const text = q(element, '.olv-findings-status').textContent as string;
    expect(text).not.toMatch(/export/i);
    expect(text).not.toMatch(/download started/i);
    expect(findings.count).toBe(1);
  });

  it('a successful export says the download started, never "saved"', async () => {
    const { element } = mount(() => Promise.resolve('downloaded'));
    q(element, '.olv-findings-export').click();
    await flush();
    const text = q(element, '.olv-findings-status').textContent as string;
    expect(text).toBe('Report download started.');
    expect(text).not.toMatch(/saved/i);
  });

  it('a failed export shows a retry-able error and keeps the findings', async () => {
    const { element, findings } = mount(() => Promise.reject(new Error('boom')));
    q(element, '.olv-findings-export').click();
    await flush();
    expect(q(element, '.olv-findings-status').textContent).toMatch(/try again/i);
    expect(findings.count).toBe(1);
    expect(q(element, '.olv-findings-export').disabled).toBe(false);
  });

  it('disables the export button while the export runs', async () => {
    let finish!: (r: FindingsExportResult) => void;
    const { element } = mount(() => new Promise((r) => { finish = r; }));
    q(element, '.olv-findings-export').click();
    expect(q(element, '.olv-findings-export').disabled).toBe(true);
    finish('downloaded');
    await flush();
    expect(q(element, '.olv-findings-export').disabled).toBe(false);
  });
});

describe('findings per scan', () => {
  it('findings on scan A survive switching to B and back', () => {
    const f = new SessionFindings();
    f.retarget('scan-A');
    f.add(finding('on A'));
    f.retarget('scan-B');
    expect(f.all).toEqual([]);
    f.add(finding('on B'));
    f.retarget('scan-A');
    expect(f.all.map((x) => x.label)).toEqual(['on A']);
    f.retarget('scan-B');
    expect(f.all.map((x) => x.label)).toEqual(['on B']);
  });

  it('drops a scan\'s findings once that scan is removed', () => {
    const f = new SessionFindings();
    f.retarget('scan-A');
    f.add(finding('on A'));
    f.retarget('scan-B');
    f.forget('scan-A');
    f.retarget('scan-A');
    expect(f.all).toEqual([]);
  });
});

describe('Clear all', () => {
  it('can be undone from the panel status', () => {
    const findings = new SessionFindings();
    findings.add(finding('one'));
    findings.add(finding('two'));
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => Promise.resolve([]),
      exportReport: () => Promise.resolve('downloaded'),
    });
    q(element, '.olv-findings-clear').click();
    expect(findings.count).toBe(0);
    const undo = q(element, '.olv-findings-undo');
    expect(undo).not.toBeNull();
    undo.click();
    expect(findings.all.map((x) => x.label)).toEqual(['one', 'two']);
    expect(q(element, '.olv-findings-list').querySelectorAll('.olv-findings-row')).toHaveLength(2);
  });
});
