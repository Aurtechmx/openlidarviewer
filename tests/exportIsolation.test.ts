/**
 * Export isolation: a figure says what it contains, and a geometry raster
 * never carries an invented elevation.
 *
 * Every Studio exporter captures the live canvas. Four of the seven raster
 * modes encode geometry in their pixel values, so the question of whether a
 * reconstructed pixel can reach one of them is not stylistic.
 *
 * Two halves, and only one of them is built. `capturePolicyFor` names the
 * modes that owe a suspension; nothing performs one, because the renderer sits
 * behind the export-to-render boundary the module-graph ratchet holds
 * shrink-only. So the figure is labelled by what it contained, which means a
 * geometry raster captured at a reconstructing tier says 'reconstructed'
 * rather than claiming to be source. That is a disclosure, not the isolation
 * this file is named for, and these tests are written to keep the difference
 * visible.
 *
 * With no capability enabled every answer is the source case, so none of it
 * changes a byte today. That is the point of landing it before the first
 * capability that can reconstruct.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import {
  capturePolicyFor,
  presentationOfCapture,
  containsInventedPixels,
  buildPresentationProvenance,
  GEOMETRY_BEARING_MODES,
} from '../src/export/presentationMode';
import { capabilitiesForTier, TIER_ORDER } from '../src/render/continuity/continuityTier';
import type { ExportMode } from '../src/export/types';

const ALL_MODES: readonly ExportMode[] = [
  'orthographic-rgb', 'height-map', 'intensity', 'classification', 'depth', 'normal', 'contour',
];

/** What the policy layer says a capture in this mode OWES. */
function policyOf(mode: ExportMode, tier: (typeof TIER_ORDER)[number]) {
  return capturePolicyFor(mode, capabilitiesForTier(tier));
}

/**
 * What BaseExportMode actually produces.
 *
 * `as-is`, because that is what the export path does: it performs no
 * suspension. `presentationMode`'s contract puts the stand-down on the caller,
 * and the caller cannot reach the renderer across the export-to-render
 * boundary. Passing the policy in here instead would credit the figure with a
 * suspension nobody performed.
 */
function captureOf(mode: ExportMode, tier: (typeof TIER_ORDER)[number]) {
  const caps = capabilitiesForTier(tier);
  const presentation = presentationOfCapture(caps, 'as-is');
  return { policy: policyOf(mode, tier), presentation, invented: containsInventedPixels(presentation) };
}

describe('the suspension is named but not yet performed', () => {
  it('names every geometry raster that owes one', () => {
    for (const mode of GEOMETRY_BEARING_MODES) {
      expect(policyOf(mode, 'full'), mode).toBe('suspend-reconstruction');
      expect(policyOf(mode, 'closure'), mode).toBe('suspend-reconstruction');
      expect(policyOf(mode, 'sizing'), mode).toBe('as-is');
      expect(policyOf(mode, 'source'), mode).toBe('as-is');
    }
  });

  it('labels the figure reconstructed rather than crediting a stand-down nobody performed', () => {
    // This pins a GAP, not a guarantee. An earlier version of this file passed
    // the policy into `presentationOfCapture`, which skips the reconstructed
    // branch on the caller's promise to have suspended. No caller makes good
    // on it, so a geometry raster captured at a reconstructing tier would have
    // been stamped 'source' over invented elevations. An honest label is the
    // conservative one until the export path can stand the renderer down.
    for (const mode of GEOMETRY_BEARING_MODES) {
      expect(captureOf(mode, 'closure').invented, mode).toBe(true);
      expect(captureOf(mode, 'sizing').invented, mode).toBe(false);
    }
  });

  it('labels an appearance raster honestly too', () => {
    const { policy, presentation } = captureOf('orthographic-rgb', 'closure');
    expect(policy).toBe('as-is');
    expect(presentation).toBe('reconstructed');
  });
});

describe('with nothing enabled the capture is the source case', () => {
  it('asks for no suspension and reports source for every mode', () => {
    for (const mode of ALL_MODES) {
      const { policy, presentation, invented } = captureOf(mode, 'source');
      expect(policy).toBe('as-is');
      expect(presentation).toBe('source');
      expect(invented).toBe(false);
    }
  });

  it('still stamps the mode, so an unstamped file is distinguishable', () => {
    const entries = buildPresentationProvenance('source');
    expect(entries).toEqual([{ keyword: 'olv:presentation', text: 'source' }]);
  });
});

describe('the figure describes itself, not the live view', () => {
  it('describes what the capture contained, for every mode alike', () => {
    // Both are 'reconstructed' at this tier because neither was suspended.
    // When a real stand-down exists, the geometry raster is the one that
    // should stop saying so, and this expectation is where that shows up.
    expect(captureOf('depth', 'full').presentation).toBe('reconstructed');
    expect(captureOf('orthographic-rgb', 'full').presentation).toBe('reconstructed');
  });

  it('discloses a counted share only on a figure that contains invented pixels', () => {
    expect(buildPresentationProvenance('reconstructed', 0.2)).toHaveLength(2);
    expect(buildPresentationProvenance('source', 0.2)).toHaveLength(1);
    expect(buildPresentationProvenance('reconstructed', null)).toHaveLength(1);
  });
});

// The helpers above mirror the export path; they cannot catch the export path
// drifting away from them. This reads the caller itself, because the defect
// being guarded is precisely a caller that hands `presentationOfCapture` a
// policy it has not honoured.
describe('the export path does not claim a suspension it never performs', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'export', 'BaseExportMode.ts'),
    'utf8',
  );

  it('passes the literal as-is, not a computed policy', () => {
    expect(source).toMatch(/presentationOfCapture\(\s*capturedCaps\s*,\s*'as-is'\s*\)/);
  });

  it('does not import capturePolicyFor while no stand-down exists', () => {
    // The IMPORT is the signal, not a mention: the comment in that file names
    // the function to explain why it is absent. When someone imports it back
    // they intend to honour the policy, and the test above is the one to
    // revisit, together with both file headers.
    expect(source).not.toMatch(/import \{[^}]*\bcapturePolicyFor\b[^}]*\}/);
  });
});
