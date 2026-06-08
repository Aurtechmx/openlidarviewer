/**
 * colorChipModel.test.ts
 *
 * The colour-mode chip rail's load-bearing rule: the Coverage chip is ALWAYS
 * present (so the feature is discoverable) but DISABLED until a terrain-analysis
 * confidence grid exists, and selecting it before then is a no-op. Tested as a
 * pure descriptor so it needs no DOM / Inspector construction.
 */

import { describe, it, expect } from 'vitest';
import { buildColorChipModel, COVERAGE_DISABLED_TITLE } from '../src/ui/colorChipModel';
import type { ColorMode } from '../src/render/colorModes';

const DATA_MODES: ColorMode[] = ['rgb', 'elevation', 'classification', 'density'];

describe('buildColorChipModel', () => {
  it('always appends the Coverage chip, exactly once, last', () => {
    const chips = buildColorChipModel(DATA_MODES, 'elevation', false);
    const coverage = chips.filter((c) => c.mode === 'coverage');
    expect(coverage).toHaveLength(1);
    expect(chips[chips.length - 1].mode).toBe('coverage');
  });

  it('disables Coverage until a grid is available', () => {
    const before = buildColorChipModel(DATA_MODES, 'elevation', false);
    expect(before.find((c) => c.mode === 'coverage')!.disabled).toBe(true);

    const after = buildColorChipModel(DATA_MODES, 'elevation', true);
    expect(after.find((c) => c.mode === 'coverage')!.disabled).toBe(false);
  });

  it('never marks the disabled Coverage chip active, even if it is the active mode', () => {
    const chips = buildColorChipModel(DATA_MODES, 'coverage', false);
    const coverage = chips.find((c) => c.mode === 'coverage')!;
    expect(coverage.disabled).toBe(true);
    expect(coverage.active).toBe(false);
  });

  it('marks Coverage active once available and selected', () => {
    const chips = buildColorChipModel(DATA_MODES, 'coverage', true);
    expect(chips.find((c) => c.mode === 'coverage')!.active).toBe(true);
  });

  it('highlights the active data mode and enables every data chip', () => {
    const chips = buildColorChipModel(DATA_MODES, 'classification', true);
    const cls = chips.find((c) => c.mode === 'classification')!;
    expect(cls.active).toBe(true);
    expect(cls.disabled).toBe(false);
    for (const c of chips) {
      if (c.mode !== 'coverage') expect(c.disabled).toBe(false);
    }
  });

  it('ignores a stray coverage entry in the input modes (appends once)', () => {
    const chips = buildColorChipModel([...DATA_MODES, 'coverage'], 'elevation', true);
    expect(chips.filter((c) => c.mode === 'coverage')).toHaveLength(1);
  });

  it('exposes the disabled tooltip copy for the UI', () => {
    expect(COVERAGE_DISABLED_TITLE).toMatch(/terrain analysis/i);
  });
});
