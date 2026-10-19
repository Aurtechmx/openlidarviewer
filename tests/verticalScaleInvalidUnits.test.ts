/**
 * verticalScaleInvalidUnits.test.ts
 *
 * A vertical unit the source declares but that cannot be read is not the
 * horizontal unit. The streaming grade, the classifier and the scan-type route
 * used to borrow the horizontal factor for Z and print metres for it. Each now
 * withholds what depends on Z and says why, and leaves the figures that do not
 * depend on it alone.
 */

import { describe, it, expect, vi } from 'vitest';

const { gradeFullCloud } = vi.hoisted(() => ({ gradeFullCloud: vi.fn() }));
vi.mock('../src/render/streaming/fullCloudGradeAdapter', () => ({ gradeFullCloud }));

import { runFullCloudGrade } from '../src/render/streaming/runFullCloudGradeAction';
import { gradeSampleDensity, summarizeSampleGrade } from '../src/render/streaming/sampleGrade';
import { classifierVerticalRefusal } from '../src/render/class/classifierCues';
import { runDeriveClassification, runFillUnclassified, type ClassifyActionsDeps } from '../src/app/classifyActions';
import { routeUnitFrame } from '../src/app/scanRouteCoordinator';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { PointCloud } from '../src/model/PointCloud';
import type { CrsInfo } from '../src/io/crs';

const base = {
  source: 'wkt', name: 'UTM 13N', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false,
} as CrsInfo;
const INVALID = spatialContextFrom({ ...base, verticalUnitToMetres: 0 } as CrsInfo);
const VALID = spatialContextFrom({ ...base, verticalUnitToMetres: 0.3048 } as CrsInfo);

/** A tall sample: a 10 m by 10 m footprint standing 40 m high, so the tier is judged by volume. */
function tallSample(): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i < 1500; i++) pts.push((i * 7) % 10, (i * 13) % 10, (i * 3) % 40);
  return Float32Array.from(pts);
}

describe('the full-cloud grade summary', () => {
  const grade = gradeSampleDensity(tallSample(), 1, 1, 1);

  it('is judged by volume for this sample', () => {
    expect(grade.bucketBasis).toBe('volumetric');
  });

  it('states the vertical extent and the volumetric density when the vertical unit is readable', () => {
    const lines = summarizeSampleGrade(grade, true, false);
    expect(lines.join('\n')).toMatch(/Vertical extent: \d+\.\d m/);
    expect(lines[0]).toMatch(/pts\/m³/);
  });

  it('withholds both, with the reason, when the vertical unit cannot be read', () => {
    const lines = summarizeSampleGrade(grade, true, true);
    expect(lines[0]).toBe('Density: not available: the height unit of the coordinate system could not be read');
    expect(lines).toContain('Vertical extent: not available: the height unit of the coordinate system could not be read');
    expect(lines.join('\n')).not.toMatch(/pts\/m³|\d m\b/);
  });

  it('runs through the action: the panel shows the withheld lines for an invalid frame', async () => {
    gradeFullCloud.mockReset();
    gradeFullCloud.mockImplementation(async (opts: { grade: (p: Float32Array, s: number) => unknown }) => ({
      kind: 'graded',
      run: { coverage: { label: 'Exact', note: 'n' }, grade: opts.grade(tallSample(), 1) },
    }));
    const panel = { setGradeBusy: vi.fn(), setGradeResult: vi.fn(), setGradeError: vi.fn(), setGradeCancelled: vi.fn() };
    const viewer = { streamingCloud: { crs: () => null }, streamingDecoder: {} };
    await runFullCloudGrade({ viewer, panel, context: INVALID } as never);
    const lines = panel.setGradeResult.mock.calls[0]![1] as string[];
    expect(lines.join('\n')).toContain('Vertical extent: not available');
    expect(lines.join('\n')).not.toMatch(/pts\/m³/);
    panel.setGradeResult.mockClear();
    await runFullCloudGrade({ viewer, panel, context: VALID } as never);
    expect((panel.setGradeResult.mock.calls[0]![1] as string[]).join('\n')).toMatch(/Vertical extent: \d/);
  });
});

describe('Classify and Fill unclassified', () => {
  it('names the refusal for an unreadable vertical unit and none otherwise', () => {
    expect(classifierVerticalRefusal(INVALID)).toMatch(/height unit .* could not be read/);
    expect(classifierVerticalRefusal(VALID)).toBeNull();
  });

  function deps(ctx = INVALID) {
    const toasts: string[] = [];
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'a.las',
      classification: Uint8Array.from([2, 0, 0]),
    });
    const d = {
      viewer: { getCloud: () => cloud, applyDerivedClassification: vi.fn(), classificationEpoch: () => 0 },
      activeId: () => 'a',
      crsService: { crsRevision: () => 0, context: () => ctx },
      toast: (m: string) => toasts.push(m),
      legend: {},
      setDerivedConfidence: vi.fn(),
      afterDerive: vi.fn(),
    } as unknown as ClassifyActionsDeps;
    const noClasses = new PointCloud({
      positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]), origin: [0, 0, 0], sourceFormat: 'las', name: 'b.las',
    });
    return { d, toasts, bare: { ...d, viewer: { ...d.viewer, getCloud: () => noClasses } } as ClassifyActionsDeps };
  }

  it('Classify does not run, and says why, in a frame with an unreadable height unit', async () => {
    const { toasts, bare } = deps();
    await runDeriveClassification(bare);
    expect(toasts.at(-1)).toMatch(/^Classify · not run: the height unit .* could not be read/);
    expect(bare.viewer.applyDerivedClassification).not.toHaveBeenCalled();
  });

  it('Fill unclassified does not run, and says why', async () => {
    const { d, toasts } = deps();
    await runFillUnclassified(d);
    expect(toasts.at(-1)).toMatch(/^Fill unclassified · not run: the height unit .* could not be read/);
    expect(d.viewer.applyDerivedClassification).not.toHaveBeenCalled();
  });
});

describe('scan-type routing frame', () => {
  it('treats the unit as unconfirmed when the vertical unit cannot be read', () => {
    expect(routeUnitFrame(() => INVALID).linearUnitKnown()).toBe(false);
    expect(routeUnitFrame(() => VALID).linearUnitKnown()).toBe(true);
    expect(routeUnitFrame(() => VALID).verticalUnitToMetres()).toBeCloseTo(0.3048, 9);
  });

  it('so room metrics are labelled as source units, not metres', () => {
    const f = routeUnitFrame(() => INVALID);
    const positions = Float32Array.from([0, 0, 0, 4, 0, 0, 4, 5, 0, 0, 5, 0, 0, 0, 3, 4, 5, 3]);
    const m = spaceMetrics(positions, {
      upAxis: 'z', spaceKind: 'interior', unitToMetres: f.linearUnitToMetres(), verticalUnitToMetres: f.verticalUnitToMetres(),
      unitKnown: f.linearUnitKnown(), hasRgb: false, sourcePointCount: 6, residentOnly: false,
    } as never);
    expect(m.reasons.join(' ')).toMatch(/Coordinate units are unverified, so dimensions, areas, volumes and densities are reported in the source file's own units, not in metres/);
    const known = spaceMetrics(positions, {
      upAxis: 'z', spaceKind: 'interior', unitToMetres: 1, verticalUnitToMetres: 1,
      unitKnown: routeUnitFrame(() => VALID).linearUnitKnown(), hasRgb: false, sourcePointCount: 6, residentOnly: false,
    } as never);
    expect(known.reasons.join(' ')).not.toMatch(/unverified/);
  });
});
