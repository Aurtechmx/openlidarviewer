import { describe, it, expect } from 'vitest';
import {
  analysisFreshnessBreach,
  FRESHNESS_REFUSALS,
  type AnalysisFreshnessStamp,
} from '../src/science/analysisFreshness';

/** The real comparator's semantics: two nulls are NOT the same target. */
const sameTarget = (a: string | null, b: string | null): boolean => a !== null && a === b;

const stamp = (over: Partial<AnalysisFreshnessStamp> = {}): AnalysisFreshnessStamp => ({
  targetId: 'scan_1',
  classificationEpoch: 3,
  crsRevision: 7,
  coverageMode: 'full',
  ...over,
});

describe('analysisFreshnessBreach', () => {
  it('passes when every fact still matches', () => {
    expect(
      analysisFreshnessBreach(stamp(), { targetId: 'scan_1', classificationEpoch: 3, crsRevision: 7 }, sameTarget),
    ).toBeNull();
  });

  it('catches a classification edit the scan check cannot see', () => {
    // The defect: same scan, edited classes, exported anyway behind a caveat.
    expect(
      analysisFreshnessBreach(stamp(), { targetId: 'scan_1', classificationEpoch: 4, crsRevision: 7 }, sameTarget),
    ).toBe('classification');
  });

  it('catches a CRS override the scan check cannot see', () => {
    expect(
      analysisFreshnessBreach(stamp(), { targetId: 'scan_1', classificationEpoch: 3, crsRevision: 8 }, sameTarget),
    ).toBe('frame');
  });

  it('reports a scan swap as a swap, not as its side effects', () => {
    // A different scan usually carries a different epoch and frame too. Naming
    // the epoch would send the reader to re-classify when they must re-run.
    const breach = analysisFreshnessBreach(
      stamp(),
      { targetId: 'scan_2', classificationEpoch: 99, crsRevision: 99 },
      sameTarget,
    );
    expect(breach).toBe('scan');
  });

  it('treats two streaming nulls as a breach, never as a match', () => {
    // `activeId` is null for every streaming scan, which is why the stamp
    // carries the export-target id and the comparator refuses null === null.
    expect(
      analysisFreshnessBreach(
        stamp({ targetId: null }),
        { targetId: null, classificationEpoch: 3, crsRevision: 7 },
        sameTarget,
      ),
    ).toBe('scan');
  });

  it('is inert with no stamp, leaving the caller its own null checks', () => {
    expect(
      analysisFreshnessBreach(null, { targetId: 'scan_1', classificationEpoch: 0, crsRevision: 0 }, sameTarget),
    ).toBeNull();
  });

  it('names what changed and what to do in every refusal', () => {
    for (const [kind, text] of Object.entries(FRESHNESS_REFUSALS)) {
      expect(text, kind).toMatch(/nothing was written/);
      expect(text, kind).toMatch(/Re-run/);
    }
  });
});
