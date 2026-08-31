/**
 * reportScanQuality.test.ts — the Scan QA facts builder.
 *
 * The rule the retired `scan-acceptance` template broke: state facts read off
 * the cloud, and always disclose the boundary of the report. These cases pin
 * that the two unconditional caveats are always present, that a missing CRS /
 * datum / classification each adds its own honest caveat, and that a
 * producer-supplied classification is never described as derived.
 */

import { describe, it, expect } from 'vitest';
import { buildScanQuality, type ScanQualityInput } from '../src/report/ReportScanQuality';

const base: ScanQualityInput = {
  coordinateHeadline: 'Placed in the real world',
  positionLabel: 'On the map',
  heightLabel: 'Real-world elevation',
  positionKnown: true,
  heightKnown: true,
  hasClassification: true,
  classificationDerived: false,
  attributes: [
    { name: 'RGB colour', present: true },
    { name: 'Classification', present: true },
  ],
};

describe('buildScanQuality', () => {
  it('always states the two unconditional boundaries', () => {
    const q = buildScanQuality(base);
    expect(q.caveats).toContain(
      'This is a data-quality summary, not a survey-grade acceptance certificate.',
    );
    expect(q.caveats).toContain(
      'Vertical accuracy is not established — no checkpoint comparison was run.',
    );
  });

  it('adds no positional caveat when the scan is fully anchored', () => {
    const q = buildScanQuality(base);
    expect(q.caveats.some((c) => c.includes('horizontal CRS'))).toBe(false);
    expect(q.caveats.some((c) => c.includes('vertical datum'))).toBe(false);
    expect(q.classificationNote).toBe(
      'Classification supplied by the producer, carried through unchanged.',
    );
  });

  it('names the missing position and datum when the scan is floating', () => {
    const q = buildScanQuality({
      ...base,
      positionKnown: false,
      heightKnown: false,
      coordinateHeadline: 'Floating scan — not placed on Earth',
    });
    expect(q.caveats.some((c) => c.includes('no horizontal CRS'))).toBe(true);
    expect(q.caveats.some((c) => c.includes('No vertical datum'))).toBe(true);
  });

  it('flags a derived classification as heuristic, not a producer label', () => {
    const q = buildScanQuality({ ...base, classificationDerived: true });
    expect(q.classificationNote).toContain('derived in the viewer (heuristic)');
    expect(q.caveats.some((c) => c.includes('Derived classification is heuristic'))).toBe(true);
  });

  it('states plainly when no classification is present, and adds no derived caveat', () => {
    const q = buildScanQuality({
      ...base,
      hasClassification: false,
      classificationDerived: false,
    });
    expect(q.classificationNote).toBe('No classification present.');
    expect(q.caveats.some((c) => c.includes('Derived classification'))).toBe(false);
  });

  it('carries the attribute presence list through unchanged', () => {
    const q = buildScanQuality(base);
    expect(q.attributes).toEqual([
      { name: 'RGB colour', present: true },
      { name: 'Classification', present: true },
    ]);
  });
});
