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

/**
 * A COPC/EPT source whose LAS header declares min = max = 0 on every axis while
 * the file carries millions of points. Real files do this: two public LAS 1.4
 * datasets in the corpus ship that header, cross-checked with WhiteboxTools
 * `lidar_info`. `dataBounds()` is the header box shifted by the render origin,
 * so it collapses to the single point `-renderOrigin`; `localBounds()` is the
 * octree root cube, which the COPC header parser refuses unless its half-size
 * is positive.
 */
function degenerateHeaderStreaming(
  renderOrigin: [number, number, number],
  cubeHalfSpan: number,
) {
  const [rx, ry, rz] = renderOrigin;
  return {
    renderOrigin,
    dataBounds: () => [-rx, -ry, -rz, -rx, -ry, -rz] as const,
    // The cube is centred on the render origin (which IS its floored centre),
    // so in local space it straddles zero.
    localBounds: () =>
      [
        -cubeHalfSpan,
        -cubeHalfSpan,
        -cubeHalfSpan,
        cubeHalfSpan,
        cubeHalfSpan,
        cubeHalfSpan,
      ] as const,
  };
}

describe('scanPrecision — a declared box that is not a box', () => {
  it('never reads a collapsed data box as a zero reach', () => {
    // The fabrication case: a LOCAL-frame source, where the collapsed box lands
    // exactly on the origin. Read straight it reports reach 0 and a 1.4e-45 m
    // step, which grades `fine` and grants a permit from no evidence at all.
    const p = scanPrecision({
      streaming: degenerateHeaderStreaming([0, 0, 0], 1_000),
      crs: METRE,
    })!;
    expect(p.reach).toBe(1_000);
    expect(p.metres!.worstCaseSpacing).toBe(float32Spacing(1_000));
  });

  it('refuses a local-frame scan whose octree cube is over budget', () => {
    const permit = scanPrecisionPermit({
      streaming: degenerateHeaderStreaming([0, 0, 0], 400_000),
      crs: METRE,
    })!;
    expect(permit.ok).toBe(false);
  });

  it('never reads a collapsed data box as the whole render origin', () => {
    // The false-refusal case: a GEOREFERENCED source, where the collapsed box
    // lands one render origin away from zero. Read straight it reports the UTM
    // northing as the reach (4,644,804), grades `unusable`, and blocks terrain
    // analysis on a dataset that is fine.
    const p = scanPrecision({
      streaming: degenerateHeaderStreaming([600_000, 4_644_804, 61], 1_000),
      crs: METRE,
    })!;
    expect(p.reach).toBe(1_000);
    expect(p.grade).toBe('fine');
    expect(scanPrecisionPermit({
      streaming: degenerateHeaderStreaming([600_000, 4_644_804, 61], 1_000),
      crs: METRE,
    })!.ok).toBe(true);
  });

  it('falls back to the cube when the data box carries a non-finite corner', () => {
    const source = {
      renderOrigin: [0, 0, 0] as [number, number, number],
      dataBounds: () => [-500, -500, Number.NaN, 500, 500, Number.NaN] as const,
      localBounds: () => [-1_000, -1_000, -1_000, 1_000, 1_000, 1_000] as const,
    };
    const p = scanPrecision({ streaming: source, crs: METRE })!;
    expect(p.reach).toBe(1_000);
    expect(Number.isFinite(p.metres!.worstCaseSpacing)).toBe(true);
  });

  it('still prefers the tight data box whenever it is readable', () => {
    // The cube over-reports the reach on the short axes, so it must stay the
    // fallback and never become the default.
    const p = scanPrecision({
      streaming: {
        ...streamingCloud([600_000, 4_500_000, 100], 20_000),
        localBounds: () => [-400_000, -400_000, -400_000, 400_000, 400_000, 400_000] as const,
      },
      crs: METRE,
    })!;
    expect(p.reach).toBe(20_000);
  });

  it('refuses, rather than grades, when no box on the scan is readable', () => {
    const inputs = {
      streaming: { renderOrigin: [0, 0, 0] as [number, number, number], dataBounds: () => [0, 0, 0, 0, 0, 0] as const },
      crs: METRE,
    };
    // No figure to report, and the refusal invents no metre step for one.
    expect(scanPrecision(inputs)).toBeNull();
    const permit = scanPrecisionPermit(inputs)!;
    expect(permit.ok).toBe(false);
    if (permit.ok) return;
    expect(permit.precision.metres).toBeNull();
    expect(permit.precision.grade).toBe('unknown');
    expect(permit.reasons.join(' ').toLowerCase()).toContain('bounding box');
  });

  it('refuses a static cloud whose scanned bounds hold no extent', () => {
    const permit = scanPrecisionPermit({
      cloud: {
        sourceOrigin: [500_000, 4_500_000, 0],
        bounds: () => ({ min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] }),
      },
      crs: METRE,
    })!;
    expect(permit.ok).toBe(false);
  });

  it('separates "no scan" from "a scan with no measurable frame"', () => {
    // `null` passes downstream (exportManifest blocks only on ok === false), so
    // an unmeasurable scan must never come back as `null`.
    expect(scanPrecisionPermit({ crs: METRE })).toBeNull();
    const unmeasurable = scanPrecisionPermit({
      streaming: { renderOrigin: [0, 0, 0], dataBounds: () => [0, 0, 0, 0, 0, 0] as const },
      crs: METRE,
    });
    expect(unmeasurable).not.toBeNull();
    expect(unmeasurable!.ok).toBe(false);
  });
});
