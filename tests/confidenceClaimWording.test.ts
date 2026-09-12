/**
 * confidenceClaimWording.test.ts
 *
 * The claim register prohibits two things for the confidence surface:
 * "calibrated probability for interpolated cells" and "single undifferentiated
 * confidence" (docs/validation/claim-register.yaml, CONFIDENCE-OVERLAY). Two
 * shipped surfaces asserted both — the overlay caption opened with "Calibrated"
 * and pooled measured, interpolated and gap cells in one sentence, and the
 * terrain report printed a bare "Mean confidence N/100" whose value averages a
 * calibrated probability with an uncalibrated heuristic.
 *
 * Nothing pinned either string, so both could drift back silently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIDENCE_CAPTION } from '../src/terrain/surface/confidenceOverlay';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('confidence claim wording', () => {
  it('the overlay caption never calls the surface calibrated', () => {
    expect(CONFIDENCE_CAPTION).not.toMatch(/calibrated (trust|probability|confidence)/i);
    expect(CONFIDENCE_CAPTION).not.toMatch(/^calibrated/i);
  });

  it('the overlay caption names the measured and interpolated quantities apart', () => {
    // Measured cells carry an empirical figure; interpolated and gap cells do
    // not. A caption that mentions only one of the two is the prohibited
    // undifferentiated read, whichever one it keeps.
    expect(CONFIDENCE_CAPTION).toMatch(/measured/i);
    expect(CONFIDENCE_CAPTION).toMatch(/interpolated/i);
    expect(CONFIDENCE_CAPTION).toMatch(/calibrated against nothing/i);
  });

  it('the terrain report prints no pooled confidence row', () => {
    // A source read, not a render: the row is built inside a section array and
    // reaching it through a full report build would need a whole result.
    const src = readFileSync(resolve(ROOT, 'src/terrain/export/terrainReportContent.ts'), 'utf8');
    expect(src).not.toMatch(/label:\s*'Mean confidence'/);
    expect(src).not.toMatch(/meanCellConfidence\s*\)\s*\}\/100/);
  });

  it('the quality gate still keys on the pooled value', () => {
    // The row left the report; the threshold did not move. If this fails, a
    // wording change has altered a verdict, which it must not.
    const src = readFileSync(resolve(ROOT, 'src/terrain/quality/dtmQualityGate.ts'), 'utf8');
    expect(src).toMatch(/input\.meanCellConfidence >= T\.readyMinMeanConfidence/);
  });
});
