/**
 * colorChipModel.test.ts
 *
 * The colour-mode chip rail's load-bearing rule: the analysis-gated chips
 * (Coverage, and its colourblind-safe twin Confidence — v0.4.5) are ALWAYS
 * present (so the features are discoverable) but DISABLED until a
 * terrain-analysis confidence grid exists, and selecting one before then is a
 * no-op. Tested as a pure descriptor so it needs no DOM / Inspector
 * construction.
 */

import { describe, it, expect } from 'vitest';
import {
  buildColorChipModel,
  COVERAGE_DISABLED_TITLE,
  ANALYSIS_GATED_MODES,
} from '../src/ui/colorChipModel';
import type { ColorMode } from '../src/render/colorModes';

const DATA_MODES: ColorMode[] = ['rgb', 'elevation', 'classification', 'density'];

describe('buildColorChipModel', () => {
  it('always appends the gated chips, exactly once each, last (Coverage then Confidence)', () => {
    const chips = buildColorChipModel(DATA_MODES, 'elevation', false);
    expect(chips.filter((c) => c.mode === 'coverage')).toHaveLength(1);
    expect(chips.filter((c) => c.mode === 'confidence')).toHaveLength(1);
    expect(chips[chips.length - 2].mode).toBe('coverage');
    expect(chips[chips.length - 1].mode).toBe('confidence');
    expect(ANALYSIS_GATED_MODES).toEqual(['coverage', 'confidence']);
  });

  it('disables Coverage and Confidence until a grid is available', () => {
    const before = buildColorChipModel(DATA_MODES, 'elevation', false);
    expect(before.find((c) => c.mode === 'coverage')!.disabled).toBe(true);
    expect(before.find((c) => c.mode === 'confidence')!.disabled).toBe(true);

    const after = buildColorChipModel(DATA_MODES, 'elevation', true);
    expect(after.find((c) => c.mode === 'coverage')!.disabled).toBe(false);
    expect(after.find((c) => c.mode === 'confidence')!.disabled).toBe(false);
  });

  it('never marks a disabled gated chip active, even if it is the active mode', () => {
    for (const mode of ANALYSIS_GATED_MODES) {
      const chips = buildColorChipModel(DATA_MODES, mode, false);
      const chip = chips.find((c) => c.mode === mode)!;
      expect(chip.disabled).toBe(true);
      expect(chip.active).toBe(false);
    }
  });

  it('marks a gated chip active once available and selected', () => {
    expect(
      buildColorChipModel(DATA_MODES, 'coverage', true).find((c) => c.mode === 'coverage')!.active,
    ).toBe(true);
    expect(
      buildColorChipModel(DATA_MODES, 'confidence', true).find((c) => c.mode === 'confidence')!
        .active,
    ).toBe(true);
  });

  it('highlights the active data mode and enables every data chip', () => {
    const chips = buildColorChipModel(DATA_MODES, 'classification', true);
    const cls = chips.find((c) => c.mode === 'classification')!;
    expect(cls.active).toBe(true);
    expect(cls.disabled).toBe(false);
    for (const c of chips) {
      if (!ANALYSIS_GATED_MODES.includes(c.mode)) expect(c.disabled).toBe(false);
    }
  });

  it('ignores stray gated entries in the input modes (appends once each)', () => {
    const chips = buildColorChipModel(
      [...DATA_MODES, 'coverage', 'confidence'],
      'elevation',
      true,
    );
    expect(chips.filter((c) => c.mode === 'coverage')).toHaveLength(1);
    expect(chips.filter((c) => c.mode === 'confidence')).toHaveLength(1);
  });

  it('exposes the disabled tooltip copy for the UI', () => {
    expect(COVERAGE_DISABLED_TITLE).toMatch(/terrain analysis/i);
  });

  it('shows the scalar chips (gpsTime, returnNumber) only when the cloud carries the field', () => {
    // `availableModes(cloud)` appends these data-gated modes only when the
    // channel exists — the chip model must surface them as ordinary enabled
    // chips, never as analysis-gated ones.
    const withScalars = buildColorChipModel(
      [...DATA_MODES, 'gpsTime', 'returnNumber'],
      'elevation',
      false,
    );
    const gps = withScalars.find((c) => c.mode === 'gpsTime')!;
    const ret = withScalars.find((c) => c.mode === 'returnNumber')!;
    expect(gps.disabled).toBe(false);
    expect(ret.disabled).toBe(false);

    const without = buildColorChipModel(DATA_MODES, 'elevation', false);
    expect(without.find((c) => c.mode === 'gpsTime')).toBeUndefined();
    expect(without.find((c) => c.mode === 'returnNumber')).toBeUndefined();
  });

  it('keeps the gated chips last even when scalar chips are present', () => {
    const chips = buildColorChipModel(
      [...DATA_MODES, 'gpsTime', 'returnNumber'],
      'gpsTime',
      false,
    );
    expect(chips[chips.length - 2].mode).toBe('coverage');
    expect(chips[chips.length - 1].mode).toBe('confidence');
    expect(chips.find((c) => c.mode === 'gpsTime')!.active).toBe(true);
  });
});
