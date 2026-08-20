/**
 * toolPreflight.test.ts
 *
 * The preflight model has one job: when a tool is limited, say which condition
 * limits it and what would lift it. These tests pin the four conditions the
 * v0.6.6 interaction brief names — an unresolved physical unit, no proven shared
 * vertical reference across the visible layers, streaming data still refining,
 * and a classification prerequisite that needs a confirmed physical scale — plus
 * the state where nothing limits the tool at all.
 *
 * They also pin the property that makes the model safe to build a UI on: every
 * verdict comes from the service that already owns it (SpatialContext for the
 * unit, measureConfidence for the shared reference, the capability model for
 * derived products), so a status can never be more permissive than the authority
 * behind it.
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { ScanFacts } from '../src/process/ProcessPlan';
import {
  ALL_TOOLS,
  preflightAll,
  preflightFor,
  type PreflightInput,
  type ToolPreflight,
} from '../src/process/toolPreflight';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A projected metre CRS with an orthometric vertical datum — nothing unknown. */
function fullyKnownCrs(overrides: Partial<CrsInfo> = {}): CrsInfo {
  return {
    source: 'epsg',
    name: 'WGS 84 / UTM zone 12N',
    epsg: 32612,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    isGeographic: false,
    verticalEpsg: 5703,
    verticalDatum: 'NAVD88',
    verticalUnitToMetres: 1,
    ...overrides,
  } as CrsInfo;
}

function scan(overrides: Partial<ScanFacts> = {}): ScanFacts {
  return {
    kind: 'static',
    coverage: 'full',
    crs: fullyKnownCrs(),
    pointCount: 1_000_000,
    hasRgb: true,
    hasIntensity: true,
    hasGpsTime: true,
    hasReturnNumber: true,
    hasPointSourceId: false,
    classification: 'full',
    classificationProvenance: 'producer',
    groundClassified: true,
    hasBuildingClass: true,
    medianSpacing: 0.2,
    ...overrides,
  };
}

/** The state where every fact is established: one scan, known frame, datum held. */
function readyInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    scans: [scan()],
    spatial: spatialContextFrom(fullyKnownCrs()),
    layerCompatibility: ['verified'],
    datumResolved: true,
    ...overrides,
  };
}

const codes = (p: ToolPreflight): readonly string[] => p.reasons.map((r) => r.code);
const actions = (p: ToolPreflight): readonly string[] => p.remediations.map((r) => r.action);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unresolved physical unit
// ─────────────────────────────────────────────────────────────────────────────

describe('unresolved physical unit', () => {
  /** No CRS at all: the context refuses metric claims, so a volume is exploratory. */
  const unitless: PreflightInput = readyInput({
    scans: [scan({ crs: null })],
    spatial: spatialContextFrom(null),
  });

  it('holds a volume at exploratory rather than presenting it as a metric figure', () => {
    const p = preflightFor('measure-volume', unitless);
    expect(p.status).toBe('review');
    expect(codes(p)).toContain('UNIT_UNRESOLVED');
  });

  it('offers setting the coordinate system, or continuing exploratory', () => {
    const p = preflightFor('measure-volume', unitless);
    expect(actions(p)).toContain('set-coordinate-system');
    expect(actions(p)).toContain('continue-exploratory');
  });

  it('names the condition on every metric measurement, not just volume', () => {
    for (const tool of ['measure-distance', 'measure-area', 'measure-height'] as const) {
      expect(codes(preflightFor(tool, unitless))).toContain('UNIT_UNRESOLVED');
    }
  });

  it('reads the verdict from the spatial context, not from a private unit test', () => {
    // The context is the authority: while it permits metric claims, no preflight
    // may report an unresolved unit, whatever else is true of the scan.
    const permitted = readyInput();
    expect(permitted.spatial.metricClaimsPermitted).toBe(true);
    for (const tool of ALL_TOOLS) {
      expect(codes(preflightFor(tool, permitted))).not.toContain('UNIT_UNRESOLVED');
    }
  });

  it('blocks a metric product outright where the capability model does', () => {
    // Footprint AREA cannot be exploratory: the capability model blocks it on an
    // unconfirmed unit, and the preflight carries that verdict rather than
    // softening it — so the permissive action is withheld too.
    const p = preflightFor('building-footprints', unitless);
    expect(p.status).toBe('blocked');
    expect(codes(p)).toContain('UNIT_UNKNOWN');
    expect(actions(p)).toEqual(['set-coordinate-system']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. No proven shared vertical reference across the visible layers
// ─────────────────────────────────────────────────────────────────────────────

describe('no proven shared reference across visible layers', () => {
  /** Two layers, one proven to be in a different frame. */
  const incomparable: PreflightInput = readyInput({
    scans: [scan(), scan()],
    layerCompatibility: ['verified', 'incompatible'],
  });

  it('refuses a height across layers that are in incomparable frames', () => {
    const p = preflightFor('measure-height', incomparable);
    expect(p.status).toBe('blocked');
    expect(codes(p)).toContain('NO_SHARED_REFERENCE');
  });

  it('offers soloing the active layer or inspecting each layer CRS', () => {
    const p = preflightFor('measure-height', incomparable);
    expect(actions(p)).toEqual(['solo-active-layer', 'inspect-layer-crs']);
  });

  it('never offers "continue" once the reference is refused', () => {
    const p = preflightFor('measure-volume', incomparable);
    expect(p.status).toBe('blocked');
    expect(actions(p)).not.toContain('continue-exploratory');
    expect(actions(p)).not.toContain('continue-resident-only');
  });

  it('degrades to review, not ready, when the layer set is merely unproven', () => {
    // No compatibility set supplied over two scans: unproven, which is a caveat
    // rather than a refusal.
    const unproven = readyInput({ scans: [scan(), scan()], layerCompatibility: undefined });
    const p = preflightFor('measure-height', unproven);
    expect(p.status).toBe('review');
    expect(codes(p)).toContain('SHARED_REFERENCE_UNPROVEN');
  });

  it('blocks cross-epoch change when the two scans declare different vertical datums', () => {
    const differing = readyInput({
      scans: [
        scan(),
        scan({ crs: fullyKnownCrs({ verticalEpsg: 3855, verticalDatum: 'EGM2008 height' }) }),
      ],
      layerCompatibility: ['verified', 'horizontal-only'],
      projectFrameCompatible: true,
    });
    const p = preflightFor('cross-epoch-change', differing);
    expect(p.status).toBe('blocked');
    expect(codes(p)).toContain('VERTICAL_REF_DIFFERS');
    expect(actions(p)).toEqual(['solo-active-layer', 'inspect-layer-crs']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Streaming data still refining — resident-only coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('streaming data still refining', () => {
  const streaming: PreflightInput = readyInput({
    scans: [scan({ kind: 'streaming', coverage: 'resident-only' })],
  });

  it('marks a measurement as scoped to the resident points', () => {
    const p = preflightFor('measure-distance', streaming);
    expect(p.status).toBe('review');
    expect(codes(p)).toContain('STREAMING_RESIDENT_ONLY');
  });

  it('offers waiting for full visible coverage, or continuing resident-only', () => {
    const p = preflightFor('measure-distance', streaming);
    expect(actions(p)).toEqual(['await-full-coverage', 'continue-resident-only']);
  });

  it('carries the capability model verdict for a derived surface', () => {
    const p = preflightFor('terrain-dtm', streaming);
    expect(p.status).toBe('review');
    expect(codes(p)).toContain('RESIDENT_ONLY');
    expect(actions(p)).toContain('await-full-coverage');
  });

  it('does not raise the condition once coverage is full', () => {
    const p = preflightFor('measure-distance', readyInput());
    expect(codes(p)).not.toContain('STREAMING_RESIDENT_ONLY');
  });

  it('distinguishes a sampled read from a resident-only one', () => {
    const sampled = readyInput({ scans: [scan({ coverage: 'sampled' })] });
    expect(codes(preflightFor('measure-area', sampled))).toContain('SAMPLED_COVERAGE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Classification prerequisites needing a confirmed physical scale
// ─────────────────────────────────────────────────────────────────────────────

describe('classification prerequisites', () => {
  it('holds classification at review while the physical scale is unconfirmed', () => {
    const unitless = readyInput({
      scans: [scan({ crs: null, classification: 'none', classificationProvenance: 'none' })],
      spatial: spatialContextFrom(null),
    });
    const p = preflightFor('classify', unitless);
    expect(p.status).toBe('review');
    expect(codes(p)).toContain('UNIT_UNKNOWN');
    expect(actions(p)).toEqual(['set-coordinate-system', 'continue-exploratory']);
  });

  it('asks for classification first where a product needs the classes', () => {
    const unclassified = readyInput({
      scans: [
        scan({
          classification: 'none',
          classificationProvenance: 'none',
          groundClassified: false,
          hasBuildingClass: false,
        }),
      ],
    });
    const p = preflightFor('building-footprints', unclassified);
    expect(p.status).toBe('review');
    expect(codes(p)).toContain('NEEDS_CLASSIFICATION');
    expect(actions(p)).toContain('classify-scan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Nothing limits the tool
// ─────────────────────────────────────────────────────────────────────────────

describe('the fully ready state', () => {
  it('names no condition and offers no remediation', () => {
    const p = preflightFor('measure-distance', readyInput());
    expect(p.status).toBe('ready');
    expect(p.reasons).toEqual([]);
    expect(p.remediations).toEqual([]);
  });

  it('reaches ready for a height and for a derived surface too', () => {
    for (const tool of ['measure-height', 'measure-volume', 'terrain-dtm', 'terrain-dsm'] as const) {
      const p = preflightFor(tool, readyInput());
      expect(p.status).toBe('ready');
      expect(p.reasons).toEqual([]);
    }
  });

  it('blocks every measurement when no scan is loaded', () => {
    const empty: PreflightInput = {
      scans: [],
      spatial: spatialContextFrom(fullyKnownCrs()),
      datumResolved: true,
    };
    const p = preflightFor('measure-area', empty);
    expect(p.status).toBe('blocked');
    expect(codes(p)).toEqual(['NO_SCAN_LOADED']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model shape
// ─────────────────────────────────────────────────────────────────────────────

describe('model shape', () => {
  it('answers for every tool, and the batch answers match the single answers', () => {
    const ctx = readyInput({ scans: [scan({ coverage: 'resident-only', kind: 'streaming' })] });
    const all = preflightAll(ctx);
    expect(all.map((p) => p.tool)).toEqual([...ALL_TOOLS]);
    for (const p of all) {
      expect(preflightFor(p.tool, ctx)).toEqual(p);
    }
  });

  it('never offers a remediation without a reason behind it', () => {
    for (const ctx of [
      readyInput(),
      readyInput({ scans: [scan({ crs: null })], spatial: spatialContextFrom(null) }),
      readyInput({ scans: [], layerCompatibility: [] }),
    ]) {
      for (const p of preflightAll(ctx)) {
        if (p.reasons.length === 0) expect(p.remediations).toEqual([]);
        if (p.status === 'ready') expect(p.reasons).toEqual([]);
      }
    }
  });
});
