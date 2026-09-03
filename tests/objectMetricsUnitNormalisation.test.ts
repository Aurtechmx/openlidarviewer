/**
 * objectMetricsUnitNormalisation.test.ts
 *
 * Object mode measured whatever numbers the file carried and printed them as
 * metres. On a foot CRS every Object-panel figure was a foot figure wearing a
 * metre label: 3.2808x on lengths, 10.764x on areas, 35.315x on volumes.
 *
 * The fix normalises the positions to metres BEFORE objectMetrics runs, using
 * the same scale authority spaceMetrics uses, and only when the CRS actually
 * resolved a linear unit. These tests pin both halves: the metre/foot
 * equivalence of the measured figures, and the panel's refusal to print a
 * metre claim when the unit is unknown.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl, allTitles } from './support/objectPanelDom';
import { readFileSync } from 'node:fs';
import { objectMetrics } from '../src/terrain/objectMetrics';
import { resolveLinearUnitScale, spaceMetrics } from '../src/terrain/spaceMetrics';
import { positionsInMetres, scalePositions } from '../src/terrain/sourceScale';

const M_PER_FT = 0.3048;

/** A hollow box shell, 4 x 2 x 1 metres, sampled on a regular grid. */
function shellMetres(step = 0.1): Float32Array {
  const t: number[] = [];
  const push = (x: number, y: number, z: number): void => { t.push(x, y, z); };
  for (let x = 0; x <= 4 + 1e-9; x += step)
    for (let y = 0; y <= 2 + 1e-9; y += step) { push(x, y, 0); push(x, y, 1); }
  for (let x = 0; x <= 4 + 1e-9; x += step)
    for (let z = 0; z <= 1 + 1e-9; z += step) { push(x, 0, z); push(x, 2, z); }
  for (let y = 0; y <= 2 + 1e-9; y += step)
    for (let z = 0; z <= 1 + 1e-9; z += step) { push(0, y, z); push(4, y, z); }
  return Float32Array.from(t);
}

describe('object metrics are normalised to metres before measuring', () => {
  const metres = shellMetres();
  const feet = scalePositions(metres, 1 / M_PER_FT);

  it('the same object measured in metres and in feet reports the same figures', () => {
    const a = objectMetrics(
      positionsInMetres(metres, resolveLinearUnitScale(1, true)),
      { sourcePointCount: metres.length / 3 },
    );
    const b = objectMetrics(
      positionsInMetres(feet, resolveLinearUnitScale(M_PER_FT, true)),
      { sourcePointCount: feet.length / 3 },
    );
    const rel = (x: number, y: number): number => Math.abs(x - y) / Math.max(1e-9, Math.abs(x));
    for (const k of ['lengthM', 'widthM', 'heightM'] as const) {
      expect(rel(a.obb[k], b.obb[k])).toBeLessThan(1e-4);
      expect(rel(a.aabb[k], b.aabb[k])).toBeLessThan(1e-4);
    }
    expect(rel(a.longestDimensionM, b.longestDimensionM)).toBeLessThan(1e-4);
    expect(rel(a.medianSpacingM, b.medianSpacingM)).toBeLessThan(1e-4);
    expect(rel(a.surfaceAreaM2, b.surfaceAreaM2)).toBeLessThan(1e-4);
    expect(rel(a.envelopeVolumeM3, b.envelopeVolumeM3)).toBeLessThan(1e-4);
    // And the metre run is the truth the figures are compared against.
    expect(a.longestDimensionM).toBeCloseTo(4, 2);
  });

  it('an unknown linear unit is left in source units, never scaled', () => {
    const same = positionsInMetres(feet, resolveLinearUnitScale(M_PER_FT, false));
    expect(same[0]).toBe(feet[0]);
    expect(same[300]).toBe(feet[300]);
  });
});

// ── The panel must not print a metre claim it cannot support ────────────────


beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

describe('ObjectPanel - an unknown unit prints no metre, foot or centimetre claim', () => {
  it('renders source-unit figures only', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const positions = shellMetres(0.2);
    const space = spaceMetrics(positions, {
      upAxis: 'z', spaceKind: 'object', unitToMetres: 1, unitKnown: false,
      sourcePointCount: positions.length / 3,
    });
    const panel = new ObjectPanel();
    panel.showObject(objectMetrics(positions), space, null);
    const root = panel.element as unknown as FakeEl;
    const text = `${root.textContent} ${allTitles(root).join(' ')}`;
    expect(text).not.toMatch(/\d\s*(m|ft|cm|m²|ft²|m³|ft³)\b/);
    expect(text).not.toContain('pts/m²');
    expect(text).toContain('source units');
  });

  it('a known foot CRS still prints metres with the foot conversion', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const positions = shellMetres(0.2);
    const space = spaceMetrics(positions, {
      upAxis: 'z', spaceKind: 'object', unitToMetres: M_PER_FT, unitKnown: true,
      sourcePointCount: positions.length / 3,
    });
    const panel = new ObjectPanel();
    panel.showObject(objectMetrics(positions), space, null);
    const text = (panel.element as unknown as FakeEl).textContent;
    expect(text).toMatch(/\bm\b/);
    expect(text).toMatch(/\bft\b/);
  });
});

describe('the call site itself is normalised, not just the helper', () => {
  // The defect was never in objectMetrics; it was that main.ts handed it raw
  // source-unit positions while spaceMetrics scaled the same buffer first.
  // Both accept `Float32Array | ReadonlyArray<number>`, so removing the wrapper
  // type-checks and every helper test still passes. This reads the wiring.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  it('passes objectMetrics positions converted to metres', () => {
    const call = /objectMetrics\(\s*([^,]+),/.exec(main);
    expect(call, 'objectMetrics call site not found in main.ts').toBeTruthy();
    expect(call![1]).toMatch(/positionsInMetres\(/);
  });

  it('resolves the scale from the CRS unit-known flag, not the bare factor', () => {
    expect(main).toMatch(/resolveLinearUnitScale\(\s*unitToMetres,\s*spaceCtx\.linearUnitKnown\s*\)/);
  });

  it('never hands objectMetrics the raw gathered buffer', () => {
    expect(main).not.toMatch(/objectMetrics\(\s*gathered\.positions/);
  });
});
