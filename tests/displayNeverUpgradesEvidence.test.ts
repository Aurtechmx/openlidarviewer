import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stockpileAuthority } from '../src/render/measure/stockpilePresenter';

/**
 * A reconstructed view can be beautiful and the source still incomplete.
 *
 * The Continuity Field decides how a frame looks: which pixels were drawn from
 * samples, which were carried across frames, which were filled in, and whether a
 * sweep finished. None of that says anything about whether the points that
 * exist are all the points there will be. The concepts sit next to each other
 * and the words for them are similar, so the separation is held structurally:
 * the code that decides what a figure may be called cannot see the code that
 * decides how it was drawn.
 */
// fileURLToPath, not URL.pathname: on Windows the latter yields `/D:/...`,
// which Node resolves against the current drive as `D:\\D:\\...`.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Where a figure's standing is decided. */
const AUTHORITY_SURFACE = [
  'render/measure/stockpilePresenter.ts',
  'render/measure/profileSectionSnapshot.ts',
];

/** Everything that decides how a frame is drawn. */
const CONTINUITY_SURFACE = ['render/continuity/', 'render/streaming/continuity'];
const CONTINUITY_FILES = [
  'convergence',
  'depthMerge',
  'microGap',
  'evidenceLens',
  'supportCensus',
  'temporalPhase',
  'movingSubset',
  'normalAgreement',
  'historyBudget',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

describe('display never upgrades evidence', () => {
  it('keeps continuity out of the authority surface', () => {
    const offenders: string[] = [];
    for (const rel of AUTHORITY_SURFACE) {
      for (const spec of importsOf(join(SRC, rel))) {
        const touches =
          CONTINUITY_SURFACE.some((c) => spec.includes(c)) ||
          CONTINUITY_FILES.some((f) => spec.endsWith(`/${f}`));
        if (touches) offenders.push(`${rel} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the authority surface out of continuity', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'render/streaming')).concat(
      walk(join(SRC, 'render/continuity')),
    )) {
      const rel = relative(SRC, file);
      if (!CONTINUITY_FILES.some((f) => rel.includes(f)) && !rel.includes('continuity')) continue;
      for (const spec of importsOf(file)) {
        if (spec.includes('stockpilePresenter') || spec.includes('profileSectionSnapshot')) {
          offenders.push(`${rel} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The behaviour the structure protects: an incomplete source caps the figure
  // at preview whatever the footprint looks like.
  it('caps an incomplete source at preview however good the coverage', () => {
    const complete = { sourceComplete: true, sampled: false, streaming: false };
    expect(stockpileAuthority('measured', complete).authority).toBe('measured');

    for (const scope of [
      { sourceComplete: false, sampled: false, streaming: true },
      { sourceComplete: false, sampled: false, streaming: false },
    ]) {
      const v = stockpileAuthority('measured', scope);
      expect(v.authority).toBe('preview');
      expect(v.reason).not.toBe('');
    }
  });

  it('keeps a refused coverage withheld whatever the source', () => {
    for (const sourceComplete of [true, false]) {
      expect(
        stockpileAuthority('refused', { sourceComplete, sampled: false, streaming: false })
          .authority,
      ).toBe('withheld');
    }
  });

  // A display sample is a presentation decision, and it caps the figure too.
  it('caps a display sample at preview', () => {
    expect(
      stockpileAuthority('measured', { sourceComplete: true, sampled: true, streaming: false })
        .authority,
    ).toBe('preview');
  });
});
