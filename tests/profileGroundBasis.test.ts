/**
 * profileGroundBasis.test.ts — what the profile says its heights came from.
 *
 * The sampler drops vegetation, building and noise returns before taking the
 * corridor percentile, but only where a source classifies them. Without that,
 * the percentile still runs, over every return, and under canopy it lands in
 * the canopy. Grade is a difference between two such heights, so it follows
 * whatever the surface followed.
 *
 * The exported sheet has always stated this basis. The screen did not, so a
 * reader working from the panel had to export a PDF to learn how the heights
 * in front of them were chosen. These cases hold both surfaces to one answer.
 */

import { describe, it, expect } from 'vitest';
import {
  describeClassBasis,
  GROUND_BASIS_UNVERIFIED_NOTE,
} from '../src/render/measure/profileProvenance';

describe('the class-basis clause', () => {
  it('names classification present on every source', () => {
    expect(describeClassBasis(true)).toBe('classification on every source');
  });

  it('names classification missing on any source', () => {
    expect(describeClassBasis(false)).toBe('classification missing on a source');
  });
});

describe('the caution about an unverified ground basis', () => {
  it('states the basis, and what follows from it', () => {
    // Not a bare "unverified": a reader needs to know what the number in
    // front of them followed, and that grades inherit it.
    expect(GROUND_BASIS_UNVERIFIED_NOTE).toContain('percentile of every return');
    expect(GROUND_BASIS_UNVERIFIED_NOTE).toContain('canopy');
    expect(GROUND_BASIS_UNVERIFIED_NOTE).toContain('grades');
  });

  it('does not promise a bare-earth surface', () => {
    expect(GROUND_BASIS_UNVERIFIED_NOTE).not.toMatch(/bare.?earth|ground truth|corrected/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The composed view: the clause reaches the screen, and the caution appears
// only where it changes what the figures mean.
// ─────────────────────────────────────────────────────────────────────────────

import { prepareWorkbenchSection } from '../src/app/profileWorkbenchSection';
import type { ProfileSectionResult } from '../src/render/measure/profileSectionSeam';

/** A section carrying two returns, classified or not as the case requires. */
function sectionWith(classificationOnEverySource: boolean): ProfileSectionResult {
  const count = 2;
  return {
    points: {
      count,
      chainage: new Float32Array([0, 10]),
      height: new Float64Array([100, 101]),
      lateralOffset: new Float32Array([0, 0]),
      sourceSlot: new Uint16Array([0, 0]),
      pointIndex: new Uint32Array([0, 1]),
      channelPresence: new Uint8Array([0, 0]),
    },
    frame: null as never,
    band: 2,
    scope: 'full-static-source' as never,
    scopeLabel: 'Full static source',
    classificationOnEverySource,
    streamingComplete: null,
    sources: [{ slot: 0, kind: 'static', id: 'layer-a', pointCount: count }],
    generation: 1,
    aborted: false,
    skippedSlots: [],
    examined: count,
  };
}

const canvas = () =>
  ({ width: 400, height: 200, getContext: () => null }) as unknown as HTMLCanvasElement;

describe('the workbench header', () => {
  it('carries the caution when a source has no classification', () => {
    const plot = prepareWorkbenchSection({ section: sectionWith(false), canvas: canvas() });
    expect(plot.view.scope).toContain('classification missing on a source');
    expect(plot.view.groundBasisNote).toBe(GROUND_BASIS_UNVERIFIED_NOTE);
  });

  it('carries no caution when every source classifies', () => {
    // A caution shown everywhere is a caution nowhere. This is the case that
    // keeps the amber note meaning something when it does appear.
    const plot = prepareWorkbenchSection({ section: sectionWith(true), canvas: canvas() });
    expect(plot.view.scope).toContain('classification on every source');
    expect(plot.view.groundBasisNote).toBeNull();
  });

  it('states the read scope and the class basis in one line', () => {
    const plot = prepareWorkbenchSection({ section: sectionWith(true), canvas: canvas() });
    expect(plot.view.scope).toBe('Full static source · classification on every source');
  });
});
