/**
 * classifierCorpusEval.test.ts — the run that produces the classifier corpus
 * record.
 *
 * This file is the RECOMPUTE. It builds the frozen corpus
 * (`src/validation/classifierCorpus.ts`), runs `deriveClassification` on every
 * scene with that scene's cues and unit, reduces the result to per-class
 * metrics, and writes
 * `validation/classifier-corpus/results-classifier-corpus.json`.
 *
 * `scripts/verify-classifier-corpus.mjs` is the GATE. It does not run the
 * classifier: it reads this record and refuses a corpus digest that moved or a
 * metric that fell. That is the same division of labour
 * `tests/groundFilterPdalAgreement.test.ts` and
 * `scripts/verify-ground-filter-metrics.mjs` already use, so the record has to
 * be refreshed by running this bucket before a pass means anything.
 *
 * WHAT THE NUMBERS ARE. Synthetic scenes with labels this project generated.
 * They measure the classifier's behaviour on those scenes. They are not field
 * validation and they say nothing about accuracy on a real scan.
 *
 * Runtime and peak resident memory are printed per scene and are NOT written to
 * the record: they vary with the host, and a frozen artifact that changes on
 * every run would make the freeze meaningless.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildCorpus,
  corpusDigest,
  sceneDigest,
  scaleLengthParams,
  scoreScene,
  poolScores,
  CORPUS_VERSION,
  type CorpusScene,
  type SceneScore,
} from '../src/validation/classifierCorpus';
import {
  deriveClassification,
  CLASSIFIER_METHOD_TAG,
  CLASSIFIER_PRESET,
  CLASSIFIER_VERSION,
  type DeriveClassificationOptions,
} from '../src/render/class/deriveClassification';

const OUT_DIR = resolve(__dirname, '../validation/classifier-corpus');
const OUT_FILE = resolve(OUT_DIR, 'results-classifier-corpus.json');

/** The options a scene is run with: its own grid, its own unit, its own cues. */
export function optionsFor(scene: CorpusScene): DeriveClassificationOptions {
  return {
    cellSizeM: scene.cellSize,
    ...scaleLengthParams(CLASSIFIER_PRESET.params, scene),
    ...(scene.colors ? { colors: scene.colors } : {}),
    ...(scene.returnNumber && scene.returnCount
      ? { returnNumber: scene.returnNumber, returnCount: scene.returnCount }
      : {}),
  };
}

interface Run {
  readonly scene: CorpusScene;
  readonly score: SceneScore;
  readonly runtimeMs: number;
  readonly peakRssMb: number;
}

function runCorpus(): Run[] {
  const runs: Run[] = [];
  for (const scene of buildCorpus()) {
    const before = process.memoryUsage().rss;
    const t0 = performance.now();
    const result = deriveClassification(scene.xyz, scene.count, optionsFor(scene));
    const runtimeMs = performance.now() - t0;
    const peakRssMb = Math.max(before, process.memoryUsage().rss) / (1024 * 1024);
    runs.push({
      scene,
      score: scoreScene(scene.id, scene.truth, result.codes),
      runtimeMs,
      peakRssMb,
    });
  }
  return runs;
}

const f3 = (v: number | null): string => (v === null ? '   n/a' : v.toFixed(3));

describe('classifier corpus evaluation', () => {
  it('runs every scene and writes the record', () => {
    const runs = runCorpus();
    const scores = runs.map((r) => r.score);
    const pooled = poolScores(scores);
    const scenes = runs.map((r) => r.scene);

    // ── the printed report: per-class P/R/F1, plus cost ───────────────────
    const lines: string[] = [];
    lines.push(`corpus v${CORPUS_VERSION}, classifier ${CLASSIFIER_METHOD_TAG}`);
    lines.push(`digest ${corpusDigest(scenes)}`);
    lines.push('');
    lines.push(
      'scene                 pts   macroF1  unclass  falseBldg   ms   peakRSS(MB)',
    );
    for (const r of runs) {
      lines.push(
        `${r.scene.id.padEnd(22)}${String(r.score.points).padStart(5)}   ` +
          `${f3(r.score.macroF1)}    ${f3(r.score.unclassifiedRate)}    ` +
          `${f3(r.score.falseBuildingRate)}  ${r.runtimeMs.toFixed(1).padStart(5)}  ` +
          `${r.peakRssMb.toFixed(0).padStart(6)}`,
      );
    }
    lines.push(
      `${'POOLED'.padEnd(22)}${String(pooled.points).padStart(5)}   ` +
        `${f3(pooled.macroF1)}    ${f3(pooled.unclassifiedRate)}    ${f3(pooled.falseBuildingRate)}`,
    );
    lines.push('');
    lines.push('per-class (pooled)   support  predicted  precision  recall     F1');
    for (const m of pooled.byClass) {
      lines.push(
        `  class ${m.code}          ${String(m.support).padStart(8)}  ` +
          `${String(m.predicted).padStart(9)}     ${f3(m.precision)}   ${f3(m.recall)}  ${f3(m.f1)}`,
      );
    }
    console.log(lines.join('\n'));

    // ── the record ────────────────────────────────────────────────────────
    const record = {
      generatedBy: 'tests/classifierCorpusEval.test.ts',
      gatedBy: 'scripts/verify-classifier-corpus.mjs',
      corpusModule: 'src/validation/classifierCorpus.ts',
      corpusVersion: CORPUS_VERSION,
      corpusDigest: corpusDigest(scenes),
      classifier: {
        method: CLASSIFIER_METHOD_TAG,
        version: CLASSIFIER_VERSION,
        presetId: CLASSIFIER_PRESET.id,
        presetDigest: CLASSIFIER_PRESET.digest,
      },
      evidenceNote:
        'E3 synthetic. Every scene and every label in this record was generated by ' +
        'src/validation/classifierCorpus.ts, so this is one implementation measured ' +
        'against a generator the same project wrote. It is not field validation, not ' +
        'survey truth, and it does not describe accuracy on a real scan. A metric with ' +
        'no denominator is null, never 0.',
      boundaries: [
        'Uniform-random returns in plan: no sensor geometry, no scan pattern, no range noise.',
        'Objects are boxes and clumps of points, not surveyed structures.',
        'Truth vegetation bands are the same bands the classifier uses, so a band disagreement is a real disagreement rather than a definition mismatch.',
        'ASPRS 7 (low point) is a truth label the classifier cannot emit; those points are reported separately and are never scored as a class the classifier could have got right.',
        'Runtime and peak memory are printed by the producing test and deliberately absent here: they vary with the host and would break the freeze.',
      ],
      scenes: runs.map((r) => ({
        id: r.scene.id,
        categories: [...r.scene.categories],
        unit: r.scene.unit,
        description: r.scene.description,
        points: r.scene.count,
        cellSize: r.scene.cellSize,
        cues: {
          rgb: r.scene.colors !== null,
          returns: r.scene.returnNumber !== null && r.scene.returnCount !== null,
        },
        digest: sceneDigest(r.scene),
        metrics: r.score,
      })),
      pooled,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(record, null, 2) + '\n', 'utf8');

    // Every scene produced a score over every point it holds.
    for (const r of runs) expect(r.score.points).toBe(r.scene.count);
    expect(pooled.points).toBeGreaterThan(0);
  });

  it('scores the foot scene exactly as it scores its metre twin', () => {
    // The same geometry in a different linear unit, run with every length
    // parameter restated in that unit. A difference here is a unit bug in the
    // classifier, because the terrain is identical by construction.
    const scenes = buildCorpus();
    const run = (id: string) => {
      const scene = scenes.find((s) => s.id === id)!;
      const result = deriveClassification(scene.xyz, scene.count, optionsFor(scene));
      return scoreScene(scene.id, scene.truth, result.codes);
    };
    const metre = run('units-metre');
    const foot = run('units-foot');
    expect(foot.macroF1).toBe(metre.macroF1);
    expect(foot.unclassifiedRate).toBe(metre.unclassifiedRate);
    expect(foot.falseBuildingRate).toBe(metre.falseBuildingRate);
    for (let i = 0; i < metre.byClass.length; i++) {
      expect(foot.byClass[i].truePositive).toBe(metre.byClass[i].truePositive);
      expect(foot.byClass[i].falsePositive).toBe(metre.byClass[i].falsePositive);
      expect(foot.byClass[i].falseNegative).toBe(metre.byClass[i].falseNegative);
    }
  });
});
