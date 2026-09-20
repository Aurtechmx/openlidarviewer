import { describe, it, expect } from 'vitest';
import {
  GEOMETRY_BEARING_MODES,
  encodesGeometry,
  reconstructsPixels,
  capturePolicyFor,
  presentationOfCapture,
  containsInventedPixels,
  buildPresentationProvenance,
} from '../src/export/presentationMode';
import { CONTINUITY_DISABLED } from '../src/render/continuity/continuityField';
import type { ContinuityCapabilities } from '../src/render/continuity/continuityField';
import type { ExportMode } from '../src/export/types';
import { reconstructedShare } from '../src/render/continuity/supportCensus';
import type { SupportCensus } from '../src/render/continuity/supportCensus';

const caps = (over: Partial<ContinuityCapabilities>): ContinuityCapabilities => ({
  ...CONTINUITY_DISABLED,
  ...over,
});

const ALL_MODES: readonly ExportMode[] = [
  'orthographic-rgb',
  'height-map',
  'intensity',
  'classification',
  'depth',
  'normal',
  'contour',
];

describe('what counts as reconstruction', () => {
  it('is micro-gap fill and nothing else', () => {
    expect(reconstructsPixels(caps({ microGapFill: true }))).toBe(true);
    expect(reconstructsPixels(caps({ temporalAccumulation: true }))).toBe(false);
    expect(reconstructsPixels(caps({ coverageSizing: true }))).toBe(false);
    expect(reconstructsPixels(CONTINUITY_DISABLED)).toBe(false);
  });

  it('does not treat accumulation as invention even with everything else on', () => {
    const on = caps({
      coverageSizing: true,
      temporalAccumulation: true,
      evidenceLens: true,
      nodeCulling: true,
      packedAttributes: true,
    });
    expect(reconstructsPixels(on)).toBe(false);
  });
});

describe('geometry-bearing rasters', () => {
  it('names the four whose pixel values are read back as geometry', () => {
    expect([...GEOMETRY_BEARING_MODES].sort()).toEqual(
      ['contour', 'depth', 'height-map', 'normal'].sort(),
    );
  });

  it('classifies every export mode', () => {
    for (const m of ALL_MODES) expect(typeof encodesGeometry(m)).toBe('boolean');
    expect(encodesGeometry('orthographic-rgb')).toBe(false);
    expect(encodesGeometry('intensity')).toBe(false);
    expect(encodesGeometry('classification')).toBe(false);
  });
});

describe('capture policy', () => {
  it('suspends reconstruction for every geometry raster when gaps are being filled', () => {
    const filling = caps({ microGapFill: true });
    for (const m of GEOMETRY_BEARING_MODES) {
      expect(capturePolicyFor(m, filling)).toBe('suspend-reconstruction');
    }
  });

  it('never invents an elevation in a depth map', () => {
    const filling = caps({ microGapFill: true, temporalAccumulation: true, coverageSizing: true });
    const policy = capturePolicyFor('depth', filling);
    expect(policy).toBe('suspend-reconstruction');
    expect(containsInventedPixels(presentationOfCapture(filling, policy))).toBe(false);
  });

  it('captures appearance rasters as they stand', () => {
    const filling = caps({ microGapFill: true });
    expect(capturePolicyFor('orthographic-rgb', filling)).toBe('as-is');
    expect(capturePolicyFor('intensity', filling)).toBe('as-is');
    expect(capturePolicyFor('classification', filling)).toBe('as-is');
  });

  it('asks for no suspension when nothing is being reconstructed', () => {
    for (const m of ALL_MODES) {
      expect(capturePolicyFor(m, CONTINUITY_DISABLED)).toBe('as-is');
      expect(capturePolicyFor(m, caps({ temporalAccumulation: true }))).toBe('as-is');
    }
  });
});

describe('presentation of the captured figure', () => {
  it('describes the capture, not the live view', () => {
    const filling = caps({ microGapFill: true, coverageSizing: true });
    expect(presentationOfCapture(filling, 'as-is')).toBe('reconstructed');
    expect(presentationOfCapture(filling, 'suspend-reconstruction')).toBe('coverage-sized');
  });

  it('reports the richest mode in force', () => {
    expect(presentationOfCapture(CONTINUITY_DISABLED, 'as-is')).toBe('source');
    expect(presentationOfCapture(caps({ coverageSizing: true }), 'as-is')).toBe('coverage-sized');
    expect(
      presentationOfCapture(caps({ coverageSizing: true, temporalAccumulation: true }), 'as-is'),
    ).toBe('accumulated');
  });

  it('marks only reconstruction as invented', () => {
    expect(containsInventedPixels('reconstructed')).toBe(true);
    expect(containsInventedPixels('accumulated')).toBe(false);
    expect(containsInventedPixels('coverage-sized')).toBe(false);
    expect(containsInventedPixels('source')).toBe(false);
  });
});

describe('presentation provenance entries', () => {
  const census: SupportCensus = { direct: 700, accumulated: 100, reconstructed: 200, none: 5000 };

  it('always states the mode, including source', () => {
    const e = buildPresentationProvenance('source');
    expect(e).toEqual([{ keyword: 'olv:presentation', text: 'source' }]);
  });

  it('states the counted share when the figure contains invented pixels', () => {
    const e = buildPresentationProvenance('reconstructed', reconstructedShare(census));
    expect(e[0]).toEqual({ keyword: 'olv:presentation', text: 'reconstructed' });
    expect(e[1].keyword).toBe('olv:reconstructed-share');
    expect(e[1].text).toContain('20.00%');
  });

  it('carries the census definition, which excludes background', () => {
    const pulledBack: SupportCensus = { ...census, none: 500000 };
    const e = buildPresentationProvenance('reconstructed', reconstructedShare(pulledBack));
    expect(e[1].text).toContain('20.00%');
  });

  it('emits no share when none was counted', () => {
    expect(buildPresentationProvenance('reconstructed')).toHaveLength(1);
    expect(buildPresentationProvenance('reconstructed', null)).toHaveLength(1);
  });

  it('emits no share for a frame that drew nothing', () => {
    const empty: SupportCensus = { direct: 0, accumulated: 0, reconstructed: 0, none: 9000 };
    expect(reconstructedShare(empty)).toBeNull();
    expect(buildPresentationProvenance('reconstructed', reconstructedShare(empty))).toHaveLength(1);
  });

  it('refuses a share that is not a share', () => {
    for (const bad of [NaN, Infinity, -0.5, 1.5]) {
      expect(buildPresentationProvenance('reconstructed', bad)).toHaveLength(1);
    }
  });

  it('emits no share for a mode that invents nothing, even when one was counted', () => {
    const s = reconstructedShare(census);
    expect(buildPresentationProvenance('accumulated', s)).toHaveLength(1);
    expect(buildPresentationProvenance('source', s)).toHaveLength(1);
  });
});
