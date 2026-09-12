/**
 * derivedClassFrameInput.test.ts — a frame-invalid derived classification must
 * not reach a new analytical computation.
 *
 * Marking the classification stale invalidates results that were already
 * computed. It does nothing to the ARRAY, so the next terrain gather handed the
 * same derived codes to a fresh run and that run passed its own freshness gate:
 * `terrainAnalysisRunner` captures `crsRevision` when the run STARTS, so a run
 * begun after the frame change compares the new revision against itself and
 * finds nothing wrong. The stale codes were the input, not the output, and no
 * gate read the input's frame.
 *
 * The rule tested here is the input side: while a derived classification is
 * known to belong to a replaced frame, it is not an analysis input. The bytes
 * stay attached — the legend, the colours and the user's editing work are
 * untouched — and a successful re-derive under the current frame restores it.
 *
 * A producer's classification carries no frame-dependent thresholds and is
 * never withheld.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { analysisClassification } from '../src/render/integrableClouds';

const POINTS = 8;

function cloud(): PointCloud {
  const positions = new Float32Array(POINTS * 3);
  for (let i = 0; i < POINTS; i += 1) positions[i * 3 + 2] = i * 0.25;
  return new PointCloud({
    positions, origin: [516_000, 4_644_000, 70], sourceFormat: 'las', name: 'frame-fixture',
  });
}

const codes = () => Uint8Array.from({ length: POINTS }, (_, i) => (i < 4 ? 2 : 5));

describe('analysisClassification', () => {
  it('withholds nothing from a cloud with no classification at all', () => {
    expect(analysisClassification(cloud(), POINTS * 3)).toBeUndefined();
  });

  it('supplies a freshly derived classification', () => {
    const c = cloud();
    c.attachDerivedClassification(codes());
    expect(analysisClassification(c, POINTS * 3)).toHaveLength(POINTS);
  });

  it('withholds a derived classification once its frame is replaced', () => {
    const c = cloud();
    c.attachDerivedClassification(codes());
    c.markDerivedClassificationFrameInvalid();
    expect(analysisClassification(c, POINTS * 3)).toBeUndefined();
  });

  it('keeps the codes attached for display while withholding them from analysis', () => {
    const c = cloud();
    c.attachDerivedClassification(codes());
    c.markDerivedClassificationFrameInvalid();
    // The user's work is not discarded: the legend and the class colours read
    // this array, and a derive costs seconds.
    expect(c.classification).toHaveLength(POINTS);
    expect(c.classificationIsDerived).toBe(true);
  });

  it('restores the input path after a re-derive under the current frame', () => {
    const c = cloud();
    c.attachDerivedClassification(codes());
    c.markDerivedClassificationFrameInvalid();
    expect(analysisClassification(c, POINTS * 3)).toBeUndefined();
    c.attachDerivedClassification(codes());
    expect(analysisClassification(c, POINTS * 3)).toHaveLength(POINTS);
    expect(c.derivedClassificationFrameInvalid).toBe(false);
  });

  it('never withholds a producer classification', () => {
    const positions = new Float32Array(POINTS * 3);
    const c = new PointCloud({
      positions, origin: [516_000, 4_644_000, 70], sourceFormat: 'las',
      name: 'producer', classification: codes(),
    });
    // The mark is a no-op on codes the file supplied: their thresholds are the
    // producer's, not a restatement of metres in this frame's units.
    c.markDerivedClassificationFrameInvalid();
    expect(c.classificationIsDerived).toBe(false);
    expect(analysisClassification(c, POINTS * 3)).toHaveLength(POINTS);
  });

  it('still rejects a misaligned array, frame validity aside', () => {
    const c = cloud();
    c.attachDerivedClassification(codes());
    // A length mismatch maps codes to the wrong points; that check is not
    // weakened by adding the frame one.
    expect(analysisClassification(c, (POINTS + 1) * 3)).toBeUndefined();
  });
});
