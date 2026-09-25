/**
 * observatoryStateChip.test.ts — OB-UI-02: each badge shows the SPEC-exact
 * word, and origin/basis are read from the kernel's own value (never
 * inferred), so `DECLARED` never renders `ASSUMED ORIGIN` or vice versa.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';

beforeAll(installRecordingDom);

const { originChip, basisChip, suggestedStationChip, OBSERVATORY_BADGE_WORDS } = await import('../src/ui/observatory/stateChip');

const textOf = (node: HTMLElement) => (node as unknown as RecordingEl).textContent;

describe('origin badges', () => {
  it('DECLARED -> "DECLARED ORIGIN"', () => {
    expect(textOf(originChip('DECLARED'))).toContain('DECLARED ORIGIN');
  });
  it('ASSUMED -> "ASSUMED ORIGIN", never DECLARED', () => {
    const text = textOf(originChip('ASSUMED'));
    expect(text).toContain('ASSUMED ORIGIN');
    expect(text).not.toContain('DECLARED ORIGIN');
  });
  it('every RECONSTRUCTED_* confidence level -> "RECONSTRUCTED ORIGIN"', () => {
    expect(textOf(originChip('RECONSTRUCTED_STRONG'))).toContain('RECONSTRUCTED ORIGIN');
    expect(textOf(originChip('RECONSTRUCTED_MODERATE'))).toContain('RECONSTRUCTED ORIGIN');
    expect(textOf(originChip('RECONSTRUCTED_WEAK'))).toContain('RECONSTRUCTED ORIGIN');
  });
});

describe('basis badges', () => {
  it('full -> "SOURCE COMPLETE"', () => {
    expect(textOf(basisChip('full'))).toContain('SOURCE COMPLETE');
  });
  it('resident-only -> "RESIDENT ONLY"', () => {
    expect(textOf(basisChip('resident-only'))).toContain('RESIDENT ONLY');
  });
  it('sampled -> "SAMPLED"', () => {
    expect(textOf(basisChip('sampled'))).toContain('SAMPLED');
  });
});

it('the suggested-station badge reads "SUGGESTED STATION"', () => {
  expect(textOf(suggestedStationChip())).toContain('SUGGESTED STATION');
});

it('every badge word is one of SPEC OB-UI-02\'s seven', () => {
  const spec = ['DECLARED ORIGIN', 'ASSUMED ORIGIN', 'RECONSTRUCTED ORIGIN', 'SOURCE COMPLETE', 'RESIDENT ONLY', 'SAMPLED', 'SUGGESTED STATION'];
  for (const word of OBSERVATORY_BADGE_WORDS) expect(spec).toContain(word);
  for (const word of spec) expect(OBSERVATORY_BADGE_WORDS).toContain(word);
});
