/**
 * Export isolation: a figure says what it contains, and a geometry raster
 * never carries an invented elevation.
 *
 * Every Studio exporter captures the live canvas. Four of the seven raster
 * modes encode geometry in their pixel values, so the question of whether a
 * reconstructed pixel can reach one of them is not stylistic. These pin the
 * two halves the export path now applies: which modes must suspend
 * reconstruction, and what the resulting figure is allowed to claim.
 *
 * With no capability enabled every answer is the source case, so the wiring
 * changes no byte today. That is the point of landing it before the first
 * capability that can reconstruct.
 */
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

/** What BaseExportMode now computes for a capture. */
function captureOf(mode: ExportMode, tier: (typeof TIER_ORDER)[number]) {
  const caps = capabilitiesForTier(tier);
  const policy = capturePolicyFor(mode, caps);
  const presentation = presentationOfCapture(caps, policy);
  return { policy, presentation, invented: containsInventedPixels(presentation) };
}

describe('a scientific capture never carries an invented elevation', () => {
  it('suspends reconstruction for every geometry raster at every tier that reconstructs', () => {
    for (const mode of GEOMETRY_BEARING_MODES) {
      for (const tier of TIER_ORDER) {
        const { invented } = captureOf(mode, tier);
        expect(invented, `${mode} at ${tier}`).toBe(false);
      }
    }
  });

  it('labels an appearance raster honestly instead of suspending it', () => {
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
  it('records the suspended mode rather than the one on screen', () => {
    // Live view reconstructing, capture suspended: the file has no invented
    // pixel and must not be labelled as though it did.
    expect(captureOf('depth', 'full').presentation).not.toBe('reconstructed');
    expect(captureOf('orthographic-rgb', 'full').presentation).toBe('reconstructed');
  });

  it('discloses a counted share only on a figure that contains invented pixels', () => {
    expect(buildPresentationProvenance('reconstructed', 0.2)).toHaveLength(2);
    expect(buildPresentationProvenance('source', 0.2)).toHaveLength(1);
    expect(buildPresentationProvenance('reconstructed', null)).toHaveLength(1);
  });
});
