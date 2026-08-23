/**
 * profileDerivedLegend.test.ts
 *
 * The derived overlay on a profile section is a low percentile of each
 * station's corridor, with vegetation / building / noise dropped wherever a
 * source classified its returns. Three things about that are easy to say
 * dishonestly, and each has a test here:
 *
 *   - naming the series after a terrain class it cannot certify;
 *   - claiming a class policy applied to the section when only some sources
 *     carried the classification it needs;
 *   - reporting a resident streaming snapshot as if the full source was read.
 *
 * Every expectation below is hand-computed from the fixture it names.
 */

import { describe, it, expect } from 'vitest';
import type { ProfileSample } from '../src/render/measure/profileSampler';
import { DEFAULT_GROUND_PERCENTILE } from '../src/render/measure/profileSampler';
import { NON_GROUND_CLASSES } from '../src/terrain/ground/classificationFilter';
import {
  buildDerivedSurfaceLegend,
  derivedSurfaceLegendStrings,
} from '../src/render/measure/profileDerivedLegend';
import type {
  DerivedSurfaceSource,
  SourceClassificationProvenance,
  SourceReadKind,
} from '../src/render/measure/profileDerivedLegend';

/**
 * Six stations, two of them coverage gaps (NaN height). Covered = 4.
 *   0 m: 10 · 10 m: 12 · 20 m: gap · 30 m: 11 · 40 m: gap · 50 m: 13
 */
const SAMPLES: ProfileSample[] = [
  { distance: 0, height: 10, count: 5 },
  { distance: 10, height: 12, count: 8 },
  { distance: 20, height: Number.NaN, count: 0 },
  { distance: 30, height: 11, count: 3 },
  { distance: 40, height: Number.NaN, count: 0 },
  { distance: 50, height: 13, count: 9 },
];

const src = (
  classification: SourceClassificationProvenance,
  read: SourceReadKind = 'static',
  label?: string,
): DerivedSurfaceSource => ({ classification, read, label });

/** The plain, fully-classified, fully-static case used as the baseline. */
const baseline = () =>
  buildDerivedSurfaceLegend({
    samples: SAMPLES,
    percentile: 25,
    corridorHalfWidthM: 2.5,
    sources: [src('producer', 'static', 'flight A'), src('producer', 'static', 'flight B')],
  });

const allStrings = (legend: ReturnType<typeof buildDerivedSurfaceLegend>): string =>
  derivedSurfaceLegendStrings(legend).join('\n');

// ── The vocabulary the legend exists to prevent ─────────────────────────────

describe('the derived series is never named after a terrain class', () => {
  /**
   * Every combination of provenance, read kind and percentile the module can
   * word differently. If any branch reaches for the forbidden vocabulary, one
   * of these legends carries it.
   */
  const matrix: ReturnType<typeof buildDerivedSurfaceLegend>[] = [];
  const provenances: SourceClassificationProvenance[] = ['producer', 'derived', 'absent'];
  const reads: SourceReadKind[] = ['static', 'streaming-resident'];
  for (const a of provenances) {
    for (const b of provenances) {
      for (const ra of reads) {
        for (const rb of reads) {
          for (const percentile of [null, 0, 25, 37.5, 100]) {
            matrix.push(
              buildDerivedSurfaceLegend({
                samples: SAMPLES,
                percentile,
                corridorHalfWidthM: 2.5,
                sources: [src(a, ra, 'flight A'), src(b, rb, 'flight B')],
              }),
            );
          }
        }
      }
    }
  }
  // The degenerate shapes too: no sources, no stations, no corridor width.
  matrix.push(buildDerivedSurfaceLegend({ samples: [], sources: [] }));
  matrix.push(
    buildDerivedSurfaceLegend({ samples: SAMPLES, sources: [src('producer')], corridorHalfWidthM: null }),
  );

  it('never emits the word "Ground" in any produced string', () => {
    for (const legend of matrix) {
      for (const s of derivedSurfaceLegendStrings(legend)) {
        expect(s, `banned word in: ${s}`).not.toMatch(/\bground\b/i);
      }
    }
  });

  it('never emits "bare earth" in any produced string', () => {
    for (const legend of matrix) {
      for (const s of derivedSurfaceLegendStrings(legend)) {
        expect(s, `banned phrase in: ${s}`).not.toMatch(/bare[\s-]*earth/i);
      }
    }
  });

  it('names the series by the operation that made it', () => {
    const legend = baseline();
    expect(legend.seriesLabel).toContain('Derived surface');
    expect(legend.seriesLabel).toContain('percentile');
    expect(allStrings(legend)).toContain('Estimated, not measured');
  });

  it('covers every branch of the module (the matrix is not vacuous)', () => {
    expect(matrix.length).toBe(3 * 3 * 2 * 2 * 5 + 2);
    const scopes = new Set(matrix.map((m) => m.exclusionScope));
    const reads2 = new Set(matrix.map((m) => m.readScope));
    const provs = new Set(matrix.map((m) => m.classificationProvenance));
    expect([...scopes].sort()).toEqual(['every-source', 'none', 'partial']);
    expect([...reads2].sort()).toEqual([
      'full-static',
      'partial-resident',
      'resident-snapshot',
      'unknown',
    ]);
    expect(provs.has('mixed')).toBe(true);
  });
});

// ── The percentile that ran, not the one that is usually used ───────────────

describe('percentile reporting', () => {
  it('states the percentile actually passed, not the default', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: 10,
      corridorHalfWidthM: 2.5,
      sources: [src('producer')],
    });
    expect(legend.percentileUsed).toBe(10);
    expect(legend.percentileWasDefault).toBe(false);
    expect(legend.seriesLabel).toContain('10th percentile');
    expect(allStrings(legend)).toContain('10th percentile');
    // The default must not appear anywhere: it did not shape this estimate.
    expect(allStrings(legend)).not.toContain(`${DEFAULT_GROUND_PERCENTILE}th percentile`);
  });

  it('resolves an absent percentile to the sampler default and says so', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      corridorHalfWidthM: 2.5,
      sources: [src('producer')],
    });
    expect(legend.percentileUsed).toBe(DEFAULT_GROUND_PERCENTILE);
    expect(legend.percentileWasDefault).toBe(true);
    expect(allStrings(legend)).toContain('the sampler default');
  });

  it('clamps as the sampler clamps, and reports the clamped value', () => {
    expect(
      buildDerivedSurfaceLegend({ samples: SAMPLES, percentile: 140, sources: [src('producer')] })
        .percentileUsed,
    ).toBe(100);
    expect(
      buildDerivedSurfaceLegend({ samples: SAMPLES, percentile: -5, sources: [src('producer')] })
        .percentileUsed,
    ).toBe(0);
    const nan = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: Number.NaN,
      sources: [src('producer')],
    });
    expect(nan.percentileUsed).toBe(DEFAULT_GROUND_PERCENTILE);
  });

  it('carries a fractional percentile through to the text', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: 12.5,
      sources: [src('producer')],
    });
    expect(legend.seriesLabel).toContain('12.5th percentile');
  });
});

// ── Geometry: stations and corridor ─────────────────────────────────────────

describe('station count and corridor half width', () => {
  it('states both', () => {
    const legend = baseline();
    expect(legend.stationCount).toBe(6);
    expect(legend.corridorHalfWidthM).toBe(2.5);
    const text = allStrings(legend);
    expect(text).toContain('6 stations along the section');
    expect(text).toContain('corridor half width 2.5 m');
  });

  it('says "not recorded" rather than inventing a width', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: 25,
      corridorHalfWidthM: null,
      sources: [src('producer')],
    });
    expect(legend.corridorHalfWidthM).toBeNull();
    expect(allStrings(legend)).toContain('Corridor half width: not recorded');
  });
});

// ── Class exclusion, and whether it could reach the whole section ───────────

describe('class exclusion policy', () => {
  it('reports full exclusion only when every source carried classification', () => {
    const legend = baseline();
    expect(legend.exclusionScope).toBe('every-source');
    expect(legend.sourcesWithClassification).toBe(2);
    expect(legend.excludedClasses).toEqual([...NON_GROUND_CLASSES]);
    const text = allStrings(legend);
    expect(text).toContain('excluded on every contributing source (2 of 2)');
    expect(text).toContain('vegetation, building, noise');
  });

  it('says PARTIAL when only some sources carried classification', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: 25,
      corridorHalfWidthM: 2.5,
      sources: [src('producer', 'static', 'flight A'), src('absent', 'static', 'flight B')],
    });
    expect(legend.exclusionScope).toBe('partial');
    expect(legend.sourcesWithClassification).toBe(1);
    const text = allStrings(legend);
    expect(text).toContain('only 1 of 2 sources: partial');
    expect(text).toContain('did not apply to the whole section');
    // The whole-section claim must not be made.
    expect(text).not.toContain('excluded on every contributing source');
  });

  it('says the policy was not applied at all when no source classified', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: 25,
      sources: [src('absent'), src('absent')],
    });
    expect(legend.exclusionScope).toBe('none');
    const text = allStrings(legend);
    expect(text).toContain('Class exclusion: not applied');
    expect(text).not.toContain('excluded on every contributing source');
  });

  it('honours a caller-supplied exclusion set', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      sources: [src('producer')],
      excludedClasses: [5, 6],
    });
    expect(legend.excludedClasses).toEqual([5, 6]);
    expect(allStrings(legend)).toContain('Classes 5, 6');
  });
});

// ── Provenance across sources ───────────────────────────────────────────────

describe('classification provenance', () => {
  it('reports a single provenance when the sources agree', () => {
    expect(baseline().classificationProvenance).toBe('producer');
    expect(allStrings(baseline())).toContain('producer classification on all 2 sources');
  });

  it('reports OLV-derived classification as its own provenance', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      sources: [src('derived'), src('derived')],
    });
    expect(legend.classificationProvenance).toBe('derived');
    expect(allStrings(legend)).toContain('OLV-derived classification');
  });

  it('says MIXED rather than picking one source answer', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: 25,
      corridorHalfWidthM: 2.5,
      sources: [
        src('producer', 'static', 'flight A'),
        src('derived', 'static', 'flight B'),
        src('absent', 'static', 'walk C'),
      ],
    });
    expect(legend.classificationProvenance).toBe('mixed');
    const text = allStrings(legend);
    expect(text).toContain('mixed across 3 sources');
    // Each source's own answer is named; none of them is promoted to the whole.
    expect(text).toContain('flight A: producer classification');
    expect(text).toContain('flight B: OLV-derived classification');
    expect(text).toContain('walk C: no classification channel');
    expect(text).not.toContain('producer classification on all 3 sources');
    // A mixed section that includes an unclassified source is partial by
    // definition: the same error one level down.
    expect(legend.exclusionScope).toBe('partial');
  });

  it('reports an empty section as unrecorded, not as a clean read', () => {
    const legend = buildDerivedSurfaceLegend({ samples: [], sources: [] });
    expect(legend.sourceCount).toBe(0);
    expect(legend.readScope).toBe('unknown');
    const text = allStrings(legend);
    expect(text).toContain('no contributing source was recorded');
    expect(text).not.toContain('the full static sources');
  });
});

// ── Read scope ──────────────────────────────────────────────────────────────

describe('read scope', () => {
  it('reports a full static read as such', () => {
    const legend = baseline();
    expect(legend.readScope).toBe('full-static');
    expect(allStrings(legend)).toContain('Read: the full static sources.');
  });

  it('never reports a resident streaming snapshot as a full static read', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: 25,
      corridorHalfWidthM: 2.5,
      sources: [src('producer', 'streaming-resident')],
    });
    expect(legend.readScope).toBe('resident-snapshot');
    const text = allStrings(legend);
    expect(text).toContain('a resident streaming snapshot, not the full sources');
    expect(text).not.toContain('the full static sources');
  });

  it('reports a part-streaming section as a partial read', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      sources: [src('producer', 'static'), src('producer', 'streaming-resident')],
    });
    expect(legend.readScope).toBe('partial-resident');
    const text = allStrings(legend);
    expect(text).toContain('part static, part resident streaming snapshot');
    expect(text).not.toContain('Read: the full static sources.');
  });
});

// ── Coverage gaps ───────────────────────────────────────────────────────────

describe('coverage gaps', () => {
  it('counts the NaN stations and states the line is broken', () => {
    const legend = baseline();
    expect(legend.gapStationCount).toBe(2);
    expect(legend.coveredStationCount).toBe(4);
    const text = allStrings(legend);
    expect(text).toContain('Coverage gaps: 2 of 6 stations');
    expect(text).toContain('never interpolated');
    expect(legend.caption).toContain('2 gaps');
  });

  it('states an explicit zero when every station has returns', () => {
    const legend = buildDerivedSurfaceLegend({
      samples: SAMPLES.filter((s) => Number.isFinite(s.height)),
      sources: [src('producer')],
    });
    expect(legend.gapStationCount).toBe(0);
    expect(allStrings(legend)).toContain('Coverage gaps: 0 of 4 stations');
  });

  it('the gap count is always present in the text', () => {
    for (const samples of [SAMPLES, [], SAMPLES.slice(0, 2)]) {
      const legend = buildDerivedSurfaceLegend({ samples, sources: [src('producer')] });
      expect(allStrings(legend)).toMatch(/Coverage gaps: \d+ of \d+/);
    }
  });
});

// ── Display modes ───────────────────────────────────────────────────────────

describe('display modes', () => {
  it('offers exactly the three modes, in order', () => {
    const modes = baseline().displayModes;
    expect(modes.map((m) => m.id)).toEqual(['observed', 'observed-and-derived', 'derived-only']);
  });

  it('the derived-only mode warns that the supporting returns are hidden', () => {
    const derivedOnly = baseline().displayModes[2];
    expect(derivedOnly.detail).toContain('hidden');
    expect(derivedOnly.detail).toContain('25th-percentile estimate');
  });

  it('mode text tracks the percentile that ran', () => {
    const modes = buildDerivedSurfaceLegend({
      samples: SAMPLES,
      percentile: 40,
      sources: [src('producer')],
    }).displayModes;
    expect(modes[1].detail).toContain('40th-percentile estimate');
    expect(modes[2].detail).toContain('40th-percentile estimate');
  });
});

// ── Purity ──────────────────────────────────────────────────────────────────

describe('purity', () => {
  it('is deterministic and does not mutate its input', () => {
    const sources = [src('producer', 'static', 'flight A'), src('absent', 'streaming-resident')];
    const before = JSON.stringify({ SAMPLES, sources });
    const a = buildDerivedSurfaceLegend({ samples: SAMPLES, percentile: 25, sources });
    const b = buildDerivedSurfaceLegend({ samples: SAMPLES, percentile: 25, sources });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify({ SAMPLES, sources })).toBe(before);
  });
});
