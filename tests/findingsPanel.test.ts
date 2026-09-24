/**
 * findingsPanel.test.ts — the durable findings ledger surface.
 *
 * Drives the panel through the shared recording DOM stub: adding measurements
 * appends to the ledger, remove drops the right row, export hands the current
 * ledger to the host, and an empty ledger disables export. The panel keeps each
 * finding's band and caveats visible (they are the honesty notes).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeDom } from './support/measurePanelDom';
import { SessionFindings } from '../src/render/measure/sessionFindings';
import type { ReportFinding } from '../src/render/measure/reportManifest';
import { buildFindingsPanel } from '../src/ui/findingsPanel';

beforeEach(() => installFakeDom());

const finding = (label: string, value: number): ReportFinding => ({
  label,
  value,
  unit: 'm³',
  sigma: 5,
  confidence: 'medium',
  caveats: ['assumes spatial independence'],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = (root: any, sel: string): any => root.querySelector(sel);

describe('buildFindingsPanel', () => {
  it('starts empty: export/clear disabled, empty note shown', () => {
    const findings = new SessionFindings();
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => Promise.resolve([]),
      exportReport: () => {},
    });
    expect(q(element, '.olv-findings-empty')).not.toBeNull();
    expect(q(element, '.olv-findings-export').disabled).toBe(true);
    expect(q(element, '.olv-findings-clear').disabled).toBe(true);
  });

  it('adds current measurements to the ledger and renders rows', async () => {
    const findings = new SessionFindings();
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => Promise.resolve([finding('Distance AB', 43.28), finding('Stockpile A', 612.4)]),
      exportReport: () => {},
    });
    q(element, '.olv-findings-add').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(findings.count).toBe(2);
    expect(q(element, '.olv-findings-list').querySelectorAll('.olv-findings-row')).toHaveLength(2);
    // The band and caveat travel onto the row.
    expect(q(element, '.olv-findings-value').textContent).toContain('±');
    expect(q(element, '.olv-findings-caveats').textContent).toContain('spatial independence');
    expect(q(element, '.olv-findings-export').disabled).toBe(false);
  });

  it('reports nothing to add when there are no measurements', async () => {
    const findings = new SessionFindings();
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => Promise.resolve([]),
      exportReport: () => {},
    });
    q(element, '.olv-findings-add').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(findings.count).toBe(0);
    expect(q(element, '.olv-findings-status').textContent).toMatch(/no placed measurements/i);
  });

  // ANALYSIS-F7: the status line is the only feedback surface for add/remove/
  // export/clear, so it must be an accessible live region, and a rejecting
  // collectMeasurements() must report something instead of vanishing as an
  // unhandled rejection with the button silently re-enabling.
  it('wires the status line as an accessible live region', () => {
    const findings = new SessionFindings();
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => Promise.resolve([]),
      exportReport: () => {},
    });
    const status = q(element, '.olv-findings-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('reports a failure and re-enables the button when collectMeasurements rejects', async () => {
    const findings = new SessionFindings();
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => Promise.reject(new Error('chunk load failed')),
      exportReport: () => {},
    });
    const addBtn = q(element, '.olv-findings-add');
    addBtn.click();
    expect(addBtn.disabled).toBe(true);
    // Flush the rejected promise chain.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(findings.count).toBe(0);
    expect(
      q(element, '.olv-findings-status').textContent,
      'a rejection must not leave the status line silently blank',
    ).toMatch(/could not read the current measurements/i);
    expect(addBtn.disabled).toBe(false);
  });

  it('remove drops exactly that finding', () => {
    const findings = new SessionFindings();
    findings.add(finding('A', 1));
    findings.add(finding('B', 2));
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => Promise.resolve([]),
      exportReport: () => {},
    });
    // Remove the first row.
    q(element, '.olv-findings-list').querySelectorAll('.olv-findings-remove')[0].click();
    expect(findings.count).toBe(1);
    expect(findings.all[0].label).toBe('B');
  });

  it('export hands the current ledger to the host; clear empties it', () => {
    const findings = new SessionFindings();
    findings.add(finding('A', 1));
    let exported: readonly ReportFinding[] | null = null;
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => Promise.resolve([]),
      exportReport: (f) => {
        exported = f;
      },
    });
    q(element, '.olv-findings-export').click();
    expect(exported).not.toBeNull();
    expect(exported!).toHaveLength(1);
    q(element, '.olv-findings-clear').click();
    expect(findings.count).toBe(0);
    expect(q(element, '.olv-findings-export').disabled).toBe(true);
  });
});
