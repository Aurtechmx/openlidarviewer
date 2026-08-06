/**
 * tests/scanPrecisionPolicy.test.ts
 *
 * The reader that turns live app state into an in-memory precision permit.
 * The interesting part is WHICH origin and WHICH extent each loaded shape
 * holds: a static cloud recentres on its own floored minimum, a streaming
 * source on the floored octree-cube centre, and reading the wrong one either
 * under-reports the reach or invents a frame the buffer is not in.
 */

import { describe, it, expect } from 'vitest';
import { scanPrecision, scanPrecisionPermit } from '../src/app/scanPrecision';
import { float32Spacing } from '../src/geo/inMemoryPrecision';

const METRE = { linearUnit: 'metre', linearUnitToMetres: 1 } as const;

/** A static cloud recentred on `origin`, whose local residuals span `span`. */
function staticCloud(origin: [number, number, number], span: number) {
  return {
    sourceOrigin: origin,
    bounds: () => ({ min: [0, 0, 0] as [number, number, number], max: [span, span, span / 20] as [number, number, number] }),
  };
}

/** A streaming source whose local data extent straddles the render origin. */
function streamingCloud(renderOrigin: [number, number, number], halfSpan: number) {
  return {
    renderOrigin,
    dataBounds: () =>
      [-halfSpan, -halfSpan, -halfSpan / 20, halfSpan, halfSpan, halfSpan / 20] as const,
  };
}

describe('scanPrecision — which frame it reads', () => {
  it('returns null when nothing is loaded, which is not a pass', () => {
    expect(scanPrecision({ crs: METRE })).toBeNull();
    expect(scanPrecisionPermit({ crs: METRE })).toBeNull();
  });

  it('reads a static cloud from its source origin and local bounds', () => {
    const p = scanPrecision({ cloud: staticCloud([500_000, 4_500_000, 0], 20_000), crs: METRE });
    expect(p).not.toBeNull();
    expect(p!.localOrigin).toEqual([500_000, 4_500_000, 0]);
    expect(p!.reach).toBe(20_000);
    expect(p!.metres!.worstCaseSpacing).toBe(float32Spacing(20_000));
  });

  it('charges a static cloud for its extent, never for its absolute easting', () => {
    const near = scanPrecision({ cloud: staticCloud([0, 0, 0], 500), crs: METRE });
    const far = scanPrecision({ cloud: staticCloud([600_000, 4_100_876, 61], 500), crs: METRE });
    expect(far!.worstCaseSpacing).toBe(near!.worstCaseSpacing);
  });

  it('reads a streaming source from its render origin and TIGHT data bounds', () => {
    const p = scanPrecision({
      streaming: streamingCloud([600_000, 4_500_000, 100], 20_000),
      crs: METRE,
    });
    expect(p!.localOrigin).toEqual([600_000, 4_500_000, 100]);
    // Residuals straddle zero, so the reach is the half span, not the full one.
    expect(p!.reach).toBe(20_000);
  });

  it('prefers the static cloud when both are present', () => {
    const p = scanPrecision({
      cloud: staticCloud([0, 0, 0], 100),
      streaming: streamingCloud([0, 0, 0], 400_000),
      crs: METRE,
    });
    expect(p!.reach).toBe(100);
  });

  it('withholds metres when the CRS declares no linear unit', () => {
    const p = scanPrecision({
      cloud: staticCloud([0, 0, 0], 400_000),
      crs: { linearUnit: 'unknown', linearUnitToMetres: 1 },
    });
    expect(p!.metres).toBeNull();
    expect(p!.grade).toBe('unknown');
  });

  it('withholds metres when there is no CRS at all', () => {
    const p = scanPrecision({ cloud: staticCloud([0, 0, 0], 400_000) });
    expect(p!.metres).toBeNull();
  });
});

describe('scanPrecisionPermit — the gate the deliverables read', () => {
  it('grants a normal survey extent', () => {
    const permit = scanPrecisionPermit({ cloud: staticCloud([0, 0, 0], 2_000), crs: METRE });
    expect(permit!.ok).toBe(true);
  });

  it('refuses a continental extent with an actionable message', () => {
    const permit = scanPrecisionPermit({ cloud: staticCloud([0, 0, 0], 400_000), crs: METRE });
    expect(permit!.ok).toBe(false);
    if (permit!.ok) return;
    const text = permit!.reasons.join(' ').toLowerCase();
    expect(text).toContain('tile');
    expect(text).toContain('copc');
  });

  it('refuses a streaming source whose data extent is over budget', () => {
    const permit = scanPrecisionPermit({
      streaming: streamingCloud([0, 0, 0], 400_000),
      crs: METRE,
    });
    expect(permit!.ok).toBe(false);
  });

  it('honours a caller-supplied budget', () => {
    const inputs = { cloud: staticCloud([0, 0, 0], 20_000), crs: METRE };
    expect(scanPrecisionPermit({ ...inputs })!.ok).toBe(true);
    expect(scanPrecisionPermit({ ...inputs, budgetMetres: 0.001 })!.ok).toBe(false);
  });
});
