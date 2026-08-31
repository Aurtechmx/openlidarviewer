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
      collectMeasurements: () => [],
      exportReport: () => {},
    });
    expect(q(element, '.olv-findings-empty')).not.toBeNull();
    expect(q(element, '.olv-findings-export').disabled).toBe(true);
    expect(q(element, '.olv-findings-clear').disabled).toBe(true);
  });

  it('adds current measurements to the ledger and renders rows', () => {
    const findings = new SessionFindings();
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => [finding('Distance AB', 43.28), finding('Stockpile A', 612.4)],
      exportReport: () => {},
    });
    q(element, '.olv-findings-add').click();
    expect(findings.count).toBe(2);
    expect(q(element, '.olv-findings-list').querySelectorAll('.olv-findings-row')).toHaveLength(2);
    // The band and caveat travel onto the row.
    expect(q(element, '.olv-findings-value').textContent).toContain('±');
    expect(q(element, '.olv-findings-caveats').textContent).toContain('spatial independence');
    expect(q(element, '.olv-findings-export').disabled).toBe(false);
  });

  it('reports nothing to add when there are no measurements', () => {
    const findings = new SessionFindings();
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => [],
      exportReport: () => {},
    });
    q(element, '.olv-findings-add').click();
    expect(findings.count).toBe(0);
    expect(q(element, '.olv-findings-status').textContent).toMatch(/no placed measurements/i);
  });

  it('remove drops exactly that finding', () => {
    const findings = new SessionFindings();
    findings.add(finding('A', 1));
    findings.add(finding('B', 2));
    const { element } = buildFindingsPanel({
      findings,
      collectMeasurements: () => [],
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
      collectMeasurements: () => [],
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
