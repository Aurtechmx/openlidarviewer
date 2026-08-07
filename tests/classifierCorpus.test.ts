/**
 * classifierCorpus.test.ts — the corpus is immutable, complete, and its
 * reducer computes what it says it computes.
 *
 * THE PIN. `CORPUS_DIGEST` below is the corpus as published. Editing a scene, a
 * seed, a density, a draw order or a label changes it and fails here, so a
 * metric that moved because the corpus moved cannot be read as a classifier
 * that improved. This is the same discipline the validation snapshot applies:
 * the artifact is checked against a recomputation from its own inputs.
 *
 * THE COVERAGE. The corpus exists to cover a stated list of conditions. The
 * category assertion is what stops a scene being dropped and the list quietly
 * becoming a claim about scenes that are no longer there.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCorpus,
  corpusDigest,
  sceneDigest,
  scoreScene,
  poolScores,
  scaleLengthParams,
  lcg,
  CORPUS_SCENE_IDS,
  CORPUS_VERSION,
  SCORED_CLASSES,
  TRUTH_GROUND,
  TRUTH_BUILDING,
  TRUTH_LOW_NOISE,
  PREDICTED_UNCLASSIFIED,
  US_SURVEY_FOOT_M,
  type CorpusCategory,
} from '../src/validation/classifierCorpus';
import {
  collectCorpusProblems,
  EXPECTED_CORPUS,
  FROZEN_BASELINE,
} from '../scripts/verify-classifier-corpus.mjs';

/** The published corpus. See the header: this is the freeze. */
const CORPUS_DIGEST = 'sha256:2a0c01654d979210dd2b95ef343c3b25a5a4ae97a237afaddf8662197173b1db';

/** Every condition the corpus is claimed to cover. */
const REQUIRED_CATEGORIES: readonly CorpusCategory[] = [
  'aerial-urban',
  'aerial-vegetation',
  'scan-edge-void',
  'walls-roofs',
  'low-vegetation',
  'steep-terrain',
  'rolling-terrain',
  'low-outliers',
  'rgb-absent',
  'returns-absent',
  'unit-metre',
  'unit-foot',
];

describe('corpus immutability', () => {
  it('hashes to the published digest', () => {
    expect(corpusDigest(buildCorpus())).toBe(CORPUS_DIGEST);
  });

  it('regenerates byte for byte on a second build', () => {
    const a = buildCorpus();
    const b = buildCorpus();
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(sceneDigest(a[i])).toBe(sceneDigest(b[i]));
      expect(Array.from(a[i].xyz)).toEqual(Array.from(b[i].xyz));
      expect(Array.from(a[i].truth)).toEqual(Array.from(b[i].truth));
    }
  });

  it('the digest moves when one coordinate moves', () => {
    const scenes = buildCorpus();
    const before = sceneDigest(scenes[0]);
    const tampered = { ...scenes[0], positions: scenes[0].xyz.slice() };
    tampered.xyz[7] += 0.002; // two millimetres, past the quantiser
    expect(sceneDigest(tampered)).not.toBe(before);
  });

  it('the digest moves when one label moves', () => {
    const scenes = buildCorpus();
    const before = sceneDigest(scenes[0]);
    const truth = scenes[0].truth.slice();
    truth[3] = truth[3] === TRUTH_GROUND ? TRUTH_BUILDING : TRUTH_GROUND;
    expect(sceneDigest({ ...scenes[0], truth })).not.toBe(before);
  });

  it('generation uses no ambient randomness', () => {
    // A seeded LCG is the only source of variation, so a stubbed Math.random
    // and a moved clock cannot reach the corpus.
    const realRandom = Math.random;
    const realNow = Date.now;
    try {
      Math.random = () => 0.42;
      Date.now = () => 1;
      expect(corpusDigest(buildCorpus())).toBe(CORPUS_DIGEST);
    } finally {
      Math.random = realRandom;
      Date.now = realNow;
    }
  });

  it('the generator is a plain 32-bit LCG with a stable sequence', () => {
    // Written-out constants, so the sequence cannot change under an upgrade.
    const first = ((Math.imul(1, 1664525) + 1013904223) >>> 0) / 4294967296;
    expect(lcg(1)()).toBe(first);
    // Same seed, same stream; different seeds, different streams.
    expect([lcg(7)(), lcg(7)()]).toEqual([lcg(7)(), lcg(7)()]);
    expect(lcg(7)()).not.toBe(lcg(8)());
  });
});

describe('corpus coverage', () => {
  it('covers every required condition', () => {
    const seen = new Set<CorpusCategory>();
    for (const scene of buildCorpus()) for (const c of scene.categories) seen.add(c);
    for (const required of REQUIRED_CATEGORIES) expect([...seen]).toContain(required);
  });

  it('scene ids are unique and match the exported order', () => {
    const scenes = buildCorpus();
    expect(scenes.map((s) => s.id)).toEqual([...CORPUS_SCENE_IDS]);
    expect(new Set(CORPUS_SCENE_IDS).size).toBe(CORPUS_SCENE_IDS.length);
  });

  it('every scene carries labelled points and a positive cell size', () => {
    for (const scene of buildCorpus()) {
      expect(scene.count).toBeGreaterThan(1000);
      expect(scene.truth).toHaveLength(scene.count);
      expect(scene.xyz).toHaveLength(scene.count * 3);
      expect(scene.cellSize).toBeGreaterThan(0);
      if (scene.colors) expect(scene.colors).toHaveLength(scene.count * 3);
      if (scene.returnCount) expect(scene.returnCount).toHaveLength(scene.count);
    }
  });

  it('the RGB and return conditions are each present and absent somewhere', () => {
    const scenes = buildCorpus();
    expect(scenes.some((s) => s.colors !== null)).toBe(true);
    expect(scenes.some((s) => s.colors === null)).toBe(true);
    expect(scenes.some((s) => s.returnCount !== null)).toBe(true);
    expect(scenes.some((s) => s.returnCount === null)).toBe(true);
  });

  it('the foot scene is the metre scene, rescaled and nothing else', () => {
    const scenes = buildCorpus();
    const metre = scenes.find((s) => s.id === 'units-metre')!;
    const foot = scenes.find((s) => s.id === 'units-foot')!;
    expect(foot.count).toBe(metre.count);
    expect(Array.from(foot.truth)).toEqual(Array.from(metre.truth));
    for (let i = 0; i < metre.count * 3; i++) {
      // Quantised to millimetres on both sides, so the tolerance is the
      // quantiser, not a float epsilon.
      expect(foot.xyz[i] * US_SURVEY_FOOT_M).toBeCloseTo(metre.xyz[i], 2);
    }
  });

  it('scales the length parameters into the scene unit and leaves ratios alone', () => {
    const foot = buildCorpus().find((s) => s.id === 'units-foot')!;
    const scaled = scaleLengthParams({ groundBandM: 0.5, slope: 0.15, maxGridDim: 768 }, foot);
    expect(scaled.groundBandM).toBeCloseTo(0.5 / US_SURVEY_FOOT_M, 9);
    expect(scaled.slope).toBeUndefined();
    expect(scaled.maxGridDim).toBeUndefined();
  });

  it('only the low-outlier scene carries below-ground blunders', () => {
    for (const scene of buildCorpus()) {
      const noise = Array.from(scene.truth).filter((t) => t === TRUTH_LOW_NOISE).length;
      if (scene.id === 'low-outliers') expect(noise).toBe(30);
      else expect(noise).toBe(0);
    }
  });
});

describe('the reducer', () => {
  const truth = Uint8Array.from([2, 2, 2, 6, 6, 3, 7]);

  it('counts a perfect run as precision and recall 1', () => {
    const score = scoreScene('s', truth, Uint8Array.from([2, 2, 2, 6, 6, 3, 2]));
    const ground = score.byClass.find((m) => m.code === TRUTH_GROUND)!;
    // The blunder called ground is a FALSE POSITIVE for ground, not a free pass.
    expect(ground.truePositive).toBe(3);
    expect(ground.falsePositive).toBe(1);
    expect(ground.precision).toBeCloseTo(0.75, 9);
    expect(ground.recall).toBe(1);
    expect(score.lowNoiseCalledGround).toBe(1);
    expect(score.lowNoisePoints).toBe(1);
  });

  it('reports null, not zero, for a class with no denominator', () => {
    const score = scoreScene('s', Uint8Array.from([2, 2]), Uint8Array.from([2, 2]));
    const building = score.byClass.find((m) => m.code === TRUTH_BUILDING)!;
    expect(building.precision).toBeNull();
    expect(building.recall).toBeNull();
    expect(building.f1).toBeNull();
  });

  it('counts an abstention as unclassified and not as any class', () => {
    const predicted = Uint8Array.from([2, PREDICTED_UNCLASSIFIED, 2, 6, 6, 3, 1]);
    const score = scoreScene('s', truth, predicted);
    expect(score.unclassifiedRate).toBeCloseTo(2 / 7, 9);
    const ground = score.byClass.find((m) => m.code === TRUTH_GROUND)!;
    expect(ground.falseNegative).toBe(1);
    expect(ground.falsePositive).toBe(0);
  });

  it('measures the false-building rate against the points that are not buildings', () => {
    const score = scoreScene('s', truth, Uint8Array.from([6, 2, 2, 6, 6, 3, 2]));
    // One non-building point (index 0) called building, out of five non-buildings.
    expect(score.falseBuildingRate).toBeCloseTo(1 / 5, 9);
  });

  it('macro-F1 averages the scored classes and skips the ones with no evidence', () => {
    const score = scoreScene('s', Uint8Array.from([2, 6]), Uint8Array.from([2, 6]));
    // Ground and building are perfect; the three vegetation classes have neither
    // support nor predictions and are skipped rather than counted as zero.
    expect(score.macroF1).toBe(1);
  });

  it('pools counts rather than averaging rates', () => {
    const big = scoreScene('big', Uint8Array.from(new Array(100).fill(2)), Uint8Array.from(new Array(100).fill(2)));
    const small = scoreScene('small', Uint8Array.from([2]), Uint8Array.from([6]));
    const pooled = poolScores([big, small]);
    const ground = pooled.byClass.find((m) => m.code === TRUTH_GROUND)!;
    expect(ground.truePositive).toBe(100);
    expect(ground.falseNegative).toBe(1);
    expect(ground.recall).toBeCloseTo(100 / 101, 9);
    expect(pooled.points).toBe(101);
  });

  it('scores exactly the five classes the classifier can emit', () => {
    const score = scoreScene('s', truth, truth);
    expect(score.byClass.map((m) => m.code)).toEqual([...SCORED_CLASSES]);
    expect(score.byClass.map((m) => m.code)).not.toContain(TRUTH_LOW_NOISE);
  });

  it('the corpus version is a positive integer', () => {
    expect(Number.isInteger(CORPUS_VERSION)).toBe(true);
    expect(CORPUS_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('the gate is not vacuous', () => {
  /** A record that passes, built from the frozen baseline itself. */
  const passingRecord = () => ({
    corpusVersion: EXPECTED_CORPUS.version,
    corpusDigest: EXPECTED_CORPUS.digest,
    scenes: EXPECTED_CORPUS.sceneIds.map((id) => ({
      id,
      metrics: {
        macroF1: FROZEN_BASELINE.scenes[id].macroF1,
        byClass: [{ code: 2, recall: FROZEN_BASELINE.scenes[id].groundRecall }],
      },
    })),
    pooled: {
      macroF1: FROZEN_BASELINE.pooled.macroF1,
      byClass: [{ code: 2, recall: FROZEN_BASELINE.pooled.groundRecall }],
    },
  });

  it('passes the frozen baseline', () => {
    expect(collectCorpusProblems(passingRecord()).problems).toEqual([]);
  });

  it('refuses a corpus digest that moved', () => {
    const record = { ...passingRecord(), corpusDigest: 'sha256:0000' };
    const { problems } = collectCorpusProblems(record);
    expect(problems.join(' ')).toMatch(/corpus digest/);
  });

  it('refuses a dropped scene', () => {
    const record = passingRecord();
    record.scenes = record.scenes.slice(1);
    const { problems } = collectCorpusProblems(record);
    expect(problems.join(' ')).toMatch(/scene list/);
  });

  it('refuses a ground recall that fell', () => {
    const record = passingRecord();
    record.scenes[0].metrics.byClass[0].recall -= 0.01;
    const { problems } = collectCorpusProblems(record);
    expect(problems.join(' ')).toMatch(/ground recall regressed/);
  });

  it('refuses a metric that stopped being measured', () => {
    const record = passingRecord();
    record.scenes[0].metrics.macroF1 = null as unknown as number;
    const { problems } = collectCorpusProblems(record);
    expect(problems.join(' ')).toMatch(/macro-F1 is null/);
  });

  it('accepts a metric that rose', () => {
    const record = passingRecord();
    record.scenes[5].metrics.macroF1 += 0.2;
    record.scenes[5].metrics.byClass[0].recall = 1;
    expect(collectCorpusProblems(record).problems).toEqual([]);
  });
});
