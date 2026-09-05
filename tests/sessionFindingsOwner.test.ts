/**
 * The findings ledger belongs to one scan.
 *
 * The ledger is deliberately kept alive across panel re-renders, and nothing
 * bound it to a scan. Findings measured on A therefore survived opening B, and
 * `exportFindingsReport` then read B's dataset name, CRS and classification
 * epoch to build ONE manifest describing ONE dataset — filled with A's numbers.
 * The report schema cannot express "these findings came from somewhere else",
 * so the ledger must not be able to reach that state.
 */
import { describe, it, expect } from 'vitest';
import { SessionFindings } from '../src/render/measure/sessionFindings';
import type { ReportFinding } from '../src/render/measure/reportManifest';

const finding = (label: string): ReportFinding =>
  ({ label, value: 1, unit: 'm' } as unknown as ReportFinding);

describe('SessionFindings ownership', () => {
  it('starts unowned', () => {
    expect(new SessionFindings().ownerId).toBeNull();
  });

  it('claims the scan it is retargeted to, discarding nothing when empty', () => {
    const f = new SessionFindings();
    expect(f.retarget('scan-A')).toBe(0);
    expect(f.ownerId).toBe('scan-A');
  });

  it('keeps everything when re-asserting the SAME owner, so a re-render is free', () => {
    const f = new SessionFindings();
    f.retarget('scan-A');
    f.add(finding('one'));
    f.add(finding('two'));
    expect(f.retarget('scan-A')).toBe(0);
    expect(f.count).toBe(2);
  });

  it('drops another scan\'s findings and reports how many, rather than losing them silently', () => {
    const f = new SessionFindings();
    f.retarget('scan-A');
    f.add(finding('measured on A'));
    f.add(finding('also on A'));
    // The user opens B.
    expect(f.retarget('scan-B')).toBe(2);
    expect(f.count).toBe(0);
    expect(f.ownerId).toBe('scan-B');
  });

  it('treats closing the scan as a change too', () => {
    const f = new SessionFindings();
    f.retarget('scan-A');
    f.add(finding('on A'));
    expect(f.retarget(null)).toBe(1);
    expect(f.ownerId).toBeNull();
  });

  it('clear() releases the owner as well as the rows', () => {
    const f = new SessionFindings();
    f.retarget('scan-A');
    f.add(finding('on A'));
    f.clear();
    expect(f.count).toBe(0);
    expect(f.ownerId).toBeNull();
    // A fresh scan can then claim it without anything being reported as dropped.
    expect(f.retarget('scan-B')).toBe(0);
  });

  it('THE REGRESSION: findings never survive a scan change into a report', () => {
    const f = new SessionFindings();
    f.retarget('scan-A');
    f.add(finding('volume on A'));
    f.retarget('scan-B');
    // Whatever a report built now stamps as its dataset, there is nothing from
    // A left to misattribute to it.
    expect(f.all).toEqual([]);
  });
});
