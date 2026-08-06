/**
 * lintSpatialContext.test.ts
 *
 * Guards the guard. `lint-spatial-context.mjs` is the only thing that stops the
 * SpatialContext migration rotting, and its failure mode is silence: a scanner
 * that quietly stops matching reports a clean tree in exactly the same words it
 * uses for a clean tree. So the banned-form scanner is pinned here — both that
 * it flags the ad-hoc predicates the context replaced, and that it does NOT
 * flag the context reads that look superficially similar.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { scanDeprecated, stripComments } from '../scripts/lint-spatial-context.mjs';

type Hit = { line: number; what: string; instead: string };
const scan = (src: string): Hit[] => scanDeprecated(src) as Hit[];

describe('lint-spatial-context — banned forms', () => {
  it('flags a re-introduced isLinearUnitKnown call', () => {
    expect(scan('const ok = isLinearUnitKnown(crs);')).toHaveLength(1);
  });

  it('flags a second call to the vertical-datum classifier', () => {
    expect(scan("const r = verticalReferenceFromDatum({ verticalDatum: d });")).toHaveLength(1);
  });

  it('flags a direct ladder call beside a context', () => {
    expect(scan('const v = validateCrsForMeasurement(resolved);')).toHaveLength(1);
  });

  it('flags a hand-derived geographic test', () => {
    expect(scan("const geo = crs?.kind === 'geographic';")).toHaveLength(1);
    expect(scan("const geo = resolved.kind === 'geographic';")).toHaveLength(1);
  });

  it('flags a hand-written vertical-unit fallback chain', () => {
    expect(scan('const v = crs?.verticalUnitToMetres ?? crs?.linearUnitToMetres ?? 1;'))
      .toHaveLength(1);
  });

  it('flags a local vertical-datum allow-list spelled out by code', () => {
    expect(scan("return v === 'epsg:4979' || v === '4979';").length).toBeGreaterThan(0);
  });

  it('reports the real line number, not one shifted by a stripped block comment', () => {
    const src = ['/**', ' * six', ' * line', ' * doc', ' */', 'const ok = isLinearUnitKnown(crs);'].join('\n');
    expect(scan(src)[0].line).toBe(6);
  });
});

describe('lint-spatial-context — what it must NOT flag', () => {
  it('allows reading the context fields', () => {
    expect(scan('const ok = ctx.linearUnitKnown;')).toHaveLength(0);
    expect(scan('const geo = ctx.isGeographic;')).toHaveLength(0);
    expect(scan("if (ctx.kind === 'geographic') return;")).toHaveLength(0);
  });

  it('allows the named vertical-scale policy call', () => {
    expect(scan("const v = verticalMetresPerUnit(ctx, 'horizontal-when-known');")).toHaveLength(0);
  });

  it('allows the "is this a real-world frame" test, which asks a different question', () => {
    expect(scan("return crs.kind === 'projected' || crs.kind === 'geographic';")).toHaveLength(0);
  });

  it('does not flag prose that documents the banned form', () => {
    const src = ['/**', ' * Replaces isLinearUnitKnown(crs) at this seam.', ' */', 'const ok = ctx.linearUnitKnown;'].join('\n');
    expect(scan(src)).toHaveLength(0);
  });

  it('does not flag a line comment mentioning the banned form', () => {
    expect(scan('const ok = ctx.linearUnitKnown; // was isLinearUnitKnown(crs)')).toHaveLength(0);
  });
});

describe('lint-spatial-context — comment stripping keeps line count', () => {
  it('preserves the number of lines so offsets stay true', () => {
    const src = 'a\n/* two\nline */\nb\n';
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
  });
});
