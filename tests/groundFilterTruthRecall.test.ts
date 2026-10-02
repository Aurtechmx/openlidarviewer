/**
 * groundFilterTruthRecall.test.ts: ground recall and precision against the
 * labels each synthetic scene was built with, for three label sources on the
 * same five ground-filter scenes.
 *
 * - `pdal`: PDAL filters.smrf output committed under pdal-pipeline/pdal.
 * - `study`: classifyGroundSmrf with the PDAL study settings (window 16,
 *   slope 0.15, threshold 0.5 m, no cap, floorPercentile 0).
 * - `shipped`: classifyGroundSmrf with the settings the app runs
 *   (resolveGroundFilterParams in src/terrain/contour/analyseContours.ts:
 *   window 8, slope 0.2, threshold 0.5 m, cap 2.5 m, floorPercentile 5),
 *   at a 1 m cell. The app takes the cell size from each cloud's grid, and
 *   does not run the filter when a cloud already has usable class-2 ground.
 *
 * Ground is the positive class and the .truth file is the truth argument. The
 * truth labels come from this project's own generator, so this is E3.
 * Output: validation/cross-implementation/pdal-pipeline/results-ground-filter-truth.json,
 * pinned as a derived artifact in the GROUND-FILTER-PDAL-SMRF study manifest.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyGroundSmrf } from '../src/terrain/ground/groundFilter';
import type { GroundFilterParams } from '../src/terrain/ground/groundFilter';
import { classificationAgreement } from '../src/validation/classificationAgreement';
import type { ClassLabel } from '../src/validation/classificationAgreement';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { FIXTURES, PIPELINE_DIR, parseFixtureCsv, parseTruth } from '../scripts/generate-point-cloud-fixtures.mjs';
import { PARAMS } from '../scripts/run-pdal-reference.mjs';

const FIXTURE_DIR = resolve(PIPELINE_DIR, 'fixtures');
const PDAL_DIR = resolve(PIPELINE_DIR, 'pdal');
const OUT = 'results-ground-filter-truth.json';

const CONFIGS: Record<'study' | 'shipped', Partial<GroundFilterParams>> = {
  study: {
    cellSizeM: PARAMS.smrf.cell,
    maxWindowCells: PARAMS.smrf.window,
    slope: PARAMS.smrf.slope,
    elevationThresholdM: PARAMS.smrf.threshold,
    scalingFactorM: PARAMS.smrf.scalar,
    maxElevationThresholdM: Infinity,
    floorPercentile: 0,
    verticalAxis: 'z',
  },
  shipped: {
    cellSizeM: 1,
    maxWindowCells: 8,
    slope: 0.2,
    elevationThresholdM: 0.5,
    maxElevationThresholdM: 2.5,
    floorPercentile: 5,
    verticalAxis: 'z',
  },
};

const label = (g: number): ClassLabel => (g === 1 ? 'ground' : 'non-ground');
const round = (v: number | null): number | null => (v === null ? null : Math.round(v * 1e6) / 1e6);

function pdalGround(id: string): Uint8Array {
  const lines = readFileSync(resolve(PDAL_DIR, `${id}__smrf.csv`), 'utf8').split('\n').slice(1).filter((l) => l !== '');
  return Uint8Array.from(lines, (l) => (Number(l.split(',')[3]) === PARAMS.smrf.groundClass ? 1 : 0));
}

interface Score {
  truthGround: number;
  predictedGround: number;
  truePositive: number;
  groundRecall: number | null;
  groundPrecision: number | null;
}

function score(truth: Uint8Array, predicted: ArrayLike<number>): Score {
  const cmp = classificationAgreement(Array.from(truth, label), Array.from(predicted, label), { minPairs: 1 });
  if (cmp.status !== 'compared') throw new Error(`comparison refused: ${cmp.reason}`);
  const c = cmp.confusion;
  return {
    truthGround: c.truePositive + c.falseNegative,
    predictedGround: c.truePositive + c.falsePositive,
    truePositive: c.truePositive,
    groundRecall: round(cmp.groundRecall),
    groundPrecision: round(cmp.groundPrecision),
  };
}

const scenes = FIXTURES.filter((f) => f.role === 'classification').map((spec) => {
  const points = parseFixtureCsv(readFileSync(resolve(FIXTURE_DIR, `${spec.id}.csv`), 'utf8'));
  const truth = parseTruth(readFileSync(resolve(FIXTURE_DIR, `${spec.id}.truth`), 'utf8'));
  const pdal = pdalGround(spec.id);
  if (pdal.length !== points.length || truth.length !== points.length) {
    throw new Error(`${spec.id}: label counts do not match the fixture`);
  }
  const run = (cfg: Partial<GroundFilterParams>) =>
    classifyGroundSmrf(points as readonly TerrainPoint[], cfg as GroundFilterParams).isGround;
  return {
    fixtureId: spec.id,
    surface: spec.surface,
    returns: points.length,
    pdal: score(truth, pdal),
    study: score(truth, run(CONFIGS.study)),
    shipped: score(truth, run(CONFIGS.shipped)),
  };
});

const NOT_SURVEY_DATA =
  'synthetic scenes are not survey data: uniform-random returns in plan, no sensor geometry, no scan pattern, no range noise, no multiple returns, and objects that are boxes and clumps of points.';
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const sceneCaveat = (n: number): string => `${COUNT_WORDS[n] ?? n} ${NOT_SURVEY_DATA}`;

writeFileSync(
  resolve(PIPELINE_DIR, OUT),
  JSON.stringify(
    {
      generatedBy: 'tests/groundFilterTruthRecall.test.ts',
      manifest: 'validation/cross-implementation/studies/GROUND-FILTER-PDAL-SMRF.study.json',
      promotes: 'nothing',
      positiveClass: 'ground',
      truth: 'fixtures/<scene>.truth, written by scripts/generate-point-cloud-fixtures.mjs',
      evidenceNote:
        'E3. Each label source is scored against the ground membership the scene generator assigned. ' +
        'Recall is the share of truth-ground a source calls ground; precision is the share of its ground calls that are truth-ground. ' +
        'A metric with no denominator is null.',
      configurations: {
        pdal: 'PDAL filters.smrf output under pdal/, cell 1, window 16, slope 0.15, threshold 0.5, scalar 0, cut 0',
        study: { function: 'classifyGroundSmrf', ...CONFIGS.study, maxElevationThresholdM: 'Infinity' },
        shipped: { function: 'classifyGroundSmrf', source: 'resolveGroundFilterParams defaults',
          ...CONFIGS.shipped,
          note: "Evaluated at a 1 m cell. The app takes the cell size from each cloud's grid, and does not run the filter when a cloud already has usable class-2 ground.",
        },
      },
      legs: scenes,
      boundaries: [
        sceneCaveat(scenes.length),
        'The truth labels come from a generator this project wrote. The figures describe these scenes and settings only.',
      ],
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

describe('ground filter against generator truth labels', () => {
  it('scores every scene for all three label sources', () => {
    expect(scenes.length).toBeGreaterThan(0);
    const pct = (v: number | null): string => (v === null ? 'n/a' : (v * 100).toFixed(1));
    for (const s of scenes) {
      for (const k of ['pdal', 'study', 'shipped'] as const) {
        expect(s[k].truthGround).toBeGreaterThan(0);
        process.stdout.write(
          `truth ${s.fixtureId} ${k}: recall ${pct(s[k].groundRecall)} precision ${pct(s[k].groundPrecision)}\n`,
        );
      }
    }
  });

  it('the written file names as many scenes as it lists', () => {
    const written = JSON.parse(readFileSync(resolve(PIPELINE_DIR, OUT), 'utf8')) as {
      legs: unknown[];
      boundaries: string[];
    };
    expect(written.boundaries.filter((b) => b.includes(NOT_SURVEY_DATA))).toEqual([sceneCaveat(written.legs.length)]);
  });
});
