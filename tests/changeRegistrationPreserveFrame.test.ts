/**
 * Change detection keeps the supplied coordinates of a georeferenced pair and
 * fits local-frame pairs only when the surface determines the pose.
 *
 * A rigid fit cannot separate a horizontal shift along a slope from a real
 * change in height: on z = s·x a uniform uplift Δz is removed exactly by
 * moving the after cloud Δz/s in x. Fitting yaw + x/y/z and then discarding z
 * let the horizontal terms absorb real change (slope 0.5, +1 m uplift: a
 * +0.40 m x shift applied and a mean |change| of 0.800 m instead of 1.000 m).
 *
 * Each case runs the live compare sequence (alignment, shared DTMs with
 * hold-out σz, compareDtms with the propagated level of detection and no σreg,
 * the panel summaries and the .asc raster) and checks they agree.
 */
import { describe, expect, test } from 'vitest';
import {
  alignEpochClouds,
  summarizeAlignment,
  buildRegistrationArtifact,
  summarizeRegistration,
} from '../src/terrain/change/alignEpochs';
import { buildSharedEpochDtms, type EpochCloud } from '../src/terrain/change/compareEpochs';
import { compareDtms, summarizeChange } from '../src/terrain/change/compareDtms';
import { propagatedLevelOfDetection } from '../src/terrain/change/propagatedLod';
import { packageChangeRaster } from '../src/terrain/change/changeRaster';

type Surface = (x: number, y: number) => number;
interface Pose { readonly dx: number; readonly dy: number; readonly yawDeg: number }
const NO_POSE: Pose = { dx: 0, dy: 0, yawDeg: 0 };

/**
 * A 1-unit lattice over [0,nx]×[0,ny], heights `surf + dz`, then moved by
 * `pose` (yaw about the lattice centre, then shift). Heights are in source
 * units like the coordinates.
 */
function lattice(surf: Surface, dz: number, pose: Pose = NO_POSE, nx = 50, ny = 50): Float32Array {
  const a = (pose.yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const cx = nx / 2, cy = ny / 2;
  const out: number[] = [];
  for (let y = 0; y <= ny; y++) {
    for (let x = 0; x <= nx; x++) {
      const u = x - cx, v = y - cy;
      out.push(c * u - s * v + cx + pose.dx, s * u + c * v + cy + pose.dy, surf(x, y) + dz);
    }
  }
  return new Float32Array(out);
}

interface Frame {
  readonly crs: string | null;
  readonly verticalDatum: string | null;
  readonly unitToMetres: number;
  readonly origin: [number, number, number];
  /** Projection text for the raster's .prj when the built-in table has none. */
  readonly wkt?: string;
}
const UTM: Frame = { crs: 'EPSG:32612', verticalDatum: 'NAVD88', unitToMetres: 1, origin: [0, 0, 0] };
const UTM_FAR: Frame = { ...UTM, origin: [500000, 4000000, 100] };
/** NAD83 / Colorado North (ftUS), heights NAVD88 in US survey feet, at a large origin. */
const FEET: Frame = {
  crs: 'EPSG:2231', verticalDatum: 'NAVD88', unitToMetres: 1200 / 3937, origin: [3000000, 1500000, 5000],
  wkt: 'PROJCS["NAD83 / Colorado North (ftUS)",UNIT["US survey foot",0.304800609601219],AUTHORITY["EPSG","2231"]]',
};
const LOCAL: Frame = { crs: null, verticalDatum: null, unitToMetres: 1, origin: [0, 0, 0] };

const epoch = (positions: Float32Array, f: Frame): EpochCloud => ({
  positions,
  origin: f.origin,
  crs: f.crs,
  verticalDatum: f.verticalDatum,
  linearUnitToMetres: f.unitToMetres,
  verticalUnitToMetres: f.unitToMetres,
});

/** The live compare sequence (src/main.ts compareLoadedLayers), panel and raster. */
function runCompare(before: EpochCloud, after: EpochCloud, f: Frame) {
  const h = f.unitToMetres;
  const { after: aligned, alignment } = alignEpochClouds(before, after, { maxResidualM: 5, horizontalUnitKnown: true });
  const dtms = buildSharedEpochDtms(before, aligned, { holdoutSigmaZ: true });
  if (!dtms) throw new Error('no DTMs');
  const lod = propagatedLevelOfDetection({
    sigmaZBeforeM: dtms.sigmaZ?.before, sigmaZAfterM: dtms.sigmaZ?.after, sigmaRegM: null,
    verticalUnitKnown: true, horizontalUnitKnown: true,
  });
  const cmp = compareDtms(dtms.before, dtms.after, {
    isGeographic: false, horizontalUnitKnown: true, horizontalUnitToMetres: h, verticalUnitToMetres: h, levelOfDetection: lod,
  });
  const record = buildRegistrationArtifact(alignment, { targetId: 'a', targetName: 'a', sourceId: 'b', sourceName: 'b' }, 0);
  const panel = [
    summarizeAlignment(alignment),
    summarizeRegistration(record),
    ...summarizeChange(cmp, { registrationSigmaM: 0, horizontalUnitToMetres: h }),
  ];
  // The .asc the panel offers: cell values in the source linear unit.
  const asc = packageChangeRaster(
    { diff: h === 1 ? cmp.result.diff : cmp.result.diff.map((v) => v / h), ncols: dtms.cols, nrows: dtms.rows, cellSizeM: dtms.cellSizeM, xllCorner: dtms.before.originH1, yllCorner: dtms.before.originH2 },
    { crs: f.crs ? { kind: 'projected', name: f.crs, epsg: Number(f.crs.slice(5)), ...(f.wkt ? { wkt: f.wkt } : {}) } : { kind: 'local', name: 'local' }, valueUnit: h === 1 ? 'metre' : 'US survey foot', beforeScan: 'a', afterScan: 'b' },
  ).asc();
  const lines = asc.trim().split('\n');
  const nodata = Number(lines.find((l) => /^nodata_value/i.test(l))!.split(/\s+/)[1]);
  const values = lines.filter((l) => !/^[a-z]/i.test(l)).flatMap((l) => l.trim().split(/\s+/).map(Number)).filter((v) => v !== nodata);
  const rasterMeanAbsM = values.reduce((s, v) => s + Math.abs(v), 0) / values.length * h;
  const rasterMeanM = values.reduce((s, v) => s + v, 0) / values.length * h;
  return { alignment, aligned, record, cmp, panel, rasterMeanAbsM, rasterMeanM, rasterCells: values.length };
}

const slope = (s: number): Surface => (x) => s * x;
/** Stable relief that constrains yaw, x, y and z: varies along both axes, not periodic over the scene. */
const relief: Surface = (x, y) => 3 * Math.sin(x / 9) + 2 * Math.cos(y / 7) + 0.02 * x + 1.5 * Math.exp(-((x - 30) ** 2 + (y - 18) ** 2) / 40);

/** Grid tolerance on the mean change: lattice heights are exact up to float32 storage. */
const TOL_M = 1e-3;

describe('georeferenced pairs keep their supplied coordinates', () => {
  const cases: Array<[string, Frame]> = [['UTM metres', UTM], ['UTM metres at 500000, 4000000', UTM_FAR], ['US survey feet at a large origin', FEET]];
  for (const [label, frame] of cases) {
    for (const s of [0, 0.1, -0.1, 0.5, -0.5, 1, -1]) {
      for (const upliftM of [1, -1]) {
        test(`${label}: slope ${s}, ${upliftM > 0 ? '+' : ''}${upliftM} m`, () => {
          const dz = upliftM / frame.unitToMetres; // uplift in source units
          const before = epoch(lattice(slope(s), 0), frame);
          const after = epoch(lattice(slope(s), dz), frame);
          const r = runCompare(before, after, frame);
          expect(r.alignment.frameKept).toBe(true);
          expect(r.alignment.attempted).toBe(false);
          expect(r.alignment.applied).toBe(false);
          expect(r.alignment.appliedDof).toBe('none');
          expect(r.aligned).toBe(after); // the supplied coordinates, untouched
          expect(r.record.estimated).toBe(false);
          expect(r.record.registrationSigmaM).toBeNull();
          expect(r.cmp.coregistered).toBe(true);
          const st = r.cmp.result.stats;
          expect(st.comparable).toBeGreaterThan(0);
          expect(st.meanAbsChangeM).toBeCloseTo(1, 3);
          expect(Math.abs(st.meanAbsChangeM - 1)).toBeLessThan(TOL_M);
          // Panel and raster agree with the statistics.
          expect(r.panel.join('\n')).toContain(`mean |Δ| ${st.meanAbsChangeM.toFixed(2)} m`);
          expect(r.panel.join('\n')).toContain('mean |Δ| 1.00 m');
          expect(r.rasterCells).toBe(st.comparable);
          expect(Math.abs(r.rasterMeanAbsM - 1)).toBeLessThan(TOL_M);
          expect(Math.sign(r.rasterMeanM)).toBe(Math.sign(upliftM));
          expect(r.panel[0]).toMatch(/Registration: not estimated/);
          expect(r.panel[0]).toMatch(/uncertainty is not quantified/);
          expect(r.panel[1]).toMatch(/not estimated .*registration uncertainty not quantified/);
          // σreg stays missing, so the level of detection is a lower bound.
          expect(r.cmp.levelOfDetection.basis).toBe('incomplete');
          expect(r.panel.join('\n')).not.toMatch(/\d+\.\d+ m shift/);
        });
      }
    }
  }

  test('a real horizontal misregistration in a georeferenced pair is not corrected (stated limitation)', () => {
    const before = epoch(lattice(relief, 0), UTM);
    const after = epoch(lattice(relief, 0, { dx: 0.5, dy: 0.3, yawDeg: 1 }), UTM);
    const r = runCompare(before, after, UTM);
    expect(r.alignment.frameKept).toBe(true);
    expect(r.aligned).toBe(after);
  });
});

describe('local-frame pairs: fitted only when the surface determines the pose', () => {
  test('a plane is refused as unobservable on every slope, and the change survives', () => {
    for (const s of [0, 0.1, 0.5, 1, -0.5]) {
      const before = epoch(lattice(slope(s), 0), LOCAL);
      const after = epoch(lattice(slope(s), 1), LOCAL);
      const r = runCompare(before, after, LOCAL);
      expect(r.alignment.unobservable).toBe(true);
      expect(r.alignment.applied).toBe(false);
      expect(r.alignment.observability?.observable).toBe(false);
      expect(r.alignment.centroidShiftM).toBeUndefined();
      expect(r.aligned).toBe(after);
      expect(r.record.unobservable).toBe(true);
      expect(r.record.estimated).toBe(false);
      expect(r.panel[0]).toMatch(/refused as unobservable/);
      expect(r.cmp.result.stats.meanAbsChangeM).toBeCloseTo(1, 3);
    }
  });

  test('informative relief, no offset, +1 m uplift: no false shift and the full change', () => {
    const r = runCompare(epoch(lattice(relief, 0), LOCAL), epoch(lattice(relief, 1), LOCAL), LOCAL);
    expect(r.alignment.observability?.observable).toBe(true);
    if (r.alignment.applied) {
      expect(Math.hypot(r.alignment.centroidShiftM![0], r.alignment.centroidShiftM![1])).toBeLessThan(0.02);
      expect(Math.abs(r.alignment.yawDeg)).toBeLessThan(0.02);
    }
    expect(Math.abs(r.cmp.result.stats.meanAbsChangeM - 1)).toBeLessThan(0.01);
  });

  for (const upliftM of [1, -1]) {
    test(`informative relief with a known 0.5 m, 0.3 m, 1° offset and ${upliftM} m change: recovered`, () => {
      const truth: Pose = { dx: 0.5, dy: 0.3, yawDeg: 1 };
      const before = epoch(lattice(relief, 0), LOCAL);
      const after = epoch(lattice(relief, upliftM, truth), LOCAL);
      const r = runCompare(before, after, LOCAL);
      expect(r.alignment.observability?.observable).toBe(true);
      expect(r.alignment.applied).toBe(true);
      // The aligned after lattice lands back on the unmoved lattice.
      const ref = lattice(relief, upliftM);
      let err = 0;
      for (let i = 0; i < ref.length; i += 3) err = Math.max(err, Math.hypot(r.aligned.positions[i] - ref[i], r.aligned.positions[i + 1] - ref[i + 1]));
      expect(err).toBeLessThan(0.05);
      expect(r.alignment.yawDeg).toBeCloseTo(-1, 1);
      // Fit residual, applied-pose residual and σreg are separate figures.
      expect(r.record.solverResidualM).toBeLessThan(0.05);
      expect(r.record.appliedTransformResidualM).toBeGreaterThan(0.5); // z kept: the change stays
      expect(r.record.registrationSigmaM).toBeNull();
      expect(r.panel[0]).toMatch(/registration uncertainty is not quantified/);
      expect(r.panel[0]).toMatch(/does not validate the alignment/);
      expect(Math.abs(r.cmp.result.stats.meanAbsChangeM - 1)).toBeLessThan(0.02);
      expect(Math.sign(r.rasterMeanM)).toBe(Math.sign(upliftM));
    });
  }
});

describe('partial overlap', () => {
  test('georeferenced, after extends 30 % past before, +1 m: no shift, mean |change| 1.000 m', () => {
    const before = epoch(lattice(slope(0.5), 0, NO_POSE, 50, 50), UTM);
    const after = epoch(lattice(slope(0.5), 1, NO_POSE, 65, 50), UTM);
    const r = runCompare(before, after, UTM);
    expect(r.alignment.frameKept).toBe(true);
    expect(r.aligned).toBe(after);
    // Cells on the before epoch's edge hold points only up to x = 50 in the
    // before epoch but past it in the after one; on a 0.5 slope their heights
    // differ by a fraction of a cell, so the mean is within 0.02 m, not 1e-3.
    expect(Math.abs(r.cmp.result.stats.meanAbsChangeM - 1)).toBeLessThan(0.02);
    expect(Math.abs(r.rasterMeanAbsM - r.cmp.result.stats.meanAbsChangeM)).toBeLessThan(1e-6);
  });

  test('local frame, after extends 30 % past before with a known offset: recovered or withheld, never a large false shift', () => {
    const truth: Pose = { dx: 0.5, dy: 0.3, yawDeg: 1 };
    const before = epoch(lattice(relief, 0, NO_POSE, 50, 50), LOCAL);
    const after = epoch(lattice(relief, 1, truth, 65, 50), LOCAL);
    const r = runCompare(before, after, LOCAL);
    if (r.alignment.applied) {
      const c = r.alignment.centroidShiftM!;
      expect(Math.hypot(c[0], c[1])).toBeLessThan(1.5);
      expect(Math.abs(r.cmp.result.stats.meanAbsChangeM - 1)).toBeLessThan(0.1);
    } else {
      expect(r.panel[0]).toMatch(/withheld|refused/i);
    }
  });
});
