/**
 * groundFilterPdalAgreement.test.ts — the OpenLiDARViewer side of the two PDAL
 * studies, and the file that computes their numbers.
 *
 * Every cross-implementation comparison in this repository before these two
 * started from a DEM. `tests/rasterAgreementMatrix.test.ts` compares raster
 * kernels against GDAL, which says whether our Horn kernel matches another Horn
 * kernel; it says nothing about the path a survey actually takes, which starts
 * at returns. These studies start at returns: `classifyGroundSmrf` against
 * `filters.smrf`, and `rasterizeDtm` against `writers.gdal`.
 *
 * This file promotes nothing. `docs/validation/claim-register.yaml` and
 * `REFERENCE_SLOTS` in `src/validation/crossCheck.ts` are untouched.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVIDENCE LEVEL
 * ─────────────────────────────────────────────────────────────────────────────
 * The scenes are synthetic and their ground membership is known by
 * construction, so the leg that compares our filter against those labels is E3
 * — one implementation against a generator this project also wrote, however
 * many scenes there are. It is E4 only where a second independent
 * implementation produced the reference. Every leg written to `results.json`
 * carries `reference` and `evidenceLevel`, and only the PDAL legs are
 * cross-implementation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING IS INFERRED, AND NOTHING IS SUBSTITUTED
 * ─────────────────────────────────────────────────────────────────────────────
 * If a PDAL output is missing, its leg is recorded `unavailable` and no number
 * is written for it. A zero, or an inferred pass, would be a fabricated
 * reference. If the reference output does not line up with the fixture row for
 * row, the leg is `invalid` and its numbers must not be read: two arrays
 * compared under a silent index shift produce a disagreement that describes the
 * shift and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROW ORDER
 * ─────────────────────────────────────────────────────────────────────────────
 * ESRI ASCII Grid writes the NORTHERNMOST row first. `rasterizeDtm` indexes row
 * 0 at the minimum of the second horizontal axis, which is south. The PDAL grid
 * is flipped on the way in so both sides are in the same frame. The v0.4.3
 * aspect mirror recorded in `src/terrain/ground/terrainDerivatives.ts` came from
 * getting this wrong, and `catches a row-order flip in the DTM comparison`
 * injects exactly that fault to show the comparison would catch it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GATES ARE NOT DEFINED HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * They are defined in the study manifests under
 * `validation/cross-implementation/studies/`, which were committed at `pending`
 * before any of this ran, and this file READS them. `the frozen gates match the
 * registered manifests` asserts the two agree, so a gate loosened in one place
 * and not the other fails rather than quietly disagreeing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { classifyGroundSmrf } from '../src/terrain/ground/groundFilter';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { classificationAgreement } from '../src/validation/classificationAgreement';
import type { ClassLabel } from '../src/validation/classificationAgreement';
import { compareGrids } from '../src/validation/gridAgreement';
import type { GridSpec, Raster } from '../src/validation/gridAgreement';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import {
  FIXTURES,
  PIPELINE_DIR,
  EXTENT_M,
  DTM_CELL_M,
  parseFixtureCsv,
  parseTruth,
} from '../scripts/generate-point-cloud-fixtures.mjs';
import type { PointCloudFixtureSpec, FixturePoint } from '../scripts/generate-point-cloud-fixtures.mjs';
import { PARAMS } from '../scripts/run-pdal-reference.mjs';

const FIXTURE_DIR = resolve(PIPELINE_DIR, 'fixtures');
const PDAL_DIR = resolve(PIPELINE_DIR, 'pdal');
const OLV_DIR = resolve(PIPELINE_DIR, 'olv');
const STUDIES_DIR = resolve(PIPELINE_DIR, '../studies');

const GROUND_STUDY = 'GROUND-FILTER-PDAL-SMRF.study.json';
const DTM_STUDY = 'DTM-PDAL-WRITERS-GDAL.study.json';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** UTF-16 code-unit order. Never `localeCompare`: a digest may not move with a locale. */
const byCodeUnit = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

interface StudyMetrics {
  toleranceAbs: number;
  toleranceUnit: string;
  minimumComparableCells: number;
  requiredWithinToleranceFraction: number;
}

function studyMetrics(file: string): StudyMetrics {
  const m = JSON.parse(readFileSync(resolve(STUDIES_DIR, file), 'utf8')) as { metrics: StudyMetrics };
  return m.metrics;
}

const GROUND_GATE = studyMetrics(GROUND_STUDY);
const DTM_GATE = studyMetrics(DTM_STUDY);

/**
 * How far a reference coordinate may sit from the fixture coordinate it is
 * supposed to be, in metres, before the leg is called invalid.
 *
 * The fixtures are written at three decimals and PDAL echoes them at six, so
 * the difference is exactly zero when the rows correspond. A millionth of a
 * metre is a float-representation allowance, not a matching allowance: the
 * nearest DIFFERENT return in any fixture is millimetres away, so no row shift
 * can slip under this.
 */
const ROW_ALIGNMENT_EPSILON_M = 1e-6;

// ── reading the reference side ──────────────────────────────────────────────

interface PdalLabelled {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly classification: number;
}

/** Parse `writers.text` output written with `order: "X,Y,Z,Classification"`. */
function parsePdalText(text: string): PdalLabelled[] {
  const lines = text.split('\n');
  const header = lines[0]?.replace(/"/g, '');
  if (header !== 'X,Y,Z,Classification') {
    throw new Error(`unexpected PDAL text header: ${JSON.stringify(lines[0])}`);
  }
  const out: PdalLabelled[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const f = lines[i].split(',');
    if (f.length !== 4) throw new Error(`PDAL row ${i} has ${f.length} fields, expected 4`);
    out.push({ x: Number(f[0]), y: Number(f[1]), z: Number(f[2]), classification: Number(f[3]) });
  }
  return out;
}

interface AsciiGrid {
  readonly ncols: number;
  readonly nrows: number;
  readonly xllcorner: number;
  readonly yllcorner: number;
  readonly cellsize: number;
  readonly nodata: number;
  /** Row-major, NORTH first, exactly as the file stores it. */
  readonly values: Float64Array;
}

function parseAsciiGrid(text: string): AsciiGrid {
  const head: Record<string, number> = {};
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].trim().match(/^([A-Za-z_]+)\s+(\S+)$/);
    if (!m) break;
    head[m[1].toLowerCase()] = Number(m[2]);
  }
  const need = ['ncols', 'nrows', 'xllcorner', 'yllcorner', 'cellsize', 'nodata_value'];
  for (const k of need) {
    if (!(k in head)) throw new Error(`ASCII grid header is missing ${k}`);
  }
  const ncols = head.ncols;
  const nrows = head.nrows;
  const values = new Float64Array(ncols * nrows);
  let n = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    for (const tok of line.split(/\s+/)) {
      if (n >= values.length) throw new Error('ASCII grid holds more values than ncols x nrows');
      values[n++] = Number(tok);
    }
  }
  if (n !== values.length) throw new Error(`ASCII grid holds ${n} values, expected ${values.length}`);
  return {
    ncols,
    nrows,
    xllcorner: head.xllcorner,
    yllcorner: head.yllcorner,
    cellsize: head.cellsize,
    nodata: head.nodata_value,
    values,
  };
}

/**
 * Flip a north-first grid into south-first order.
 *
 * Written as its own function rather than folded into the reader so the fault
 * injection in `catches a row-order flip in the DTM comparison` can skip it and
 * feed the comparison the unflipped grid, which is precisely the defect.
 */
function flipRows(values: Float64Array, ncols: number, nrows: number): Float64Array {
  const out = new Float64Array(values.length);
  for (let r = 0; r < nrows; r++) {
    const src = (nrows - 1 - r) * ncols;
    out.set(values.subarray(src, src + ncols), r * ncols);
  }
  return out;
}

/** Write an ESRI ASCII Grid in the same shape the reference side uses. */
function writeAsciiGrid(path: string, g: Omit<AsciiGrid, 'values'>, northFirst: Float64Array): string {
  const lines = [
    `ncols        ${g.ncols}`,
    `nrows        ${g.nrows}`,
    `xllcorner    ${g.xllcorner.toFixed(12)}`,
    `yllcorner    ${g.yllcorner.toFixed(12)}`,
    `cellsize     ${g.cellsize.toFixed(12)}`,
    `NODATA_value ${g.nodata.toFixed(6)}`,
  ];
  for (let r = 0; r < g.nrows; r++) {
    const row: string[] = [];
    for (let c = 0; c < g.ncols; c++) row.push(northFirst[r * g.ncols + c].toFixed(6));
    lines.push(row.join(' ') + ' ');
  }
  const text = lines.join('\n') + '\n';
  writeFileSync(path, text, 'utf8');
  return text;
}

// ── the ground-filter study ─────────────────────────────────────────────────

type LegStatus = 'ok' | 'unavailable' | 'invalid';

interface GroundLeg {
  fixtureId: string;
  datasetId: string;
  status: LegStatus;
  reason?: string;
  reference: 'PDAL';
  evidenceLevel: 'E4';
  returns?: number;
  evaluated?: number;
  agreeingReturns?: number;
  agreementFraction?: number;
  onlyOlvGround?: number;
  onlyPdalGround?: number;
  groundIoU?: number | null;
  mcc?: number;
  unexpectedClassifications?: number;
  /**
   * The returns the two sides labelled differently, split by what the generator
   * called them.
   *
   * Without the split a disagreement count says only that the two differ. With
   * it, a reader can see WHICH side moved away from the scene as built, which is
   * the difference between "two implementations diverge" and "one of them is
   * rejecting bare earth". It is an E3 reading and is reported apart from the E4
   * agreement figure the gate is about.
   */
  disagreementByTruth?: {
    reference: 'by-construction';
    evidenceLevel: 'E3';
    /** Disagreeing returns the generator created as bare earth. */
    truthGround: number;
    /** Disagreeing returns the generator created as an object or a blunder. */
    truthNonGround: number;
  };
  /** The E3 leg: each side's labels against the labels the generator assigned. */
  truthLeg?: {
    reference: 'by-construction';
    evidenceLevel: 'E3';
    olvBalancedAccuracy: number | null;
    pdalBalancedAccuracy: number | null;
  };
}

const olvLabel = (g: number): ClassLabel => (g === 1 ? 'ground' : 'non-ground');

function runGroundLeg(spec: PointCloudFixtureSpec): GroundLeg {
  const base: GroundLeg = {
    fixtureId: spec.id,
    datasetId: spec.datasetId,
    status: 'ok',
    reference: 'PDAL',
    evidenceLevel: 'E4',
  };
  const refPath = resolve(PDAL_DIR, `${spec.id}__smrf.csv`);
  if (!existsSync(refPath)) {
    return {
      ...base,
      status: 'unavailable',
      reason: `no PDAL output at pdal/${spec.id}__smrf.csv; run scripts/run-pdal-reference.mjs`,
    };
  }

  const points = parseFixtureCsv(readFileSync(resolve(FIXTURE_DIR, `${spec.id}.csv`), 'utf8'));
  const truth = parseTruth(readFileSync(resolve(FIXTURE_DIR, `${spec.id}.truth`), 'utf8'));
  const ref = parsePdalText(readFileSync(refPath, 'utf8'));

  if (ref.length !== points.length) {
    return {
      ...base,
      status: 'invalid',
      reason: `PDAL returned ${ref.length} returns for a fixture of ${points.length}`,
    };
  }
  for (let i = 0; i < points.length; i++) {
    if (
      Math.abs(ref[i].x - points[i].x) > ROW_ALIGNMENT_EPSILON_M ||
      Math.abs(ref[i].y - points[i].y) > ROW_ALIGNMENT_EPSILON_M ||
      Math.abs(ref[i].z - points[i].z) > ROW_ALIGNMENT_EPSILON_M
    ) {
      return {
        ...base,
        status: 'invalid',
        reason: `PDAL row ${i} does not hold the fixture's return; the two sides are not aligned and no agreement figure from them would mean anything`,
      };
    }
  }

  const p = PARAMS.smrf;
  const olv = classifyGroundSmrf(points as readonly TerrainPoint[], {
    cellSizeM: p.cell,
    maxWindowCells: p.window,
    slope: p.slope,
    elevationThresholdM: p.threshold,
    scalingFactorM: p.scalar,
    // PDAL's SMRF has no cap on the slope-scaled threshold and ours defaults to
    // 2.5 m. Disabled here so the two run the same model; the default is a
    // deliberate difference from the published filter and is out of this
    // study's scope, which the manifest says.
    maxElevationThresholdM: Infinity,
    floorPercentile: 0,
    verticalAxis: 'z',
  });

  let unexpected = 0;
  const refLabels: ClassLabel[] = [];
  for (const r of ref) {
    if (r.classification === p.groundClass) refLabels.push('ground');
    else if (r.classification === p.otherClass) refLabels.push('non-ground');
    else {
      unexpected++;
      refLabels.push('unclassified');
    }
  }
  const olvLabels: ClassLabel[] = Array.from(olv.isGround, olvLabel);

  const cmp = classificationAgreement(refLabels, olvLabels, { minPairs: 1 });
  if (cmp.status === 'refused') {
    return { ...base, status: 'invalid', reason: `agreement refused: ${cmp.reason} — ${cmp.detail}` };
  }

  const truthLabels: ClassLabel[] = Array.from(truth, olvLabel);
  const olvVsTruth = classificationAgreement(truthLabels, olvLabels);
  const pdalVsTruth = classificationAgreement(truthLabels, refLabels);

  const agreeing = cmp.confusion.truePositive + cmp.confusion.trueNegative;
  let disagreeTruthGround = 0;
  let disagreeTruthNonGround = 0;
  for (let i = 0; i < olvLabels.length; i++) {
    if (olvLabels[i] === refLabels[i]) continue;
    if (truth[i] === 1) disagreeTruthGround++;
    else disagreeTruthNonGround++;
  }

  return {
    ...base,
    returns: points.length,
    evaluated: cmp.evaluated,
    agreeingReturns: agreeing,
    agreementFraction: agreeing / cmp.evaluated,
    // Ground is the positive class and the reference is the truth argument, so
    // a false positive is a return only WE call ground.
    onlyOlvGround: cmp.confusion.falsePositive,
    onlyPdalGround: cmp.confusion.falseNegative,
    groundIoU: cmp.groundIoU,
    mcc: cmp.mcc,
    unexpectedClassifications: unexpected,
    disagreementByTruth: {
      reference: 'by-construction',
      evidenceLevel: 'E3',
      truthGround: disagreeTruthGround,
      truthNonGround: disagreeTruthNonGround,
    },
    truthLeg: {
      reference: 'by-construction',
      evidenceLevel: 'E3',
      olvBalancedAccuracy: olvVsTruth.status === 'compared' ? olvVsTruth.balancedAccuracy : null,
      pdalBalancedAccuracy: pdalVsTruth.status === 'compared' ? pdalVsTruth.balancedAccuracy : null,
    },
  };
}

// ── the DTM study ───────────────────────────────────────────────────────────

interface DtmLeg {
  fixtureId: string;
  datasetId: string;
  status: LegStatus;
  reason?: string;
  reference: 'PDAL';
  evidenceLevel: 'E4';
  cells?: number;
  comparableCells?: number;
  bothNodata?: number;
  onlyPdal?: number;
  onlyOlv?: number;
  withinToleranceFraction?: number | null;
  maxAbsErrorM?: number | null;
  rmseM?: number | null;
  meanSignedErrorM?: number | null;
}

const DTM_CELLS = Math.round(EXTENT_M / DTM_CELL_M);

const DTM_SPEC: GridSpec = {
  originX: PARAMS.dtm.originX,
  originY: PARAMS.dtm.originY,
  cellSize: PARAMS.dtm.resolution,
  width: DTM_CELLS,
  height: DTM_CELLS,
};

/** Our DTM for one bare-earth fixture, in south-first row order. */
function olvDtm(points: readonly FixturePoint[]): Float64Array {
  const all = new Uint8Array(points.length).fill(1);
  const dem = rasterizeDtm(points as readonly TerrainPoint[], all, {
    aggregation: 'min',
    grid: {
      originH1: PARAMS.dtm.originX,
      originH2: PARAMS.dtm.originY,
      cols: DTM_CELLS,
      rows: DTM_CELLS,
      cellSizeM: PARAMS.dtm.resolution,
    },
    verticalAxis: 'z',
  });
  return Float64Array.from(dem.z);
}

function runDtmLeg(spec: PointCloudFixtureSpec): { leg: DtmLeg; olvSouthFirst?: Float64Array; grid?: AsciiGrid } {
  const base: DtmLeg = {
    fixtureId: spec.id,
    datasetId: spec.datasetId,
    status: 'ok',
    reference: 'PDAL',
    evidenceLevel: 'E4',
  };
  const refPath = resolve(PDAL_DIR, `${spec.id}__dtm-min.asc`);
  if (!existsSync(refPath)) {
    return {
      leg: {
        ...base,
        status: 'unavailable',
        reason: `no PDAL raster at pdal/${spec.id}__dtm-min.asc; run scripts/run-pdal-reference.mjs`,
      },
    };
  }
  const grid = parseAsciiGrid(readFileSync(refPath, 'utf8'));
  if (grid.ncols !== DTM_CELLS || grid.nrows !== DTM_CELLS || grid.cellsize !== PARAMS.dtm.resolution) {
    return {
      leg: {
        ...base,
        status: 'invalid',
        reason: `PDAL raster is ${grid.ncols}x${grid.nrows} at ${grid.cellsize} m, expected ${DTM_CELLS}x${DTM_CELLS} at ${PARAMS.dtm.resolution} m`,
      },
    };
  }

  const points = parseFixtureCsv(readFileSync(resolve(FIXTURE_DIR, `${spec.id}.csv`), 'utf8'));
  const ours = olvDtm(points);
  const theirs = flipRows(grid.values, grid.ncols, grid.nrows);

  const a: Raster = { spec: DTM_SPEC, values: theirs, nodata: PARAMS.dtm.nodata };
  const b: Raster = { spec: DTM_SPEC, values: ours, nodata: null };
  const cmp = compareGrids(a, b, { tolerance: DTM_GATE.toleranceAbs, minCells: 1 });
  if (cmp.status === 'refused') {
    return { leg: { ...base, status: 'invalid', reason: `grid comparison refused: ${cmp.reason} — ${cmp.detail}` } };
  }

  return {
    leg: {
      ...base,
      cells: cmp.cells,
      comparableCells: cmp.mask.bothValid,
      bothNodata: cmp.mask.bothNodata,
      onlyPdal: cmp.mask.onlyA,
      onlyOlv: cmp.mask.onlyB,
      withinToleranceFraction: cmp.value.withinToleranceFraction,
      maxAbsErrorM: cmp.value.maxAbsError,
      rmseM: cmp.value.rmse,
      meanSignedErrorM: cmp.value.meanSignedError,
    },
    olvSouthFirst: ours,
    grid,
  };
}

// ── run everything once, then assert over the result ────────────────────────

const CLASSIFICATION_FIXTURES = FIXTURES.filter((f) => f.role === 'classification');
const BARE_FIXTURES = FIXTURES.filter((f) => f.role === 'bare-earth');

mkdirSync(OLV_DIR, { recursive: true });

const groundLegs: GroundLeg[] = [];
const olvSums: string[] = [];
for (const spec of CLASSIFICATION_FIXTURES) {
  const leg = runGroundLeg(spec);
  groundLegs.push(leg);
  if (leg.status === 'ok') {
    const points = parseFixtureCsv(readFileSync(resolve(FIXTURE_DIR, `${spec.id}.csv`), 'utf8'));
    const p = PARAMS.smrf;
    const olv = classifyGroundSmrf(points as readonly TerrainPoint[], {
      cellSizeM: p.cell,
      maxWindowCells: p.window,
      slope: p.slope,
      elevationThresholdM: p.threshold,
      scalingFactorM: p.scalar,
      maxElevationThresholdM: Infinity,
      floorPercentile: 0,
      verticalAxis: 'z',
    });
    // One character per return, in fixture order. A label file rather than a
    // copy of the cloud: the coordinates are already committed, and what a
    // reviewer needs to diff is which returns each side called ground.
    const text = Array.from(olv.isGround).join('') + '\n';
    const out = `${spec.id}__smrf.labels`;
    writeFileSync(resolve(OLV_DIR, out), text, 'utf8');
    olvSums.push(`${sha256(text)}  olv/${out}`);
  }
}

const dtmLegs: DtmLeg[] = [];
for (const spec of BARE_FIXTURES) {
  const { leg, olvSouthFirst, grid } = runDtmLeg(spec);
  dtmLegs.push(leg);
  if (leg.status === 'ok' && olvSouthFirst && grid) {
    const northFirst = flipRows(olvSouthFirst, grid.ncols, grid.nrows);
    // NaN is our empty cell; written as the reference sentinel so the two grids
    // are directly diffable as text.
    for (let i = 0; i < northFirst.length; i++) {
      if (!Number.isFinite(northFirst[i])) northFirst[i] = PARAMS.dtm.nodata;
    }
    const out = `${spec.id}__dtm-min.asc`;
    const text = writeAsciiGrid(resolve(OLV_DIR, out), grid, northFirst);
    olvSums.push(`${sha256(text)}  olv/${out}`);
  }
}

const okGround = groundLegs.filter((l) => l.status === 'ok');
const okDtm = dtmLegs.filter((l) => l.status === 'ok');

const groundEvaluated = okGround.reduce((a, l) => a + (l.evaluated ?? 0), 0);
const groundAgreeing = okGround.reduce((a, l) => a + (l.agreeingReturns ?? 0), 0);
const groundPooledFraction = groundEvaluated === 0 ? null : groundAgreeing / groundEvaluated;

const dtmComparable = okDtm.reduce((a, l) => a + (l.comparableCells ?? 0), 0);
const dtmWithin = okDtm.reduce(
  (a, l) => a + (l.withinToleranceFraction ?? 0) * (l.comparableCells ?? 0),
  0,
);
const dtmPooledFraction = dtmComparable === 0 ? null : dtmWithin / dtmComparable;
const dtmMaxAbs = okDtm.reduce((a, l) => Math.max(a, l.maxAbsErrorM ?? 0), 0);

olvSums.sort(byCodeUnit);
writeFileSync(resolve(PIPELINE_DIR, 'olv-SHA256SUMS'), olvSums.join('\n') + '\n', 'utf8');

/**
 * One results file per study, not one for both.
 *
 * A study manifest names the raw artifacts a derived summary came from and
 * carries a digest over them, so a combined file would have to claim it was
 * derived from one study's inputs while also holding the other study's legs.
 * Splitting them keeps each derivation true.
 */
const SHARED_BOUNDARIES = [
  'Agreement with PDAL is not accuracy against ground truth. Both implementations can be wrong about the same ground in the same way, and on a synthetic scene they were both handed a surface nobody surveyed.',
  'Eight synthetic scenes are not survey data: uniform-random returns in plan, no sensor geometry, no scan pattern, no range noise, no multiple returns, and objects that are boxes and clumps of points.',
];

const writeResults = (name: string, body: Record<string, unknown>): void => {
  writeFileSync(resolve(PIPELINE_DIR, name), JSON.stringify(body, null, 2) + '\n', 'utf8');
};

writeResults('results-ground-filter.json', {
  generatedBy: 'tests/groundFilterPdalAgreement.test.ts',
  manifest: `validation/cross-implementation/studies/${GROUND_STUDY}`,
  evidenceNote:
    'The agreement figure is cross-implementation (E4). disagreementByTruth and truthLeg compare ' +
    'each side against labels this project assigned when generating the scene, which is E3 and is ' +
    'not ground truth.',
  promotes: 'nothing',
  gate: GROUND_GATE,
  pooled: {
    evaluatedReturns: groundEvaluated,
    agreeingReturns: groundAgreeing,
    agreementFraction: groundPooledFraction,
  },
  legs: groundLegs,
  boundaries: [
    ...SHARED_BOUNDARIES,
    'One parameter set. Nothing here says anything about a different cell size, a different window ladder, a non-zero slope-scaled term, or the 2.5 m threshold cap our filter applies by default and that this study switches off to match the reference.',
    'floorPercentile is 0, matching the reference\'s per-cell minimum. The pipeline orchestrator enables a small despike floor by default, so the low-blunder scene here exercises the leaf as the reference runs it and not as the product ships it.',
  ],
});

writeResults('results-dtm.json', {
  generatedBy: 'tests/groundFilterPdalAgreement.test.ts',
  manifest: `validation/cross-implementation/studies/${DTM_STUDY}`,
  evidenceNote: 'Cross-implementation (E4). Every cell value on the reference side came from PDAL.',
  promotes: 'nothing',
  gate: DTM_GATE,
  pooled: {
    comparableCells: dtmComparable,
    withinToleranceFraction: dtmPooledFraction,
    maxAbsErrorM: dtmMaxAbs,
  },
  legs: dtmLegs,
  boundaries: [
    ...SHARED_BOUNDARIES,
    'The input is one return per cell at the cell centre, because PDAL writes rasters with a radius estimator and rasterizeDtm is a cell estimator. This study therefore tests grid origin, cell indexing and row order, and not aggregation over a realistic cloud.',
    'Every cell receives exactly one return, so nothing here says anything about how either side marks or fills a cell with no data.',
    'One aggregation and one cell size. Nothing here says anything about mean, median, percentile or robust aggregation, or about any cell size other than 1 m.',
  ],
});

describe('PDAL cross-implementation studies', () => {
  it('the frozen gates match the registered manifests', () => {
    // The manifests were committed at `pending` before any of this ran, and
    // their protocolDigest covers `metrics`. Reading them here rather than
    // re-declaring the numbers means there is one gate, not two that agree
    // until someone edits one.
    expect(GROUND_GATE.requiredWithinToleranceFraction).toBe(0.99);
    expect(GROUND_GATE.minimumComparableCells).toBe(50000);
    expect(GROUND_GATE.toleranceAbs).toBe(0);
    expect(DTM_GATE.requiredWithinToleranceFraction).toBe(1);
    expect(DTM_GATE.minimumComparableCells).toBe(7500);
    expect(DTM_GATE.toleranceAbs).toBe(0.00005);
  });

  it('every leg reached a definite status, and none was inferred', () => {
    for (const leg of [...groundLegs, ...dtmLegs]) {
      expect(['ok', 'unavailable', 'invalid']).toContain(leg.status);
      if (leg.status !== 'ok') {
        // The point of the rule: a leg that did not run carries a reason and
        // NO numbers, rather than a zero that would read as a measurement.
        expect(leg.reason).toBeTruthy();
      }
    }
  });

  it('the reference outputs exist, so these legs are cross-implementation', () => {
    // Without this the whole file could pass on a machine with no PDAL, having
    // measured nothing. A leg with no reference is `unavailable`, and this
    // asserts we are not in that state.
    expect(groundLegs.every((l) => l.status === 'ok')).toBe(true);
    expect(dtmLegs.every((l) => l.status === 'ok')).toBe(true);
  });

  it('PDAL emitted only the two classification values it was told to emit', () => {
    for (const leg of okGround) expect(leg.unexpectedClassifications).toBe(0);
  });

  it('the ground study compared enough returns to conclude anything', () => {
    expect(groundEvaluated).toBeGreaterThanOrEqual(GROUND_GATE.minimumComparableCells);
  });

  it('the DTM study compared enough cells to conclude anything', () => {
    expect(dtmComparable).toBeGreaterThanOrEqual(DTM_GATE.minimumComparableCells);
  });

  it('reports the ground-filter agreement against the preregistered gate', () => {
    // Deliberately not an assertion that the gate is met. The manifest carries
    // the verdict; this file reports the number and fails only if the number is
    // missing, because a study that disagrees is a finding and not a broken
    // test.
    expect(groundPooledFraction).not.toBeNull();
    for (const leg of okGround) {
      expect(leg.agreementFraction).toBeGreaterThan(0);
      process.stdout.write(
        `ground ${leg.fixtureId}: ${(leg.agreementFraction! * 100).toFixed(3)} % agreement, ` +
          `${leg.onlyOlvGround} only-ours, ${leg.onlyPdalGround} only-PDAL\n`,
      );
    }
    process.stdout.write(
      `ground pooled: ${((groundPooledFraction ?? 0) * 100).toFixed(3)} % over ${groundEvaluated} returns ` +
        `(gate ${(GROUND_GATE.requiredWithinToleranceFraction * 100).toFixed(1)} %)\n`,
    );
  });

  it('reports the DTM agreement against the preregistered gate', () => {
    expect(dtmPooledFraction).not.toBeNull();
    for (const leg of okDtm) {
      process.stdout.write(
        `dtm ${leg.fixtureId}: ${((leg.withinToleranceFraction ?? 0) * 100).toFixed(4)} % within ` +
          `${DTM_GATE.toleranceAbs} m, max |Δ| ${(leg.maxAbsErrorM ?? 0).toExponential(3)} m\n`,
      );
    }
    process.stdout.write(
      `dtm pooled: ${((dtmPooledFraction ?? 0) * 100).toFixed(4)} % over ${dtmComparable} cells, ` +
        `max |Δ| ${dtmMaxAbs.toExponential(3)} m (gate ${DTM_GATE.toleranceAbs} m)\n`,
    );
  });

  // ── negative controls ─────────────────────────────────────────────────────
  // A check that has never failed has not been tested. Each of these injects
  // the fault the corresponding comparison exists to catch and asserts the
  // comparison catches it.

  it('catches a perturbed ground reference', () => {
    const spec = CLASSIFICATION_FIXTURES[0];
    const ref = parsePdalText(readFileSync(resolve(PDAL_DIR, `${spec.id}__smrf.csv`), 'utf8'));
    const p = PARAMS.smrf;
    const refLabels: ClassLabel[] = ref.map((r) => (r.classification === p.groundClass ? 'ground' : 'non-ground'));
    // Flip every twentieth label: a five per cent corruption, which is five
    // times the slack the registered gate allows.
    const corrupted = refLabels.map((l, i) =>
      i % 20 === 0 ? (l === 'ground' ? 'non-ground' : 'ground') : l,
    ) as ClassLabel[];

    const clean = classificationAgreement(refLabels, refLabels);
    const dirty = classificationAgreement(refLabels, corrupted);
    expect(clean.status).toBe('compared');
    expect(dirty.status).toBe('compared');
    if (clean.status !== 'compared' || dirty.status !== 'compared') return;

    const fractionOf = (c: typeof clean): number =>
      (c.confusion.truePositive + c.confusion.trueNegative) / c.evaluated;
    expect(fractionOf(clean)).toBe(1);
    expect(fractionOf(dirty)).toBeLessThan(GROUND_GATE.requiredWithinToleranceFraction);
  });

  it('catches a row-order flip in the DTM comparison', () => {
    const spec = BARE_FIXTURES.find((f) => f.surface === 'rolling') ?? BARE_FIXTURES[0];
    const grid = parseAsciiGrid(readFileSync(resolve(PDAL_DIR, `${spec.id}__dtm-min.asc`), 'utf8'));
    const points = parseFixtureCsv(readFileSync(resolve(FIXTURE_DIR, `${spec.id}.csv`), 'utf8'));
    const ours = olvDtm(points);
    const correct = flipRows(grid.values, grid.ncols, grid.nrows);

    const b: Raster = { spec: DTM_SPEC, values: ours, nodata: null };
    const good = compareGrids({ spec: DTM_SPEC, values: correct, nodata: PARAMS.dtm.nodata }, b, {
      tolerance: DTM_GATE.toleranceAbs,
    });
    // The defect: forget the flip and hand the comparison the file's own
    // north-first order. A DTM lit from the wrong end still looks like terrain.
    const flipped = compareGrids({ spec: DTM_SPEC, values: grid.values, nodata: PARAMS.dtm.nodata }, b, {
      tolerance: DTM_GATE.toleranceAbs,
    });
    expect(good.status).toBe('compared');
    expect(flipped.status).toBe('compared');
    if (good.status !== 'compared' || flipped.status !== 'compared') return;
    expect(good.value.withinToleranceFraction).toBe(1);
    expect(flipped.value.withinToleranceFraction).toBeLessThan(1);
  });

  it('catches a half-cell shift in the DTM comparison', () => {
    const spec = BARE_FIXTURES.find((f) => f.surface === 'ridge') ?? BARE_FIXTURES[0];
    const grid = parseAsciiGrid(readFileSync(resolve(PDAL_DIR, `${spec.id}__dtm-min.asc`), 'utf8'));
    const points = parseFixtureCsv(readFileSync(resolve(FIXTURE_DIR, `${spec.id}.csv`), 'utf8'));
    const correct = flipRows(grid.values, grid.ncols, grid.nrows);
    // Our side rasterised onto a grid offset by half a cell. The origins then
    // disagree, and `compareGrids` REFUSES rather than resampling one side to
    // fit the other: a number produced that way would describe the resampler.
    const all = new Uint8Array(points.length).fill(1);
    const shifted = rasterizeDtm(points as readonly TerrainPoint[], all, {
      aggregation: 'min',
      grid: {
        originH1: PARAMS.dtm.originX + PARAMS.dtm.resolution / 2,
        originH2: PARAMS.dtm.originY,
        cols: DTM_CELLS,
        rows: DTM_CELLS,
        cellSizeM: PARAMS.dtm.resolution,
      },
      verticalAxis: 'z',
    });
    const out = compareGrids(
      { spec: DTM_SPEC, values: correct, nodata: PARAMS.dtm.nodata },
      {
        spec: { ...DTM_SPEC, originX: DTM_SPEC.originX + PARAMS.dtm.resolution / 2 },
        values: Float64Array.from(shifted.z),
        nodata: null,
      },
      { tolerance: DTM_GATE.toleranceAbs },
    );
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.reason).toBe('grid-origin-differs');
  });
});
